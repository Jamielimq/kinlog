// Runs a TypeScript script through the same esbuild bundle settings as the functions, so it shares
// functions/node_modules (one @solana/web3.js). Usage: npm run script -- scripts/<name>.ts [args]
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error("usage: node tools/run.mjs <file.ts> [args]");
const outfile = path.join(".tmp", path.basename(entry).replace(/\.ts$/, ".js"));
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  packages: "external",
  sourcemap: true,
  logLevel: "warning",
  tsconfigRaw: "{}",
});
const r = spawnSync(process.execPath, ["--enable-source-maps", outfile, ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
