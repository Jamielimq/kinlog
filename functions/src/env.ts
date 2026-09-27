import { defineSecret } from "firebase-functions/params";

// Firestore is in asia-northeast3 (Seoul); Firestore triggers must run in the same region.
export const REGION = "asia-northeast3";

// Sign In With Solana. Kinlog's web address is its GitHub Pages site.
export const SIWS_DOMAIN = "jamielimq.github.io";
export const SIWS_URI = "https://jamielimq.github.io/kinlog";
export const SIWS_STATEMENT = "Sign in to Kinlog. This signature does not send a transaction.";
export const SIWS_CHAIN_ID = "mainnet";
export const SIWS_VERSION = "1";
export const NONCE_TTL_SECONDS = 300;

export const DAILY_TARGET_REPS = 30;
/** Completion points by cohort kind (3-Day, 7-Day). */
export const COMPLETION_POINTS = [300, 700] as const;
/** Badge id prefix by cohort kind; tiers append _common / _rare / _legendary. */
export const BADGE_PREFIX = ["square_3d", "square_7d"] as const;

export const THRESHOLDS = {
  rewardVaultMin: 70_000_000_000n, // 0.7 ORE
  lamportsMin: { cohortCreator: 50_000_000n, crank: 50_000_000n, attester: 10_000_000n },
  successRateMax: 0.85,
  successRateMinParticipants: 10,
  pickStuckMs: 15 * 60_000,
} as const;

/** Reads only, when the primary RPC fails. Transactions always go through SERVER_RPC_URL. */
export const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

export const secrets = {
  cohortCreatorKey: defineSecret("COHORT_CREATOR_KEY"),
  attesterKey: defineSecret("ATTESTER_KEY"),
  crankKey: defineSecret("CRANK_KEY"),
  jupiterApiKey: defineSecret("JUPITER_API_KEY"),
  coingeckoApiKey: defineSecret("COINGECKO_API_KEY"),
  authNonceSecret: defineSecret("AUTH_NONCE_SECRET"),
  serverRpcUrl: defineSecret("SERVER_RPC_URL"),
};
