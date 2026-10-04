// Which Locked In cohorts the home card shows, and what an ended one still asks of the wallet.
// Pure, so both can be checked without a device.
import type { CohortView } from '../../hooks/useCohorts';
import { formatUtc, NBSP } from './time';

/** A cohort this wallet joined, from the server's users/{wallet}/lockedIn record. */
export interface JoinedCohort {
  key: string;
  returned: boolean; // deposit back in the wallet (withdrawn, or returned by the server)
  success: boolean; // every day met, marked on chain
  picked: boolean; // a Square is picked (its ORE may not be received yet)
  claimed: boolean; // reward (ORE) received
}

/**
 * Every seat taken, by the server's mirror of the cohort (up to a minute behind the chain). The
 * program itself refuses deposits past capacity (CohortFull), so a stale count can't oversell.
 */
export const isFull = (c: CohortView) => c.capacity > 0 && c.participants >= c.capacity;

/** Something is still due to the wallet: its deposit, or a reward it earned and hasn't received (picked or not). */
export const stillDue = (j: JoinedCohort) => !j.returned || (j.success && !j.claimed);

/**
 * For each kind (3-Day first, then 7-Day): the running cohort and the next scheduled one. Cohorts
 * this wallet joined stay while they run; once over, only while something is still due and the
 * deadline (5 days after the end) hasn't passed. Ended cohorts are otherwise gone.
 */
export function shownCohorts(cohorts: CohortView[], joined: JoinedCohort[], nowSec: number): CohortView[] {
  const byKey = new Map(joined.map(j => [j.key, j]));
  const shown = new Map<string, CohortView>();
  for (const kind of [0, 1]) {
    const ofKind = cohorts.filter(c => c.kind === kind);
    const running = ofKind.find(c => c.startTs <= nowSec && nowSec < c.endTs);
    const next = ofKind.find(c => c.startTs > nowSec);
    for (const c of [running, next]) if (c) shown.set(c.key, c);
  }
  for (const c of cohorts) {
    const j = byKey.get(c.key);
    if (j && (nowSec < c.endTs || (nowSec < c.deadlineTs && stillDue(j)))) shown.set(c.key, c);
  }
  return [...shown.values()].sort((a, b) => a.kind - b.kind || a.startTs - b.startTs);
}

/**
 * Subtitle lines for an ended cohort: one per thing still due, the reward first because it expires
 * at the deadline, while an unwithdrawn deposit is returned automatically after it.
 */
export function dueLines(c: CohortView, j: JoinedCohort): string[] {
  const d = formatUtc(c.deadlineTs);
  const lines: string[] = [];
  if (j.success && !j.picked) lines.push(`Pick a Square by${NBSP}${d}, or the reward expires.`);
  else if (j.success && !j.claimed) lines.push(`Claim your reward by${NBSP}${d}, or it expires.`);
  if (!j.returned) lines.push(`Withdraw your SKR, or it returns automatically after${NBSP}${d}.`);
  return lines;
}
