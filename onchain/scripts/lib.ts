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
const GENESIS: Record<Exclude<Cluster, "local">, string> = {
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

export async function boardRoundId(conn: Connection): Promise<bigint> {
  const a = await conn.getAccountInfo(ORE_BOARD);
  if (!a) throw new Error("ORE board not found");
  return a.data.readBigUInt64LE(8);
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
