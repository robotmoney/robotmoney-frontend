// Alpine factory for /vault — the depositor-capital factsheet (RM-105,
// design RM-104).
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: it reads
// GET /api/dashboards/vault-economics and GET /api/dashboards/allocation, and
// NOTHING ELSE. It must never read wallet-balances or wallet-sleeves — those
// are the three protocol-owned prop wallets (the house book), a different pot
// of money that moves to the token page under RM-103. /allocation's Total AUM
// tile added the two together, which is how the vault came to be 0.4% of a
// figure printed under a heading about the vault, while backend config.ts
// throws at boot if a prop wallet is ever configured as the vault ("would
// double-count vault TVL"). Separating the pots is the entire point of this
// page. A reviewer should check that exclusion before anything else.
//
// Live, per fetch:
//   vault-economics  tvlUsd, sharePrice, totalShares, idleUsdc, apy7d, and the
//                    three adapter holdings (balance + provenance + asOf) that
//                    drive Holdings, the held-weight side of Allocation, the
//                    fixed-income constituents, and the concentration figure
//                    in Risk.
//   allocation       the four sleeve target weights and their constituents.
//                    Display-layer only: the DTO keeps its legacy labels
//                    ("Conservative DeFi Yield", "Agent Tokens"), and SLEEVES
//                    below renames them to RM-97's vocabulary on the way out.
//
// NOT live, and said so on the page (REFERENCE below): the per-venue APY
// series behind "What it pays" and the recorded vault-TVL series behind
// "Value over time". Neither has a GET route yet — RM-104 files both as
// backend asks (a route over vault_share_price_history, and a reference-APY
// collector). Until they land the page renders them as a dated reference
// dataset with a visible non-live badge and a seam banner, rather than
// implying a feed that does not exist. Same reason NAV per share, drawdown
// and Sharpe render as "not yet published" instead of borrowing the single
// spot sharePrice: one number is not a series.
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, SERIES, CATEGORICAL } from "../../lib/chart-theme.js";

// ── the reference dataset ───────────────────────────────────────────────────
// Daily USDC supply APY at the three venues the fixed-income sleeve lends
// into, 2026-03-18 → 2026-08-26 (162 days), read by hand from each protocol's
// public rates and frozen here. `asOf` is rendered next to every figure drawn
// from it so the page never presents it as a live read.
const REFERENCE = {
  start: "2026-03-18",
  asOf: "2026-08-26",
  venues: {
    aave: [2.55,2.509,2.579,2.594,2.586,2.863,2.345,2.333,2.384,2.439,2.474,2.474,2.51,2.689,2.657,2.705,2.576,2.599,2.604,2.721,2.763,2.696,2.721,2.707,2.699,2.685,2.661,3.015,2.768,2.695,2.791,3.283,13.048,5.135,3.514,3.874,3.442,3.503,3.562,3.427,3.486,3.486,3.393,3.377,3.367,3.333,3.331,3.422,3.388,3.412,3.382,3.37,3.327,3.298,3.264,3.215,3.138,3.063,3.074,2.93,2.867,2.859,2.92,2.953,3.056,3.133,3.1,3.119,3.13,3.11,3.203,3.203,3.222,3.202,3.235,3.247,3.339,3.397,3.257,3.231,3.107,3.153,3.181,3.142,3.189,3.219,3.123,3.117,3.175,3.196,3.181,3.238,3.135,3.136,3.081,3.084,3.099,3.096,3.141,3.175,3.148,3.155,3.158,3.181,3.225,3.164,3.121,3.142,3.085,3.14,3.093,3.081,3.119,3.144,3.058,3.051,3.12,3.147,3.014,3.025,3.023,3.066,3.102,3.103,2.982,2.703,2.72,3.409,3.399,3.532,3.486,3.453,3.542,3.524,3.438,3.547,3.547,3.482,3.457,3.333,3.344,3.366,3.265,3.383,3.447,3.583,3.602,3.636,3.589,3.501,3.554,3.564,3.942,3.522,3.462,3.449,3.332,3.157,3.169,3.226,3.093,3.013],
    morpho: [3.641,3.665,3.688,3.68,3.727,3.612,3.612,3.664,3.938,3.8,3.86,4.081,3.722,3.741,4.258,4.065,3.729,3.711,3.712,3.745,3.774,4.029,4.157,3.855,3.793,3.792,5.054,3.842,3.863,3.997,4.224,4.777,6.005,5.498,4.062,4.109,4.123,4.194,4.301,4.276,4.08,4.024,4.04,4.107,4.24,4.087,4.079,4.037,3.995,4.017,3.997,4.04,4.12,4.224,4.877,4.417,4.943,4.142,4.142,4.484,4.622,4.531,4.769,4.325,4.234,4.203,4.298,4.57,4.488,4.312,4.49,4.716,4.5,4.588,4.619,4.584,4.265,4.202,4.018,3.946,3.858,3.844,3.836,3.933,4.001,4.004,4.301,5.75,5.414,5.205,5.053,4.472,4.882,4.624,4.649,4.85,4.516,4.427,4.5,4.414,4.377,4.53,4.45,4.282,4.268,4.243,4.241,4.213,4.22,4.219,4.2,4.131,4.223,4.38,4.338,4.301,4.286,4.495,4.465,4.375,4.273,4.267,4.268,4.266,4.294,4.488,4.413,4.575,4.438,4.669,4.696,4.516,4.789,5.055,4.46,4.385,4.373,4.322,4.313,4.319,4.545,4.864,4.975,4.443,4.431,4.584,4.777,4.407,4.124,4.124,4.121,4.121,4.125,4.123,4.126,4.124,4.13,4.147,4.123,4.158,4.339,4.429],
    compound: [2.845,2.836,2.843,2.852,2.846,2.896,2.9,3.081,2.981,3.003,2.989,2.96,2.942,2.944,2.927,2.969,3.008,3.018,3.025,3.034,3.038,3.014,3.055,2.914,2.962,2.95,3.128,2.96,2.907,2.875,2.892,3.063,3.217,5.403,4.071,5.208,3.144,7.009,4.328,5.133,6.273,4.404,4.704,5.175,3.215,5.657,3.506,7.036,5.637,3.225,3.181,4.198,4.275,6.28,3.223,6.637,3.2,3.159,3.342,5.698,3.249,6.633,5.916,3.172,4.078,3.236,3.222,3.55,3.203,4.522,3.161,3.17,5.379,7.732,5.873,7.02,7.963,4.239,3.725,3.219,3.171,3.299,3.237,3.236,3.656,4.044,6.304,3.216,5.822,4.739,3.894,5.061,3.189,3.157,3.248,4.443,6.966,4.116,5.169,3.235,3.205,3.163,3.147,5.243,3.195,4.555,3.221,4.293,3.182,4.756,5.288,4.108,7.531,5.146,6.493,7.608,6.197,7.742,3.235,3.215,5.94,4.791,3.229,5.654,6.019,6.849,4.779,4.968,3.82,5.489,4.155,3.767,4.842,6.003,6.062,4.983,4.64,3.233,4.485,3.131,3.659,5.472,3.805,5.299,7.112,5.284,6.247,5.751,5.263,4.275,3.226,3.265,4.261,3.803,4.883,7.388,4.617,4.415,5.688,3.362,4.01,5.95],
  },
};

// Recorded vault TVL, one point per day the sampler persisted. The series
// stops at its last persisted day; seamMessage() below reconciles that day to
// the live tvlUsd rather than letting the chart's end read as today.
// `yieldUsd` is the share-price appreciation over the same window, which is
// what separates "the vault grew" from "the vault earned".
const RECORDED_TVL = {
  points: [["2026-05-26",108.79],["2026-05-27",124.99],["2026-05-28",125.02],["2026-05-29",125.02],["2026-05-30",130.39],["2026-05-31",133.73],["2026-06-01",133.75],["2026-06-03",136.22],["2026-06-04",139.01],["2026-06-05",139.03],["2026-06-06",139.04],["2026-06-07",141.83],["2026-06-08",141.85],["2026-06-09",142.18],["2026-06-10",142.88],["2026-06-11",145.39],["2026-06-12",145.4],["2026-06-13",145.61],["2026-06-14",146.3],["2026-06-16",149.03],["2026-06-17",149.04],["2026-06-19",149.89],["2026-06-20",150.69],["2026-06-21",151.49],["2026-06-22",152.3],["2026-06-23",153.11],["2026-06-24",153.91],["2026-06-25",153.92],["2026-06-26",155.48],["2026-06-27",159.19],["2026-06-28",165.52],["2026-06-29",165.53],["2026-06-30",165.56],["2026-07-01",166.34],["2026-07-02",166.66],["2026-07-03",167.27],["2026-07-04",169.31],["2026-07-05",169.61],["2026-07-06",170.24],["2026-07-07",170.66],["2026-07-08",171.2],["2026-07-09",181.67],["2026-07-10",182.21],["2026-07-11",182.69],["2026-07-12",183.2],["2026-07-13",184.64],["2026-07-14",187.51],["2026-07-15",187.53],["2026-07-16",187.55],["2026-07-17",188.09],["2026-07-18",188.57],["2026-07-19",189.09],["2026-07-20",189.59],["2026-07-21",190.1],["2026-07-22",192.53],["2026-07-23",192.56],["2026-07-24",193.37],["2026-07-25",193.67],["2026-07-26",194.3],["2026-07-27",194.72],["2026-07-28",195.29],["2026-07-29",199.67],["2026-07-30",200.48],["2026-07-31",200.78],["2026-08-01",201.41],["2026-08-02",201.83],["2026-08-03",202.39],["2026-08-04",202.85]],
  yieldUsd: 1.24,
};

// The withdrawal fee, charged once, on the way out. There is no management
// fee. Every "after the withdrawal fee" figure on the page is a gross figure
// minus this, held for a year.
const WITHDRAWAL_FEE_PCT = 0.25;

// RM-97 vocabulary. The allocation DTO still serves the legacy labels; this is
// the display-layer rename, keyed on the bucket key so a label edit upstream
// cannot silently fall back to the old wording. Retired here: Conservative
// DeFi Yield, Agent Tokens, bucket, strategy, slice, leg.
const SLEEVE_NAMES = {
  "defi-yield": "Fixed income",
  "agent-tokens": "Small cap tokens",
  "protocol-tokens": "Protocol tokens",
  rwa: "Real world assets",
};

// The fixed-income sleeve is the only one the vault holds anything in: the
// ERC-4626 contract's assets are its three lending adapters plus idle USDC.
const FIXED_INCOME_KEY = "defi-yield";

// Adapter display names and venue types. vault-economics serves the protocol
// name only ("Morpho"), but Morpho's position is a specific curated vault and
// saying so is the difference between "three lending venues" and "two pooled
// markets and a vault somebody else sets the caps on" — which is the whole
// content of the Risk section's middle cell. An adapter not in this map still
// renders, under its own name, rather than disappearing.
const ADAPTER_DISPLAY = {
  aave: { label: "Aave V3 USDC", type: "Pooled market", managed: false },
  morpho: { label: "Gauntlet USDC Prime", type: "Curated vault", managed: true },
  compound: { label: "Compound III USDC", type: "Pooled market", managed: false },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SVG_NS = "http://www.w3.org/2000/svg";

/** @param {string} name @param {Record<string, string | number>} attrs */
function svg(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const key in attrs) node.setAttribute(key, String(attrs[key]));
  return node;
}
/** @param {Element} node @param {string} text */
function label(node, text) {
  node.textContent = text;
  return node;
}

/** Mean of a numeric array; null on empty so a missing window never reads 0. */
function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Trailing-mean smoother. Venue rates spike (Aave touched 13.05% for one day
 *  in March), so every charted line is a 7-day trailing mean; the period table
 *  and the day counts stay unsmoothed. */
function trailing(values, window) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/** ISO days from REFERENCE.start, one per sample. */
function referenceDates() {
  const out = [];
  const [y, m, d] = REFERENCE.start.split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < REFERENCE.venues.aave.length; i++) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** "2026-08-04" → "4 Aug 2026". */
function longDay(iso) {
  const parts = String(iso || "").split("-");
  if (parts.length !== 3) return "—";
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}
/** "2026-08-04" → "4 Aug". */
function shortDay(iso) {
  const parts = String(iso || "").split("-");
  if (parts.length !== 3) return "—";
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]}`;
}

const DATES = referenceDates();
const RAW_BLEND = REFERENCE.venues.aave.map(
  (a, i) => (a + REFERENCE.venues.morpho[i] + REFERENCE.venues.compound[i]) / 3,
);
const SMOOTH = {
  aave: trailing(REFERENCE.venues.aave, 7),
  morpho: trailing(REFERENCE.venues.morpho, 7),
  compound: trailing(REFERENCE.venues.compound, 7),
};
SMOOTH.blend = SMOOTH.aave.map((a, i) => (a + SMOOTH.morpho[i] + SMOOTH.compound[i]) / 3);
const BAND = {
  lo: SMOOTH.aave.map((a, i) => Math.min(a, SMOOTH.morpho[i], SMOOTH.compound[i])),
  hi: SMOOTH.aave.map((a, i) => Math.max(a, SMOOTH.morpho[i], SMOOTH.compound[i])),
};
const LAST = DATES.length - 1;

export function registerVaultView(Alpine) {
  Alpine.data("vaultView", () => ({
    economics: null, // GET /api/dashboards/vault-economics
    allocationFw: null, // GET /api/dashboards/allocation
    loading: true,
    showAllDays: false,

    // Exposed so the view can render the dataset's own dates and length
    // instead of a copywritten "162 days" that stops being true.
    reference: REFERENCE,
    trackRecordDays: DATES.length,
    feePct: WITHDRAWAL_FEE_PCT,

    init() {
      this.load();
    },

    // Both feeds are fetched independently (allSettled semantics), so one
    // degraded endpoint leaves only its own widget on "—" rather than
    // blanking a page about money. A failed leg becomes null, never a
    // fabricated value.
    async load() {
      const fetchInto = (key, route) =>
        api.get(route).then((d) => { this[key] = d; }).catch(() => { this[key] = null; });
      await Promise.allSettled([
        fetchInto("economics", ROUTES.dashboards.vaultEconomics),
        fetchInto("allocationFw", ROUTES.dashboards.allocation),
      ]);
      this.loading = false;
      this.$nextTick(() => this.draw());
    },

    // ── formatters ──────────────────────────────────────────────────────────
    fmtUsd(v) {
      if (v == null || !isFinite(v)) return "—";
      const n = Number(v);
      return "$" + n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1000 ? 2 : 0 });
    },
    fmtUsd2(v) {
      return v == null || !isFinite(v)
        ? "—"
        : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    // A percentage already expressed in points (4.16 → "4.16%").
    fmtPct(v) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(2) + "%"; },
    fmtPct1(v) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(1) + "%"; },
    // A percentage-point difference, always signed.
    fmtPp(v) {
      if (v == null || !isFinite(v)) return "—";
      return (v >= 0 ? "+" : "−") + Math.abs(Number(v)).toFixed(2) + "pp";
    },
    fmtPp1(v) {
      if (v == null || !isFinite(v)) return "—";
      return (v >= 0 ? "+" : "−") + Math.abs(Number(v)).toFixed(1) + "pp";
    },
    // A fraction 0..1 from the API (apy7d) → "4.20%".
    fmtRate(v) { return v == null || !isFinite(v) ? "—" : (Number(v) * 100).toFixed(2) + "%"; },

    // ── the reference series, as figures ────────────────────────────────────
    // The latest 7-day trailing mean of the equal-weight blend, and of Aave on
    // its own. These are the two figures the chart's end labels carry.
    blendNow() { return SMOOTH.blend[LAST]; },
    aaveNow() { return SMOOTH.aave[LAST]; },
    // Gross minus the one-off withdrawal fee, held for a year.
    blendNetNow() { return SMOOTH.blend[LAST] - WITHDRAWAL_FEE_PCT; },
    // Since-inception means, unsmoothed. The stat rail's "net vs Aave" is this
    // gap after the fee — the figure a depositor actually keeps.
    inceptionBlend() { return mean(RAW_BLEND); },
    inceptionAave() { return mean(REFERENCE.venues.aave); },
    netVsAave() { return this.inceptionBlend() - this.inceptionAave() - WITHDRAWAL_FEE_PCT; },
    // Months of holding before the annual advantage covers the one-off fee.
    breakEvenMonths() {
      const edge = this.inceptionBlend() - this.inceptionAave();
      if (!edge || edge <= 0) return null;
      return (WITHDRAWAL_FEE_PCT / edge) * 12;
    },
    // Day counts, unsmoothed: the honest form of "does the blend beat X".
    daysAheadOfAave() {
      return RAW_BLEND.filter((b, i) => b > REFERENCE.venues.aave[i]).length;
    },
    daysBehindMorpho() {
      return RAW_BLEND.filter((b, i) => b < REFERENCE.venues.morpho[i]).length;
    },
    // The unsmoothed period table. `days: null` means since inception.
    periodRows() {
      const windows = [
        { label: "30 days", days: 30 },
        { label: "90 days", days: 90 },
        { label: `Since inception · ${DATES.length}d`, days: null, total: true },
      ];
      return windows.map((w) => {
        const cut = (arr) => (w.days == null ? arr : arr.slice(-w.days));
        const vault = mean(cut(RAW_BLEND));
        const aave = mean(cut(REFERENCE.venues.aave));
        return {
          label: w.label,
          total: !!w.total,
          vault,
          aave,
          morpho: mean(cut(REFERENCE.venues.morpho)),
          compound: mean(cut(REFERENCE.venues.compound)),
          vsAave: vault == null || aave == null ? null : vault - aave,
        };
      });
    },

    // ── the recorded TVL series ─────────────────────────────────────────────
    recordedFirst() { return RECORDED_TVL.points[0]; },
    recordedLast() { return RECORDED_TVL.points[RECORDED_TVL.points.length - 1]; },
    recordedStartLabel() { return shortDay(this.recordedFirst()[0]); },
    recordedEndLabel() { return longDay(this.recordedLast()[0]); },
    // Growth over the recorded window, decomposed. 1.3% of it is earnings and
    // the rest is money arriving; without the split the slope reads as
    // performance, which it is not.
    growthUsd() { return this.recordedLast()[1] - this.recordedFirst()[1]; },
    growthYieldUsd() { return RECORDED_TVL.yieldUsd; },
    growthDepositsUsd() { return this.growthUsd() - RECORDED_TVL.yieldUsd; },
    growthYieldShare() {
      const g = this.growthUsd();
      return g ? (RECORDED_TVL.yieldUsd / g) * 100 : null;
    },

    // ── degradation states ──────────────────────────────────────────────────
    // Carried over from /allocation and /performance in full. A page about
    // money that silently assumes fresh data is a regression, so every one of
    // these renders a visible badge rather than a console warning.

    // The vault feed is serving hermetic stub data, not a chain read.
    vaultNonLive() { return this.economics?.source === "stub"; },
    // The live RPC read failed and every figure is the last persisted sample.
    vaultStale() { return this.economics?.stale === true; },
    // issue #614 AC4: a same-bucket scheduler catch-up — a genuinely live
    // read, only a late one. Distinct from stub (never a chain read) and from
    // stale (a degraded leg reusing an OLDER value).
    vaultBackfilled() {
      return (this.economics?.adapters || []).some((a) => a.provenance === "backfilled");
    },
    // The target weights are seeded rather than swarm-managed.
    allocationNonLive() { return this.allocationFw?.source === "stub"; },
    // Per-adapter stale label, the vault-side counterpart of /allocation's
    // sleeveStaleLabel(w): names the observation time so "stale" is a date, not
    // an adjective.
    sleeveStaleLabel(adapter) {
      const degraded = adapter?.provenance === "stale" || this.vaultStale();
      if (!degraded) return "";
      const observed = adapter?.balanceObservedAt || this.economics?.asOf;
      if (!observed) return "stale";
      const when = new Date(observed).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
      }) + " UTC";
      return `stale (${when})`;
    },
    asOfLabel() {
      const asOf = this.economics?.asOf;
      if (!asOf) return "—";
      const when = new Date(asOf).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
      }) + " UTC";
      return this.vaultStale() ? `${when} (stale)` : when;
    },
    // issue #614 AC5: the unrecoverable window between the recorded series and
    // the live read. Non-null renders the seam banner under the value chart.
    seamMessage() {
      const end = this.recordedLast()[0];
      const endMs = Date.parse(end + "T00:00:00Z");
      if (!isFinite(endMs)) return null;
      const days = Math.floor((Date.now() - endMs) / 86_400_000);
      if (days <= 0) return null;
      const live = this.economics?.tvlUsd;
      const holds = live == null
        ? "The live figure is above."
        : `The vault holds ${this.fmtUsd2(live)} today;`;
      return `This series ends ${longDay(end)}. ${holds} the ${days} day${days === 1 ? "" : "s"} `
        + `in between are in process of being retrieved from the blockchain.`;
    },

    // ── sleeves: allocation (target) against holdings (actual) ──────────────
    // The vault's assets are its three lending adapters plus idle USDC, so
    // everything it holds sits in fixed income. Held weight is COMPUTED from
    // the live adapter balances rather than asserted, which is what makes
    // "held at zero" a reading instead of a copy decision.
    adapters() { return this.economics?.adapters || []; },
    fundedAdapters() {
      return this.adapters().filter((a) => a.configured !== false && a.balanceUsd != null);
    },
    adaptersTotalUsd() {
      const funded = this.fundedAdapters();
      if (!funded.length) return null;
      return funded.reduce((sum, a) => sum + Number(a.balanceUsd), 0);
    },
    // Sleeve rows for the bullet bars and the mandate fan.
    sleeves() {
      const buckets = this.allocationFw?.buckets || [];
      const strategy = this.allocationFw?.strategy || [];
      const tvl = this.economics?.tvlUsd;
      const fixedIncome = this.adaptersTotalUsd();
      return buckets.map((b, i) => {
        const target = Number(strategy[i]?.targetPct ?? 0);
        const held = b.key === FIXED_INCOME_KEY
          ? (tvl && fixedIncome != null ? (fixedIncome / tvl) * 100 : null)
          : 0;
        return {
          key: b.key,
          name: SLEEVE_NAMES[b.key] || b.label,
          target,
          held,
          drift: held == null ? null : held - target,
          holding: held != null && held > 0,
        };
      });
    },
    // The legend rows, phrased the way the page talks about them.
    sleeveState(s) {
      if (s.held == null) return "—";
      return s.holding ? "holding" : "held at zero";
    },

    // ── the allocation rail ─────────────────────────────────────────────────
    // One hue per sleeve, taken from the shared chart palette so a sleeve keeps
    // its colour wherever it appears. Falls through to the categorical order for
    // a sleeve the framework adds later, rather than repeating a hue.
    sleeveHue(key) {
      const fixed = {
        [FIXED_INCOME_KEY]: SERIES.emerald,
        "protocol-tokens": SERIES.sand,
        rwa: SERIES.slate,
        "agent-tokens": PALETTE.accent,
      };
      if (fixed[key]) return fixed[key];
      let h = 0;
      for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return CATEGORICAL[h % CATEGORICAL.length];
    },
    // Cumulative target boundaries, so a tick sits where each sleeve's target
    // ends. The last one is omitted: a tick at 100% is the end of the bar.
    targetTicks() {
      const out = [];
      let cum = 0;
      const rows = this.sleeves();
      rows.forEach((s, i) => {
        cum += Number(s.target) || 0;
        if (i < rows.length - 1 && cum > 0 && cum < 100) out.push(Number(cum.toFixed(2)));
      });
      return out;
    },
    // Funded sleeves get a row each. Everything held at zero collapses into one
    // muted row — four separate "0%" rows made the empty sleeves the loudest
    // thing in the hero, which is the opposite of what they are.
    railRows() {
      const rows = this.sleeves();
      const funded = rows.filter((s) => s.holding);
      const empty = rows.filter((s) => !s.holding);
      const out = funded.map((s) => ({
        key: s.key,
        name: s.name,
        muted: false,
        line: `${this.fmtPct1(s.held)} held · ${this.fmtPctTrim(s.target)} allocation`,
      }));
      if (empty.length) {
        out.push({
          key: "held-at-zero",
          name: empty.map((s) => s.name).join(", "),
          muted: true,
          line: "held at zero",
        });
      }
      return out;
    },
    railLabel() {
      const rows = this.sleeves();
      if (!rows.length) return "Allocation unavailable";
      return rows
        .map((s) => `${s.name} ${this.fmtPct1(s.held)} held against a ${this.fmtPctTrim(s.target)} allocation`)
        .join("; ");
    },
    // A target weight, at one decimal but with a trailing ".0" trimmed: 25%,
    // 14.3%, 50%. Held weights keep the decimal (100.0%, 0.0%) because a
    // holding that reads "0%" and one that reads "0.0%" are different claims
    // about how closely it was measured.
    fmtPctTrim(v) {
      if (v == null || !isFinite(v)) return "—";
      return this.fmtPctTrimBare(v) + "%";
    },
    fmtPctTrimBare(v) {
      if (v == null || !isFinite(v)) return "—";
      return Number(v).toFixed(1).replace(/\.0$/, "");
    },
    // Header figure on each small multiple.
    sleeveWeightLabel(s) {
      if (s.held == null) return "—";
      if (s.holding) return `${this.fmtPct1(s.held)} held`;
      return s.target > 0 ? `${this.fmtPct1(0)} held · ${this.fmtPctTrim(s.target)} target` : "held at zero";
    },

    // ── constituents (small multiples) ──────────────────────────────────────
    // Within-sleeve weights. Fixed income's come from the live adapter
    // balances; every other sleeve holds nothing, so its constituents render
    // as a hatched allocation against a zero holding.
    constituents(sleeveKey) {
      const bucket = (this.allocationFw?.buckets || []).find((b) => b.key === sleeveKey);
      if (!bucket) return [];
      const total = this.adaptersTotalUsd();
      return (bucket.items || []).map((item) => {
        const target = Number(item.targetPct ?? 0);
        let held = 0;
        if (sleeveKey === FIXED_INCOME_KEY && total) {
          const adapter = this.adapters().find(
            (a) => String(a.name).toLowerCase() === String(item.label).toLowerCase(),
          );
          held = adapter && adapter.balanceUsd != null ? (Number(adapter.balanceUsd) / total) * 100 : 0;
        }
        return { label: item.label, target, held, holding: held > 0 };
      });
    },
    constituentValue(c) {
      return c.holding ? this.fmtPct1(c.held) : `0% / ${this.fmtPctTrim(c.target)}`;
    },

    // ── holdings ────────────────────────────────────────────────────────────
    // Balance AND price, never value alone, plus idle USDC — without both the
    // rows cannot be checked against totalAssets().
    adapterLabel(a) { return ADAPTER_DISPLAY[String(a?.name).toLowerCase()]?.label || a?.name || "—"; },
    adapterType(a) { return ADAPTER_DISPLAY[String(a?.name).toLowerCase()]?.type || "—"; },
    // issue #50: an adapter still at its placeholder address is reported
    // configured:false with balanceUsd:null — render that explicitly, never a
    // live-looking $0.
    adapterValue(a) {
      return a && a.configured === false ? "Not configured" : this.fmtUsd2(a?.balanceUsd);
    },
    // Every adapter is a USDC-denominated lending position, so its unit
    // balance is balanceUsd at a $1.0000 peg — not a second, independently
    // fabricated number. Unknown adapters show "—", never an invented price.
    adapterBalance(a) {
      return a && a.configured !== false && a.balanceUsd != null
        ? Number(a.balanceUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "—";
    },
    adapterPrice(a) {
      return a && a.configured !== false && a.balanceUsd != null ? "$1.0000" : "—";
    },
    adapterWeight(a) {
      const tvl = this.economics?.tvlUsd;
      if (!tvl || a?.balanceUsd == null || a.configured === false) return "—";
      return this.fmtPct1((Number(a.balanceUsd) / tvl) * 100);
    },
    idleUsdc() { return this.economics?.idleUsdc; },
    idleWeight() {
      const tvl = this.economics?.tvlUsd;
      const idle = this.idleUsdc();
      if (!tvl || idle == null) return "—";
      return this.fmtPct1((Number(idle) / tvl) * 100);
    },
    tvlUsd() { return this.economics?.tvlUsd; },

    // NAV per share is a POINT-IN-TIME value and vault-economics already
    // returns it, so it publishes now. Only drawdown and Sharpe wait on the
    // vault_share_price_history route, because those need the series this one
    // number cannot stand in for.
    navPerShare() {
      const p = this.economics?.sharePrice;
      return p == null ? null : Number(p);
    },
    navPerShareLabel() {
      const p = this.navPerShare();
      return p == null ? "not yet published" : "$" + p.toFixed(4);
    },

    // ── risk ────────────────────────────────────────────────────────────────
    // Concentration, computed from the live balances: what one venue failing
    // would cost. Not a drawdown percentage — a venue failing is the risk the
    // yield is being paid for.
    largestVenuePct() {
      const total = this.adaptersTotalUsd();
      if (!total) return null;
      const largest = Math.max(...this.fundedAdapters().map((a) => Number(a.balanceUsd)));
      return (largest / total) * 100;
    },
    managedVenues() {
      return this.fundedAdapters().filter(
        (a) => ADAPTER_DISPLAY[String(a.name).toLowerCase()]?.managed,
      ).length;
    },
    venueCount() { return this.fundedAdapters().length; },
    managedVenueName() {
      const managed = this.fundedAdapters().find(
        (a) => ADAPTER_DISPLAY[String(a.name).toLowerCase()]?.managed,
      );
      return managed ? this.adapterLabel(managed) : "—";
    },

    // ── daily series ────────────────────────────────────────────────────────
    dailyRows() {
      const byDate = new Map(RECORDED_TVL.points);
      const rows = DATES.map((d, i) => ({
        date: d,
        tvl: byDate.has(d) ? byDate.get(d) : null,
        vault: SMOOTH.blend[i],
        aave: SMOOTH.aave[i],
        morpho: SMOOTH.morpho[i],
        compound: SMOOTH.compound[i],
      }));
      return this.showAllDays ? rows : rows.slice(-5);
    },
    dailyTotal() { return DATES.length; },

    // ── charts (hand-authored inline SVG; no chart dependency) ──────────────
    draw() {
      this.drawYield();
      this.drawValue();
    },

    drawYield() {
      const host = this.$refs.yield;
      const tip = this.$refs.yieldTip;
      if (!host) return;
      host.replaceChildren();

      const W = 900, H = 280, L = 46, R = 66, T = 16, B = 34, LO = 2.2, HI = 6.6;
      const n = DATES.length;
      const X = (i) => L + ((W - L - R) * i) / (n - 1);
      const Y = (v) => T + ((H - T - B) * (HI - v)) / (HI - LO);
      host.setAttribute("viewBox", `0 0 ${W} ${H}`);

      for (let g = 3; g <= 6.01; g += 1) {
        host.appendChild(svg("line", { class: "grid", x1: L, y1: Y(g), x2: W - R, y2: Y(g) }));
        host.appendChild(label(svg("text", { class: "axtxt", x: L - 8, y: Y(g) + 3.5, "text-anchor": "end" }), g + "%"));
      }
      const seen = {};
      DATES.forEach((d, i) => {
        const month = d.slice(0, 7);
        if (seen[month]) return;
        seen[month] = 1;
        host.appendChild(label(svg("text", { class: "axtxt", x: X(i), y: H - 12, "text-anchor": "middle" }),
          MONTHS[Number(d.slice(5, 7)) - 1]));
      });

      const up = BAND.hi.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
      const down = BAND.lo.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).reverse().join(" ");
      host.appendChild(svg("polygon", { points: `${up} ${down}`, fill: "rgba(126,136,158,0.22)" }));

      const points = (arr) => arr.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
      host.appendChild(svg("polyline", {
        points: points(SMOOTH.aave), fill: "none", stroke: PALETTE.textMuted,
        "stroke-width": 1.75, "stroke-dasharray": "5 4", "stroke-linejoin": "round",
      }));
      host.appendChild(svg("polyline", {
        points: points(SMOOTH.blend), fill: "none", stroke: SERIES.emerald,
        "stroke-width": 2.5, "stroke-linejoin": "round",
      }));

      [[SMOOTH.blend[LAST], SERIES.emerald, "Vault"], [SMOOTH.aave[LAST], PALETTE.textMuted, "Aave"]]
        .forEach(([v, colour, name]) => {
          host.appendChild(svg("circle", {
            cx: X(LAST), cy: Y(v), r: 3.5, fill: colour, stroke: PALETTE.deep, "stroke-width": 2,
          }));
          host.appendChild(label(svg("text", { class: "endlbl", x: X(LAST) + 9, y: Y(v) + 4, fill: colour }),
            v.toFixed(2) + "%"));
          host.appendChild(label(svg("text", { class: "axtxt", x: X(LAST) + 9, y: Y(v) + 15 }), name));
        });

      const cross = svg("line", { x1: 0, y1: T, x2: 0, y2: H - B, stroke: PALETTE.borderLight, "stroke-width": 1, opacity: 0 });
      host.appendChild(cross);
      host.setAttribute("aria-label", `Vault blended yield, 7-day trailing mean, drawn inside the range of its three venues, with Aave as the named benchmark, ${shortDay(DATES[0])} to ${shortDay(DATES[LAST])} ${DATES[LAST].slice(0, 4)}.`);

      if (!tip) return;
      host.addEventListener("pointermove", (ev) => {
        const rect = host.getBoundingClientRect();
        let i = Math.round(((((ev.clientX - rect.left) / rect.width) * W - L) / (W - L - R)) * (n - 1));
        i = Math.max(0, Math.min(n - 1, i));
        cross.setAttribute("x1", String(X(i)));
        cross.setAttribute("x2", String(X(i)));
        cross.setAttribute("opacity", "1");
        tip.innerHTML = `<b>${shortDay(DATES[i])}</b>`
          + `<span><i style="background:${SERIES.emerald}"></i>Vault ${SMOOTH.blend[i].toFixed(2)}%</span>`
          + `<span><i style="background:${PALETTE.textMuted}"></i>Aave ${SMOOTH.aave[i].toFixed(2)}%</span>`
          + `<span class="vp__tip-soft">Morpho ${SMOOTH.morpho[i].toFixed(2)}% · Compound ${SMOOTH.compound[i].toFixed(2)}%</span>`;
        tip.style.opacity = "1";
        const lx = (X(i) / W) * rect.width;
        tip.style.left = Math.min(Math.max(lx + 14, 8), Math.max(8, rect.width - 210)) + "px";
        tip.style.top = "16px";
      });
      host.addEventListener("pointerleave", () => {
        tip.style.opacity = "0";
        cross.setAttribute("opacity", "0");
      });
    },

    // Value over time: an area, explicitly labelled a size chart, with the
    // growth decomposed above it. Without the decomposition the slope reads as
    // performance when 1.3% of it is earnings.
    drawValue() {
      const host = this.$refs.value;
      const tip = this.$refs.valueTip;
      if (!host) return;
      host.replaceChildren();

      const series = RECORDED_TVL.points;
      const W = 900, H = 200, L = 52, R = 66, T = 16, B = 32;
      const m = series.length;
      const peak = Math.max(...series.map(([, v]) => v));
      const HI = Math.max(50, Math.ceil((peak * 1.08) / 50) * 50);
      const X = (i) => L + ((W - L - R) * i) / (m - 1);
      const Y = (v) => T + ((H - T - B) * (HI - v)) / HI;
      host.setAttribute("viewBox", `0 0 ${W} ${H}`);

      for (let g = 0; g <= HI + 0.1; g += HI / 4) {
        host.appendChild(svg("line", { class: "grid", x1: L, y1: Y(g), x2: W - R, y2: Y(g) }));
        host.appendChild(label(svg("text", { class: "axtxt", x: L - 8, y: Y(g) + 3.5, "text-anchor": "end" }), "$" + Math.round(g)));
      }
      const seen = {};
      series.forEach(([d], i) => {
        const month = d.slice(0, 7);
        if (seen[month]) return;
        seen[month] = 1;
        host.appendChild(label(svg("text", { class: "axtxt", x: X(i), y: H - 11, "text-anchor": "middle" }),
          MONTHS[Number(d.slice(5, 7)) - 1]));
      });

      const line = series.map(([, v], i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
      host.appendChild(svg("polygon", {
        points: `${L},${Y(0)} ${line} ${X(m - 1)},${Y(0)}`, fill: "rgba(16,185,129,0.16)",
      }));
      host.appendChild(svg("polyline", {
        points: line, fill: "none", stroke: SERIES.emerald, "stroke-width": 2, "stroke-linejoin": "round",
      }));
      host.appendChild(svg("circle", {
        cx: X(m - 1), cy: Y(series[m - 1][1]), r: 3.5, fill: SERIES.emerald,
        stroke: PALETTE.deep, "stroke-width": 2,
      }));
      host.appendChild(label(svg("text", {
        class: "endlbl", x: X(m - 1) + 9, y: Y(series[m - 1][1]) + 4, fill: SERIES.emerald,
      }), this.fmtUsd2(series[m - 1][1])));

      const cross = svg("line", { x1: 0, y1: T, x2: 0, y2: H - B, stroke: PALETTE.borderLight, "stroke-width": 1, opacity: 0 });
      host.appendChild(cross);
      host.setAttribute("aria-label", `Recorded vault TVL in US dollars, ${shortDay(series[0][0])} to ${shortDay(series[m - 1][0])} ${series[m - 1][0].slice(0, 4)}, rising from ${this.fmtUsd2(series[0][1])} to ${this.fmtUsd2(series[m - 1][1])}, almost all of it deposits.`);

      if (!tip) return;
      host.addEventListener("pointermove", (ev) => {
        const rect = host.getBoundingClientRect();
        let i = Math.round(((((ev.clientX - rect.left) / rect.width) * W - L) / (W - L - R)) * (m - 1));
        i = Math.max(0, Math.min(m - 1, i));
        cross.setAttribute("x1", String(X(i)));
        cross.setAttribute("x2", String(X(i)));
        cross.setAttribute("opacity", "1");
        tip.innerHTML = `<b>${shortDay(series[i][0])}</b>`
          + `<span><i style="background:${SERIES.emerald}"></i>${this.fmtUsd2(series[i][1])}</span>`;
        tip.style.opacity = "1";
        const lx = (X(i) / W) * rect.width;
        tip.style.left = Math.min(Math.max(lx + 14, 8), Math.max(8, rect.width - 118)) + "px";
        tip.style.top = "16px";
      });
      host.addEventListener("pointerleave", () => {
        tip.style.opacity = "0";
        cross.setAttribute("opacity", "0");
      });
    },
  }));
}
