// Chain implementation over a Solana RPC. Reads fall back to a second connection when the primary
// fails; transactions only go through the primary.
import { type Connection, type Keypair, type PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import * as P from "./program.ts";
import { sendTx, type SendOptions } from "./send.ts";
import { type Chain, type CohortKey, keyOf } from "./types.ts";

export interface ServerKeys {
  cohortCreator?: Keypair;
  attester?: Keypair;
  crank?: Keypair;
}

export class SolanaChain implements Chain {
  constructor(
    private readonly conn: Connection,
    private readonly fallback: Connection | null,
    private readonly keys: ServerKeys,
    private readonly sendOpts: SendOptions = {},
  ) {}

  private async read<T>(f: (c: Connection) => Promise<T>): Promise<T> {
    try {
      return await f(this.conn);
    } catch (e) {
      if (!this.fallback) throw e;
      return f(this.fallback);
    }
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

  markSuccess(k: CohortKey, user: PublicKey) {
    const a = this.key("attester");
    return sendTx(this.conn, [P.ixMarkSuccess(a.publicKey, k.kind, k.id, user)], a, `mark_success ${keyOf(k)}`, this.sendOpts);
  }
  settle(k: CohortKey, targetRound: bigint) {
    return sendTx(this.conn, [P.ixSettle(k.kind, k.id, targetRound)], this.key("crank"), `settle ${keyOf(k)}`, this.sendOpts);
  }
  retarget(k: CohortKey, user: PublicKey, targetRound: bigint) {
    return sendTx(this.conn, [P.ixRetarget(k.kind, k.id, user, targetRound)], this.key("crank"), `retarget ${keyOf(k)}`, this.sendOpts);
  }
  returnDeposit(k: CohortKey, depositor: PublicKey) {
    const c = this.key("crank");
    return sendTx(this.conn, [P.ixReturnDeposit(c.publicKey, k.kind, k.id, depositor)], c, `return_deposit ${keyOf(k)}`, this.sendOpts);
  }
  closeCohort(k: CohortKey, creator: PublicKey) {
    return sendTx(this.conn, [P.ixCloseCohort(k.kind, k.id, creator)], this.key("crank"), `close_cohort ${keyOf(k)}`, this.sendOpts);
  }
  createCohort(k: CohortKey, startTs: bigint, daySeconds: number, depositAmount: bigint, commonAmount: bigint) {
    const cr = this.key("cohortCreator");
    const ix = P.ixCreateCohort(cr.publicKey, k.kind, k.id, startTs, daySeconds, depositAmount, commonAmount);
    return sendTx(this.conn, [ix], cr, `create_cohort ${keyOf(k)}`, this.sendOpts);
  }
}
