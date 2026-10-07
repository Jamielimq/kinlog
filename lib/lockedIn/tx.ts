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
// Long enough for a sent transaction to land or for its blockhash to expire (150 blocks after it was
// fetched, about a minute), so that "unconfirmed" means the RPC couldn't tell us either way.
const CONFIRM_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_MS = 1_500;

const messageOf = (e: unknown) => String((e as { message?: unknown })?.message ?? e);

/** What went wrong, for each screen to put in its own words (the join screen: joinErrorAlert). */
export class TxError extends Error {
  constructor(
    // simulation: refused before the wallet opened. network: an RPC call failed before sending.
    // wallet: the wallet failed (a cancel is not one). failed: landed with an error. expired: never
    // landed and no longer can. unconfirmed: sent, and the outcome is unknown.
    readonly kind: 'simulation' | 'network' | 'wallet' | 'failed' | 'expired' | 'unconfirmed',
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

/**
 * Simulates without signatures; throws TxError('simulation') with the program's error code, or
 * TxError('network') when the RPC can't be reached.
 */
export async function simulate(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<{ unitsConsumed?: number; logs: string[] }> {
  let sim: Awaited<ReturnType<Connection['simulateTransaction']>>;
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    const message = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...instructions).compileMessage();
    sim = await connection.simulateTransaction(new VersionedTransaction(message), {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
  } catch (e) {
    throw new TxError('network', undefined, [], messageOf(e));
  }
  const logs = sim.value.logs ?? [];
  if (sim.value.err) throw new TxError('simulation', customCode(sim.value.err), logs, errorReason(sim.value.err));
  return { unitsConsumed: sim.value.unitsConsumed, logs };
}

/**
 * Waits for the transaction to land, or for its blockhash to expire: once the block height passes
 * lastValidBlockHeight, a transaction that hasn't landed never will. A failed poll is retried.
 */
async function confirm(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<void> {
  const until = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < until) {
    try {
      const status = (await connection.getSignatureStatuses([signature])).value[0];
      if (status?.err) throw new TxError('failed', customCode(status.err), [], errorReason(status.err));
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
      if (!status && (await connection.getBlockHeight()) > lastValidBlockHeight) {
        // One more look, in case it landed in a block just before the line.
        if (!(await connection.getSignatureStatuses([signature])).value[0]) throw new TxError('expired');
      }
    } catch (e) {
      if (e instanceof TxError) throw e;
      console.log('Confirmation poll failed:', messageOf(e));
    }
    await new Promise(resolve => setTimeout(resolve, CONFIRM_POLL_MS));
  }
  throw new TxError('unconfirmed');
}

type AuthorizeAndSign = (callback: (wallet: any, authToken: string) => Promise<void>) => Promise<void>;

/**
 * Simulates, has the wallet sign and send, and waits for confirmation. Returns the signature. onSent,
 * if given, gets the signature as soon as the wallet has sent the transaction, before confirmation,
 * so a caller can keep it in case the outcome isn't known here (its own failure is only logged).
 */
export async function sendWithWallet(opts: {
  connection: Connection;
  payer: PublicKey;
  instructions: TransactionInstruction[];
  authorizeAndSign: AuthorizeAndSign;
  onSent?: (signature: string, lastValidBlockHeight: number) => Promise<void> | void;
}): Promise<string> {
  const { connection, payer, instructions } = opts;
  const { unitsConsumed } = await simulate(connection, payer, instructions);
  const budget = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: Math.ceil((unitsConsumed ?? 150_000) * 1.3) + 1_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
  ];
  let signature: string | undefined;
  let lastValidBlockHeight = 0;
  try {
    await opts.authorizeAndSign(async wallet => {
      // Fetched inside the wallet session so the blockhash is as fresh as possible when signing.
      let latest: { blockhash: string; lastValidBlockHeight: number };
      try {
        latest = await connection.getLatestBlockhash();
      } catch (e) {
        throw new TxError('network', undefined, [], messageOf(e));
      }
      lastValidBlockHeight = latest.lastValidBlockHeight;
      const tx = new Transaction({ feePayer: payer, recentBlockhash: latest.blockhash }).add(...budget, ...instructions);
      const signatures: string[] = await wallet.signAndSendTransactions({ transactions: [tx] });
      signature = signatures[0];
      // Inside the wallet session, before anything else can fail.
      if (signature && opts.onSent) {
        try {
          await opts.onSent(signature, lastValidBlockHeight);
        } catch (e) {
          console.log('onSent failed:', messageOf(e));
        }
      }
    });
  } catch (e) {
    // A cancel passes through unchanged (the caller shows nothing); anything else the wallet raised
    // is a wallet error.
    if (e instanceof TxError || isWalletCancel(e)) throw e;
    throw new TxError('wallet', undefined, [], messageOf(e));
  }
  if (!signature) throw new TxError('unconfirmed');
  await confirm(connection, signature, lastValidBlockHeight);
  return signature;
}

/** The user closed the wallet without approving: not an error worth showing. */
export function isWalletCancel(e: unknown): boolean {
  const msg = messageOf(e);
  return msg.includes('CancellationException') || msg.toLowerCase().includes('cancelled');
}
