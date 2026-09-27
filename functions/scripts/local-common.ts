// Shared by local-chain.ts and e2e-local.ts: constants and throwaway-key helpers for the local
// validator rehearsal. Keys live in a directory outside the repository and are never printed.
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

export const RPC = "http://127.0.0.1:8899";
export const TEST_COHORT = { kind: 0, id: 3 };
export const DAY_SECONDS = 10;
export const COMMON = 139_000_000n; // 0.00139 ORE
export const DEPOSIT = 1_000_000n; // 1 SKR
export const ROLES = ["deployer", "admin", "cohortCreator", "attester", "crank", "feeWallet", "mintAuthority", "funder", "user1", "user2"] as const;
export type Role = (typeof ROLES)[number];

export interface State {
  keys: Record<Role, string>; // public keys
  boardRound: string;
  targetRound: string;
  winningSquare: number;
  cohortStart?: number;
}

export const keyPath = (dir: string, role: Role) => path.join(dir, "keys", `${role}.json`);
export const loadKey = (dir: string, role: Role) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath(dir, role), "utf8"))));
export const loadState = (dir: string): State => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
export const saveState = (dir: string, s: State) => fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(s, null, 2));

