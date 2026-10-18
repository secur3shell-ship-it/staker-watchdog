import { createHmac } from "node:crypto";
import type { ValidatorAlert } from "./types.js";
import type { WatchdogStore } from "./store.js";

const CURSOR_KEY = "webhook_delivered_alert_id";
const BATCH_SIZE = 50;

export interface WebhookOptions {
  url: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Delivers stored alerts to the configured webhook in id order, outside the
 * sync loop. The `alerts` table is the outbox and a metadata cursor records the
 * last delivered id, so delivery is at-least-once and survives restarts.
 * Transient failures (network, 408, 429, 5xx) retry with capped exponential
 * backoff until they succeed; other 4xx responses are permanent and skipped.
 */
export class WebhookDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private draining: Promise<void> | null = null;
  private pending = false;
  private stopped = false;
  private readonly stopController = new AbortController();

  constructor(
    private readonly store: WatchdogStore,
    private readonly options: WebhookOptions
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 5_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 300_000;
    // On first use, start from the newest alert instead of replaying history.
    if (this.store.getMetadata(CURSOR_KEY) === null) {
      this.store.setMetadata(CURSOR_KEY, String(this.store.getLatestAlertId()));
    }
  }

  /** Starts (or schedules) a drain of undelivered alerts; never throws. */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) {
      this.pending = true;
      return this.draining;
    }
    this.draining = this.drain()
      .catch((error: unknown) => {
        console.error("Webhook dispatcher stopped unexpectedly:", error);
      })
      .finally(() => {
        this.draining = null;
        if (this.pending && !this.stopped) {
          this.pending = false;
          void this.kick();
        }
      });
    return this.draining;
  }

  stop(): void {
    this.stopped = true;
    this.stopController.abort();
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const cursor = Number(this.store.getMetadata(CURSOR_KEY) ?? "0");
      const batch = this.store.listAlertsAfter(cursor, BATCH_SIZE);
      if (!batch.length) return;
      for (const alert of batch) {
        const delivered = await this.deliverWithRetry(alert);
        if (this.stopped && !delivered) return;
        this.store.setMetadata(CURSOR_KEY, String(alert.id));
      }
    }
  }

  /** Resolves true when delivered, false when skipped as permanent or stopped. */
  private async deliverWithRetry(alert: ValidatorAlert): Promise<boolean> {
    for (let attempt = 0; !this.stopped; attempt += 1) {
      const outcome = await this.deliver(alert);
      if (outcome === "delivered") return true;
      if (outcome === "permanent") return false;
      const delay = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * 2 ** attempt);
      console.warn(`Retrying webhook for alert ${alert.id} in ${Math.round(delay / 1000)}s`);
      await this.sleep(delay);
    }
    return false;
  }

  private async deliver(alert: ValidatorAlert): Promise<"delivered" | "retry" | "permanent"> {
    const body = JSON.stringify(alert);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-staker-watchdog-delivery": String(alert.id),
      "x-staker-watchdog-timestamp": timestamp
    };
    if (this.options.secret) {
      headers["x-staker-watchdog-signature"] =
        `v1=${signWebhookPayload(this.options.secret, timestamp, body)}`;
    }
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(this.timeoutMs),
          this.stopController.signal
        ])
      });
      if (response.ok) return "delivered";
      const transient = response.status === 408 || response.status === 429 ||
        response.status >= 500;
      if (transient) {
        console.error(`Webhook for alert ${alert.id} failed with HTTP ${response.status}`);
        return "retry";
      }
      console.error(
        `Webhook rejected alert ${alert.id} with HTTP ${response.status}; not retrying`
      );
      return "permanent";
    } catch (error) {
      if (this.stopped) return "retry";
      console.error(`Webhook for alert ${alert.id} failed:`, error);
      return "retry";
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const signal = this.stopController.signal;
      signal.addEventListener("abort", done, { once: true });
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  }
}

/** HMAC-SHA256 over `${timestamp}.${body}`, hex encoded. */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
