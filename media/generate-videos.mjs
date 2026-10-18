import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = dirname(fileURLToPath(import.meta.url));
const logoUrl = pathToFileURL(join(projectRoot, "public", "image.png")).href;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "staker-watchdog-video-"));
const width = 1280;
const height = 720;
const sceneDuration = 3.8;
const transitionDuration = 0.65;
const fps = 30;

const colors = {
  canvas: "#f6f1f2",
  surface: "#fcf9fa",
  raised: "#f0eaed",
  line: "#d4c9ce",
  lineSoft: "#e8e0e3",
  ink: "#272326",
  secondary: "#554d52",
  muted: "#756b71",
  pink: "#9b6575",
  palePink: "#edcbd5",
  gray: "#626168",
  green: "#5d6963"
};

const productScenes = [
  {
    eyebrow: "PRODUCT WALKTHROUGH · 01 / 05",
    title: ["Know where your", "stake is going."],
    body: ["A clearer view of validator commissions,", "collectors, and observed changes."],
    view: "directory"
  },
  {
    eyebrow: "TWO COMMISSION STREAMS · 02 / 05",
    title: ["See both commission", "streams clearly."],
    body: ["Compare inflation rewards and block revenue", "side by side, with protocol source context."],
    view: "commissions"
  },
  {
    eyebrow: "COLLECTOR VISIBILITY · 03 / 05",
    title: ["Know where each", "commission goes."],
    body: ["Inspect the configured collector accounts", "for both validator revenue streams."],
    view: "collectors"
  },
  {
    eyebrow: "OBSERVED CHANGES · 04 / 05",
    title: ["See what changed", "over time."],
    body: ["Review observed commission history and", "changes to collectors or validator status."],
    view: "history"
  },
  {
    eyebrow: "WATCHLIST + API · 05 / 05",
    title: ["Keep your focus.", "Build on the data."],
    body: ["Save a browser-local watchlist, tune your", "comparison, or explore the public data API."],
    view: "api"
  }
];

const launchScenes = [
  {
    eyebrow: "INTRODUCING",
    title: ["Staker", "Watchdog."],
    body: ["Validator intelligence for Solana stakers.", "Read-only monitoring. Clear on-chain context."],
    view: "launch"
  },
  {
    eyebrow: "A CLEARER COMMISSION PICTURE",
    title: ["Two commissions.", "One clear view."],
    body: ["Inflation rewards and block revenue,", "shown separately—not hidden in one number."],
    view: "commissions"
  },
  {
    eyebrow: "FOLLOW CONFIGURATION CHANGES",
    title: ["Track the cut.", "Catch changes."],
    body: ["See collector accounts, observed history,", "and current or delinquent status changes."],
    view: "history"
  },
  {
    eyebrow: "NOW AVAILABLE",
    title: ["Validator data", "for Solana."],
    body: ["Explore the dashboard and public API.", "Built for stakers and staking operators."],
    view: "launch"
  }
];

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function text(x, y, value, size, color, weight = 400, family = "sans", extra = "") {
  const font = family === "mono"
    ? "DM Mono, DejaVu Sans Mono, monospace"
    : "DM Sans, Arial, sans-serif";
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${font}" font-size="${size}" font-weight="${weight}" ${extra}>${escapeXml(value)}</text>`;
}

function rect(x, y, w, h, fill, stroke = colors.lineSoft, radius = 8) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
}

function line(x1, y1, x2, y2, color = colors.lineSoft, width = 1) {
  return `<path d="M${x1} ${y1}H${x2}" stroke="${color}" stroke-width="${width}"/>`;
}

function logo(x, y, size) {
  return `<image href="${logoUrl}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
}

function panelHeader(title, detail = "FINALIZED SOLANA DATA") {
  return [
    rect(0, 0, 548, 408, colors.surface, colors.line, 12),
    logo(22, 20, 27),
    text(60, 37, title, 15, colors.ink, 600),
    text(525, 36, detail, 9, colors.muted, 500, "mono", 'text-anchor="end"'),
    line(20, 55, 528)
  ].join("");
}

function directoryView() {
  const entries = [
    ["Fdk7…jv69Nk", "CURRENT", "5%", "12%", "92.5", "17.5M SOL"],
    ["HEL1…Gv1e2TU", "CURRENT", "0%", "10%", "95.0", "15.7M SOL"],
    ["DRpb…okm21hy", "DELINQUENT", "4%", "15%", "90.5", "12.4M SOL"]
  ];
  let result = panelHeader("Validator directory");
  result += rect(22, 73, 225, 33, colors.raised, colors.lineSoft, 5);
  result += text(36, 94, "Search vote or identity address", 10, colors.muted);
  result += rect(365, 73, 160, 33, colors.raised, colors.lineSoft, 5);
  result += text(380, 94, "SORT  ·  ACTIVE STAKE", 9, colors.secondary, 500, "mono");
  result += rect(22, 122, 504, 38, colors.raised, colors.lineSoft, 4);
  result += text(38, 146, "VALIDATOR", 9, colors.muted, 500, "mono");
  result += text(205, 146, "INFLATION", 9, colors.muted, 500, "mono");
  result += text(295, 146, "BLOCK REV.", 9, colors.muted, 500, "mono");
  result += text(390, 146, "SCORE", 9, colors.muted, 500, "mono");
  result += text(470, 146, "STAKE", 9, colors.muted, 500, "mono");
  entries.forEach((entry, index) => {
    const y = 160 + index * 67;
    result += rect(22, y, 504, 66, index % 2 ? colors.surface : "#faf6f7", colors.lineSoft, 0);
    result += text(38, y + 25, entry[0], 12, colors.ink, 500, "mono");
    result += text(38, y + 46, entry[1], 9, entry[1] === "CURRENT" ? colors.green : colors.pink, 500, "mono");
    result += text(205, y + 36, entry[2], 13, colors.ink, 500, "mono");
    result += text(295, y + 36, entry[3], 13, colors.ink, 500, "mono");
    result += text(390, y + 36, entry[4], 13, colors.pink, 600, "mono");
    result += text(470, y + 36, entry[5], 10, colors.secondary, 400, "mono");
  });
  result += text(24, 383, "ILLUSTRATIVE PREVIEW · LIVE VALUES UPDATE", 9, colors.muted, 400, "mono");
  return result;
}

function commissionsView() {
  let result = panelHeader("Commission breakdown");
  result += text(24, 84, "Understand both revenue streams independently.", 12, colors.secondary);
  result += rect(22, 104, 244, 128, "#faf6f7", colors.lineSoft, 8);
  result += rect(282, 104, 244, 128, "#faf6f7", colors.lineSoft, 8);
  result += text(42, 134, "INFLATION REWARDS", 10, colors.muted, 500, "mono");
  result += text(42, 181, "5.00%", 34, colors.ink, 500, "mono");
  result += text(42, 210, "VoteState v4 · on-chain", 11, colors.secondary);
  result += text(302, 134, "BLOCK REVENUE", 10, colors.muted, 500, "mono");
  result += text(302, 181, "12.00%", 34, colors.ink, 500, "mono");
  result += text(302, 210, "VoteState v4 · on-chain", 11, colors.secondary);
  result += rect(22, 248, 504, 110, colors.raised, colors.lineSoft, 8);
  result += text(42, 278, "COMMISSION COMPARISON", 10, colors.muted, 500, "mono");
  result += text(42, 323, "91.5", 32, colors.pink, 600, "mono");
  result += text(124, 322, "/ 100  ·  Equal-weight reference", 12, colors.secondary);
  result += text(24, 383, "ILLUSTRATIVE VALUES · SCORE IS NOT A YIELD ESTIMATE", 9, colors.muted, 400, "mono");
  return result;
}

function collectorsView() {
  let result = panelHeader("Collector accounts");
  result += text(24, 84, "See where validator commission streams are directed.", 12, colors.secondary);
  result += rect(22, 105, 504, 88, colors.surface, colors.lineSoft, 8);
  result += text(42, 132, "INFLATION REWARDS COLLECTOR", 10, colors.muted, 500, "mono");
  result += text(42, 160, "7xKX…m4QA", 17, colors.ink, 500, "mono");
  result += text(42, 180, "Vote account · source shown in profile", 10, colors.secondary);
  result += rect(22, 207, 504, 88, colors.surface, colors.lineSoft, 8);
  result += text(42, 234, "BLOCK REVENUE COLLECTOR", 10, colors.muted, 500, "mono");
  result += text(42, 262, "9pLr…2vHc", 17, colors.ink, 500, "mono");
  result += text(42, 282, "Validator identity · source shown in profile", 10, colors.secondary);
  result += rect(22, 310, 504, 48, "#f4eaed", "#e4d1d8", 6);
  result += text(40, 340, "Legacy accounts are identified with migration-default context.", 11, colors.pink, 500);
  result += text(24, 383, "SHORTENED ADDRESSES ARE ILLUSTRATIVE", 9, colors.muted, 400, "mono");
  return result;
}

function historyView() {
  let result = panelHeader("Observed validator history");
  result += text(24, 84, "Configuration and status changes, recorded over time.", 12, colors.secondary);
  result += rect(22, 100, 504, 150, colors.surface, colors.lineSoft, 8);
  [0, 1, 2, 3].forEach((i) => {
    result += line(44, 134 + i * 27, 500, colors.lineSoft);
  });
  result += `<polyline points="48,211 150,190 250,199 352,159 470,170" fill="none" stroke="${colors.pink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  result += `<polyline points="48,143 150,147 250,145 352,142 470,138" fill="none" stroke="${colors.gray}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  result += text(42, 239, "INFLATION COMMISSION", 9, colors.pink, 500, "mono");
  result += text(214, 239, "BLOCK REVENUE", 9, colors.gray, 500, "mono");
  result += rect(22, 264, 504, 94, colors.raised, colors.lineSoft, 8);
  result += text(42, 291, "RECENT OBSERVATION", 9, colors.muted, 500, "mono");
  result += text(42, 318, "Collector account changed", 13, colors.ink, 500);
  result += text(42, 341, "Finalized slot · change recorded in history", 10, colors.secondary, 400, "mono");
  result += text(24, 383, "POLL-OBSERVED HISTORY · NOT A FULL CHAIN EVENT LOG", 9, colors.muted, 400, "mono");
  return result;
}

function apiView() {
  let result = panelHeader("Your data, your workflow");
  result += text(24, 84, "Watchlist and preferences stay in this browser.", 12, colors.secondary);
  result += rect(22, 104, 228, 224, colors.surface, colors.lineSoft, 8);
  result += text(42, 134, "YOUR WATCHLIST", 10, colors.muted, 500, "mono");
  result += text(42, 169, "Validator · Fdk7…jv69Nk", 11, colors.ink, 500, "mono");
  result += line(42, 184, 230);
  result += text(42, 209, "Commission mix", 11, colors.secondary);
  result += rect(42, 224, 188, 6, colors.line, colors.line, 3);
  result += rect(42, 224, 94, 6, colors.pink, colors.pink, 3);
  result += text(42, 254, "Alert preferences", 11, colors.secondary);
  result += text(42, 280, "Commission · collector · status", 9, colors.muted, 400, "mono");
  result += text(42, 305, "Saved locally in your browser", 9, colors.green, 500, "mono");
  result += rect(266, 104, 260, 224, "#242327", "#242327", 8);
  result += text(286, 134, "GET  /api/validators", 12, colors.palePink, 500, "mono");
  result += text(286, 170, "{", 14, "#f3e8eb", 400, "mono");
  result += text(302, 197, '"inflationCommissionBps":', 10, "#ded3d7", 400, "mono");
  result += text(467, 197, "500,", 10, colors.palePink, 500, "mono");
  result += text(302, 222, '"blockRevenueCommissionBps":', 9, "#ded3d7", 400, "mono");
  result += text(472, 222, "1200,", 9, colors.palePink, 500, "mono");
  result += text(302, 247, '"commissionScore":', 10, "#ded3d7", 400, "mono");
  result += text(418, 247, "91.5", 10, colors.palePink, 500, "mono");
  result += text(286, 275, "…", 15, "#f3e8eb", 400, "mono");
  result += text(286, 305, "PUBLIC DATA · JSON API", 9, "#c2b8bd", 500, "mono");
  result += text(24, 383, "SAMPLE RESPONSE FIELDS · VALUES ARE ILLUSTRATIVE", 9, colors.muted, 400, "mono");
  return result;
}

function launchView() {
  let result = rect(0, 0, 548, 408, "#f4eaed", "#e4d1d8", 12);
  result += `<circle cx="274" cy="184" r="105" fill="${colors.surface}" stroke="${colors.line}" stroke-width="2"/>`;
  result += logo(210, 120, 128);
  result += text(274, 337, "STAKER WATCHDOG", 17, colors.ink, 600, "sans", 'text-anchor="middle" letter-spacing="2"');
  result += text(274, 365, "SOLANA VALIDATOR INTELLIGENCE", 10, colors.pink, 500, "mono", 'text-anchor="middle" letter-spacing="1"');
  result += rect(216, 379, 116, 2, colors.pink, colors.pink, 1);
  return result;
}

const views = {
  directory: directoryView,
  commissions: commissionsView,
  collectors: collectorsView,
  history: historyView,
  api: apiView,
  launch: launchView
};

function renderFrame(scene, index, total, kind) {
  const titleY = 267;
  const titleLines = scene.title.map((value, lineIndex) =>
    text(72, titleY + lineIndex * 62, value, 50, colors.ink, 600)
  ).join("");
  const body = scene.body.map((value, lineIndex) =>
    text(74, 427 + lineIndex * 27, value, 19, colors.secondary, 400)
  ).join("");
  const progress = Array.from({ length: total }, (_, i) =>
    `<circle cx="${1120 + i * 20}" cy="669" r="3" fill="${i === index ? colors.pink : colors.line}"/>`
  ).join("");
  const panel = views[scene.view]();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${colors.canvas}"/>
    <circle cx="1115" cy="171" r="290" fill="none" stroke="${colors.lineSoft}" stroke-width="1"/>
    <circle cx="1115" cy="171" r="250" fill="none" stroke="${colors.lineSoft}" stroke-width="1"/>
    <rect x="52" y="28" width="1176" height="1" fill="${colors.line}"/>
    ${logo(72, 47, 34)}
    ${text(119, 69, "STAKER WATCHDOG", 13, colors.ink, 600, "sans", 'letter-spacing="1.4"')}
    ${text(322, 69, "SOLANA VALIDATOR INTELLIGENCE", 10, colors.muted, 500, "mono", 'letter-spacing="0.8"')}
    ${text(72, 155, scene.eyebrow, 11, colors.pink, 600, "mono", 'letter-spacing="1.1"')}
    ${titleLines}
    ${body}
    ${text(74, 521, kind === "product" ? "READ-ONLY · FINALIZED DATA · LOCAL-FIRST PREFERENCES" : "READ-ONLY MONITORING · PUBLIC VALIDATOR DATA API", 10, colors.muted, 500, "mono", 'letter-spacing="0.5"')}
    <g transform="translate(652 160)">${panel}</g>
    <rect x="52" y="648" width="1176" height="1" fill="${colors.line}"/>
    ${text(72, 682, kind === "product" ? "STAKER WATCHDOG  /  PRODUCT WALKTHROUGH" : "STAKER WATCHDOG  /  LAUNCH", 10, colors.muted, 500, "mono", 'letter-spacing="0.7"')}
    ${progress}
  </svg>`;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function renderPng(svg, filename) {
  const htmlPath = join(temporaryDirectory, `${filename}.html`);
  const pngPath = join(temporaryDirectory, `${filename}.png`);
  writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{width:${width}px;height:${height}px;margin:0;overflow:hidden;background:${colors.canvas}}svg{display:block;width:${width}px;height:${height}px}</style>${svg}`);
  run("google-chrome", [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--run-all-compositor-stages-before-draw",
    "--window-size=1280,720",
    `--user-data-dir=${join(temporaryDirectory, `profile-${filename}`)}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href
  ]);
  readFileSync(pngPath);
  return pngPath;
}

function makeVideo(scenes, kind, outputName) {
  const frames = scenes.map((scene, index) =>
    renderPng(renderFrame(scene, index, scenes.length, kind), `${kind}-${index + 1}`)
  );
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  frames.forEach((frame) => {
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(sceneDuration), "-i", frame);
  });

  const filters = frames.map((_, index) =>
    `[${index}:v]scale=${width}:${height},fps=${fps},setsar=1,format=yuv420p,settb=AVTB[v${index}]`
  );
  let previous = "v0";
  for (let index = 1; index < frames.length; index += 1) {
    const next = `xf${index}`;
    const offset = (sceneDuration - transitionDuration) * index;
    filters.push(`[${previous}][v${index}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[${next}]`);
    previous = next;
  }
  const fullDuration = sceneDuration * frames.length - transitionDuration * (frames.length - 1);
  const fadeOutDuration = 0.5;
  filters.push(`[${previous}]fade=t=in:st=0:d=0.35,fade=t=out:st=${(fullDuration - fadeOutDuration).toFixed(2)}:d=${fadeOutDuration}[outv]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[outv]",
    "-an",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-metadata", `title=${outputName.replaceAll("-", " ")}`,
    "-metadata", "comment=Silent 1280x720 frame-based video with smooth crossfades",
    join(outputDirectory, `${outputName}.mp4`)
  );
  run("ffmpeg", args);
  console.info(`Created media/${outputName}.mp4`);
}

try {
  makeVideo(productScenes, "product", "staker-watchdog-product-walkthrough");
  makeVideo(launchScenes, "launch", "staker-watchdog-launch");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
