# Staker Watchdog — Product overview

## One-line description

Staker Watchdog is a read-only Solana validator intelligence service that makes validator commission and reward-collector configuration easier for delegators to understand and monitor.

## Problem

Validator economics are not always represented by one commission percentage. New vote-account state supports separate commission rates for inflation rewards and block revenue, and allows revenue types to use different collector accounts. A staker looking only at the legacy commission value can miss how these revenue paths are configured or where validator commissions are directed.

The product's first job is to make those settings visible from on-chain vote-account state, not to guess at an investor's realized yield or rank validators on opaque criteria.

## Intended users

- **Retail SOL stakers** comparing validator configurations and looking for straightforward explanations.
- **Staking pools and liquid-staking teams** monitoring a managed set of vote accounts.
- **Custodians and treasury operators** reviewing delegation policy and watching for configuration changes.
- **Wallets, dashboards, and analytics providers** that want a small JSON API instead of building a vote-account indexer.

The public API is intended to remain usable without payment. The institutional tier in this MVP only adds a manually provisioned, higher API request allowance.

## User-facing features

### Validator directory

The web dashboard presents a searchable directory with:

- Vote-account address and validator identity (shortened for display; full values are available in API data and address tooltips where used).
- Current or delinquent state as returned by finalized `getVoteAccounts`, or `inactive` once a validator is no longer returned there (closed or fully unstaked).
- Inflation commission and block-revenue commission, shown independently.
- Separate inflation and block-revenue collector addresses.
- Active delegated stake, kept precise in the API as lamports represented by a decimal string.
- A personalized commission-only comparison score using the user's chosen reward mix.
- Search by vote account or validator identity; filters for current, delinquent, or inactive validators or the local watchlist (inactive validators are hidden from "All validators"); sorting by stake, commission score, either commission, or status; and 25-row pages.
- A bookmarkable validator profile at `/validator/:votePubkey` with full addresses, state-source disclosure, collector accounts, status, stake, and recent change history.
- On phones (600px and narrower), each validator is a labelled card so every field is visible without horizontal scrolling.

The directory is sourced from the service's local latest snapshot. It is not a direct browser-to-RPC query.

### Commission and collector watch

After the first successful poll establishes the baseline, the monitor records changes to:

1. Inflation commission.
2. Block-revenue commission.
3. Inflation-rewards collector.
4. Block-revenue collector.

The change log provides before/after values and the observation time. If configured, an operator-owned webhook gets a JSON POST for each detected change, signed with HMAC-SHA256 when `ALERT_WEBHOOK_SECRET` is set. Deliveries arrive in order and are retried until the receiver accepts them, so a receiver outage delays alerts rather than losing them. [INTEGRATIONS.md](./INTEGRATIONS.md) explains how to build a receiver and when to use the webhook, live events, notifications, or the API.

There are no alerts on the first-ever observation: the service cannot truthfully call an initial value a change. Current/delinquent/inactive transitions are also recorded as alerts; stake, identity, score, and source-version changes alone do not create change alerts (identity/source transitions are available in history).

### JSON API

The API exposes health and sync metadata, a filterable/sortable/paginatable validator list, lookup by vote address, per-validator observed history, a paginated alert list, and an SSE stream. See the [API section in the root README](../README.md#api) and the full [technical reference](./TECHNICAL.md#http-api).

### Observed history and charts

The service records a baseline on first observation, followed by meaningful state transitions instead of a row for every five-minute poll. The profile charts observed inflation and block-revenue rates and shows a timestamped timeline with finalized slot and collector values. Commission and collector changes and current/delinquent transitions are included. This is an observation log, not a complete historical account archive; it does not include state changes that happen and revert between polls.

### Browser-local watchlists and preferences

Users can star/unstar validators from the directory or profile. Watchlists are stored in this browser's `localStorage` and can filter the directory and change log. The browser also stores notification categories (commission, collector, and status), whether to show watched-only alerts, and the notification cursor. These preferences are not associated with a server account and do not synchronize to other devices.

Users may explicitly request desktop-notification permission. Notifications are limited to newly observed change events for watched validators whose categories are enabled. Commission notifications are increase-only, with a user-selected minimum increase in basis points (default 100 bps / 1%). Collector and status notifications follow their respective category switches. The site does not ask for notification permission automatically. The in-page change log remains the durable server-side record.

### Personalized comparison

The commission-mix slider lets the user choose the assumed share of value assigned to inflation rewards (the remainder is assigned to block revenue). The browser calculates a correspondingly weighted commission comparison. A 50/50 split matches the public API's canonical score; a user-selected mix is local and is not an APY or objective validator-quality metric.

### Live dashboard updates

The page opens a server-sent events connection. After a successful sync, the service emits the observed slot, epoch, validator count, timestamp, and alert events; the open page refreshes its API data immediately. EventSource reconnects automatically after interruption, and the page polls every two minutes only while the stream is down. Slider, watchlist-star, and alert-category changes redraw already-loaded data rather than spending API requests. If the free request limit is reached, the page shows "RATE LIMITED" with the retry time instead of claiming the service is offline.

## Reading legacy and v4 data

`commissionSource` communicates where the displayed fields came from:

- `vote_state_v4`: dual commission rates and collectors were read from the account's v4 state.
- `legacy_migration_default`: the vote account is on a legacy state version; fields are derived using the accepted Vote Account v4 migration defaults. This is not a claim the validator separately set each new field.
- `null`: no supported state interpretation was available (for example a new validator whose account could not be read); values are never silently invented. If an already-known validator's account becomes unreadable, its last decoded values are kept until it can be read again.

For the legacy path, the inflation commission comes from the RPC vote-account commission, block-revenue commission is the protocol migration default of 10,000 bps, inflation collector defaults to the vote-account address, and block-revenue collector defaults to the validator identity.

The dashboard labels these as legacy commission and protocol migration defaults. When validators move to v4, new explicit values are decoded from their vote-account state. As of 2026-10-18 every observed mainnet vote account is already V4; 28 use a custom block-revenue collector and 2 a custom inflation collector, while all block-revenue commissions are still 100%.

## Commission score

The public `commissionScore` is an intentionally small, explainable comparison aid:

```text
commissionScore =
  100 - (effective inflation commission percent
         + effective block-revenue commission percent) / 2
```

Each commission is converted from basis points and capped to its effective 0–100% range before averaging. The score is rounded to one decimal place. Higher means a lower equal-weighted average commission. A score is `null` when either path is unknown.

It is **not** an APY, yield forecast, validator-performance score, safety rating, uptime metric, or recommendation. The actual value of inflation rewards versus block revenue varies, and this MVP does not model an investor-specific revenue mix, vote credits, historical performance, fees, or risk preferences.

## Product and commercial scope

This build targets a weekend-sized validation of whether stakers and integrators find the data useful:

- Retail: free public API, with a configurable default rate limit.
- Larger integrations: provisioned API keys with a configurable higher request limit.
- Billing, checkout, recurring subscriptions, organization accounts, per-customer administration, service-level commitments, and paid alert delivery are intentionally not implemented.

There is no Solana program, wallet connection, staking flow, key custody, or transaction-signing feature. The product reads public chain state only.

## Current boundaries and next steps

- Uses one configured JSON-RPC endpoint. RPC provider availability, request quotas, and consistency affect freshness.
- Polls every five minutes by default; it is not a transaction-by-transaction real-time stream.
- Saves the latest validator snapshot, an initial profile baseline, and meaningful observed transitions; it does not retain every poll or observe changes that happen and revert between polls.
- Browser-local watchlists and notification preferences do not sync between browsers/devices and are not managed user accounts.
- Desktop notifications require browser permission and an open page; there is no push service or email delivery.
- Validator display labels are still addresses, not curated names; adding names requires a validated metadata source and attribution policy.
- Webhook delivery is at least once (receivers should deduplicate on the delivery ID). Receivers that permanently reject an alert with a `4xx` status skip that alert.
- API keys and rate counters are in-memory configuration/state. Keys are not tenant records and counters reset on restart. Deployments behind a proxy must set `TRUST_PROXY` for per-client limits.
- It is not yet an HA or horizontally scaled service; SQLite is a local single-instance store.
- Curated validator names/metadata, performance analytics, stake-delegator-specific yield estimates, server-managed profiles/preferences, and commercial billing remain outside this first release.
