import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { isIPv6 } from "node:net";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { parseNonNegativeInt, parsePositiveInt, type AppConfig } from "./config.js";
import type { MonitorUpdate } from "./monitor.js";
import type { WatchdogStore } from "./store.js";

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_TABLE_SOFT_LIMIT = 100_000;
const HEARTBEAT_MS = 25_000;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

export interface WatchdogApp {
  app: express.Express;
  publishUpdate: (update: MonitorUpdate) => void;
  close: () => void;
}

export function createApp(store: WatchdogStore, config: AppConfig): WatchdogApp {
  const app = express();
  const requestCounts = new Map<string, { count: number; resetsAt: number }>();
  const eventClients = new Map<Response, string>();
  const eventClientsByIdentity = new Map<string, number>();

  const sendEvent = (client: Response, message: string): void => {
    if (!client.write(message)) {
      console.warn("SSE client write buffer is full; closing slow client");
      client.end();
      removeEventClient(client);
    }
  };
  const removeEventClient = (client: Response): void => {
    const identity = eventClients.get(client);
    if (identity === undefined) return;
    eventClients.delete(client);
    const remaining = (eventClientsByIdentity.get(identity) ?? 1) - 1;
    if (remaining > 0) eventClientsByIdentity.set(identity, remaining);
    else eventClientsByIdentity.delete(identity);
  };
  const sweepRateLimits = (): void => {
    const now = Date.now();
    for (const [key, value] of requestCounts) {
      if (value.resetsAt <= now) requestCounts.delete(key);
    }
  };

  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (request.secure) {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  app.use(express.static(config.publicDir));
  app.get("/validator/:votePubkey", (_request, response) => {
    response.sendFile(join(config.publicDir, "index.html"));
  });

  app.get("/api/health", (_request, response) => {
    const status = store.getStatus();
    response.json({
      ok: true,
      ...status,
      changeCount: store.getAlertCount(),
      stale: !status.lastSuccessfulSyncAt ||
        Date.now() - Date.parse(status.lastSuccessfulSyncAt) > config.pollIntervalMs * 2
    });
  });

  app.use("/api", (request, response, next) => {
    const suppliedKey = request.header("x-api-key");
    const keyHash = suppliedKey
      ? createHash("sha256").update(suppliedKey).digest("hex")
      : undefined;
    const configuredTier = keyHash ? config.apiKeys.get(keyHash) : undefined;
    const tier = configuredTier ?? "free";
    // Requests with an unrecognised key are charged to the caller's free
    // bucket, so key guessing is rate limited like any other request.
    const identity = configuredTier
      ? `paid:${keyHash}`
      : `free:${rateLimitSubject(request.ip)}`;
    const now = Date.now();
    if (requestCounts.size > RATE_TABLE_SOFT_LIMIT) sweepRateLimits();
    let window = requestCounts.get(identity);
    if (!window || window.resetsAt <= now) {
      window = { count: 0, resetsAt: now + RATE_WINDOW_MS };
      requestCounts.set(identity, window);
    }
    window.count += 1;
    const limit = configuredTier ? config.paidRateLimit : config.freeRateLimit;
    response.setHeader("RateLimit-Limit", String(limit));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, limit - window.count)));
    response.setHeader("RateLimit-Reset", String(Math.ceil(window.resetsAt / 1000)));
    if (window.count > limit) {
      response.setHeader("Retry-After", String(Math.ceil((window.resetsAt - now) / 1000)));
      response.status(429).json({ error: "rate_limit_exceeded", tier });
      return;
    }
    if (suppliedKey && !configuredTier) {
      response.status(401).json({ error: "invalid_api_key" });
      return;
    }
    request.rateTier = tier;
    request.rateIdentity = identity;
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
      // Inactive validators are only listed when asked for, or when watched.
      const matchesStatus =
        status === "current" || status === "delinquent" || status === "inactive"
          ? validator.status === status
          : status === "watchlist" || validator.status !== "inactive";
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
    const identity = request.rateIdentity ?? "unknown";
    if (eventClients.size >= config.sseMaxConnections) {
      response.setHeader("Retry-After", "60");
      response.status(503).json({ error: "event_stream_capacity_reached" });
      return;
    }
    if ((eventClientsByIdentity.get(identity) ?? 0) >= config.sseMaxConnectionsPerClient) {
      response.status(429).json({
        error: "too_many_event_streams",
        max: config.sseMaxConnectionsPerClient
      });
      return;
    }
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    eventClients.set(response, identity);
    eventClientsByIdentity.set(identity, (eventClientsByIdentity.get(identity) ?? 0) + 1);
    request.on("close", () => removeEventClient(response));
    sendEvent(response, `event: connected\ndata: ${JSON.stringify(store.getStatus())}\n\n`);
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

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  app.use("/api", (error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(error);
    const status = clientErrorStatus(error);
    if (status === 500) {
      console.error("API request failed:", error);
      response.status(500).json({ error: "internal_server_error" });
      return;
    }
    response.status(status).json({ error: status === 404 ? "not_found" : "bad_request" });
  });

  // Replaces Express's default handler, which echoes stack traces and file paths.
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(error);
    const status = clientErrorStatus(error);
    if (status === 500) console.error("Request failed:", error);
    response.status(status).type("text/plain").send(STATUS_CODES[status] ?? "Error");
  });

  const cleanupTimer = setInterval(sweepRateLimits, RATE_WINDOW_MS);
  const heartbeatTimer = setInterval(() => {
    for (const client of [...eventClients.keys()]) sendEvent(client, ": keep-alive\n\n");
  }, HEARTBEAT_MS);
  cleanupTimer.unref();
  heartbeatTimer.unref();

  return {
    app,
    publishUpdate: (update) => {
      const message = `event: update\ndata: ${JSON.stringify(update)}\n\n`;
      for (const client of [...eventClients.keys()]) sendEvent(client, message);
    },
    close: () => {
      clearInterval(cleanupTimer);
      clearInterval(heartbeatTimer);
      for (const client of eventClients.keys()) client.end();
      eventClients.clear();
      eventClientsByIdentity.clear();
    }
  };
}

/**
 * Rate-limit key for a client address. IPv6 clients are grouped by /64, since a
 * single host typically controls a whole /64 and could otherwise rotate
 * addresses to get unlimited buckets.
 */
export function rateLimitSubject(ip: string | undefined): string {
  if (!ip) return "unknown";
  const address = ip.split("%")[0] ?? ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(address)) return address;
  const [head = "", tail] = address.split("::");
  const groups = (part: string): string[] =>
    part ? part.split(":").flatMap((group) => group.includes(".") ? ["0", "0"] : [group]) : [];
  const headGroups = groups(head);
  const tailGroups = tail === undefined ? [] : groups(tail);
  const full = [
    ...headGroups,
    ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"),
    ...tailGroups
  ];
  return `${full.slice(0, 4).map((group) => group.toLowerCase().padStart(4, "0")).join(":")}::/64`;
}

function clientErrorStatus(error: unknown): number {
  const status = typeof error === "object" && error !== null
    ? (error as { status?: unknown; statusCode?: unknown }).status ??
      (error as { statusCode?: unknown }).statusCode
    : undefined;
  return typeof status === "number" && status >= 400 && status < 500 ? status : 500;
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
      rateIdentity?: string;
    }
  }
}
