// Every minute: mirror cohorts, settle picks in recording order (retarget when a round finished
// without entropy), record results and badge grants, catch up missed success marks, return deposits
// and close cohorts after their deadline, and alert on picks left unsettled.
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import * as P from "../chain/program.ts";
import { ChainTxError, type CohortKey, isProgramError, keyOf } from "../chain/types.ts";
import { refreshCohorts } from "../cohorts.ts";
import { BADGE_PREFIX, THRESHOLDS } from "../env.ts";
import { alert, errText } from "../log.ts";
import { type Ops, readOps } from "../ops.ts";
import { awardCompletion, type Deps, evaluate } from "../workout/attest.ts";

export interface MinuteSummary {
  cohorts: number;
  settled: number;
  retargeted: number;
  attested: number;
  returned: number;
  closed: number;
}

const TIER_NAMES = ["none", "common", "rare", "legendary"];
export const badgeIdFor = (kind: number, tier: number) => `${BADGE_PREFIX[kind]}_${TIER_NAMES[tier]}`;

/** Changes whenever anything the app shows about the slots changes. */
const slotsSig = (c: P.Cohort) => c.slots.map((s) => `${s.user.toBase58()}:${s.flags}:${s.tier}:${s.square}:${s.targetRound}:${s.amount}`).join("|");

const isSweepMinute = (nowMs: number) => Math.floor(nowMs / 60_000) % 10 === 0;

async function settlePending(deps: Deps, k: CohortKey, c: P.Cohort, boardRound: () => Promise<bigint>, sum: MinuteSummary): Promise<P.Cohort> {
  for (let n = 0; n < 10; n++) {
    const next = P.nextPendingPick(c);
    if (!next) return c;
    const action = P.settleAction(await boardRound(), next.targetRound, await deps.chain.getRound(next.targetRound));
    if (action === "wait") return c;
    try {
      if (action === "settle") {
        await deps.chain.settle(k, next.targetRound);
        sum.settled++;
      } else {
        await deps.chain.retarget(k, next.user, next.targetRound);
        sum.retargeted++;
      }
    } catch (e) {
      // ORE moved between our read and the program's: try again next minute.
      if (["RoundNotRevealed", "RoundNeedsRetarget", "RetargetNotAllowed"].some((n) => isProgramError(e, n))) return c;
      throw e;
    }
    const fresh = (await deps.chain.getCohorts([k]))[0];
    if (!fresh) return c;
    c = fresh;
  }
  return c;
}

async function sweepAttest(deps: Deps, ops: Ops, k: CohortKey, c: P.Cohort, nowMs: number, sum: MinuteSummary) {
  const nowSec = nowMs / 1000;
  if (nowSec < Number(P.lastDayStart(c)) || nowSec >= Number(c.deadlineTs)) return;
  for (const s of c.slots) {
    if (P.hasFlag(s, P.FLAG.SUCCESS)) continue;
    if ((await evaluate(deps, ops, s.user.toBase58(), k, c)) === "attested") sum.attested++;
  }
}

async function returnAndClose(deps: Deps, k: CohortKey, c: P.Cohort, nowSec: number, sum: MinuteSummary): Promise<P.Cohort | null> {
  // Wall clock first (cheap), then the chain clock the program checks.
  if (nowSec < Number(c.deadlineTs) || (await deps.chain.getClock()) < Number(c.deadlineTs)) return c;
  let sent = 0;
  for (const s of c.slots) {
    if (P.hasFlag(s, P.FLAG.RETURNED)) continue;
    if (sent++ >= 10) return c;
    try {
      await deps.chain.returnDeposit(k, s.user);
      sum.returned++;
    } catch (e) {
      if (!isProgramError(e, "AlreadyReturned")) throw e;
    }
  }
  const fresh = (await deps.chain.getCohorts([k]))[0];
  if (!fresh) return null;
  if (fresh.returned !== fresh.participants) return fresh;
  await deps.chain.closeCohort(k, fresh.creator);
  sum.closed++;
  return null;
}

async function syncSlots(db: Firestore, k: CohortKey, c: P.Cohort, mirror: Record<string, unknown>, force: boolean) {
  const sig = slotsSig(c);
  if (!force && mirror.syncedSig === sig) return;
  const batch = db.batch();
  for (const s of c.slots) {
    const w = s.user.toBase58();
    const f: Record<string, unknown> = {
      kind: k.kind,
      id: k.id,
      success: P.hasFlag(s, P.FLAG.SUCCESS),
      returned: P.hasFlag(s, P.FLAG.RETURNED),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (P.hasFlag(s, P.FLAG.PICKED)) {
      Object.assign(f, {
        square: s.square,
        targetRound: s.targetRound.toString(),
        pickSeq: s.pickSeq,
        settled: P.hasFlag(s, P.FLAG.SETTLED),
        claimed: P.hasFlag(s, P.FLAG.CLAIMED),
      });
    }
    if (P.hasFlag(s, P.FLAG.SETTLED)) {
      Object.assign(f, { tier: s.tier, amount: s.amount.toString() });
      batch.set(
        db.doc(`users/${w}/badges/${badgeIdFor(k.kind, s.tier)}/grants/${keyOf(k)}`),
        { cohort: keyOf(k), kind: k.kind, tier: s.tier, amount: s.amount.toString(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    batch.set(db.doc(`users/${w}/lockedIn/${keyOf(k)}`), f, { merge: true });
  }
  batch.set(db.doc(`cohorts/${keyOf(k)}`), { syncedSig: sig }, { merge: true });
  await batch.commit();
  for (const s of c.slots) if (P.hasFlag(s, P.FLAG.SUCCESS)) await awardCompletion(db, s.user.toBase58(), k, c);
}

async function checkStuck(db: Firestore, k: CohortKey, c: P.Cohort, mirror: Record<string, unknown>, nowMs: number) {
  const ref = db.doc(`cohorts/${keyOf(k)}`);
  const next = P.nextPendingPick(c);
  if (!next) {
    if (mirror.pendingKey !== undefined) await ref.set({ pendingKey: FieldValue.delete(), pendingSince: FieldValue.delete() }, { merge: true });
    return;
  }
  const marker = `${next.pickSeq}:${next.targetRound}`;
  if (mirror.pendingKey !== marker) {
    await ref.set({ pendingKey: marker, pendingSince: nowMs }, { merge: true });
    return;
  }
  const since = mirror.pendingSince as number;
  if (nowMs - since > THRESHOLDS.pickStuckMs) {
    await alert(db, "pick_stuck", `${keyOf(k)}:${marker}`, {
      cohort: keyOf(k),
      pickSeq: next.pickSeq,
      targetRound: next.targetRound.toString(),
      minutes: Math.round((nowMs - since) / 60_000),
    }, nowMs);
  }
}

export async function runEveryMinute(deps: Deps, opts: { sweep?: boolean } = {}): Promise<MinuteSummary> {
  const { db, chain } = deps;
  const nowMs = deps.nowMs();
  const sweep = opts.sweep ?? isSweepMinute(nowMs);
  const ops = await readOps(db);
  const sum: MinuteSummary = { cohorts: 0, settled: 0, retargeted: 0, attested: 0, returned: 0, closed: 0 };
  if (ops.testAlert) await alert(db, "test", "test", { note: "Test alert. Set config/ops.testAlert back to false." }, nowMs);

  const live = await refreshCohorts(db, chain, nowMs);
  sum.cohorts = live.length;
  let board: bigint | null = null;
  const boardRound = async () => (board ??= await chain.getBoardRound());

  for (const lc of live) {
    let c: P.Cohort | null = lc.c;
    try {
      if (!ops.paused) {
        c = await settlePending(deps, lc.key, c, boardRound, sum);
        if (sweep) await sweepAttest(deps, ops, lc.key, c, nowMs, sum);
        c = await returnAndClose(deps, lc.key, c, nowMs / 1000, sum);
      }
      if (c) {
        await syncSlots(db, lc.key, c, lc.mirror, sweep);
        await checkStuck(db, lc.key, c, lc.mirror, nowMs);
      }
    } catch (e) {
      if (e instanceof ChainTxError && e.insufficientFunds) {
        await alert(db, "server_sol_low", "crank", { wallet: "Crank", error: errText(e) }, nowMs);
      } else {
        await alert(db, "job_error", `everyMinute:${keyOf(lc.key)}`, { error: errText(e) }, nowMs);
      }
    }
  }
  return sum;
}
