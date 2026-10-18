import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeVoteStateV4, identifyVoteState } from "../src/vote-account.js";
import { voteStateWithTag } from "./helpers.js";

const mainnet = JSON.parse(
  readFileSync(new URL("./fixtures/mainnet-vote-account-v4.json", import.meta.url), "utf8")
) as {
  votePubkey: string;
  nodePubkey: string;
  getVoteAccountsCommissionPercent: number;
  data: [string, string];
};

test("decodes a real mainnet VoteStateV4 account (enum tag 3)", () => {
  const data = Buffer.from(mainnet.data[0], "base64");
  assert.equal(data.readUInt32LE(0), 3);
  const decoded = identifyVoteState(data);
  assert.equal(decoded.version, 4);
  // Cross-check against the independent getVoteAccounts commission.
  assert.equal(decoded.inflationCommissionBps, mainnet.getVoteAccountsCommissionPercent * 100);
  assert.equal(decoded.blockRevenueCommissionBps, 10_000);
  assert.equal(decoded.inflationCollector, mainnet.votePubkey);
  assert.equal(decoded.blockRevenueCollector, mainnet.nodePubkey);
});

test("decodes VoteStateV4 dual commission and collector fields", () => {
  const data = voteStateWithTag(3);
  Buffer.alloc(32, 1).copy(data, 68);
  Buffer.alloc(32, 2).copy(data, 100);
  data.writeUInt16LE(1234, 132);
  data.writeUInt16LE(9876, 134);

  assert.deepEqual(decodeVoteStateV4(data), {
    version: 4,
    inflationCommissionBps: 1234,
    blockRevenueCommissionBps: 9876,
    inflationCollector: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    blockRevenueCollector: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"
  });
});

test("maps legacy enum tags to their layout versions", () => {
  for (const [tag, version] of [[0, 0], [1, 1], [2, 3]] as const) {
    const data = voteStateWithTag(tag);
    assert.equal(decodeVoteStateV4(data), null);
    assert.deepEqual(identifyVoteState(data), {
      version,
      inflationCommissionBps: null,
      blockRevenueCommissionBps: null,
      inflationCollector: null,
      blockRevenueCollector: null
    });
  }
});

test("rejects unknown enum tags instead of guessing a layout", () => {
  assert.throws(() => identifyVoteState(voteStateWithTag(4)), /Unsupported vote account state tag 4/);
});

test("rejects truncated account headers", () => {
  assert.throws(() => decodeVoteStateV4(Buffer.alloc(3)), /too short/);
  const truncatedV4 = Buffer.alloc(120);
  truncatedV4.writeUInt32LE(3, 0);
  assert.throws(() => decodeVoteStateV4(truncatedV4), /truncated/);
});
