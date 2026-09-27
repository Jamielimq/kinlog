// Local validator rehearsal for the server (Phase 4 #8). All keys are throwaway and created here, in a
// directory outside the repository; no key material is ever printed.
//
//   prepare <dir>   keys, account dumps (mints we control, ORE board, one revealed round),
//                   functions/.secret.local for the emulator, and the validator arguments
//   init <dir>      on the running validator: airdrops, init_config, reward vault, SKR for the users,
//                   (the e2e script creates the test cohort itself, so its days line up with the run)
import fs from "node:fs";
import path from "node:path";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as P from "../src/chain/program.ts";
import { DAY_SECONDS, keyPath, loadKey, loadState, RPC, type Role, ROLES, saveState, type State } from "./local-common.ts";
import { sendTx } from "../src/chain/send.ts";
import { accountOf, fixture, roundFixtureNames } from "../test/support/fixtures.ts";

function dump(pubkey: PublicKey, owner: PublicKey, data: Buffer) {
  return { pubkey: pubkey.toBase58(), account: { lamports: 10_000_000, data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length } };
}
function mintData(authority: PublicKey, decimals: number): Buffer {
  const d = Buffer.alloc(82);
  d.writeUInt32LE(1, 0);
  authority.toBuffer().copy(d, 4);
  d[44] = decimals;
  d[45] = 1;
  return d;
}

function prepare(dir: string) {
  fs.mkdirSync(path.join(dir, "keys"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "accounts"), { recursive: true });
  const pub = {} as Record<Role, string>;
  for (const role of ROLES) {
    const kp = Keypair.generate();
    fs.writeFileSync(keyPath(dir, role), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    pub[role] = kp.publicKey.toBase58();
  }
  const mintAuthority = new PublicKey(pub.mintAuthority);
  const write = (name: string, v: unknown) => fs.writeFileSync(path.join(dir, "accounts", `${name}.json`), JSON.stringify(v));
  write("skr_mint", dump(P.SKR_MINT, TOKEN_PROGRAM_ID, mintData(mintAuthority, P.SKR_DECIMALS)));
  write("ore_mint", dump(P.ORE_MINT, TOKEN_PROGRAM_ID, mintData(mintAuthority, P.ORE_DECIMALS)));
  const board = accountOf(fixture("board"));
  write("board", dump(P.ORE_BOARD, board.owner, board.data));
  const boardRound = board.data.readBigUInt64LE(8);
  // One revealed mainnet round (no motherlode), re-addressed as the round after the board's.
  const name = roundFixtureNames().find((n) => {
    const f = fixture(n);
    return f.expected_source && !f.expected!.motherlode_hit;
  })!;
  const f = fixture(name);
  const round = Buffer.from(accountOf(f).data);
  const target = boardRound + 1n;
  round.writeBigUInt64LE(target, 8);
  write("round", dump(P.roundPda(target), accountOf(f).owner, round));
  const state: State = { keys: pub, boardRound: boardRound.toString(), targetRound: target.toString(), winningSquare: f.expected!.winning_square };
  saveState(dir, state);

  // Emulator secrets: local keys and the local validator only.
  const secret = (role: Role) => fs.readFileSync(keyPath(dir, role), "utf8");
  const nonceSecret = Buffer.from(Keypair.generate().secretKey.subarray(0, 32)).toString("hex");
  fs.writeFileSync(
    path.resolve(".secret.local"),
    [
      `SERVER_RPC_URL=${RPC}`,
      `COHORT_CREATOR_KEY=${secret("cohortCreator")}`,
      `ATTESTER_KEY=${secret("attester")}`,
      `CRANK_KEY=${secret("crank")}`,
      `AUTH_NONCE_SECRET=${nonceSecret}`,
      "JUPITER_API_KEY=local-unused",
      "COINGECKO_API_KEY=local-unused",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const args = [
    "--reset", "--quiet", "--ledger", path.join(dir, "ledger"), "--rpc-port", "8899", "--faucet-port", "9900",
    "--upgradeable-program", P.PROGRAM_ID.toBase58(), path.resolve("../onchain/target/deploy/locked_in.so"), pub.deployer,
    "--account", P.SKR_MINT.toBase58(), path.join(dir, "accounts/skr_mint.json"),
    "--account", P.ORE_MINT.toBase58(), path.join(dir, "accounts/ore_mint.json"),
    "--account", P.ORE_BOARD.toBase58(), path.join(dir, "accounts/board.json"),
    "--account", P.roundPda(target).toBase58(), path.join(dir, "accounts/round.json"),
  ];
  fs.writeFileSync(path.join(dir, "validator.args"), args.join("\n"));
  console.log(`prepared ${dir}: ${ROLES.length} keys (not shown), board round ${boardRound}, target ${target} (winning square ${state.winningSquare}, from ${name})`);
}

async function init(dir: string) {
  const conn = new Connection(RPC, "confirmed");
  const k = (r: Role) => loadKey(dir, r);
  const state = loadState(dir);
  for (const r of ["deployer", "cohortCreator", "attester", "crank", "funder", "user1", "user2", "mintAuthority", "feeWallet"] as Role[]) {
    const sig = await conn.requestAirdrop(k(r).publicKey, 5 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }
  const deployer = k("deployer");
  await sendTx(conn, [P.ixInitConfig(deployer.publicKey, k("admin").publicKey, k("feeWallet").publicKey,
    { cohortCreator: k("cohortCreator").publicKey, attester: k("attester").publicKey, crank: k("crank").publicKey },
    { feeLamports: 1_000_000n, depositAmountMax: 100_000_000n, maxRewardPerBox: 10_000_000_000n, minDaySeconds: DAY_SECONDS, maxCapacity: 30, maxLiveCohorts: [4, 3] })], deployer, "init_config");

  const mintAuth = k("mintAuthority");
  const funder = k("funder");
  const funderOre = getAssociatedTokenAddressSync(P.ORE_MINT, funder.publicKey);
  await sendTx(conn, [
    createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, funderOre, funder.publicKey, P.ORE_MINT),
  ], funder, "funder ORE account");
  await sendTx(conn, [createMintToInstruction(P.ORE_MINT, funderOre, mintAuth.publicKey, 100_100_000_000n)], mintAuth, "mint ORE");
  await sendTx(conn, [createTransferCheckedInstruction(funderOre, P.ORE_MINT, P.rewardVaultPda(), funder.publicKey, 100_100_000_000n, P.ORE_DECIMALS)], funder, "fund reward vault");
  for (const u of ["user1", "user2"] as Role[]) {
    const user = k(u);
    const ata = getAssociatedTokenAddressSync(P.SKR_MINT, user.publicKey);
    await sendTx(conn, [createAssociatedTokenAccountIdempotentInstruction(user.publicKey, ata, user.publicKey, P.SKR_MINT)], user, `${u} SKR account`);
    await sendTx(conn, [createMintToInstruction(P.SKR_MINT, ata, mintAuth.publicKey, 10_000_000n)], mintAuth, `mint SKR to ${u}`);
  }
  const cfg = P.decodeConfig((await conn.getAccountInfo(P.configPda()))!.data);
  console.log(`init done: vault ${Number(P.tokenAmount(await conn.getAccountInfo(P.rewardVaultPda()))) / 1e11} ORE, reserved ${Number(cfg.reservedTotal) / 1e11} ORE, min day ${cfg.minDaySeconds} s`);
  void state;
}

const [cmd, dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: local-chain.ts prepare|init <dir>");
(cmd === "prepare" ? Promise.resolve(prepare(dir)) : cmd === "init" ? init(dir) : Promise.reject(new Error(`unknown ${cmd}`))).catch((e: Error) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
