// Bundles the functions (and, with --tests, the test files) with esbuild. The shared program code in
// ../onchain/scripts/lib.ts is inlined; every npm package stays external and resolves from
// functions/node_modules at run time, so there is one copy of @solana/web3.js.
import { build } from "esbuild";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  packages: "external",
  sourcemap: true,
  logLevel: "warning",
  // Not functions/tsconfig.json: its `paths` exist for tsc only and would make esbuild inline web3.js.
  tsconfigRaw: "{}",
};

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

if (process.argv.includes("--tests")) {
  const entryPoints = walk("test").filter((f) => f.endsWith(".test.ts"));
  await build({ ...common, entryPoints, outdir: ".test-build", outbase: "test" });
} else {
  await build({ ...common, entryPoints: ["src/index.ts"], outfile: "lib/index.js" });
}
