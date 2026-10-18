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

## 2026-10-18 — QA and security pass

An end-to-end QA run (live mainnet reads, a controllable mock RPC, HTTP probes, and a headless-browser pass) found correctness and security problems that the existing unit tests could not catch, because those tests encoded the same assumptions as the code.

### Bugs found and fixed

1. **Vote-state version misread (critical).** The leading `u32` of a vote account is the bincode `VoteStateVersions` enum tag (0 = V0_23_5, 1 = V1_14_11, 2 = V3, 3 = V4), not a version number. The decoder expected `4` for V4 and treated tag `3` as legacy, so every mainnet account (all V4) was labelled `legacy_migration_default` and showed default collectors and 100% block-revenue commission regardless of on-chain values; on-chain changes to those fields produced no alerts. The earlier "mainnet is still on version 3" observation was this misreading. A live check found 28 custom block-revenue collectors and 2 custom inflation collectors that the old build hid. The decoder now maps tags to layout versions (API `voteStateVersion` 0/1/3/4) and is tested against a real mainnet account fixture.
2. **One bad account halted all monitoring.** An unknown tag or wrongly owned account threw and failed the whole sync. Failures are now per account: logged, with the validator's last decoded configuration carried forward. Only envelope-level RPC errors and empty snapshots fail a sync.
3. **Transient gaps erased data and hid changes.** A missing account overwrote stored commissions/collectors with `null`, and a change made during the gap was never alerted. Carry-forward fixes both.
4. **Departed validators stayed "current" forever.** Validators missing from `getVoteAccounts` are now marked `inactive` with a status alert, guarded against truncated RPC responses (no removals if more than max(10, 20%) would disappear at once). The list hides them by default; the dashboard has an Inactive filter.
5. **Invalid API keys bypassed the rate limit.** They got `401` before being counted, allowing unlimited key guessing. They are now charged to the caller's free bucket. Keys must be at least 32 characters; IPv6 clients are bucketed per `/64`; `TRUST_PROXY` (hop count or address list; `true` rejected) makes per-client limits work behind a proxy.
6. **Unbounded SSE connections.** Streams are now capped per client (`SSE_MAX_CONNECTIONS_PER_CLIENT`, default 10) and in total (`SSE_MAX_CONNECTIONS`, default 1000).
7. **Webhooks blocked syncs and lost alerts.** Sequential 10-second POSTs ran inside the sync and failures were dropped. `src/webhook.ts` now delivers from the `alerts` table as an outbox with a metadata cursor: ordered, at least once, retried with capped backoff, HMAC-signed with `ALERT_WEBHOOK_SECRET`, and independent of the poll loop.
8. **Missing security headers and stack-trace leak.** Added CSP and related headers on every response; replaced Express's default error page, which returned stack traces and absolute file paths. Malformed URLs now return `400` instead of `500`, and unknown `/api` routes return JSON `404`.
9. **Dashboard issues.** The commission-increase threshold never saved (its listener was unreachable code after a `return`). Normal use could exhaust the free limit (60-second polling, plus two requests per slider step on a profile) and then showed "OFFLINE"; refreshes are now SSE-driven with fallback polling only while the stream is down, local re-rendering for slider/watch/category changes, and a "RATE LIMITED · retrying in …" state. Stale detail responses are discarded, remaining unescaped interpolations are escaped, and the loading-row colspan and "Config changes" label are corrected. A browser walkthrough on live mainnet data then found that deep links (`/validator/:votePubkey`) scrolled to the profile before the directory above it rendered, leaving the profile off-screen; phones hid every commission column behind an unmarked horizontal scroll; empty filters always said "No validators match this search"; and one sync that recorded two event types showed as duplicate timeline entries and chart points. The profile now opens after the first directory render, rows become labelled cards at ≤600px, empty states are filter-specific, and same-sync history rows are grouped.
10. **Third-party font requests.** Google Fonts exposed every visitor's IP address to Google despite the "not uploaded" promise. DM Sans and DM Mono are now self-hosted from `public/fonts` (SIL OFL).

### Structure

`src/server.ts` is now a thin bootstrap. HTTP concerns moved to `src/app.ts` (`createApp`) so they can be tested without starting the poller, and environment parsing moved to `src/config.ts`, which refuses unsafe configuration at startup.

### Upgrade note

On the first successful sync after upgrading an existing database, every validator gets a `source_change` history row (legacy default → `vote_state_v4`), and validators with custom collectors get one-time collector alerts. These are corrections of previously hidden values, not new on-chain changes. A webhook configured at upgrade time will receive them.

### Verification

- 36 tests pass, including new HTTP (`test/app.test.ts`), webhook (`test/webhook.test.ts`), real-fixture decoding, per-account failure, carry-forward, and inactive-detection tests. Reintroducing the tag bug or the invalid-key bypass makes the relevant tests fail.
- The original failing scenarios were replayed against a mock cluster: block-revenue and collector changes alert, one bad account no longer stalls syncs, departed validators become inactive, webhooks recover after a receiver outage with valid signatures, bogus keys hit `429`, and SSE streams stop at the cap.
- Headless Chrome loaded the dashboard under the CSP with no console errors and no third-party requests.
- A sync against live mainnet, run on a copy of the local database, decoded all 681 accounts as V4.

## 2026-10-18 — Live database upgrade, browser walkthrough, media, and docs

- **Local database upgraded.** After a backup to `.data/staker-watchdog.pre-fix-backup-2026-10-18.sqlite`, one sync with the fixed decoder relabelled all 681 validators as `vote_state_v4` and recorded 30 one-time collector corrections and a genuine delinquency change, as described in the upgrade note above.
- **Browser walkthrough on live data** (desktop 1440px and phone 390px, headless Chrome): every flow worked with no console errors or failed requests. It found four UI problems (deep-link scroll race, hidden mobile columns, misleading empty-filter text, duplicated same-sync history entries), all fixed and recorded in item 9 above.
- **Videos replaced.** The earlier illustrated mockups were replaced by videos built from real screenshots of the running dashboard (`media/generate-videos.mjs`): an 18.6 s, six-scene walkthrough with crossfades and an 18.2 s launch cut with slow zooms and varied transitions, both silent 1280×720 H.264 under 1.3 MB. Launch figures come from the live service at capture time. The total alert count was deliberately left off the launch video because it includes the one-time upgrade corrections.
- **Docs.** Added [INTEGRATIONS.md](./INTEGRATIONS.md) covering webhooks, SSE, desktop notifications, the JSON API, and the RPC dependency, with a receiver example verified against the real dispatcher (a valid signature is handled once even when delivered twice; a wrong secret gets `401` and is skipped). Brought TECHNICAL, ARCHITECTURE, PRODUCT, and README up to date with these changes.

## Deliberate non-goals in this iteration

No wallet/keypair generation, transaction construction/signing, staking action, validator program, cloud DB, billing provider, customer management, external queue service, historical per-poll time series, synchronized cross-device account, or multi-instance deployment was added.
