// Stateless sign-in nonces: random part, issue time and an HMAC tag, all hex. Issuing one writes
// nothing, so request floods cost no database writes; a nonce is recorded only after a valid signature.
import crypto from "node:crypto";

const tag = (secret: string, body: string) => crypto.createHmac("sha256", secret.trim()).update(body).digest().subarray(0, 16);

export function issueNonce(secret: string, nowSec: number): string {
  const body = crypto.randomBytes(16).toString("hex") + Math.floor(nowSec).toString(16).padStart(10, "0");
  return body + tag(secret, body).toString("hex");
}

export type NonceCheck = { ok: true; issuedAt: number } | { ok: false; reason: "malformed" | "bad_tag" | "expired" };

export function checkNonce(secret: string, nonce: string, nowSec: number, ttlSeconds: number): NonceCheck {
  if (!/^[0-9a-f]{74}$/.test(nonce)) return { ok: false, reason: "malformed" };
  const body = nonce.slice(0, 42);
  const got = Buffer.from(nonce.slice(42), "hex");
  if (!crypto.timingSafeEqual(got, tag(secret, body))) return { ok: false, reason: "bad_tag" };
  const issuedAt = parseInt(body.slice(32), 16);
  if (nowSec - issuedAt > ttlSeconds || issuedAt - nowSec > 60) return { ok: false, reason: "expired" };
  return { ok: true, issuedAt };
}
