// Sends one transaction: priority fee, simulation first (a program error is reported with its code
// and costs nothing), then broadcast and rebroadcast until confirmed or the blockhash expires.
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  type TransactionError,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { errorName } from "./program.ts";
import { ChainTxError } from "./types.ts";

export interface SendOptions {
  computeUnits?: number;
  microLamports?: number;
  attempts?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function toChainError(label: string, err: TransactionError | string, logs: string[]): ChainTxError {
  const insufficient =
    err === "InsufficientFundsForFee" ||
    err === "InsufficientFundsForRent" ||
    logs.some((l) => /insufficient lamports|insufficient funds/i.test(l));
  const ie = typeof err === "object" && err !== null ? (err as { InstructionError?: [number, unknown] }).InstructionError : undefined;
  const custom = ie && typeof ie[1] === "object" && ie[1] !== null ? (ie[1] as { Custom?: number }).Custom : undefined;
  const name = custom !== undefined ? errorName(custom) : undefined;
  const detail = name ?? (custom !== undefined ? `custom ${custom}` : JSON.stringify(err));
  return new ChainTxError(`${label}: ${detail}`, custom, name, insufficient);
}

export async function sendTx(
  conn: Connection,
  ixs: TransactionInstruction[],
  payer: Keypair,
  label: string,
  opts: SendOptions = {},
): Promise<string> {
  const { computeUnits = 200_000, microLamports = 20_000, attempts = 3, pollMs = 1_500 } = opts;
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...ixs,
  ];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) throw toChainError(label, sim.value.err, sim.value.logs ?? []);

    const raw = tx.serialize();
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    for (;;) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw toChainError(label, st.err, []);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
      await sleep(pollMs);
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
    // The blockhash expired; the transaction may still have landed in the last blocks.
    const last = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (last?.err) throw toChainError(label, last.err, []);
    if (last?.confirmationStatus === "confirmed" || last?.confirmationStatus === "finalized") return sig;
  }
  throw new ChainTxError(`${label}: not confirmed after ${attempts} attempts`);
}
