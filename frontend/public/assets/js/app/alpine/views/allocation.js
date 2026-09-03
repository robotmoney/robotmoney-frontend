// Alpine factory for /allocation — the product sheet (RM-115, container rule
// RM-114).
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: it reads
// GET /api/dashboards/allocation, GET /api/dashboards/vault-economics and
// GET /api/swarm/sessions, and NOTHING ELSE. It must never read
// wallet-balances or wallet-sleeves. Those are the three protocol-owned prop
// wallets — the house book, a different pot of money with different owners,
// moving to the token page under RM-103. The page this replaced added the two
// together under one "Total AUM" heading, which on 2026-09-02 put a $229 vault
// inside a $59.4k figure, 0.4% of the number a reader took for the vault,
// while backend config.ts throws at boot if a prop wallet is ever configured
// as the vault ("would double-count vault TVL"). A reviewer should check that
// exclusion before anything else.
//
// The allocation is a POLICY, not a book of holdings (RM-114). This page is
// the policy as it stands now; /allocation/history is how it has changed;
// /swarm/subjects/:id is a book, and the vault keeps one.
//
// Live, per fetch:
//   allocation       the four sleeve target weights and their constituents,
//                    plus `asOf`. NOT `source`: on this DTO that is the Base
//                    RPC source, not the provenance of the weights.
//   vault-economics  tvlUsd, sharePrice, totalShares, idleUsdc, apy7d and the
//                    three adapter holdings (balance + provenance + observed
//                    time). These drive the Vault section, the held side of
//                    Allocation, and the fixed-income constituents.
//   swarm/sessions   the newest PUBLISHED session on the allocation subject,
//                    for the one-line latest recommendation.
//
// NOT live, and said so on the page:
//   * The per-venue APY series behind "What it pays" is REFERENCE below: a
//     dated dataset read by hand from each protocol's public rates. No
//     collector serves it, so it carries a visible non-live badge, its own
//     asOf, and seamMessage()'s disclosure of the window between its last day
//     and today.
//   * NAV per share and true period returns render "not yet published". There
//     is no GET route over `vault_share_price_history` (RM-115's first backend
//     ask). vault-economics does serve one SPOT `sharePrice`, which the Vault
//     section prints as a spot read with its own timestamp; one number is not
//     a series, and a since-inception return derived from it would be a
//     fabrication.
//   * The recommendation VECTOR. `robotmoney-allocation` is typed
//     `position_actions`, so meanTakeWeights() never runs for it and no
//     session publishes weights. The line shows the aggregator's rationale
//     instead of inventing a vector.
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, SERIES } from "../../lib/chart-theme.js";
import { ALLOCATION_SUBJECT_ID, VAULT_SUBJECT_ID, isPublishedAllocationSession } from "../../lib/allocation-subject.js";

// ── the reference dataset ───────────────────────────────────────────────────
// Daily USDC supply APY at the three venues the vault lends into, 2026-03-18
// to 2026-08-26 (162 days), read by hand from each protocol's public rates and
// frozen here. `asOf` is rendered next to every figure drawn from it so the
// page never presents it as a live read.
const REFERENCE = {
  start: "2026-03-18",
  asOf: "2026-08-26",
  venues: {
    aave: [2.55,2.509,2.579,2.594,2.586,2.863,2.345,2.333,2.384,2.439,2.474,2.474,2.51,2.689,2.657,2.705,2.576,2.599,2.604,2.721,2.763,2.696,2.721,2.707,2.699,2.685,2.661,3.015,2.768,2.695,2.791,3.283,13.048,5.135,3.514,3.874,3.442,3.503,3.562,3.427,3.486,3.486,3.393,3.377,3.367,3.333,3.331,3.422,3.388,3.412,3.382,3.37,3.327,3.298,3.264,3.215,3.138,3.063,3.074,2.93,2.867,2.859,2.92,2.953,3.056,3.133,3.1,3.119,3.13,3.11,3.203,3.203,3.222,3.202,3.235,3.247,3.339,3.397,3.257,3.231,3.107,3.153,3.181,3.142,3.189,3.219,3.123,3.117,3.175,3.196,3.181,3.238,3.135,3.136,3.081,3.084,3.099,3.096,3.141,3.175,3.148,3.155,3.158,3.181,3.225,3.164,3.121,3.142,3.085,3.14,3.093,3.081,3.119,3.144,3.058,3.051,3.12,3.147,3.014,3.025,3.023,3.066,3.102,3.103,2.982,2.703,2.72,3.409,3.399,3.532,3.486,3.453,3.542,3.524,3.438,3.547,3.547,3.482,3.457,3.333,3.344,3.366,3.265,3.383,3.447,3.583,3.602,3.636,3.589,3.501,3.554,3.564,3.942,3.522,3.462,3.449,3.332,3.157,3.169,3.226,3.093,3.013],
    morpho: [3.641,3.665,3.688,3.68,3.727,3.612,3.612,3.664,3.938,3.8,3.86,4.081,3.722,3.741,4.258,4.065,3.729,3.711,3.712,3.745,3.774,4.029,4.157,3.855,3.793,3.792,5.054,3.842,3.863,3.997,4.224,4.777,6.005,5.498,4.062,4.109,4.123,4.194,4.301,4.276,4.08,4.024,4.04,4.107,4.24,4.087,4.079,4.037,3.995,4.017,3.997,4.04,4.12,4.224,4.877,4.417,4.943,4.142,4.142,4.484,4.622,4.531,4.769,4.325,4.234,4.203,4.298,4.57,4.488,4.312,4.49,4.716,4.5,4.588,4.619,4.584,4.265,4.202,4.018,3.946,3.858,3.844,3.836,3.933,4.001,4.004,4.301,5.75,5.414,5.205,5.053,4.472,4.882,4.624,4.649,4.85,4.516,4.427,4.5,4.414,4.377,4.53,4.45,4.282,4.268,4.243,4.241,4.213,4.22,4.219,4.2,4.131,4.223,4.38,4.338,4.301,4.286,4.495,4.465,4.375,4.273,4.267,4.268,4.266,4.294,4.488,4.413,4.575,4.438,4.669,4.696,4.516,4.789,5.055,4.46,4.385,4.373,4.322,4.313,4.319,4.545,4.864,4.975,4.443,4.431,4.584,4.777,4.407,4.124,4.124,4.121,4.121,4.125,4.123,4.126,4.124,4.13,4.147,4.123,4.158,4.339,4.429],
    compound: [2.845,2.836,2.843,2.852,2.846,2.896,2.9,3.081,2.981,3.003,2.989,2.96,2.942,2.944,2.927,2.969,3.008,3.018,3.025,3.034,3.038,3.014,3.055,2.914,2.962,2.95,3.128,2.96,2.907,2.875,2.892,3.063,3.217,5.403,4.071,5.208,3.144,7.009,4.328,5.133,6.273,4.404,4.704,5.175,3.215,5.657,3.506,7.036,5.637,3.225,3.181,4.198,4.275,6.28,3.223,6.637,3.2,3.159,3.342,5.698,3.249,6.633,5.916,3.172,4.078,3.236,3.222,3.55,3.203,4.522,3.161,3.17,5.379,7.732,5.873,7.02,7.963,4.239,3.725,3.219,3.171,3.299,3.237,3.236,3.656,4.044,6.304,3.216,5.822,4.739,3.894,5.061,3.189,3.157,3.248,4.443,6.966,4.116,5.169,3.235,3.205,3.163,3.147,5.243,3.195,4.555,3.221,4.293,3.182,4.756,5.288,4.108,7.531,5.146,6.493,7.608,6.197,7.742,3.235,3.215,5.94,4.791,3.229,5.654,6.019,6.849,4.779,4.968,3.82,5.489,4.155,3.767,4.842,6.003,6.062,4.983,4.64,3.233,4.485,3.131,3.659,5.472,3.805,5.299,7.112,5.284,6.247,5.751,5.263,4.275,3.226,3.265,4.261,3.803,4.883,7.388,4.617,4.415,5.688,3.362,4.01,5.95],
  },
};

// The withdrawal fee, charged once, on the way out. There is no management
// fee. Every "after the withdrawal fee" figure on the page is a gross figure
// minus this, held for a year.
const WITHDRAWAL_FEE_PCT = 0.25;

// Deposit limits while the vault is young. Product facts, sourced from
// skill.md's error table and views/skills.html, not from a feed.
const TVL_CAP_USD = 100000;
const PER_DEPOSIT_CAP_USD = 5000;

// The ERC-4626 vault on Base. A public on-chain address, source of truth
// frontend/public/skill.md.
const VAULT_ADDRESS = "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd";

// The vault's assets are its three lending adapters plus idle USDC, so
// everything it holds sits in the fixed-income sleeve. Keyed on the
// framework's own bucket key.
const FIXED_INCOME_KEY = "defi-yield";

// Adapter display names and venue types. vault-economics serves the protocol
// name only ("Morpho"), but Morpho's position is a specific curated vault and
// saying so is the difference between "three lending venues" and "two pooled
// markets and a vault somebody else sets the caps on". An adapter not in this
// map still renders, under its own name, rather than disappearing.
const ADAPTER_DISPLAY = {
  aave: { label: "Aave V3 USDC", type: "Pooled market", managed: false },
  morpho: { label: "Gauntlet USDC Prime", type: "Curated vault", managed: true },
  compound: { label: "Compound III USDC", type: "Pooled market", managed: false },
};

// Sessions are served newest first (swarm_sessions ORDER BY date DESC), so the
// allocation's latest published session is normally on the first page. Walk a
// bounded number of pages rather than one, because a run of sessions on the
// other portfolios can push it off page one, and stop the moment it is found.
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 4;

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

export function registerAllocationView(Alpine) {
  Alpine.data("allocationView", () => ({
    economics: null,    // GET /api/dashboards/vault-economics
    allocationFw: null, // GET /api/dashboards/allocation
    latest: null,       // newest published session on the allocation subject
    sessionsFailed: false,
    loading: true,

    // Exposed so the view renders the dataset's own dates and length instead
    // of a copywritten "162 days" that stops being true.
    reference: REFERENCE,
    trackRecordDays: DATES.length,
    feePct: WITHDRAWAL_FEE_PCT,
    vaultAddress: VAULT_ADDRESS,
    vaultSubjectHref: `/swarm/subjects/${VAULT_SUBJECT_ID}`,
    historyHref: "/allocation/history",

    init() {
      this.load();
      this.$nextTick(() => this.draw());
    },

    // Every feed is fetched independently (allSettled semantics), so one
    // degraded endpoint leaves only its own widget on "—" rather than blanking
    // a page about money. A failed leg becomes null, never a fabricated value.
    async load() {
      const fetchInto = (key, route) =>
        api.get(route).then((d) => { this[key] = d; }).catch(() => { this[key] = null; });
      await Promise.allSettled([
        fetchInto("economics", ROUTES.dashboards.vaultEconomics),
        fetchInto("allocationFw", ROUTES.dashboards.allocation),
        this.loadLatestSession(),
      ]);
      this.loading = false;
      this.$nextTick(() => this.draw());
    },

    // The one line the page needs from the swarm: what the allocation's most
    // recent published session came out with. `sessionsFailed` is tracked
    // separately from "there is no session", because a dead feed and an empty
    // history are different facts and the page says which one it is.
    async loadLatestSession() {
      let cursor = null;
      try {
        for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
          const query = { limit: String(SESSION_PAGE_SIZE) };
          if (cursor) query.cursor = cursor;
          const res = await api.get(ROUTES.swarm.sessions, query);
          const hit = (res.sessions || []).find(isPublishedAllocationSession);
          if (hit) { this.latest = hit; return; }
          cursor = res.nextCursor || null;
          if (!cursor) return;
        }
      } catch (_) {
        this.sessionsFailed = true;
      }
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
    // A target weight at one decimal with a trailing ".0" trimmed: 95%, 14.3%.
    // Held weights keep the decimal (100.0%, 0.0%) because a holding that
    // reads "0%" and one that reads "0.0%" are different claims about how
    // closely it was measured.
    fmtPctTrim(v) {
      if (v == null || !isFinite(v)) return "—";
      return this.fmtPctTrimBare(v) + "%";
    },
    fmtPctTrimBare(v) {
      if (v == null || !isFinite(v)) return "—";
      return Number(v).toFixed(1).replace(/\.0$/, "");
    },
    fmtDay(iso) { return longDay(iso); },

    // ── the allocation in force ─────────────────────────────────────────────
    allocationAsOf() { return this.allocationFw?.asOf || null; },
    allocationAsOfLabel() {
      const asOf = this.allocationAsOf();
      return asOf ? longDay(asOf) : "—";
    },
    hasTargets() { return this.sleeves().length > 0; },
    // The state chip, and the one place on this page it would be easy to lie.
    //
    // NEITHER FIELD ON THIS DTO ANSWERS THE QUESTION. `source` is
    // resolveBaseRpcSource() — whether the Base RPC is live or the hermetic
    // stub — which has nothing to do with where a row of weights came from,
    // and `managed` is hardcoded `true` in
    // backend/src/chain/allocation-framework.ts. Keying the chip on either one
    // would print "swarm-managed" on production for a row the database seed
    // wrote.
    //
    // A row a session actually produced will carry PROVENANCE: the session id
    // and the receipt digest behind it, which is RM-115's closing backend ask.
    // Nothing writes that field today, so this is false for every row the API
    // serves and the chip reads "seeded" — which is true. It is not hardcoded:
    // the day the field arrives the chip flips with no edit here.
    isSwarmManaged() {
      return this.hasTargets() && !!this.allocationFw?.provenance?.sessionId;
    },
    stateChip() {
      if (!this.hasTargets()) return "weights unavailable";
      return this.isSwarmManaged() ? "swarm-managed" : "seeded";
    },
    // Read from the code rather than from the feed: no session has ever
    // changed these weights, because nothing but the seed writes the table.
    // When a real writer lands, this sentence is the whole of the change.
    unchangedLine() {
      if (!this.hasTargets()) return "The published target could not be read.";
      const asOf = this.allocationAsOf();
      const since = asOf ? `Unchanged since ${longDay(asOf)}. ` : "";
      return `${since}No session has moved these weights: `
        + "applying a recommendation to the target is not built yet.";
    },

    // ── the reference series, as figures ────────────────────────────────────
    blendNow() { return SMOOTH.blend[LAST]; },
    aaveNow() { return SMOOTH.aave[LAST]; },
    blendNetNow() { return SMOOTH.blend[LAST] - WITHDRAWAL_FEE_PCT; },
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

    // ── degradation states ──────────────────────────────────────────────────
    // Carried over from the pages this one replaces, in full. A page about
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
    // The target weights are seeded rather than swarm-managed. Always true
    // today (see isSwarmManaged), and stated once, by the hero's chip, rather
    // than repeated as a provenance badge beside it.
    allocationSeeded() { return this.hasTargets() && !this.isSwarmManaged(); },
    // Per-row stale label: names the observation time, so "stale" is a date
    // rather than an adjective. The direct descendant of the old page's
    // sleeveStaleLabel(w) over wallet-sleeves, pointed at the only book this
    // page is allowed to read.
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
    // issue #614 AC5: the window between the last day of the reference series
    // and today, disclosed rather than smoothed over. Non-null renders the
    // seam banner under "What it pays". The old page's seamMessage() disclosed
    // the same kind of window on the wallet series; this is the same
    // disclosure on the only non-live series left here.
    seamMessage() {
      const end = REFERENCE.asOf;
      const endMs = Date.parse(end + "T00:00:00Z");
      if (!isFinite(endMs)) return null;
      const days = Math.floor((Date.now() - endMs) / 86_400_000);
      if (days <= 0) return null;
      return `This comparison ends ${longDay(end)}. The ${days} day${days === 1 ? "" : "s"} since `
        + "are not in it, and no collector serves these rates yet. Vault TVL, holdings and "
        + "target weights above are live.";
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
    // Sleeve rows for the bullet bars and the hero fan. The vault is the only
    // book the allocation has, so "held" is the vault's own composition; the
    // agent-token basket is bought at deposit time and lands in the
    // depositor's wallet, which is why that sleeve reads held at zero.
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
          // The served label, never a local rename: /swarm prints these same
          // four strings from the same DTO, and two product surfaces naming
          // the same sleeve differently is worse than an inelegant label.
          name: b.label || strategy[i]?.label || b.key,
          target,
          held,
          drift: held == null ? null : held - target,
          holding: held != null && held > 0,
        };
      });
    },
    sleeveState(s) {
      if (s.held == null) return "—";
      return s.holding ? "holding" : "held at zero";
    },
    sleeveFanLine(s) {
      return `${this.fmtPctTrim(s.target)} target · ${this.sleeveState(s)}`;
    },
    sleeveWeightLabel(s) {
      if (s.held == null) return "—";
      if (s.holding) return `${this.fmtPct1(s.held)} held`;
      return s.target > 0 ? `${this.fmtPct1(0)} held · ${this.fmtPctTrim(s.target)} target` : "held at zero";
    },

    // ── constituents (small multiples) ──────────────────────────────────────
    // Within-sleeve weights. Fixed income's come from the live adapter
    // balances; every other sleeve holds nothing in the vault, so its
    // constituents render as an allocation against a zero holding rather than
    // being hidden.
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

    // ── the vault: how the allocation is implemented today ──────────────────
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
    adapterHref(a) { return a?.address ? `https://basescan.org/address/${a.address}` : null; },
    idleUsdc() { return this.economics?.idleUsdc; },
    idleWeight() {
      const tvl = this.economics?.tvlUsd;
      const idle = this.idleUsdc();
      if (!tvl || idle == null) return "—";
      return this.fmtPct1((Number(idle) / tvl) * 100);
    },
    tvlUsd() { return this.economics?.tvlUsd; },
    vaultHref() { return `https://basescan.org/address/${VAULT_ADDRESS}`; },
    shortAddress() { return `${VAULT_ADDRESS.slice(0, 10)}…${VAULT_ADDRESS.slice(-8)}`; },
    // The SPOT share price, labelled as a spot read. This is not the NAV per
    // share the stat rail reports as pending: that one needs the recorded
    // series, and one sample is not a series.
    sharesLabel() {
      const shares = this.economics?.totalShares;
      const price = this.economics?.sharePrice;
      if (shares == null || price == null) return "—";
      return `${Number(shares).toLocaleString("en-US", { maximumFractionDigits: 2 })} rmUSDC at `
        + `$${Number(price).toFixed(4)} a share`;
    },
    capsLine() {
      return `$${TVL_CAP_USD.toLocaleString("en-US")} in total and `
        + `$${PER_DEPOSIT_CAP_USD.toLocaleString("en-US")} per deposit`;
    },
    // Concentration, computed from the live balances: what one venue failing
    // would cost. Not a drawdown percentage — a venue failing is the risk the
    // yield is being paid for.
    largestVenuePct() {
      const total = this.adaptersTotalUsd();
      if (!total) return null;
      const largest = Math.max(...this.fundedAdapters().map((a) => Number(a.balanceUsd)));
      return (largest / total) * 100;
    },
    venueCount() { return this.fundedAdapters().length; },

    // ── the latest recommendation, in one line ──────────────────────────────
    latestDate() { return this.latest ? longDay(this.latest.date) : "—"; },
    latestHref() {
      const s = this.latest;
      if (!s) return this.historyHref;
      return s.id
        ? `/swarm/sessions/${encodeURIComponent(s.id)}`
        : `/swarm/${s.date}/${encodeURIComponent(s.subjectId || ALLOCATION_SUBJECT_ID)}`;
    },
    latestQuorum() {
      const q = this.latest?.swarmRecommendation?.quorum;
      return q ? `${q.submitted} of ${q.active} took part` : "";
    },
    // No vector, and the page says why rather than printing a blank. The
    // subject is typed `position_actions`, so meanTakeWeights() never runs for
    // it: what a session publishes is a rationale and a set of actions.
    latestLine() {
      const rec = this.latest?.swarmRecommendation;
      if (!rec) return "";
      if (rec.rationale) return String(rec.rationale);
      const acts = (Array.isArray(rec.actions) ? rec.actions : []).filter((a) => a && a.action);
      if (acts.length) return acts.map((a) => `${a.action} ${a.token}`).join(" · ");
      return "";
    },
    // What the page can say about a missing line, without guessing which of
    // the two reasons applies.
    latestFallback() {
      if (this.sessionsFailed) return "The session feed could not be read.";
      if (!this.latest) return "No session has published a recommendation on the allocation yet.";
      return "This session published no recommendation.";
    },

    // ── the hero fan (hand-authored inline SVG; no chart dependency) ─────────
    draw() { this.drawFan(); this.drawYield(); },

    // One deposit splitting into the sleeves. Drawn as MECHANISM, not as
    // weight: a donut of today's 95/5/0/0 is one slice and an 18-degree
    // sliver, which would undercut the story on sight and break again every
    // time the mandate moves. Under 640px the labels would render at ~6px, so
    // the CSS hides this and shows the same rows as a list instead.
    drawFan() {
      const host = this.$refs.fan;
      if (!host) return;
      host.replaceChildren();
      const rows = this.sleeves();
      if (!rows.length) return;

      const X0 = 196, X1 = 404, CY = 150;
      const step = 72;
      const top = CY - ((rows.length - 1) * step) / 2;

      host.appendChild(svg("rect", {
        x: 18, y: CY - 33, width: 178, height: 66,
        fill: PALETTE.surface, stroke: PALETTE.borderLight, "stroke-width": 1,
      }));
      host.appendChild(svg("rect", { x: 18, y: CY - 33, width: 3, height: 66, fill: SERIES.emerald }));
      host.appendChild(label(svg("text", {
        x: 40, y: CY - 6, fill: PALETTE.text,
        "font-family": "'JetBrains Mono',monospace", "font-size": 15, "font-weight": 700,
      }), "1 USDC"));
      host.appendChild(label(svg("text", {
        x: 40, y: CY + 16, fill: PALETTE.textMuted,
        "font-family": "'JetBrains Mono',monospace", "font-size": 11, "letter-spacing": "0.1em",
      }), "DEPOSIT"));

      rows.forEach((s, i) => {
        const y = top + i * step;
        const dimmed = s.target === 0;
        const stroke = s.holding ? SERIES.emerald : (dimmed ? PALETTE.borderLight : PALETTE.textMuted);
        const path = svg("path", {
          d: `M${X0},${CY} C${X0 + 104},${CY} ${X1 - 104},${y} ${X1},${y}`,
          fill: "none", stroke, "stroke-width": 2,
        });
        if (dimmed) path.setAttribute("stroke-dasharray", "5 4");
        host.appendChild(path);
        host.appendChild(svg("rect", { x: X1, y: y - 5, width: 10, height: 10, fill: stroke }));
        host.appendChild(label(svg("text", {
          x: X1 + 24, y: y - 1, fill: dimmed ? PALETTE.textMuted : PALETTE.text,
          "font-family": "'Space Grotesk',sans-serif", "font-size": 16, "font-weight": 700,
        }), s.name));
        host.appendChild(label(svg("text", {
          x: X1 + 24, y: y + 18, fill: PALETTE.textMuted,
          "font-family": "'JetBrains Mono',monospace", "font-size": 11.5,
        }), this.sleeveFanLine(s)));
      });
      host.setAttribute("viewBox", `0 0 728 ${top * 2 + (rows.length - 1) * step}`);
      host.setAttribute("aria-label", "One USDC deposit allocated across "
        + rows.map((s) => `${s.name} at a ${this.fmtPctTrim(s.target)} target, ${this.sleeveState(s)}`).join("; ")
        + ".");
    },

    // What it pays: the blend drawn INSIDE the range of its own three venues,
    // with Aave as the named benchmark. Four overlapping rate lines is
    // spaghetti and two of the four are indistinguishable to normal vision;
    // the band says the honest thing instead, which is that an average is
    // always inside its inputs.
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
          + `<span class="alp__tip-soft">Morpho ${SMOOTH.morpho[i].toFixed(2)}% · Compound ${SMOOTH.compound[i].toFixed(2)}%</span>`;
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
  }));
}
