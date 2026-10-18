const rows = document.querySelector("#validator-rows");
const alerts = document.querySelector("#alert-list");
const search = document.querySelector("#search");
const filters = [...document.querySelectorAll(".filter")];
const refreshButton = document.querySelector("#refresh");
const detailSection = document.querySelector("#validator-detail");
const pageSize = 25;
const watchlistKey = "stakerWatchdog.watchlist.v1";
const preferencesKey = "stakerWatchdog.preferences.v1";
const lastAlertKey = "stakerWatchdog.lastAlertId.v1";
let selectedStatus = "all";
let refreshBusy = false;
let refreshQueued = false;
let page = 0;
let sortBy = "stake";
let sortDirection = "desc";
let lastAlertId = Number(localStorage.getItem(lastAlertKey)) || null;
let lastValidators = null;
let lastAlerts = null;
let currentDetail = null;
let detailRequest = 0;
let fallbackTimer = null;
let rateLimitTimer = null;
let weightRefreshTimer;
const fallbackPollMs = 120_000;

class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super("The data API rate limit was reached");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
let watchlist = loadStringSet(watchlistKey);
let preferences = loadPreferences();

const shorten = (value, first = 6, last = 5) =>
  value ? `${value.slice(0, first)}…${value.slice(-last)}` : "—";

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);

const formatStake = (lamports) => {
  try {
    const sol = (BigInt(lamports) + 500_000_000n) / 1_000_000_000n;
    return `${new Intl.NumberFormat("en").format(sol)} SOL`;
  } catch {
    return "—";
  }
};

const statusClass = (status) =>
  status === "delinquent" || status === "inactive" ? status : "";

const formatDuration = (seconds) =>
  seconds < 90 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;

const percentage = (bps) =>
  bps === null || bps === undefined ? null : `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

function loadStringSet(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function shouldNotifyAlert(alert) {
  if (!alertIsEnabled(alert)) return false;
  if (!alert.field.includes("commission")) return true;
  const increaseBps = Number(alert.newValue) - Number(alert.previousValue);
  return increaseBps > 0 &&
    increaseBps >= preferences.commissionIncreaseThresholdBps;
}

function loadPreferences() {
  const defaults = {
    inflationWeight: 50,
    watchlistOnly: false,
    notifyCommission: true,
    notifyCollector: true,
    notifyStatus: true,
    commissionIncreaseThresholdBps: 100
  };
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey) ?? "{}");
    return {
      ...defaults,
      ...saved,
      inflationWeight: Number.isFinite(Number(saved.inflationWeight))
        ? Math.min(100, Math.max(0, Number(saved.inflationWeight)))
        : defaults.inflationWeight,
      commissionIncreaseThresholdBps: Number.isSafeInteger(Number(saved.commissionIncreaseThresholdBps))
        ? Math.min(10_000, Math.max(0, Number(saved.commissionIncreaseThresholdBps)))
        : defaults.commissionIncreaseThresholdBps
    };
  } catch {
    return defaults;
  }
}

function savePreferences() {
  localStorage.setItem(preferencesKey, JSON.stringify(preferences));
}

function personalizedScore(validator) {
  const inflation = validator.inflationCommissionBps;
  const blockRevenue = validator.blockRevenueCommissionBps;
  if (inflation === null || blockRevenue === null) return null;
  const inflationWeight = preferences.inflationWeight;
  const commissionPercent =
    (Math.min(inflation, 10_000) * inflationWeight +
      Math.min(blockRevenue, 10_000) * (100 - inflationWeight)) / 10_000;
  return Math.round((100 - commissionPercent) * 10) / 10;
}

function commissionCell(bps, kind, source) {
  if (bps === null || bps === undefined) {
    return '<span class="commission score-na">Not reported</span><small>VoteState v4 not available</small>';
  }
  const sourceLabel = source === "legacy_migration_default"
    ? kind === "block revenue" ? "protocol migration default" : "legacy commission"
    : source === "vote_state_v4" ? "on-chain VoteState v4" : source ? kind : "reported by RPC";
  return `<span class="commission">${percentage(bps)}</span><small>${sourceLabel}</small>`;
}

function collectorCell(inflation, block, source) {
  const render = (value, label, isDefault) => {
    if (!value) return `<span class="collector score-na">${label}: —</span>`;
    const shown = shorten(value, 4, 4);
    const displayLabel = isDefault ? `${label} default` : label;
    return `<span class="collector" title="${escapeHtml(value)}">${displayLabel}: ${shown}</span>`;
  };
  const legacyDefaults = source === "legacy_migration_default";
  return `${render(inflation, "INF", legacyDefaults)}<br />${render(block, "REV", legacyDefaults)}`;
}

function renderValidators(data, total) {
  lastValidators = { data, total };
  const start = total ? page * pageSize + 1 : 0;
  const end = Math.min((page + 1) * pageSize, total);
  document.querySelector("#table-count").textContent =
    `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} validators`;
  document.querySelector("#page-indicator").textContent =
    `Page ${page + 1} of ${Math.max(1, Math.ceil(total / pageSize))}`;
  document.querySelector("#previous-page").disabled = page <= 0;
  document.querySelector("#next-page").disabled = end >= total;
  if (!data.length) {
    rows.innerHTML = `<tr><td colspan="8" class="empty">${emptyDirectoryMessage()}</td></tr>`;
    return;
  }
  rows.innerHTML = data.map((validator) => {
    const score = personalizedScore(validator);
    const watched = watchlist.has(validator.votePubkey);
    return `<tr>
      <td data-label="Validator"><button class="validator-link" data-detail="${escapeHtml(validator.votePubkey)}">${escapeHtml(shorten(validator.nodePubkey, 8, 7))}</button><span class="validator-key">${escapeHtml(shorten(validator.votePubkey, 8, 7))}</span></td>
      <td data-label="Watch"><button class="watch-toggle ${watched ? "watched" : ""}" data-watch="${escapeHtml(validator.votePubkey)}" aria-label="${watched ? "Remove from" : "Add to"} watchlist" title="${watched ? "Remove from" : "Add to"} watchlist">${watched ? "★" : "☆"}</button></td>
      <td data-label="Status"><span class="status-pill ${statusClass(validator.status)}">${escapeHtml(validator.status)}</span></td>
      <td data-label="Inflation commission">${commissionCell(validator.inflationCommissionBps, "inflation rewards", validator.commissionSource)}</td>
      <td data-label="Block revenue commission">${commissionCell(validator.blockRevenueCommissionBps, "block revenue", validator.commissionSource)}</td>
      <td data-label="Collectors">${collectorCell(validator.inflationCollector, validator.blockRevenueCollector, validator.commissionSource)}</td>
      <td data-label="Your score">${score === null ? '<span class="score-na">—</span>' : `<span class="score">${score.toFixed(1)} / 100</span>`}</td>
      <td data-label="Active stake"><span class="stake">${formatStake(validator.activeStakeLamports)}</span></td>
    </tr>`;
  }).join("");
}

function emptyDirectoryMessage() {
  if (search.value.trim()) return "No validators match this search.";
  if (selectedStatus === "watchlist") {
    return watchlist.size === 0
      ? "Your watchlist is empty. Add validators with the star button."
      : "None of your watched validators are in the current data.";
  }
  if (selectedStatus === "inactive") {
    return "No inactive validators. A validator appears here when it drops out of the network's vote-account list.";
  }
  if (selectedStatus === "delinquent") return "No delinquent validators right now.";
  return "No validators to show yet.";
}

// One sync can record several event types with identical values; show it once.
function groupHistory(history) {
  const groups = [];
  for (const entry of history) {
    const previous = groups.at(-1);
    if (previous && previous.recordedAt === entry.recordedAt && previous.slot === entry.slot) {
      previous.eventTypes.push(entry.eventType);
    } else {
      groups.push({ ...entry, eventTypes: [entry.eventType] });
    }
  }
  return groups;
}

function formatAlertField(field) {
  return ({
    inflation_commission: "Inflation commission",
    block_revenue_commission: "Block revenue commission",
    inflation_collector: "Inflation collector",
    block_revenue_collector: "Block revenue collector",
    validator_status: "Validator status"
  })[field] ?? field.replaceAll("_", " ");
}

function formatAlertValue(field, value) {
  if (value === null) return "—";
  if (field.includes("commission")) return `${(Number(value) / 100).toFixed(2)}%`;
  if (field === "validator_status") return escapeHtml(value);
  return escapeHtml(shorten(value, 7, 6));
}

function alertIsEnabled(alert) {
  if (alert.field.includes("commission")) return preferences.notifyCommission;
  if (alert.field.includes("collector")) return preferences.notifyCollector;
  if (alert.field === "validator_status") return preferences.notifyStatus;
  return false;
}

function renderAlerts(data, total) {
  lastAlerts = { data, total };
  const visible = data.filter((alert) => alertIsEnabled(alert));
  if (!visible.length) {
    alerts.innerHTML = `<div class="empty-alert">${
      preferences.watchlistOnly && watchlist.size === 0
        ? "Add validators to your watchlist to see their changes here."
        : "No changes match your current watchlist and alert preferences."
    }</div>`;
    return;
  }
  alerts.innerHTML = visible.slice(0, 10).map((alert) => `
    <article class="alert-item">
      <time class="alert-time">${new Date(alert.detectedAt).toLocaleString()}</time>
      <button class="alert-validator validator-link" data-detail="${escapeHtml(alert.votePubkey)}">${escapeHtml(shorten(alert.votePubkey, 8, 7))}</button>
      <span class="alert-kind">${escapeHtml(formatAlertField(alert.field))}</span>
      <span class="alert-values">${formatAlertValue(alert.field, alert.previousValue)} <span class="alert-arrow">→</span> ${formatAlertValue(alert.field, alert.newValue)}</span>
      <span class="alert-time">${escapeHtml(shorten(alert.nodePubkey, 5, 4))}</span>
    </article>`).join("");
}

function updateWatchlistSummary() {
  const summary = document.querySelector("#watchlist-summary");
  const values = [...watchlist];
  summary.textContent = values.length
    ? `${values.length} validator${values.length === 1 ? "" : "s"} watched in this browser.`
    : "No validators watched yet. Use the star in the directory to add one.";
}

function syncPreferenceControls() {
  document.querySelector("#mix-weight").value = preferences.inflationWeight;
  document.querySelector("#inflation-weight").textContent = `${preferences.inflationWeight}%`;
  document.querySelector("#revenue-weight").textContent = `${100 - preferences.inflationWeight}%`;
  document.querySelector("#watchlist-only").checked = preferences.watchlistOnly;
  document.querySelector("#alert-commission").checked = preferences.notifyCommission;
  document.querySelector("#alert-collector").checked = preferences.notifyCollector;
  document.querySelector("#alert-status").checked = preferences.notifyStatus;
  document.querySelector("#commission-threshold").value =
    preferences.commissionIncreaseThresholdBps;
  const button = document.querySelector("#enable-notifications");
  if (!("Notification" in window)) {
    button.disabled = true;
    button.textContent = "Desktop notifications unavailable";
  } else if (Notification.permission === "granted") {
    button.textContent = "Desktop notifications enabled";
  } else if (Notification.permission === "denied") {
    button.textContent = "Notifications blocked in browser settings";
    button.disabled = true;
  }
  updateWatchlistSummary();
}

function persistWatchlist() {
  localStorage.setItem(watchlistKey, JSON.stringify([...watchlist]));
  updateWatchlistSummary();
  // Only server-filtered views need new data; elsewhere just redraw the stars.
  if (selectedStatus === "watchlist" || preferences.watchlistOnly) {
    if (selectedStatus === "watchlist") page = 0;
    void refresh();
  } else if (lastValidators) {
    renderValidators(lastValidators.data, lastValidators.total);
  }
}

function renderHistoryChart(history) {
  const points = groupHistory(history).reverse().filter((entry) =>
    entry.inflationCommissionBps !== null || entry.blockRevenueCommissionBps !== null
  );
  if (!points.length) return '<p class="empty-alert">Commission history will appear as changes are observed.</p>';
  const width = 760;
  const height = 220;
  const pad = { top: 18, right: 18, bottom: 34, left: 38 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const y = (value) => pad.top + plotHeight * (1 - Math.min(100, Math.max(0, value)) / 100);
  const x = (index) => pad.left + (points.length === 1 ? plotWidth / 2 : plotWidth * index / (points.length - 1));
  const series = (field) => points
    .map((entry, index) => entry[field] === null ? null : `${x(index)},${y(entry[field] / 100)}`)
    .filter(Boolean)
    .join(" ");
  const grid = [0, 25, 50, 75, 100].map((value) => `
    <line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" class="chart-grid" />
    <text x="${pad.left - 8}" y="${y(value) + 3}" class="chart-label" text-anchor="end">${value}%</text>`).join("");
  const dots = (field, className) => points.map((entry, index) => {
    const value = entry[field];
    if (value === null) return "";
    const date = escapeHtml(new Date(entry.recordedAt).toLocaleString());
    return `<circle class="${className}" cx="${x(index)}" cy="${y(value / 100)}" r="4"><title>${date} · ${(value / 100).toFixed(2)}%</title></circle>`;
  }).join("");
  return `<div class="chart-legend"><span class="legend-inflation">Inflation</span><span class="legend-revenue">Block revenue</span><span>${points.length} observed state${points.length === 1 ? "" : "s"}</span></div>
    <svg class="history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Commission rates over observed validator changes">
      ${grid}
      <polyline class="chart-inflation" points="${series("inflationCommissionBps")}" />
      <polyline class="chart-revenue" points="${series("blockRevenueCommissionBps")}" />
      ${dots("inflationCommissionBps", "chart-point-inflation")}
      ${dots("blockRevenueCommissionBps", "chart-point-revenue")}
      <text x="${pad.left}" y="${height - 8}" class="chart-label">${escapeHtml(new Date(points[0].recordedAt).toLocaleDateString())}</text>
      <text x="${width - pad.right}" y="${height - 8}" class="chart-label" text-anchor="end">${escapeHtml(new Date(points.at(-1).recordedAt).toLocaleDateString())}</text>
    </svg>`;
}

function sourceLabel(source, legacyLabel) {
  if (source === "legacy_migration_default") return legacyLabel;
  return source === "vote_state_v4" ? "VoteState v4" : "Not identified";
}

function renderDetail() {
  if (!currentDetail) return;
  const { validator, history: validatorHistory } = currentDetail;
  const votePubkey = validator.votePubkey;
  const watched = watchlist.has(votePubkey);
  const score = personalizedScore(validator);
  detailSection.innerHTML = `
      <div class="detail-heading">
        <div><div class="eyebrow"><span class="eyebrow-line"></span> Validator profile</div><h2>${escapeHtml(shorten(validator.nodePubkey, 10, 9))}</h2></div>
        <button class="outline-button" id="close-detail">Close detail ×</button>
      </div>
      <div class="detail-addresses">
        <div><span>VALIDATOR IDENTITY</span><code>${escapeHtml(validator.nodePubkey)}</code></div>
        <div><span>VOTE ACCOUNT</span><code>${escapeHtml(validator.votePubkey)}</code></div>
      </div>
      <div class="detail-grid">
        <article><span>STATUS</span><strong class="status-pill ${statusClass(validator.status)}">${escapeHtml(validator.status)}</strong></article>
        <article><span>ACTIVE STAKE</span><strong>${formatStake(validator.activeStakeLamports)}</strong></article>
        <article><span>INFLATION COMMISSION</span><strong>${percentage(validator.inflationCommissionBps) ?? "Unknown"}</strong><small>${sourceLabel(validator.commissionSource, "Legacy commission")}</small></article>
        <article><span>BLOCK REVENUE COMMISSION</span><strong>${percentage(validator.blockRevenueCommissionBps) ?? "Unknown"}</strong><small>${sourceLabel(validator.commissionSource, "Protocol migration default")}</small></article>
        <article><span>YOUR WEIGHTED SCORE</span><strong>${score === null ? "Unknown" : `${score.toFixed(1)} / 100`}</strong><small>${preferences.inflationWeight}% inflation · ${100 - preferences.inflationWeight}% block revenue</small></article>
        <article><span>STATE SOURCE</span><strong>VoteState ${validator.voteStateVersion === null ? "unknown" : `v${escapeHtml(validator.voteStateVersion)}`}</strong><small>${escapeHtml(validator.commissionSource ?? "Not identified")}</small></article>
      </div>
      <div class="detail-collectors">
        <article><span>INFLATION REWARDS COLLECTOR</span><code>${escapeHtml(validator.inflationCollector ?? "Not available")}</code></article>
        <article><span>BLOCK REVENUE COLLECTOR</span><code>${escapeHtml(validator.blockRevenueCollector ?? "Not available")}</code></article>
      </div>
      <div class="detail-actions"><button class="watch-toggle ${watched ? "watched" : ""}" data-watch="${escapeHtml(votePubkey)}">${watched ? "★ Remove from watchlist" : "☆ Add to watchlist"}</button><span>Last observed ${escapeHtml(new Date(validator.updatedAt).toLocaleString())}</span></div>
      <div class="history-block"><h3>Commission history</h3>${renderHistoryChart(validatorHistory)}</div>
      <div class="history-block"><h3>Recent observed changes</h3><div class="detail-timeline">${
        validatorHistory.length ? groupHistory(validatorHistory).map((entry) => `<article>
          <span class="timeline-dot"></span><div><strong>${escapeHtml(entry.eventTypes.map((type) => type.replaceAll("_", " ")).join(" · "))}</strong>
          <p>${escapeHtml(new Date(entry.recordedAt).toLocaleString())} · slot ${escapeHtml(entry.slot)}</p>
          <p>Inflation ${percentage(entry.inflationCommissionBps) ?? "—"} · Block revenue ${percentage(entry.blockRevenueCommissionBps) ?? "—"}</p>
          <p class="collector-history">INF ${escapeHtml(shorten(entry.inflationCollector ?? "—"))} · REV ${escapeHtml(shorten(entry.blockRevenueCollector ?? "—"))}</p>
          </div></article>`).join("") : '<p class="empty-alert">No observations yet.</p>'
      }</div></div>`;
}

async function openValidator(votePubkey, updateUrl = true) {
  const requestId = ++detailRequest;
  try {
    const encodedKey = encodeURIComponent(votePubkey);
    const [validatorResponse, historyResponse] = await Promise.all([
      fetch(`/api/validators/${encodedKey}`),
      fetch(`/api/validators/${encodedKey}/history?limit=100`)
    ]);
    throwIfRateLimited(validatorResponse, historyResponse);
    if (!validatorResponse.ok || !historyResponse.ok) {
      throw new Error("Unable to load validator detail and history");
    }
    const [{ data: validator }, { data: validatorHistory }] = await Promise.all([
      validatorResponse.json(), historyResponse.json()
    ]);
    // A newer request (or closing the panel) supersedes this one.
    if (requestId !== detailRequest) return;
    currentDetail = { validator, history: validatorHistory };
    renderDetail();
    detailSection.classList.remove("hidden");
    if (updateUrl && location.pathname !== `/validator/${encodedKey}`) {
      window.history.pushState({ votePubkey }, "", `/validator/${encodedKey}`);
    }
    detailSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (requestId !== detailRequest) return;
    console.error("Unable to open validator detail", error);
    detailSection.classList.remove("hidden");
    detailSection.innerHTML = `<div class="empty-alert">${
      error instanceof RateLimitError
        ? `Request limit reached. Try again in ${formatDuration(error.retryAfterSeconds)}.`
        : "Validator detail is temporarily unavailable."
    }</div>`;
  }
}

function throwIfRateLimited(...responses) {
  const limited = responses.find((response) => response.status === 429);
  if (limited) {
    throw new RateLimitError(Number(limited.headers.get("retry-after")) || 60);
  }
}

function processLiveAlerts(newAlerts) {
  for (const alert of newAlerts) {
    const id = Number(alert.id);
    if (!Number.isSafeInteger(id) || (lastAlertId !== null && id <= lastAlertId)) continue;
    if (
      watchlist.has(alert.votePubkey) &&
      shouldNotifyAlert(alert) &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      new Notification("Staker Watchdog · Validator change", {
        body: `${formatAlertField(alert.field)}: ${formatAlertValue(alert.field, alert.previousValue)} → ${formatAlertValue(alert.field, alert.newValue)}`,
        tag: `staker-watchdog-alert-${id}`
      });
    }
    lastAlertId = id;
  }
  if (lastAlertId !== null) localStorage.setItem(lastAlertKey, String(lastAlertId));
}

async function loadData() {
  const params = new URLSearchParams({
    limit: String(pageSize),
    offset: String(page * pageSize),
    sort: sortBy,
    direction: sortDirection
  });
  if (sortBy === "commission") {
    params.set("inflationWeight", String(preferences.inflationWeight));
  }
  const query = search.value.trim();
  if (query) params.set("q", query);
  if (["current", "delinquent", "inactive"].includes(selectedStatus)) {
    params.set("status", selectedStatus);
  }
  if (selectedStatus === "watchlist") {
    params.set("status", "watchlist");
    for (const votePubkey of watchlist) params.append("watchlist", votePubkey);
  }
  const alertParams = new URLSearchParams({ limit: "200" });
  if (preferences.watchlistOnly) {
    alertParams.set("watchlistOnly", "true");
    for (const votePubkey of watchlist) alertParams.append("watchlist", votePubkey);
  }
  const [validatorResponse, alertsResponse, healthResponse] = await Promise.all([
    fetch(`/api/validators?${params}`),
    fetch(`/api/alerts?${alertParams}`),
    fetch("/api/health")
  ]);
  // Health is not rate limited, so show it even when the data calls are refused.
  if (healthResponse.ok) renderHealth(await healthResponse.json());
  throwIfRateLimited(validatorResponse, alertsResponse);
  if (!validatorResponse.ok || !alertsResponse.ok || !healthResponse.ok) {
    throw new Error("The data API returned an unsuccessful response");
  }
  const [validatorPayload, alertPayload] = await Promise.all([
    validatorResponse.json(), alertsResponse.json()
  ]);
  renderValidators(validatorPayload.data, validatorPayload.meta.total);
  renderAlerts(alertPayload.data, alertPayload.meta.total);
  if (lastAlertId === null) {
    lastAlertId = alertPayload.data.reduce(
      (highest, alert) => Math.max(highest, Number(alert.id)), 0
    );
    localStorage.setItem(lastAlertKey, String(lastAlertId));
  }
}

function renderHealth(health) {
  document.querySelector("#change-count").textContent =
    Number(health.changeCount).toLocaleString();
  document.querySelector("#validator-count").textContent =
    Number(health.validatorCount).toLocaleString();
  const lastSync = document.querySelector("#last-sync");
  const healthStatus = document.querySelector("#health-status");
  const healthFoot = document.querySelector("#health-foot");
  const syncSlot = document.querySelector("#sync-slot");
  if (health.lastSuccessfulSyncAt) {
    const syncAt = new Date(health.lastSuccessfulSyncAt);
    lastSync.textContent = syncAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    lastSync.title = syncAt.toLocaleString();
    syncSlot.textContent = `finalized slot ${Number(health.currentSlot).toLocaleString()}`;
  } else {
    lastSync.textContent = "Waiting for first sync";
  }
  healthStatus.classList.toggle("online", !health.stale);
  healthStatus.innerHTML = `<i></i> ${health.stale ? "STALE" : "MONITORING"}`;
  healthFoot.textContent = health.stale ? "check RPC connection" : `epoch ${health.currentEpoch}`;
}

let searchTimer;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  page = 0;
  searchTimer = setTimeout(() => void refresh(), 220);
});
filters.forEach((button) => button.addEventListener("click", () => {
  filters.forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  selectedStatus = button.dataset.status ?? "all";
  page = 0;
  void refresh();
}));
document.querySelector("#sort-by").addEventListener("change", (event) => {
  sortBy = event.target.value;
  page = 0;
  void refresh();
});
document.querySelector("#sort-direction").addEventListener("click", (event) => {
  sortDirection = sortDirection === "desc" ? "asc" : "desc";
  event.currentTarget.textContent = sortDirection === "desc" ? "↓" : "↑";
  page = 0;
  void refresh();
});
document.querySelector("#previous-page").addEventListener("click", () => {
  if (page > 0) {
    page -= 1;
    void refresh();
  }
});
document.querySelector("#next-page").addEventListener("click", () => {
  page += 1;
  void refresh();
});
refreshButton.addEventListener("click", () => void refresh());
rows.addEventListener("click", (event) => {
  const watchButton = event.target.closest("[data-watch]");
  if (watchButton) {
    event.stopPropagation();
    toggleWatch(watchButton.dataset.watch);
    return;
  }
  const detailButton = event.target.closest("[data-detail]");
  if (detailButton) void openValidator(detailButton.dataset.detail);
});
alerts.addEventListener("click", (event) => {
  const detailButton = event.target.closest("[data-detail]");
  if (detailButton) void openValidator(detailButton.dataset.detail);
});
detailSection.addEventListener("click", (event) => {
  if (event.target.closest("#close-detail")) {
    detailRequest += 1;
    currentDetail = null;
    detailSection.classList.add("hidden");
    window.history.replaceState({}, "", "/");
    return;
  }
  const watchButton = event.target.closest("[data-watch]");
  if (watchButton) toggleWatch(watchButton.dataset.watch);
});

function toggleWatch(votePubkey) {
  if (watchlist.has(votePubkey)) {
    watchlist.delete(votePubkey);
  } else {
    if (watchlist.size >= 100) {
      document.querySelector("#watchlist-summary").textContent =
        "This MVP supports up to 100 watched validators per browser.";
      return;
    }
    watchlist.add(votePubkey);
  }
  persistWatchlist();
  if (currentDetail?.validator.votePubkey === votePubkey) renderDetail();
}

document.querySelector("#mix-weight").addEventListener("input", (event) => {
  preferences.inflationWeight = Number(event.target.value);
  savePreferences();
  syncPreferenceControls();
  // Scores are computed in the browser; only the server-side sort needs a fetch.
  if (lastValidators) renderValidators(lastValidators.data, lastValidators.total);
  renderDetail();
  if (sortBy === "commission") {
    clearTimeout(weightRefreshTimer);
    weightRefreshTimer = setTimeout(() => void refresh(), 300);
  }
});
document.querySelector("#commission-threshold").addEventListener("change", (event) => {
  const value = Number(event.target.value);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    event.target.value = preferences.commissionIncreaseThresholdBps;
    return;
  }
  preferences.commissionIncreaseThresholdBps = value;
  savePreferences();
});
document.querySelector("#watchlist-only").addEventListener("change", (event) => {
  preferences.watchlistOnly = event.target.checked;
  savePreferences();
  void refresh();
});
for (const [id, key] of [
  ["alert-commission", "notifyCommission"],
  ["alert-collector", "notifyCollector"],
  ["alert-status", "notifyStatus"]
]) {
  document.querySelector(`#${id}`).addEventListener("change", (event) => {
    preferences[key] = event.target.checked;
    savePreferences();
    if (lastAlerts) renderAlerts(lastAlerts.data, lastAlerts.total);
  });
}
document.querySelector("#enable-notifications").addEventListener("click", async (event) => {
  if (!("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  event.currentTarget.textContent = permission === "granted"
    ? "Desktop notifications enabled"
    : permission === "denied" ? "Notifications blocked in browser settings" : "Enable desktop notifications";
  event.currentTarget.disabled = permission === "denied" || permission === "granted";
});

window.addEventListener("popstate", () => {
  const match = location.pathname.match(/^\/validator\/([^/]+)$/);
  if (match) void openValidator(decodeURIComponent(match[1]), false);
  else {
    detailRequest += 1;
    currentDetail = null;
    detailSection.classList.add("hidden");
  }
});

async function refresh() {
  if (refreshBusy) {
    refreshQueued = true;
    return;
  }
  refreshBusy = true;
  refreshButton.disabled = true;
  refreshButton.innerHTML = '<span>↻</span> Updating';
  try {
    await loadData();
  } catch (error) {
    if (error instanceof RateLimitError) {
      showRateLimited(error.retryAfterSeconds);
      return;
    }
    console.error("Unable to load validator data", error);
    rows.innerHTML = '<tr><td colspan="8" class="empty">Validator data is temporarily unavailable. The monitor will retry automatically.</td></tr>';
    document.querySelector("#health-status").innerHTML = "<i></i> OFFLINE";
    document.querySelector("#health-foot").textContent = "unable to reach the data API";
  } finally {
    refreshBusy = false;
    refreshButton.disabled = false;
    refreshButton.innerHTML = '<span>↻</span> Refresh';
    if (refreshQueued) {
      refreshQueued = false;
      queueMicrotask(() => void refresh());
    }
  }
}

function showRateLimited(retryAfterSeconds) {
  document.querySelector("#health-status").innerHTML = "<i></i> RATE LIMITED";
  document.querySelector("#health-foot").textContent =
    `request limit reached · retrying in ${formatDuration(retryAfterSeconds)}`;
  if (!lastValidators) {
    rows.innerHTML = `<tr><td colspan="8" class="empty">Request limit reached for this network. Data will reload in ${formatDuration(retryAfterSeconds)}.</td></tr>`;
  }
  clearTimeout(rateLimitTimer);
  rateLimitTimer = setTimeout(() => void refresh(), retryAfterSeconds * 1000);
}

// Live updates drive refreshes; polling only runs while the stream is down.
function setFallbackPolling(enabled) {
  if (enabled && !fallbackTimer) {
    fallbackTimer = setInterval(() => void refresh(), fallbackPollMs);
  } else if (!enabled && fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
}

function connectLiveUpdates() {
  const status = document.querySelector("#live-connection");
  const pulse = document.querySelector("#network-pulse");
  const source = new EventSource("/api/events");
  let wasConnected = false;
  source.addEventListener("open", () => {
    status.textContent = "LIVE UPDATES";
    pulse.classList.add("online");
    setFallbackPolling(false);
    // Catch up on anything missed while reconnecting.
    if (wasConnected) void refresh();
    wasConnected = true;
  });
  source.addEventListener("error", () => {
    pulse.classList.remove("online");
    setFallbackPolling(true);
    if (source.readyState === EventSource.CLOSED) {
      // The server refused the stream (e.g. too many tabs); retry later.
      status.textContent = "PERIODIC UPDATES";
      setTimeout(connectLiveUpdates, 5 * 60_000);
    } else {
      status.textContent = "RECONNECTING";
    }
  });
  source.addEventListener("update", (event) => {
    try {
      const update = JSON.parse(event.data);
      processLiveAlerts(update.alerts ?? []);
      void refresh();
    } catch (error) {
      console.error("Invalid live monitor event", error);
    }
  });
}

syncPreferenceControls();
const initialLoad = refresh();
void initialLoad.then(connectLiveUpdates);
const initialValidatorRoute = location.pathname.match(/^\/validator\/([^/]+)$/);
if (initialValidatorRoute) {
  // Wait for the directory to render first, or it pushes the profile out of view.
  void initialLoad.then(() => openValidator(decodeURIComponent(initialValidatorRoute[1]), false));
}
