// authNonce / authVerify logic. The app asks for a sign-in payload, the wallet signs the SIWS text
// built from it (or the app builds the same text and signs it with signMessages), and a valid
// signature gets a Firebase custom token whose uid is the wallet address.
import { PublicKey } from "@solana/web3.js";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { NONCE_TTL_SECONDS, SIWS_CHAIN_ID, SIWS_DOMAIN, SIWS_STATEMENT, SIWS_URI, SIWS_VERSION } from "../env.ts";
import { checkNonce, issueNonce } from "./nonce.ts";
import { parseSignInMessage, verifyEd25519 } from "./siws.ts";

export function signInPayload(secret: string, nowMs: number) {
  const nowSec = Math.floor(nowMs / 1000);
  return {
    domain: SIWS_DOMAIN,
    statement: SIWS_STATEMENT,
    uri: SIWS_URI,
    version: SIWS_VERSION,
    chainId: SIWS_CHAIN_ID,
    nonce: issueNonce(secret, nowSec),
    issuedAt: new Date(nowSec * 1000).toISOString(),
    expirationTime: new Date((nowSec + NONCE_TTL_SECONDS) * 1000).toISOString(),
  };
}

export type SignInCheck = { ok: true; wallet: string; nonce: string } | { ok: false; status: number; error: string };
const reject = (status: number, error: string): SignInCheck => ({ ok: false, status, error });

/** Validates a signed sign-in message without touching the database. */
export function checkSignIn(secret: string, body: unknown, nowMs: number): SignInCheck {
  const b = body as { address?: unknown; message?: unknown; signature?: unknown } | null;
  if (!b || typeof b.address !== "string" || typeof b.message !== "string" || typeof b.signature !== "string") {
    return reject(400, "invalid_request");
  }
  let key: PublicKey;
  try {
    key = new PublicKey(b.address);
  } catch {
    return reject(400, "invalid_request");
  }
  if (key.toBase58() !== b.address) return reject(400, "invalid_request");
  const bytes = Buffer.from(b.message, "base64");
  const text = bytes.toString("utf8");
  if (!bytes.length || !Buffer.from(text, "utf8").equals(bytes)) return reject(400, "invalid_message");
  const f = parseSignInMessage(text);
  if (!f) return reject(400, "invalid_message");
  if (f.domain !== SIWS_DOMAIN || f.address !== b.address || f.uri !== SIWS_URI) return reject(401, "invalid_message");
  if (f.version !== undefined && f.version !== SIWS_VERSION) return reject(401, "invalid_message");
  if (f.chainId !== undefined && f.chainId !== SIWS_CHAIN_ID && f.chainId !== `solana:${SIWS_CHAIN_ID}`) return reject(401, "invalid_message");
  if (!f.nonce || !f.issuedAt) return reject(401, "invalid_message");

  const nowSec = nowMs / 1000;
  const nonce = checkNonce(secret, f.nonce, nowSec, NONCE_TTL_SECONDS);
  if (!nonce.ok) return reject(401, nonce.reason === "expired" ? "nonce_expired" : "invalid_nonce");
  const issued = Date.parse(f.issuedAt) / 1000;
  if (!Number.isFinite(issued) || issued > nowSec + 60 || issued < nowSec - NONCE_TTL_SECONDS) return reject(401, "nonce_expired");
  if (f.expirationTime !== undefined && !(Date.parse(f.expirationTime) / 1000 > nowSec)) return reject(401, "nonce_expired");
  if (f.notBefore !== undefined && !(Date.parse(f.notBefore) / 1000 <= nowSec + 60)) return reject(401, "invalid_message");

  if (!verifyEd25519(bytes, Buffer.from(b.signature, "base64"), key.toBytes())) return reject(401, "invalid_signature");
  return { ok: true, wallet: b.address, nonce: f.nonce };
}

const ALREADY_EXISTS = 6;
const isAlreadyExists = (e: unknown) => (e as { code?: unknown })?.code === ALREADY_EXISTS;

export interface TokenIssuer {
  createCustomToken(uid: string): Promise<string>;
}

/** Spends the nonce (a second use is refused), issues the token and records the wallet's first sign-in. */
export async function completeSignIn(
  db: Firestore,
  auth: TokenIssuer,
  ok: { wallet: string; nonce: string },
  nowMs: number,
): Promise<{ status: number; body: Record<string, string> }> {
  try {
    await db.doc(`authNonces/${ok.nonce}`).create({ wallet: ok.wallet, usedAt: nowMs, expiresAt: nowMs + NONCE_TTL_SECONDS * 1000 });
  } catch (e) {
    if (isAlreadyExists(e)) return { status: 409, body: { error: "nonce_used" } };
    throw e;
  }
  const token = await auth.createCustomToken(ok.wallet);
  const link = db.doc(`authLinks/${ok.wallet}`);
  try {
    await link.create({ linkedAt: FieldValue.serverTimestamp(), lastSignInAt: FieldValue.serverTimestamp() });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    await link.set({ lastSignInAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return { status: 200, body: { token } };
}
