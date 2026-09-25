// @ts-nocheck — buildless browser JS that was outside the root TS program until
// static-views.js began importing subjectDot() from it, which pulled the whole
// file in and surfaced a pile of pre-existing implicit-any errors in the regime
// chart helpers. Same situation, and same call, as the pragma at the top of
// alpine/static-views.js: this preserves the status quo rather than weakening
// coverage that existed, and JSDoc-typing this file is a worthwhile follow-up
// rather than a drive-by inside an unrelated change.
//
// Shared regime-dashboard chart/data helpers, moved verbatim from the top of
// the old monolithic views.js (review-maintainability finding 025). The regime
// page, the blog's backtest charts and the swarm views import from here; any
// other chart view should too, rather than re-declaring a series colour.
import { PALETTE, SERIES, CATEGORICAL, rgba } from "../../lib/chart-theme.js";

// ── Shared regime-dashboard chart helpers ───────────────────────────────────
// Background regime bands painted behind the line datasets, one treatment per
// state: risk-on a light wash, neutral a fainter one, risk-off a diagonal
// hatch. They are drawn in the text colour, not in a hue, because every hue
// the palette has is already a series on these charts (the regime hues too:
// emerald, slate and beacon are strategy lines), and a band in a series
// colour reads as that series. Cyan is a line and beacon is a point, so
// neither may be a full-height area anyway.
export const REGIME_BAND = {
  risk_on: { fill: rgba(PALETTE.text, 0.09) },
  neutral: { fill: rgba(PALETTE.text, 0.03) },
  risk_off: { hatch: rgba(PALETTE.text, 0.16) },
};
const HATCH_GAP = 6;
export const regimeBandsPlugin = {
  id: "regimeBands",
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.enabled) return;
    const regimes = opts.regimes || [];
    const x = chart.scales.x;
    if (!regimes.length || !x) return;
    const { top, bottom, right } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    let i = 0;
    while (i < regimes.length) {
      const cur = regimes[i];
      let j = i;
      while (j + 1 < regimes.length && regimes[j + 1] === cur) j++;
      const band = cur ? REGIME_BAND[cur] : null;
      if (band) {
        const x0 = x.getPixelForValue(i);
        const x1 = j + 1 < regimes.length ? x.getPixelForValue(j + 1) : right;
        if (band.fill) {
          ctx.fillStyle = band.fill;
          ctx.fillRect(x0, top, x1 - x0, bottom - top);
        }
        if (band.hatch) {
          // Lines of x + y = k ("/"), with k on one grid for the whole chart,
          // so two neighbouring risk-off spans hatch as one surface.
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, top, x1 - x0, bottom - top);
          ctx.clip();
          ctx.strokeStyle = band.hatch;
          ctx.lineWidth = 1;
          ctx.beginPath();
          const k0 = Math.floor((x0 + top) / HATCH_GAP) * HATCH_GAP;
          for (let k = k0; k <= x1 + bottom; k += HATCH_GAP) {
            ctx.moveTo(k - top, top);
            ctx.lineTo(k - bottom, bottom);
          }
          ctx.stroke();
          ctx.restore();
        }
      }
      i = j + 1;
    }
    ctx.restore();
  },
};

// Forward-fill a sparse [{date,value}] series onto a dense date-label axis.
export function alignToDates(series, labels) {
  const map = new Map((series || []).map((p) => [p.date, p.value]));
  let last = null;
  return labels.map((d) => { if (map.has(d)) last = map.get(d); return last; });
}

// Equity-curve strategy styling (label + colour; baseline = dashed reference).
export const STRATEGY_STYLE = {
  composite: { label: "Composite", color: PALETTE.accent },
  macro: { label: "Macro", color: PALETTE.warm },
  onchain: { label: "On-chain", color: SERIES.teal },
  factor: { label: "Equity factor", color: SERIES.slate },
  macro_inverted: { label: "Macro inv.", color: SERIES.beacon },
  conservative: { label: "Conservative", color: SERIES.mint },
  aggressive: { label: "Aggressive", color: SERIES.emerald },
  // Baselines stay a muted slate family (they're reference context, not the
  // strategies under study) but each takes a DISTINCT dash so two reference
  // lines are never indistinguishable — the dash sample also shows in the legend.
  eth_hodl: { label: "ETH HODL", color: SERIES.slate, baseline: true, dash: [6, 3] },
  sp500_hodl: { label: "SP500 HODL", color: SERIES.slate, baseline: true, dash: [2, 3] },
  blend_hodl: { label: "50/50 HODL", color: SERIES.slate, baseline: true, dash: [10, 3, 2, 3] },
  stables_only: { label: "Stables", color: PALETTE.textMuted, baseline: true, dash: [1, 3] },
};
export const BASELINE_KEYS = new Set(["eth_hodl", "sp500_hodl", "blend_hodl", "stables_only"]);

// Backtest markets: title, per-regime target weights (drive the allocation pie
// glyphs), and the ordered strategy rows (key / label / description).
//
// Every strategy holds the same three mixes (a market's `weights`). What sets
// one apart is which reading decides the regime each day: the composite, one
// panel, or a rule across every panel (backend/src/analytics/analyze/
// backtest.ts: combineConservativeN, combineAggressiveN, over all the
// snapshot's panels). The names are the chart legend's (STRATEGY_STYLE); the
// descriptions say the rule in words.
const RULES = [
  ["composite", "Composite", "Follows the published regime: the composite's own reading."],
  ["macro", "Macro", "Follows the macro panel's reading alone."],
  ["onchain", "On-chain", "Follows the on-chain panel's reading alone."],
  ["factor", "Equity factor", "Follows the equity factor panel's reading alone."],
  ["conservative", "Conservative", "Combines every panel: risk-off if any panel reads risk-off, risk-on only when all read risk-on, neutral otherwise."],
  ["aggressive", "Aggressive", "Combines every panel by vote, +1 for each risk-on and −1 for each risk-off: above 0 is risk-on, below 0 risk-off, 0 neutral."],
];
const CASH = ["stables_only", "All stables", "Holds cash throughout, earning the 3-month T-bill (DTB3) yield."];
export const BACKTESTS = [
  {
    key: "eth",
    title: "Backtest · ETH / cash",
    weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, eth: 0.5 }, risk_on: { eth: 1 } },
    strategies: [...RULES, ["eth_hodl", "Buy-and-hold ETH", "Holds 100% ETH throughout."], CASH],
  },
  {
    key: "sp500",
    title: "Backtest · SP500 / cash",
    weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, sp500: 0.5 }, risk_on: { sp500: 1 } },
    strategies: [...RULES, ["sp500_hodl", "Buy-and-hold S&P 500", "Holds 100% S&P 500 throughout."], CASH],
  },
  {
    key: "mixed",
    title: "Backtest · ETH + SP500 + cash",
    weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, eth: 0.25, sp500: 0.25 }, risk_on: { eth: 0.5, sp500: 0.5 } },
    strategies: [...RULES, ["blend_hodl", "Buy-and-hold 50/50", "Holds 50% ETH and 50% S&P 500 throughout: the risk-on mix, always."], CASH],
  },
];
// Strategy weight-pie slices (cash / ETH / SP500) — three categories, three
// distinct hues (cash was previously the same slate as eth: an invisible split).
export const ASSET_COLOR = { cash: SERIES.slate, eth: SERIES.sand, sp500: SERIES.teal };
export const ASSET_LABEL = { cash: "cash", eth: "ETH", sp500: "SP500" };

// Wallet-holdings dot colour by symbol — shared by the /allocation pies+tables
// and the wallet-performance charts so a given asset is ONE colour everywhere
// (pie slice == table dot == perf line). Every symbol takes a DISTINCT brand
// hue: a holdings pie is categorical (each slice is a different asset the reader
// must tell apart), so we never collapse a whole asset class onto one green —
// that reads as an indistinguishable blob. Native tokens share the cyan family
// (bright vs deep) so they stay visually related while remaining distinct.
/** @type {Record<string, string>} — indexed by arbitrary symbol, not just the keys below. */
export const ASSET_DOT = {
  USDC: "#10b981",        // green  — primary stable
  "ZYFAI-SS1": "#5fb3a1", // teal   — strategy position
  "GIZA-SS1": "#9cffd2",  // mint   — strategy position
  ROBOTMONEY: "#00e5ff",  // cyan   — native
  BNKR: "#0891b2",        // deep cyan — native (related to ROBOTMONEY, distinct)
  WETH: "#e8a640",        // sand
  ETH: "#ff7a29",         // beacon — distinct from WETH
  SP500: "#7e889e",       // slate  — reference index
};
// Unmapped symbol: hash to a stable CATEGORICAL hue so a new asset still gets a
// distinct colour rather than every unknown collapsing onto one grey.
/** @param {string} sym */
export const assetDot = (sym) => {
  if (ASSET_DOT[sym]) return ASSET_DOT[sym];
  let h = 0;
  for (const ch of String(sym)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CATEGORICAL[h % CATEGORICAL.length];
};

// Stable colour for a swarm session subject. Same construction as assetDot
// because it answers the same question — subjects are a CATEGORICAL encoding
// (Mav Holdings is not "more" than Woon Treasury), so they take distinct hues
// rather than a ramp, hashed on id so a subject keeps one colour on every page
// instead of shifting with its position in whatever list is being drawn.
//
// Beacon is withheld: it means loss/drawdown/attention in the covenant, so
// letting the hash land an ordinary subject on it would say something untrue
// about that subject permanently.
//
// Beam is withheld for the same reason one step further. Cyan is the house
// colour and the covenant's rule is that it is a LINE and never a figure, so a
// subject wearing it reads as interface rather than as one of the things under
// review. It was not hypothetical: `woon` hashed to PALETTE.accent, which put
// the only externally-operated subject on the page in Robot Money's own colour,
// on its session rail and its filter chip. member-mark.js already withholds
// both hues from the derived marks for exactly this pair of reasons; this is
// the same withholding, one file over.
//
// Withholding a second hue leaves five, and the three subjects under review
// (robotmoney-vault, robotmoney-treasury, woon) still hash to three distinct
// ones. Existing subjects do change colour once, which is the cost of the fix.
/** @param {string} subjectId */
// One colour per token WITHIN ONE FIGURE. assetDot() hashes any symbol it does
// not name into CATEGORICAL, so two unnamed tokens in one book can land on the
// same hue, or on a hue a named token owns (WOON hashes to cyan, which
// ROBOTMONEY owns), and two rows keyed alike in one table read as one thing.
// Named tokens claim their colour first; hashed ones take theirs if it is free
// and the next free hue otherwise. Slate is withheld from that pool: the
// covenant spends it on muted references, and a real holding drawn slate reads
// as the leftovers bucket. `reserved` are hues already spoken for in the figure.
// Shared by the subject page's chart and holdings and the session page's
// holdings, so the same book is keyed the same way on both.
/** @param {string[]} tokens @param {string[]} [reserved] @returns {Record<string, string>} */
export const resolveTokenColors = (tokens, reserved = []) => {
  /** @type {Record<string, string>} */
  const out = {};
  const used = new Set(reserved);
  for (const token of tokens) {
    const owned = /** @type {Record<string, string>} */ (ASSET_DOT)[token];
    if (owned && !used.has(owned)) {
      out[token] = owned;
      used.add(owned);
    }
  }
  const pool = CATEGORICAL.filter((hue) => hue !== SERIES.slate);
  for (const token of tokens) {
    if (out[token]) continue;
    const hashed = assetDot(token);
    const free = hashed !== SERIES.slate && !used.has(hashed);
    const color = free
      ? hashed
      : (pool.find((hue) => !used.has(hue)) || CATEGORICAL.find((hue) => !used.has(hue)) || hashed);
    out[token] = color;
    used.add(color);
  }
  return out;
};

export const subjectDot = (subjectId) => {
  const hues = CATEGORICAL.filter((c) => c !== SERIES.beacon && c !== PALETTE.accent);
  let h = 0;
  for (const ch of String(subjectId || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[h % hues.length];
};

// Correlation ("Predictive power & alignment") table columns + row order.
export const FWD_COLS = [
  ["spx_30d", "SPX 30d"], ["spx_90d", "SPX 90d"], ["spx_180d", "SPX 180d"],
  ["eth_30d", "ETH 30d"], ["eth_90d", "ETH 90d"], ["eth_180d", "ETH 180d"],
];
export const CON_COLS = [["spx", "SPX now"], ["eth", "ETH now"]];
export const CORR_ROWS = [
  ["composite", "Composite"], ["macro", "Macro"], ["onchain", "On-chain"], ["factor", "Equity factor"],
];
export const SOURCE_LABEL = {
  fred: "FRED", yahoo: "Yahoo", defillama_tvl: "DefiLlama", defillama_stables: "DefiLlama",
  blockchain_com: "Blockchain.com", coinmetrics: "Coinmetrics", geckoterminal_newpools: "GeckoTerminal",
};

// The inline regime-band legend swatches, shown next to "Full history" and each
// equity-curve chart: one per state, in REGIME_BAND's treatments, a little
// stronger so a 10px square still reads. `bg` is a CSS background value; the
// hatch is an SVG image rather than a repeating gradient, which the covenant
// scan would flag.
const HATCH_SWATCH = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><path d='M3-1L-9 11M7-1L-5 11M11-1L-1 11M15-1L3 11M19-1L7 11' stroke='rgba(242,244,249,0.6)' stroke-width='1'/></svg>",
)}")`;
// The same three treatments as CSS backgrounds, for the bands behind the
// site's own charts (lib/line-chart.js), where each run is a strip of HTML
// under the lines. The hatch is a 6px tile, so it keeps its angle and pitch
// however the plot stretches.
const HATCH_TILE = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='6' height='6'><path d='M-1 1l2-2M0 6L6 0M5 7l2-2' stroke='rgba(242,244,249,0.16)' stroke-width='1'/></svg>",
)}")`;
export const REGIME_BAND_BG = {
  risk_on: rgba(PALETTE.text, 0.09),
  neutral: rgba(PALETTE.text, 0.03),
  risk_off: HATCH_TILE,
};

export const REGIME_BG_LEGEND = [
  { label: "risk-off", bg: HATCH_SWATCH },
  { label: "neutral", bg: rgba(PALETTE.text, 0.1) },
  { label: "risk-on", bg: rgba(PALETTE.text, 0.34) },
];
