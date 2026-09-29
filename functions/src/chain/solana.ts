// Chain implementation over a Solana RPC. The primary RPC (SERVER_RPC_URL) is checked once per
// instance against the expected genesis hash: on another cluster, reads use the fallback only and every
// transaction is refused. Reads that fail on the primary fall back to the second connection;
// transactions only ever go through the primary.
import { type Connection, type Keypair, type PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import * as P from "./program.ts";
import { sendTx, type SendOptions } from "./send.ts";
import { type Chain, ChainTxError, type CohortKey, keyOf } from "./types.ts";

export interface ServerKeys {
  cohortCreator?: Keypair;
  attester?: Keypair;
  crank?: Keypair;
}

/** What the chain reports about its primary RPC; index.ts turns these into logs and alerts. */
export type RpcEvent =
  | { kind: "verified"; genesis: string }
  | { kind: "genesis_mismatch"; genesis: string }
  | { kind: "genesis_unreachable"; error: unknown }
  | { kind: "fallback"; error: unknown };

export interface ChainOptions {
  sendOpts?: SendOptions;
  /** Genesis hash the primary RPC must serve (mainnet). Unset for a local validator: no check. */
  expectedGenesis?: string;
  onRpcEvent?: (e: RpcEvent) => void | Promise<void>;
  /** Wait before the one retry of a failed genesis check. */
  genesisRetryMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SolanaChain implements Chain {
  private check: Promise<void> | null = null;
  private wrongCluster = false;

  constructor(
    private readonly conn: Connection,
    private readonly fallback: Connection | null,
    private readonly keys: ServerKeys,
    private readonly opts: ChainOptions = {},
  ) {}

  /** Reporting must never break the chain. */
  private async emit(e: RpcEvent) {
    try {
      await this.opts.onRpcEvent?.(e);
    } catch {
      // ignored
    }
  }

  /** Once per instance: does the primary RPC serve the expected cluster? */
  private verifyPrimary(): Promise<void> {
    const expected = this.opts.expectedGenesis;
    if (!expected) return Promise.resolve();
    this.check ??= (async () => {
      let genesis: string | undefined;
      let error: unknown;
      for (let attempt = 0; attempt < 2 && genesis === undefined; attempt++) {
        if (attempt) await sleep(this.opts.genesisRetryMs ?? 2_000);
        try {
          genesis = await this.conn.getGenesisHash();
        } catch (e) {
          error = e;
        }
      }
      if (genesis === undefined) {
        this.check = null; // check again on the next use
        await this.emit({ kind: "genesis_unreachable", error });
      } else if (genesis !== expected) {
        this.wrongCluster = true;
        await this.emit({ kind: "genesis_mismatch", genesis });
      } else {
        await this.emit({ kind: "verified", genesis });
      }
    })();
    return this.check;
  }

  private async read<T>(f: (c: Connection) => Promise<T>): Promise<T> {
    await this.verifyPrimary();
    if (this.wrongCluster) {
      if (!this.fallback) throw new Error("SERVER_RPC_URL is not the expected cluster");
      return f(this.fallback);
    }
    try {
      return await f(this.conn);
    } catch (e) {
      if (!this.fallback) throw e;
      await this.emit({ kind: "fallback", error: e });
      return f(this.fallback);
    }
  }

  /** The connection every transaction goes through; refused when the primary is another cluster. */
  private async primaryForWrites(): Promise<Connection> {
    await this.verifyPrimary();
    if (this.wrongCluster) throw new ChainTxError("SERVER_RPC_URL is not the expected cluster; transactions are refused");
    return this.conn;
  }

  private key(role: keyof ServerKeys): Keypair {
    const kp = this.keys[role];
    if (!kp) throw new Error(`${role} key is not available to this function`);
    return kp;
  }

  async getConfig() {
    const a = await this.read((c) => c.getAccountInfo(P.configPda()));
    if (!a) throw new Error("Locked In config is not initialised");
    return P.decodeConfig(a.data);
  }

  async getCohorts(keys: CohortKey[]) {
    const out: (P.Cohort | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const infos = await this.read((c) => c.getMultipleAccountsInfo(chunk.map((k) => P.cohortPda(k.kind, k.id))));
      for (const a of infos) out.push(a && a.owner.equals(P.PROGRAM_ID) && P.isCohortAccount(a.data) ? P.decodeCohort(a.data) : null);
    }
    return out;
  }

  async getBoardRound() {
    return P.decodeBoardRoundId(await this.read((c) => c.getAccountInfo(P.ORE_BOARD)));
  }

  async getRound(id: bigint) {
    return P.readRound(await this.read((c) => c.getAccountInfo(P.roundPda(id))), id);
  }

  async getLamports(addresses: PublicKey[]) {
    const infos = await this.read((c) => c.getMultipleAccountsInfo(addresses));
    return infos.map((a) => BigInt(a?.lamports ?? 0));
  }

  async getClock() {
    const a = await this.read((c) => c.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"));
    if (!a) throw new Error("clock sysvar not found");
    return Number(a.data.readBigInt64LE(32));
  }

  async getRewardVaultAmount() {
    return P.tokenAmount(await this.read((c) => c.getAccountInfo(P.rewardVaultPda()))) ?? 0n;
  }

  async markSuccess(k: CohortKey, user: PublicKey) {
    const a = this.key("attester");
    return sendTx(await this.primaryForWrites(), [P.ixMarkSuccess(a.publicKey, k.kind, k.id, user)], a, `mark_success ${keyOf(k)}`, this.opts.sendOpts);
  }
  async settle(k: CohortKey, targetRound: bigint) {
    const c = this.key("crank");
    return sendTx(await this.primaryForWrites(), [P.ixSettle(k.kind, k.id, targetRound)], c, `settle ${keyOf(k)}`, this.opts.sendOpts);
  }
  async retarget(k: CohortKey, user: PublicKey, targetRound: bigint) {
    const c = this.key("crank");
    return sendTx(await this.primaryForWrites(), [P.ixRetarget(k.kind, k.id, user, targetRound)], c, `retarget ${keyOf(k)}`, this.opts.sendOpts);
  }
  async returnDeposit(k: CohortKey, depositor: PublicKey) {
    const c = this.key("crank");
    return sendTx(await this.primaryForWrites(), [P.ixReturnDeposit(c.publicKey, k.kind, k.id, depositor)], c, `return_deposit ${keyOf(k)}`, this.opts.sendOpts);
  }
  async closeCohort(k: CohortKey, creator: PublicKey) {
    const c = this.key("crank");
    return sendTx(await this.primaryForWrites(), [P.ixCloseCohort(k.kind, k.id, creator)], c, `close_cohort ${keyOf(k)}`, this.opts.sendOpts);
  }
  async createCohort(k: CohortKey, startTs: bigint, daySeconds: number, depositAmount: bigint, commonAmount: bigint) {
    const cr = this.key("cohortCreator");
    const ix = P.ixCreateCohort(cr.publicKey, k.kind, k.id, startTs, daySeconds, depositAmount, commonAmount);
    return sendTx(await this.primaryForWrites(), [ix], cr, `create_cohort ${keyOf(k)}`, this.opts.sendOpts);
  }
}
