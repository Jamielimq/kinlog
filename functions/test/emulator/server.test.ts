// Server logic against the Firestore and Auth emulators (project demo-kinlog), with the program
// replaced by FakeChain. Run through `firebase emulators:exec --only firestore,auth`.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { initializeApp as adminApp } from "firebase-admin/app";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore as adminFirestore } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from "firebase/auth";
import { addDoc, collection, connectFirestoreEmulator, getFirestore, terminate } from "firebase/firestore";
import { checkSignIn, completeSignIn, signInPayload } from "../../src/auth/handlers.ts";
import { buildSignInMessage } from "../../src/auth/siws.ts";
import * as P from "../../src/chain/program.ts";
import { ChainTxError } from "../../src/chain/types.ts";
import { refreshCohorts } from "../../src/cohorts.ts";
import { runEveryMinute } from "../../src/crank/everyMinute.ts";
import { runDaily } from "../../src/daily/daily.ts";
import type { PriceRead } from "../../src/daily/price.ts";
import { kstMidnight } from "../../src/daily/schedule.ts";
import { onWorkoutCreated } from "../../src/workout/attest.ts";
import { FakeChain, newWallet, rngFor } from "../support/fakeChain.ts";
import { signBytes } from "../support/sign.ts";

const PROJECT = "demo-kinlog";
adminApp({ projectId: PROJECT });
const db = adminFirestore();
const SECRET = "emulator-nonce-secret-0123456789";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(host, "run under firebase emulators:exec");
  const res = await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(res.status, 200);
}
async function setOps(fields: Record<string, unknown>) {
  await db.doc("config/ops").set(fields);
}
const alertsSent = async () => Object.keys((await db.doc("ops/alerts").get()).data() ?? {});

beforeEach(clearFirestore);

describe("wallet sign-in", () => {
  test("a signed message gets a token that unlocks only that wallet, once", async () => {
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const now = Date.now();
    const text = buildSignInMessage({ ...signInPayload(SECRET, now), address: w });
    const message = Buffer.from(text, "utf8");
    const body = { address: w, message: message.toString("base64"), signature: signBytes(kp, message).toString("base64") };
    const check = checkSignIn(SECRET, body, now);
    assert.equal(check.ok, true);
    if (!check.ok) return;
    const out = await completeSignIn(db, adminAuth(), check, now);
    assert.equal(out.status, 200);
    assert.ok((await db.doc(`authLinks/${w}`).get()).exists);
    // The same nonce cannot be used twice.
    const again = await completeSignIn(db, adminAuth(), check, now);
    assert.equal(again.status, 409);

    // The token signs the client in as the wallet, and the owner can write a signed-in workout.
    const app = initializeApp({ projectId: PROJECT, apiKey: "demo-api-key" }, `client-${w}`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
    const cred = await signInWithCustomToken(auth, out.body.token);
    assert.equal(cred.user.uid, w);
    const fs = getFirestore(app);
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
    connectFirestoreEmulator(fs, host, Number(port));
    await addDoc(collection(fs, `users/${w}/workouts`), { uid: w, rawReps: 30, reps: 30, elapsed: 60, createdAt: Date.now() });
    await signOut(auth);
    await terminate(fs);
  });
});

describe("attestation (onWorkoutCreate)", () => {
  // Three 3-second days on the real clock: Firestore's create time decides the day.
  const DAY = 3;
  let chain: FakeChain;
  let user: PublicKey;
  const key = { kind: 0, id: 1 };
  let startTs: number;
  const deps = () => ({ db, chain, nowMs: () => Date.now() });
  const tick = () => (chain.nowSec = Date.now() / 1000);

  async function workout(fields: Record<string, unknown>) {
    const ref = await db.collection(`users/${user.toBase58()}/workouts`).add({ createdAt: Date.now(), ...fields });
    const snap = await ref.get();
    tick();
    return onWorkoutCreated(deps(), user.toBase58(), ref.id, snap.data()!, snap.createTime!.toMillis());
  }
  const waitForDay = async (i: number) => {
    const target = (startTs + i * DAY) * 1000 + 300;
    if (Date.now() < target) await sleep(target - Date.now());
  };

  beforeEach(async () => {
    chain = new FakeChain(Date.now() / 1000);
    chain.config.minDaySeconds = 1;
    user = newWallet();
    startTs = Math.ceil(Date.now() / 1000) + 1;
    chain.addCohort(key, startTs, DAY);
    tick();
    chain.join(key, user);
    await refreshCohorts(db, chain, Date.now());
    await setOps({ paused: false });
  });

  test("counts signed-in workouts per day and marks success on the last day, once", async () => {
    const w = user.toBase58();
    await waitForDay(0);
    assert.deepEqual(await workout({ uid: w, rawReps: 30, reps: 30, elapsed: 60 }), { "0-1": "progress" });
    // A 1.3.3 workout (no uid) never counts.
    assert.deepEqual(await workout({ reps: 30, elapsed: 60 }), {});
    await waitForDay(1);
    await workout({ uid: w, rawReps: 20, reps: 20, elapsed: 40 });
    // rawReps counts even when the app's own daily cap made reps 0.
    await workout({ uid: w, rawReps: 10, reps: 0, elapsed: 20 });
    await waitForDay(2);
    assert.deepEqual(await workout({ uid: w, rawReps: 30, reps: 30, elapsed: 60 }), { "0-1": "attested" });
    assert.deepEqual(chain.sent.map((t) => t.op), ["markSuccess"]);

    const li = (await db.doc(`users/${w}/lockedIn/0-1`).get()).data()!;
    assert.deepEqual(li.dayReps, [30, 30, 30]);
    assert.equal(li.success, true);
    assert.equal(li.pointsAwarded, true);
    assert.equal((await db.doc(`users/${w}/points_history/li-0-1`).get()).data()!.amount, 300);
    assert.equal((await db.doc(`users/${w}`).get()).data()!.points, 300);

    // Another workout the same day: already successful, nothing sent, no second award.
    assert.deepEqual(await workout({ uid: w, rawReps: 5, reps: 5, elapsed: 10 }), { "0-1": "already" });
    assert.equal(chain.sent.length, 1);
    assert.equal((await db.doc(`users/${w}`).get()).data()!.points, 300);
  });

  test("a missed day fails; a duplicate trigger is counted once", async () => {
    const w = user.toBase58();
    await waitForDay(0);
    const ref = await db.collection(`users/${w}/workouts`).add({ uid: w, rawReps: 30, reps: 30, elapsed: 60, createdAt: Date.now() });
    const snap = await ref.get();
    tick();
    await onWorkoutCreated(deps(), w, ref.id, snap.data()!, snap.createTime!.toMillis());
    await onWorkoutCreated(deps(), w, ref.id, snap.data()!, snap.createTime!.toMillis());
    const daily = (await db.collection(`users/${w}/daily`).get()).docs[0].data();
    assert.equal(daily.reps, 30);
    await waitForDay(2); // day 1 skipped
    assert.deepEqual(await workout({ uid: w, rawReps: 30, reps: 30, elapsed: 60 }), { "0-1": "progress" });
    assert.equal(chain.sent.length, 0);
  });

  test("at the last day's first second, waits for the chain clock instead of failing", async () => {
    const w = user.toBase58();
    // The chain trails wall time; FakeChain follows the real clock minus this lag.
    const realTick = tick;
    chain.clockLagSec = 2;
    Object.defineProperty(chain, "nowSec", { get: () => Date.now() / 1000, set: () => undefined, configurable: true });
    for (let d = 0; d < 3; d++) {
      await waitForDay(d);
      const out = await workout({ uid: w, rawReps: 30, reps: 30, elapsed: 60 });
      if (d === 2) assert.deepEqual(out, { "0-1": "attested" });
    }
    assert.deepEqual(await alertsSent(), []);
    void realTick;
  });

  test("while paused nothing is sent; the sweep attests after unpausing", async () => {
    const w = user.toBase58();
    await setOps({ paused: true });
    for (let d = 0; d < 3; d++) {
      await waitForDay(d);
      await workout({ uid: w, rawReps: 30, reps: 30, elapsed: 60 });
    }
    assert.equal(chain.sent.length, 0);
    assert.equal((await db.doc(`users/${w}/lockedIn/0-1`).get()).data()!.allMet, true);
    await setOps({ paused: false });
    tick();
    const sum = await runEveryMinute(deps(), { sweep: true });
    assert.equal(sum.attested, 1);
    assert.deepEqual(chain.sent.map((t) => t.op), ["markSuccess"]);
  });

  test("a failed mark_success raises one alert and is retried by the sweep", async () => {
    const w = user.toBase58();
    chain.failNext.set("markSuccess", new ChainTxError("fake: insufficient", undefined, undefined, true));
    for (let d = 0; d < 3; d++) {
      await waitForDay(d);
      await workout({ uid: w, rawReps: 30, reps: 30, elapsed: 60 });
    }
    assert.deepEqual(await alertsSent(), ["server_sol_low:attester"]);
    tick();
    const sum = await runEveryMinute(deps(), { sweep: true });
    assert.equal(sum.attested, 1);
  });
});

describe("everyMinute", () => {
  const key = { kind: 0, id: 2 };
  let chain: FakeChain;
  let t0: number;
  const deps = (nowMs?: number) => ({ db, chain, nowMs: () => nowMs ?? chain.nowSec * 1000 });
  const lockedIn = async (u: PublicKey) => (await db.doc(`users/${u.toBase58()}/lockedIn/0-2`).get()).data();
  const pastDeadline = () => (chain.nowSec = t0 + 3 * 600 + 5 * 600 + 1);

  function successful(n: number) {
    const users = Array.from({ length: n }, () => newWallet());
    for (const u of users) chain.join(key, u);
    chain.nowSec = t0 + 3 * 600 + 10; // after the end
    for (const u of users) chain.cohorts.get("0-2")!.slots.find((s) => s.user.equals(u))!.flags |= P.FLAG.SUCCESS;
    return users;
  }

  beforeEach(async () => {
    t0 = 1_790_000_000;
    chain = new FakeChain(t0 - 100);
    chain.addCohort(key, t0, 600);
    chain.nowSec = t0 + 10;
    await setOps({ paused: false });
  });

  test("settles picks in order once the round is revealed and records tiers and grants", async () => {
    const [a, b] = successful(2);
    chain.pick(key, a, 5);
    chain.pick(key, b, 7);
    const target = chain.board + 1n;
    let sum = await runEveryMinute(deps());
    assert.equal(sum.settled, 0, "round not revealed yet");
    chain.board = target;
    chain.setRound(target, rngFor(5, false));
    sum = await runEveryMinute(deps());
    assert.equal(sum.settled, 2);
    const la = (await db.doc(`users/${a.toBase58()}/lockedIn/0-2`).get()).data()!;
    const lb = (await db.doc(`users/${b.toBase58()}/lockedIn/0-2`).get()).data()!;
    assert.equal(la.tier, P.TIER.RARE);
    assert.equal(la.amount, (164_000_000n * 2n).toString());
    assert.equal(lb.tier, P.TIER.COMMON);
    assert.ok((await db.doc(`users/${a.toBase58()}/badges/square_3d_rare/grants/0-2`).get()).exists);
    assert.ok((await db.doc(`users/${b.toBase58()}/badges/square_3d_common/grants/0-2`).get()).exists);
    // Success points were awarded to both by the slot sync.
    assert.equal((await db.doc(`users/${a.toBase58()}`).get()).data()!.points, 300);
  });

  test("retargets a finished round without entropy; a closed round settles as Common", async () => {
    const [a, b] = successful(2);
    chain.pick(key, a, 1);
    const first = chain.board + 1n;
    chain.board = first + 1n; // ORE moved on
    chain.setRound(first, null); // finished without entropy
    let sum = await runEveryMinute(deps());
    assert.equal(sum.retargeted, 1);
    const retargeted = chain.cohorts.get("0-2")!.slots.find((s) => s.user.equals(a))!.targetRound;
    assert.equal(retargeted, chain.board + 1n);

    chain.board = retargeted + 5n; // the new target was closed before anyone settled it
    sum = await runEveryMinute(deps());
    assert.equal(sum.settled, 1);
    assert.equal(chain.cohorts.get("0-2")!.slots.find((s) => s.user.equals(a))!.tier, P.TIER.COMMON);
    void b;
  });

  test("alerts once when a pick stays unsettled for 15 minutes", async () => {
    const [a] = successful(1);
    chain.pick(key, a, 3);
    const start = chain.nowSec * 1000;
    await runEveryMinute(deps(start));
    await runEveryMinute(deps(start + 16 * 60_000));
    await runEveryMinute(deps(start + 17 * 60_000));
    const sent = await alertsSent();
    assert.equal(sent.filter((k) => k.startsWith("pick_stuck")).length, 1);
  });

  test("after the deadline returns what is left, records every slot, then closes the cohort", async () => {
    const [a, b] = successful(2);
    chain.withdraw(key, a); // a withdrew on their own (test-user1 in the mainnet test cohort)
    await runEveryMinute(deps());
    assert.equal((await lockedIn(a))?.returned, true);
    assert.equal((await lockedIn(b))?.returned, false);
    pastDeadline();
    const sum = await runEveryMinute(deps());
    assert.equal(sum.returned, 1);
    assert.equal(sum.closed, 1);
    assert.equal(chain.cohorts.has("0-2"), false);
    assert.deepEqual(chain.sent.filter((t) => t.op === "returnDeposit").map((t) => t.user), [b.toBase58()]);
    // b's return (test-user2's case) was recorded before the close took the slots away.
    assert.equal((await lockedIn(b))?.returned, true);
    assert.equal((await lockedIn(a))?.returned, true);
    assert.equal((await db.doc("cohorts/0-2").get()).data()?.returned, 2);
    await runEveryMinute(deps());
    assert.equal((await db.doc("cohorts/0-2").get()).data()!.status, "closed");
  });

  test("a withdrawal after the last sync is recorded when the same run closes the cohort", async () => {
    const [a] = successful(1);
    await runEveryMinute(deps());
    assert.equal((await lockedIn(a))?.returned, false);
    chain.withdraw(key, a); // just before the deadline, after the last sync
    pastDeadline();
    const sum = await runEveryMinute(deps());
    assert.deepEqual([sum.returned, sum.closed], [0, 1]);
    assert.equal((await lockedIn(a))?.returned, true);
  });

  test("a failed close keeps the final record and closes on the next run", async () => {
    const [a] = successful(1);
    pastDeadline();
    chain.failNext.set("closeCohort", new ChainTxError("fake: blockhash expired"));
    let sum = await runEveryMinute(deps());
    assert.deepEqual([sum.returned, sum.closed], [1, 0]);
    assert.equal((await lockedIn(a))?.returned, true, "recorded before the close was attempted");
    assert.deepEqual(await alertsSent(), ["job_error:everyMinute:0-2"]);
    sum = await runEveryMinute(deps());
    assert.equal(sum.closed, 1);
  });

  test("the test alert switch writes one alert", async () => {
    await setOps({ paused: true, testAlert: true });
    await runEveryMinute(deps());
    await runEveryMinute(deps());
    assert.deepEqual(await alertsSent(), ["test:test"]);
  });

  test("paused sends nothing", async () => {
    const [a] = successful(1);
    chain.pick(key, a, 3);
    chain.board += 1n;
    chain.setRound(chain.board, rngFor(3, false));
    await setOps({ paused: true });
    const sum = await runEveryMinute(deps());
    assert.equal(sum.settled, 0);
    assert.equal(chain.sent.length, 0);
  });
});

describe("daily", () => {
  // 2026-09-29 12:00 KST: the next 3-Day start on or after createFrom 2026-10-04 is 2026-10-04.
  const NOW = Date.UTC(2026, 8, 29, 3, 0, 0);
  let chain: FakeChain;
  const prices = (sol = 113.72, ore = 69.35, sol2 = sol, ore2 = ore) => async (): Promise<PriceRead[]> => [
    { source: "jupiter", sol, ore },
    { source: "coingecko", sol: sol2, ore: ore2 },
  ];
  const deps = (p: () => Promise<(PriceRead | Error)[]> = prices()) => ({ db, chain, nowMs: () => NOW, prices: p });

  beforeEach(() => {
    chain = new FakeChain(NOW / 1000);
  });

  test("dryRun plans the 10/4 cohort without sending", async () => {
    await setOps({ paused: false, create3Day: "dryRun", createFrom: "2026-10-04" });
    const { plans } = await runDaily(deps());
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, 20261004);
    assert.equal(plans[0].startTs, kstMidnight(2026, 10, 4));
    assert.equal(new Date(plans[0].startTs * 1000).toISOString(), "2026-10-03T15:00:00.000Z");
    assert.equal(plans[0].commonAmount, "164000000"); // 0.00164 ORE, the documented example
    assert.equal(chain.sent.length, 0);
  });

  test("on creates it once, with the documented Common, and mirrors it", async () => {
    await setOps({ paused: false, create3Day: "on", createFrom: "2026-10-04" });
    await runDaily(deps());
    assert.deepEqual(chain.sent.map((t) => t.cohort), ["0-20261004"]);
    const c = chain.cohorts.get("0-20261004")!;
    assert.equal(c.commonAmount, 164_000_000n);
    assert.equal(c.depositAmount, 100_000_000n);
    const m = (await db.doc("cohorts/0-20261004").get()).data()!;
    assert.equal(m.isTest, false);
    assert.equal(m.status, "scheduled");
    await runDaily(deps());
    assert.equal(chain.sent.length, 1, "a scheduled cohort already exists");
    // 7-Day stays off unless switched on.
    assert.equal([...chain.cohorts.keys()].some((k) => k.startsWith("1-")), false);
  });

  test("paused or off creates nothing", async () => {
    await setOps({ paused: true, create3Day: "on" });
    await runDaily(deps());
    await setOps({ paused: false });
    await runDaily(deps());
    assert.equal(chain.sent.length, 0);
  });

  test("price disagreement or failure falls back and alerts; nothing usable stops creation", async () => {
    await setOps({ paused: false, create3Day: "on", createFrom: "2026-10-04" });
    await runDaily(deps(async () => [new Error("jupiter HTTP 401"), { source: "coingecko", sol: 113.72, ore: 69.35 }]));
    assert.equal(chain.sent.length, 0);
    assert.ok((await alertsSent()).some((k) => k.startsWith("cohort_create_failed")));

    await setOps({ paused: false, create3Day: "on", createFrom: "2026-10-04", fallbackCommon: "150000000" });
    await runDaily(deps(prices(113.72, 69.35, 113.72, 60)));
    assert.equal(chain.cohorts.get("0-20261004")!.commonAmount, 150_000_000n);
  });

  test("Legendary above max_reward_per_box stops creation", async () => {
    await setOps({ paused: false, create3Day: "on", createFrom: "2026-10-04" });
    await runDaily(deps(prices(113.72, 1)));
    assert.equal(chain.sent.length, 0);
    assert.ok((await alertsSent()).some((k) => k.includes("legendary_above_max")));
  });

  test("low server SOL and a low reward vault raise alerts", async () => {
    await setOps({ paused: true });
    chain.lamports.set(chain.config.crank.toBase58(), 10_000_000n);
    chain.vault = 50_000_000_000n;
    await runDaily(deps());
    const sent = await alertsSent();
    assert.ok(sent.includes("server_sol_low:crank"));
    assert.ok(sent.includes("reward_vault_low:vault"));
    assert.ok(!sent.includes("server_sol_low:attester"));
  });
});

after(async () => {
  await clearFirestore();
});
void FieldValue;
void before;
