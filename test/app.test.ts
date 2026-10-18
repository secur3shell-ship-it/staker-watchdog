import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { createApp, rateLimitSubject } from "../src/app.js";
import { parseApiKeys, parseTrustProxy, type AppConfig } from "../src/config.js";
import { WatchdogStore } from "../src/store.js";
import type { ValidatorSnapshot } from "../src/types.js";

const PAID_KEY = "k".repeat(40);

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    pollIntervalMs: 300_000,
    freeRateLimit: 5,
    paidRateLimit: 100,
    apiKeys: new Map([[createHash("sha256").update(PAID_KEY).digest("hex"), "institution"]]),
    trustProxy: false,
    sseMaxConnections: 100,
    sseMaxConnectionsPerClient: 2,
    publicDir: resolve("public"),
    ...overrides
  };
}

function snapshot(votePubkey: string, status: ValidatorSnapshot["status"]): ValidatorSnapshot {
  return {
    votePubkey,
    nodePubkey: `${votePubkey}-node`,
    voteStateVersion: 4,
    commissionSource: "vote_state_v4",
    status,
    activeStakeLamports: "1000000000",
    inflationCommissionBps: 500,
    blockRevenueCommissionBps: 1000,
    inflationCollector: "a",
    blockRevenueCollector: "b",
    rootSlot: "1",
    lastVote: "2",
    commissionScore: 92.5,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

async function serve(overrides: Partial<AppConfig> = {}, store = new WatchdogStore(":memory:")) {
  const watchdog = createApp(store, config(overrides));
  const server = watchdog.app.listen(0, "127.0.0.1");
  await new Promise((resolveListen) => server.once("listening", resolveListen));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    store,
    close: async () => {
      watchdog.close();
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
      store.close();
    }
  };
}

test("invalid API keys are charged to the caller's free rate limit", async () => {
  const app = await serve();
  try {
    const statuses: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      const response = await fetch(`${app.base}/api/alerts`, {
        headers: { "x-api-key": `guess-${index}` }
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429]);
    const paid = await fetch(`${app.base}/api/alerts`, { headers: { "x-api-key": PAID_KEY } });
    assert.equal(paid.status, 200);
  } finally {
    await app.close();
  }
});

test("rate-limit buckets follow X-Forwarded-For only when a proxy is trusted", async () => {
  const request = (base: string, forwardedFor: string) =>
    fetch(`${base}/api/alerts`, { headers: { "x-forwarded-for": forwardedFor } });
  const direct = await serve({ freeRateLimit: 1 });
  try {
    assert.equal((await request(direct.base, "203.0.113.1")).status, 200);
    assert.equal((await request(direct.base, "203.0.113.2")).status, 429, "header ignored");
  } finally {
    await direct.close();
  }
  const proxied = await serve({ freeRateLimit: 1, trustProxy: 1 });
  try {
    assert.equal((await request(proxied.base, "203.0.113.1")).status, 200);
    assert.equal((await request(proxied.base, "203.0.113.2")).status, 200);
    assert.equal((await request(proxied.base, "203.0.113.1")).status, 429);
  } finally {
    await proxied.close();
  }
});

test("event streams are capped per client and in total", async () => {
  const app = await serve({ sseMaxConnectionsPerClient: 2, sseMaxConnections: 3, freeRateLimit: 50 });
  const controllers: AbortController[] = [];
  const open = async (headers: Record<string, string> = {}) => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${app.base}/api/events`, { headers, signal: controller.signal });
    return { response, controller };
  };
  try {
    assert.equal((await open()).response.status, 200);
    const second = await open();
    assert.equal(second.response.status, 200);
    assert.equal((await open()).response.status, 429);

    assert.equal((await open({ "x-api-key": PAID_KEY })).response.status, 200);
    assert.equal((await open({ "x-api-key": PAID_KEY })).response.status, 503, "global cap");

    second.controller.abort();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.equal((await open()).response.status, 200, "closed streams free their slot");
  } finally {
    for (const controller of controllers) controller.abort();
    await app.close();
  }
});

test("malformed URLs get a 4xx without stack traces", async () => {
  const app = await serve({ freeRateLimit: 50 });
  try {
    const api = await fetch(`${app.base}/api/validators/%E0%A4%A`);
    assert.equal(api.status, 400);
    assert.deepEqual(await api.json(), { error: "bad_request" });

    const page = await fetch(`${app.base}/validator/%E0%A4%A`);
    assert.equal(page.status, 400);
    const body = await page.text();
    assert.equal(body, "Bad Request");

    const missing = await fetch(`${app.base}/api/does-not-exist`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
  } finally {
    await app.close();
  }
});

test("responses carry security headers", async () => {
  const app = await serve();
  try {
    const response = await fetch(`${app.base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await app.close();
  }
});

test("inactive validators are hidden unless requested or watched", async () => {
  const store = new WatchdogStore(":memory:");
  store.applySnapshot([snapshot("live", "current"), snapshot("gone", "current")], 1, 1);
  store.applySnapshot([snapshot("live", "current")], 2, 1, ["gone"]);
  const app = await serve({ freeRateLimit: 50 }, store);
  const votes = async (query: string) =>
    ((await (await fetch(`${app.base}/api/validators?${query}`)).json()) as {
      data: Array<{ votePubkey: string }>;
    }).data.map(({ votePubkey }) => votePubkey);
  try {
    assert.deepEqual(await votes(""), ["live"]);
    assert.deepEqual(await votes("status=inactive"), ["gone"]);
    assert.deepEqual(await votes("status=watchlist&watchlist=gone"), ["gone"]);
  } finally {
    await app.close();
  }
});

test("IPv6 clients share a rate-limit bucket per /64", () => {
  assert.equal(rateLimitSubject("2001:db8:1:2::1"), "2001:0db8:0001:0002::/64");
  assert.equal(rateLimitSubject("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:0db8:0001:0002::/64");
  assert.equal(rateLimitSubject("::1"), "0000:0000:0000:0000::/64");
  assert.equal(rateLimitSubject("::ffff:198.51.100.7"), "198.51.100.7");
  assert.equal(rateLimitSubject("198.51.100.7"), "198.51.100.7");
});

test("unsafe configuration is rejected at startup", () => {
  assert.throws(() => parseApiKeys("short:institution"), /shorter than 32/);
  assert.throws(() => parseApiKeys(`${PAID_KEY}:free`), /tier other than/);
  assert.throws(() => parseApiKeys(PAID_KEY), /key:tier/);
  assert.equal(parseApiKeys(`${PAID_KEY}:institution`).size, 1);
  assert.equal(parseApiKeys("").size, 0);
  assert.throws(() => parseTrustProxy("true"), /spoofed/);
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("loopback, 10.0.0.0/8"), "loopback, 10.0.0.0/8");
});
