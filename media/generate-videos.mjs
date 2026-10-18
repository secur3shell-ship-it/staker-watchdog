// Builds the two product videos from real screenshots of the running dashboard.
//
//   node media/generate-videos.mjs                 # starts its own server on :3456
//   BASE_URL=http://127.0.0.1:3000 node media/generate-videos.mjs
//
// Requires Google Chrome and ffmpeg (libx264, xfade, zoompan) on PATH.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectRoot, "media");
const work = mkdtempSync(join(tmpdir(), "staker-watchdog-video-"));
const fileUrl = (path) => pathToFileURL(path).href;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
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
  ion: "#9b6575"
};

// ---------------------------------------------------------------- processes

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

async function startServer() {
  if (process.env.BASE_URL) return { base: process.env.BASE_URL.replace(/\/$/, ""), stop() {} };
  const port = 3456;
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore"
  });
  const base = `http://127.0.0.1:${port}`;
  // Wait for a fresh sync so the frames show current mainnet data.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(1000);
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (Date.parse(health.lastSuccessfulSyncAt) >= startedAt) break;
      if (attempt === 119 && health.lastSuccessfulSyncAt) {
        console.warn("No fresh sync yet; using the last stored snapshot");
      }
    } catch {
      // server still starting
    }
  }
  return { base, stop: () => child.kill("SIGTERM") };
}

async function startChrome() {
  const port = Number(process.env.CHROME_DEBUG_PORT ?? 9339);
  const chrome = spawn("google-chrome", [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(work, "chrome")}`,
    "--no-first-run",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "about:blank"
  ], { stdio: "ignore" });
  let targets = [];
  for (let attempt = 0; attempt < 50 && !targets.some((t) => t.type === "page"); attempt += 1) {
    await sleep(200);
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      // not listening yet
    }
  }
  const socket = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener("open", done));
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++nextId;
    pending.set(id, (message) => message.error
      ? fail(new Error(`${method}: ${message.error.message}`))
      : done(message.result));
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  return {
    send,
    evaluate,
    async open(url, wait = 2500) {
      await send("Page.navigate", { url });
      await sleep(wait);
    },
    viewport: (width, height, scale, mobile = false) =>
      send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile }),
    async capture(path, clip) {
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: clip ? { ...clip, scale: 1 } : undefined
      });
      writeFileSync(path, Buffer.from(data, "base64"));
      return path;
    },
    close() {
      socket.close();
      chrome.kill();
    }
  };
}

// ---------------------------------------------------------------- capture

async function captureApp(browser, base) {
  const shots = {};
  const top = (selector, offset = 0) => browser.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top + scrollY + ${offset}`
  );
  const region = async (name, selector, offset, width, height) => {
    const y = selector ? Math.max(0, await top(selector, offset)) : 0;
    shots[name] = await browser.capture(join(work, `${name}.png`), { x: 0, y, width, height });
  };

  const validators = (await (await fetch(`${base}/api/validators?limit=1000`)).json()).data;
  const health = await (await fetch(`${base}/api/health`)).json();
  const custom = validators.filter((v) =>
    v.commissionSource === "vote_state_v4" &&
    (v.inflationCollector !== v.votePubkey || v.blockRevenueCollector !== v.nodePubkey)
  );
  if (!validators.length) throw new Error("The API returned no validators to film");
  // Prefer a validator whose block revenue goes to a third account: the clearest example.
  const featured = custom.find((v) =>
    v.blockRevenueCollector !== v.nodePubkey && v.blockRevenueCollector !== v.votePubkey
  ) ?? custom[0] ?? validators[0];
  const watched = [featured.votePubkey, validators[0].votePubkey, validators[1]?.votePubkey]
    .filter(Boolean);
  const stats = {
    validators: Number(health.validatorCount),
    custom: custom.length,
    delinquent: validators.filter((v) => v.status === "delinquent").length
  };

  // Desktop at 1280 CSS px, 2x pixels so text survives scaling into frames.
  await browser.viewport(1280, 720, 2);
  await browser.open(`${base}/`, 500);
  await browser.evaluate(`localStorage.setItem("stakerWatchdog.watchlist.v1", ${JSON.stringify(JSON.stringify(watched))})`);
  await browser.open(`${base}/`, 3500);
  await region("overview", null, 0, 1280, 720);
  await region("directory", "#validators", -8, 1280, 720);
  await region("watch", "#watchlist", -8, 1280, 720);
  await region("alerts", "#alerts", -8, 1280, 720);

  await browser.open(`${base}/validator/${encodeURIComponent(featured.votePubkey)}`, 3500);
  await region("profile", "#validator-detail", -8, 1280, 720);
  await region("history", "#validator-detail .history-block", -16, 1280, 720);

  await browser.viewport(390, 844, 2, true);
  await browser.open(`${base}/`, 3500);
  await region("phoneDirectory", "#validator-rows tr", -16, 390, 600);
  await region("phoneAlerts", "#alerts", -8, 390, 600);
  await browser.open(`${base}/validator/${encodeURIComponent(featured.votePubkey)}`, 3500);
  await region("phoneProfile", "#validator-detail .detail-grid", -8, 390, 600);

  return { shots, stats };
}

// ---------------------------------------------------------------- frames

const fonts = ["400", "500", "600", "700"].map((weight) =>
  `@font-face{font-family:"DM Sans";font-weight:${weight};src:url("${fileUrl(join(projectRoot, `public/fonts/dm-sans-latin-${weight}-normal.woff2`))}")}`
).concat(["400", "500"].map((weight) =>
  `@font-face{font-family:"DM Mono";font-weight:${weight};src:url("${fileUrl(join(projectRoot, `public/fonts/dm-mono-latin-${weight}-normal.woff2`))}")}`
)).join("");
const logo = fileUrl(join(projectRoot, "public/image.png"));

const baseCss = `${fonts}
*{box-sizing:border-box;margin:0}
html,body{width:1280px;height:720px;overflow:hidden;background:${colors.canvas};color:${colors.ink};font-family:"DM Sans",sans-serif}
.mono{font-family:"DM Mono",monospace}
.eyebrow{font:500 12px/16px "DM Mono",monospace;letter-spacing:.12em;color:${colors.ion};text-transform:uppercase;display:flex;align-items:center;gap:10px}
.eyebrow:before{content:"";width:22px;height:1px;background:${colors.ion}}
.brand{display:flex;align-items:center;gap:10px;font:600 13px/1 "DM Sans";letter-spacing:.14em}
.brand img{width:28px;height:28px;object-fit:contain}
.brand b{font-weight:400;color:${colors.secondary}}
.shot{border:1px solid ${colors.line};border-radius:10px;overflow:hidden;background:${colors.surface};box-shadow:0 1px 0 ${colors.lineSoft},0 18px 40px rgb(39 35 38 / 10%)}
.shot img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
em{font-style:normal;color:${colors.ion}}`;

const brand = `<div class="brand"><img src="${logo}" alt=""><span>STAKER<b>WATCHDOG</b></span></div>`;

function productFrame(scene, index, total) {
  const progress = Array.from({ length: total }, (_, i) =>
    `<i style="background:${i <= index ? colors.ion : colors.line}"></i>`).join("");
  const visual = scene.phones
    ? `<div class="phones">${scene.phones.map((src) => `<div class="shot phone"><img src="${fileUrl(src)}" alt=""></div>`).join("")}</div>`
    : `<div class="shot wide"><img src="${fileUrl(scene.image)}" alt=""></div>`;
  return `<!doctype html><meta charset="utf-8"><style>${baseCss}
header{position:absolute;inset:0 0 auto;height:58px;padding:0 50px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ${colors.line}}
header .step{font:500 11px/1 "DM Mono";letter-spacing:.1em;color:${colors.muted}}
.caption{position:absolute;left:50px;right:50px;top:78px;display:grid;grid-template-columns:1fr 440px;align-items:end;gap:40px}
h1{margin-top:10px;font:600 34px/40px "DM Sans";letter-spacing:-.01em}
.caption p{font:400 15px/23px "DM Sans";color:${colors.secondary}}
.wide{position:absolute;left:50px;right:50px;top:186px;height:494px}
.phones{position:absolute;left:50px;right:50px;top:186px;height:494px;display:flex;justify-content:center;gap:36px}
.phone{width:342px;height:494px;border-radius:18px}
footer{position:absolute;left:50px;right:50px;bottom:16px;display:flex;gap:6px}
footer i{flex:1;height:3px;border-radius:2px}
</style><body>
<header>${brand}<span class="step">PRODUCT WALKTHROUGH · ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</span></header>
<div class="caption"><div><div class="eyebrow">${scene.eyebrow}</div><h1>${scene.title}</h1></div><p>${scene.body}</p></div>
${visual}
<footer>${progress}</footer>`;
}

function launchFrame(scene) {
  if (scene.kind === "card") {
    return `<!doctype html><meta charset="utf-8"><style>${baseCss}
body{display:grid;place-items:center;text-align:center}
.rings{position:absolute;inset:0}
.rings i{position:absolute;left:50%;top:50%;border:1px solid ${colors.lineSoft};border-radius:50%;transform:translate(-50%,-50%)}
.mark{width:96px;height:96px;object-fit:contain;margin:0 auto 26px;display:block}
h1{font:600 64px/70px "DM Sans";letter-spacing:-.02em}
p{margin-top:18px;font:400 20px/30px "DM Sans";color:${colors.secondary}}
.eyebrow{justify-content:center;margin-bottom:18px}
.pills{margin-top:30px;display:flex;gap:10px;justify-content:center}
.pills span{padding:8px 14px;border:1px solid ${colors.line};border-radius:999px;background:${colors.surface};font:500 12px/1 "DM Mono";letter-spacing:.06em;color:${colors.secondary}}
</style><body><div class="rings">${[420, 620, 820, 1020].map((size) => `<i style="width:${size}px;height:${size}px"></i>`).join("")}</div>
<div style="position:relative">${scene.logo ? `<img class="mark" src="${logo}" alt="">` : ""}
${scene.eyebrow ? `<div class="eyebrow">${scene.eyebrow}</div>` : ""}<h1>${scene.title}</h1>${scene.body ? `<p>${scene.body}</p>` : ""}
${scene.pills ? `<div class="pills">${scene.pills.map((pill) => `<span>${pill}</span>`).join("")}</div>` : ""}</div>`;
  }
  if (scene.kind === "stats") {
    return `<!doctype html><meta charset="utf-8"><style>${baseCss}
body{padding:96px 90px}
h1{margin-top:14px;font:600 46px/54px "DM Sans";letter-spacing:-.015em;max-width:900px}
.grid{margin-top:56px;display:grid;grid-template-columns:repeat(3,1fr);border:1px solid ${colors.line};border-radius:12px;background:${colors.surface};overflow:hidden}
.grid div{padding:30px 32px;border-right:1px solid ${colors.line}}
.grid div:last-child{border-right:0}
.grid strong{display:block;font:500 54px/1 "DM Mono";color:${colors.ink}}
.grid div:nth-child(2) strong{color:${colors.ion}}
.grid span{display:block;margin-top:14px;font:400 16px/23px "DM Sans";color:${colors.secondary}}
.note{margin-top:22px;font:500 11px/1 "DM Mono";letter-spacing:.08em;color:${colors.muted}}
</style><body><div class="eyebrow">${scene.eyebrow}</div><h1>${scene.title}</h1>
<div class="grid">${scene.stats.map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>
<div class="note">${scene.note}</div>`;
  }
  if (scene.kind === "phones") {
    return `<!doctype html><meta charset="utf-8"><style>${baseCss}
body{display:grid;grid-template-columns:360px 1fr;align-items:center;padding:0 80px;gap:40px}
h1{margin-top:14px;font:600 48px/56px "DM Sans";letter-spacing:-.015em}
p{margin-top:16px;font:400 18px/27px "DM Sans";color:${colors.secondary}}
.phones{display:flex;gap:20px;justify-content:center;align-items:center}
.phone{width:214px;height:329px;border-radius:16px}
.phone:nth-child(2){transform:translateY(-26px)}
</style><body><div><div class="eyebrow">${scene.eyebrow}</div><h1>${scene.title}</h1><p>${scene.body}</p></div>
<div class="phones">${scene.phones.map((src) => `<div class="shot phone"><img src="${fileUrl(src)}" alt=""></div>`).join("")}</div>`;
  }
  // Full-bleed screenshot with a caption panel.
  return `<!doctype html><meta charset="utf-8"><style>${baseCss}
.bleed{position:absolute;inset:44px 44px 0;border:1px solid ${colors.line};border-bottom:0;border-radius:12px 12px 0 0;overflow:hidden;background:${colors.surface}}
.bleed img{width:100%;height:100%;object-fit:cover;object-position:top}
.veil{position:absolute;inset:0;background:linear-gradient(180deg,rgb(246 241 242 / 0) 35%,rgb(246 241 242 / 88%) 100%)}
.panel{position:absolute;left:56px;bottom:52px;max-width:640px;padding:26px 30px;border:1px solid ${colors.line};border-radius:12px;background:${colors.surface};box-shadow:0 22px 50px rgb(39 35 38 / 16%)}
h1{margin-top:12px;font:600 44px/50px "DM Sans";letter-spacing:-.015em}
p{margin-top:12px;font:400 17px/25px "DM Sans";color:${colors.secondary}}
</style><body><div class="bleed"><img src="${fileUrl(scene.image)}" alt=""></div><div class="veil"></div>
<div class="panel"><div class="eyebrow">${scene.eyebrow}</div><h1>${scene.title}</h1>${scene.body ? `<p>${scene.body}</p>` : ""}</div>`;
}

async function renderFrames(browser, scenes, render, name, scale) {
  await browser.viewport(1280, 720, scale);
  const frames = [];
  for (const [index, scene] of scenes.entries()) {
    const html = join(work, `${name}-${index + 1}.html`);
    writeFileSync(html, render(scene, index, scenes.length));
    await browser.open(fileUrl(html), 900);
    await browser.evaluate("document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))))");
    frames.push(await browser.capture(join(work, `${name}-${index + 1}.png`)));
  }
  return frames;
}

// ---------------------------------------------------------------- encode

function encode(frames, { output, title, sceneDuration, transitions, transitionDuration, kenBurns }) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const frame of frames) {
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(sceneDuration), "-i", frame);
  }
  const sceneFrames = Math.round(sceneDuration * fps);
  const filters = frames.map((_, index) => {
    // Slow push-in / pull-out on 2x frames; plain scale otherwise.
    const motion = kenBurns
      ? `zoompan=z='${index % 2 === 0 ? `1+0.07*on/${sceneFrames}` : `1.07-0.07*on/${sceneFrames}`}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=${fps}`
      : `scale=1280:720:flags=lanczos,fps=${fps}`;
    return `[${index}:v]${motion},setsar=1,format=yuv420p,settb=AVTB[v${index}]`;
  });
  let previous = "v0";
  for (let index = 1; index < frames.length; index += 1) {
    const offset = ((sceneDuration - transitionDuration) * index).toFixed(3);
    const transition = transitions[(index - 1) % transitions.length];
    filters.push(`[${previous}][v${index}]xfade=transition=${transition}:duration=${transitionDuration}:offset=${offset}[x${index}]`);
    previous = `x${index}`;
  }
  const total = sceneDuration * frames.length - transitionDuration * (frames.length - 1);
  filters.push(`[${previous}]fade=t=in:st=0:d=0.4,fade=t=out:st=${(total - 0.5).toFixed(2)}:d=0.5[out]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[out]",
    "-an",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "27",
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-metadata", `title=${title}`,
    "-metadata", "comment=Silent 1280x720 video built from real Staker Watchdog screenshots",
    join(outputDirectory, output)
  );
  run("ffmpeg", args);
  console.info(`Created media/${output} (${total.toFixed(1)}s)`);
}

// ---------------------------------------------------------------- scenes

const server = await startServer();
const browser = await startChrome();
try {
  const { shots, stats } = await captureApp(browser, server.base);
  const n = (value) => value.toLocaleString("en");

  const product = [
    {
      eyebrow: "Overview",
      title: "Know where your <em>stake</em> is going.",
      body: `Live, finalized Solana data for ${n(stats.validators)} validators, refreshed every five minutes.`,
      image: shots.overview
    },
    {
      eyebrow: "Validator directory",
      title: "Both commissions, side by side.",
      body: "Inflation and block-revenue commission read from on-chain VoteState v4, scored with your own weighting.",
      image: shots.directory
    },
    {
      eyebrow: "Validator profile",
      title: "See where commission is paid.",
      body: `Both payout addresses on every profile. ${n(stats.custom)} validators already route theirs to custom accounts.`,
      image: shots.profile
    },
    {
      eyebrow: "History",
      title: "What changed, and when.",
      body: "Every observed commission, collector, or status change on a chart and a timeline.",
      image: shots.history
    },
    {
      eyebrow: "Watchlist & alerts",
      title: "Your validators, your alerts.",
      body: "Star validators, filter the change log, and opt in to desktop notifications. Saved only in your browser.",
      image: shots.watch
    },
    {
      eyebrow: "Anywhere",
      title: "On your phone, and in your stack.",
      body: "A responsive dashboard, a free public JSON API, and signed webhooks for every detected change.",
      phones: [shots.phoneDirectory, shots.phoneProfile, shots.phoneAlerts]
    }
  ];

  const launch = [
    {
      kind: "card",
      logo: true,
      eyebrow: "Introducing",
      title: "Staker Watchdog",
      body: "Validator intelligence for Solana stakers."
    },
    {
      kind: "bleed",
      eyebrow: "Two commissions. One view.",
      title: "Stop guessing what your validator keeps.",
      body: "Inflation and block-revenue commission, straight from the chain.",
      image: shots.directory
    },
    {
      kind: "stats",
      eyebrow: "Live on mainnet",
      title: "The payout details behind every validator.",
      stats: [
        [n(stats.validators), "validators tracked on finalized data"],
        [n(stats.custom), "already route commission to custom collector accounts"],
        [n(stats.delinquent), "delinquent right now, flagged the moment status changes"]
      ],
      note: `FIGURES FROM THE LIVE SERVICE · ${new Date().toISOString().slice(0, 10)}`
    },
    {
      kind: "bleed",
      eyebrow: "Every validator, explained",
      title: "Follow the money.",
      body: "Commission rates, collector accounts, and history on one profile.",
      image: shots.profile
    },
    {
      kind: "bleed",
      eyebrow: "Change watch",
      title: "Catch changes before they catch you.",
      body: "Live updates in the browser, signed webhooks for your systems.",
      image: shots.alerts
    },
    {
      kind: "phones",
      eyebrow: "Wherever you are",
      title: "Built for your pocket, too.",
      body: "Every field, every validator, on any screen.",
      phones: [shots.phoneDirectory, shots.phoneProfile, shots.phoneAlerts]
    },
    {
      kind: "card",
      logo: true,
      eyebrow: "Live now",
      title: "Know where your <em>stake</em> is going.",
      pills: ["DASHBOARD", "WATCHLISTS", "SIGNED WEBHOOKS", "FREE PUBLIC API"]
    }
  ];

  encode(await renderFrames(browser, product, productFrame, "product", 1), {
    output: "staker-watchdog-product-walkthrough.mp4",
    title: "Staker Watchdog product walkthrough",
    sceneDuration: 3.6,
    transitionDuration: 0.6,
    transitions: ["fade"],
    kenBurns: false
  });
  encode(await renderFrames(browser, launch, launchFrame, "launch", 2), {
    output: "staker-watchdog-launch.mp4",
    title: "Staker Watchdog launch",
    sceneDuration: 3.2,
    transitionDuration: 0.7,
    transitions: ["fadeblack", "smoothleft", "circleopen", "smoothup", "slideleft", "fadeblack"],
    kenBurns: true
  });
} finally {
  browser.close();
  server.stop();
  rmSync(work, { recursive: true, force: true });
}
