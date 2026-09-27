// Cloud Functions entry points. Logic lives in the modules; this file only wires triggers, secrets
// and limits. Every function runs in asia-northeast3 with automatic retries off.
import { Connection } from "@solana/web3.js";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { completeSignIn, checkSignIn, signInPayload } from "./auth/handlers.ts";
import { keypairFromSecret } from "./chain/keys.ts";
import { SolanaChain, type ServerKeys } from "./chain/solana.ts";
import { runEveryMinute } from "./crank/everyMinute.ts";
import { runDaily } from "./daily/daily.ts";
import { readCoinGecko, readJupiter } from "./daily/price.ts";
import { PUBLIC_RPC, REGION, secrets } from "./env.ts";
import { alert, errText, log, redactValue } from "./log.ts";
import { onWorkoutCreated } from "./workout/attest.ts";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: REGION, memory: "256MiB" });

type Role = keyof ServerKeys;
const SECRET_FOR: Record<Role, { value(): string }> = {
  cohortCreator: secrets.cohortCreatorKey,
  attester: secrets.attesterKey,
  crank: secrets.crankKey,
};
const SECRET_NAME: Record<Role, string> = { cohortCreator: "COHORT_CREATOR_KEY", attester: "ATTESTER_KEY", crank: "CRANK_KEY" };

/** One chain per instance and role set. Only the keys a function is bound to are ever read. */
const chains = new Map<string, SolanaChain>();
function chainFor(roles: Role[]): SolanaChain {
  const id = roles.join(",");
  let chain = chains.get(id);
  if (!chain) {
    const url = secrets.serverRpcUrl.value().trim();
    redactValue(url);
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);
    const keys: ServerKeys = {};
    for (const r of roles) keys[r] = keypairFromSecret(SECRET_FOR[r].value(), SECRET_NAME[r]);
    chain = new SolanaChain(new Connection(url, "confirmed"), local || url === PUBLIC_RPC ? null : new Connection(PUBLIC_RPC, "confirmed"), keys);
    chains.set(id, chain);
  }
  return chain;
}

function prices() {
  const jup = secrets.jupiterApiKey.value();
  const cg = secrets.coingeckoApiKey.value();
  redactValue(jup);
  redactValue(cg);
  return Promise.all([readJupiter(jup).catch((e: Error) => e), readCoinGecko(cg).catch((e: Error) => e)]);
}

export const authNonce = onRequest({ maxInstances: 3, concurrency: 40, timeoutSeconds: 10, secrets: [secrets.authNonceSecret] }, (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  res.set("Cache-Control", "no-store").json(signInPayload(secrets.authNonceSecret.value(), Date.now()));
});

export const authVerify = onRequest({ maxInstances: 3, concurrency: 40, timeoutSeconds: 30, secrets: [secrets.authNonceSecret] }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const now = Date.now();
  const check = checkSignIn(secrets.authNonceSecret.value(), req.body, now);
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }
  try {
    const out = await completeSignIn(db, getAuth(), check, now);
    res.status(out.status).json(out.body);
  } catch (e) {
    log.error("authVerify failed", { error: errText(e) });
    res.status(500).json({ error: "internal" });
  }
});

export const onWorkoutCreate = onDocumentCreated(
  { document: "users/{wallet}/workouts/{workoutId}", maxInstances: 5, timeoutSeconds: 120, retry: false, secrets: [secrets.attesterKey, secrets.serverRpcUrl] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    if (typeof data.uid !== "string") {
      // 1.3.3 and other signed-out writes: counted in logs to track the migration, never toward Locked In.
      log.info("legacy workout", { legacyWorkout: true });
      return;
    }
    try {
      await onWorkoutCreated({ db, chain: chainFor(["attester"]), nowMs: Date.now }, event.params.wallet, event.params.workoutId, data, snap.createTime.toMillis());
    } catch (e) {
      await alert(db, "job_error", "onWorkoutCreate", { error: errText(e) });
    }
  },
);

export const everyMinute = onSchedule(
  { schedule: "every 1 minutes", timeZone: "UTC", maxInstances: 1, timeoutSeconds: 120, retryCount: 0, secrets: [secrets.crankKey, secrets.attesterKey, secrets.serverRpcUrl] },
  async () => {
    try {
      const sum = await runEveryMinute({ db, chain: chainFor(["crank", "attester"]), nowMs: Date.now });
      if (sum.settled || sum.retargeted || sum.attested || sum.returned || sum.closed) log.info("everyMinute", { ...sum });
    } catch (e) {
      await alert(db, "job_error", "everyMinute", { error: errText(e) });
    }
  },
);

export const daily = onSchedule(
  {
    schedule: "5 15 * * *",
    timeZone: "UTC",
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [secrets.cohortCreatorKey, secrets.serverRpcUrl, secrets.jupiterApiKey, secrets.coingeckoApiKey],
  },
  async () => {
    try {
      const sum = await runDaily({ db, chain: chainFor(["cohortCreator"]), nowMs: Date.now, prices });
      log.info("daily", { plans: sum.plans.length });
    } catch (e) {
      await alert(db, "job_error", "daily", { error: errText(e) });
    }
  },
);

/**
 * Emulator only: runs a scheduled job on request (the emulator does not run schedules). Not exported
 * outside the emulator, and refuses to run unless the project is a demo- project.
 */
export const devRun =
  process.env.FUNCTIONS_EMULATOR === "true"
    ? onRequest(
        { secrets: [secrets.crankKey, secrets.attesterKey, secrets.cohortCreatorKey, secrets.serverRpcUrl, secrets.jupiterApiKey, secrets.coingeckoApiKey] },
        async (req, res) => {
          if (!(process.env.GCLOUD_PROJECT ?? "").startsWith("demo-")) {
            res.status(403).json({ error: "emulator demo project only" });
            return;
          }
          const nowMs = req.query.nowMs ? Number(req.query.nowMs) : Date.now();
          if (req.query.job === "everyMinute") {
            res.json(await runEveryMinute({ db, chain: chainFor(["crank", "attester"]), nowMs: () => nowMs }));
          } else if (req.query.job === "daily") {
            res.json(await runDaily({ db, chain: chainFor(["cohortCreator"]), nowMs: () => nowMs, prices }));
          } else {
            res.status(400).json({ error: "job must be everyMinute or daily" });
          }
        },
      )
    : undefined;
