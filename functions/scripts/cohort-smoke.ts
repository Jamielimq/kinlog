// Mainnet test cohort 0-2 (2026-09-30): signs in the two test wallets and writes one signed-in workout per
// cohort day at the middle of that day's window (test-user1 every day, test-user2 on day one only),
// then waits for the server to mark test-user1 successful. Uses only the test wallets' key files;
// prints PASS/FAIL lines, never keys, tokens or the web app config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import { addDoc, collection, doc, type Firestore, getDoc, getFirestore, terminate } from "firebase/firestore";
import { buildSignInMessage } from "../src/auth/siws.ts";
import * as P from "../src/chain/program.ts";
import { signBytes } from "../test/support/sign.ts";

const FN = "https://asia-northeast3-kinlog-6549a.cloudfunctions.net";
const KEY = { kind: 0, id: 2 };
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const configText = fs.readFileSync(path.resolve("../docs/private/firebase-web-config.json"), "utf8");
const config = JSON.parse(configText.slice(configText.indexOf("{"), configText.lastIndexOf("}") + 1));
const testKey = (n: 1 | 2) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), `.config/kinlog/test-wallets/test-user${n}.json`), "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push(ok);
  console.log(`${hhmmss(Date.now())} ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const code = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "error");

async function cohort() {
  const a = await conn.getAccountInfo(P.cohortPda(KEY.kind, KEY.id));
  if (!a) throw new Error("cohort 0-2 not found");
  return P.decodeCohort(a.data);
}

async function signIn(kp: Keypair, name: string): Promise<Firestore> {
  const payload = await (await fetch(`${FN}/authNonce`)).json();
  const message = Buffer.from(buildSignInMessage({ ...payload, address: kp.publicKey.toBase58() }), "utf8");
  const res = await fetch(`${FN}/authVerify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: kp.publicKey.toBase58(), message: message.toString("base64"), signature: signBytes(kp, message).toString("base64") }),
  });
  const out = (await res.json()) as { token?: unknown; error?: string };
  if (res.status !== 200 || typeof out.token !== "string") throw new Error(`${name} sign-in failed: HTTP ${res.status} ${out.error}`);
  const app = initializeApp(config, `cohort-smoke-${name}`);
  const cred = await signInWithCustomToken(getAuth(app), out.token);
  check(`${name} signed in`, cred.user.uid === kp.publicKey.toBase58(), `uid ${cred.user.uid.slice(0, 4)}…${cred.user.uid.slice(-4)}`);
  return getFirestore(app);
}

async function main() {
  const u1 = testKey(1);
  const u2 = testKey(2);
  const w1 = u1.publicKey.toBase58();
  const w2 = u2.publicKey.toBase58();
  const c = await cohort();
  const start = Number(c.startTs);
  console.log(`cohort 0-2: start ${hhmmss(start * 1000)} UTC, ${c.days} days of ${c.daySeconds} s, participants ${c.participants}`);
  const fs1 = await signIn(u1, "test-user1");
  const fs2 = await signIn(u2, "test-user2");

  for (let d = 0; d < c.days; d++) {
    const mid = (start + d * c.daySeconds + c.daySeconds / 2) * 1000;
    const latest = (start + (d + 1) * c.daySeconds - 60) * 1000; // stay a minute clear of the next boundary
    if (Date.now() < mid) await sleep(mid - Date.now());
    if (Date.now() > latest) {
      check(`day ${d + 1} workouts`, false, "too late for this day's window");
      continue;
    }
    const writes: [Firestore, string][] = d === 0 ? [[fs1, w1], [fs2, w2]] : [[fs1, w1]];
    for (const [db, w] of writes) {
      try {
        await addDoc(collection(db, `users/${w}/workouts`), { uid: w, rawReps: 30, reps: 30, elapsed: 60, createdAt: Date.now() });
        check(`day ${d + 1} workout ${w.slice(0, 4)}…`, true);
      } catch (e) {
        check(`day ${d + 1} workout ${w.slice(0, 4)}…`, false, code(e));
      }
    }
  }

  // The server marks test-user1 on the last day (needs config/ops.paused == false).
  let li: Record<string, unknown> | undefined;
  for (let i = 0; i < 60 && !li; i++) {
    const snap = await getDoc(doc(fs1, `users/${w1}/lockedIn/0-2`));
    if (snap.exists() && snap.get("success") === true) li = snap.data();
    else await sleep(5000);
  }
  const s1 = (await cohort()).slots.find((s) => s.user.equals(u1.publicKey));
  const s2 = (await cohort()).slots.find((s) => s.user.equals(u2.publicKey));
  check("test-user1 lockedIn success", li?.success === true, li ? `dayReps ${JSON.stringify(li.dayReps)}, successTx ${String(li.successTx).slice(0, 8)}…` : "not within 5 minutes (is config/ops.paused false?)");
  check("test-user1 SUCCESS flag on chain", !!s1 && P.hasFlag(s1, P.FLAG.SUCCESS));
  check("test-user2 not marked", !!s2 && !P.hasFlag(s2, P.FLAG.SUCCESS));
  const pts = await getDoc(doc(fs1, `users/${w1}/points_history/li-0-2`));
  check("completion points recorded once", pts.exists() && pts.get("amount") === 300, pts.exists() ? `amount ${pts.get("amount")}` : "missing");
  const li2 = await getDoc(doc(fs2, `users/${w2}/lockedIn/0-2`));
  console.log(`test-user2 progress: dayReps ${JSON.stringify(li2.get("dayReps"))}, success ${li2.get("success")}`);

  await terminate(fs1);
  await terminate(fs2);
  const failed = results.filter((r) => !r).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(`ERROR: ${e instanceof Error ? e.message.replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]") : code(e)}`);
  process.exit(1);
});
