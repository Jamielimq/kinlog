// The ported ORE reading in onchain/scripts/lib.ts, against round accounts captured from mainnet
// (the same fixtures the program's LiteSVM tests use).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import * as P from "../../src/chain/program.ts";
import { accountOf, fixture, roundFixtureNames } from "../support/fixtures.ts";

test("mainnet rounds reproduce ORE's own reset events", () => {
  let checked = 0;
  let motherlodes = 0;
  for (const name of roundFixtureNames()) {
    const f = fixture(name);
    if (!f.expected_source) continue;
    const id = BigInt(f.round_id!);
    const st = P.readRound(accountOf(f), id);
    assert.equal(st.kind, "present");
    const rng = st.kind === "present" ? st.rng : null;
    assert.notEqual(rng, null, `${name} revealed`);
    assert.equal(rng!.toString(), f.expected_source.event_rng, `${name} rng`);
    assert.equal(P.winningSquare(rng!), f.expected!.winning_square, `${name} winning square`);
    assert.equal(P.hitMotherlode(rng!), f.expected!.motherlode_hit, `${name} motherlode`);
    if (P.hitMotherlode(rng!)) motherlodes++;
    checked++;
  }
  assert.ok(checked >= 27, `only ${checked} event-sourced fixtures`);
  assert.equal(motherlodes, 3);
});

test("unrevealed round has no rng; all-0xFF hash has none either", () => {
  const f = fixture("round_417351");
  const st = P.readRound(accountOf(f), 417351n);
  assert.deepEqual(st, { kind: "present", rng: null });
  assert.equal(P.oreRng(Buffer.alloc(32, 0xff)), null);
  assert.equal(P.oreRng(Buffer.alloc(32, 0)), null);
});

test("board fixture decodes and foreign accounts are refused", () => {
  const board = accountOf(fixture("board"));
  assert.ok(P.decodeBoardRoundId(board) > 400_000n);
  assert.throws(() => P.decodeBoardRoundId({ ...board, owner: Keypair.generate().publicKey }));
  assert.throws(() => P.decodeBoardRoundId({ ...board, data: board.data.subarray(0, 39) }));
  assert.throws(() => P.decodeBoardRoundId(null));
});

test("round reading mirrors ore::read_round", () => {
  const f = fixture("round_417955");
  const acc = accountOf(f);
  // Missing / closed / foreign-owned at the round's own address.
  assert.deepEqual(P.readRound(null, 1n), { kind: "missing" });
  assert.deepEqual(P.readRound({ owner: Keypair.generate().publicKey, data: acc.data }, 417955n), { kind: "missing" });
  assert.deepEqual(P.readRound({ owner: acc.owner, data: Buffer.alloc(0) }, 417955n), { kind: "missing" });
  // ORE-owned but not this round: the program errors, so do we.
  assert.throws(() => P.readRound(acc, 417956n));
  assert.throws(() => P.readRound({ owner: acc.owner, data: acc.data.subarray(0, 900) }, 417955n));
});

test("settle decision table matches reward.rs", () => {
  const revealed: P.RoundState = { kind: "present", rng: 12345n };
  const noEntropy: P.RoundState = { kind: "present", rng: null };
  const missing: P.RoundState = { kind: "missing" };
  // Revealed settles whether or not the board has moved on.
  assert.equal(P.settleAction(100n, 100n, revealed), "settle");
  assert.equal(P.settleAction(101n, 100n, revealed), "settle");
  // Missing: not created yet (board not past it) waits; closed after the board moved on settles Common.
  assert.equal(P.settleAction(99n, 100n, missing), "wait");
  assert.equal(P.settleAction(100n, 100n, missing), "wait");
  assert.equal(P.settleAction(101n, 100n, missing), "settle");
  // No entropy: waits while current, retargets once finished.
  assert.equal(P.settleAction(100n, 100n, noEntropy), "wait");
  assert.equal(P.settleAction(101n, 100n, noEntropy), "retarget");
});
