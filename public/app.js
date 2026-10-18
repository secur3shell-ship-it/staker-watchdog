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
  document.querySelector("#commission-threshold").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
      event.target.value = preferences.commissionIncreaseThresholdBps;
      return;
    }
    preferences.commissionIncreaseThresholdBps = value;
    savePreferences();
  });
};

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
  if (!categoryEnabled(alert)) return false;
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
    : source === "vote_state_v4" ? "on-chain VoteState v4" : kind;
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
  const start = total ? page * pageSize + 1 : 0;
  const end = Math.min((page + 1) * pageSize, total);
  document.querySelector("#table-count").textContent =
    `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} validators`;
  document.querySelector("#page-indicator").textContent =
    `Page ${page + 1} of ${Math.max(1, Math.ceil(total / pageSize))}`;
  document.querySelector("#previous-page").disabled = page <= 0;
  document.querySelector("#next-page").disabled = end >= total;
  if (!data.length) {
    rows.innerHTML = `<tr><td colspan="8" class="empty">${
      selectedStatus === "watchlist" && watchlist.size === 0
        ? "Your watchlist is empty. Add validators with the star button."
        : "No validators match this search."
    }</td></tr>`;
    return;
  }
  rows.innerHTML = data.map((validator) => {
    const delinquent = validator.status === "delinquent";
    const score = personalizedScore(validator);
    const watched = watchlist.has(validator.votePubkey);
    return `<tr>
      <td><button class="validator-link" data-detail="${escapeHtml(validator.votePubkey)}">${escapeHtml(shorten(validator.nodePubkey, 8, 7))}</button><span class="validator-key">${escapeHtml(shorten(validator.votePubkey, 8, 7))}</span></td>
      <td><button class="watch-toggle ${watched ? "watched" : ""}" data-watch="${escapeHtml(validator.votePubkey)}" aria-label="${watched ? "Remove from" : "Add to"} watchlist" title="${watched ? "Remove from" : "Add to"} watchlist">${watched ? "★" : "☆"}</button></td>
      <td><span class="status-pill ${delinquent ? "delinquent" : ""}">${validator.status}</span></td>
      <td>${commissionCell(validator.inflationCommissionBps, "inflation rewards", validator.commissionSource)}</td>
      <td>${commissionCell(validator.blockRevenueCommissionBps, "block revenue", validator.commissionSource)}</td>
      <td>${collectorCell(validator.inflationCollector, validator.blockRevenueCollector, validator.commissionSource)}</td>
      <td>${score === null ? '<span class="score-na">—</span>' : `<span class="score">${score.toFixed(1)} / 100</span>`}</td>
      <td><span class="stake">${formatStake(validator.activeStakeLamports)}</span></td>
    </tr>`;
  }).join("");
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
  document.querySelector("#change-count").textContent = total.toLocaleString();
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
      <span class="alert-kind">${formatAlertField(alert.field)}</span>
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
  if (selectedStatus === "watchlist") page = 0;
  void refresh();
}

function renderHistoryChart(history) {
  const points = [...history].reverse().filter((entry) =>
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

async function openValidator(votePubkey, updateUrl = true) {
  try {
    const encodedKey = encodeURIComponent(votePubkey);
    const [validatorResponse, historyResponse] = await Promise.all([
      fetch(`/api/validators/${encodedKey}`),
      fetch(`/api/validators/${encodedKey}/history?limit=100`)
    ]);
    if (!validatorResponse.ok || !historyResponse.ok) {
      throw new Error("Unable to load validator detail and history");
    }
    const [{ data: validator }, { data: validatorHistory }] = await Promise.all([
      validatorResponse.json(), historyResponse.json()
    ]);
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
        <article><span>STATUS</span><strong class="status-pill ${validator.status === "delinquent" ? "delinquent" : ""}">${validator.status}</strong></article>
        <article><span>ACTIVE STAKE</span><strong>${formatStake(validator.activeStakeLamports)}</strong></article>
        <article><span>INFLATION COMMISSION</span><strong>${percentage(validator.inflationCommissionBps) ?? "Unknown"}</strong><small>${validator.commissionSource === "legacy_migration_default" ? "Legacy commission" : "VoteState v4"}</small></article>
        <article><span>BLOCK REVENUE COMMISSION</span><strong>${percentage(validator.blockRevenueCommissionBps) ?? "Unknown"}</strong><small>${validator.commissionSource === "legacy_migration_default" ? "Protocol migration default" : "VoteState v4"}</small></article>
        <article><span>YOUR WEIGHTED SCORE</span><strong>${score === null ? "Unknown" : `${score.toFixed(1)} / 100`}</strong><small>${preferences.inflationWeight}% inflation · ${100 - preferences.inflationWeight}% block revenue</small></article>
        <article><span>STATE SOURCE</span><strong>VoteState ${validator.voteStateVersion ?? "unknown"}</strong><small>${validator.commissionSource ?? "Not identified"}</small></article>
      </div>
      <div class="detail-collectors">
        <article><span>INFLATION REWARDS COLLECTOR</span><code>${escapeHtml(validator.inflationCollector ?? "Not available")}</code></article>
        <article><span>BLOCK REVENUE COLLECTOR</span><code>${escapeHtml(validator.blockRevenueCollector ?? "Not available")}</code></article>
      </div>
      <div class="detail-actions"><button class="watch-toggle ${watched ? "watched" : ""}" data-watch="${escapeHtml(votePubkey)}">${watched ? "★ Remove from watchlist" : "☆ Add to watchlist"}</button><span>Last observed ${escapeHtml(new Date(validator.updatedAt).toLocaleString())}</span></div>
      <div class="history-block"><h3>Commission history</h3>${renderHistoryChart(validatorHistory)}</div>
      <div class="history-block"><h3>Recent observed changes</h3><div class="detail-timeline">${
        validatorHistory.length ? validatorHistory.map((entry) => `<article>
          <span class="timeline-dot"></span><div><strong>${escapeHtml(entry.eventType.replaceAll("_", " "))}</strong>
          <p>${escapeHtml(new Date(entry.recordedAt).toLocaleString())} · slot ${escapeHtml(entry.slot)}</p>
          <p>Inflation ${percentage(entry.inflationCommissionBps) ?? "—"} · Block revenue ${percentage(entry.blockRevenueCommissionBps) ?? "—"}</p>
          <p class="collector-history">INF ${escapeHtml(shorten(entry.inflationCollector ?? "—"))} · REV ${escapeHtml(shorten(entry.blockRevenueCollector ?? "—"))}</p>
          </div></article>`).join("") : '<p class="empty-alert">No observations yet.</p>'
      }</div></div>`;
    detailSection.classList.remove("hidden");
    if (updateUrl && location.pathname !== `/validator/${encodedKey}`) {
      window.history.pushState({ votePubkey }, "", `/validator/${encodedKey}`);
    }
    detailSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error("Unable to open validator detail", error);
    detailSection.classList.remove("hidden");
    detailSection.innerHTML = '<div class="empty-alert">Validator detail is temporarily unavailable.</div>';
  }
}

function categoryEnabled(alert) {
  if (alert.field.includes("commission")) return preferences.notifyCommission;
  if (alert.field.includes("collector")) return preferences.notifyCollector;
  if (alert.field === "validator_status") return preferences.notifyStatus;
  return false;
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
  if (selectedStatus === "current" || selectedStatus === "delinquent") {
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
  if (!validatorResponse.ok || !alertsResponse.ok || !healthResponse.ok) {
    throw new Error("The data API returned an unsuccessful response");
  }
  const [validatorPayload, alertPayload, health] = await Promise.all([
    validatorResponse.json(), alertsResponse.json(), healthResponse.json()
  ]);
  renderValidators(validatorPayload.data, validatorPayload.meta.total);
  renderAlerts(alertPayload.data, alertPayload.meta.total);
  if (lastAlertId === null) {
    lastAlertId = alertPayload.data.reduce(
      (highest, alert) => Math.max(highest, Number(alert.id)), 0
    );
    localStorage.setItem(lastAlertKey, String(lastAlertId));
  }
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
  if (location.pathname.startsWith("/validator/")) {
    void openValidator(votePubkey, false);
  }
}

document.querySelector("#mix-weight").addEventListener("input", (event) => {
  preferences.inflationWeight = Number(event.target.value);
  savePreferences();
  syncPreferenceControls();
  void refresh();
  if (location.pathname.startsWith("/validator/")) {
    void openValidator(decodeURIComponent(location.pathname.split("/").at(-1)), false);
  }
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
    void refresh();
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
  else detailSection.classList.add("hidden");
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

function connectLiveUpdates() {
  const status = document.querySelector("#live-connection");
  const pulse = document.querySelector("#network-pulse");
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    status.textContent = "LIVE UPDATES";
    pulse.classList.add("online");
  });
  source.addEventListener("error", () => {
    status.textContent = "RECONNECTING";
    pulse.classList.remove("online");
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
void refresh().then(connectLiveUpdates);
const initialValidatorRoute = location.pathname.match(/^\/validator\/([^/]+)$/);
if (initialValidatorRoute) {
  void openValidator(decodeURIComponent(initialValidatorRoute[1]), false);
}
setInterval(() => void refresh(), 60_000);
