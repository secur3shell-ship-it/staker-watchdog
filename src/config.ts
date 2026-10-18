import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const MIN_API_KEY_LENGTH = 32;

export interface AppConfig {
  pollIntervalMs: number;
  freeRateLimit: number;
  paidRateLimit: number;
  /** sha256(key) hex -> tier name */
  apiKeys: Map<string, string>;
  trustProxy: boolean | number | string;
  sseMaxConnections: number;
  sseMaxConnectionsPerClient: number;
  publicDir: string;
}

export interface ServerConfig extends AppConfig {
  port: number;
  host: string;
  rpcUrl: string;
  databasePath: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim() || undefined;
  if (webhookUrl && !/^https?:\/\//i.test(webhookUrl)) {
    throw new Error("ALERT_WEBHOOK_URL must be an http(s) URL");
  }
  return {
    port: parsePositiveInt(env.PORT, 3000),
    host: env.HOST ?? "127.0.0.1",
    rpcUrl: env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
    databasePath: resolve(env.DATABASE_PATH ?? ".data/staker-watchdog.sqlite"),
    pollIntervalMs: parsePositiveInt(env.POLL_INTERVAL_MS, 300_000),
    freeRateLimit: parsePositiveInt(env.FREE_RATE_LIMIT, 120),
    paidRateLimit: parsePositiveInt(env.PAID_RATE_LIMIT, 6000),
    apiKeys: parseApiKeys(env.STAKER_API_KEYS),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sseMaxConnections: parsePositiveInt(env.SSE_MAX_CONNECTIONS, 1000),
    sseMaxConnectionsPerClient: parsePositiveInt(env.SSE_MAX_CONNECTIONS_PER_CLIENT, 10),
    publicDir: resolve("public"),
    webhookUrl,
    webhookSecret: env.ALERT_WEBHOOK_SECRET?.trim() || undefined
  };
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseNonNegativeInt(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Parses `key:tier,key:tier`; refuses short keys rather than silently accepting them. */
export function parseApiKeys(value: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of (value ?? "").split(",")) {
    if (!entry.trim()) continue;
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error("STAKER_API_KEYS entries must use the form key:tier");
    }
    const key = entry.slice(0, separator).trim();
    const tier = entry.slice(separator + 1).trim();
    if (!tier || tier === "free") {
      throw new Error("STAKER_API_KEYS entries need a tier other than \"free\"");
    }
    if (key.length < MIN_API_KEY_LENGTH) {
      throw new Error(
        `STAKER_API_KEYS contains a key shorter than ${MIN_API_KEY_LENGTH} characters; ` +
        "generate one with `openssl rand -hex 24`"
      );
    }
    keys.set(createHash("sha256").update(key).digest("hex"), tier);
  }
  return keys;
}

/**
 * Maps TRUST_PROXY to Express's `trust proxy` setting. Only a hop count or an
 * explicit address/subnet list is accepted: `true` would trust any
 * client-supplied X-Forwarded-For and let callers pick their rate-limit bucket.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "false" || trimmed === "0") return false;
  if (trimmed === "true") {
    throw new Error(
      "TRUST_PROXY=true would trust spoofed X-Forwarded-For headers; " +
      "set the number of proxy hops (e.g. 1) or the proxy addresses instead"
    );
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
