# Staker Watchdog

A small Solana validator data API and dashboard. It polls finalized vote-account state, shows inflation and block-revenue commission separately, tracks their collector accounts, and records changes over time.

## Run locally

Requirements: Node.js 22.9 or newer.

```sh
npm install
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:3000`. The first sync can take a short while, depending on RPC service latency and mainnet validator count. The SQLite database is created at `.data/staker-watchdog.sqlite`; project data stays in this directory.

For production, build a deployment around `npm start` and inject environment variables through the hosting platform. The server binds to `127.0.0.1` by default; set `HOST=0.0.0.0` when it must accept connections from outside its container or host.

## Database and persistence

The project uses embedded SQLite through `better-sqlite3`; it does not require a database server or a separate account. By default, `DATABASE_PATH=.data/staker-watchdog.sqlite` is resolved against the process working directory, so when started from this project root the live database file is [`.data/staker-watchdog.sqlite`](./.data/staker-watchdog.sqlite). The server creates the parent directory automatically. `.data/` is ignored by Git to keep runtime data out of source control.

The file persists across restarts and contains the latest row for each validator, detected commission/collector/status changes, meaningful validator state history, and sync metadata (last successful sync time, finalized slot, epoch, and count). It is local to this checkout by default; it is not automatically copied to a cloud database. Back it up before deleting the checkout or changing `DATABASE_PATH`. SQLite runs in WAL mode while the service is open, so use SQLite's online backup mechanism (or stop the service first) rather than copying only the main file during writes.

The development smoke test has already populated the default local database. It is disposable runtime state, not a keypair or a required project source file.

## Project documentation

- [Architecture](./docs/ARCHITECTURE.md) — system context, runtime components, sync flow, data model, and trust boundaries.
- [Product overview](./docs/PRODUCT.md) — audience, features, score interpretation, alert semantics, limitations, and product scope.
- [Development log](./docs/DEVLOG.md) — implementation sequence, discovered bugs, decisions, and validation record.
- [Technical reference](./docs/TECHNICAL.md) — stack, RPC protocols, VoteState decoding, API behavior, database schema, runtime configuration, and operational boundaries.
- [Integrations](./docs/INTEGRATIONS.md) — webhooks (what they are, where they are used, how to write a receiver), plus SSE live events, desktop notifications, the JSON API, and the Solana RPC dependency.
- [Product walkthrough video](./media/staker-watchdog-product-walkthrough.mp4) — ~19 s silent tour built from real screenshots of the dashboard.
- [Launch video](./media/staker-watchdog-launch.mp4) — ~18 s silent launch cut with live mainnet figures. Regenerate both with `node media/generate-videos.mjs` (see [media/README.md](./media/README.md)).

## What is monitored

- `getVoteAccounts` provides stake, liveness, and the legacy inflation commission view.
- Vote accounts are fetched in batches and their program owner checked before decoding. The leading `u32` is the bincode `VoteStateVersions` enum tag (`0` = V0_23_5, `1` = V1_14_11, `2` = V3, `3` = V4); the API's `voteStateVersion` reports the layout version (`0`, `1`, `3`, `4`).
- `VoteStateV4` account data provides the full-basis-point inflation and block-revenue commissions, plus separate collector addresses. For legacy vote states, the API uses the [accepted Vote Account v4 migration defaults](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0185-vote-account-v4.md) (inflation commission from the legacy commission, block-revenue commission 100%, inflation collector = vote account, block-revenue collector = validator identity) and marks them as `legacy_migration_default`. Unknown account versions are not guessed. An account that cannot be read in a sync (missing, wrong owner, unknown tag) is logged and keeps its last decoded configuration; it does not stop the rest of the sync.
- The first successful sync establishes the alert baseline. Subsequent commission, collector, and current/delinquent status changes are stored in SQLite, with a baseline and meaningful state transitions available to validator profiles. An optional `ALERT_WEBHOOK_URL` receives one signed JSON POST per detected change (see [Webhooks](#webhooks)).
- Validators that drop out of `getVoteAccounts` are marked `inactive` with a status alert and keep their last observed configuration. If one sync would remove more than 20% of active validators, removals are skipped as a likely truncated RPC response.
- Failed or empty RPC snapshots do not replace the last good database snapshot. Polling errors are logged; webhook deliveries retry until they succeed.

## Workflow

```mermaid
flowchart TD
    start([Service starts]) --> init[Open SQLite and initialize service]
    init --> api[Serve REST API, SSE, and dashboard continuously]
    api <-->|HTTP API + SSE| browser[Browser dashboard]
    browser --> local[Keep watchlist and preferences in browser storage]
    init --> poll[Run initial validator sync]
    poll --> rpc[Fetch finalized vote accounts, slot, and epoch]
    rpc --> batches[Fetch vote-account data in batches]
    batches --> validate{RPC response envelope valid?}
    validate -- No --> fail[Log sync error; keep last good snapshot]
    fail --> wait[Wait for next poll interval]
    validate -- Yes --> decode[Decode each VoteState and apply legacy defaults;<br/>unreadable accounts keep last known values]
    decode --> score[Calculate commission comparison score]
    score --> tx[Persist snapshot in SQLite transaction]
    tx --> compare[Compare with previous validator state;<br/>mark missing validators inactive]
    compare --> changes{Detected changes?}
    changes -- Yes --> record[Save alerts and history]
    changes -- No --> metadata[Update sync metadata]
    record --> metadata
    metadata --> publish[Publish committed sync update over SSE]
    publish --> webhook{Webhook configured and alerts found?}
    webhook -- Yes --> send[Wake background dispatcher:<br/>signed POSTs in order, retried until delivered]
    webhook -- No --> wait
    send --> wait
    wait --> poll

```

The `commissionScore` is only a comparison aid: `100 - average(inflation commission %, block-revenue commission %)`, clamped to the protocol's effective 0–100% range. Thus both revenue types count equally. It is **not** an estimate of total validator revenue, uptime, reliability, or overall quality; no public RPC field supplies an investor-specific mix of rewards and block revenue.

## API

API data endpoints return JSON; `/api/events` is a Server-Sent Events stream. Public endpoints are free with a per-IP default limit of 120 requests per 15 minutes (IPv6 clients are grouped per /64; `/api/health` is not limited). Requests carrying an unrecognised `X-API-Key` count against the caller's free limit and receive `401`, or `429` once the limit is used.

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Sync timestamp, finalized slot/epoch, count, and staleness |
| `GET /api/validators` | List data with `q`, `status=current\|delinquent\|inactive\|watchlist` (inactive validators are hidden unless requested or watched), `sort=stake\|commission\|inflation\|blockRevenue\|status`, `direction=asc\|desc`, optional `inflationWeight=0..100` for personalized commission sorting, `limit` (max 1000), `offset`, and repeated `watchlist` addresses (max 100) |
| `GET /api/validators/:votePubkey` | One validator record |
| `GET /api/validators/:votePubkey/history` | Baseline and observed meaningful configuration/status transitions |
| `GET /api/alerts?limit=50&offset=0` | Recent commission, collector, and status changes (limit max 200; optionally filtered by repeated `watchlist` addresses) |
| `GET /api/events` | Server-sent events for successful monitor syncs (max `SSE_MAX_CONNECTIONS_PER_CLIENT` streams per client, `SSE_MAX_CONNECTIONS` in total) |

The dashboard adds a validator detail route and profile, commission-history chart, full addresses, sorting, 25-row pagination, and a browser-local watchlist. Watchlist entries, commission-mix slider, alert preferences, and notification cursor are stored in this browser's `localStorage`; they are not sent to the server unless their addresses are included as explicit API filters. Optional desktop notifications require the user's browser permission. The browser score can use a chosen inflation/block-revenue weight; the public `commissionScore` remains the documented 50/50 comparison.

List entries include `votePubkey`, `nodePubkey`, `voteStateVersion`, `commissionSource`, `activeStakeLamports` (decimal string, preserving u64 precision), both commission rates in basis points, both collector addresses, status, and `commissionScore`. A field unavailable from the on-chain state is `null`.

### Institutional API keys

This MVP leaves billing out of the product. Configure provisioned keys using `STAKER_API_KEYS=<key>:institution,<another-key>:institution` and send them in `X-API-Key`. Keys must be at least 32 characters (generate one with `openssl rand -hex 24`); the server refuses to start with a shorter key. Keys are hashed in memory; invalid supplied keys receive `401` and are charged to the caller's free per-IP limit. Configured keys get the `PAID_RATE_LIMIT` request allowance per 15-minute window (default 6000), tracked per key. This is a manually provisioned higher-limit tier, not payment processing or a tenant-management system.

## Configuration

See [.env.example](./.env.example). `RPC_URL` should point to a trusted Solana mainnet RPC that allows `getVoteAccounts`, `getMultipleAccounts`, and `getEpochInfo`. Polling defaults to every five minutes. Alert webhooks are optional.

**Behind a reverse proxy or load balancer, set `TRUST_PROXY`** to the number of proxy hops (usually `1`) or to the proxy addresses/subnets. Without it every visitor appears to come from the proxy and shares one rate limit. `TRUST_PROXY=true` is rejected because it would let any client choose its own rate-limit bucket via `X-Forwarded-For`.

Every response carries a Content-Security-Policy and related security headers (plus HSTS when served over HTTPS). Fonts are self-hosted under `public/fonts` (SIL OFL), so the dashboard makes no third-party requests.

### Webhooks

When `ALERT_WEBHOOK_URL` is set, each alert is POSTed as JSON in alert-id order by a background dispatcher, so slow receivers never delay syncing. Network errors, `408`, `429`, and `5xx` responses are retried with exponential backoff (5 s up to 5 min) until delivered; other `4xx` responses are logged and skipped. The last delivered id is stored in SQLite, so delivery resumes after a restart (on first start it begins with new alerts only). Each request includes:

| Header | Value |
| --- | --- |
| `X-Staker-Watchdog-Delivery` | Alert id; use it to ignore duplicate deliveries |
| `X-Staker-Watchdog-Timestamp` | Unix seconds when the request was signed |
| `X-Staker-Watchdog-Signature` | `v1=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"` keyed with `ALERT_WEBHOOK_SECRET` (sent only when the secret is set) |

Receivers should recompute the HMAC over the raw body, compare in constant time, and reject stale timestamps.

## Validation

```sh
npm test
npm run typecheck
```
