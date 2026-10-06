// After a cohort has ended: the button that takes the deposit back, what the challenge screen and the
// home card say about the deposit, and the alert for a withdrawal that didn't go through. Pure, so
// every case can be checked without a device.
import { errorName } from './program';
import { solShort, txFailure } from './reward';
import { NBSP } from './time';
import { TxError } from './tx';

/**
 * The challenge screen's Withdraw button: from the end, while the deposit is still in the cohort.
 * Only once the chain has shown this wallet's slot, which is what the program pays out from.
 */
export function withdrawButton(s: {
  ended: boolean;
  onChain: boolean; // this wallet's slot has been read from the cohort account
  returned: boolean;
  busy: boolean; // a withdrawal is under way
  deposit: string; // e.g. "100"
}): { label?: string } | null {
  if (!s.ended || !s.onChain || s.returned) return null;
  if (s.busy) return {};
  return { label: `Withdraw ${s.deposit} SKR` };
}

/** The deposit can be taken back. No full stop: the home card's lines have none. */
export const readyToWithdraw = (deposit: string) => `Your ${deposit} SKR is ready to withdraw`;

/**
 * The deposit is back. "All done." only when nothing is left: a reward still to pick or receive is
 * shown before this line instead. No full stop, as readyToWithdraw.
 */
export const backInWallet = (deposit: string, rewardDue: boolean) =>
  `${rewardDue ? '' : 'All done. '}${deposit} SKR is back in your wallet`;

/**
 * The alert for a withdrawal that didn't go through, once the chain has been checked and shows the
 * deposit still in the cohort. Not for a cancel in the wallet, which shows nothing.
 */
export function withdrawErrorAlert(e: unknown, opensAt: string): { title: string; body: string } {
  const FAILED = "Couldn't withdraw";
  const other = { title: FAILED, body: 'Something went wrong. Try again.' };
  if (!(e instanceof TxError)) return other;
  if (e.kind === 'unconfirmed') return { title: 'Not confirmed yet', body: 'Your withdrawal may still go through. Check back in a minute.' };
  const failure = txFailure(e);
  if (failure) return { title: FAILED, body: failure };
  if (solShort(e)) return { title: FAILED, body: "This wallet doesn't have enough SOL to withdraw." };
  switch (e.code === undefined ? undefined : errorName(e.code)) {
    case 'AlreadyReturned': return { title: 'Already returned', body: 'Your SKR is already back in your wallet.' };
    // The phone's clock can run ahead of the chain's.
    case 'CohortNotEnded': return { title: FAILED, body: `Withdrawals open at${NBSP}${opensAt}. Try again in a minute.` };
    default: return other;
  }
}
