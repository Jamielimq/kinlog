import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

// Tests run from functions/ (npm test), so fixtures resolve from the working directory.
export const FIXTURE_DIR = path.resolve("../onchain/programs/locked_in/tests/fixtures");

export interface Fixture {
  address: string;
  owner: string;
  data_base64: string;
  round_id?: number;
  expected?: { winning_square: number; motherlode_hit: boolean };
  expected_source?: { event_rng: string };
}
export const fixture = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
export const accountOf = (f: Fixture) => ({ owner: new PublicKey(f.owner), data: Buffer.from(f.data_base64, "base64") });
export const roundFixtureNames = () =>
  fs.readdirSync(FIXTURE_DIR).filter((n) => /^round_\d+\.json$/.test(n)).map((n) => n.replace(/\.json$/, ""));
