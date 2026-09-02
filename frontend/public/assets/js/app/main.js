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
import { initTooltips } from "./lib/tooltip.js";
import { start } from "./router.js";
import { startAnalytics } from "./analytics.js";
import { api, ROUTES } from "./lib/api.js";

// The real vault (source of truth: robotmoney-site config, Base mainnet). This
// is a public on-chain address, not a fabricated demo value.
const VAULT_ADDRESS = "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd";
const shortAddr = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;

// Prose for each allocation sleeve, keyed on the framework's own bucket keys.
// No WEIGHT lives in here. Every number on those cards comes from
// GET /api/dashboards/allocation. What a sleeve IS does not change when its
// weight does, and the reader needs both facts on the same card.
//
// No FUNDING STATE lives in here either. A sleeve's target can move off zero
// without anyone editing this file, and prose that said "funded at nothing"
// would then contradict the bound number on the same card. The weight and the
// status row carry that fact; these strings say only what the sleeve is.
//
// No VOLATILITY TIER lives in here either. The feed carries no risk field, so
// a per-card hue would be this file's opinion painted as data, and the palette
// reserves cyan for the interface and warm for a point of attention. Where
// volatility is worth saying, the description says it in words.
//
// An unknown key (the framework gains a fifth sleeve) falls through to no
// description, rather than borrowing another sleeve's.
const SLEEVE_COPY = {
  "defi-yield": {
    desc: "The lowest-volatility sleeve, aimed at capital preservation. USDC lent on Base money markets. Principal is still at risk: see Smart Contract Risks, linked in the footer.",
  },
  "agent-tokens": {
    // Not "buys THIS basket": the framework's published constituents and the
    // list the skill's prepare-deposit actually buys are two different seven-
    // token sets that overlap on three. Until one is derived from the other,
    // this card may not assert they are the same basket.
    desc: "The most volatile sleeve. Nothing in the vault holds it: the deposit skill buys an agent-token basket at deposit time and it lands in the depositor's own wallet.",
  },
  "protocol-tokens": {
    desc: "Large-cap crypto. A published sleeve of the allocation framework.",
  },
  rwa: {
    desc: "Equity and gold exposure. A published sleeve of the allocation framework.",
  },
};

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
// .rm-tip behaviour, bound once by delegation (see lib/tooltip.js).
initTooltips();

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

  // The allocation sleeves drawn in the Architecture section, live from
  // GET /api/dashboards/allocation, the same route terminalBoot reads above.
  //
  // What this replaces: a baked "Bucket A / B / C" at 50/25/25 that agreed
  // with nothing on its own page. The governance section below it said the
  // default was 33/33/33; the API has served four sleeves at 95/5/0/0 the
  // whole time. Three weight sets, one page. The hardcoded weight WAS the
  // false claim, so the fix is a binding, not better copy.
  //
  // Two rules the markup depends on:
  //   • A sleeve at a 0% target renders AT ZERO, dimmed but present. A
  //     published zero is a decision someone made, and hiding it would let
  //     the page imply the sleeve does not exist.
  //   • If the feed fails, no cards render at all and the absent state shows
  //     instead. Same precedent terminalBoot follows for its split lines:
  //     omit rather than fabricate. Never fall back to the old constants.
  Alpine.data("allocationSleeves", () => ({
    sleeves: [],
    asOf: null,
    loaded: false,
    failed: false,
    async load() {
      try {
        const fw = await api.get(ROUTES.dashboards.allocation);
        const strategy = fw?.strategy || [];
        const buckets = fw?.buckets || [];
        // strategy[] carries the sleeve weight, buckets[] the constituents.
        // Join on the label they share rather than on position, so a
        // reordering on one side cannot silently pair a weight with the
        // wrong sleeve. Position is the fallback, not the contract.
        const byLabel = new Map(strategy.map((s) => [s.label, s]));
        const rows = buckets.map((b, i) => {
          const s = byLabel.get(b.label) || strategy[i] || {};
          // A MISSING weight is not a zero weight. Defaulting to 0 here would
          // print "0%" and "Held at zero" for a sleeve the framework never
          // published a target for, which is a fabricated fact, not an absent
          // one. Unresolvable weights fail the whole block instead.
          const target = Number(s.targetPct);
          const copy = SLEEVE_COPY[b.key] || {};
          return {
            key: b.key,
            label: s.label || b.label,
            target: Number.isFinite(target) ? target : null,
            desc: copy.desc || "",
            // The framework publishes the constituents it targets. Reading
            // them from the feed is the only way this line stays true: the
            // hardcoded one read "USDC/USDT on Aave, Compound, Morpho", and
            // the vault's asset is USDC.
            constituents: (b.items || []).map((it) => it.label).filter(Boolean).join(", "),
          };
        });
        this.sleeves = rows.some((r) => r.target === null) ? [] : rows;
        this.asOf = fw?.asOf || null;
        this.failed = this.sleeves.length === 0;
      } catch (e) {
        this.sleeves = [];
        this.asOf = null;
        this.failed = true;
      }
      this.loaded = true;
    },
    // A target weight with no trailing ".0": 95%, 5%, 0%, 14.3%.
    pct(v) {
      if (v == null || !isFinite(v)) return "—";
      return Number(v).toFixed(1).replace(/\.0$/, "") + "%";
    },
    // Card tint. Every sleeve carrying a target reads the same: the four are
    // one framework, and the target weight on the card is what separates them.
    // A sleeve at zero is dimmed, which is a state the feed can back, not a
    // hue this file invented. The old cards tinted by volatility tier in cyan,
    // warm and a raw #facc15 yellow: three hues the covenant spends elsewhere,
    // over a fill far past the cap, rating a position nobody holds.
    cardClass(s) {
      return s.target > 0 ? "" : "architecture__bucket--zero";
    },
    // The one word below the card's divider. It says TARGETED, not "funded":
    // this reads the published target weight, and the feed carries no holding.
    // Agent Tokens is the case that makes the distinction load-bearing, since
    // the vault holds none of it at any target: the basket is bought by the
    // deposit skill into the depositor's own wallet.
    statusLabel(s) {
      return s.target > 0 ? "Targeted" : "Held at zero";
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

// Subscribe to the router's `rm:view-changed` BEFORE start() below fires the
// first one, so the landing route is counted like every later one.
startAnalytics();

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
