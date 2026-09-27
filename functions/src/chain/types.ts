import type { PublicKey } from "@solana/web3.js";
import type { Cohort, ConfigState, RoundState } from "./program.ts";

export interface CohortKey {
  kind: number;
  id: number;
}
/** Firestore document id for a cohort: `<kind>-<id>`. */
export const keyOf = (k: CohortKey) => `${k.kind}-${k.id}`;

export interface ChainReader {
  getConfig(): Promise<ConfigState>;
  /** Decoded cohorts in the same order; null where no cohort account exists. */
  getCohorts(keys: CohortKey[]): Promise<(Cohort | null)[]>;
  getBoardRound(): Promise<bigint>;
  getRound(id: bigint): Promise<RoundState>;
  getLamports(addresses: PublicKey[]): Promise<bigint[]>;
  getRewardVaultAmount(): Promise<bigint>;
  /** Unix time of the latest confirmed bank (Clock sysvar): the clock the program's time checks use. */
  getClock(): Promise<number>;
}

/** Each write is signed by the one server key allowed to send it; see docs/LOCKED_IN.md section 6. */
export interface ChainWriter {
  markSuccess(k: CohortKey, user: PublicKey): Promise<string>;
  settle(k: CohortKey, targetRound: bigint): Promise<string>;
  retarget(k: CohortKey, user: PublicKey, targetRound: bigint): Promise<string>;
  returnDeposit(k: CohortKey, depositor: PublicKey): Promise<string>;
  closeCohort(k: CohortKey, creator: PublicKey): Promise<string>;
  createCohort(k: CohortKey, startTs: bigint, daySeconds: number, depositAmount: bigint, commonAmount: bigint): Promise<string>;
}

export interface Chain extends ChainReader, ChainWriter {}

export class ChainTxError extends Error {
  constructor(
    message: string,
    /** Custom program error code (6000+ for Locked In), when the failure carried one. */
    readonly code?: number,
    readonly programError?: string,
    readonly insufficientFunds = false,
  ) {
    super(message);
  }
}
export const isProgramError = (e: unknown, name: string) => e instanceof ChainTxError && e.programError === name;
