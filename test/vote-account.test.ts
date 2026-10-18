import assert from "node:assert/strict";
import test from "node:test";
import { decodeVoteStateV4, identifyVoteState } from "../src/vote-account.js";

test("decodes VoteStateV4 dual commission and collector fields", () => {
  const data = Buffer.alloc(144);
  data.writeUInt32LE(4, 0);
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

test("returns null for old vote state versions", () => {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(3, 0);
  assert.equal(decodeVoteStateV4(data), null);
});

test("identifies legacy vote state for explicit default handling", () => {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(3, 0);
  assert.deepEqual(identifyVoteState(data), {
    version: 3,
    inflationCommissionBps: null,
    blockRevenueCommissionBps: null,
    inflationCollector: null,
    blockRevenueCollector: null
  });
});

test("rejects truncated account headers", () => {
  assert.throws(() => decodeVoteStateV4(Buffer.alloc(3)), /too short/);
  const truncatedV4 = Buffer.alloc(120);
  truncatedV4.writeUInt32LE(4, 0);
  assert.throws(() => decodeVoteStateV4(truncatedV4), /truncated/);
});
