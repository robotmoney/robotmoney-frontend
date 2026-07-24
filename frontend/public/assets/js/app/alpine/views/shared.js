// Shared regime-dashboard chart/data helpers, moved verbatim from the top of
// the old monolithic views.js (review-maintainability finding 025). Today
// every export is consumed only by views/regime.js, but they are the shared
// layer any other chart view should import from rather than re-declaring.
import { PALETTE, SERIES, rgba } from "../../lib/chart-theme.js";

// ── Shared regime-dashboard chart helpers ───────────────────────────────────
// Background regime bands painted behind the line datasets, matching the
// original RegimeDashboard: risk-off amber @10%, risk-on cyan @8%, neutral bare.
export const REGIME_BAND = { risk_off: rgba(PALETTE.warm, 0.1), risk_on: rgba(PALETTE.accent, 0.08), neutral: null };
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
      const fill = cur ? REGIME_BAND[cur] : null;
      if (fill) {
        const x0 = x.getPixelForValue(i);
        const x1 = j + 1 < regimes.length ? x.getPixelForValue(j + 1) : right;
        ctx.fillStyle = fill;
        ctx.fillRect(x0, top, x1 - x0, bottom - top);
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
  eth_hodl: { label: "ETH HODL", color: SERIES.slate, baseline: true },
  sp500_hodl: { label: "SP500 HODL", color: SERIES.slate, baseline: true },
  blend_hodl: { label: "50/50 HODL", color: SERIES.slate, baseline: true },
  stables_only: { label: "Stables", color: PALETTE.textMuted, baseline: true },
};
export const BASELINE_KEYS = new Set(["eth_hodl", "sp500_hodl", "blend_hodl", "stables_only"]);

// Backtest markets: title, per-regime target weights (drive the allocation pie
// glyphs), and the ordered strategy rows (key / label / description).
export const BACKTESTS = [
  {
    key: "eth",
    title: "Backtest · ETH / cash",
    weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, eth: 0.5 }, risk_on: { eth: 1 } },
    strategies: [
      ["composite", "Composite bucket", "Default rule on the published composite."],
      ["macro", "Macro bucket", "Macro panel only."],
      ["onchain", "On-chain bucket", "On-chain panel only."],
      ["factor", "Equity factor bucket", "Equity factor panel only (only present in /regime_eq)."],
      ["conservative", "Conservative (N-panel)", "Any panel off → off; all panels on → on; else neutral."],
      ["aggressive", "Aggressive (N-panel)", "Net sum > 0 → on, < 0 → off, = 0 → neutral."],
      ["eth_hodl", "Buy-and-hold ETH", "Reference: 100% ETH."],
      ["stables_only", "All-stables", "Reference: 100% DTB3 yield."],
    ],
  },
  {
    key: "sp500",
    title: "Backtest · SP500 / cash",
    weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, sp500: 0.5 }, risk_on: { sp500: 1 } },
    strategies: [
      ["composite", "Composite bucket", "Default rule on the published composite."],
      ["macro", "Macro bucket", "Macro panel only."],
      ["onchain", "On-chain bucket", "On-chain panel only."],
      ["factor", "Equity factor bucket", "Equity factor panel only (only present in /regime_eq)."],
      ["conservative", "Conservative (N-panel)", "Any panel off → off; all panels on → on; else neutral."],
      ["aggressive", "Aggressive (N-panel)", "Net sum > 0 → on, < 0 → off, = 0 → neutral."],
      ["sp500_hodl", "Buy-and-hold SP500", "Reference: 100% SP500."],
      ["stables_only", "All-stables", "Reference: 100% DTB3 yield."],
    ],
  },
  {
    key: "mixed",
    title: "Backtest · ETH + SP500 + cash",
    weights: { risk_off: { cash: 1 }, neutral: { cash: 0.5, eth: 0.25, sp500: 0.25 }, risk_on: { eth: 0.5, sp500: 0.5 } },
    strategies: [
      ["composite", "Composite bucket", "Default rule on the published composite."],
      ["macro", "Macro bucket", "Macro panel only."],
      ["onchain", "On-chain bucket", "On-chain panel only."],
      ["factor", "Equity factor bucket", "Equity factor panel only (only present in /regime_eq)."],
      ["conservative", "Conservative (N-panel)", "Any panel off → off; all panels on → on; else neutral."],
      ["aggressive", "Aggressive (N-panel)", "Net sum > 0 → on, < 0 → off, = 0 → neutral."],
      ["blend_hodl", "50/50 ETH + SP500 HODL", "Reference: always max-risk."],
      ["stables_only", "All-stables", "Reference: 100% DTB3 yield."],
    ],
  },
];
export const ASSET_COLOR = { cash: PALETTE.textMuted, eth: SERIES.slate, sp500: SERIES.teal };
export const ASSET_LABEL = { cash: "cash", eth: "ETH", sp500: "SP500" };

// Wallet-holdings dot colour by symbol — shared by the /allocation pies+tables
// and the wallet-performance charts so the same asset never renders two colours.
// Beam/Pool/Beacon: stables = the green mass; volatile/reference assets take a
// distinct brand hue (cyan / sand / slate), never the DTO's own `color`.
export const ASSET_DOT = {
  USDC: "#10b981", "ZYFAI-SS1": "#10b981", "GIZA-SS1": "#10b981",
  ROBOTMONEY: "#00e5ff", BNKR: "#00e5ff",
  WETH: "#e8a640", ETH: "#e8a640", SP500: "#7e889e",
};
export const assetDot = (sym) => ASSET_DOT[sym] || "#7e889e";

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

// The inline regime-band legend swatches (REGIME_BG_LEGEND from
// regimeBandsPlugin.ts): shown next to "Full history" and each equity-curve chart.
export const REGIME_BG_LEGEND = [
  { label: "risk-off", color: rgba(PALETTE.warm, 0.5) },
  { label: "neutral", color: rgba(PALETTE.textMuted, 0.15) },
  { label: "risk-on", color: rgba(PALETTE.accent, 0.4) },
];
