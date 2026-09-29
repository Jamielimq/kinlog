// SolanaChain's primary-RPC checks with stand-in connections (no network).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Connection, Keypair, type PublicKey } from "@solana/web3.js";
import * as P from "../../src/chain/program.ts";
import { type RpcEvent, SolanaChain } from "../../src/chain/solana.ts";
import { ChainTxError } from "../../src/chain/types.ts";

const MAINNET = P.GENESIS.mainnet;
const DEVNET = P.GENESIS.devnet;
const K = { kind: 0, id: 1 };

/** Counts calls; can serve another genesis, fail the genesis check n times, or fail every read. */
function fakeConn(o: { genesis?: string; genesisFailures?: number; failReads?: boolean } = {}) {
  const calls = { genesis: 0, reads: 0, sends: 0 };
  let failures = o.genesisFailures ?? 0;
  const conn = {
    async getGenesisHash() {
      calls.genesis++;
      if (failures > 0) {
        failures--;
        throw new Error("fetch failed");
      }
      return o.genesis ?? MAINNET;
    },
    async getAccountInfo() {
      calls.reads++;
      if (o.failReads) throw new Error("401 Unauthorized");
      return null;
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      calls.reads++;
      if (o.failReads) throw new Error("401 Unauthorized");
      return keys.map(() => null);
    },
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };
    },
    async simulateTransaction() {
      return { value: { err: null, logs: [] } };
    },
    async sendRawTransaction() {
      calls.sends++;
      return "sig";
    },
    async getSignatureStatuses() {
      return { value: [{ confirmationStatus: "confirmed", err: null }] };
    },
    async getBlockHeight() {
      return 1;
    },
  };
  return { conn: conn as unknown as Connection, calls };
}

/** `null` = no expected genesis (a local validator); a default parameter would swallow `undefined`. */
function setup(primaryOpts: Parameters<typeof fakeConn>[0], expectedGenesis: string | null = MAINNET) {
  const primary = fakeConn(primaryOpts);
  const fallback = fakeConn();
  const events: RpcEvent[] = [];
  const chain = new SolanaChain(primary.conn, fallback.conn, { crank: Keypair.generate() }, {
    expectedGenesis: expectedGenesis ?? undefined,
    onRpcEvent: (e) => {
      events.push(e);
    },
    genesisRetryMs: 0,
  });
  return { chain, primary: primary.calls, fallback: fallback.calls, kinds: () => events.map((e) => e.kind) };
}

test("mainnet primary: verified once per instance, then reads and transactions use the primary", async () => {
  const { chain, primary, fallback, kinds } = setup({});
  await Promise.all([chain.getRewardVaultAmount(), chain.getRewardVaultAmount(), chain.getCohorts([K])]);
  await chain.getRewardVaultAmount();
  assert.equal(await chain.settle(K, 5n), "sig");
  assert.deepEqual(kinds(), ["verified"]);
  assert.equal(primary.genesis, 1, "one check per instance, even with concurrent first calls");
  assert.equal(primary.reads, 4);
  assert.equal(primary.sends, 1);
  assert.deepEqual(fallback, { genesis: 0, reads: 0, sends: 0 });
});

test("another cluster: one alert event, reads only on the fallback, every transaction refused", async () => {
  const { chain, primary, fallback, kinds } = setup({ genesis: DEVNET });
  await chain.getRewardVaultAmount();
  await chain.getCohorts([K]);
  await assert.rejects(chain.settle(K, 5n), (e) => e instanceof ChainTxError && /transactions are refused/.test(e.message));
  assert.deepEqual(kinds(), ["genesis_mismatch"]);
  assert.equal(primary.genesis, 1);
  assert.equal(primary.reads, 0);
  assert.equal(primary.sends, 0);
  assert.equal(fallback.reads, 2);
  assert.equal(fallback.sends, 0);
});

test("a failed primary read falls back to the public RPC and reports it", async () => {
  const { chain, fallback, kinds } = setup({ failReads: true });
  await chain.getRewardVaultAmount();
  assert.deepEqual(kinds(), ["verified", "fallback"]);
  assert.equal(fallback.reads, 1);
});

test("an unreachable check is retried once, reported, and checked again on the next use", async () => {
  const { chain, primary, kinds } = setup({ genesisFailures: 2 });
  await chain.getRewardVaultAmount();
  assert.deepEqual(kinds(), ["genesis_unreachable"]);
  assert.equal(primary.genesis, 2, "first try plus one retry");
  assert.equal(primary.reads, 1, "reads are not blocked");
  await chain.getRewardVaultAmount();
  assert.deepEqual(kinds(), ["genesis_unreachable", "verified"]);
  assert.equal(primary.genesis, 3);
});

test("local validator: no genesis check and no events", async () => {
  const { chain, primary, kinds } = setup({}, null);
  await chain.getRewardVaultAmount();
  assert.equal(await chain.settle(K, 5n), "sig");
  assert.equal(primary.genesis, 0);
  assert.deepEqual(kinds(), []);
});

test("a failing event handler never breaks the chain", async () => {
  const primary = fakeConn({ genesis: DEVNET });
  const fallback = fakeConn();
  const chain = new SolanaChain(primary.conn, fallback.conn, {}, {
    expectedGenesis: MAINNET,
    onRpcEvent: () => {
      throw new Error("alert write failed");
    },
  });
  assert.equal(await chain.getRewardVaultAmount(), 0n);
  assert.equal(fallback.calls.reads, 1);
});
