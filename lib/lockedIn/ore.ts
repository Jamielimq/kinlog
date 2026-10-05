// ORE accounts the app reads around a pick: the Board (which round is running and when it ends),
// ORE's Config (round and intermission lengths) and a Round (its result). Layouts and result math as
// in onchain/scripts/lib.ts and programs/locked_in/src/ore.rs (ore-api 3.8.x).
import { type Connection, PublicKey } from '@solana/web3.js';
import { cohortPda, ORE_BOARD } from './program';

export const ORE_PROGRAM_ID = new PublicKey('oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv');
const ORE_CONFIG = new PublicKey('9c9X7aDRAF41faiDs94ELjT19UrGnn72wBW9hPsS4Awy');

const BOARD_DISCRIMINATOR = 105;
const BOARD_LEN = 40;
const ROUND_DISCRIMINATOR = 109;
const ROUND_LEN = 952;
const ROUND_ID_OFFSET = 8;
const ROUND_SLOT_HASH_OFFSET = 616;
const CONFIG_INTERMISSION_OFFSET = 152;
const CONFIG_ROUND_SLOTS_OFFSET = 160;

// Reads go to the account's own Buffer by offset: on the phone, a subarray of a Buffer is a plain
// Uint8Array without Buffer's read methods.

// steel discriminator: first byte is the account type, the next 7 are zero.
function hasSteelDisc(d: Buffer, disc: number): boolean {
  if (d.length < 8 || d[0] !== disc) return false;
  for (let i = 1; i < 8; i++) if (d[i] !== 0) return false;
  return true;
}

export function roundPda(id: bigint): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from('round'), le], ORE_PROGRAM_ID)[0];
}

/** `Round::rng()` of the 32-byte slot hash at `at`: XOR of its four little-endian u64 words; null if all 0x00 or all 0xFF. */
function oreRng(d: Buffer, at: number): bigint | null {
  let zeros = true;
  let ones = true;
  for (let i = at; i < at + 32; i++) {
    if (d[i] !== 0) zeros = false;
    if (d[i] !== 0xff) ones = false;
  }
  if (zeros || ones) return null;
  let r = 0n;
  for (let i = 0; i < 4; i++) r ^= d.readBigUInt64LE(at + i * 8);
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

export interface RoundResult {
  winningSquare: number; // 0-24
  motherlode: boolean;
}

/**
 * A round's result, worked out from its entropy the way the program does. Null while the round has
 * none, and once ORE has closed the account (about a day after the round).
 */
export async function readRoundResult(connection: Connection, roundId: bigint): Promise<RoundResult | null> {
  const info = await connection.getAccountInfo(roundPda(roundId));
  if (!info || !info.owner.equals(ORE_PROGRAM_ID)) return null;
  const d = info.data;
  if (d.length !== ROUND_LEN || !hasSteelDisc(d, ROUND_DISCRIMINATOR) || d.readBigUInt64LE(ROUND_ID_OFFSET) !== roundId) return null;
  const rng = oreRng(d, ROUND_SLOT_HASH_OFFSET);
  if (rng === null) return null;
  return { winningSquare: Number(rng % 25n), motherlode: reverseBits64(rng) % 500n === 0n };
}

/** The network's recent slot time in ms, from the RPC's performance samples (400 if it has none). */
export async function readSlotMs(connection: Connection): Promise<number> {
  const samples = await connection.getRecentPerformanceSamples(4);
  const slots = samples.reduce((n, s) => n + s.numSlots, 0);
  const secs = samples.reduce((n, s) => n + s.samplePeriodSecs, 0);
  return slots > 0 ? (secs * 1000) / slots : 400;
}

/**
 * When a round's result should exist, in ms since the epoch: ORE writes it as the next round starts,
 * one intermission after the round ends. Estimated from the board and the current slot; 0 once the
 * board has moved past the round, null when the board gives no usable figure.
 */
export async function readResultAt(connection: Connection, roundId: bigint, slotMs: number): Promise<number | null> {
  const [[board, config], slot] = await Promise.all([
    connection.getMultipleAccountsInfo([ORE_BOARD, ORE_CONFIG]),
    connection.getSlot('confirmed'),
  ]);
  if (!board || !board.owner.equals(ORE_PROGRAM_ID) || board.data.length !== BOARD_LEN || !hasSteelDisc(board.data, BOARD_DISCRIMINATOR)) {
    throw new Error('ORE board unreadable');
  }
  if (!config || !config.owner.equals(ORE_PROGRAM_ID) || config.data.length < CONFIG_ROUND_SLOTS_OFFSET + 8) {
    throw new Error('ORE config unreadable');
  }
  const current = board.data.readBigUInt64LE(8);
  if (current > roundId) return 0;
  const end = board.data.readBigUInt64LE(24);
  const now = BigInt(slot);
  // An end far from now means the board isn't showing a running round.
  if (end + 1_000n < now || end > now + 100_000n) return null;
  // Measured on mainnet: the next round starts one slot after the intermission.
  const gap = config.data.readBigUInt64LE(CONFIG_INTERMISSION_OFFSET) + 1n;
  const roundSlots = config.data.readBigUInt64LE(CONFIG_ROUND_SLOTS_OFFSET);
  const resultSlot = end + (roundId - current) * (gap + roundSlots) + gap;
  return Date.now() + Number(resultSlot - now) * slotMs;
}

// Transaction reads are spaced out: RPC providers rate-limit them more tightly than account reads.
const TX_READ_GAP_MS = 300;

// "Locked In settle: round N reason R winning_square W picked P motherlode M tier T amount A"
// (reward.rs handle_settle). W is 255 when the round was closed and had no result to read.
const SETTLE_LINE = /Locked In settle: round \d+ reason \w+ winning_square (\d+) picked \d+ motherlode (true|false)/;

/**
 * Kinlog's settlement transaction for a pick, found among the cohort account's latest transactions
 * by the line the program logs, with the round result that line records (null for a closed round).
 * Settlement follows the pick within minutes, so it is normally one of the first few. Null if not
 * found.
 */
export async function findSettleTx(
  connection: Connection,
  kind: number,
  id: number,
  roundId: bigint,
  square: number,
): Promise<{ sig: string; result: RoundResult | null } | null> {
  const sigs = await connection.getSignaturesForAddress(cohortPda(kind, id), { limit: 10 });
  const round = `Locked In settle: round ${roundId} `;
  const picked = ` picked ${square} `;
  for (const s of sigs) {
    if (s.err) continue;
    await new Promise(resolve => setTimeout(resolve, TX_READ_GAP_MS));
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    const line = tx?.meta?.logMessages?.find(l => l.includes(round) && l.includes(picked));
    if (!line) continue;
    const m = SETTLE_LINE.exec(line);
    const winning = m ? Number(m[1]) : NaN;
    return { sig: s.signature, result: m && winning < 25 ? { winningSquare: winning, motherlode: m[2] === 'true' } : null };
  }
  return null;
}
