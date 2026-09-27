// Owner-controlled switches in config/ops (written in the Firebase console). A missing document or
// field means off: deploying the functions alone never sends a mainnet transaction.
import type { Firestore } from "firebase-admin/firestore";

export type CreateMode = "off" | "dryRun" | "on";
export interface Ops {
  /** When true (the default), no transaction is sent; state is still read and mirrored. */
  paused: boolean;
  /** Automatic cohort creation per kind: [3-Day, 7-Day]. */
  create: [CreateMode, CreateMode];
  /** KST date (YYYY-MM-DD); no cohort starting before it is created. */
  createFrom: string | null;
  /** Raw ORE Common amount used when both price reads fail and no earlier cohort exists. */
  fallbackCommon: bigint | null;
  testAlert: boolean;
}

const mode = (v: unknown): CreateMode => (v === "on" || v === "dryRun" ? v : "off");

export function parseOps(d: Record<string, unknown> | undefined): Ops {
  const fb = d?.fallbackCommon;
  return {
    paused: d?.paused !== false,
    create: [mode(d?.create3Day), mode(d?.create7Day)],
    createFrom: typeof d?.createFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.createFrom) ? d.createFrom : null,
    fallbackCommon: (typeof fb === "string" || typeof fb === "number") && /^\d+$/.test(String(fb)) ? BigInt(fb) : null,
    testAlert: d?.testAlert === true,
  };
}

export async function readOps(db: Firestore): Promise<Ops> {
  return parseOps((await db.doc("config/ops").get()).data());
}
