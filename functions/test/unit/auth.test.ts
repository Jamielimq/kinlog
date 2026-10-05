import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { checkSignIn, signInPayload } from "../../src/auth/handlers.ts";
import { checkNonce, issueNonce } from "../../src/auth/nonce.ts";
import { buildSignInMessage, parseSignInMessage, type SignInFields, verifyEd25519 } from "../../src/auth/siws.ts";
import { signBytes } from "../support/sign.ts";

const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 8, 29, 3, 0, 0);

function signedBody(kp: Keypair, fields: Partial<SignInFields> = {}, nowMs = NOW, secret = SECRET) {
  const p = signInPayload(secret, nowMs);
  const text = buildSignInMessage({ ...p, address: kp.publicKey.toBase58(), ...fields });
  const message = Buffer.from(text, "utf8");
  return { address: kp.publicKey.toBase58(), message: message.toString("base64"), signature: signBytes(kp, message).toString("base64") };
}

test("nonce: issued nonces verify, expire and resist tampering", () => {
  const n = issueNonce(SECRET, NOW / 1000);
  assert.match(n, /^[0-9a-f]{74}$/);
  assert.deepEqual(checkNonce(SECRET, n, NOW / 1000 + 10, 300), { ok: true, issuedAt: Math.floor(NOW / 1000) });
  assert.deepEqual(checkNonce(SECRET, n, NOW / 1000 + 301, 300), { ok: false, reason: "expired" });
  assert.deepEqual(checkNonce("other-secret-value", n, NOW / 1000, 300), { ok: false, reason: "bad_tag" });
  const flipped = n.slice(0, 40) + (n[40] === "0" ? "1" : "0") + n.slice(41);
  assert.equal(checkNonce(SECRET, flipped, NOW / 1000, 300).ok, false);
  assert.deepEqual(checkNonce(SECRET, "zz", NOW / 1000, 300), { ok: false, reason: "malformed" });
});

test("SIWS text round-trips through parse (wallet-standard format)", () => {
  const f: SignInFields = {
    domain: "kinlog.app",
    address: Keypair.generate().publicKey.toBase58(),
    statement: "Sign in to Kinlog.",
    uri: "https://kinlog.app",
    version: "1",
    chainId: "mainnet",
    nonce: "abc12345",
    issuedAt: "2026-09-29T03:00:00.000Z",
    expirationTime: "2026-09-29T03:05:00.000Z",
    resources: ["https://example.com/a", "https://example.com/b"],
  };
  const text = buildSignInMessage(f);
  assert.ok(text.startsWith("kinlog.app wants you to sign in with your Solana account:\n"));
  assert.deepEqual(parseSignInMessage(text), f);
  const { statement: _s, resources: _r, ...bare } = f;
  assert.deepEqual(parseSignInMessage(buildSignInMessage(bare)), bare);
  assert.equal(parseSignInMessage("hello"), null);
  assert.equal(parseSignInMessage(`${text}\nNonce: second`), null);
});

test("ed25519 verification", () => {
  const kp = Keypair.generate();
  const msg = Buffer.from("hello");
  const sig = signBytes(kp, msg);
  assert.ok(verifyEd25519(msg, sig, kp.publicKey.toBytes()));
  assert.ok(!verifyEd25519(Buffer.from("hellp"), sig, kp.publicKey.toBytes()));
  assert.ok(!verifyEd25519(msg, sig, Keypair.generate().publicKey.toBytes()));
  assert.ok(!verifyEd25519(msg, sig.subarray(0, 63), kp.publicKey.toBytes()));
});

test("checkSignIn accepts a correct signed message", () => {
  const kp = Keypair.generate();
  const r = checkSignIn(SECRET, signedBody(kp), NOW + 20_000);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.wallet, kp.publicKey.toBase58());
  // chainId as a CAIP-style string is accepted too.
  assert.equal(checkSignIn(SECRET, signedBody(kp, { chainId: "solana:mainnet" }), NOW).ok, true);
});

test("checkSignIn refuses everything else", () => {
  const kp = Keypair.generate();
  const other = Keypair.generate();
  const cases: [string, unknown, string][] = [
    ["no body", null, "invalid_request"],
    ["bad address", { ...signedBody(kp), address: "nope" }, "invalid_request"],
    ["the old domain", signedBody(kp, { domain: "jamielimq.github.io" }), "invalid_message"],
    ["the old uri", signedBody(kp, { uri: "https://jamielimq.github.io/kinlog" }), "invalid_message"],
    ["another chain", signedBody(kp, { chainId: "devnet" }), "invalid_message"],
    ["another version", signedBody(kp, { version: "2" }), "invalid_message"],
    ["message for another wallet", { ...signedBody(other), address: kp.publicKey.toBase58() }, "invalid_message"],
    ["no nonce", signedBody(kp, { nonce: undefined }), "invalid_message"],
    ["nonce from another secret", signedBody(kp, {}, NOW, "some-other-secret-value"), "invalid_nonce"],
    ["issued in the future", signedBody(kp, { issuedAt: new Date(NOW + 5 * 60_000).toISOString() }), "nonce_expired"],
    ["expired message", signedBody(kp, { expirationTime: new Date(NOW - 1000).toISOString() }), "nonce_expired"],
    ["garbage message", { ...signedBody(kp), message: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") }, "invalid_message"],
  ];
  for (const [name, body, error] of cases) {
    const r = checkSignIn(SECRET, body, NOW);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.equal(r.error, error, name);
  }
  // Old nonce: signed correctly but more than five minutes ago.
  const late = checkSignIn(SECRET, signedBody(kp), NOW + 301_000);
  assert.equal(!late.ok && late.error, "nonce_expired");
  // Tampered signature.
  const body = signedBody(kp);
  const sig = Buffer.from(body.signature, "base64");
  sig[0] ^= 1;
  const bad = checkSignIn(SECRET, { ...body, signature: sig.toString("base64") }, NOW);
  assert.equal(!bad.ok && bad.error, "invalid_signature");
});
