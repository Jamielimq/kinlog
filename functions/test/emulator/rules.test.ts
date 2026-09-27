// firestore.rules against the Firestore emulator (project demo-kinlog). The signed-out cases replay
// the exact writes and reads the live v1.3.3 app makes.
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { Keypair } from "@solana/web3.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  type Firestore,
  getDoc,
  getDocs,
  increment,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";

const wallet = () => Keypair.generate().publicKey.toBase58();
const W1 = wallet(); // never signed in (v1.3.3 user)
const W2 = wallet(); // signed in with the new app (authLinks exists)
const W3 = wallet(); // some other signed-in wallet
const TESTER = wallet();

let env: RulesTestEnvironment;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-kinlog",
    firestore: { rules: fs.readFileSync(path.resolve("../firestore.rules"), "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => {
  await env.cleanup();
});

const activeChallenge = () => ({
  challengeId: "three_day_challenger",
  status: "active",
  sequence: 1,
  startedAt: Date.now() - 1000,
  startTxSignature: "sig",
  startMemo: "kinlog:start",
  requirementSnapshot: { requirementDays: 3 },
  progress: { dayIndex: 0, daysLog: {} },
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    await setDoc(doc(db, `authLinks/${W2}`), { linkedAt: 1 });
    await setDoc(doc(db, "config/testers"), { wallets: [TESTER] });
    await setDoc(doc(db, "config/ops"), { paused: true });
    await setDoc(doc(db, "cohorts/0-20261004"), { isTest: false, kind: 0, id: 20261004 });
    await setDoc(doc(db, "cohorts/0-1"), { isTest: true, kind: 0, id: 1 });
    await setDoc(doc(db, "challenges/three_day_challenger"), { bonusPoints: 300, isActive: true });
    for (const w of [W1, W2]) {
      await setDoc(doc(db, `users/${w}`), { points: 0 });
      await setDoc(doc(db, `users/${w}/workouts/legacy`), { exercise: "squat", reps: 10, elapsed: 60, createdAt: Date.now() });
      await setDoc(doc(db, `users/${w}/workouts/signed`), { uid: w, rawReps: 30, reps: 30, elapsed: 60, createdAt: Date.now() });
      await setDoc(doc(db, `users/${w}/lockedIn/0-20261004`), { dayReps: [30, 0, 0] });
      await setDoc(doc(db, `users/${w}/daily/2026-10-04`), { reps: 30 });
      await setDoc(doc(db, `users/${w}/badges/square_3d_common/grants/0-20261004`), { tier: 1 });
      await setDoc(doc(db, `users/${w}/points_history/li-0-20261004`), { amount: 300 });
      await setDoc(doc(db, `users/${w}/cache/skr_staking`), { account: "x" });
      await setDoc(doc(db, `users/${w}/userChallenges/active1`), activeChallenge());
    }
  });
});

const signedOut = () => env.unauthenticatedContext().firestore() as unknown as Firestore;
const signedIn = (uid: string) => env.authenticatedContext(uid).firestore() as unknown as Firestore;

/** Everything v1.3.3 writes and reads for its own wallet, field for field. */
function legacyOps(db: Firestore, w: string): [string, () => Promise<unknown>][] {
  const now = Date.now();
  return [
    ["saveWorkout: users merge", () => setDoc(doc(db, `users/${w}`), { totalSquats: 10, totalWorkouts: 1, currentStreak: 1, bestStreak: 1, lastWorkoutDate: now, dailyReps: 10, points: increment(50), updatedAt: now }, { merge: true })],
    ["saveWorkout: points_history", () => addDoc(collection(db, `users/${w}/points_history`), { reason: "Completed 10 squats", amount: 50, createdAt: now })],
    ["saveWorkout: workouts", () => addDoc(collection(db, `users/${w}/workouts`), { exercise: "squat", reps: 10, elapsed: 60, createdAt: now })],
    ["saveWorkout: workouts with 0 reps", () => addDoc(collection(db, `users/${w}/workouts`), { exercise: "squat", reps: 0, elapsed: 5, createdAt: now })],
    ["saveWorkout: goals/weekly", () => setDoc(doc(db, `users/${w}/goals/weekly`), { current: 1, total: 7, lastResetDate: now }, { merge: true })],
    ["saveWorkout: goals/monthly", () => setDoc(doc(db, `users/${w}/goals/monthly`), { current: 1, total: 30, lastResetDate: now }, { merge: true })],
    ["saveWorkout: goals/daily", () => setDoc(doc(db, `users/${w}/goals/daily`), { current: 10, total: 30 }, { merge: true })],
    ["checkAndAwardBadges", () => setDoc(doc(db, `users/${w}/badges/squats_30`), { earned: true, earnedAt: now }, { merge: true })],
    ["WalletContext init", () => setDoc(doc(db, `users/${w}`), { updatedAt: now, createdAt: now }, { merge: true })],
    ["useGoals reset", () => setDoc(doc(db, `users/${w}/goals/daily`), { current: 0, lastResetDate: now }, { merge: true })],
    ["useGoals seed", () => setDoc(doc(db, `users/${w}/goals/g1`), { tag: "DAILY", title: "Daily", current: 0, total: 30, color: "#fff" })],
    ["badges.tsx staker", () => setDoc(doc(db, `users/${w}/badges/skr_staker`), { earned: true, earnedAt: now }, { merge: true })],
    ["badges.tsx mint", () => setDoc(doc(db, `users/${w}/badges/squats_30`), { mintedAt: now, txSignature: "sig" }, { merge: true })],
    ["badges.tsx mint points", () => setDoc(doc(db, `users/${w}`), { points: increment(100), updatedAt: now }, { merge: true })],
    ["useSkrStaking cache delete", () => deleteDoc(doc(db, `users/${w}/cache/skr_staking`))],
    ["useStartChallenge create", () => addDoc(collection(db, `users/${w}/userChallenges`), { ...activeChallenge(), sequence: 2 })],
    ["challengeProgress update", () => setDoc(doc(db, `users/${w}/userChallenges/active1`), { progress: { dayIndex: 1, daysLog: {} } }, { merge: true })],
    ["read users", () => getDoc(doc(db, `users/${w}`))],
    ["read workouts", () => getDocs(collection(db, `users/${w}/workouts`))],
    ["read points_history", () => getDocs(collection(db, `users/${w}/points_history`))],
    ["read goals", () => getDocs(collection(db, `users/${w}/goals`))],
    ["read badges", () => getDocs(collection(db, `users/${w}/badges`))],
    ["read userChallenges", () => getDocs(query(collection(db, `users/${w}/userChallenges`), where("status", "==", "active")))],
    ["read challenges catalog", () => getDocs(query(collection(db, "challenges"), where("isActive", "==", true)))],
  ];
}

async function expectAll(kind: "succeed" | "fail", ops: [string, () => Promise<unknown>][]) {
  for (const [name, op] of ops) {
    try {
      await (kind === "succeed" ? assertSucceeds(op()) : assertFails(op()));
    } catch (e) {
      throw new Error(`${name}: expected to ${kind} (${(e as Error).message})`);
    }
  }
}
const withoutCatalog = (ops: [string, () => Promise<unknown>][]) => ops.filter(([n]) => n !== "read challenges catalog");

test("v1.3.3 keeps working, signed out, for a wallet that never signed in", async () => {
  await expectAll("succeed", legacyOps(signedOut(), W1));
});

test("a wallet that signed in is closed to signed-out clients", async () => {
  await expectAll("fail", withoutCatalog(legacyOps(signedOut(), W2)));
});

test("the owner's own token can do everything v1.3.3 did", async () => {
  await expectAll("succeed", legacyOps(signedIn(W2), W2));
  await expectAll("succeed", legacyOps(signedIn(W1), W1));
});

test("another signed-in wallet cannot touch either wallet", async () => {
  await expectAll("fail", withoutCatalog(legacyOps(signedIn(W3), W1)));
  await expectAll("fail", withoutCatalog(legacyOps(signedIn(W3), W2)));
});

test("server-only paths refuse every client write", async () => {
  for (const db of [signedOut(), signedIn(W1), signedIn(W2), signedIn(TESTER)]) {
    for (const w of [W1, W2]) {
      await assertFails(setDoc(doc(db, `users/${w}/daily/2026-10-05`), { reps: 99 }));
      await assertFails(setDoc(doc(db, `users/${w}/lockedIn/0-20261004`), { dayReps: [99, 99, 99] }, { merge: true }));
      await assertFails(setDoc(doc(db, `users/${w}/badges/square_3d_legendary/grants/0-20261004`), { tier: 3 }));
      await assertFails(setDoc(doc(db, `users/${w}/points_history/li-0-20261004`), { amount: 700 }));
      await assertFails(deleteDoc(doc(db, `users/${w}/points_history/li-0-20261004`)));
    }
    await assertFails(setDoc(doc(db, "cohorts/0-20261007"), { isTest: false }));
    await assertFails(setDoc(doc(db, "config/testers"), { wallets: [W1] }));
    await assertFails(setDoc(doc(db, "config/ops"), { paused: false }));
    await assertFails(getDoc(doc(db, "config/ops")));
    await assertFails(setDoc(doc(db, `authLinks/${W1}`), { linkedAt: 1 }));
    await assertFails(deleteDoc(doc(db, `authLinks/${W2}`)));
    await assertFails(getDoc(doc(db, `authLinks/${W2}`)));
    await assertFails(setDoc(doc(db, "authNonces/n"), { usedAt: 1 }));
    await assertFails(setDoc(doc(db, "ops/alerts"), { x: 1 }));
    await assertFails(setDoc(doc(db, "challenges/new"), { bonusPoints: 1 }));
  }
});

test("Locked In progress is readable by its owner only", async () => {
  for (const w of [W1, W2]) {
    const own = signedIn(w);
    await assertSucceeds(getDoc(doc(own, `users/${w}/lockedIn/0-20261004`)));
    await assertSucceeds(getDoc(doc(own, `users/${w}/daily/2026-10-04`)));
    await assertSucceeds(getDoc(doc(own, `users/${w}/badges/square_3d_common/grants/0-20261004`)));
    for (const db of [signedOut(), signedIn(W3)]) {
      await assertFails(getDoc(doc(db, `users/${w}/lockedIn/0-20261004`)));
      await assertFails(getDoc(doc(db, `users/${w}/daily/2026-10-04`)));
      await assertFails(getDoc(doc(db, `users/${w}/badges/square_3d_common/grants/0-20261004`)));
    }
  }
});

test("signed-in workouts: owner only, plausible, immutable", async () => {
  const good = () => ({ uid: W2, rawReps: 30, reps: 30, elapsed: 60, createdAt: Date.now() });
  const own = signedIn(W2);
  const col = collection(own, `users/${W2}/workouts`);
  await assertSucceeds(addDoc(col, good()));
  await assertSucceeds(addDoc(col, { uid: W2, rawReps: 40, elapsed: 80, createdAt: Date.now() }));
  await assertFails(addDoc(col, { ...good(), uid: W1 }));
  await assertFails(addDoc(col, { ...good(), rawReps: 301, elapsed: 400 }));
  await assertFails(addDoc(col, { ...good(), rawReps: 30.5 }));
  await assertFails(addDoc(col, { ...good(), reps: 31 }));
  await assertFails(addDoc(col, { ...good(), elapsed: 29 }));
  await assertFails(addDoc(col, { ...good(), elapsed: 30_000 }));
  await assertFails(addDoc(col, { ...good(), createdAt: Date.now() - 11 * 60_000 }));
  await assertFails(addDoc(col, { ...good(), createdAt: Date.now() + 11 * 60_000 }));
  await assertFails(addDoc(col, { ...good(), createdAt: Timestamp.now() }));
  await assertFails(updateDoc(doc(own, `users/${W2}/workouts/signed`), { rawReps: 300 }));
  await assertFails(deleteDoc(doc(own, `users/${W2}/workouts/signed`)));
  // Someone else's token, or none, cannot create a signed-in workout for a wallet.
  await assertFails(addDoc(collection(signedIn(W3), `users/${W2}/workouts`), good()));
  await assertFails(addDoc(collection(signedOut(), `users/${W1}/workouts`), { ...good(), uid: W1 }));
  // Signed-out access to an unlinked wallet's workouts stays as before, but cannot mark or touch signed ones.
  const out = signedOut();
  await assertSucceeds(updateDoc(doc(out, `users/${W1}/workouts/legacy`), { reps: 12 }));
  await assertFails(updateDoc(doc(out, `users/${W1}/workouts/legacy`), { uid: W1 }));
  await assertFails(updateDoc(doc(out, `users/${W1}/workouts/signed`), { rawReps: 300 }));
  await assertFails(deleteDoc(doc(out, `users/${W1}/workouts/signed`)));
});

test("test cohorts are visible to testers only", async () => {
  const out = signedOut();
  await assertSucceeds(getDoc(doc(out, "cohorts/0-20261004")));
  await assertSucceeds(getDocs(query(collection(out, "cohorts"), where("isTest", "==", false))));
  await assertFails(getDoc(doc(out, "cohorts/0-1")));
  await assertFails(getDoc(doc(signedIn(W3), "cohorts/0-1")));
  await assertFails(getDocs(query(collection(signedIn(W3), "cohorts"), where("isTest", "==", true))));
  await assertSucceeds(getDoc(doc(signedIn(TESTER), "cohorts/0-1")));
  await assertSucceeds(getDocs(query(collection(signedIn(TESTER), "cohorts"), where("isTest", "==", true))));
  await assertSucceeds(getDoc(doc(out, "config/testers")));
});
