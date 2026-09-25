// Locked In operator CLI.  Usage: npx tsx li.ts <command> --cluster local|devnet|mainnet [options]
//
// Every command prints the network first. Mainnet needs --confirm-mainnet. --dry-run prints the
// instructions (programs, accounts, fee payer) without sending. Keypairs are always explicit paths.
import { parseArgs } from "node:util";
import { LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import {

  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import * as L from "./lib.ts";

const { positionals, values: o } = parseArgs({
  allowPositionals: true,
  options: {
    cluster: { type: "string" },
    "confirm-mainnet": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    // keypair paths
    payer: { type: "string" },
    deployer: { type: "string" },
    creator: { type: "string" },
    attester: { type: "string" },
    crank: { type: "string" },
    user: { type: "string" },
    member: { type: "string" },
    "create-key": { type: "string" },
    from: { type: "string" },
    // addresses / values
    admin: { type: "string" },
    "fee-wallet": { type: "string" },
    "creator-pubkey": { type: "string" },
    "attester-pubkey": { type: "string" },
    "crank-pubkey": { type: "string" },
    "user-pubkey": { type: "string" },
    depositor: { type: "string" },
    members: { type: "string" },
    threshold: { type: "string", default: "2" },
    multisig: { type: "string" },
    index: { type: "string" },
    action: { type: "string" },
    buffer: { type: "string" },
    spill: { type: "string" },
    memo: { type: "string" },
    tx: { type: "string" },
    kind: { type: "string", default: "0" },
    id: { type: "string" },
    start: { type: "string" },
    "day-seconds": { type: "string", default: "86400" },
    deposit: { type: "string" },
    common: { type: "string" },
    square: { type: "string" },
    amount: { type: "string" },
    "fee-lamports": { type: "string", default: "1000000" },
    "deposit-max": { type: "string", default: "100000000" },
    "max-reward": { type: "string" },
    "min-day-seconds": { type: "string", default: "86400" },
    "max-capacity": { type: "string", default: "30" },
    "max-live": { type: "string", default: "4,3" },
  },
});

const cmd = positionals[0];
const dry = o["dry-run"]!;
const kind = Number(o.kind);
const id = () => Number(o.id ?? fail("--id"));
function fail(m: string): never {
  throw new Error(`missing ${m}`);
}

const limits = (): L.Limits => ({
  feeLamports: BigInt(o["fee-lamports"]!),
  depositAmountMax: BigInt(o["deposit-max"]!),
  maxRewardPerBox: BigInt(o["max-reward"] ?? fail("--max-reward")),
  minDaySeconds: Number(o["min-day-seconds"]),
  maxCapacity: Number(o["max-capacity"]),
  maxLiveCohorts: o["max-live"]!.split(",").map(Number) as [number, number],
});

async function main() {
  const cluster = o.cluster as L.Cluster;
  if (!["local", "devnet", "mainnet"].includes(cluster)) fail("--cluster local|devnet|mainnet");
  const conn = await L.connect(cluster, o["confirm-mainnet"]!);

  switch (cmd) {
    case "init-config": {
      const deployer = L.loadKeypair(o.deployer, "deployer");
      const roles = {
        cohortCreator: L.pk(o["creator-pubkey"], "creator-pubkey"),
        attester: L.pk(o["attester-pubkey"], "attester-pubkey"),
        crank: L.pk(o["crank-pubkey"], "crank-pubkey"),
      };
      const l = limits();
      console.log({ admin: o.admin, feeWallet: o["fee-wallet"], ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, String(v)])) });
      await L.send(conn, "init_config", [L.ixInitConfig(deployer.publicKey, L.pk(o.admin, "admin"), L.pk(o["fee-wallet"], "fee-wallet"), roles, l)], [deployer], dry);
      console.log(`config ${L.configPda().toBase58()}  reward vault ${L.rewardVaultPda().toBase58()}`);
      break;
    }

    case "fund-reward-vault": {
      // Moves ORE from the signer's own ORE account into the program's reward vault token account,
      // with a checked transfer (mint + decimals). Amount in raw units (1 ORE = 1e11).
      const from = L.loadKeypair(o.from, "from");
      const amount = BigInt(o.amount ?? fail("--amount"));
      const src = getAssociatedTokenAddressSync(L.ORE_MINT, from.publicKey);
      const vault = L.rewardVaultPda();
      console.log(`amount ${amount} raw = ${Number(amount) / 1e11} ORE  from ${src.toBase58()} -> vault ${vault.toBase58()}`);
      await L.send(conn, "fund reward vault", [createTransferCheckedInstruction(src, L.ORE_MINT, vault, from.publicKey, amount, L.ORE_DECIMALS)], [from], dry);
      break;
    }

    case "transfer-sol": {
      const from = L.loadKeypair(o.from, "from");
      const to = L.pk(o["user-pubkey"], "user-pubkey");
      const lamports = Math.round(Number(o.amount ?? fail("--amount")) * LAMPORTS_PER_SOL);
      console.log(`${lamports / LAMPORTS_PER_SOL} SOL -> ${to.toBase58()}`);
      const { SystemProgram } = await import("@solana/web3.js");
      await L.send(conn, "transfer SOL", [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })], [from], dry);
      break;
    }

    case "create-cohort": {
      const creator = L.loadKeypair(o.creator, "creator");
      const ix = L.ixCreateCohort(
        creator.publicKey,
        kind,
        id(),
        BigInt(o.start ?? fail("--start")),
        Number(o["day-seconds"]),
        BigInt(o.deposit ?? fail("--deposit")),
        BigInt(o.common ?? fail("--common")),
      );
      await L.send(conn, `create_cohort kind ${kind} id ${id()} start ${o.start}`, [ix], [creator], dry);
      console.log(`cohort ${L.cohortPda(kind, id()).toBase58()}`);
      break;
    }

    case "deposit": {
      const user = L.loadKeypair(o.user, "user");
      const cfg = await conn.getAccountInfo(L.configPda());
      const feeWallet = new PublicKey(cfg!.data.subarray(8 + 32 * 4, 8 + 32 * 5));
      await L.send(conn, "deposit", [L.ixDeposit(user.publicKey, kind, id(), feeWallet)], [user], dry);
      break;
    }
    case "withdraw": {
      const user = L.loadKeypair(o.user, "user");
      await L.send(conn, "withdraw", [L.ixWithdraw(user.publicKey, kind, id())], [user], dry);
      break;
    }
    case "return-deposit": {
      const caller = L.loadKeypair(o.crank ?? o.payer, "crank|payer");
      await L.send(conn, "return_deposit", [L.ixReturnDeposit(caller.publicKey, kind, id(), L.pk(o.depositor, "depositor"))], [caller], dry);
      break;
    }
    case "mark-success": {
      const attester = L.loadKeypair(o.attester, "attester");
      await L.send(conn, "mark_success", [L.ixMarkSuccess(attester.publicKey, kind, id(), L.pk(o["user-pubkey"], "user-pubkey"))], [attester], dry);
      break;
    }
    case "pick": {
      const user = L.loadKeypair(o.user, "user");
      console.log(`ORE board round now ${await L.boardRoundId(conn)}; the program targets the next one`);
      await L.send(conn, "pick_square", [L.ixPickSquare(user.publicKey, kind, id(), Number(o.square))], [user], dry);
      break;
    }
    case "settle": {
      const payer = L.loadKeypair(o.payer ?? o.crank, "payer|crank");
      const c = L.decodeCohort((await conn.getAccountInfo(L.cohortPda(kind, id())))!.data);
      const next = c.slots.find((s) => (s.flags & 8) && !(s.flags & 16) && s.pickSeq === c.nextSettle);
      if (!next) fail("a pending pick");
      console.log(`next pick seq ${c.nextSettle} targets ORE round ${next.targetRound}`);
      await L.send(conn, "settle", [L.ixSettle(kind, id(), next.targetRound)], [payer], dry);
      break;
    }
    case "claim": {
      const user = L.loadKeypair(o.user, "user");
      await L.send(conn, "claim_reward", [L.ixClaimReward(user.publicKey, kind, id())], [user], dry);
      break;
    }
    case "close-cohort": {
      const payer = L.loadKeypair(o.payer, "payer");
      const c = L.decodeCohort((await conn.getAccountInfo(L.cohortPda(kind, id())))!.data);
      await L.send(conn, "close_cohort", [L.ixCloseCohort(kind, id(), c.creator)], [payer], dry);
      break;
    }
    case "show": {
      const a = await conn.getAccountInfo(L.cohortPda(kind, id()));
      if (!a) {
        console.log("cohort not found");
        break;
      }
      const c = L.decodeCohort(a.data);
      const fmt = (x: any) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v), 1);
      console.log(fmt(c));
      break;
    }

    // ---- Squads v4 -------------------------------------------------------------------------------
    case "squads-create": {
      const payer = L.loadKeypair(o.payer, "payer");
      const createKey = L.loadKeypair(o["create-key"], "create-key");
      const members = (o.members ?? fail("--members a,b,c")).split(",").map((m) => new PublicKey(m.trim()));
      const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
      const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
      const [programConfigPda] = multisig.getProgramConfigPda({});
      const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
      console.log(`multisig ${multisigPda.toBase58()}\nvault(0) ${vault.toBase58()}  <- use THIS as admin / upgrade authority`);
      console.log(`members ${members.map((m) => m.toBase58()).join(", ")}  threshold ${o.threshold}`);
      if (dry) break;
      const sig = await multisig.rpc.multisigCreateV2({
        connection: conn,
        treasury: programConfig.treasury,
        createKey,
        creator: payer,
        multisigPda,
        configAuthority: null,
        threshold: Number(o.threshold),
        members: members.map((key) => ({ key, permissions: multisig.types.Permissions.all() })),
        timeLock: 0,
        rentCollector: null,
      });
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`created: ${sig}`);
      break;
    }

    case "squads-propose": {
      // Creates a vault transaction + proposal. The proposer (a member) also pays the fee.
      const member = L.loadKeypair(o.member, "member");
      const multisigPda = L.pk(o.multisig, "multisig");
      const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
      const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
      const index = BigInt(ms.transactionIndex.toString()) + 1n;
      let ixs;
      switch (o.action) {
        case "memo":
          ixs = [L.ixMemo(vault, o.memo ?? "kinlog squads vault check")];
          break;
        case "set-limits":
          ixs = [L.ixSetLimits(vault, limits())];
          break;
        case "set-fee-wallet":
          ixs = [L.ixSetFeeWallet(vault, L.pk(o["fee-wallet"], "fee-wallet"))];
          break;
        case "pause":
          ixs = [L.ixPauseDeposits(vault, true)];
          break;
        case "unpause":
          ixs = [L.ixPauseDeposits(vault, false)];
          break;
        case "upgrade":
          ixs = [L.ixUpgrade(L.pk(o.buffer, "buffer"), L.pk(o.spill, "spill"), vault)];
          break;
        case "import-tx": {
          // A transaction exported for Squads (e.g. `solana-verify export-pda-tx`, base58). Its
          // instructions run from the vault; every signer they name must be the vault itself.
          const raw = Buffer.from(bs58.decode(o.tx ?? fail("--tx <base58>")));
          let decoded: TransactionInstruction[];
          try {
            decoded = TransactionMessage.decompile(VersionedTransaction.deserialize(raw).message).instructions;
          } catch {
            decoded = Transaction.from(raw).instructions;
          }
          for (const i of decoded) {
            for (const k of i.keys) {
              if (k.isSigner && !k.pubkey.equals(vault)) throw new Error(`imported tx needs signer ${k.pubkey.toBase58()}, not the vault`);
            }
          }
          ixs = decoded;
          break;
        }
        default:
          fail("--action memo|set-limits|set-fee-wallet|pause|unpause|upgrade|import-tx");
      }
      console.log(`vault ${vault.toBase58()}  new transaction index ${index}  action ${o.action}`);
      for (const i of ixs) {
        console.log(`  program ${i.programId.toBase58()}`);
        for (const k of i.keys) console.log(`    ${k.isWritable ? "w" : "r"}${k.isSigner ? "s" : " "} ${k.pubkey.toBase58()}`);
      }
      if (dry) break;
      const { blockhash } = await conn.getLatestBlockhash();
      const message = new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: ixs });
      let sig = await multisig.rpc.vaultTransactionCreate({
        connection: conn,
        feePayer: member,
        multisigPda,
        transactionIndex: index,
        creator: member.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: message,
      });
      await conn.confirmTransaction(sig, "confirmed");
      sig = await multisig.rpc.proposalCreate({ connection: conn, feePayer: member, multisigPda, transactionIndex: index, creator: member });
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`proposal ${index} created: ${sig}`);
      break;
    }

    case "squads-approve": {
      const member = L.loadKeypair(o.member, "member");
      const multisigPda = L.pk(o.multisig, "multisig");
      const index = BigInt(o.index ?? fail("--index"));
      if (dry) break;
      const sig = await multisig.rpc.proposalApprove({ connection: conn, feePayer: member, member, multisigPda, transactionIndex: index });
      await conn.confirmTransaction(sig, "confirmed");
      console.log(`approved ${index}: ${sig}`);
      break;
    }

    case "squads-execute": {
      const member = L.loadKeypair(o.member, "member");
      const multisigPda = L.pk(o.multisig, "multisig");
      const index = BigInt(o.index ?? fail("--index"));
      if (dry) break;
      const sig = await multisig.rpc.vaultTransactionExecute({ connection: conn, feePayer: member, multisigPda, transactionIndex: index, member: member.publicKey });
      const res = await conn.confirmTransaction(sig, "confirmed");
      if (res.value.err) throw new Error(`execute failed ${JSON.stringify(res.value.err)}`);
      console.log(`executed ${index}: ${sig}`);
      break;
    }

    case "squads-show": {
      const multisigPda = L.pk(o.multisig, "multisig");
      const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
      const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
      console.log({
        multisig: multisigPda.toBase58(),
        vault0: vault.toBase58(),
        threshold: ms.threshold,
        members: ms.members.map((m) => m.key.toBase58()),
        transactionIndex: ms.transactionIndex.toString(),
      });
      break;
    }

    case "config": {
      const a = await conn.getAccountInfo(L.configPda());
      if (!a) {
        console.log("config not initialised");
        break;
      }
      const d = a.data;
      const key = (i: number) => new PublicKey(d.subarray(8 + 32 * i, 8 + 32 * (i + 1))).toBase58();
      let off = 8 + 32 * 5;
      const u64 = () => d.readBigUInt64LE((off += 8) - 8).toString();
      const fee = u64(), depMax = u64(), maxReward = u64(), reserved = u64();
      const minDay = d.readUInt32LE(off);
      off += 4;
      console.log({
        admin: key(0), cohortCreator: key(1), attester: key(2), crank: key(3), feeWallet: key(4),
        feeLamports: fee, depositAmountMax: depMax, maxRewardPerBox: maxReward, reservedTotal: reserved,
        minDaySeconds: minDay, maxCapacity: d[off], maxLiveCohorts: [d[off + 1], d[off + 2]],
        liveCohorts: [d[off + 3], d[off + 4]], depositsPaused: d[off + 5] === 1,
      });
      break;
    }

    default:
      console.log("commands: init-config fund-reward-vault transfer-sol create-cohort deposit withdraw return-deposit mark-success pick settle claim close-cohort show config squads-create squads-propose squads-approve squads-execute squads-show");
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});


