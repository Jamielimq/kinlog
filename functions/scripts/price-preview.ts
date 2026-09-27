// Reads both price sources with the API keys in ~/.config/kinlog and prints the Common amount the daily
// job would use. The keys are read from files and never printed. Read-only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commonFromPrices, decideCommon, readCoinGecko, readJupiter } from "../src/daily/price.ts";

const keyFile = (name: string) => fs.readFileSync(path.join(os.homedir(), ".config/kinlog", name), "utf8");

async function main() {
  const reads = await Promise.all([
    readJupiter(keyFile("jupiter-api-key")).catch((e: Error) => e),
    readCoinGecko(keyFile("coingecko-api-key")).catch((e: Error) => e),
  ]);
  for (const r of reads) {
    if (r instanceof Error) console.log(`read failed: ${r.message}`);
    else console.log(`${r.source}: SOL $${r.sol}  ORE $${r.ore}  -> Common ${Number(commonFromPrices(r.sol, r.ore)) / 1e11} ORE`);
  }
  const d = decideCommon(reads, null, null);
  console.log(`decision: ${d.source}${d.reason ? ` (${d.reason})` : ""}; Common ${d.common === null ? "none" : `${Number(d.common) / 1e11} ORE (${d.common} raw)`}`);
  if (d.common !== null) console.log(`Legendary ${(Number(d.common) * 20) / 1e11} ORE (limit 0.1); reserve per cohort ${(Number(d.common) * 52) / 1e11} ORE`);
}
main().catch((e: Error) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
