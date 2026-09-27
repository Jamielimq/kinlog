import assert from "node:assert/strict";
import { test } from "node:test";
import { commonFromPrices, decideCommon, type Fetch, type PriceRead, readCoinGecko, readJupiter, SOL_MINT } from "../../src/daily/price.ts";

const ORE = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });

test("Common: 0.001 SOL in ORE, rounded up to 0.00001 ORE", () => {
  assert.equal(commonFromPrices(113.72, 69.35), 164_000_000n); // documented example: 0.00164 ORE
  assert.equal(commonFromPrices(100, 100), 100_000_000n); // exact: no extra step
  assert.equal(commonFromPrices(100, 99.99), 101_000_000n);
});

test("the larger of two agreeing sources is used", () => {
  const reads: PriceRead[] = [
    { source: "jupiter", sol: 113.72, ore: 69.35 },
    { source: "coingecko", sol: 113.9, ore: 69.3 },
  ];
  const d = decideCommon(reads, null, null);
  assert.equal(d.source, "prices");
  assert.equal(d.common, commonFromPrices(113.9, 69.3));
});

test("5% disagreement boundary", () => {
  const at = (ore2: number) => decideCommon([{ source: "jupiter", sol: 100, ore: 100 }, { source: "coingecko", sol: 100, ore: ore2 }], 7_000_000n, null);
  assert.equal(at(100 / 1.05).source, "prices");
  assert.equal(at(100 / 1.051).source, "previous");
});

test("failures fall back to the previous cohort, then the configured amount, then nothing", () => {
  const failed = [new Error("jupiter HTTP 401"), { source: "coingecko", sol: 100, ore: 100 } as PriceRead];
  assert.deepEqual([decideCommon(failed, 5_000_000n, 9_000_000n).source, decideCommon(failed, 5_000_000n, 9_000_000n).common], ["previous", 5_000_000n]);
  assert.deepEqual([decideCommon(failed, null, 9_000_000n).source, decideCommon(failed, null, 9_000_000n).common], ["fallback", 9_000_000n]);
  assert.deepEqual([decideCommon(failed, null, null).source, decideCommon(failed, null, null).common], ["none", null]);
});

test("Jupiter: by mint address with the key header; a missing token is a failed read", async () => {
  let seen: { url: string; headers?: Record<string, string> } | null = null;
  const ok: Fetch = async (url, init) => {
    seen = { url, headers: init?.headers };
    return reply(200, { [SOL_MINT]: { usdPrice: 113.72 }, [ORE]: { usdPrice: 69.35 } });
  };
  assert.deepEqual(await readJupiter("k1 \n", ok), { source: "jupiter", sol: 113.72, ore: 69.35 });
  assert.ok(seen!.url.includes(SOL_MINT) && seen!.url.includes(ORE));
  assert.equal(seen!.headers!["x-api-key"], "k1");
  await assert.rejects(readJupiter("k", async () => reply(200, { [SOL_MINT]: { usdPrice: 113.72 } })), /missing ORE/);
  await assert.rejects(readJupiter("k", async () => reply(401, {})), /HTTP 401/);
});

test("CoinGecko: demo host first, pro host when the key is a paid one", async () => {
  const calls: string[] = [];
  const f: Fetch = async (url) => {
    calls.push(new URL(url).host);
    return url.includes("pro-api") ? reply(200, { [SOL_MINT.toLowerCase()]: { usd: 113.72 }, [ORE]: { usd: 69.35 } }) : reply(400, {});
  };
  assert.deepEqual(await readCoinGecko("k", f), { source: "coingecko", sol: 113.72, ore: 69.35 });
  assert.deepEqual(calls, ["api.coingecko.com", "pro-api.coingecko.com"]);
});
