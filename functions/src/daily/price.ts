// Common amount rule (docs/LOCKED_IN.md section 2): the USD value of the 0.001 SOL Fee in ORE, computed
// from each price source separately, the larger taken, rounded up to 0.00001 ORE. Both sources are
// queried by mint address with an API key; a rejected key or a missing token is a failed read.
import { ORE_MINT } from "../chain/program.ts";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const ORE = ORE_MINT.toBase58();
const MAX_DISAGREEMENT = 0.05;

export interface PriceRead {
  source: "jupiter" | "coingecko";
  sol: number;
  ore: number;
}
export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export async function readJupiter(apiKey: string, fetchFn: Fetch = fetch): Promise<PriceRead> {
  const res = await fetchFn(`https://api.jup.ag/price/v3?ids=${SOL_MINT},${ORE}`, { headers: { "x-api-key": apiKey.trim() } });
  if (!res.ok) throw new Error(`jupiter HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { usdPrice?: unknown } | undefined>;
  const sol = positive(body?.[SOL_MINT]?.usdPrice);
  const ore = positive(body?.[ORE]?.usdPrice);
  if (sol === null || ore === null) throw new Error(`jupiter response is missing ${sol === null ? "SOL" : "ORE"}`);
  return { source: "jupiter", sol, ore };
}

export async function readCoinGecko(apiKey: string, fetchFn: Fetch = fetch): Promise<PriceRead> {
  const path = `/api/v3/simple/token_price/solana?contract_addresses=${SOL_MINT},${ORE}&vs_currencies=usd`;
  // A demo key works on the public host; a paid key needs the pro host.
  let res = await fetchFn(`https://api.coingecko.com${path}`, { headers: { "x-cg-demo-api-key": apiKey.trim() } });
  if (!res.ok && res.status >= 400 && res.status < 500) {
    res = await fetchFn(`https://pro-api.coingecko.com${path}`, { headers: { "x-cg-pro-api-key": apiKey.trim() } });
  }
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { usd?: unknown } | undefined>;
  const find = (mint: string) => Object.entries(body ?? {}).find(([k]) => k.toLowerCase() === mint.toLowerCase())?.[1]?.usd;
  const sol = positive(find(SOL_MINT));
  const ore = positive(find(ORE));
  if (sol === null || ore === null) throw new Error(`coingecko response is missing ${sol === null ? "SOL" : "ORE"}`);
  return { source: "coingecko", sol, ore };
}

/** 0.001 SOL in USD converted to ORE, in raw units (1 ORE = 1e11), rounded up to 0.00001 ORE. */
export function commonFromPrices(sol: number, ore: number): bigint {
  const units = Math.ceil((100 * sol) / ore - 1e-9); // 0.00001-ORE units: 0.001 * sol / ore * 1e5
  return BigInt(units) * 1_000_000n;
}

export interface CommonDecision {
  common: bigint | null;
  source: "prices" | "previous" | "fallback" | "none";
  reason?: string;
  perSource: { source: string; sol?: number; ore?: number; common?: string; error?: string }[];
}

export function decideCommon(reads: (PriceRead | Error)[], previous: bigint | null, fallback: bigint | null): CommonDecision {
  const perSource = reads.map((r) =>
    r instanceof Error ? { source: "?", error: r.message } : { source: r.source, sol: r.sol, ore: r.ore, common: commonFromPrices(r.sol, r.ore).toString() },
  );
  const ok = reads.filter((r): r is PriceRead => !(r instanceof Error));
  let reason: string;
  if (ok.length === 2) {
    const v = ok.map((r) => (0.001 * r.sol) / r.ore);
    const gap = Math.abs(v[0] - v[1]) / Math.min(v[0], v[1]);
    if (gap <= MAX_DISAGREEMENT) {
      const [a, b] = ok.map((r) => commonFromPrices(r.sol, r.ore));
      return { common: a > b ? a : b, source: "prices", perSource };
    }
    reason = `sources disagree by ${(gap * 100).toFixed(2)}%`;
  } else {
    reason = `price read failed: ${reads.filter((r) => r instanceof Error).map((e) => (e as Error).message).join("; ")}`;
  }
  if (previous !== null) return { common: previous, source: "previous", reason, perSource };
  if (fallback !== null) return { common: fallback, source: "fallback", reason, perSource };
  return { common: null, source: "none", reason, perSource };
}
