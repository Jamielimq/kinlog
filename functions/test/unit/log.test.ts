import assert from "node:assert/strict";
import { test } from "node:test";
import { keypairFromSecret } from "../../src/chain/keys.ts";
import { redact, redactValue } from "../../src/log.ts";

test("registered secrets and API-key-shaped strings never reach the logs", () => {
  redactValue("https://solana-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwx");
  assert.equal(redact("failed: https://solana-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwx timeout"), "failed: [redacted] timeout");
  assert.equal(redact("GET https://mainnet.helius-rpc.com/?api-key=1234-5678-90ab&x=1"), "GET https://mainnet.helius-rpc.com/?api-key=[redacted]&x=1");
  assert.equal(redact("https://other.example/v2/ZYXWVUTSRQPONMLKJIHG"), "https://other.example/v2/[redacted]");
});

test("keypair parsing errors never include the value", () => {
  for (const bad of ["not json {secret-ish}", "[1,2,3]", JSON.stringify(new Array(64).fill(300))]) {
    assert.throws(() => keypairFromSecret(bad, "ATTESTER_KEY"), (e: Error) => !e.message.includes(bad.slice(0, 8)) && e.message.startsWith("ATTESTER_KEY"));
  }
  assert.throws(() => keypairFromSecret("", "CRANK_KEY"), /CRANK_KEY is not set/);
});
