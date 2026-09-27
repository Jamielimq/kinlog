import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as P from "../../src/chain/program.ts";

test("account discriminators match the IDL", () => {
  assert.deepEqual([...P.COHORT_DISCRIMINATOR], [137, 17, 213, 61, 105, 64, 144, 169]);
  assert.deepEqual([...P.CONFIG_DISCRIMINATOR], [155, 12, 170, 224, 30, 250, 204, 130]);
});

test("error codes match the IDL", () => {
  assert.equal(P.errorName(6000), "Unauthorized");
  assert.equal(P.errorName(6029), "RoundNotRevealed");
  assert.equal(P.errorName(6031), "RoundNeedsRetarget");
  assert.equal(P.errorName(6036), "Overflow");
  assert.equal(P.errorName(6037), undefined);
  assert.equal(P.ERROR_NAMES.length, 37);
});

test("decodeConfig reads the Borsh layout", () => {
  const keys = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
  const b = Buffer.alloc(212);
  P.CONFIG_DISCRIMINATOR.copy(b, 0);
  keys.forEach((k, i) => k.toBuffer().copy(b, 8 + 32 * i));
  let o = 168;
  for (const v of [1_000_000n, 100_000_000n, 10_000_000_000n, 8_528_000_000n]) {
    b.writeBigUInt64LE(v, o);
    o += 8;
  }
  b.writeUInt32LE(86_400, o);
  b.set([30, 4, 3, 1, 0, 1], o + 4);
  const c = P.decodeConfig(b);
  assert.ok(c.admin.equals(keys[0]) && c.cohortCreator.equals(keys[1]) && c.attester.equals(keys[2]) && c.crank.equals(keys[3]) && c.feeWallet.equals(keys[4]));
  assert.equal(c.feeLamports, 1_000_000n);
  assert.equal(c.maxRewardPerBox, 10_000_000_000n);
  assert.equal(c.reservedTotal, 8_528_000_000n);
  assert.equal(c.minDaySeconds, 86_400);
  assert.equal(c.maxCapacity, 30);
  assert.deepEqual(c.maxLiveCohorts, [4, 3]);
  assert.deepEqual(c.liveCohorts, [1, 0]);
  assert.equal(c.depositsPaused, true);
});

test("worst-case reservation is 52 x Common for 30 seats", () => {
  assert.equal(P.worstCaseReward(164_000_000n, 30), 52n * 164_000_000n);
  assert.equal(P.worstCaseReward(1_000_000n, 1), 20n * 1_000_000n);
  assert.equal(P.worstCaseReward(1_000_000n, 3), 20n * 1_000_000n + 2n * 2n * 1_000_000n);
});

test("token amount reads only 165-byte token accounts", () => {
  const d = Buffer.alloc(165);
  d.writeBigUInt64LE(123n, 64);
  assert.equal(P.tokenAmount({ data: d }), 123n);
  assert.equal(P.tokenAmount({ data: Buffer.alloc(82) }), null);
  assert.equal(P.tokenAmount(null), null);
});

test("PDAs are stable", () => {
  assert.equal(P.configPda().toBase58(), "4N8eLriNHi4ytGtLQZRHcg6iq2VnwxaZ1JeCAJWCGCNm");
  assert.equal(P.rewardVaultPda().toBase58(), "J4v1U7A92ji7qyfWhkadV5g9QufnkPpXpMjm85uKY31S");
  assert.ok(P.cohortPda(0, 20261004) instanceof PublicKey);
});
