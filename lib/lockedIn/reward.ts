// After a participant has finished every day: the bottom buttons that lead to the Square and through
// it (pick, reveal, receive), the wording for each result, and the alerts for a pick or a claim that
// didn't go through. Pure, so every case can be checked without a device.
import { RARITY_COLOR } from '../../constants/rarity';
import type { RoundResult } from './ore';
import { errorName, TIER } from './program';
import { TxError } from './tx';

/** Completion points, as the server awards them (functions/src/env.ts COMPLETION_POINTS), by kind. */
export const COMPLETION_POINTS = [300, 700] as const;

export const TIER_NAME: Record<number, string> = {
  [TIER.COMMON]: 'Common Square',
  [TIER.RARE]: 'Rare Square',
  [TIER.LEGENDARY]: 'Legendary Square',
};

/** What each result says (docs/LOCKED_IN.md section 8). */
export const TIER_LINE: Record<number, string> = {
  [TIER.COMMON]: 'Challenge complete.',
  [TIER.RARE]: 'Your pick was the lucky one.',
  [TIER.LEGENDARY]: 'You found the rarest square.',
};

/** Each tier in the badge screen's color for that rarity (constants/rarity.ts). */
export const TIER_COLOR: Record<number, string> = {
  [TIER.COMMON]: RARITY_COLOR.Common,
  [TIER.RARE]: RARITY_COLOR.Rare,
  [TIER.LEGENDARY]: RARITY_COLOR.Legendary,
};

/**
 * Why a settled pick got its tier, from its ORE round's result (null when that can't be read). The
 * program's rule (reward.rs handle_settle): Legendary when the round hit the Motherlode, whatever the
 * Square; otherwise Rare when the picked Square is the winning one; otherwise Common. The challenge's
 * caps (1 Legendary, 3 Rare) can then move a pick down, and the line names the cap when one did.
 */
export function tierReason(tier: number, picked: number, result: RoundResult | null): string | null {
  if (tier === TIER.LEGENDARY) return 'Your ORE round hit the Motherlode.';
  if (!result) return null;
  const matched = picked === result.winningSquare;
  if (tier === TIER.RARE) {
    if (result.motherlode) return 'Your ORE round hit the Motherlode. Each challenge has only one Legendary Square, so yours is Rare.';
    return matched ? 'Your Square matched the winning Square.' : null;
  }
  if (result.motherlode) {
    return 'Your ORE round hit the Motherlode. Each challenge has only one Legendary and at most three Rare Squares, so yours is Common.';
  }
  if (matched) return 'Your Square matched the winning Square. Each challenge has at most three Rare Squares, so yours is Common.';
  return `The winning Square was ${result.winningSquare + 1}.`;
}

/** The challenge screen's button once joined: to the Square while a reward is still to pick or receive. */
export function joinedButton(s: { success: boolean; picked: boolean; claimed: boolean; beforeDeadline: boolean }): { label: string } | null {
  if (!s.success || s.claimed || !s.beforeDeadline) return null;
  return { label: s.picked ? 'See your Square' : 'Pick a Square' };
}

export interface SquareState {
  success: boolean;
  picked: boolean;
  settled: boolean;
  claimed: boolean;
  beforeDeadline: boolean;
  busy: boolean; // a pick, reveal or claim is under way
  selected: number | null; // tapped but not picked yet (0-24)
  revealed: boolean; // Reveal reward was pressed on this visit
  resultInSec: number | null; // until the target round's result should exist; null: unknown
}

export interface SquareButton {
  action?: 'pick' | 'reveal' | 'claim'; // none: the button can't be pressed
  label?: string; // none: a spinner shows instead
  grey?: boolean;
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** The Square screen's one bottom button. Null when there is nothing left to do here. */
export function squareButton(s: SquareState): SquareButton | null {
  if (s.busy) return {};
  if (!s.success || s.claimed) return null;
  if (!s.beforeDeadline) return { label: 'Reward expired', grey: true };
  if (!s.picked) {
    return s.selected === null ? { label: 'Pick a Square', grey: true } : { action: 'pick', label: `Pick Square ${s.selected + 1}` };
  }
  if (!s.settled) {
    if (s.resultInSec === null) return { label: 'Waiting for ORE', grey: true };
    // Once the round's result should exist, the server settles the pick within about a minute.
    return s.resultInSec > 0 ? { label: `Result in ${mmss(s.resultInSec)}`, grey: true } : { label: 'Confirming', grey: true };
  }
  if (!s.revealed) return { action: 'reveal', label: 'Reveal reward' };
  return { action: 'claim', label: 'Receive to wallet' };
}

type Alert = { title: string; body: string };

/** Wording shared with the join and withdraw alerts for the ways a transaction fails before the program runs. */
export function txFailure(e: TxError): string | null {
  if (e.kind === 'network') return "Couldn't reach the network, so nothing was sent. Try again.";
  if (e.kind === 'wallet') return "Your wallet couldn't complete the request. Try again.";
  if (e.kind === 'expired') return "It timed out before going through, so nothing changed. Try again.";
  return null;
}

/** Not enough SOL for the network fee, or for a new token account (a claim's ORE, a withdrawal's SKR). */
export function solShort(e: TxError): boolean {
  if (e.reason === 'InsufficientFundsForRent' || e.reason === 'InsufficientFundsForFee' || e.reason === 'AccountNotFound') return true;
  return e.code === 1 && e.logs.some(l => l.toLowerCase().includes('insufficient lamports'));
}

/**
 * The alert for a pick that didn't go through, once the chain has been checked and shows no pick.
 * Not for a cancel in the wallet, which shows nothing.
 */
export function pickErrorAlert(e: unknown): Alert {
  const FAILED = "Couldn't pick";
  const other = { title: FAILED, body: 'Something went wrong. Try again.' };
  if (!(e instanceof TxError)) return other;
  if (e.kind === 'unconfirmed') return { title: 'Not confirmed yet', body: 'Your pick may still go through. Check back in a minute.' };
  const failure = txFailure(e);
  if (failure) return { title: FAILED, body: failure };
  if (solShort(e)) return { title: FAILED, body: "This wallet doesn't have enough SOL for the network fee." };
  switch (e.code === undefined ? undefined : errorName(e.code)) {
    case 'AlreadyPicked': return { title: 'Already picked', body: "You've already picked a Square." };
    case 'NotSuccessful': return { title: FAILED, body: "Your finished days aren't marked yet. Try again in a minute." };
    case 'DeadlinePassed': return { title: FAILED, body: 'The deadline to pick a Square has passed.' };
    default: return other;
  }
}

/**
 * The alert for a claim that didn't go through, once the chain has been checked and shows it
 * unclaimed. Not for a cancel in the wallet, which shows nothing.
 */
export function claimErrorAlert(e: unknown): Alert {
  const FAILED = "Couldn't receive";
  const other = { title: FAILED, body: 'Something went wrong. Try again.' };
  if (!(e instanceof TxError)) return other;
  if (e.kind === 'unconfirmed') return { title: 'Not confirmed yet', body: 'Your reward may still be on its way. Check back in a minute.' };
  const failure = txFailure(e);
  if (failure) return { title: FAILED, body: failure };
  if (solShort(e)) return { title: FAILED, body: "This wallet doesn't have enough SOL to receive the reward." };
  switch (e.code === undefined ? undefined : errorName(e.code)) {
    case 'AlreadyClaimed': return { title: 'Already received', body: "You've already received this reward." };
    case 'NotSettled': return { title: FAILED, body: "Your result isn't in yet. Try again in a minute." };
    case 'DeadlinePassed': return { title: FAILED, body: 'The deadline to receive this reward has passed.' };
    default: return other;
  }
}
