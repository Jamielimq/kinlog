// Which Locked In cohorts the home card shows, and the line under each. Pure, so both can be checked
// without a device.
import type { CohortView } from '../../hooks/useCohorts';
import { formatAmount, joiningClosesTs, SKR_DECIMALS } from './program';
import { cohortDayIndex, formatUtc, NBSP } from './time';
import { backInWallet, readyToWithdraw } from './withdraw';

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

/**
 * For each kind (3-Day first, then 7-Day): the running cohort and the next scheduled one. A cohort
 * this wallet joined also stays once it has ended, until its deadline (5 days after the end), when
 * deposits are returned and the cohort closes. An ended cohort it didn't join is never shown.
 */
export function shownCohorts(cohorts: CohortView[], joined: JoinedCohort[], nowSec: number): CohortView[] {
  const joinedKeys = new Set(joined.map(j => j.key));
  const shown = new Map<string, CohortView>();
  for (const kind of [0, 1]) {
    const ofKind = cohorts.filter(c => c.kind === kind);
    const running = ofKind.find(c => c.startTs <= nowSec && nowSec < c.endTs);
    const next = ofKind.find(c => c.startTs > nowSec);
    for (const c of [running, next]) if (c) shown.set(c.key, c);
  }
  for (const c of cohorts) {
    if (joinedKeys.has(c.key) && nowSec < c.deadlineTs) shown.set(c.key, c);
  }
  return [...shown.values()].sort((a, b) => a.kind - b.kind || a.startTs - b.startTs);
}

/**
 * The line under a cohort's title, without a full stop. For a wallet that joined, what is next for
 * it; once the cohort has ended, a reward still to pick or receive comes first, because it expires at
 * the deadline, while the deposit is returned automatically after it. Each line fits the card on one
 * line, except "Reward received.", which breaks after its first sentence rather than mid-phrase; the
 * reward lines are therefore shorter than the challenge screen's.
 */
export function cardSubtitle(c: CohortView, j: JoinedCohort | undefined, nowMs: number): string {
  const nowSec = nowMs / 1000;
  const day = cohortDayIndex(c.startTs, c.daySeconds, nowMs) + 1;
  const starts = `Starts${NBSP}${formatUtc(c.startTs)}`;
  if (!j) {
    // A full cohort says so while joining is open; once joining closes, that is what matters.
    const full = isFull(c);
    if (nowSec < c.startTs) return full ? `${starts}. Full` : starts;
    if (nowSec < joiningClosesTs(c)) {
      return full ? `Day 1 of ${c.days}. Full` : `Day 1 of ${c.days}. Join until${NBSP}${formatUtc(joiningClosesTs(c))}`;
    }
    return `Day ${day} of ${c.days}. Joining closed`;
  }
  if (nowSec < c.startTs) return `You're in. ${starts}`;
  const rewardDue = j.success && !j.claimed;
  if (nowSec < c.endTs) {
    if (!j.success) return `You're in. Day ${day} of ${c.days}`;
    if (rewardDue) return `All ${c.days} days done. ${j.picked ? 'See your Square' : 'Pick a Square'}`;
    return `Reward received.\nWithdraw from${NBSP}${formatUtc(c.endTs)}`;
  }
  const deposit = formatAmount(c.depositAmount, SKR_DECIMALS);
  const deadline = formatUtc(c.deadlineTs);
  const lines: string[] = [];
  if (rewardDue) lines.push(`${j.picked ? 'Claim your reward' : 'Pick a Square'} by${NBSP}${deadline}`);
  lines.push(j.returned ? backInWallet(deposit, rewardDue) : readyToWithdraw(deposit));
  return lines.join('\n');
}
