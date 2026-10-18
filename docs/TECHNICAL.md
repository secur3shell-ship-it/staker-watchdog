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
                       │              │
                       │              └── optional webhook POSTs
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

Each non-null vote account is checked for the canonical vote-program owner `Vote111111111111111111111111111111111111111` before the account data is decoded. RPC response shape, HTTP status, JSON-RPC errors, account owner, and base64 metadata are validated. A failed fetch prevents the snapshot from being written.

Large integer JSON values are parsed losslessly. In the API, activated stake is exposed in lamports as a decimal string; clients must not assume it is a JavaScript-safe integer. The UI converts lamports with `BigInt` before formatting SOL.

### Vote account versions

For VoteStateV4, the fixed header is decoded little-endian from the vote program's serialized account data. The relevant offsets in the current documented layout are:

| Byte range / offset | Field |
| --- | --- |
| `0..4` | State version tag (`u32`, expected `4`) |
| `4..36` | Validator node identity pubkey |
| `36..68` | Authorized withdrawer pubkey |
| `68..100` | Inflation-rewards collector pubkey |
| `100..132` | Block-revenue collector pubkey |
| `132..134` | Inflation-rewards commission, basis points (`u16`) |
| `134..136` | Block-revenue commission, basis points (`u16`) |

At least 144 bytes are required before reading the v4 fixed fields. Public keys are Base58-encoded after decoding. Unknown state versions cause the monitor to report a sync error; it does not interpret them as an older or newer layout.

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

One upserted row per vote-account address. Includes identity, state version and source, current/delinquent status, exact activated stake string, both commissions, both collectors, root and last-vote slots, the comparison score, and last update time. This is a **latest-state table**, not an append-only time series.

#### `alerts`

Append-only observed changes to the two commissions, two collectors, and current/delinquent status. Each row contains a monotonically allocated ID, vote and node pubkeys, changed field name, previous/new string values, and detection timestamp. There is no automatic retention/deletion job in this MVP.

#### `validator_history`

Per-validator observed history. The first sync stores a `baseline` row. Later rows are written only when a monitored commission/collector value changes or status, validator identity, or data source changes. A row captures the resulting commissions, collectors, source, status, observed finalized slot, and timestamp. If an existing database predates the history table, its current validator rows are inserted as historical baselines during the next successful sync before changes are recorded. This is **poll-observed history**, not a full chain event history: transient changes that occur and revert between polls cannot be recovered.

#### `metadata`

Key/value record for last successful sync timestamp, finalized slot, finalized epoch, and validator count.

### Scope, backup, and deletion

The default database belongs to this project checkout and is excluded from Git by `.gitignore`. It survives application restarts and is not automatically uploaded or synchronized elsewhere. It is runtime data, separate from source code and separate from Solana keys (this application does not create or store a keypair).

Changing `DATABASE_PATH` starts/opens another database file; it does not move or migrate data from the old path. Preserve or explicitly back up the old file before changing paths or deleting the project. Because WAL mode may create adjacent `-wal` and `-shm` files while the process is active, use SQLite's backup facility or stop the service before copying the database file at the filesystem level.

### Observed local contents at documentation time

The smoke test created the default database and synced 681 validator records. At inspection time it contained 681 rows in `validators`, 681 initial baselines in `validator_history`, zero rows in `alerts`, and four rows in `metadata`. These are ephemeral values that change with RPC polling, not a schema guarantee.

## HTTP API

API paths are rooted at `/api`. Unless noted, a supplied invalid `X-API-Key` returns `401`; requests over a limit return `429` and `Retry-After`.

| Route | Response / behavior |
| --- | --- |
| `GET /api/health` | `ok`, last sync timestamp, slot, epoch, validator count, total change count, and `stale` flag |
| `GET /api/validators` | `{ data, meta }`; defaults to 500, max 1000; `q` searches vote/node addresses; `status` filters `current`/`delinquent`/`watchlist`; repeated `watchlist` addresses filter a watched list (max 100); `sort` accepts `stake`, `commission`, `inflation`, `blockRevenue`, or `status`; `direction=asc|desc`; `offset` paginates; `inflationWeight=0..100` optionally makes commission sorting match a local mix (default 50) |
| `GET /api/validators/:votePubkey` | `{ data, tier }` or `404 { error: "validator_not_found" }` |
| `GET /api/validators/:votePubkey/history?limit=100` | Observed baseline and meaningful state transitions (max 500) or validator 404 |
| `GET /api/alerts` | `{ data, meta }`; defaults to 50, max 200, accepts `offset`; optional repeated `watchlist` addresses filter (max 100); `watchlistOnly=true` with no address returns an empty list |
| `GET /api/events` | `text/event-stream`; sends `connected`, then `update` events after successful committed syncs |

Validator fields are defined in [`ValidatorSnapshot`](../src/types.ts). Commission values use integer basis points (e.g. `1250` = 12.5%). When a value is not available, it is `null`. Sorts keep unknown commission scores/rates last in either direction; stake comparisons use `BigInt` so u64 ordering remains precise.

Health is intentionally registered before the API rate-limit middleware, so it is currently unauthenticated and not counted against those API limits. Validator, history, alert, and SSE endpoints are behind the middleware.

### Live events

`/api/events` uses Server-Sent Events (one-way HTTP streaming; no WebSocket server). When a database transaction successfully commits a full sync, connected clients receive an `update` JSON event containing `slot`, `epoch`, `validatorCount`, `syncedAt`, and the alert rows created for that sync. A comment heartbeat is sent every 25 seconds. Disconnected clients are removed; EventSource clients reconnect and refresh through the normal JSON APIs. Events are not retained/replayed by SSE itself; the SQLite alert/history endpoints are the durable read path. API limits count an SSE connection at request-open time, not continuously for the whole stream.

The dashboard also retains a 60-second refresh fallback. It does not require SSE to keep the main directory functional.

### Browser-local personalization

The browser stores watchlist vote pubkeys in `stakerWatchdog.watchlist.v1`, preferences in `stakerWatchdog.preferences.v1`, and the processed-notification cursor in `stakerWatchdog.lastAlertId.v1` using `localStorage`. Watchlists are capped at 100 addresses. Preferences cover commission-mix weight, watched-only alert view, commission/collector/status event categories, and a minimum commission-increase threshold in basis points (default 100 bps). These values are not written to SQLite and there is no account sync.

The UI includes only selected watchlist pubkeys as explicit API query filters. The backend bounds those filters to 100 addresses and uses parameterized SQL for alert filtering. Browser Notification permission is requested only after the user clicks the enable button. Notifications apply to new live `update` events for watched validators and enabled alert categories. Commission notifications are increase-only and use the configured minimum basis-point delta; collectors and current/delinquent changes use their own category toggles. On initial load, the cursor is initialized from existing alert data to avoid popping old changes as new. The user’s personal commission mix modifies the browser display only; it never modifies `commissionScore` returned by the API.

## API tier mechanics

- Free requests are keyed to Express's `request.ip`, default limit 120 per 15 minutes.
- Institutional keys are supplied through `STAKER_API_KEYS`, as comma-separated `key:tier` pairs, for example `team-secret:institution`.
- Clients send a key in the `X-API-Key` header.
- The process stores only SHA-256 key hashes in its in-memory key map; raw key strings are read from the environment at startup, not saved in SQLite.
- Configured non-free keys are counted per key; default `PAID_RATE_LIMIT` is 6000 per 15 minutes.
- Rate counters are in-memory and reset on process restart. This is one-instance MVP enforcement, not durable billing/accounting.
- Billing, key issuance UI, account lifecycle, usage invoices, and organization/tenant management are not implemented.

## Poller, alerts, and failure behavior

The poller starts immediately on server start, then repeats after `POLL_INTERVAL_MS` (default 300,000 ms). An in-flight guard prevents overlapping poll runs. A successful nonempty snapshot is atomically committed to the database before webhook delivery.

On a change, one alert row is inserted for each changed monitored commission/collector or current/delinquent status field. A baseline is required, and null-to-known data is not interpreted as a change. History records baseline plus meaningful configuration/status/identity/source transitions. Webhooks run after commit; a webhook failure is logged and is not retried automatically. SSE broadcasts only after the database commit.

Poll errors (including RPC errors, malformed response/account data, unsupported vote-state versions, and empty snapshots) are logged. A failed poll does not update the last-successful-sync metadata or replace the stored validator snapshot. `/api/health` reports stale when there has been no successful sync or the last one is more than two poll intervals old.

## Configuration and operations

See [`.env.example`](../.env.example). The key settings are:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listening port |
| `HOST` | `127.0.0.1` | Bind address; change to `0.0.0.0` only when external access is intended |
| `RPC_URL` | Public mainnet RPC | Trusted Solana JSON-RPC endpoint |
| `DATABASE_PATH` | `.data/staker-watchdog.sqlite` | SQLite file path (resolved from working directory) |
| `POLL_INTERVAL_MS` | `300000` | Poll interval |
| `FREE_RATE_LIMIT` | `120` | Requests per free IP per 15-minute window |
| `PAID_RATE_LIMIT` | `6000` | Requests per provisioned key per 15-minute window |
| `STAKER_API_KEYS` | empty | Comma-separated `key:tier` entries |
| `ALERT_WEBHOOK_URL` | empty | Optional JSON POST target |

For container deployment, persist/mount the directory containing `DATABASE_PATH`; otherwise a replacement container can lose local state. `HOST=0.0.0.0` exposes the HTTP service on container interfaces and should be paired with the deployment's intended network controls.

## Tests and source map

```sh
npm test
npm run typecheck
```

- `src/rpc.ts`: JSON-RPC transport and account batching.
- `src/vote-account.ts`: version identification and v4 binary decoding.
- `src/monitor.ts`: polling, defaults, score, change and webhook orchestration.
- `src/scoring.ts`: isolated score formula.
- `src/store.ts`: SQLite schema, migrations, latest snapshots, history, alerts, metadata.
- `src/server.ts`: static/detail-route delivery, REST endpoints, rate limits, SSE, and process lifecycle.
- `public/`: browser UI.
- `test/`: score, decoding, RPC-shape/precision, alert, and schema-migration tests.
