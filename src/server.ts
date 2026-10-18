import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { SolanaRpc } from "./rpc.js";
import { ValidatorMonitor, type MonitorUpdate } from "./monitor.js";
import { WatchdogStore } from "./store.js";

const port = parsePositiveInt(process.env.PORT, 3000);
const host = process.env.HOST ?? "127.0.0.1";
const pollIntervalMs = parsePositiveInt(process.env.POLL_INTERVAL_MS, 300_000);
const freeRateLimit = parsePositiveInt(process.env.FREE_RATE_LIMIT, 120);
const paidRateLimit = parsePositiveInt(process.env.PAID_RATE_LIMIT, 6000);
const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const databasePath = resolve(process.env.DATABASE_PATH ?? ".data/staker-watchdog.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const store = new WatchdogStore(databasePath);
const eventClients = new Set<Response>();
const publishUpdate = (update: MonitorUpdate): void => {
  const message = `event: update\ndata: ${JSON.stringify(update)}\n\n`;
  for (const client of eventClients) {
    if (!client.write(message)) {
      console.warn("SSE client write buffer is full; closing slow client");
      client.end();
      eventClients.delete(client);
    }
  }
};
const monitor = new ValidatorMonitor(
  new SolanaRpc(rpcUrl),
  store,
  process.env.ALERT_WEBHOOK_URL,
  publishUpdate
);
const app = express();
const rateWindowMs = 15 * 60 * 1000;
const requestCounts = new Map<string, { count: number; resetsAt: number }>();
const apiKeys = parseApiKeys(process.env.STAKER_API_KEYS);

app.disable("x-powered-by");
app.use(express.static(resolve("public")));
app.get("/validator/:votePubkey", (_request, response) => {
  response.sendFile(resolve("public/index.html"));
});

app.get("/api/health", (_request, response) => {
  const status = store.getStatus();
  response.json({
    ok: true,
    ...status,
    changeCount: store.getAlertCount(),
    stale: !status.lastSuccessfulSyncAt ||
      Date.now() - Date.parse(status.lastSuccessfulSyncAt) > pollIntervalMs * 2
  });
});

app.use("/api", (request, response, next) => {
  const suppliedKey = request.header("x-api-key");
  const keyHash = suppliedKey
    ? createHash("sha256").update(suppliedKey).digest("hex")
    : undefined;
  const configuredTier = keyHash ? apiKeys.get(keyHash) : undefined;
  if (suppliedKey && !configuredTier) {
    response.status(401).json({ error: "invalid_api_key" });
    return;
  }
  const tier = configuredTier ?? "free";
  const identity = tier === "free"
    ? `free:${request.ip ?? "unknown"}`
    : `paid:${keyHash}`;
  const now = Date.now();
  const current = requestCounts.get(identity);
  if (!current || current.resetsAt <= now) {
    requestCounts.set(identity, { count: 1, resetsAt: now + rateWindowMs });
  } else {
    current.count += 1;
  }
  const window = requestCounts.get(identity)!;
  const limit = tier === "free" ? freeRateLimit : paidRateLimit;
  response.setHeader("RateLimit-Limit", String(limit));
  response.setHeader("RateLimit-Remaining", String(Math.max(0, limit - window.count)));
  response.setHeader("RateLimit-Reset", String(Math.ceil(window.resetsAt / 1000)));
  if (window.count > limit) {
    response.setHeader("Retry-After", String(Math.ceil((window.resetsAt - now) / 1000)));
    response.status(429).json({ error: "rate_limit_exceeded", tier });
    return;
  }
  request.rateTier = tier;
  next();
});

app.get("/api/validators", (request, response) => {
  const query = typeof request.query.q === "string" ? request.query.q.trim().toLowerCase() : "";
  const status = request.query.status;
  const sort = isValidatorSort(request.query.sort) ? request.query.sort : "stake";
  const direction = request.query.direction === "asc" ? "asc" : "desc";
  const inflationWeight = parseWeight(request.query.inflationWeight);
  if (inflationWeight === null) {
    response.status(400).json({ error: "invalid_inflation_weight", min: 0, max: 100 });
    return;
  }
  const limit = Math.min(parsePositiveInt(String(request.query.limit ?? "500"), 500), 1000);
  const offset = parseNonNegativeInt(String(request.query.offset ?? "0"), 0);
  const watchlist = parseWatchlistQuery(request.query.watchlist, response);
  if (watchlist === null) return;
  const validators = store.listValidators().filter((validator) => {
    const matchesQuery = !query ||
      validator.votePubkey.toLowerCase().includes(query) ||
      validator.nodePubkey.toLowerCase().includes(query);
    const matchesStatus =
      (status !== "current" && status !== "delinquent") || validator.status === status;
    const matchesWatchlist = status !== "watchlist" || watchlist?.includes(validator.votePubkey);
    return matchesQuery && matchesStatus && matchesWatchlist;
  });

  validators.sort((a, b) => compareValidators(a, b, sort, direction, inflationWeight));
  response.json({
    data: validators.slice(offset, offset + limit),
    meta: { total: validators.length, limit, offset, tier: request.rateTier }
  });
});

app.get("/api/validators/:votePubkey/history", (request, response) => {
  const votePubkey = request.params.votePubkey ?? "";
  if (!store.getValidator(votePubkey)) {
    response.status(404).json({ error: "validator_not_found" });
    return;
  }
  const limit = Math.min(parsePositiveInt(String(request.query.limit ?? "100"), 100), 500);
  const data = store.listValidatorHistory(votePubkey, limit);
  response.json({
    data,
    meta: { limit, total: store.getValidatorHistoryCount(votePubkey) }
  });
});

app.get("/api/validators/:votePubkey", (request, response) => {
  const validator = store.getValidator(request.params.votePubkey ?? "");
  if (!validator) {
    response.status(404).json({ error: "validator_not_found" });
    return;
  }
  response.json({ data: validator, tier: request.rateTier });
});

app.get("/api/events", (request, response) => {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.write(`event: connected\ndata: ${JSON.stringify(store.getStatus())}\n\n`);
  eventClients.add(response);
  request.on("close", () => {
    eventClients.delete(response);
  });
});

app.get("/api/alerts", (request, response) => {
  const limit = Math.min(parsePositiveInt(String(request.query.limit ?? "50"), 50), 200);
  const offset = parseNonNegativeInt(String(request.query.offset ?? "0"), 0);
  let watchlist = parseWatchlistQuery(request.query.watchlist, response);
  if (watchlist === null) return;
  if (request.query.watchlistOnly === "true" && watchlist === undefined) {
    watchlist = [];
  }
  response.json({
    data: store.listAlerts(limit, offset, watchlist),
    meta: {
      total: store.getAlertCount(watchlist),
      limit,
      offset,
      tier: request.rateTier
    }
  });
});

app.use("/api", (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error("API request failed:", error);
  response.status(500).json({ error: "internal_server_error" });
});

const server = app.listen(port, host, () => {
  console.info(`Staker Watchdog listening on http://${host}:${port}`);
  console.info(`Using Solana RPC ${rpcUrl}`);
});

const runSync = (): void => {
  void monitor.sync().catch((error: unknown) => {
    console.error("Validator sync failed:", error);
  });
};
runSync();
const syncTimer = setInterval(runSync, pollIntervalMs);
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of requestCounts) {
    if (value.resetsAt <= now) requestCounts.delete(key);
  }
}, rateWindowMs);
const heartbeatTimer = setInterval(() => {
  for (const client of eventClients) client.write(": keep-alive\n\n");
}, 25_000);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseWatchlistQuery(
  value: unknown,
  response: Response
): string[] | undefined | null {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  if (
    entries.length > 100 ||
    entries.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 64)
  ) {
    response.status(400).json({ error: "invalid_watchlist_filter", maxItems: 100 });
    return null;
  }
  return [...new Set(entries as string[])];
}

function parseApiKeys(value: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of (value ?? "").split(",")) {
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    const tier = entry.slice(separator + 1).trim();
    if (key && tier && tier !== "free") {
      keys.set(createHash("sha256").update(key).digest("hex"), tier);
    }
  }
  return keys;
}

type ValidatorSort = "stake" | "commission" | "inflation" | "blockRevenue" | "status";

function isValidatorSort(value: unknown): value is ValidatorSort {
  return value === "stake" ||
    value === "commission" ||
    value === "inflation" ||
    value === "blockRevenue" ||
    value === "status";
}

function parseWeight(value: unknown): number | null {
  if (value === undefined) return 50;
  if (typeof value !== "string") return null;
  const weight = Number(value);
  return Number.isInteger(weight) && weight >= 0 && weight <= 100 ? weight : null;
}

function compareValidators(
  left: ReturnType<WatchdogStore["listValidators"]>[number],
  right: ReturnType<WatchdogStore["listValidators"]>[number],
  sort: ValidatorSort,
  direction: "asc" | "desc",
  inflationWeight: number
): number {
  if (sort === "status") {
    return direction === "asc"
      ? left.status.localeCompare(right.status)
      : right.status.localeCompare(left.status);
  }

  if (sort === "stake") {
    const a = BigInt(left.activeStakeLamports);
    const b = BigInt(right.activeStakeLamports);
    const compare = a < b ? -1 : a > b ? 1 : 0;
    return direction === "asc" ? compare : -compare;
  }

  const getValue = (validator: ReturnType<WatchdogStore["listValidators"]>[number]): number | null =>
    sort === "commission"
      ? validator.inflationCommissionBps === null || validator.blockRevenueCommissionBps === null
        ? null
        : 100 - (
            Math.min(validator.inflationCommissionBps, 10_000) * inflationWeight +
            Math.min(validator.blockRevenueCommissionBps, 10_000) * (100 - inflationWeight)
          ) / 10_000
      : sort === "inflation"
        ? validator.inflationCommissionBps
        : validator.blockRevenueCommissionBps;
  const a = getValue(left);
  const b = getValue(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const compare = a - b;
  return direction === "asc" ? compare : -compare;
}

declare global {
  namespace Express {
    interface Request {
      rateTier?: string;
    }
  }
}

function shutdown(): void {
  clearInterval(syncTimer);
  clearInterval(cleanupTimer);
  clearInterval(heartbeatTimer);
  for (const client of eventClients) client.end();
  eventClients.clear();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
