// End-to-end rehearsal: Firebase emulators (auth, firestore, functions, project demo-kinlog) plus a
// local validator running the deployed program build. Run by `firebase emulators:exec` after
// local-chain.ts prepare + init. Uses only throwaway keys; prints no key material.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { initializeApp as adminApp } from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken } from "firebase/auth";
import { addDoc, collection, connectFirestoreEmulator, getDoc, doc, getFirestore, terminate } from "firebase/firestore";
import { buildSignInMessage } from "../src/auth/siws.ts";
import * as P from "../src/chain/program.ts";
import { sendTx } from "../src/chain/send.ts";
import { signBytes } from "../test/support/sign.ts";
import { COMMON, DAY_SECONDS, DEPOSIT, loadKey, loadState, RPC, TEST_COHORT } from "./local-common.ts";

const PROJECT = "demo-kinlog";
const FN = `http://127.0.0.1:5001/${PROJECT}/asia-northeast3`;
const dir = process.argv[2];
if (!dir) throw new Error("usage: e2e-local.ts <dir>");
const state = loadState(dir);
const conn = new Connection(RPC, "confirmed");
adminApp({ projectId: PROJECT });
const db = adminFirestore();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let start = 0;
const k = TEST_COHORT;
const until = async (unixSec: number) => {
  const ms = unixSec * 1000 - Date.now();
  if (ms > 0) await sleep(ms);
};
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
async function poll<T>(f: () => Promise<T | undefined>, ms = 30_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v !== undefined) return v;
    await sleep(500);
  }
  return undefined;
}
async function devRun(job: "everyMinute" | "daily") {
  const res = await fetch(`${FN}/devRun?job=${job}`);
  return res.json();
}
const cohort = async () => {
  const a = await conn.getAccountInfo(P.cohortPda(k.kind, k.id));
  return a ? P.decodeCohort(a.data) : null;
};
const slotOf = async (kp: Keypair) => (await cohort())?.slots.find((s) => s.user.equals(kp.publicKey));

async function signIn(kp: Keypair) {
  const payload = await (await fetch(`${FN}/authNonce`)).json();
  const text = buildSignInMessage({ ...payload, address: kp.publicKey.toBase58() });
  const message = Buffer.from(text, "utf8");
  const res = await fetch(`${FN}/authVerify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: kp.publicKey.toBase58(), message: message.toString("base64"), signature: signBytes(kp, message).toString("base64") }),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`authVerify ${res.status} ${JSON.stringify(body)}`);
  const app = initializeApp({ projectId: PROJECT, apiKey: "demo-api-key" }, kp.publicKey.toBase58());
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  await signInWithCustomToken(auth, body.token);
  const fs = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
  connectFirestoreEmulator(fs, host, Number(port));
  return fs;
}

function cli(dirOfCli: string, args: string[]): string {
  const r = spawnSync("npx", ["tsx", "li.ts", ...args], { cwd: dirOfCli, encoding: "utf8" });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

async function main() {
  const user1 = loadKey(dir, "user1");
  const user2 = loadKey(dir, "user2");
  const legacy = Keypair.generate().publicKey.toBase58();

  // 0. A fresh test cohort (as the CLI would create it) and both deposits, timed to this run.
  const creator = loadKey(dir, "cohortCreator");
  start = Math.floor(Date.now() / 1000) + 6;
  await sendTx(conn, [P.ixCreateCohort(creator.publicKey, k.kind, k.id, BigInt(start), DAY_SECONDS, DEPOSIT, COMMON)], creator, "create test cohort");
  const feeWallet = P.decodeConfig((await conn.getAccountInfo(P.configPda()))!.data).feeWallet;
  for (const u of [user1, user2]) await sendTx(conn, [P.ixDeposit(u.publicKey, k.kind, k.id, feeWallet)], u, "deposit");

  // 1. Mirror the test cohort, then sign both users in over HTTP.
  await db.doc("config/ops").set({ paused: false });
  await until(start + 1);
  await devRun("everyMinute");
  const mirror = (await db.doc("cohorts/0-3").get()).data();
  check("cohort mirrored", mirror?.isTest === true && mirror?.participants === 2, `status ${mirror?.status}`);
  const fs1 = await signIn(user1);
  const fs2 = await signIn(user2);
  check("sign-in links both wallets", (await db.doc(`authLinks/${user1.publicKey.toBase58()}`).get()).exists && (await db.doc(`authLinks/${user2.publicKey.toBase58()}`).get()).exists);

  // 2. Three days: user1 does 30 reps each day through the rules; user2 only on day one; a signed-out
  //    v1.3.3 wallet saves a workout too and must be ignored.
  const w1 = user1.publicKey.toBase58();
  const w2 = user2.publicKey.toBase58();
  const workout = (fsx: ReturnType<typeof getFirestore>, w: string, reps: number) =>
    addDoc(collection(fsx, `users/${w}/workouts`), { uid: w, rawReps: reps, reps, elapsed: reps * 2, createdAt: Date.now() });
  for (let d = 0; d < 3; d++) {
    await until(start + d * DAY_SECONDS + 1);
    await workout(fs1, w1, 30);
    if (d === 0) {
      await workout(fs2, w2, 30);
      await db.collection(`users/${legacy}/workouts`).add({ exercise: "squat", reps: 30, elapsed: 60, createdAt: Date.now() });
    }
  }
  const success = await poll(async () => ((await slotOf(user1)) && P.hasFlag((await slotOf(user1))!, P.FLAG.SUCCESS) ? true : undefined));
  check("mark_success sent by the trigger on the last day", success === true);
  // The server records success right after the transaction confirms.
  const li1 = await poll(async () => {
    const d = (await db.doc(`users/${w1}/lockedIn/0-3`).get()).data();
    return d?.success === true ? d : undefined;
  }, 10_000);
  check("progress recorded", JSON.stringify(li1?.dayReps) === "[30,30,30]" && li1?.success === true && typeof li1?.successTx === "string", JSON.stringify(li1?.dayReps));
  const pts = await poll(async () => ((await db.doc(`users/${w1}/points_history/li-0-3`).get()).exists ? true : undefined), 10_000);
  check("completion points awarded once", pts === true && (await db.doc(`users/${w1}`).get()).data()?.points === 300);
  const s2 = await slotOf(user2);
  check("user2 (missed days) not marked", !!s2 && !P.hasFlag(s2, P.FLAG.SUCCESS));
  check("v1.3.3 workout ignored", !(await db.collection(`users/${legacy}/lockedIn`).get()).size);
  const ownRead = await getDoc(doc(fs1, `users/${w1}/lockedIn/0-3`));
  check("owner reads own progress through the rules", ownRead.exists());

  // 3. Pick the round's winning square, then the crank settles it as Rare and records the grant.
  await sendTx(conn, [P.ixPickSquare(user1.publicKey, k.kind, k.id, state.winningSquare)], user1, "pick");
  const picked = await slotOf(user1);
  check("pick targets the preloaded round", picked?.targetRound.toString() === state.targetRound);
  await devRun("everyMinute");
  const settled = await slotOf(user1);
  check("settled by the crank", !!settled && P.hasFlag(settled, P.FLAG.SETTLED) && settled.tier === P.TIER.RARE, `tier ${settled?.tier}`);
  const grant = (await db.doc(`users/${w1}/badges/square_3d_rare/grants/0-3`).get()).data();
  check("Rare grant written", grant?.amount === (COMMON * 2n).toString());

  // 4. The CLI's read-only commands print the same as before the code moved into lib.ts.
  const scripts = path.resolve("../onchain/scripts");
  const old = path.resolve(dir, "../old-scripts");
  for (const args of [["show", "--cluster", "local", "--kind", "0", "--id", "3"], ["config", "--cluster", "local"]]) {
    const a = cli(old, args);
    const b = cli(scripts, args);
    check(`li.ts ${args[0]} output unchanged`, a === b && a.includes("NETWORK: LOCAL"), a === b ? "" : `\n--- old\n${a}\n--- new\n${b}`);
  }

  // 5. Claim, withdraw after the end, and let the crank return the rest and close after the deadline.
  await sendTx(conn, [P.ixClaimReward(user1.publicKey, k.kind, k.id)], user1, "claim");
  const ore = P.tokenAmount(await conn.getAccountInfo(getAssociatedTokenAddressSync(P.ORE_MINT, user1.publicKey)));
  check("claim paid the Rare amount", ore === COMMON * 2n, `${ore}`);
  const c = (await cohort())!;
  await until(Number(c.endTs) + 1);
  await sendTx(conn, [P.ixWithdraw(user1.publicKey, k.kind, k.id)], user1, "withdraw");
  await until(Number(c.deadlineTs) + 4); // the chain clock trails wall time by 1-2 s
  const creatorBefore = await conn.getBalance(new PublicKey(state.keys.cohortCreator));
  const sum = await devRun("everyMinute");
  check("crank returned user2's deposit and closed the cohort", sum.returned === 1 && sum.closed === 1 && (await cohort()) === null, JSON.stringify(sum));
  const skr2 = P.tokenAmount(await conn.getAccountInfo(getAssociatedTokenAddressSync(P.SKR_MINT, user2.publicKey)));
  check("user2 got the deposit back", skr2 === 10_000_000n, `${skr2}`);
  check("rent returned to the cohort creator", (await conn.getBalance(new PublicKey(state.keys.cohortCreator))) > creatorBefore);
  const cfg = P.decodeConfig((await conn.getAccountInfo(P.configPda()))!.data);
  check("reservation released", cfg.reservedTotal === 0n && cfg.liveCohorts[0] === 0, `${cfg.reservedTotal}`);
  await devRun("everyMinute");
  check("mirror marked closed", (await db.doc("cohorts/0-3").get()).data()?.status === "closed");

  // 6. Automatic creation of the next scheduled 3-Day cohort through the real program. The price keys
  //    are dummies here, so the configured fallback amount is used (and an alert is logged).
  await db.doc("config/ops").set({ paused: false, create3Day: "on", fallbackCommon: COMMON.toString() });
  const daily = await devRun("daily");
  const plan = daily.plans?.[0];
  const created = plan ? (await conn.getAccountInfo(P.cohortPda(0, plan.id))) : null;
  const cc = created ? P.decodeCohort(created.data) : null;
  check("daily created the next scheduled cohort on chain", !!cc && cc.daySeconds === 86_400 && Number(cc.startTs) % 86_400 === 54_000 && cc.commonAmount === COMMON, plan ? `id ${plan.id}` : "no plan");
  const again = await devRun("daily");
  check("no second creation while one is scheduled", (again.plans ?? []).length === 0);

  await terminate(fs1);
  await terminate(fs2);
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e: Error) => {
  console.error(`ERROR: ${e.stack ?? e.message}`);
  process.exit(1);
});
