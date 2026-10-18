import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { WatchdogStore } from "../src/store.js";
import type { ValidatorSnapshot } from "../src/types.js";

function snapshot(overrides: Partial<ValidatorSnapshot> = {}): ValidatorSnapshot {
  return {
    votePubkey: "vote-account",
    nodePubkey: "validator-identity",
    voteStateVersion: 4,
    commissionSource: "vote_state_v4",
    status: "current",
    activeStakeLamports: "1000000000",
    inflationCommissionBps: 500,
    blockRevenueCommissionBps: 1200,
    inflationCollector: "inflation-wallet",
    blockRevenueCollector: "revenue-wallet",
    rootSlot: "50",
    lastVote: "51",
    commissionScore: 91.5,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("stores baseline without creating false first-run alerts", () => {
  const store = new WatchdogStore(":memory:");
  try {
    assert.deepEqual(store.applySnapshot([snapshot()], 52, 2), []);
    assert.equal(store.listValidators().length, 1);
    assert.equal(store.getStatus().currentSlot, "52");
  } finally {
    store.close();
  }
});

test("records commission and collector changes with old and new values", () => {
  const store = new WatchdogStore(":memory:");
  try {
    store.applySnapshot([snapshot()], 52, 2);
    const detected = store.applySnapshot([
      snapshot({
        inflationCommissionBps: 700,
        blockRevenueCollector: "new-revenue-wallet",
        commissionScore: 90.5
      })
    ], 53, 2);
    assert.equal(detected.length, 2);
    assert.deepEqual(
      detected.map(({ field, previousValue, newValue }) => [field, previousValue, newValue]),
      [
        ["inflation_commission", "500", "700"],
        ["block_revenue_collector", "revenue-wallet", "new-revenue-wallet"]
      ]
    );
    assert.equal(store.listAlerts().length, 2);
    assert.equal(store.getAlertCount(), 2);
    assert.equal(store.listAlerts(1, 1)[0]?.field, "inflation_commission");
    const history = store.listValidatorHistory("vote-account");
    assert.deepEqual(history.map(({ eventType }) => eventType), [
      "configuration_change",
      "baseline"
    ]);
    assert.equal(store.getValidatorHistoryCount("vote-account"), 2);
    assert.equal(history[0]?.inflationCommissionBps, 700);
  } finally {
    store.close();
  }
});

test("records validator status changes as alert and historical state", () => {
  const store = new WatchdogStore(":memory:");
  try {
    store.applySnapshot([snapshot()], 52, 2);
    const alerts = store.applySnapshot([
      snapshot({ status: "delinquent" })
    ], 53, 2);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.field, "validator_status");
    assert.equal(alerts[0]?.previousValue, "current");
    assert.equal(store.listValidatorHistory("vote-account")[0]?.eventType, "status_change");
  } finally {
    store.close();
  }
});

test("filters alerts by watched validator addresses", () => {
  const store = new WatchdogStore(":memory:");
  try {
    store.applySnapshot([snapshot()], 52, 2);
    store.applySnapshot([snapshot({ inflationCommissionBps: 600 })], 53, 2);
    store.applySnapshot([
      snapshot({ votePubkey: "other-vote", inflationCommissionBps: 900 })
    ], 54, 2);

    assert.equal(store.getAlertCount(["vote-account"]), 1);
    assert.equal(store.listAlerts(10, 0, ["vote-account"])[0]?.votePubkey, "vote-account");
    assert.equal(store.getAlertCount([]), 0);
  } finally {
    store.close();
  }
});

test("does not infer a change when an unknown field becomes available", () => {
  const store = new WatchdogStore(":memory:");
  try {
    store.applySnapshot([
      snapshot({ blockRevenueCommissionBps: null, blockRevenueCollector: null })
    ], 52, 2);
    assert.deepEqual(store.applySnapshot([snapshot()], 53, 2), []);
  } finally {
    store.close();
  }
});

test("migrates a database created before vote-state source fields existed", () => {
  const directory = mkdtempSync(join(tmpdir(), "staker-watchdog-test-"));
  const path = join(directory, "legacy.sqlite");
  const legacyDb = new Database(path);
  legacyDb.exec(`
    CREATE TABLE validators (
      vote_pubkey TEXT PRIMARY KEY,
      node_pubkey TEXT NOT NULL,
      status TEXT NOT NULL,
      active_stake_lamports TEXT NOT NULL,
      inflation_commission_bps INTEGER,
      block_revenue_commission_bps INTEGER,
      inflation_collector TEXT,
      block_revenue_collector TEXT,
      root_slot TEXT NOT NULL,
      last_vote TEXT NOT NULL,
      commission_score REAL,
      updated_at TEXT NOT NULL
    )
  `);
  legacyDb.prepare(`
    INSERT INTO validators (
      vote_pubkey, node_pubkey, status, active_stake_lamports,
      inflation_commission_bps, block_revenue_commission_bps,
      inflation_collector, block_revenue_collector, root_slot,
      last_vote, commission_score, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "vote-account",
    "validator-identity",
    "current",
    "1000000000",
    400,
    1200,
    "inflation-wallet",
    "revenue-wallet",
    "49",
    "50",
    92,
    "2025-12-31T00:00:00.000Z"
  );
  legacyDb.close();

  const store = new WatchdogStore(path);
  try {
    store.applySnapshot([snapshot()], 52, 2);
    assert.equal(store.listValidators()[0]?.voteStateVersion, 4);
    assert.equal(store.listValidators()[0]?.commissionSource, "vote_state_v4");
    const history = store.listValidatorHistory("vote-account");
    assert.equal(history.at(-1)?.eventType, "baseline");
    assert.equal(history.at(-1)?.inflationCommissionBps, 400);
    assert.ok(history.some((entry) => entry.eventType === "configuration_change"));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
