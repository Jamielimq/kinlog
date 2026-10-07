// Claiming a monthly badge: 0.001 SOL to Kinlog's fee wallet plus a memo naming the badge and its
// month, in one transaction sent with lib/lockedIn/tx.ts sendWithWallet (simulated before the wallet
// opens, confirmed after). No on-chain badge is issued yet; the memo is the on-chain record of the claim.
import { type Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { solShort, txFailure } from './lockedIn/reward';
import { TxError } from './lockedIn/tx';

/** Where the lifetime badges' claim fee goes too (app/(tabs)/badges.tsx TREASURY_WALLET). */
export const FEE_WALLET = new PublicKey('EyEohuV8fBXyNDZK9ZtYFNe6A6FfUw9ndSwBbtNqTxmJ');
export const BADGE_FEE_LAMPORTS = 1_000_000; // 0.001 SOL
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export function claimInstructions(payer: PublicKey, memo: string): TransactionInstruction[] {
  return [
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: FEE_WALLET, lamports: BADGE_FEE_LAMPORTS }),
    new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memo, 'utf8') }),
  ];
}

export type SentState = 'confirmed' | 'failed' | 'expired' | 'unknown';

/**
 * Where a sent claim stands on chain. The whole history is searched, so a payment confirmed long ago
 * is still found. It counts as expired only when the history doesn't have it and the chain is past the
 * block height its blockhash was valid for (looked up twice, as lib/lockedIn/tx.ts confirm does).
 * Throws if the RPC can't answer, which the caller treats as unknown.
 */
export async function sentState(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<SentState> {
  const lookUp = async () =>
    (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  const judge = (s: NonNullable<Awaited<ReturnType<typeof lookUp>>>): SentState =>
    s.err ? 'failed' : s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'unknown';
  const status = await lookUp();
  if (status) return judge(status);
  if ((await connection.getBlockHeight()) <= lastValidBlockHeight) return 'unknown';
  const again = await lookUp();
  return again ? judge(again) : 'expired';
}

/** The popup for a claim that didn't go through. Not for a cancel in the wallet, which shows nothing. */
export function badgeClaimAlert(e: unknown): { title: string; body: string } {
  const FAILED = "Couldn't claim";
  const other = { title: FAILED, body: 'Something went wrong. Try again.' };
  if (!(e instanceof TxError)) return other;
  if (e.kind === 'unconfirmed') {
    return { title: 'Not confirmed yet', body: 'Your claim may still go through. Check your wallet before you try again.' };
  }
  const failure = txFailure(e);
  if (failure) return { title: FAILED, body: failure };
  if (solShort(e)) return { title: FAILED, body: "This wallet doesn't have enough SOL to claim." };
  return other;
}
