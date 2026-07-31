// SPA shell entry module. Loaded as a <script type="module"> BEFORE the Alpine
// CDN script (document order = execution order), so our `alpine:init` listener
// is registered before Alpine boots and starts processing the DOM. No build
// step, no Web Components — Alpine owns all behavior and lifecycle.
import { registerSubstrate } from "./alpine/substrate.js";
import { registerViews } from "./alpine/views.js";
import { registerHeroes } from "./alpine/heroes.js";
import { registerStaticViews } from "./alpine/static-views.js";
import { registerDashUi } from "./alpine/dash-ui.js";
import { applyChartDefaults } from "./lib/chart-theme.js";
import { start } from "./router.js";
import { api, ROUTES } from "./lib/api.js";

// The real vault (source of truth: robotmoney-site config, Base mainnet). This
// is a public on-chain address, not a fabricated demo value.
const VAULT_ADDRESS = "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd";
const shortAddr = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;

// Build the hero's boot-log lines. The bucket-split lines are injected from the
// LIVE allocation framework (GET /api/dashboards/allocation) — never a baked
// 33/33/33 — and are omitted entirely if the feed is unavailable rather than
// fabricated. Delays are staggered so the log types out over ~7s.
// `beat` is the pause BEFORE each line, in milliseconds, and it is deliberately
// uneven: a real shell waits while it works, rattles through its successes in a
// burst, and takes a breath before reporting final state. The previous flat
// 600ms cadence was the main reason the log read as a metronome rather than as a
// machine doing work. The accumulated `delay` is handed to CSS as a per-row
// animation-delay, so the browser owns the reveal and no JS timer is involved.
function buildTerminalLines(bucketLines) {
  const lines = [
    { text: "$ robot-money init --chain base --vault erc4626", beat: 400 },
    { text: "  Deploying vault contract...", beat: 700 },
    { text: `  ✓ Vault deployed at ${shortAddr(VAULT_ADDRESS)}`, beat: 900 },
    // The bucket split lands as one quick burst: it is a single fact, and
    // spacing its parts out invites the reader to weigh them separately.
    ...bucketLines.map((b) => ({ text: `  ✓ ${b}`, beat: 260 })),
    { text: "  Launching $ROBOTMONEY on Base...", beat: 560 },
    { text: "  ✓ LP locked until 2100", beat: 820 },
    { text: "  ✓ Prop wallet initialized", beat: 260 },
    { text: "", beat: 200 },
    { text: "  Ready. Accepting deposits.", beat: 650 },
  ];
  let at = 0;
  return lines.map((l) => {
    at += l.beat;
    return { ...l, delay: at };
  });
}

// Register every Alpine.data factory the views need, before Alpine starts.
document.addEventListener("alpine:init", () => {
  const Alpine = window.Alpine;

  // Chart.js CDN precedes Alpine in document order, so window.Chart is ready by
  // now — set the shared chart theme defaults once, before any chart draws.
  applyChartDefaults();

  Alpine.data("terminalBoot", () => ({
    lines: [],
    async start() {
      // Pull the real bucket target weights from the allocation framework; on
      // any failure, omit the split lines (honest — no fabricated 33/33/33).
      let bucketLines = [];
      try {
        const fw = await api.get(ROUTES.dashboards.allocation);
        bucketLines = (fw?.strategy || [])
          .filter((s) => Number(s.targetPct) > 0)
          .map((s) => `${s.label}: ${Math.round(Number(s.targetPct))}%`);
      } catch (e) {
        bucketLines = [];
      }
      // Every line is rendered at once and revealed by its own CSS animation
      // delay. That replaces one setTimeout per line, and it means a row
      // animates exactly once, when it is created, instead of the whole list
      // re-rendering on each tick and risking re-animating rows already shown.
      this.lines = buildTerminalLines(bucketLines);
    },
    lineClass(line) {
      const t = line.text;
      let tone = "term-line--muted";
      if (t.includes("✓")) tone = "term-line--accent";
      else if (t.startsWith("$")) tone = "term-line--cmd";
      else if (t.includes("Ready")) tone = "term-line--ready";
      return `term-line ${tone}${t === "" ? " term-line--blank" : ""}`;
    },
  }));

  registerSubstrate(Alpine);
  registerViews(Alpine);
  registerHeroes(Alpine);
  registerStaticViews(Alpine);
  // Dashboard (.a3 scope) UI primitives — issue #379. Registered once here,
  // like the other alpine/* helpers, so every future dashboard fragment can
  // use a3Tabs/a3Dialog/a3Sheet/etc. without its own registration step.
  registerDashUi(Alpine);
});

// Boot the router once the document is parsed. The router renders the current
// path into #view; Alpine's MutationObserver initializes the injected markup.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

// Global delegated "copy to clipboard" handler. An element with a
// `data-copy="<text>"` attribute copies that literal text; an element with
// `data-copy-code` copies the textContent of the <pre> in its closest
// `.docs-codeblock`. Both show transient "Copied!" feedback. Registered once at
// boot so it works for router-injected views (whose inline scripts never run).
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy], [data-copy-code]");
  if (!btn) return;
  let text;
  if (btn.hasAttribute("data-copy")) {
    text = btn.getAttribute("data-copy");
  } else {
    const pre = btn.closest(".docs-codeblock")?.querySelector("pre");
    text = pre ? pre.textContent : "";
  }
  const done = () => {
    const label = btn.querySelector("[data-copy-label]") || btn;
    const prev = label.textContent;
    label.textContent = btn.getAttribute("data-copied-text") || "Copied!";
    btn.classList.add("is-copied");
    setTimeout(() => { label.textContent = prev; btn.classList.remove("is-copied"); }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(done);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta); done();
  }
});
