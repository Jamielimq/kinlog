// Locked In program client: addresses, instruction builders and account decoders, ported from
// onchain/scripts/lib.ts. That file can't be bundled by Metro (it needs Node built-ins and
// @solana/spl-token), so the Anchor discriminators here are the fixed bytes from the program's IDL.
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby');
export const SKR_MINT = new PublicKey('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3');
export const ORE_MINT = new PublicKey('oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp');
export const ORE_BOARD = new PublicKey('BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SKR_DECIMALS = 6;
export const ORE_DECIMALS = 11;

// ---- PDAs -----------------------------------------------------------------------------------------

const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const pda = (seeds: Buffer[], program = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const configPda = () => pda([Buffer.from('config')]);
export const rewardVaultPda = () => pda([Buffer.from('reward_vault')]);
export const cohortPda = (kind: number, id: number) => pda([Buffer.from('cohort'), Buffer.from([kind]), u32le(id)]);
export const skrVaultPda = (cohort: PublicKey) => pda([Buffer.from('skr_vault'), cohort.toBuffer()]);
export const associatedTokenAddress = (owner: PublicKey, mint: PublicKey) =>
  pda([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);

// ---- instructions (data = sha256("global:<name>")[..8] ++ borsh args) ------------------------------

const DISCRIMINATOR = {
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  pick_square: [114, 128, 92, 57, 222, 67, 183, 122],
  claim_reward: [149, 95, 181, 242, 94, 90, 158, 162],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
} as const;

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

/** Joins a cohort: the program takes the cohort's deposit in SKR and its Fee in SOL. */
export const ixDeposit = (user: PublicKey, kind: number, id: number, feeWallet: PublicKey) => {
  const cohort = cohortPda(kind, id);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      w(user, true),
      r(configPda()),
      w(cohort),
      w(skrVaultPda(cohort)),
      w(associatedTokenAddress(user, SKR_MINT)),
      r(SKR_MINT),
      w(feeWallet),
      r(TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    data: Buffer.from(DISCRIMINATOR.deposit),
  });
};

/**
 * Records the participant's Square (0-24). The program reads ORE's board itself and targets the
 * round after the one on it, so the result can't be known when the pick lands.
 */
export const ixPickSquare = (user: PublicKey, kind: number, id: number, square: number) =>
  new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [r(user, true), w(cohortPda(kind, id)), r(ORE_BOARD)],
    data: Buffer.from([...DISCRIMINATOR.pick_square, square]),
  });

/** Pays a settled pick's reward from the reward vault; the program creates the user's ORE token account if needed. */
export const ixClaimReward = (user: PublicKey, kind: number, id: number) =>
  new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      w(user, true),
      w(configPda()),
      w(cohortPda(kind, id)),
      w(rewardVaultPda()),
      w(associatedTokenAddress(user, ORE_MINT)),
      r(ORE_MINT),
      r(TOKEN_PROGRAM_ID),
      r(ASSOCIATED_TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    data: Buffer.from(DISCRIMINATOR.claim_reward),
  });

/** Takes the deposit back once the cohort has ended, into the depositor's own SKR token account. */
export const ixWithdraw = (user: PublicKey, kind: number, id: number) => {
  const cohort = cohortPda(kind, id);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      r(user, true),
      w(cohort),
      w(skrVaultPda(cohort)),
      w(associatedTokenAddress(user, SKR_MINT)),
      r(SKR_MINT),
      r(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(DISCRIMINATOR.withdraw),
  });
};

/**
 * The owner's associated token account for a mint: created if missing, nothing if it exists (the
 * associated token program's CreateIdempotent, not an Anchor instruction). Sent before a withdrawal,
 * which needs the SKR account and fails if the wallet has closed it.
 */
export const ixCreateAtaIdempotent = (payer: PublicKey, owner: PublicKey, mint: PublicKey) =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      w(payer, true),
      w(associatedTokenAddress(owner, mint)),
      r(owner),
      r(mint),
      r(SystemProgram.programId),
      r(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from([1]),
  });

// ---- accounts -------------------------------------------------------------------------------------

const COHORT_DISCRIMINATOR = [137, 17, 213, 61, 105, 64, 144, 169];
const COHORT_ACCOUNT_LEN = 1808;
const CONFIG_DISCRIMINATOR = [155, 12, 170, 224, 30, 250, 204, 130];
const CONFIG_ACCOUNT_LEN = 212;
const MAX_SLOTS = 30;

const hasDiscriminator = (d: Buffer, disc: readonly number[]) => disc.every((b, i) => d[i] === b);

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
  startTs: number;
  endTs: number;
  deadlineTs: number;
  depositAmount: bigint;
  feeLamports: bigint;
  commonAmount: bigint;
  id: number;
  daySeconds: number;
  kind: number;
  days: number;
  capacity: number;
  participants: number;
  picks: number;
  nextSettle: number;
  returned: number;
  slots: Slot[];
}

/** Cohort account (zero-copy, 1808 bytes); null when the data is not one. */
export function decodeCohort(d: Buffer): Cohort | null {
  if (d.length !== COHORT_ACCOUNT_LEN || !hasDiscriminator(d, COHORT_DISCRIMINATOR)) return null;
  const i64 = (o: number) => Number(d.readBigInt64LE(o));
  const slots: Slot[] = [];
  const participants = d[115];
  for (let i = 0; i < Math.min(participants, MAX_SLOTS); i++) {
    const o = 128 + 56 * i;
    slots.push({
      user: new PublicKey(d.subarray(o, o + 32)),
      targetRound: d.readBigUInt64LE(o + 32),
      amount: d.readBigUInt64LE(o + 40),
      square: d[o + 48],
      pickSeq: d[o + 49],
      tier: d[o + 50],
      flags: d[o + 51],
    });
  }
  return {
    startTs: i64(40),
    endTs: i64(48),
    deadlineTs: i64(56),
    depositAmount: d.readBigUInt64LE(64),
    feeLamports: d.readBigUInt64LE(72),
    commonAmount: d.readBigUInt64LE(80),
    id: d.readUInt32LE(104),
    daySeconds: d.readUInt32LE(108),
    kind: d[112],
    days: d[113],
    capacity: d[114],
    participants,
    picks: d[116],
    nextSettle: d[117],
    returned: d[120],
    slots,
  };
}

export interface ConfigState {
  feeWallet: PublicKey;
  feeLamports: bigint;
  depositsPaused: boolean;
}

/** Config (Borsh, 212 bytes): five keys, then the Fee, limits and flags. */
export function decodeConfig(d: Buffer): ConfigState | null {
  if (d.length !== CONFIG_ACCOUNT_LEN || !hasDiscriminator(d, CONFIG_DISCRIMINATOR)) return null;
  return {
    feeWallet: new PublicKey(d.subarray(136, 168)),
    feeLamports: d.readBigUInt64LE(168),
    depositsPaused: d[209] === 1,
  };
}

// ---- program rules mirrored for the app (programs/locked_in/src/state.rs) --------------------------

export const FLAG = { OCCUPIED: 1, SUCCESS: 2, RETURNED: 4, PICKED: 8, SETTLED: 16, CLAIMED: 32 } as const;
export const TIER = { NONE: 0, COMMON: 1, RARE: 2, LEGENDARY: 3 } as const;
export const BOARD_SQUARES = 25;
export const hasFlag = (s: Slot, f: number) => (s.flags & f) !== 0;
/** Deposits are accepted before the start and during day one only. */
export const joiningClosesTs = (c: { startTs: number; daySeconds: number }) => c.startTs + c.daySeconds;

/** LockedInError variants in declaration order; Anchor numbers them from 6000. */
const ERROR_NAMES = [
  'Unauthorized', 'InvalidLimit', 'InvalidKind', 'InvalidDayLength', 'MisalignedStart', 'StartInPast',
  'EndTooFar', 'InvalidDepositAmount', 'InvalidRewardAmount', 'RewardAboveMax', 'TooManyLiveCohorts',
  'InsufficientRewardVault', 'DepositsPaused', 'JoiningClosed', 'CohortFull', 'AlreadyJoined', 'NotParticipant',
  'CohortNotEnded', 'AlreadyReturned', 'SuccessWindowClosed', 'NotSuccessful', 'AlreadyPicked', 'InvalidSquare',
  'DeadlinePassed', 'NotPicked', 'AlreadySettled', 'OutOfOrder', 'InvalidBoard', 'InvalidRound',
  'RoundNotRevealed', 'RetargetNotAllowed', 'RoundNeedsRetarget', 'NotSettled', 'AlreadyClaimed',
  'DeadlineNotPassed', 'DepositsOutstanding', 'Overflow',
] as const;
export type ProgramErrorName = (typeof ERROR_NAMES)[number];
export const errorName = (code: number): ProgramErrorName | undefined => ERROR_NAMES[code - 6000];

/**
 * Raw token amount to a display string, trimming trailing zeros (100000000, 6 -> "100"). With
 * maxFraction the fraction is cut (not rounded) to that many digits, so a balance never reads high.
 */
export function formatAmount(raw: bigint, decimals: number, maxFraction = decimals): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
