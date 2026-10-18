# Staker Watchdog — Development log

This log records the product and engineering decisions made for this repository. It is project documentation, not a global preference or user profile.

## 2026-10-18 — Greenfield MVP

### Initial scope

The workspace was empty, so the implementation began as a standalone project rather than being grafted into another repository. The brief called for:

- Direct vote-account reads.
- Change alerts for both commissions and collector addresses.
- A score that accounts for both commission types.
- A free public/retail path and a plausible higher-volume institutional path.
- Weekend-sized scope rather than a full billing platform.

### Product decisions

- Built a static dashboard plus a JSON API and a background poller; no wallet or on-chain program was needed for this read-only data problem.
- Used a local SQLite file to keep snapshots and alert history without operating a separate database service.
- Implemented manually provisioned API keys and separate free/institution rate limits instead of introducing payment integration, merchant accounts, or subscription workflows.
- Made the score transparent, equally weighting the inflation and block-revenue percentages. Unknown inputs produce no score; the app does not substitute a made-up zero.
- Made the initial observation a baseline, not a false change alert.
- Documented legacy-state defaults and exposed their source on each validator record so defaults would not be presented as explicit v4 settings.

## Implementation and debugging record

### 1. Project scaffold and interfaces

Added a TypeScript/Node service, Express HTTP server, static HTML/CSS/JavaScript dashboard, SQLite persistence, environment template, and test/type-check scripts. The default bind is loopback (`127.0.0.1`) to avoid exposing a newly run development server to the LAN by default.

### 2. Direct Solana RPC ingestion

Implemented JSON-RPC calls for finalized `getVoteAccounts`, `getMultipleAccounts`, `getSlot`, and `getEpochInfo`. Vote accounts are fetched in bounded batches; account owner is checked against the vote program before interpreting account bytes.

**Live smoke-test bug found and fixed:** Solana's `getMultipleAccounts` response is an envelope containing `{ context, value: [...] }`, not a top-level array. The first version treated the envelope as an array and correctly failed the poll without overwriting the database. A live RPC shape check identified the mismatch; parsing and tests were updated to consume `result.value`.

**Precision issue found and fixed:** stake values and slots can be u64 values beyond JavaScript's exact integer range. JSON parsing now preserves large integer values as decimal strings, and the public API stores lamports as strings. The browser formats SOL using `BigInt`.

### 3. VoteState v4 and legacy behavior

Checked the accepted Vote Account v4 proposal and the Agave vote-state layout to implement an explicit v4 decoder for both commissions and both collectors.

**Initial mainnet gap found and fixed:** live mainnet vote accounts were still observed as state version 3 in the smoke test. Treating all non-v4 fields as `null` would have made the score unavailable and the directory much less useful. The monitor now uses the accepted protocol migration defaults for legacy states and returns `commissionSource: "legacy_migration_default"`. The dashboard labels those values as defaults. V4 accounts are labeled `vote_state_v4`; unsupported versions fail a snapshot rather than being guessed.

### 4. Snapshot and alerts

The store upserts one latest row per vote account. Each successful poll compares four configuration fields and validator status to the previous known values and inserts before/after alert rows atomically with the snapshot. Null-to-known transitions do not create false alerts. Empty poll responses are rejected to protect the last good snapshot.

Added optional webhook POST delivery after alert persistence. Delivery failures are logged explicitly and do not roll back the successful database snapshot.

### 5. Commercial boundary and HTTP behavior

Added free per-IP request limits and manually provisioned higher-limit API keys. Configured key strings are hashed in memory; invalid supplied keys get `401`. The response includes rate-limit headers. Billing and customer/tenant management were excluded to fit the requested small-market/weekend constraint.

Added validator filtering, bounded list pagination, recent alert pagination, and health metadata. Alert totals use the actual total count rather than only the displayed page size.

### 6. Data safety and maintainability

- SQLite uses WAL mode.
- New database columns are added with a small compatibility migration for an older local schema.
- API key configuration is externalized; `.env` and `.data/` are ignored by Git.
- UI output derived from network/account data is escaped where inserted as HTML.
- The server reports monitor/RPC errors rather than silently presenting an empty successful dataset.

### 7. Verification performed

- Unit tests covered commission scoring, v4 byte decoding, legacy version identification, lossless RPC u64 parsing, the `getMultipleAccounts` envelope, first-run baselines, commission/collector/status alerts, watchlist filtering, monitor update publishing, unknown-field behavior, and SQLite schema migration/backfill.
- TypeScript type-check completed successfully.
- Against the configured public mainnet RPC, the service synced 681 current+delinquent vote-account records in the observed live test and returned finalized slot/epoch metadata.
- HTTP smoke checks verified dashboard delivery, validator/health/alert endpoints, pagination, provisioned institutional API key headers, and invalid-key rejection.
- Browser smoke checks exercised bookmarkable validator details, chart/timeline data, browser watchlist filtering, personalized commission weights, and live SSE connection status.
- Smoke-test servers were stopped after verification. The local runtime database remains in this project's ignored `.data/` directory.

## 2026-10-18 — Product recommendations 1–5

Implemented the requested usability and live-data recommendations:

1. **Validator exploration:** added sortable columns, server-side 25-row pagination, a bookmarkable `/validator/:votePubkey` profile, full address/source details, collector information, and recent history.
2. **History:** added `validator_history` and per-validator history reads. It stores one baseline and then meaningful configuration/status/identity/source transitions, not every polling interval. Existing databases seed a baseline on their next successful sync before any newly observed transitions.
3. **Watchlists and alert preferences:** added browser-local watchlists, watchlist-only directory/log filters, category preferences for commission/collector/status events, a minimum commission-increase threshold, and opt-in desktop notifications for new watched-validator events. No account or preference table was introduced; user state stays in browser `localStorage`.
4. **Personalized commission mix:** added an inflation-versus-block-revenue weighting slider and local weighted comparison score. It does not mutate server data or the canonical equal-weighted API score.
5. **Dynamic UI:** added an SSE endpoint that publishes committed successful sync updates and their alerts; the dashboard refreshes from API data after events, and keeps a periodic fallback plus EventSource reconnect behavior.

The extension remains read-only and introduces no Solana program, wallet, or keypair. New tests cover history baselines, status transitions, and watchlist-filtered alerts. Documentation now distinguishes poll-observed history from complete chain history and browser preferences from server-side user accounts.

## Deliberate non-goals in this iteration

No wallet/keypair generation, transaction construction/signing, staking action, validator program, cloud DB, billing provider, customer management, retry queue, historical per-poll time series, synchronized cross-device account, or multi-instance deployment was added.
