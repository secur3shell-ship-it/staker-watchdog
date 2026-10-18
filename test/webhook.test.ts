import assert from "node:assert/strict";
import test from "node:test";
import { WatchdogStore } from "../src/store.js";
import type { ValidatorSnapshot } from "../src/types.js";
import { signWebhookPayload, WebhookDispatcher } from "../src/webhook.js";

function snapshot(inflationCommissionBps: number): ValidatorSnapshot {
  return {
    votePubkey: "vote-account",
    nodePubkey: "validator-identity",
    voteStateVersion: 4,
    commissionSource: "vote_state_v4",
    status: "current",
    activeStakeLamports: "1000000000",
    inflationCommissionBps,
    blockRevenueCommissionBps: 1200,
    inflationCollector: "inflation-wallet",
    blockRevenueCollector: "revenue-wallet",
    rootSlot: "50",
    lastVote: "51",
    commissionScore: 90,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

interface Delivery {
  headers: Record<string, string>;
  body: string;
}

function recorder(statuses: number[] = []) {
  const deliveries: Delivery[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    deliveries.push({
      headers: init?.headers as Record<string, string>,
      body: String(init?.body)
    });
    return new Response("ok", { status: statuses.shift() ?? 200 });
  };
  return { deliveries, fetchImpl };
}

test("delivers new alerts in order with a verifiable signature", async () => {
  const store = new WatchdogStore(":memory:");
  try {
    store.applySnapshot([snapshot(500)], 1, 1);
    store.applySnapshot([snapshot(600)], 2, 1); // existed before the dispatcher
    const { deliveries, fetchImpl } = recorder();
    const dispatcher = new WebhookDispatcher(store, {
      url: "https://hooks.invalid",
      secret: "test-secret",
      fetchImpl
    });
    store.applySnapshot([snapshot(700)], 3, 1);
    store.applySnapshot([snapshot(800)], 4, 1);
    await dispatcher.kick();

    assert.deepEqual(
      deliveries.map(({ body }) => JSON.parse(body).newValue),
      ["700", "800"],
      "history from before the first start is not replayed"
    );
    const [first] = deliveries;
    assert.ok(first);
    const timestamp = first.headers["x-staker-watchdog-timestamp"] ?? "";
    assert.equal(
      first.headers["x-staker-watchdog-signature"],
      `v1=${signWebhookPayload("test-secret", timestamp, first.body)}`
    );
    assert.equal(first.headers["x-staker-watchdog-delivery"], String(JSON.parse(first.body).id));

    await dispatcher.kick();
    assert.equal(deliveries.length, 2, "delivered alerts are not sent again");
  } finally {
    store.close();
  }
});

test("retries transient failures and skips permanent rejections", async () => {
  const store = new WatchdogStore(":memory:");
  try {
    store.applySnapshot([snapshot(500)], 1, 1);
    const { deliveries, fetchImpl } = recorder([503, 429, 200, 400, 200]);
    const dispatcher = new WebhookDispatcher(store, {
      url: "https://hooks.invalid",
      fetchImpl,
      baseRetryDelayMs: 1
    });
    store.applySnapshot([snapshot(600)], 2, 1);
    store.applySnapshot([snapshot(700)], 3, 1);
    store.applySnapshot([snapshot(800)], 4, 1);
    await dispatcher.kick();

    assert.deepEqual(
      deliveries.map(({ body }) => JSON.parse(body).newValue),
      ["600", "600", "600", "700", "800"]
    );
    assert.equal(deliveries[0]?.headers["x-staker-watchdog-signature"], undefined);
  } finally {
    store.close();
  }
});

test("resumes from the stored cursor after a restart", async () => {
  const store = new WatchdogStore(":memory:");
  try {
    store.applySnapshot([snapshot(500)], 1, 1);
    const first = recorder([500]);
    const dispatcher = new WebhookDispatcher(store, {
      url: "https://hooks.invalid",
      fetchImpl: first.fetchImpl,
      baseRetryDelayMs: 60_000
    });
    store.applySnapshot([snapshot(600)], 2, 1);
    const draining = dispatcher.kick();
    await new Promise((resolve) => setImmediate(resolve));
    dispatcher.stop();
    await draining;
    assert.equal(first.deliveries.length, 1);

    const second = recorder();
    await new WebhookDispatcher(store, {
      url: "https://hooks.invalid",
      fetchImpl: second.fetchImpl
    }).kick();
    assert.deepEqual(second.deliveries.map(({ body }) => JSON.parse(body).newValue), ["600"]);
  } finally {
    store.close();
  }
});
