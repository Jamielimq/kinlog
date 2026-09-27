// In-memory stand-in for the Locked In program, enforcing the same rules the server relies on
// (success window, settle order and tiers, retarget, returns, close, creation limits). Used to test
// the server logic against the Firestore emulator without a validator.
import { Keypair, PublicKey } from "@solana/web3.js";
import * as P from "../../src/chain/program.ts";
import { type Chain, ChainTxError, type CohortKey, keyOf } from "../../src/chain/types.ts";

const perr = (name: P.ProgramErrorName) => new ChainTxError(`fake: ${name}`, 6000 + P.ERROR_NAMES.indexOf(name), name);

export interface SentTx {
  op: string;
  cohort?: string;
  user?: string;
  target?: string;
}

export class FakeChain implements Chain {
  nowSec: number;
  config: P.ConfigState;
  cohorts = new Map<string, P.Cohort>();
  board = 500_000n;
  rounds = new Map<bigint, P.RoundState>();
  lamports = new Map<string, bigint>();
  vault = 100_100_000_000n; // 1.001 ORE
  sent: SentTx[] = [];
  /** How far the chain's clock trails `nowSec` (the program checks times against the chain clock). */
  clockLagSec = 0;
  /** Makes the next write of this op throw, once. */
  failNext = new Map<string, ChainTxError>();
  private n = 0;

  constructor(nowSec: number) {
    this.nowSec = nowSec;
    const key = () => Keypair.generate().publicKey;
    this.config = {
      admin: key(), cohortCreator: key(), attester: key(), crank: key(), feeWallet: key(),
      feeLamports: 1_000_000n, depositAmountMax: 100_000_000n, maxRewardPerBox: 10_000_000_000n,
      reservedTotal: 0n, minDaySeconds: 60, maxCapacity: 30, maxLiveCohorts: [4, 3], liveCohorts: [0, 0],
      depositsPaused: false,
    };
    for (const k of [this.config.cohortCreator, this.config.crank, this.config.attester]) this.lamports.set(k.toBase58(), 200_000_000n);
  }

  private cohort(k: CohortKey): P.Cohort {
    const c = this.cohorts.get(keyOf(k));
    if (!c) throw new ChainTxError(`fake: no cohort ${keyOf(k)}`);
    return c;
  }
  private slot(c: P.Cohort, user: PublicKey): P.Slot {
    const s = c.slots.find((x) => x.user.equals(user));
    if (!s) throw perr("NotParticipant");
    return s;
  }
  private record(t: SentTx): string {
    this.sent.push(t);
    return `fakesig${++this.n}`;
  }
  private check(op: string) {
    const fail = this.failNext.get(op);
    if (fail) {
      this.failNext.delete(op);
      throw fail;
    }
  }
  private clone(c: P.Cohort): P.Cohort {
    return { ...c, slots: c.slots.map((s) => ({ ...s })) };
  }

  // ---- reads ----
  async getConfig() {
    return { ...this.config, maxLiveCohorts: [...this.config.maxLiveCohorts] as [number, number], liveCohorts: [...this.config.liveCohorts] as [number, number] };
  }
  async getCohorts(keys: CohortKey[]) {
    return keys.map((k) => {
      const c = this.cohorts.get(keyOf(k));
      return c ? this.clone(c) : null;
    });
  }
  async getBoardRound() {
    return this.board;
  }
  async getRound(id: bigint) {
    return this.rounds.get(id) ?? { kind: "missing" as const };
  }
  async getLamports(addresses: PublicKey[]) {
    return addresses.map((a) => this.lamports.get(a.toBase58()) ?? 0n);
  }
  async getRewardVaultAmount() {
    return this.vault;
  }
  async getClock() {
    return Math.floor(this.chainNow());
  }
  private chainNow() {
    return this.nowSec - this.clockLagSec;
  }

  // ---- server writes (program rules) ----
  async markSuccess(k: CohortKey, user: PublicKey) {
    this.check("markSuccess");
    const c = this.cohort(k);
    const now = this.chainNow();
    if (!(now >= Number(P.lastDayStart(c)) && now < Number(c.deadlineTs))) throw perr("SuccessWindowClosed");
    this.slot(c, user).flags |= P.FLAG.SUCCESS;
    return this.record({ op: "markSuccess", cohort: keyOf(k), user: user.toBase58() });
  }

  async settle(k: CohortKey, target: bigint) {
    this.check("settle");
    const c = this.cohort(k);
    if (c.nextSettle >= c.picks) throw perr("NotPicked");
    const s = c.slots.find((x) => P.hasFlag(x, P.FLAG.PICKED) && !P.hasFlag(x, P.FLAG.SETTLED) && x.pickSeq === c.nextSettle);
    if (!s) throw perr("OutOfOrder");
    if (s.targetRound !== target) throw perr("InvalidRound");
    const round = this.rounds.get(target) ?? { kind: "missing" as const };
    const finished = this.board > target;
    let tier: number;
    if (round.kind === "present" && round.rng !== null) {
      tier = P.hitMotherlode(round.rng) ? P.TIER.LEGENDARY : s.square === P.winningSquare(round.rng) ? P.TIER.RARE : P.TIER.COMMON;
    } else if (round.kind === "missing" && finished) {
      tier = P.TIER.COMMON;
    } else if (round.kind === "present" && finished) {
      throw perr("RoundNeedsRetarget");
    } else {
      throw perr("RoundNotRevealed");
    }
    if (tier === P.TIER.LEGENDARY && c.legendaryAwarded >= P.LEGENDARY_CAP) tier = P.TIER.RARE;
    if (tier === P.TIER.RARE && c.rareAwarded >= P.RARE_CAP) tier = P.TIER.COMMON;
    if (tier === P.TIER.LEGENDARY) c.legendaryAwarded++;
    if (tier === P.TIER.RARE) c.rareAwarded++;
    s.tier = tier;
    s.amount = c.commonAmount * (tier === P.TIER.LEGENDARY ? P.LEGENDARY_MULTIPLIER : tier === P.TIER.RARE ? P.RARE_MULTIPLIER : 1n);
    s.flags |= P.FLAG.SETTLED;
    c.nextSettle++;
    return this.record({ op: "settle", cohort: keyOf(k), user: s.user.toBase58(), target: target.toString() });
  }

  async retarget(k: CohortKey, user: PublicKey, target: bigint) {
    this.check("retarget");
    const c = this.cohort(k);
    const s = this.slot(c, user);
    if (!P.hasFlag(s, P.FLAG.PICKED)) throw perr("NotPicked");
    if (P.hasFlag(s, P.FLAG.SETTLED)) throw perr("AlreadySettled");
    if (!(this.board > s.targetRound) || s.targetRound !== target) throw perr("RetargetNotAllowed");
    const round = this.rounds.get(target);
    if (!(round?.kind === "present" && round.rng === null)) throw perr("RetargetNotAllowed");
    s.targetRound = this.board + 1n;
    return this.record({ op: "retarget", cohort: keyOf(k), user: user.toBase58(), target: target.toString() });
  }

  async returnDeposit(k: CohortKey, depositor: PublicKey) {
    this.check("returnDeposit");
    const c = this.cohort(k);
    if (this.nowSec < Number(c.endTs)) throw perr("CohortNotEnded");
    const s = this.slot(c, depositor);
    if (P.hasFlag(s, P.FLAG.RETURNED)) throw perr("AlreadyReturned");
    s.flags |= P.FLAG.RETURNED;
    c.returned++;
    return this.record({ op: "returnDeposit", cohort: keyOf(k), user: depositor.toBase58() });
  }

  async closeCohort(k: CohortKey, creator: PublicKey) {
    this.check("closeCohort");
    const c = this.cohort(k);
    if (!creator.equals(c.creator)) throw perr("Unauthorized");
    if (this.chainNow() < Number(c.deadlineTs)) throw perr("DeadlineNotPassed");
    if (c.returned !== c.participants) throw perr("DepositsOutstanding");
    this.cohorts.delete(keyOf(k));
    this.config.reservedTotal -= c.reserved;
    this.config.liveCohorts[k.kind]--;
    return this.record({ op: "closeCohort", cohort: keyOf(k) });
  }

  async createCohort(k: CohortKey, startTs: bigint, daySeconds: number, depositAmount: bigint, common: bigint) {
    this.check("createCohort");
    this.create(k, startTs, daySeconds, depositAmount, common);
    return this.record({ op: "createCohort", cohort: keyOf(k) });
  }

  private create(k: CohortKey, startTs: bigint, daySeconds: number, depositAmount: bigint, common: bigint) {
    const cfg = this.config;
    if (this.cohorts.has(keyOf(k))) throw new ChainTxError("fake: account already in use");
    if (daySeconds < cfg.minDaySeconds || daySeconds > P.SECONDS_PER_DAY) throw perr("InvalidDayLength");
    if (daySeconds === P.SECONDS_PER_DAY && ((Number(startTs) % 86_400) + 86_400) % 86_400 !== P.REAL_COHORT_START_OFFSET) throw perr("MisalignedStart");
    if (!(Number(startTs) > this.nowSec)) throw perr("StartInPast");
    const days = P.DAYS_FOR_KIND[k.kind];
    const endTs = startTs + BigInt(days * daySeconds);
    if (Number(endTs) > this.nowSec + P.MAX_END_AHEAD) throw perr("EndTooFar");
    if (depositAmount <= 0n || depositAmount > cfg.depositAmountMax) throw perr("InvalidDepositAmount");
    if (common <= 0n || common % P.ORE_REWARD_GRANULARITY !== 0n) throw perr("InvalidRewardAmount");
    if (common * P.LEGENDARY_MULTIPLIER > cfg.maxRewardPerBox) throw perr("RewardAboveMax");
    if (cfg.liveCohorts[k.kind] >= cfg.maxLiveCohorts[k.kind]) throw perr("TooManyLiveCohorts");
    const reserve = P.worstCaseReward(common, cfg.maxCapacity);
    if (this.vault - cfg.reservedTotal < reserve) throw perr("InsufficientRewardVault");
    cfg.reservedTotal += reserve;
    cfg.liveCohorts[k.kind]++;
    this.cohorts.set(keyOf(k), {
      creator: cfg.cohortCreator, startTs, endTs, deadlineTs: endTs + BigInt(P.CLAIM_WINDOW_DAYS * daySeconds),
      depositAmount, feeLamports: cfg.feeLamports, commonAmount: common, reserved: reserve, paid: 0n,
      id: k.id, daySeconds, kind: k.kind, days, capacity: cfg.maxCapacity, participants: 0, picks: 0, nextSettle: 0,
      legendaryAwarded: 0, rareAwarded: 0, returned: 0, slots: [],
    });
  }

  // ---- participant actions (the app's side) ----
  join(k: CohortKey, user: PublicKey) {
    const c = this.cohort(k);
    if (!(this.nowSec < Number(P.joiningCloses(c)))) throw perr("JoiningClosed");
    if (c.slots.some((s) => s.user.equals(user))) throw perr("AlreadyJoined");
    c.slots.push({ user, targetRound: 0n, amount: 0n, square: 0, pickSeq: 0, tier: 0, flags: P.FLAG.OCCUPIED });
    c.participants++;
  }
  pick(k: CohortKey, user: PublicKey, square: number) {
    const c = this.cohort(k);
    const s = this.slot(c, user);
    if (!P.hasFlag(s, P.FLAG.SUCCESS)) throw perr("NotSuccessful");
    if (P.hasFlag(s, P.FLAG.PICKED)) throw perr("AlreadyPicked");
    Object.assign(s, { square, targetRound: this.board + 1n, pickSeq: c.picks, flags: s.flags | P.FLAG.PICKED });
    c.picks++;
  }
  withdraw(k: CohortKey, user: PublicKey) {
    const c = this.cohort(k);
    if (this.nowSec < Number(c.endTs)) throw perr("CohortNotEnded");
    const s = this.slot(c, user);
    if (P.hasFlag(s, P.FLAG.RETURNED)) throw perr("AlreadyReturned");
    s.flags |= P.FLAG.RETURNED;
    c.returned++;
  }
  /** Test cohort created directly (as the CLI would), bypassing the schedule. */
  addCohort(k: CohortKey, startTs: number, daySeconds: number, common = 164_000_000n, deposit = 1_000_000n) {
    const saved = this.nowSec;
    this.nowSec = Math.min(this.nowSec, startTs - 1);
    try {
      this.create(k, BigInt(startTs), daySeconds, deposit, common);
    } finally {
      this.nowSec = saved;
    }
  }
  setRound(id: bigint, rng: bigint | null | "missing") {
    this.rounds.set(id, rng === "missing" ? { kind: "missing" } : { kind: "present", rng });
  }
}

/** An rng whose ORE result is `square`, with or without a motherlode (tests/common/mod.rs rng_for). */
export function rngFor(square: number, motherlode: boolean): bigint {
  for (let k = 1n; ; k++) {
    const r = motherlode ? reverse64(k * 500n) : (k * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    if (P.winningSquare(r) === square && P.hitMotherlode(r) === motherlode) return r;
  }
}
function reverse64(x: bigint): bigint {
  let r = 0n;
  for (let i = 0; i < 64; i++) {
    r = (r << 1n) | (x & 1n);
    x >>= 1n;
  }
  return r;
}
export const newWallet = () => Keypair.generate().publicKey;
export { PublicKey };
