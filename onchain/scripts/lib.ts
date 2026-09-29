// Shared helpers for the Locked In operator CLI. Never prints secret material: keypairs are loaded
// from explicit paths and only their public keys are shown.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const PROGRAM_ID = new PublicKey("9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby");
export const SKR_MINT = new PublicKey("SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3");
export const ORE_MINT = new PublicKey("oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp");
export const ORE_PROGRAM_ID = new PublicKey("oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv");
export const ORE_BOARD = new PublicKey("BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi");
export const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const SKR_DECIMALS = 6;
export const ORE_DECIMALS = 11;

// ---- network --------------------------------------------------------------------------------------

export type Cluster = "local" | "devnet" | "mainnet";
export const GENESIS: Record<Exclude<Cluster, "local">, string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

export async function connect(cluster: Cluster, confirmMainnet: boolean): Promise<Connection> {
  const url =
    cluster === "local"
      ? "http://127.0.0.1:8899"
      : cluster === "devnet"
        ? "https://api.devnet.solana.com"
        : "https://api.mainnet-beta.solana.com";
  const host = new URL(url).host;
  const banner = { local: "LOCAL (127.0.0.1)", devnet: "DEVNET", mainnet: "*** MAINNET ***" }[cluster];
  console.log(`NETWORK: ${banner}  rpc host: ${host}`);
  if (cluster === "mainnet" && !confirmMainnet) {
    throw new Error("mainnet requires --confirm-mainnet (only after the owner approved this exact command)");
  }
  const conn = new Connection(url, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (cluster === "local") {
    if (host !== "127.0.0.1:8899") throw new Error("local cluster must be 127.0.0.1:8899");
  } else if (genesis !== GENESIS[cluster]) {
    throw new Error(`genesis mismatch for ${cluster}: ${genesis}`);
  }
  return conn;
}

// ---- keys -----------------------------------------------------------------------------------------

export function loadKeypair(p: string | undefined, label: string): Keypair {
  if (!p) throw new Error(`--${label} <keypair path> is required (no default id.json)`);
  const resolved = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8"))));
  console.log(`${label}: ${kp.publicKey.toBase58()}  (${resolved})`);
  return kp;
}

export const pk = (s: string | undefined, label: string) => {
  if (!s) throw new Error(`--${label} <address> is required`);
  return new PublicKey(s);
};

// ---- PDAs -----------------------------------------------------------------------------------------

const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
};
const pda = (seeds: Buffer[], program = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const configPda = () => pda([Buffer.from("config")]);
export const rewardVaultPda = () => pda([Buffer.from("reward_vault")]);
export const cohortPda = (kind: number, id: number) => pda([Buffer.from("cohort"), Buffer.from([kind]), u32le(id)]);
export const skrVaultPda = (cohort: PublicKey) => pda([Buffer.from("skr_vault"), cohort.toBuffer()]);
export const roundPda = (id: bigint) => pda([Buffer.from("round"), u64le(id)], ORE_PROGRAM_ID);
export const programDataPda = () => pda([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE);

// ---- instruction encoding (Anchor: sha256("global:<name>")[..8] ++ borsh args) --------------------

const disc = (name: string) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const data = (name: string, ...parts: Buffer[]) => Buffer.concat([disc(name), ...parts]);
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const ix = (name: string, keys: TransactionInstruction["keys"], ...args: Buffer[]) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys, data: data(name, ...args) });

export interface Limits {
  feeLamports: bigint;
  depositAmountMax: bigint;
  maxRewardPerBox: bigint;
  minDaySeconds: number;
  maxCapacity: number;
  maxLiveCohorts: [number, number];
}
const encLimits = (l: Limits) =>
  Buffer.concat([
    u64le(l.feeLamports),
    u64le(l.depositAmountMax),
    u64le(l.maxRewardPerBox),
    u32le(l.minDaySeconds),
    Buffer.from([l.maxCapacity, l.maxLiveCohorts[0], l.maxLiveCohorts[1]]),
  ]);
export interface Roles {
  cohortCreator: PublicKey;
  attester: PublicKey;
  crank: PublicKey;
}
const encRoles = (x: Roles) => Buffer.concat([x.cohortCreator.toBuffer(), x.attester.toBuffer(), x.crank.toBuffer()]);

export const ixInitConfig = (authority: PublicKey, admin: PublicKey, feeWallet: PublicKey, roles: Roles, limits: Limits) =>
  ix(
    "init_config",
    [
      w(authority, true),
      r(PROGRAM_ID),
      r(programDataPda()),
      w(configPda()),
      r(ORE_MINT),
      w(rewardVaultPda()),
      r(TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    admin.toBuffer(),
    feeWallet.toBuffer(),
    encRoles(roles),
    encLimits(limits),
  );

const adminKeys = (admin: PublicKey) => [r(admin, true), w(configPda())];
export const ixSetLimits = (admin: PublicKey, l: Limits) => ix("set_limits", adminKeys(admin), encLimits(l));
export const ixSetRoles = (admin: PublicKey, x: Roles) => ix("set_roles", adminKeys(admin), encRoles(x));
export const ixSetFeeWallet = (admin: PublicKey, f: PublicKey) => ix("set_fee_wallet", adminKeys(admin), f.toBuffer());
export const ixSetAdmin = (admin: PublicKey, a: PublicKey) => ix("set_admin", adminKeys(admin), a.toBuffer());
export const ixPauseDeposits = (admin: PublicKey, p: boolean) => ix("pause_deposits", adminKeys(admin), Buffer.from([p ? 1 : 0]));

export const ixCreateCohort = (
  creator: PublicKey,
  kind: number,
  id: number,
  startTs: bigint,
  daySeconds: number,
  depositAmount: bigint,
  commonAmount: bigint,
) => {
  const cohort = cohortPda(kind, id);
  return ix(
    "create_cohort",
    [
      w(creator, true),
      w(configPda()),
      w(cohort),
      w(skrVaultPda(cohort)),
      r(SKR_MINT),
      r(rewardVaultPda()),
      r(TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    Buffer.from([kind]),
    u32le(id),
    i64le(startTs),
    u32le(daySeconds),
    u64le(depositAmount),
    u64le(commonAmount),
  );
};

export const ixDeposit = (user: PublicKey, kind: number, id: number, feeWallet: PublicKey) => {
  const cohort = cohortPda(kind, id);
  return ix("deposit", [
    w(user, true),
    r(configPda()),
    w(cohort),
    w(skrVaultPda(cohort)),
    w(getAssociatedTokenAddressSync(SKR_MINT, user)),
    r(SKR_MINT),
    w(feeWallet),
    r(TOKEN_PROGRAM_ID),
    r(SystemProgram.programId),
  ]);
};

export const ixWithdraw = (user: PublicKey, kind: number, id: number) => {
  const cohort = cohortPda(kind, id);
  return ix("withdraw", [
    r(user, true),
    w(cohort),
    w(skrVaultPda(cohort)),
    w(getAssociatedTokenAddressSync(SKR_MINT, user)),
    r(SKR_MINT),
    r(TOKEN_PROGRAM_ID),
  ]);
};

export const ixReturnDeposit = (caller: PublicKey, kind: number, id: number, depositor: PublicKey) => {
  const cohort = cohortPda(kind, id);
  return ix("return_deposit", [
    w(caller, true),
    r(configPda()),
    w(cohort),
    w(skrVaultPda(cohort)),
    r(depositor),
    w(getAssociatedTokenAddressSync(SKR_MINT, depositor)),
    r(SKR_MINT),
    r(TOKEN_PROGRAM_ID),
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    r(SystemProgram.programId),
  ]);
};

export const ixMarkSuccess = (attester: PublicKey, kind: number, id: number, user: PublicKey) =>
  ix("mark_success", [r(attester, true), r(configPda()), w(cohortPda(kind, id))], user.toBuffer());

export const ixPickSquare = (user: PublicKey, kind: number, id: number, square: number) =>
  ix("pick_square", [r(user, true), w(cohortPda(kind, id)), r(ORE_BOARD)], Buffer.from([square]));

export const ixSettle = (kind: number, id: number, targetRound: bigint) =>
  ix("settle", [w(cohortPda(kind, id)), r(ORE_BOARD), r(roundPda(targetRound))]);

export const ixRetarget = (kind: number, id: number, user: PublicKey, targetRound: bigint) =>
  ix("retarget", [w(cohortPda(kind, id)), r(ORE_BOARD), r(roundPda(targetRound))], user.toBuffer());

export const ixClaimReward = (user: PublicKey, kind: number, id: number) =>
  ix("claim_reward", [
    w(user, true),
    w(configPda()),
    w(cohortPda(kind, id)),
    w(rewardVaultPda()),
    w(getAssociatedTokenAddressSync(ORE_MINT, user)),
    r(ORE_MINT),
    r(TOKEN_PROGRAM_ID),
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    r(SystemProgram.programId),
  ]);

export const ixCloseCohort = (kind: number, id: number, creator: PublicKey) => {
  const cohort = cohortPda(kind, id);
  return ix("close_cohort", [
    w(configPda()),
    w(cohort),
    w(creator),
    w(skrVaultPda(cohort)),
    w(SKR_MINT),
    r(TOKEN_PROGRAM_ID),
  ]);
};

/** BPF upgradeable loader `Upgrade` (tag 3), signed by the current upgrade authority. */
export const ixUpgrade = (buffer: PublicKey, spill: PublicKey, authority: PublicKey) =>
  new TransactionInstruction({
    programId: BPF_UPGRADEABLE,
    keys: [
      w(programDataPda()),
      w(PROGRAM_ID),
      w(buffer),
      w(spill),
      r(SYSVAR_RENT_PUBKEY),
      r(SYSVAR_CLOCK_PUBKEY),
      r(authority, true),
    ],
    data: Buffer.from([3, 0, 0, 0]),
  });

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const ixMemo = (signer: PublicKey, text: string) =>
  new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [r(signer, true)], data: Buffer.from(text, "utf8") });

// ---- account decoding -----------------------------------------------------------------------------

export interface Slot {
  user: PublicKey;
  targetRound: bigint;
  amount: bigint;
  square: number;
  pickSeq: number;
  tier: number;
  flags: number;
}
export interface Cohort {
  creator: PublicKey;
  startTs: bigint;
  endTs: bigint;
  deadlineTs: bigint;
  depositAmount: bigint;
  feeLamports: bigint;
  commonAmount: bigint;
  reserved: bigint;
  paid: bigint;
  id: number;
  daySeconds: number;
  kind: number;
  days: number;
  capacity: number;
  participants: number;
  picks: number;
  nextSettle: number;
  legendaryAwarded: number;
  rareAwarded: number;
  returned: number;
  slots: Slot[];
}
export function decodeCohort(d: Buffer): Cohort {
  let o = 8;
  const pkey = () => new PublicKey(d.subarray(o, (o += 32)));
  const u64 = () => d.readBigUInt64LE((o += 8) - 8);
  const i64 = () => d.readBigInt64LE((o += 8) - 8);
  const u32 = () => d.readUInt32LE((o += 4) - 4);
  const u8 = () => d[o++];
  const c: any = {
    creator: pkey(),
    startTs: i64(),
    endTs: i64(),
    deadlineTs: i64(),
    depositAmount: u64(),
    feeLamports: u64(),
    commonAmount: u64(),
    reserved: u64(),
    paid: u64(),
    id: u32(),
    daySeconds: u32(),
    kind: u8(),
    days: u8(),
    capacity: u8(),
    participants: u8(),
    picks: u8(),
    nextSettle: u8(),
    legendaryAwarded: u8(),
    rareAwarded: u8(),
    returned: u8(),
  };
  o += 2 + 5; // bump, vault_bump, _pad
  c.slots = [];
  for (let i = 0; i < 30; i++) {
    const s: any = { user: pkey(), targetRound: u64(), amount: u64() };
    s.square = u8();
    s.pickSeq = u8();
    s.tier = u8();
    s.flags = u8();
    o += 4;
    if (i < c.participants) c.slots.push(s);
  }
  return c as Cohort;
}

// Anchor account discriminator: sha256("account:<Name>")[..8].
const accountDisc = (name: string) => crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
export const COHORT_DISCRIMINATOR = accountDisc("Cohort");
export const CONFIG_DISCRIMINATOR = accountDisc("Config");
export const COHORT_ACCOUNT_LEN = 1808;
export const isCohortAccount = (d: Buffer) => d.length === COHORT_ACCOUNT_LEN && d.subarray(0, 8).equals(COHORT_DISCRIMINATOR);

export interface ConfigState {
  admin: PublicKey;
  cohortCreator: PublicKey;
  attester: PublicKey;
  crank: PublicKey;
  feeWallet: PublicKey;
  feeLamports: bigint;
  depositAmountMax: bigint;
  maxRewardPerBox: bigint;
  reservedTotal: bigint;
  minDaySeconds: number;
  maxCapacity: number;
  maxLiveCohorts: [number, number];
  liveCohorts: [number, number];
  depositsPaused: boolean;
}
/** Config (Borsh): five keys, four u64, min_day_seconds u32, then single bytes. */
export function decodeConfig(d: Buffer): ConfigState {
  const key = (i: number) => new PublicKey(d.subarray(8 + 32 * i, 8 + 32 * (i + 1)));
  let off = 8 + 32 * 5;
  const u64 = () => d.readBigUInt64LE((off += 8) - 8);
  const feeLamports = u64(), depositAmountMax = u64(), maxRewardPerBox = u64(), reservedTotal = u64();
  const minDaySeconds = d.readUInt32LE(off);
  off += 4;
  return {
    admin: key(0), cohortCreator: key(1), attester: key(2), crank: key(3), feeWallet: key(4),
    feeLamports, depositAmountMax, maxRewardPerBox, reservedTotal, minDaySeconds,
    maxCapacity: d[off], maxLiveCohorts: [d[off + 1], d[off + 2]], liveCohorts: [d[off + 3], d[off + 4]],
    depositsPaused: d[off + 5] === 1,
  };
}

/** Amount of a classic SPL token account (165 bytes), or null when the account is missing or not one. */
export const tokenAmount = (info: { data: Buffer } | null | undefined): bigint | null =>
  info && info.data.length === 165 ? info.data.readBigUInt64LE(64) : null;

// ---- program rules mirrored for off-chain callers (programs/locked_in/src/constants.rs, state.rs) ---

export const FLAG = { OCCUPIED: 1, SUCCESS: 2, RETURNED: 4, PICKED: 8, SETTLED: 16, CLAIMED: 32 } as const;
export const TIER = { NONE: 0, COMMON: 1, RARE: 2, LEGENDARY: 3 } as const;
export const KIND_3_DAY = 0;
export const KIND_7_DAY = 1;
export const DAYS_FOR_KIND: readonly number[] = [3, 7];
export const SECONDS_PER_DAY = 86_400;
/** Real (86,400 s) cohorts start at 00:00 KST = 15:00 UTC. */
export const REAL_COHORT_START_OFFSET = 15 * 3_600;
export const MAX_END_AHEAD = 30 * 86_400;
export const CLAIM_WINDOW_DAYS = 5;
export const MAX_SLOTS = 30;
/** Reward amounts are whole multiples of 0.00001 ORE. */
export const ORE_REWARD_GRANULARITY = 1_000_000n;
export const LEGENDARY_CAP = 1;
export const RARE_CAP = 3;
export const LEGENDARY_MULTIPLIER = 20n;
export const RARE_MULTIPLIER = 2n;

export const hasFlag = (s: Slot, f: number) => (s.flags & f) !== 0;
export const lastDayStart = (c: Cohort) => c.startTs + BigInt(c.days - 1) * BigInt(c.daySeconds);
export const joiningCloses = (c: Cohort) => c.startTs + BigInt(c.daySeconds);

/** Worst case a cohort can pay (state.rs worst_case_reward): every seat succeeds and the caps fill. */
export function worstCaseReward(common: bigint, capacity: number): bigint {
  const legendary = Math.min(LEGENDARY_CAP, capacity);
  const rare = Math.min(RARE_CAP, capacity - legendary);
  const rest = capacity - legendary - rare;
  return common * (LEGENDARY_MULTIPLIER * BigInt(legendary) + RARE_MULTIPLIER * BigInt(rare) + BigInt(rest));
}

/** The pick `settle` will take next: picked, unsettled, and first in recording order. */
export const nextPendingPick = (c: Cohort): Slot | undefined =>
  c.slots.find((s) => hasFlag(s, FLAG.PICKED) && !hasFlag(s, FLAG.SETTLED) && s.pickSeq === c.nextSettle);

/** LockedInError variants in declaration order; Anchor numbers them from 6000. */
export const ERROR_NAMES = [
  "Unauthorized", "InvalidLimit", "InvalidKind", "InvalidDayLength", "MisalignedStart", "StartInPast",
  "EndTooFar", "InvalidDepositAmount", "InvalidRewardAmount", "RewardAboveMax", "TooManyLiveCohorts",
  "InsufficientRewardVault", "DepositsPaused", "JoiningClosed", "CohortFull", "AlreadyJoined", "NotParticipant",
  "CohortNotEnded", "AlreadyReturned", "SuccessWindowClosed", "NotSuccessful", "AlreadyPicked", "InvalidSquare",
  "DeadlinePassed", "NotPicked", "AlreadySettled", "OutOfOrder", "InvalidBoard", "InvalidRound",
  "RoundNotRevealed", "RetargetNotAllowed", "RoundNeedsRetarget", "NotSettled", "AlreadyClaimed",
  "DeadlineNotPassed", "DepositsOutstanding", "Overflow",
] as const;
export type ProgramErrorName = (typeof ERROR_NAMES)[number];
export const errorName = (code: number): ProgramErrorName | undefined => ERROR_NAMES[code - 6000];

// ---- ORE accounts (programs/locked_in/src/ore.rs; ore-api 3.8.x layouts) ------------------------

export const ORE_BOARD_DISCRIMINATOR = 105;
export const ORE_BOARD_LEN = 40;
export const ORE_ROUND_DISCRIMINATOR = 109;
export const ORE_ROUND_LEN = 952;
export const ORE_ROUND_ID_OFFSET = 8;
export const ORE_ROUND_SLOT_HASH_OFFSET = 616;

interface RawAccount {
  owner: PublicKey;
  data: Buffer;
}
// steel discriminator: first byte is the account type, the next 7 are zero.
const hasSteelDisc = (d: Buffer, disc: number) => d.length >= 8 && d[0] === disc && d.subarray(1, 8).every((b) => b === 0);

/** Current round id from ORE's Board, validated the way the program does (owner, size, discriminator). */
export function decodeBoardRoundId(info: RawAccount | null | undefined): bigint {
  if (!info) throw new Error("ORE board not found");
  if (!info.owner.equals(ORE_PROGRAM_ID) || info.data.length !== ORE_BOARD_LEN || !hasSteelDisc(info.data, ORE_BOARD_DISCRIMINATOR)) {
    throw new Error("account is not the ORE board");
  }
  return info.data.readBigUInt64LE(8);
}

export async function boardRoundId(conn: Connection): Promise<bigint> {
  return decodeBoardRoundId(await conn.getAccountInfo(ORE_BOARD));
}

/** `missing`: closed, not created yet, or not owned by ORE. `present`: rng is null until entropy is written. */
export type RoundState = { kind: "missing" } | { kind: "present"; rng: bigint | null };

/** Reads the account fetched from roundPda(roundId), as `ore::read_round` does. Throws where the program would. */
export function readRound(info: RawAccount | null | undefined, roundId: bigint): RoundState {
  if (!info || !info.owner.equals(ORE_PROGRAM_ID) || info.data.length === 0) return { kind: "missing" };
  const d = info.data;
  if (d.length !== ORE_ROUND_LEN || !hasSteelDisc(d, ORE_ROUND_DISCRIMINATOR) || d.readBigUInt64LE(ORE_ROUND_ID_OFFSET) !== roundId) {
    throw new Error(`account is not ORE round ${roundId}`);
  }
  return { kind: "present", rng: oreRng(d.subarray(ORE_ROUND_SLOT_HASH_OFFSET, ORE_ROUND_SLOT_HASH_OFFSET + 32)) };
}

/** `Round::rng()`: XOR of the four little-endian u64 words; null if all 0x00 or all 0xFF. */
export function oreRng(slotHash: Buffer): bigint | null {
  if (slotHash.every((b) => b === 0) || slotHash.every((b) => b === 0xff)) return null;
  let r = 0n;
  for (let i = 0; i < 4; i++) r ^= slotHash.readBigUInt64LE(i * 8);
  return r;
}

function reverseBits64(x: bigint): bigint {
  let r = 0n;
  for (let i = 0; i < 64; i++) {
    r = (r << 1n) | (x & 1n);
    x >>= 1n;
  }
  return r;
}
export const winningSquare = (rng: bigint) => Number(rng % 25n);
export const hitMotherlode = (rng: bigint) => reverseBits64(rng) % 500n === 0n;

/**
 * What `settle` / `retarget` would do for a pick targeting `target` (reward.rs handle_settle):
 * a revealed round settles; a closed round settles as Common once ORE's board has moved past it;
 * a finished round without entropy needs `retarget`; anything else waits.
 */
export type SettleAction = "settle" | "retarget" | "wait";
export function settleAction(boardRound: bigint, target: bigint, round: RoundState): SettleAction {
  const finished = boardRound > target;
  if (round.kind === "present" && round.rng !== null) return "settle";
  if (round.kind === "missing") return finished ? "settle" : "wait";
  return finished ? "retarget" : "wait";
}

// ---- sending --------------------------------------------------------------------------------------

export async function send(
  conn: Connection,
  label: string,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  dryRun: boolean,
): Promise<string | null> {
  console.log(`\n== ${label}`);
  for (const i of ixs) {
    console.log(`  program ${i.programId.toBase58()}`);
    for (const k of i.keys) {
      console.log(`    ${k.isWritable ? "w" : "r"}${k.isSigner ? "s" : " "} ${k.pubkey.toBase58()}`);
    }
  }
  console.log(`  fee payer ${signers[0].publicKey.toBase58()}`);
  if (dryRun) {
    console.log("  (dry run: not sent)");
    return null;
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)} sig ${sig}`);
  console.log(`  confirmed: ${sig}`);
  const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
  for (const l of t?.meta?.logMessages ?? []) if (l.includes("Locked In")) console.log(`  log: ${l.replace("Program log: ", "")}`);
  return sig;
}
