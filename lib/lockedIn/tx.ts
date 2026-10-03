// Sends Locked In instructions through the wallet: simulate first (so a refusal is explained before
// the wallet opens), add a compute budget, let the wallet sign and send, then confirm over RPC.
import {
  ComputeBudgetProgram,
  type Connection,
  type PublicKey,
  Transaction,
  type TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { errorName } from './program';

// Same priority fee as the server (functions/src/chain/send.ts).
const PRIORITY_MICROLAMPORTS = 20_000;
const CONFIRM_TIMEOUT_MS = 60_000;
const CONFIRM_POLL_MS = 1_500;

export class TxError extends Error {
  constructor(
    readonly kind: 'simulation' | 'failed' | 'unconfirmed',
    readonly code?: number,
    readonly logs: string[] = [],
    // A transaction-level error that no instruction raised, e.g. InsufficientFundsForRent.
    readonly reason?: string,
  ) {
    super(code === undefined ? (reason ? `${kind}: ${reason}` : kind) : `${kind}: ${errorName(code) ?? code}`);
    this.name = 'TxError';
  }
}

/** The custom error code inside an RPC transaction error ({ InstructionError: [i, { Custom: n }] }). */
function customCode(err: unknown): number | undefined {
  const ie = (err as { InstructionError?: unknown[] } | null)?.InstructionError;
  const custom = Array.isArray(ie) ? (ie[1] as { Custom?: unknown } | undefined)?.Custom : undefined;
  return typeof custom === 'number' ? custom : undefined;
}

/** Name of a transaction-level RPC error: "AccountNotFound" or { InsufficientFundsForRent: {...} }. */
function errorReason(err: unknown): string | undefined {
  if (typeof err === 'string') return err;
  const keys = err && typeof err === 'object' ? Object.keys(err) : [];
  return keys.length === 1 && keys[0] !== 'InstructionError' ? keys[0] : undefined;
}

/** Simulates without signatures; throws TxError('simulation') with the program's error code. */
export async function simulate(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<{ unitsConsumed?: number; logs: string[] }> {
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...instructions).compileMessage();
  const sim = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  const logs = sim.value.logs ?? [];
  if (sim.value.err) throw new TxError('simulation', customCode(sim.value.err), logs, errorReason(sim.value.err));
  return { unitsConsumed: sim.value.unitsConsumed, logs };
}

async function confirm(connection: Connection, signature: string): Promise<void> {
  const until = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < until) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) throw new TxError('failed', customCode(status.err), [], errorReason(status.err));
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    await new Promise(resolve => setTimeout(resolve, CONFIRM_POLL_MS));
  }
  throw new TxError('unconfirmed');
}

type AuthorizeAndSign = (callback: (wallet: any, authToken: string) => Promise<void>) => Promise<void>;

/** Simulates, has the wallet sign and send, and waits for confirmation. Returns the signature. */
export async function sendWithWallet(opts: {
  connection: Connection;
  payer: PublicKey;
  instructions: TransactionInstruction[];
  authorizeAndSign: AuthorizeAndSign;
}): Promise<string> {
  const { connection, payer, instructions } = opts;
  const { unitsConsumed } = await simulate(connection, payer, instructions);
  const budget = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: Math.ceil((unitsConsumed ?? 150_000) * 1.3) + 1_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
  ];
  let signature: string | undefined;
  await opts.authorizeAndSign(async wallet => {
    // Fetched inside the wallet session so the blockhash is as fresh as possible when signing.
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...budget, ...instructions);
    const signatures: string[] = await wallet.signAndSendTransactions({ transactions: [tx] });
    signature = signatures[0];
  });
  if (!signature) throw new TxError('unconfirmed');
  await confirm(connection, signature);
  return signature;
}

/** The user closed the wallet without approving: not an error worth showing. */
export function isWalletCancel(e: unknown): boolean {
  const msg = String((e as { message?: unknown })?.message ?? e);
  return msg.includes('CancellationException') || msg.toLowerCase().includes('cancelled');
}

/** Copy for a failed Locked In transaction. Describes what was observed, nothing more. */
export function txErrorMessage(e: unknown): string {
  if (!(e instanceof TxError)) return "Couldn't send the transaction. Please try again.";
  if (e.kind === 'unconfirmed') return "Couldn't confirm the transaction. Check your wallet before trying again.";
  // The wallet would be left below the minimum balance Solana requires an account to keep.
  if (e.reason === 'InsufficientFundsForRent') return 'Not enough SOL. A Solana wallet must keep a small minimum balance after the fee.';
  if (e.reason === 'InsufficientFundsForFee' || e.reason === 'AccountNotFound') return 'Not enough SOL for the network fee.';
  if (e.code === 1) {
    // Custom(1) is the token program's or the system program's "insufficient" error.
    if (e.logs.some(l => l.toLowerCase().includes('insufficient lamports'))) return 'Not enough SOL for the fee.';
    return 'Not enough SKR in this wallet.';
  }
  if (e.code === 3012) return 'This wallet has no SKR token account.';
  switch (e.code === undefined ? undefined : errorName(e.code)) {
    case 'DepositsPaused': return 'Joining is paused right now.';
    case 'JoiningClosed': return 'Joining has closed for this challenge.';
    case 'CohortFull': return 'This challenge is full.';
    case 'AlreadyJoined': return 'You have already joined this challenge.';
    case 'Unauthorized': return "Couldn't prepare the transaction. Please try again.";
    default:
      return e.kind === 'simulation'
        ? 'The program did not accept this transaction.'
        : 'The transaction failed on chain.';
  }
}
