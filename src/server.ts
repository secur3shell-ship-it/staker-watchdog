import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SolanaRpc } from "./rpc.js";
import { ValidatorMonitor } from "./monitor.js";
import { WatchdogStore } from "./store.js";
import { WebhookDispatcher } from "./webhook.js";

const config = loadConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });

const store = new WatchdogStore(config.databasePath);
const webhooks = config.webhookUrl
  ? new WebhookDispatcher(store, { url: config.webhookUrl, secret: config.webhookSecret })
  : undefined;
if (webhooks && !config.webhookSecret) {
  console.warn(
    "ALERT_WEBHOOK_URL is set without ALERT_WEBHOOK_SECRET; receivers cannot verify alerts"
  );
}
const { app, publishUpdate, close: closeApp } = createApp(store, config);
const monitor = new ValidatorMonitor(new SolanaRpc(config.rpcUrl), store, (update) => {
  publishUpdate(update);
  if (update.alerts.length) void webhooks?.kick();
});

const server = app.listen(config.port, config.host, () => {
  console.info(`Staker Watchdog listening on http://${config.host}:${config.port}`);
  console.info(`Using Solana RPC ${config.rpcUrl}`);
  if (config.trustProxy === false && config.host !== "127.0.0.1") {
    console.info(
      "TRUST_PROXY is not set; behind a reverse proxy every client will share one rate limit"
    );
  }
});

const runSync = (): void => {
  void monitor.sync().catch((error: unknown) => {
    console.error("Validator sync failed:", error);
  });
};
runSync();
// Deliver anything left undelivered by a previous run.
void webhooks?.kick();
const syncTimer = setInterval(runSync, config.pollIntervalMs);

function shutdown(): void {
  clearInterval(syncTimer);
  webhooks?.stop();
  closeApp();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
