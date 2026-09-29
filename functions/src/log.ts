// Structured logging. Secret values registered here (RPC URL, API keys) are replaced before anything
// is written, and API-key-shaped substrings are masked as a second line of defence.
import * as logger from "firebase-functions/logger";
import type { Firestore } from "firebase-admin/firestore";

const secretValues = new Set<string>();
export function redactValue(v: string | undefined) {
  if (v && v.trim().length >= 8) secretValues.add(v.trim());
}

export function redact(s: string): string {
  let out = s;
  for (const v of secretValues) out = out.split(v).join("[redacted]");
  return out
    .replace(/(api[-_]?key=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/(\/v2\/)[A-Za-z0-9_-]{16,}/g, "$1[redacted]");
}

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
function clean(fields: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(redact(JSON.stringify(fields, replacer)));
}
export const errText = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

export const log = {
  info: (msg: string, fields: Record<string, unknown> = {}) => logger.info(redact(msg), clean(fields)),
  warn: (msg: string, fields: Record<string, unknown> = {}) => logger.warn(redact(msg), clean(fields)),
  error: (msg: string, fields: Record<string, unknown> = {}) => logger.error(redact(msg), clean(fields)),
};

export type AlertKind =
  | "reward_vault_low"
  | "server_sol_low"
  | "cohort_create_failed"
  | "pick_stuck"
  | "success_rate_high"
  | "job_error"
  | "rpc_misconfigured"
  | "test";

const ALERT_EVERY_MS = 60 * 60_000;

/**
 * Writes one `{"alert": kind}` log line (a log-based alert policy turns it into an email), at most
 * once per hour for the same kind and key. Returns whether the line was written.
 */
export async function alert(db: Firestore, kind: AlertKind, key: string, fields: Record<string, unknown>, nowMs = Date.now()): Promise<boolean> {
  const ref = db.doc("ops/alerts");
  const field = `${kind}:${key}`.replace(/[.~*/[\]]/g, "_");
  const sent = await db.runTransaction(async (tx) => {
    const last = (await tx.get(ref)).get(field) as number | undefined;
    if (last !== undefined && nowMs - last < ALERT_EVERY_MS) return false;
    tx.set(ref, { [field]: nowMs }, { merge: true });
    return true;
  });
  // One structured entry (no stack trace in the message); the alert policy matches jsonPayload.alert.
  if (sent) logger.write({ severity: "ERROR", message: `ALERT ${kind}`, ...clean({ alert: kind, key, ...fields }) });
  return sent;
}
