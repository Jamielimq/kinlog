// Production sign-in smoke test. Uses only the test wallet test-user1 (its key file is read, never
// printed); test-user2 appears only as a public address. Prints PASS/FAIL lines, "token issued" and the
// signed-in uid; never prints keys, tokens or the web app config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import { addDoc, collection, doc, getDoc, getFirestore, terminate } from "firebase/firestore";
import { buildSignInMessage } from "../src/auth/siws.ts";
import { kstDateKey } from "../src/time.ts";
import { signBytes } from "../test/support/sign.ts";

const FN = "https://asia-northeast3-kinlog-6549a.cloudfunctions.net";
const TEST_USER2 = "DfdQbN6pkJf1t9d52CWx8cGQEzKJ2mAadw6JRxdzP2Ap"; // public address; its key is not opened
const configText = fs.readFileSync(path.resolve("../docs/private/firebase-web-config.json"), "utf8");
const config = JSON.parse(configText.slice(configText.indexOf("{"), configText.lastIndexOf("}") + 1));
const user = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/kinlog/test-wallets/test-user1.json"), "utf8"))),
);
const w = user.publicKey.toBase58();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
/** Firebase error code only (never the message, which could echo request details). */
const code = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "error");
const post = (body: unknown) =>
  fetch(`${FN}/authVerify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function finish(): never {
  const failed = results.filter((r) => !r).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

async function main() {
  console.log(`test wallet: ${w}`);

  // 1. nonce -> SIWS text signed by the test wallet -> custom token
  const payload = await (await fetch(`${FN}/authNonce`)).json();
  const message = Buffer.from(buildSignInMessage({ ...payload, address: w }), "utf8");
  const body = { address: w, message: message.toString("base64"), signature: signBytes(user, message).toString("base64") };
  const res = await post(body);
  const out = (await res.json()) as { token?: unknown; error?: string };
  const token = typeof out.token === "string" ? out.token : null;
  check("1 authVerify issues a custom token", res.status === 200 && token !== null, `HTTP ${res.status}, ${token ? "token issued" : out.error}`);
  if (!token) finish();

  // 2. sign in with it
  const app = initializeApp(config, "smoke-user1");
  const cred = await signInWithCustomToken(getAuth(app), token);
  check("2 signed in as the test wallet", cred.user.uid === w, `uid ${cred.user.uid}`);
  const own = getFirestore(app);

  // 3. a signed-in workout, through the rules
  try {
    await addDoc(collection(own, `users/${w}/workouts`), { uid: w, rawReps: 30, reps: 30, elapsed: 60, createdAt: Date.now() });
    check("3 owner writes a signed-in workout", true);
  } catch (e) {
    check("3 owner writes a signed-in workout", false, code(e));
  }

  // 4. onWorkoutCreate adds it to today's (KST) total
  const day = kstDateKey(Date.now());
  let reps: number | undefined;
  for (let i = 0; i < 30 && reps === undefined; i++) {
    const snap = await getDoc(doc(own, `users/${w}/daily/${day}`));
    const r = snap.exists() ? snap.get("reps") : undefined;
    if (typeof r === "number" && r >= 30) reps = r;
    else await sleep(1000);
  }
  check("4 onWorkoutCreate recorded today's reps", reps !== undefined, reps !== undefined ? `daily/${day} reps ${reps}` : "not within 30 s");

  // 5. the same signed message again
  const replay = await post(body);
  check("5 the same signed message is refused", replay.status === 409, `HTTP ${replay.status} ${((await replay.json()) as { error?: string }).error}`);

  // 6. a tampered signature
  const sig = Buffer.from(body.signature, "base64");
  sig[0] ^= 1;
  const bad = await post({ ...body, signature: sig.toString("base64") });
  check("6 a tampered signature is refused", bad.status === 401, `HTTP ${bad.status} ${((await bad.json()) as { error?: string }).error}`);

  // 7. signed out, writing to the test wallet (now signed in, so owner-only)
  const anon = getFirestore(initializeApp(config, "smoke-anon"));
  try {
    await addDoc(collection(anon, `users/${w}/workouts`), { exercise: "squat", reps: 1, elapsed: 5, createdAt: Date.now() });
    check("7 signed-out write to a signed-in wallet is refused", false, "write was allowed");
  } catch (e) {
    check("7 signed-out write to a signed-in wallet is refused", code(e) === "permission-denied", code(e));
  }

  // 8. test-user1's token writing a signed-in workout for test-user2
  try {
    await addDoc(collection(own, `users/${TEST_USER2}/workouts`), { uid: TEST_USER2, rawReps: 30, reps: 30, elapsed: 60, createdAt: Date.now() });
    check("8 another wallet's token cannot write test-user2's signed-in workout", false, "write was allowed");
  } catch (e) {
    check("8 another wallet's token cannot write test-user2's signed-in workout", code(e) === "permission-denied", code(e));
  }

  await terminate(own);
  await terminate(anon);
  finish();
}

main().catch((e: unknown) => {
  console.error(`ERROR: ${code(e)} ${e instanceof Error ? e.name : ""}`);
  process.exit(1);
});
