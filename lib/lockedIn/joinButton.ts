// The join screen's one bottom button: what it says and does in each state, whether a wallet's
// balances fall short, and the alert for a Join that didn't go through. Pure, so every case can be
// checked without a device.
import { errorName } from './program';
import { TxError } from './tx';

// Base fee (5,000 lamports a signature) plus the priority fee (about 600), with room to spare.
export const NETWORK_FEE_MARGIN = 20_000n;

export interface Balances {
  skr: bigint | null; // null: no SKR token account
  lamports: bigint;
  rentMin: bigint; // what Solana requires a wallet to keep (rent-exempt minimum, no data)
}

/** Which balance falls short of joining: SKR first, then SOL for the Fee, the minimum balance and network fees. */
export function shortOf(b: Balances, depositAmount: bigint, feeLamports: bigint): 'skr' | 'sol' | null {
  if (b.skr === null || b.skr < depositAmount) return 'skr';
  if (b.lamports < feeLamports + b.rentMin + NETWORK_FEE_MARGIN) return 'sol';
  return null;
}

/** Where the wallet stands, as the join screen sees it. */
export interface JoinState {
  joined: boolean; // known to be in: a slot on chain, or the server's record
  joining: boolean; // a Join is under way
  open: boolean; // joining hasn't closed
  full: boolean; // every seat taken
  connecting: boolean; // connecting, or restoring the saved wallet at start
  connected: boolean;
  session: 'checking' | 'needed' | 'signingIn' | 'ready';
  slotKnown: boolean; // the chain has answered whether this wallet is in
  short: 'skr' | 'sol' | null | undefined; // undefined while balances are being read
  deposit: string; // e.g. "100"
}

export interface JoinButton {
  action?: 'connect' | 'signIn' | 'join'; // none: the button can't be pressed
  label?: string; // none: a spinner shows instead
  grey?: boolean; // joining isn't possible from here, or the screen is still checking
}

/**
 * Null for a participant: what goes there after joining is decided separately. Closed and full
 * come before connecting and signing in, so a wallet not known to be in sees only that.
 */
export function joinButton(s: JoinState): JoinButton | null {
  if (s.joined) return null;
  if (s.joining) return {};
  if (!s.open) return { label: 'Joining closed', grey: true };
  if (s.full) return { label: 'This challenge is full', grey: true };
  if (s.connecting) return { label: 'Connecting...' };
  if (!s.connected) return { action: 'connect', label: 'Connect Wallet' };
  if (s.session === 'needed') return { action: 'signIn', label: 'Sign in' };
  if (s.session === 'signingIn') return {};
  if (s.session === 'checking' || !s.slotKnown || s.short === undefined) return { grey: true };
  if (s.short === 'skr') return { label: `Need ${s.deposit} SKR to join`, grey: true };
  if (s.short === 'sol') return { label: 'Not enough SOL to join', grey: true };
  return { action: 'join', label: `Join with ${s.deposit} SKR` };
}

const FAILED = "Couldn't join";

/**
 * The alert for a Join that didn't go through, once the chain has been checked and the wallet isn't
 * in. Not for a cancel in the wallet, which shows nothing.
 */
export function joinErrorAlert(e: unknown, deposit: string): { title: string; body: string } {
  // Anything rare enough to have no wording of its own.
  const other = { title: FAILED, body: 'Something went wrong. Try again.' };
  if (!(e instanceof TxError)) return other;
  // Not known to have failed: it may still land, or the chain couldn't be read to show the wallet is in.
  if (e.kind === 'unconfirmed') return { title: 'Not confirmed yet', body: 'Your join may still go through. Check back in a minute.' };
  const name = e.code === undefined ? undefined : errorName(e.code);
  if (name === 'AlreadyJoined') return { title: 'Already joined', body: "You've already joined this challenge." };

  const failed = (body: string) => ({ title: FAILED, body });
  if (e.kind === 'network') return failed("Couldn't reach the network, so nothing was sent. Try again.");
  if (e.kind === 'wallet') return failed("Your wallet couldn't complete the request. Try again.");
  if (e.kind === 'expired') return failed("It timed out before going through, so nothing changed. Try again.");
  const noSol = failed("This wallet doesn't have enough SOL to join.");
  // The wallet would be left below the minimum balance Solana requires, or can't pay the network fee.
  if (e.reason === 'InsufficientFundsForRent' || e.reason === 'InsufficientFundsForFee' || e.reason === 'AccountNotFound') return noSol;
  if (e.code === 1) {
    // Custom(1) is the system program's or the token program's "insufficient" error.
    return e.logs.some(l => l.toLowerCase().includes('insufficient lamports')) ? noSol : failed(`You need ${deposit} SKR to join.`);
  }
  if (e.code === 3012) return failed(`You need ${deposit} SKR to join.`); // no SKR token account
  switch (name) {
    case 'CohortFull': return failed('This challenge just filled up.');
    case 'JoiningClosed': return failed('Joining has closed for this challenge.');
    case 'DepositsPaused': return failed('Joining is paused right now. Try again later.');
    default: return other; // e.g. Unauthorized (fee wallet mismatch) or any other program error
  }
}
