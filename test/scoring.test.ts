import assert from "node:assert/strict";
import test from "node:test";
import { calculateCommissionScore } from "../src/scoring.js";

test("score equally weights both commission rates", () => {
  assert.equal(calculateCommissionScore(500, 1200), 91.5);
});

test("score requires both commission rates rather than treating unknown as zero", () => {
  assert.equal(calculateCommissionScore(500, null), null);
  assert.equal(calculateCommissionScore(null, 1200), null);
});

test("commission rates above 100 percent are capped for effective score", () => {
  assert.equal(calculateCommissionScore(12_000, 0), 50);
});

test("invalid commission values do not produce a score", () => {
  assert.equal(calculateCommissionScore(-1, 100), null);
  assert.equal(calculateCommissionScore(Number.NaN, 100), null);
});
