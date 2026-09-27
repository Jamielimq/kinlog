// Daily at 15:05 UTC: create the next scheduled cohort of each enabled kind, check server wallet and
// reward vault balances, check the recent success rate, and drop spent sign-in nonces.
import type { Firestore } from "firebase-admin/firestore";
import * as P from "../chain/program.ts";
import { ChainTxError, keyOf } from "../chain/types.ts";
import { type LiveCohort, mirrorFields, refreshCohorts } from "../cohorts.ts";
import { THRESHOLDS } from "../env.ts";
import { alert, errText, log } from "../log.ts";
import { type Ops, readOps } from "../ops.ts";
import type { Deps } from "../workout/attest.ts";
import { decideCommon, type PriceRead } from "./price.ts";
import { nextScheduledStart } from "./schedule.ts";

export interface DailyDeps extends Deps {
  prices: () => Promise<(PriceRead | Error)[]>;
}

/** 100 SKR (6 decimals). */
export const DEPOSIT_AMOUNT = 100_000_000n;
const KIND_NAMES = ["3-Day", "7-Day"];
const sol = (lamports: bigint) => Number(lamports) / 1e9;
const ore = (raw: bigint) => Number(raw) / 1e11;

export interface CreationPlan {
  kind: number;
  id: number;
  startTs: number;
  endTs: number;
  daySeconds: number;
  depositAmount: string;
  commonAmount: string;
  commonOre: number;
  legendaryOre: number;
  reserveOre: number;
  commonSource: string;
  perSource: unknown;
}

async function previousCommon(db: Firestore): Promise<bigint | null> {
  const docs = (await db.collection("cohorts").orderBy("startTs", "desc").limit(20).get()).docs.map((d) => d.data());
  const last = docs.find((m) => m.isTest === false && typeof m.commonAmount === "string");
  return last ? BigInt(last.commonAmount as string) : null;
}

async function createNext(deps: DailyDeps, ops: Ops, kind: number, live: LiveCohort[], nowSec: number): Promise<CreationPlan | null> {
  const { db, chain } = deps;
  const scheduled = live.some((l) => l.key.kind === kind && l.c.daySeconds === P.SECONDS_PER_DAY && Number(l.c.startTs) > nowSec);
  if (scheduled) return null;
  const next = nextScheduledStart(kind, nowSec, ops.createFrom);
  if (!next) return null;
  const fail = (reason: string, extra: Record<string, unknown> = {}) =>
    alert(db, "cohort_create_failed", `${kind}-${next.id}:${reason}`, { kind: KIND_NAMES[kind], id: next.id, reason, ...extra });

  const cfg = await chain.getConfig();
  const decision = decideCommon(await deps.prices(), await previousCommon(db), ops.fallbackCommon);
  if (decision.source !== "prices") await fail("price_fallback", { detail: decision.reason, used: decision.source, perSource: decision.perSource });
  if (decision.common === null) return null;
  const common = decision.common;
  if (common * P.LEGENDARY_MULTIPLIER > cfg.maxRewardPerBox) {
    await fail("legendary_above_max", { commonOre: ore(common), maxRewardPerBoxOre: ore(cfg.maxRewardPerBox) });
    return null;
  }
  const reserve = P.worstCaseReward(common, cfg.maxCapacity);
  const unreserved = (await chain.getRewardVaultAmount()) - cfg.reservedTotal;
  if (unreserved < reserve) {
    await fail("reward_vault_short", { reserveOre: ore(reserve), unreservedOre: ore(unreserved) });
    return null;
  }
  if (cfg.liveCohorts[kind] >= cfg.maxLiveCohorts[kind]) {
    await fail("too_many_live_cohorts", { live: cfg.liveCohorts[kind], max: cfg.maxLiveCohorts[kind] });
    return null;
  }
  const days = P.DAYS_FOR_KIND[kind];
  const plan: CreationPlan = {
    kind,
    id: next.id,
    startTs: next.startTs,
    endTs: next.startTs + days * next.daySeconds,
    daySeconds: next.daySeconds,
    depositAmount: DEPOSIT_AMOUNT.toString(),
    commonAmount: common.toString(),
    commonOre: ore(common),
    legendaryOre: ore(common * P.LEGENDARY_MULTIPLIER),
    reserveOre: ore(reserve),
    commonSource: decision.source,
    perSource: decision.perSource,
  };
  if (ops.create[kind] === "dryRun") {
    log.info("cohort creation dry run", { plan });
    return plan;
  }
  if (ops.paused) {
    log.info("cohort creation skipped: paused", { plan });
    return null;
  }
  const key = { kind, id: next.id };
  try {
    const sig = await chain.createCohort(key, BigInt(next.startTs), next.daySeconds, DEPOSIT_AMOUNT, common);
    log.info("cohort created", { plan, sig });
  } catch (e) {
    if (e instanceof ChainTxError && e.insufficientFunds) {
      await alert(db, "server_sol_low", "cohortCreator", { wallet: "Cohort-Creator", error: errText(e) });
    }
    await fail("create_failed", { error: errText(e) });
    return null;
  }
  const created = (await chain.getCohorts([key]))[0];
  if (created) await db.doc(`cohorts/${keyOf(key)}`).set(mirrorFields(key, created, nowSec), { merge: true });
  return plan;
}

async function checkBalances(deps: DailyDeps, nowMs: number) {
  const { db, chain } = deps;
  const cfg = await chain.getConfig();
  const roles = [
    { role: "cohortCreator", name: "Cohort-Creator", address: cfg.cohortCreator },
    { role: "crank", name: "Crank", address: cfg.crank },
    { role: "attester", name: "Attester", address: cfg.attester },
  ] as const;
  const lamports = await chain.getLamports(roles.map((r) => r.address));
  const vault = await chain.getRewardVaultAmount();
  const unreserved = vault - cfg.reservedTotal;
  log.info("balances", {
    ...Object.fromEntries(roles.map((r, i) => [`${r.role}Sol`, sol(lamports[i])])),
    rewardVaultOre: ore(vault),
    reservedOre: ore(cfg.reservedTotal),
    unreservedOre: ore(unreserved),
  });
  for (let i = 0; i < roles.length; i++) {
    const min = THRESHOLDS.lamportsMin[roles[i].role];
    if (lamports[i] < min) {
      await alert(db, "server_sol_low", roles[i].role, {
        wallet: roles[i].name,
        address: roles[i].address.toBase58(),
        sol: sol(lamports[i]),
        thresholdSol: sol(min),
      }, nowMs);
    }
  }
  if (vault < THRESHOLDS.rewardVaultMin) {
    await alert(db, "reward_vault_low", "vault", {
      ore: ore(vault),
      reservedOre: ore(cfg.reservedTotal),
      unreservedOre: ore(unreserved),
      thresholdOre: ore(THRESHOLDS.rewardVaultMin),
    }, nowMs);
  }
}

async function checkSuccessRate(db: Firestore, nowSec: number, nowMs: number) {
  const docs = (await db.collection("cohorts").orderBy("endTs", "desc").limit(20).get()).docs.map((d) => d.data());
  const recent = docs.filter((m) => m.isTest === false && (m.endTs as number) <= nowSec && (m.participants as number) > 0).slice(0, 3);
  const participants = recent.reduce((a, m) => a + (m.participants as number), 0);
  const successes = recent.reduce((a, m) => a + ((m.successes as number) ?? 0), 0);
  if (participants >= THRESHOLDS.successRateMinParticipants && successes / participants > THRESHOLDS.successRateMax) {
    await alert(db, "success_rate_high", "recent", {
      cohorts: recent.map((m) => `${m.kind}-${m.id}`),
      participants,
      successes,
      rate: Number((successes / participants).toFixed(3)),
    }, nowMs);
  }
}

async function cleanupNonces(db: Firestore, nowMs: number) {
  const snap = await db.collection("authNonces").where("expiresAt", "<", nowMs - 3_600_000).limit(400).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

export interface DailySummary {
  plans: CreationPlan[];
}

export async function runDaily(deps: DailyDeps): Promise<DailySummary> {
  const { db, chain } = deps;
  const nowMs = deps.nowMs();
  const nowSec = Math.floor(nowMs / 1000);
  const ops = await readOps(db);
  const live = await refreshCohorts(db, chain, nowMs);
  const plans: CreationPlan[] = [];
  for (const kind of [0, 1]) {
    if (ops.create[kind] === "off") continue;
    try {
      const p = await createNext(deps, ops, kind, live, nowSec);
      if (p) plans.push(p);
    } catch (e) {
      await alert(db, "cohort_create_failed", `${kind}:error`, { kind: KIND_NAMES[kind], error: errText(e) }, nowMs);
    }
  }
  const steps: [string, () => Promise<void>][] = [
    ["balances", () => checkBalances(deps, nowMs)],
    ["successRate", () => checkSuccessRate(db, nowSec, nowMs)],
    ["nonces", () => cleanupNonces(db, nowMs)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      await alert(db, "job_error", `daily:${name}`, { error: errText(e) }, nowMs);
    }
  }
  return { plans };
}
