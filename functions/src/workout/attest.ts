// Counts signed-in workouts toward Locked In and marks success on chain once every day is met.
// Only workouts carrying `uid` count: the rules let a client write that field only with its own
// sign-in token, and never change or delete such a document afterwards. Days are bucketed by the
// document's Firestore create time, never by a client clock.
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import * as P from "../chain/program.ts";
import { type Chain, ChainTxError, type CohortKey, isProgramError, keyOf } from "../chain/types.ts";
import { COMPLETION_POINTS, DAILY_TARGET_REPS } from "../env.ts";
import { alert, errText, log } from "../log.ts";
import { type Ops, readOps } from "../ops.ts";
import { cohortDayIndex, kstDateKey } from "../time.ts";

export interface Deps {
  db: Firestore;
  chain: Chain;
  nowMs: () => number;
}

const MAX_REPS = 300;
const QUERY_MARGIN_MS = 15 * 60_000;
const LEASE_MS = 120_000;
/** The chain clock runs 1-2 s behind wall time; wait this long at most for it to reach the last day. */
const MAX_CLOCK_WAIT_S = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reps before the app's own daily cap (`rawReps`), falling back to `reps`; 0 when unusable. */
export function repsOf(d: Record<string, unknown>): number {
  const v = Number.isInteger(d.rawReps) ? d.rawReps : d.reps;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, MAX_REPS) : 0;
}

/** Reps per cohort day from the wallet's signed-in workouts. */
export async function dayRepsFor(db: Firestore, wallet: string, c: P.Cohort): Promise<number[]> {
  const startMs = Number(c.startTs) * 1000;
  const endMs = Number(c.endTs) * 1000;
  const snap = await db
    .collection(`users/${wallet}/workouts`)
    .where("uid", "==", wallet)
    .where("createdAt", ">=", startMs - QUERY_MARGIN_MS)
    .where("createdAt", "<", endMs + QUERY_MARGIN_MS)
    .get();
  const days: number[] = new Array(c.days).fill(0);
  for (const d of snap.docs) {
    const i = cohortDayIndex(Number(c.startTs), c.daySeconds, d.createTime.toMillis());
    if (i >= 0 && i < c.days) days[i] += repsOf(d.data());
  }
  return days;
}

async function addDaily(db: Firestore, wallet: string, workoutId: string, reps: number, atMs: number) {
  const ref = db.doc(`users/${wallet}/daily/${kstDateKey(atMs)}`);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).get(`counted.${workoutId}`)) return;
    tx.set(ref, { reps: FieldValue.increment(reps), counted: { [workoutId]: true }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

async function takeLease(db: Firestore, ref: FirebaseFirestore.DocumentReference, nowMs: number): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const until = (await tx.get(ref)).get("leaseUntil") as number | undefined;
    if (until !== undefined && until > nowMs) return false;
    tx.set(ref, { leaseUntil: nowMs + LEASE_MS }, { merge: true });
    return true;
  });
}

/** Completion points, once per wallet and cohort (the history document id is fixed). */
export async function awardCompletion(db: Firestore, wallet: string, k: CohortKey, c: P.Cohort): Promise<boolean> {
  const amount = COMPLETION_POINTS[k.kind];
  if (!amount) return false;
  const hist = db.doc(`users/${wallet}/points_history/li-${keyOf(k)}`);
  return db.runTransaction(async (tx) => {
    if ((await tx.get(hist)).exists) return false;
    const now = Date.now();
    tx.create(hist, { reason: `Locked In ${c.days}-Day complete`, amount, createdAt: now });
    tx.set(db.doc(`users/${wallet}`), { points: FieldValue.increment(amount), updatedAt: now }, { merge: true });
    tx.set(db.doc(`users/${wallet}/lockedIn/${keyOf(k)}`), { pointsAwarded: true }, { merge: true });
    return true;
  });
}

export type Outcome = "not_participant" | "progress" | "met" | "attested" | "already";

/** Recomputes a participant's progress; sends mark_success when every day is met inside the window. */
export async function evaluate(deps: Deps, ops: Ops, wallet: string, k: CohortKey, c: P.Cohort): Promise<Outcome> {
  const slot = c.slots.find((s) => s.user.toBase58() === wallet);
  if (!slot) return "not_participant";
  const ref = deps.db.doc(`users/${wallet}/lockedIn/${keyOf(k)}`);
  const onChainSuccess = P.hasFlag(slot, P.FLAG.SUCCESS);
  const dayReps = await dayRepsFor(deps.db, wallet, c);
  const allMet = dayReps.every((r) => r >= DAILY_TARGET_REPS);
  await ref.set(
    {
      kind: k.kind, id: k.id, days: c.days, daySeconds: c.daySeconds,
      startTs: Number(c.startTs), endTs: Number(c.endTs), deadlineTs: Number(c.deadlineTs),
      dayReps, allMet, success: onChainSuccess, updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  if (onChainSuccess) {
    await awardCompletion(deps.db, wallet, k, c);
    return "already";
  }
  if (!allMet) return "progress";
  if (ops.paused) return "met";
  // The success window is checked against the chain's clock, which the program uses.
  const lastDay = Number(P.lastDayStart(c));
  let chainNow = await deps.chain.getClock();
  if (chainNow < lastDay && lastDay - chainNow <= MAX_CLOCK_WAIT_S) {
    await sleep((lastDay - chainNow + 1) * 1000);
    chainNow = await deps.chain.getClock();
  }
  if (chainNow < lastDay || chainNow >= Number(c.deadlineTs)) return "met";
  if (!(await takeLease(deps.db, ref, deps.nowMs()))) return "met";
  try {
    const sig = await deps.chain.markSuccess(k, slot.user);
    await ref.set({ success: true, successTx: sig, leaseUntil: FieldValue.delete() }, { merge: true });
    log.info("mark_success sent", { cohort: keyOf(k), wallet, sig });
  } catch (e) {
    await ref.set({ leaseUntil: FieldValue.delete() }, { merge: true });
    if (isProgramError(e, "SuccessWindowClosed") && (await deps.chain.getClock()) < Number(c.deadlineTs)) {
      // Clock race at the day boundary: the next workout or the sweep retries.
      log.info("mark_success early; will retry", { cohort: keyOf(k), wallet });
    } else if (e instanceof ChainTxError && e.insufficientFunds) {
      await alert(deps.db, "server_sol_low", "attester", { wallet: "Attester", error: errText(e) });
    } else {
      await alert(deps.db, "job_error", `mark_success:${keyOf(k)}`, { error: errText(e) });
    }
    return "met";
  }
  await awardCompletion(deps.db, wallet, k, c);
  return "attested";
}

/** Firestore trigger body for users/{wallet}/workouts/{workoutId}. */
export async function onWorkoutCreated(
  deps: Deps,
  wallet: string,
  workoutId: string,
  data: Record<string, unknown>,
  createTimeMs: number,
): Promise<Record<string, Outcome>> {
  if (data.uid !== wallet) return {};
  const reps = repsOf(data);
  if (reps <= 0) return {};
  await addDaily(deps.db, wallet, workoutId, reps, createTimeMs);

  const atSec = createTimeMs / 1000;
  const running = (await deps.db.collection("cohorts").where("endTs", ">", atSec).get()).docs
    .map((d) => d.data())
    .filter((m) => m.status !== "closed" && m.startTs <= atSec)
    .map((m) => ({ kind: m.kind as number, id: m.id as number }));
  if (!running.length) return {};
  const cohorts = await deps.chain.getCohorts(running);
  const ops = await readOps(deps.db);
  const outcomes: Record<string, Outcome> = {};
  for (let i = 0; i < running.length; i++) {
    const c = cohorts[i];
    if (c) outcomes[keyOf(running[i])] = await evaluate(deps, ops, wallet, running[i], c);
  }
  return outcomes;
}
