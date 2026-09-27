// Finds live cohort accounts (computed addresses, one getMultipleAccounts call; no getProgramAccounts)
// and mirrors them into cohorts/{kind}-{id} for the app. Server-only; the chain stays authoritative.
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import * as P from "./chain/program.ts";
import { type Chain, type CohortKey, keyOf } from "./chain/types.ts";
import { candidateKeys } from "./daily/schedule.ts";

export type CohortStatus = "scheduled" | "running" | "ended" | "closing" | "closed";

export interface LiveCohort {
  key: CohortKey;
  c: P.Cohort;
  /** The mirror document as it was before this refresh (server bookkeeping fields included). */
  mirror: Record<string, unknown>;
}

export function statusOf(c: P.Cohort, nowSec: number): CohortStatus {
  if (nowSec < Number(c.startTs)) return "scheduled";
  if (nowSec < Number(c.endTs)) return "running";
  if (nowSec < Number(c.deadlineTs)) return "ended";
  return "closing";
}

export function mirrorFields(k: CohortKey, c: P.Cohort, nowSec: number) {
  return {
    kind: k.kind,
    id: k.id,
    address: P.cohortPda(k.kind, k.id).toBase58(),
    startTs: Number(c.startTs),
    endTs: Number(c.endTs),
    deadlineTs: Number(c.deadlineTs),
    daySeconds: c.daySeconds,
    days: c.days,
    capacity: c.capacity,
    depositAmount: c.depositAmount.toString(),
    feeLamports: c.feeLamports.toString(),
    commonAmount: c.commonAmount.toString(),
    participants: c.participants,
    picks: c.picks,
    nextSettle: c.nextSettle,
    returned: c.returned,
    successes: c.slots.filter((s) => P.hasFlag(s, P.FLAG.SUCCESS)).length,
    legendaryAwarded: c.legendaryAwarded,
    rareAwarded: c.rareAwarded,
    isTest: c.daySeconds < P.SECONDS_PER_DAY,
    status: statusOf(c, nowSec),
  };
}

const parseKey = (id: string): CohortKey | null => {
  const m = /^(\d)-(\d+)$/.exec(id);
  return m ? { kind: Number(m[1]), id: Number(m[2]) } : null;
};

export async function refreshCohorts(db: Firestore, chain: Chain, nowMs: number): Promise<LiveCohort[]> {
  const nowSec = nowMs / 1000;
  const known = new Map<string, Record<string, unknown>>();
  for (const d of (await db.collection("cohorts").where("status", "!=", "closed").get()).docs) known.set(d.id, d.data());

  const keys = new Map<string, CohortKey>();
  for (const k of candidateKeys(nowMs)) keys.set(keyOf(k), k);
  for (const id of known.keys()) {
    const k = parseKey(id);
    if (k) keys.set(id, k);
  }
  const list = [...keys.values()];
  const found = await chain.getCohorts(list);

  const batch = db.batch();
  let writes = 0;
  const live: LiveCohort[] = [];
  list.forEach((k, i) => {
    const c = found[i];
    const id = keyOf(k);
    const prev = known.get(id);
    const ref = db.doc(`cohorts/${id}`);
    if (c) {
      const f = mirrorFields(k, c, nowSec);
      live.push({ key: k, c, mirror: prev ?? {} });
      const changed = !prev || Object.entries(f).some(([name, v]) => JSON.stringify(prev[name]) !== JSON.stringify(v));
      if (changed) {
        batch.set(ref, { ...f, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        writes++;
      }
    } else if (prev) {
      batch.set(ref, { status: "closed", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      writes++;
    }
  });
  if (writes) await batch.commit();
  return live;
}
