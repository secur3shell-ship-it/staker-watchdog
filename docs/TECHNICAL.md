# Staker Watchdog — Technical reference

## Architecture

```text
Solana JSON-RPC (finalized)
       │
       ├── getVoteAccounts
       ├── getMultipleAccounts (base64, batches of 100)
       ├── getSlot
       └── getEpochInfo
       │
       ▼
  SolanaRpc ──► ValidatorMonitor ──► WatchdogStore ──► local SQLite
                       │                                  │
                       │              WebhookDispatcher ◄─┘ (alerts table as outbox)
                       │                     └── optional signed webhook POSTs
                       └── committed sync events ──► SSE clients

Browser ──HTTP/API + EventSource──► Express static dashboard + /api endpoints
```

The API server, periodic poller, and SQLite store run in one Node.js process. The browser consumes only the local service API. The application is read-only with respect to Solana: it constructs, signs, or submits no transactions.

## Runtime stack

| Area | Choice | Role |
| --- | --- | --- |
| Runtime | Node.js 22.9+ | Built-in `--env-file-if-exists`, Fetch API, AbortSignal timeouts, and server runtime |
| Language | TypeScript, strict compiler options | Typed API, RPC, monitor, store, and test code |
| Dev execution | `tsx` | Runs `.ts` entrypoint and watches source in development |
| HTTP | Express 5 | Static assets and JSON API routes |
| Database driver | `better-sqlite3` | Synchronous, embedded SQLite interface |
| Database | SQLite, WAL journal mode | Local validator snapshot, alerts, and sync metadata |
| Address encoding | `bs58` | Converts 32-byte public keys read from vote-account bytes to Base58 |
| Large-integer JSON | `json-bigint` | Preserves RPC u64 fields as strings instead of lossy JavaScript numbers |
| Tests | Node test runner + `tsx` | Unit and persistence tests |
| UI | Static HTML, CSS, browser JavaScript | No frontend build tool or client framework |

Dependency versions are recorded in [package.json](../package.json) and [package-lock.json](../package-lock.json).

## Solana protocols and state interpretation

### JSON-RPC transport

The service POSTs JSON-RPC 2.0 to the configured `RPC_URL`. It uses finalized commitment consistently:

- `getVoteAccounts({ commitment: "finalized" })` returns `current` and `delinquent` records, including vote key, node identity, activated stake, legacy integer commission, root/last-vote slots.
- `getMultipleAccounts(pubkeys, { commitment: "finalized", encoding: "base64" })` returns account metadata in `result.context` and accounts in `result.value`. The request is divided into batches of at most 100 vote-account keys.
- `getSlot({ commitment: "finalized" })` records the snapshot's finalized slot.
- `getEpochInfo({ commitment: "finalized" })` records the epoch.

Each non-null vote account is checked for the canonical vote-program owner `Vote111111111111111111111111111111111111111` before the account data is decoded. RPC response shape, HTTP status, JSON-RPC errors, account owner, and base64 metadata are validated. A failed fetch or malformed RPC envelope prevents the snapshot from being written. A problem with one individual account (missing, wrong owner, unknown state tag, malformed data) is reported per account instead: it is logged as a warning and does not stop the other validators from being synced (see [Poller, alerts, and failure behavior](#poller-alerts-and-failure-behavior)).

Large integer JSON values are parsed losslessly. In the API, activated stake is exposed in lamports as a decimal string; clients must not assume it is a JavaScript-safe integer. The UI converts lamports with `BigInt` before formatting SOL.

### Vote account versions

Vote accounts hold a bincode-serialized `VoteStateVersions` enum, so the leading `u32` is the **enum variant index**, not the layout's version number:

| Tag (`u32` at `0..4`) | Variant | API `voteStateVersion` | Handling |
| --- | --- | --- | --- |
| `0` | `V0_23_5` | `0` | Legacy migration defaults |
| `1` | `V1_14_11` | `1` | Legacy migration defaults |
| `2` | `V3` | `3` | Legacy migration defaults |
| `3` | `V4` | `4` | Decoded from account bytes |

The API's `voteStateVersion` is the layout version in the third column, not the raw tag. (Before 2026-10-18 the code read tag `3` as a legacy V3 account, so every mainnet V4 account was labelled `legacy_migration_default` and its on-chain collectors were hidden behind defaults.)

For VoteStateV4, the fixed header is decoded little-endian from the vote program's serialized account data. The relevant offsets in the current documented layout are:

| Byte range / offset | Field |
| --- | --- |
| `0..4` | `VoteStateVersions` enum tag (`u32`, `3` for V4) |
| `4..36` | Validator node identity pubkey |
| `36..68` | Authorized withdrawer pubkey |
| `68..100` | Inflation-rewards collector pubkey |
| `100..132` | Block-revenue collector pubkey |
| `132..134` | Inflation-rewards commission, basis points (`u16`) |
| `134..136` | Block-revenue commission, basis points (`u16`) |

At least 144 bytes are required before reading the v4 fixed fields. Public keys are Base58-encoded after decoding. Unknown tags are rejected for that account rather than interpreted as an older or newer layout. The decoder is tested against a real finalized mainnet V4 account ([`test/fixtures/mainnet-vote-account-v4.json`](../test/fixtures/mainnet-vote-account-v4.json)), cross-checked against the independent `getVoteAccounts` commission.

Protocol references:

- [Accepted SIMD-0185: Vote Account v4](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0185-vote-account-v4.md) defines v4 and migration defaults.
- [SIMD-0232: Custom Commission Collector Account](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0232-custom-commission-collector.md) describes explicit collector selection.
- [SIMD-0291: Commission Rate in Basis Points](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0291-commission-rate-in-basis-points.md) describes basis-point commission rates.
- [Solana `getVoteAccounts` RPC](https://solana.com/docs/rpc/http/getvoteaccounts) and [getAccountInfo/RPC reference](https://solana.com/docs/rpc/http/getaccountinfo) document RPC account data conventions.

The monitor's legacy migration handling follows SIMD-0185: commission from the existing RPC commission, block-revenue commission of 10,000 bps, inflation collector = vote account, block-revenue collector = current node identity. `commissionSource` makes this inferred-from-protocol default visible. V4 values come from account bytes and use `vote_state_v4`.

### Commission score

The scorer takes the two rates in basis points and computes:

```text
effectiveInflationBps = min(inflationBps, 10000)
effectiveBlockBps     = min(blockRevenueBps, 10000)
score                 = roundTo1Decimal(
  100 - (effectiveInflationBps + effectiveBlockBps) / 200
)
```

Invalid or negative rates and incomplete inputs produce `null`. The score weights the categories equally because the service has no investor-specific revenue composition or stake policy. It does not estimate yield or validator quality.

## Local database and persistence

The application uses SQLite via `better-sqlite3`; no PostgreSQL/MySQL service is installed or required. `DATABASE_PATH` defaults to `.data/staker-watchdog.sqlite` and is resolved with Node's `resolve()` from the process current working directory. Running commands from the project root makes the database file:

```text
.data/staker-watchdog.sqlite
```

In this workspace, the actual absolute file is:

```text
/home/rishi/Projects/staker-watchdog-test-copilot/.data/staker-watchdog.sqlite
```

The server creates the parent directory, enables `journal_mode = WAL`, and applies a small schema migration to add `vote_state_version` and `commission_source` columns when opening an older validators table.

### Tables

#### `validators`

One upserted row per vote-account address. Includes identity, state version and source, `current`/`delinquent`/`inactive` status, exact activated stake string, both commissions, both collectors, root and last-vote slots, the comparison score, and last update time. This is a **latest-state table**, not an append-only time series.

#### `alerts`

Append-only observed changes to the two commissions, two collectors, and `current`/`delinquent`/`inactive` status. The table also serves as the webhook outbox (see below). Each row contains a monotonically allocated ID, vote and node pubkeys, changed field name, previous/new string values, and detection timestamp. There is no automatic retention/deletion job in this MVP.

#### `validator_history`

Per-validator observed history. The first sync stores a `baseline` row. Later rows are written only when a monitored commission/collector value changes or status, validator identity, or data source changes. A row captures the resulting commissions, collectors, source, status, observed finalized slot, and timestamp. If an existing database predates the history table, its current validator rows are inserted as historical baselines during the next successful sync before changes are recorded. This is **poll-observed history**, not a full chain event history: transient changes that occur and revert between polls cannot be recovered.

#### `metadata`

Key/value record for last successful sync timestamp, finalized slot, finalized epoch, active validator count, and `webhook_delivered_alert_id` (the webhook delivery cursor, present once a webhook is configured).

### Scope, backup, and deletion

The default database belongs to this project checkout and is excluded from Git by `.gitignore`. It survives application restarts and is not automatically uploaded or synchronized elsewhere. It is runtime data, separate from source code and separate from Solana keys (this application does not create or store a keypair).

Changing `DATABASE_PATH` starts/opens another database file; it does not move or migrate data from the old path. Preserve or explicitly back up the old file before changing paths or deleting the project. Because WAL mode may create adjacent `-wal` and `-shm` files while the process is active, use SQLite's backup facility or stop the service before copying the database file at the filesystem level.

### Observed local contents at documentation time

The smoke test created the default database and synced 681 validator records. After the 2026-10-18 upgrade sync it contained 681 rows in `validators`, 1,396 rows in `validator_history` (baselines, the one-time `source_change` rows, and later transitions), 35 rows in `alerts` (30 one-time collector corrections from the upgrade plus status changes), and four rows in `metadata` (no webhook cursor, because no webhook is configured). A pre-upgrade copy is kept as `.data/staker-watchdog.pre-fix-backup-2026-10-18.sqlite`. These are ephemeral values that change with RPC polling, not a schema guarantee.

## HTTP API

API paths are rooted at `/api`. Unless noted, a supplied invalid `X-API-Key` returns `401` (and is counted against the caller's free limit); requests over a limit return `429` and `Retry-After`. Unknown `/api` routes return `404 { error: "not_found" }`; malformed requests such as invalid percent-encoding return `400 { error: "bad_request" }`.

| Route | Response / behavior |
| --- | --- |
| `GET /api/health` | `ok`, last sync timestamp, slot, epoch, active validator count, total change count, and `stale` flag |
| `GET /api/validators` | `{ data, meta }`; defaults to 500, max 1000; `q` searches vote/node addresses; `status` filters `current`/`delinquent`/`inactive`/`watchlist` (without `status`, inactive validators are omitted; `watchlist` includes them); repeated `watchlist` addresses filter a watched list (max 100); `sort` accepts `stake`, `commission`, `inflation`, `blockRevenue`, or `status`; `direction=asc|desc`; `offset` paginates; `inflationWeight=0..100` optionally makes commission sorting match a local mix (default 50) |
| `GET /api/validators/:votePubkey` | `{ data, tier }` or `404 { error: "validator_not_found" }` |
| `GET /api/validators/:votePubkey/history?limit=100` | Observed baseline and meaningful state transitions (max 500) or validator 404 |
| `GET /api/alerts` | `{ data, meta }`; defaults to 50, max 200, accepts `offset`; optional repeated `watchlist` addresses filter (max 100); `watchlistOnly=true` with no address returns an empty list |
| `GET /api/events` | `text/event-stream`; sends `connected`, then `update` events after successful committed syncs. `429 too_many_event_streams` above the per-client cap; `503 event_stream_capacity_reached` (with `Retry-After: 60`) above the total cap |

Validator fields are defined in [`ValidatorSnapshot`](../src/types.ts). Commission values use integer basis points (e.g. `1250` = 12.5%). When a value is not available, it is `null`. Sorts keep unknown commission scores/rates last in either direction; stake comparisons use `BigInt` so u64 ordering remains precise.

Health is intentionally registered before the API rate-limit middleware, so it is currently unauthenticated and not counted against those API limits. Validator, history, alert, and SSE endpoints are behind the middleware.

### Response headers and errors

Every response (static and API) carries a Content-Security-Policy (`default-src 'none'`; `script-src`, `style-src`, `font-src`, `connect-src 'self'`; `img-src 'self' data:`; `base-uri 'none'`; `form-action 'none'`; `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, and a restrictive `Permissions-Policy`. `Strict-Transport-Security` is added when Express sees the request as secure (HTTPS, or HTTPS at a trusted proxy). The dashboard uses no inline scripts or styles and self-hosts its fonts (`public/fonts`, DM Sans and DM Mono latin WOFF2 from `@fontsource` 5.3.0, SIL OFL), so it makes no third-party requests.

Express's default error page, which echoed stack traces and absolute file paths, is replaced: API errors return the JSON bodies above (500s are logged and return `internal_server_error`), and non-API errors return plain status text such as `Bad Request`.

### Live events

`/api/events` uses Server-Sent Events (one-way HTTP streaming; no WebSocket server). When a database transaction successfully commits a full sync, connected clients receive an `update` JSON event containing `slot`, `epoch`, `validatorCount`, `syncedAt`, and the alert rows created for that sync. A comment heartbeat is sent every 25 seconds. Disconnected clients are removed; EventSource clients reconnect and refresh through the normal JSON APIs. Events are not retained/replayed by SSE itself; the SQLite alert/history endpoints are the durable read path. API limits count an SSE connection at request-open time, not continuously for the whole stream, so open streams are capped separately: `SSE_MAX_CONNECTIONS_PER_CLIENT` (default 10, keyed by the same identity as the rate limiter) and `SSE_MAX_CONNECTIONS` (default 1000 in total). A client whose write buffer fills during an update or heartbeat is closed.

The dashboard refreshes on each SSE `update` (and once after reconnecting). It polls only while the stream is down, every 2 minutes; if the server refuses the stream (for example the per-client cap), the dashboard switches to that periodic mode and retries the stream after 5 minutes. Weight-slider, watch-star, and alert-category changes re-render already-loaded data instead of refetching; only a commission-score sort makes a debounced request. A `429` shows `RATE LIMITED` with the retry time and reloads after `Retry-After`, keeping already-rendered data on screen; health metrics still render because `/api/health` is not limited. Detail-panel responses that arrive after a newer request (or after closing the panel) are discarded.

### Dashboard layout notes

- A deep link (`/validator/:votePubkey`) opens the profile only after the first directory render, so the directory above it cannot push the profile out of view.
- At widths of 600px and below, directory rows become labelled cards (every field visible, no horizontal scrolling); wider screens keep the table.
- Empty states are specific to the active filter or search (for example, "No inactive validators").
- History rows recorded by the same sync (for example `configuration_change` and `source_change`) are shown as one timeline entry and one chart point.

### Browser-local personalization

The browser stores watchlist vote pubkeys in `stakerWatchdog.watchlist.v1`, preferences in `stakerWatchdog.preferences.v1`, and the processed-notification cursor in `stakerWatchdog.lastAlertId.v1` using `localStorage`. Watchlists are capped at 100 addresses. Preferences cover commission-mix weight, watched-only alert view, commission/collector/status event categories, and a minimum commission-increase threshold in basis points (default 100 bps). These values are not written to SQLite and there is no account sync.

The UI includes only selected watchlist pubkeys as explicit API query filters. The backend bounds those filters to 100 addresses and uses parameterized SQL for alert filtering. Browser Notification permission is requested only after the user clicks the enable button. Notifications apply to new live `update` events for watched validators and enabled alert categories. Commission notifications are increase-only and use the configured minimum basis-point delta; collectors and current/delinquent changes use their own category toggles. On initial load, the cursor is initialized from existing alert data to avoid popping old changes as new. The user’s personal commission mix modifies the browser display only; it never modifies `commissionScore` returned by the API.

## API tier mechanics

- Free requests are keyed to Express's `request.ip`, default limit 120 per 15 minutes. IPv6 clients share a bucket per `/64` (a single host usually controls a whole `/64`); IPv4-mapped IPv6 addresses are normalised to IPv4.
- `request.ip` honours `X-Forwarded-For` only when `TRUST_PROXY` is set to a hop count (e.g. `1`) or a list of proxy addresses/subnets, passed to Express's `trust proxy`. Without it, every client behind a reverse proxy shares the proxy's bucket. `TRUST_PROXY=true` is rejected at startup because it would trust spoofed headers and let callers choose their own bucket.
- Requests with an unrecognised `X-API-Key` are charged to the caller's free bucket before the `401`, so key guessing is rate limited like any other request (and gets `429` once the bucket is exhausted).
- Institutional keys are supplied through `STAKER_API_KEYS`, as comma-separated `key:tier` pairs. Keys must be at least 32 characters (generate with `openssl rand -hex 24`) and the tier must not be `free`; otherwise the server refuses to start.
- Clients send a key in the `X-API-Key` header.
- The process stores only SHA-256 key hashes in its in-memory key map; raw key strings are read from the environment at startup, not saved in SQLite.
- Configured non-free keys are counted per key; default `PAID_RATE_LIMIT` is 6000 per 15 minutes.
- Rate counters are in-memory and reset on process restart. This is one-instance MVP enforcement, not durable billing/accounting.
- Billing, key issuance UI, account lifecycle, usage invoices, and organization/tenant management are not implemented.

## Poller, alerts, and failure behavior

The poller starts immediately on server start, then repeats after `POLL_INTERVAL_MS` (default 300,000 ms). An in-flight guard prevents overlapping poll runs. A successful nonempty snapshot is atomically committed to the database; webhook delivery happens separately and never delays the next poll.

On a change, one alert row is inserted for each changed monitored commission/collector or status field. A baseline is required, and null-to-known data is not interpreted as a change. History records baseline plus meaningful configuration/status/identity/source transitions. SSE broadcasts only after the database commit.

Validators that stop appearing in `getVoteAccounts` (closed or fully unstaked vote accounts) are marked `inactive` with a `validator_status` alert and a `status_change` history row; their last observed configuration, stake, and `updatedAt` are kept. If one returns, the normal comparison emits an `inactive` → `current`/`delinquent` alert. As a guard against truncated RPC responses, a sync that would remove more than max(10, 20% of the active validators) skips all removals and logs a warning.

Individual accounts that cannot be read (missing, wrong owner, unknown tag, malformed data) are logged as a warning. The validator's status, stake, and slots still update, but its commissions, collectors, source, and version are carried forward from the last decoded state, so a transient gap neither erases data nor hides a change made during the gap (it is alerted once the account is readable again). A brand-new validator that is unreadable gets its inflation commission from `getVoteAccounts` and `null` for the other fields, with `commissionSource` `null`.

Poll errors (RPC errors, malformed RPC envelopes, and empty snapshots) are logged. A failed poll does not update the last-successful-sync metadata or replace the stored validator snapshot. `/api/health` reports stale when there has been no successful sync or the last one is more than two poll intervals old.

### Webhook delivery

When `ALERT_WEBHOOK_URL` (must be `http(s)`) is set, `WebhookDispatcher` delivers alerts from the `alerts` table, which acts as an outbox. The metadata key `webhook_delivered_alert_id` records the last delivered alert. The first time a dispatcher starts it sets this cursor to the newest existing alert, so history is not replayed. Delivery is in alert-id order, outside the poll loop, at least once, and resumes from the cursor after a restart.

Each POST body is one alert as JSON, with headers:

- `x-staker-watchdog-delivery`: the alert ID (use it to ignore duplicates).
- `x-staker-watchdog-timestamp`: Unix seconds.
- `x-staker-watchdog-signature`: `v1=` + hex HMAC-SHA256 of `${timestamp}.${body}` with `ALERT_WEBHOOK_SECRET`. Sent only when the secret is set; the server warns at startup if a URL is configured without one. Receivers should compare in constant time and reject old timestamps.

Network errors, `408`, `429`, and `5xx` responses retry with exponential backoff from 5 seconds up to 5 minutes, indefinitely, so a receiver outage delays but does not lose alerts. Other `4xx` responses are treated as permanent rejections: the alert is logged and skipped. Redirects are not followed.

[INTEGRATIONS.md](./INTEGRATIONS.md) explains webhooks for receiver authors, with a tested verification example, and compares them with SSE, desktop notifications, the JSON API, and the RPC dependency.

## Configuration and operations

See [`.env.example`](../.env.example). The key settings are:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listening port |
| `HOST` | `127.0.0.1` | Bind address; change to `0.0.0.0` only when external access is intended |
| `RPC_URL` | Public mainnet RPC | Trusted Solana JSON-RPC endpoint |
| `DATABASE_PATH` | `.data/staker-watchdog.sqlite` | SQLite file path (resolved from working directory) |
| `POLL_INTERVAL_MS` | `300000` | Poll interval |
| `FREE_RATE_LIMIT` | `120` | Requests per free IP (IPv6 `/64`) per 15-minute window |
| `PAID_RATE_LIMIT` | `6000` | Requests per provisioned key per 15-minute window |
| `STAKER_API_KEYS` | empty | Comma-separated `key:tier` entries; keys of at least 32 characters |
| `TRUST_PROXY` | off | Proxy hop count or address/subnet list for `X-Forwarded-For`; `true` is rejected |
| `SSE_MAX_CONNECTIONS` | `1000` | Total open event streams |
| `SSE_MAX_CONNECTIONS_PER_CLIENT` | `10` | Open event streams per IP bucket or API key |
| `ALERT_WEBHOOK_URL` | empty | Optional `http(s)` JSON POST target |
| `ALERT_WEBHOOK_SECRET` | empty | HMAC secret for signing webhook deliveries |

For container deployment, persist/mount the directory containing `DATABASE_PATH`; otherwise a replacement container can lose local state. `HOST=0.0.0.0` exposes the HTTP service on container interfaces and should be paired with the deployment's intended network controls. Behind a load balancer or reverse proxy, set `TRUST_PROXY` so rate limits apply per client rather than to the proxy.

## Tests and source map

```sh
npm test
npm run typecheck
```

- `src/rpc.ts`: JSON-RPC transport, account batching, and per-account read failures.
- `src/vote-account.ts`: enum-tag-to-version mapping and v4 binary decoding.
- `src/monitor.ts`: polling, legacy defaults, carry-forward of unreadable accounts, inactive detection, and score.
- `src/scoring.ts`: isolated score formula.
- `src/store.ts`: SQLite schema, migrations, latest snapshots, history, alerts, metadata.
- `src/webhook.ts`: outbox-style webhook dispatcher, retries, and HMAC signing.
- `src/config.ts`: environment parsing and startup validation (`loadConfig`, `parseApiKeys`, `parseTrustProxy`).
- `src/app.ts`: `createApp` — static/detail-route delivery, REST endpoints, security headers, rate limits, SSE caps, and error handlers.
- `src/server.ts`: thin bootstrap wiring config, store, monitor, dispatcher, and process lifecycle.
- `public/`: browser UI; `public/fonts/`: self-hosted fonts and licences.
- `media/generate-videos.mjs`: rebuilds both product videos from real screenshots of a running instance (see [`media/README.md`](../media/README.md)).
- `test/`: score, decoding (including a real mainnet V4 fixture), RPC-shape/precision, per-account failures, monitor carry-forward and inactive detection, alert, webhook delivery, HTTP limits/headers/errors, configuration, and schema-migration tests.
