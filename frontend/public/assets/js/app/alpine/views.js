// Alpine.data factories for the data-driven views (regime + committee). They
// fetch the API through app/lib/api.js (HTTP-only boundary) and expose plain
// state the HTML renders with x-for/x-text. No build, no Web Components.
import { api, ROUTES, path } from "../lib/api.js";
import { PALETTE, SERIES, MONO_FONT, GRID_COLOR, rgba, monoAxis } from "../lib/chart-theme.js";

// ── Shared regime-dashboard chart helpers ───────────────────────────────────
// Background regime bands painted behind the line datasets, matching the
// original RegimeDashboard: risk-off amber @10%, risk-on cyan @8%, neutral bare.
const REGIME_BAND = { risk_off: rgba(PALETTE.warm, 0.1), risk_on: rgba(PALETTE.accent, 0.08), neutral: null };
const regimeBandsPlugin = {
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
function alignToDates(series, labels) {
  const map = new Map((series || []).map((p) => [p.date, p.value]));
  let last = null;
  return labels.map((d) => { if (map.has(d)) last = map.get(d); return last; });
}

// Equity-curve strategy styling (label + colour; baseline = dashed reference).
const STRATEGY_STYLE = {
  composite: { label: "Composite", color: PALETTE.accent },
  macro: { label: "Macro", color: PALETTE.warm },
  onchain: { label: "On-chain", color: SERIES.teal },
  factor: { label: "Equity factor", color: SERIES.violet },
  macro_inverted: { label: "Macro inv.", color: SERIES.red },
  conservative: { label: "Conservative", color: SERIES.mint },
  aggressive: { label: "Aggressive", color: SERIES.amberLight },
  eth_hodl: { label: "ETH HODL", color: SERIES.violet, baseline: true },
  sp500_hodl: { label: "SP500 HODL", color: SERIES.violet, baseline: true },
  blend_hodl: { label: "50/50 HODL", color: SERIES.violet, baseline: true },
  stables_only: { label: "Stables", color: PALETTE.textMuted, baseline: true },
};
const BASELINE_KEYS = new Set(["eth_hodl", "sp500_hodl", "blend_hodl", "stables_only"]);

// Backtest markets: title, per-regime target weights (drive the allocation pie
// glyphs), and the ordered strategy rows (key / label / description).
const BACKTESTS = [
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
const ASSET_COLOR = { cash: PALETTE.textMuted, eth: SERIES.violet, sp500: SERIES.teal };
const ASSET_LABEL = { cash: "cash", eth: "ETH", sp500: "SP500" };

// Correlation ("Predictive power & alignment") table columns + row order.
const FWD_COLS = [
  ["spx_30d", "SPX 30d"], ["spx_90d", "SPX 90d"], ["spx_180d", "SPX 180d"],
  ["eth_30d", "ETH 30d"], ["eth_90d", "ETH 90d"], ["eth_180d", "ETH 180d"],
];
const CON_COLS = [["spx", "SPX now"], ["eth", "ETH now"]];
const CORR_ROWS = [
  ["composite", "Composite"], ["macro", "Macro"], ["onchain", "On-chain"], ["factor", "Equity factor"],
];
const SOURCE_LABEL = {
  fred: "FRED", yahoo: "Yahoo", defillama_tvl: "DefiLlama", defillama_stables: "DefiLlama",
  blockchain_com: "Blockchain.com", coinmetrics: "Coinmetrics", geckoterminal_newpools: "GeckoTerminal",
};

// The inline regime-band legend swatches (REGIME_BG_LEGEND from
// regimeBandsPlugin.ts): shown next to "Full history" and each equity-curve chart.
const REGIME_BG_LEGEND = [
  { label: "risk-off", color: rgba(PALETTE.warm, 0.5) },
  { label: "neutral", color: rgba(PALETTE.textMuted, 0.15) },
  { label: "risk-on", color: rgba(PALETTE.accent, 0.4) },
];

export function registerViews(Alpine) {
  // ── Projects directory ("Agentic Economy Ecosystem") ─────────────────────
  // Ported from robotmoney-bot-analytics src/pages/Projects.tsx. The backend now
  // does the facet aggregation (revenue, sparkline, max mcap/fdv); this factory
  // handles interactive sorting + formatting over the /api/projects DTO.
  Alpine.data("projectsView", () => ({
    loading: true,
    error: null,
    rows: [],
    sortKey: "fdv",
    sortDir: "desc",
    // Sticky projects pin to the top on first load only; the first header click
    // releases the pin for the session (matches the source page).
    stickyActive: true,

    async load() {
      try {
        const data = await api.get(ROUTES.projects.list);
        this.rows = (data.projects || []).map((p) => this._enrich(p));
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },

    // Per-row derived metrics used only for sorting/display (the API supplies the
    // heavy aggregates). maxPct = the largest-magnitude 24h move across coins.
    _enrich(p) {
      const maxPct = p.coins.length
        ? p.coins.reduce((best, c) => {
            const v = c.percentChange24h;
            if (v == null) return best;
            if (best == null) return v;
            return Math.abs(v) > Math.abs(best) ? v : best;
          }, null)
        : null;
      const facetCount = ["agent", "coin", "wallet", "vault"].reduce((s, k) => s + (p.facets[k] ? 1 : 0), 0);
      return { p, maxPct, facetCount };
    },

    get sortedRows() {
      const arr = [...this.rows];
      const dir = this.sortDir === "asc" ? 1 : -1;
      arr.sort((a, b) => {
        if (this.stickyActive) {
          const aS = a.p.isSticky ? 1 : 0;
          const bS = b.p.isSticky ? 1 : 0;
          if (aS !== bS) return bS - aS;
        }
        let av = 0;
        let bv = 0;
        switch (this.sortKey) {
          case "name":    av = a.p.displayName.toLowerCase(); bv = b.p.displayName.toLowerCase(); break;
          case "mcap":    av = a.p.maxMarketCap; bv = b.p.maxMarketCap; break;
          case "fdv":     av = a.p.maxFdv; bv = b.p.maxFdv; break;
          case "pct24h":  av = a.maxPct ?? -Infinity; bv = b.maxPct ?? -Infinity; break;
          case "revenue": av = a.p.revenue30d; bv = b.p.revenue30d; break;
          case "wallet":  av = a.p.walletTotalUsd; bv = b.p.walletTotalUsd; break;
          case "score":   av = a.p.dataCoverageScore ?? 0; bv = b.p.dataCoverageScore ?? 0; break;
          case "facets":  av = a.facetCount; bv = b.facetCount; break;
        }
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
      return arr;
    },

    sortBy(key) {
      if (this.stickyActive) this.stickyActive = false;
      if (key === this.sortKey) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortKey = key;
        this.sortDir = key === "name" ? "asc" : "desc";
      }
    },
    isSort(key) { return this.sortKey === key; },
    sortIcon(key) { return this.sortKey === key ? (this.sortDir === "asc" ? "▲" : "▼") : "↕"; },

    // ── formatting ────────────────────────────────────────────────────────
    fmtUsd(n) {
      if (n == null || !isFinite(n) || n === 0) return "—";
      if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
      return "$" + n.toFixed(0);
    },
    mcFdvPct(p) {
      return p.maxFdv > 0 && p.maxMarketCap > 0 ? ((p.maxMarketCap / p.maxFdv) * 100).toFixed(1) + "%" : "—";
    },
    pctText(v) { return v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%"; },
    pctColor(v) {
      if (v == null) return "var(--color-text-dim)";
      return v > 0 ? "var(--color-accent)" : v < 0 ? "var(--color-warn)" : "var(--color-text-muted)";
    },
    facetPills(p) {
      return [
        { label: "AGT", on: p.facets.agent, hint: "Has agent" },
        { label: "X402", on: p.facets.x402, hint: "x402-enabled agent" },
        { label: "COIN", on: p.facets.coin, hint: "Has token" },
        { label: "WLT", on: p.facets.wallet, hint: p.wallets.length + " wallet(s)" },
        { label: "VLT", on: p.facets.vault, hint: "Has vault" },
      ];
    },
    twitterUrl(h) { return "https://x.com/" + String(h).replace(/^@/, ""); },
    twitterLabel(h) { return "@" + String(h).replace(/^@/, ""); },
    cleanUrl(u) { return String(u).replace(/^https?:\/\//, "").replace(/\/$/, ""); },
    initials(name) { return String(name || "").slice(0, 2).toUpperCase() || "?"; },

    // Inline-SVG price sparkline (normalized to the window min/max); cyan when the
    // window closes up, amber when down.
    sparkSvg(values) {
      const vals = (values || []).filter((v) => typeof v === "number" && isFinite(v));
      if (vals.length < 2) return '<span class="pj-spark-empty">—</span>';
      const W = 90, H = 24, pad = 2, n = vals.length;
      const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
      const xAt = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
      const yAt = (v) => pad + (1 - (v - min) / span) * (H - 2 * pad);
      const up = vals[n - 1] >= vals[0];
      const stroke = up ? "var(--color-accent)" : "var(--color-warn)";
      const pts = vals.map((v, i) => xAt(i).toFixed(1) + "," + yAt(v).toFixed(1)).join(" ");
      const lx = xAt(n - 1).toFixed(1), ly = yAt(vals[n - 1]).toFixed(1);
      return '<svg class="pj-spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
        + '<polyline points="' + pts + '" fill="none" stroke="' + stroke + '" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>'
        + '<circle cx="' + lx + '" cy="' + ly + '" r="1.5" fill="' + stroke + '"/></svg>';
    },
  }));

  // ── Regime classification ────────────────────────────────────────────────
  Alpine.data("regimeView", () => ({
    _charts: {},
    loading: true,
    error: null,
    latest: null,
    history: [],
    // History-chart overlay toggles. composite/macro/on-chain/factor are ALWAYS
    // drawn (no per-series toggle, matching the source HistoryChart); only the
    // regime bands + the S&P 500 / ETH price overlays toggle.
    visible: { spx: false, eth: false, bands: true },

    async load() {
      try {
        // The dashboard blobs (backtest/correlations/extras) ride on the asof
        // `latest` row; history is the full daily series for the charts.
        const data = await api.get(ROUTES.dashboards.regimeSnapshots, { range: 4000 });
        this.latest = data.latest;
        this.history = data.history || [];
        this.loading = false;
        this.$nextTick(() => { this.drawHistory(); this.drawBacktests(); });
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },

    // ── panels ──────────────────────────────────────────────────────────────
    panelsList() {
      const p = this.latest?.panels;
      if (Array.isArray(p) && p.length) return p;
      // Fallback when `panels` is null: always show macro + on-chain, and append the
      // display-only Equity factor panel when its index is present in the data.
      const base = ["macro", "onchain"];
      return this.latest?.factorIndex != null ? [...base, "factor"] : base;
    },
    panelLabel(p) { return p === "macro" ? "Macro" : p === "onchain" ? "On-chain" : p === "factor" ? "Equity factor" : p; },
    panelIndex(p) { return this.latest?.[p + "Index"]; },
    // Rich per-indicator objects come only on the latest (asof) row; historical
    // rows carry the numeric columns + `percentiles` map. Group by panel.
    indicatorsIn(panel) {
      const inds = this.latest?.indicators;
      return Array.isArray(inds) ? inds.filter((i) => i.panel === panel) : [];
    },

    // ── formatting ──────────────────────────────────────────────────────────
    posPct(x) { return x == null ? 0 : Math.max(0, Math.min(1, x)) * 100; },
    // Percentile as an integer (no % sign), e.g. "62" → rendered "62th pct".
    fmtPctInt(x) { return x == null || !isFinite(x) ? "—" : (x * 100).toFixed(0); },
    fmtWeight(w) { return w == null ? "—" : (w * 100).toFixed(1) + "%"; },
    regimeLabel(r) { return r == null ? "—" : ({ risk_off: "Risk-off", neutral: "Neutral", risk_on: "Risk-on" }[r] || String(r).replace(/_/g, "-")); },
    regimeColor(r) { return r === "risk_off" ? PALETTE.warn : r === "risk_on" ? PALETTE.accent : PALETTE.textMuted; },
    regimeCardStyle(r) { const c = this.regimeColor(r); return `border-color:${c};background:${rgba(c, 0.1)}`; },
    fmtSign(s) { return s == null ? "—" : (s >= 0 ? "+" : "") + s; },
    sourceLabel(s) { return SOURCE_LABEL[s] || s || "—"; },
    // Per-indicator +1/−1 sign explanation (the panel-table hover tooltip).
    signTooltip(sign, name) {
      if (sign == null || sign >= 0) {
        return `Sign +1 — rising ${name} reads as risk-on, so the percentile is used as-is. "Signed" column has the same orientation as "high = risk-on" across every indicator.`;
      }
      return `Sign −1 — rising ${name} reads as risk-off, so we flip the percentile (1 − pctile) before averaging. That keeps "Signed" oriented "high = risk-on" across every indicator.`;
    },
    // Component methodology footer: bucket thresholds as integer percentiles.
    bucketPct(key) { const t = this.latest?.bucketThresholds; return t && t[key] != null ? (t[key] * 100).toFixed(0) : "—"; },

    // Last visible value (transformed for change series), formatted by unit.
    fmtLast(ind) {
      const t = ind.transform;
      const v = (t === "change30" || t === "change90") ? ind.transformed_value : ind.raw_value;
      if (v == null) return "—";
      const u = ind.unit;
      if (u === "percent") return v.toFixed(2) + "%";
      if (u === "percent_change") return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
      if (u === "index") return v.toFixed(2);
      if (u === "count") return Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.round(v).toLocaleString();
      if (u === "ratio2") return v.toFixed(2);
      if (u === "ratio4") return v.toFixed(4);
      if (u === "usd") {
        const a = Math.abs(v);
        if (a >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
        if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
        if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
        return "$" + Math.round(v).toLocaleString();
      }
      return v.toFixed(2);
    },
    fmtSigned(v) { return v == null ? "—" : Math.round(v * 100).toString(); },
    signedColor(v) { return v == null ? PALETTE.textDim : v >= 0.5 ? PALETTE.accent : PALETTE.warn; },

    // Inline-SVG sparkline (percentiles in [0,1]); stroke cyan when the last
    // point is risk-on (>=0.5), amber otherwise. Mid-line reference at 0.5.
    sparklineSvg(values) {
      const vals = Array.isArray(values) ? values : [];
      const finite = vals.filter((v) => typeof v === "number" && isFinite(v));
      if (finite.length < 2) return '<span class="rv__spark-empty">—</span>';
      const W = 80, H = 22, pad = 1, n = vals.length;
      const xAt = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
      const yAt = (v) => pad + (1 - v) * (H - 2 * pad);
      let last = null;
      for (let k = vals.length - 1; k >= 0; k--) { if (typeof vals[k] === "number" && isFinite(vals[k])) { last = vals[k]; break; } }
      const stroke = last >= 0.5 ? PALETTE.accent : PALETTE.warn;
      const pts = []; let lastX = pad, lastY = yAt(0.5);
      vals.forEach((v, i) => { if (typeof v === "number" && isFinite(v)) { const px = xAt(i), py = yAt(v); pts.push(px.toFixed(1) + "," + py.toFixed(1)); lastX = px; lastY = py; } });
      const mid = yAt(0.5).toFixed(1);
      return '<svg class="rv__spark-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
        + '<line x1="' + pad + '" y1="' + mid + '" x2="' + (W - pad) + '" y2="' + mid + '" stroke="' + PALETTE.border + '" stroke-width="0.5" stroke-dasharray="2 2"/>'
        + '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + stroke + '" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>'
        + '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="1.5" fill="' + stroke + '"/>'
        + '</svg>';
    },

    // ── correlations ("Predictive power & alignment") ───────────────────────
    fwdCols() { return FWD_COLS; },
    conCols() { return CON_COLS; },
    hasForward() { return !!this.latest?.correlations?.forward; },
    hasConcurrent() { return !!this.latest?.correlations?.concurrent; },
    corrRows() {
      const c = this.latest?.correlations;
      if (!c) return [];
      return CORR_ROWS.filter(([k]) => (c.forward && c.forward[k]) || (c.concurrent && c.concurrent[k]));
    },
    fwdCell(idx, col) { return this.latest?.correlations?.forward?.[idx]?.[col]; },
    conCell(idx, col) { return this.latest?.correlations?.concurrent?.[idx]?.[col]; },
    rhoText(cell) { if (!cell || cell.rho == null) return "—"; return (cell.rho >= 0 ? "+" : "") + cell.rho.toFixed(2); },
    rhoColor(cell) { if (!cell || cell.rho == null) return PALETTE.textDim; const r = cell.rho; if (Math.abs(r) < 0.15) return PALETTE.textMuted; return r > 0 ? PALETTE.accent : PALETTE.warn; },
    rhoTitle(cell) { return cell && cell.n != null ? "n = " + cell.n + " paired observations" : ""; },
    corrSampleMeta() {
      const c = this.latest?.correlations;
      const n = c?.forward?.composite?.spx_30d?.n ?? c?.concurrent?.composite?.spx?.n ?? 0;
      const trailing = n >= 252 ? "~" + (n / 252).toFixed(1) + "y" : "~" + Math.max(1, Math.round(n / 21)) + "mo";
      return "Spearman ρ · trailing " + trailing;
    },

    // ── backtests ───────────────────────────────────────────────────────────
    backtests() { return BACKTESTS; },
    hasBacktest(key) { const s = this.latest?.backtest?.[key]; return !!s && Object.keys(s).length > 0; },
    backtestRows(bt) {
      const data = this.latest?.backtest?.[bt.key] || {};
      return bt.strategies.filter(([k]) => data[k]).map(([k, label, desc]) => ({ key: k, label, desc, s: data[k], baseline: BASELINE_KEYS.has(k) }));
    },
    fmtNum2(v) { return v == null ? "—" : (+v).toFixed(2); },
    fmtPctSigned(v) { return v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%"; },
    fmtPctUnsigned(v) { return v == null ? "—" : (v * 100).toFixed(1) + "%"; },
    ddColor(v) { return v == null ? PALETTE.textDim : v < -0.5 ? PALETTE.warn : PALETTE.textMuted; },
    tradesText(row) { return row.baseline ? "—" : (row.s.transitions ?? "—"); },
    describeWeights(w) { return Object.keys(ASSET_COLOR).filter((a) => w[a]).map((a) => Math.round(w[a] * 100) + "% " + ASSET_LABEL[a]).join(" / "); },
    // Allocation pie glyph (inline SVG) for a per-regime weight map.
    statePie(w) {
      const size = 28, r = size / 2 - 1, cx = size / 2, cy = size / 2;
      const order = Object.keys(ASSET_COLOR).filter((a) => (w[a] || 0) > 0);
      const total = order.reduce((s, a) => s + w[a], 0) || 1;
      if (order.length === 1) return '<svg class="rv__pie" width="' + size + '" height="' + size + '" aria-hidden="true"><circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + ASSET_COLOR[order[0]] + '"/></svg>';
      let a0 = -Math.PI / 2, paths = "";
      for (const a of order) {
        const frac = w[a] / total, a1 = a0 + frac * Math.PI * 2, large = frac > 0.5 ? 1 : 0;
        const x0 = (cx + r * Math.cos(a0)).toFixed(2), y0 = (cy + r * Math.sin(a0)).toFixed(2);
        const x1 = (cx + r * Math.cos(a1)).toFixed(2), y1 = (cy + r * Math.sin(a1)).toFixed(2);
        paths += '<path d="M ' + cx + ' ' + cy + ' L ' + x0 + ' ' + y0 + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + ' Z" fill="' + ASSET_COLOR[a] + '"/>';
        a0 = a1;
      }
      return '<svg class="rv__pie" width="' + size + '" height="' + size + '" aria-hidden="true">' + paths + '</svg>';
    },

    // ── history-chart overlay toggles + legend ────────────────────────────────
    bgLegend() { return REGIME_BG_LEGEND; },
    hasSpx() { return (this.latest?.extras?.spx || []).length > 0; },
    hasEth() { return (this.latest?.extras?.eth || []).length > 0; },
    isVisible(key) { return !!this.visible[key]; },
    toggle(key) { this.visible[key] = !this.visible[key]; this.drawHistory(); },
    // Overlay-chip inline style: active → series colour border/text + `${color}1a` bg.
    chipStyle(active, color) {
      return active
        ? `border-color:${color};color:${color};background:${color}1a`
        : "border-color:var(--color-border);color:var(--color-text-muted);background:transparent";
    },
    _setChart(key, chart) { this._charts[key]?.destroy(); this._charts[key] = chart; },
    // Panel index on a history row: prefer the DTO camelCase, fall back to the
    // raw snapshot key so the chart works against either shape.
    _idx(h, panel) { const v = h[panel + "Index"]; return v != null ? v : h[panel]; },

    drawHistory() {
      const canvas = this.$refs.chart;
      if (!canvas || !window.Chart || !this.history.length) return;
      const labels = this.history.map((h) => h.date);
      const line = (label, data, color, o = {}) => ({ label, data, borderColor: color, backgroundColor: o.bg || "transparent", fill: !!o.fill, tension: 0.2, pointRadius: 0, borderWidth: o.bw || 1.25, yAxisID: o.axis || "y" });
      const ds = [
        line("Composite", this.history.map((h) => h.composite), PALETTE.accent, { fill: true, bg: rgba(PALETTE.accent, 0.1), bw: 2 }),
        line("Macro", this.history.map((h) => this._idx(h, "macro")), PALETTE.textMuted),
        line("On-chain", this.history.map((h) => this._idx(h, "onchain")), PALETTE.warm),
      ];
      const hasFactor = this.history.some((h) => this._idx(h, "factor") != null);
      if (hasFactor) ds.push(line("Equity factor", this.history.map((h) => this._idx(h, "factor")), SERIES.violet));
      const extras = this.latest?.extras || {};
      const showSpx = this.visible.spx && (extras.spx || []).length > 0;
      const showEth = this.visible.eth && (extras.eth || []).length > 0;
      if (showSpx) ds.push(line("S&P 500", alignToDates(extras.spx, labels), SERIES.teal, { axis: "yPrice" }));
      if (showEth) ds.push(line("ETH", alignToDates(extras.eth, labels), SERIES.violet, { axis: "yPrice" }));
      const chart = new window.Chart(canvas, {
        type: "line",
        data: { labels, datasets: ds },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            regimeBands: { enabled: this.visible.bands, regimes: this.history.map((h) => h.regime ?? null) },
            legend: { position: "bottom", labels: { color: PALETTE.textMuted, font: MONO_FONT } },
            tooltip: { backgroundColor: rgba(PALETTE.deep, 0.95), borderColor: PALETTE.border, borderWidth: 1, titleColor: PALETTE.text, bodyColor: PALETTE.text },
          },
          scales: {
            x: monoAxis({ ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }),
            y: { min: 0, max: 1, ...monoAxis({ ticks: { stepSize: 0.25 } }) },
            yPrice: { type: "logarithmic", display: !!(showSpx || showEth), position: "right", ticks: { color: PALETTE.textDim, font: MONO_FONT }, grid: { drawOnChartArea: false } },
          },
        },
        plugins: [regimeBandsPlugin],
      });
      this._setChart("history", chart);
    },

    drawBacktests() {
      if (!this.latest?.backtest || !window.Chart || !this.$root) return;
      const labels = this.history.map((h) => h.date);
      const regimes = this.history.map((h) => h.regime ?? null);
      for (const canvas of this.$root.querySelectorAll("canvas[data-bt]")) {
        const key = canvas.getAttribute("data-bt");
        const strategies = this.latest.backtest[key];
        if (!strategies) continue;
        const bt = BACKTESTS.find((b) => b.key === key);
        const order = bt ? bt.strategies.map(([k]) => k) : Object.keys(strategies);
        const ds = [];
        for (const sk of order) {
          const s = strategies[sk];
          const style = STRATEGY_STYLE[sk];
          if (!s || !style || !Array.isArray(s.equity_curve) || !s.equity_curve.length) continue;
          ds.push({ label: style.label, data: alignToDates(s.equity_curve, labels), borderColor: style.color, borderWidth: style.baseline ? 1 : 1.5, borderDash: style.baseline ? [4, 3] : undefined, pointRadius: 0, tension: 0.2, fill: false, spanGaps: true });
        }
        if (!ds.length) continue;
        const chart = new window.Chart(canvas, {
          type: "line",
          data: { labels, datasets: ds },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
              regimeBands: { enabled: true, regimes },
              legend: { position: "bottom", labels: { color: PALETTE.textMuted, font: MONO_FONT } },
              tooltip: { backgroundColor: rgba(PALETTE.deep, 0.95), borderColor: PALETTE.border, borderWidth: 1, titleColor: PALETTE.text, bodyColor: PALETTE.text, callbacks: { label: (ctx) => ctx.dataset.label + ": " + (+ctx.parsed.y).toFixed(2) + "×" } },
            },
            scales: {
              x: monoAxis({ ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }),
              y: { type: "logarithmic", ...monoAxis({ ticks: { callback: (v) => (+v).toFixed(v < 10 ? 1 : 0) + "×" } }) },
            },
          },
          plugins: [regimeBandsPlugin],
        });
        this._setChart("bt-" + key, chart);
      }
    },

    destroy() { Object.values(this._charts).forEach((c) => c?.destroy()); this._charts = {}; },
  }));

  // ── Research signal (channel-divergence / late-cycle-signals) ─────────────
  Alpine.data("researchView", (key) => ({
    _chart: null,
    key,
    loading: true,
    error: null,
    payload: null,
    async load() {
      try {
        const data = await api.get(path(ROUTES.dashboards.researchSignal, { key: this.key }));
        this.payload = data.payload;
        this.loading = false;
        this.$nextTick(() => { this.drawChart(); this.drawSeriesCharts(); });
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    // The real payload carries a richer `indicators` map (the newly-added
    // channel-divergence gauges — btc_beta_vs_risk_appetite / btc_qqq_ratio_percentile
    // / stables_vs_qqq_flow — and the late-cycle series — concentration / top7_vs_spy /
    // mna / margin / consumer_conf). Render each as its own labelled sparkline.
    indicatorNames() {
      const inds = this.payload?.indicators;
      return inds && typeof inds === "object" ? Object.keys(inds) : [];
    },
    prettify(k) { return String(k).replace(/_/g, " "); },
    drawSeriesCharts() {
      const inds = this.payload?.indicators;
      if (!inds || !window.Chart || !this.$root) return;
      for (const canvas of this.$root.querySelectorAll("canvas[data-series]")) {
        const key = canvas.getAttribute("data-series");
        const pts = (inds[key] || []).filter((p) => p && p.value != null).slice(-180);
        if (!pts.length) continue;
        new window.Chart(canvas, {
          type: "line",
          data: {
            labels: pts.map((p) => p.date),
            datasets: [{ data: pts.map((p) => p.value), borderColor: PALETTE.blue, borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false }],
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: monoAxis({ ticks: { maxTicksLimit: 3 } }) },
          },
        });
      }
    },
    drawChart() {
      const canvas = this.$refs.chart;
      const pts = this.payload?.series?.points ?? [];
      if (!canvas || !window.Chart || !pts.length) return;
      this._chart?.destroy();
      this._chart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: pts.map((p) => p.date),
          datasets: [{ label: this.payload.series.label, data: pts.map((p) => p.value),
            borderColor: PALETTE.blue, backgroundColor: rgba(PALETTE.blue, 0.12), fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: { grid: { color: GRID_COLOR }, ticks: { color: PALETTE.textMuted } },
            x: { grid: { display: false }, ticks: { color: PALETTE.textDim, maxTicksLimit: 8 } } },
          plugins: { legend: { labels: { color: PALETTE.textMuted } } },
        },
      });
    },
    destroy() { this._chart?.destroy(); this._chart = null; },
    pct(x) { return x == null ? "—" : Math.round(x * 100) + "%"; },
    readClass(read) {
      const r = String(read || "");
      if (r.includes("intact") || r === "benign") return "read read--ok";
      if (r.includes("break") || r.includes("saturated")) return "read read--warn";
      return "read read--mid";
    },
  }));

  // ── Wallet performance (allocation2) ──────────────────────────────────────
  // LIVE daily series per asset (issue #84): fetched on init from
  // GET /api/dashboards/wallet-balances, replacing the baked 99-snapshot literal
  // that used to be frozen here (Mar 18–Jun 26 2026). Eight stacked-area series
  // drawn bottom→top in the endpoint's holdings[] order: Stable
  // (USDC/ZYFAI-SS1/GIZA-SS1) → Protocol (WETH/ETH) → Agent (ROBOTMONEY/BNKR) →
  // Stocks (SP500). The allocation chart's percent = value / total AUM * 100,
  // computed at runtime so the two charts share one data source. The Historical
  // Data table reads `rows`/`columns`/`showAll` from this same component.
  Alpine.data("walletPerfView", () => ({
    _charts: [],
    showAll: false,
    loading: true,
    error: null,
    // Live prop-wallet feed (issue #84): the eight stacked series + Historical
    // Data table are derived on init from GET /api/dashboards/wallet-balances
    // (holdings[] = fixed group/colour order; history[] = continuous, sparse
    // byAsset per day), NOT baked here. The retired 99-day literal used to be
    // frozen (Mar 18–Jun 26 2026); it now updates as the daily sampler runs.
    labels: [],
    assets: [],
    totalAum: [],
    columns: [],
    rows: [],
    init() { this.load(); },
    // ISO calendar day ("2026-03-18") → the compact "Mar 18" label.
    _fmtDay(iso) {
      return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    },
    // Fetch the endpoint and build the series/table from it. Colours + series
    // order come from holdings[] (Stable→Protocol→Agent→Stocks); an asset absent
    // from a day's byAsset stacks as 0 (chart) / renders "–" (table).
    async load() {
      try {
        const data = await api.get(ROUTES.dashboards.walletBalances);
        const holdings = data.holdings || [];
        const history = data.history || [];
        this.labels = history.map((pt) => this._fmtDay(pt.date));
        this.totalAum = history.map((pt) => pt.totalUsd);
        this.columns = holdings.map((h) => ({ sym: h.symbol, color: h.color }));
        this.assets = holdings.map((h) => ({
          label: h.symbol, color: h.color,
          aum: history.map((pt) => (pt.byAsset[h.symbol] ?? 0)),
        }));
        this.rows = history.map((pt) => ({
          d: this._fmtDay(pt.date), aum: pt.totalUsd,
          a: Object.fromEntries(Object.entries(pt.byAsset).map(([sym, v]) => [sym, [v, ""]])),
        }));
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
        this.destroy();
        this.$nextTick(() => this.draw());
      }
    },
    // Collapsed = last 5 snapshots; "Show All" expands to the full series.
    visibleRows() { return this.showAll ? this.rows : this.rows.slice(-5); },
    fmtUsd(v) { return "$" + Number(v).toLocaleString("en-US"); },
    // Build the eight stacked series. kind "aum" → raw $; "pct" → % of total AUM.
    _series(kind) {
      return this.assets.map((a) => ({
        label: a.label, color: a.color,
        data: a.aum.map((v, i) => kind === "pct" ? (this.totalAum[i] ? (v / this.totalAum[i]) * 100 : 0) : v),
      }));
    },
    _chart(canvas, series, max, step, tick, tip) {
      if (!canvas || !window.Chart) return;
      const instance = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: this.labels,
          datasets: series.map((s) => ({
            label: s.label, data: s.data, borderColor: s.color,
            backgroundColor: rgba(s.color, 0.8),
            fill: true, tension: 0, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          scales: {
            y: { min: 0, max, stacked: true, ...monoAxis({ ticks: { stepSize: step, callback: tick } }) },
            x: monoAxis({ ticks: { autoSkip: true } }),
          },
          plugins: {
            legend: {
              display: true, position: "bottom",
              labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 6, boxHeight: 6, padding: 16, color: PALETTE.textMuted, font: { family: MONO_FONT.family, size: 11 } },
            },
            tooltip: { callbacks: { label: tip } },
          },
        },
      });
      this._charts.push(instance);
    },
    draw() {
      this._chart(this.$refs.aum, this._series("aum"), 140000, 20000, (v) => "$" + (v / 1000).toFixed(0) + "k",
        (c) => `${c.dataset.label}: $${(+c.parsed.y).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
      this._chart(this.$refs.alloc, this._series("pct"), 120, 20, (v) => v + "%",
        (c) => `${c.dataset.label}: ${(+c.parsed.y).toFixed(1)}%`);
    },
    destroy() { this._charts.forEach((item) => item.destroy()); this._charts = []; },
  }));

  // ── Tokenomics fee distribution (pie + legend + breakdown cards) ──────────
  // The fee split is LIVE from GET /api/dashboards/token-metrics (`feeSplit`) —
  // a fixed Clanker-pool config constant surfaced through the API so the
  // frontend stops baking the Protocol/Bankr/Clanker % literals. This factory
  // backs both the tokenomics fee section (pie + custom legend + breakdown
  // cards) and the home page fee-routing card (Creator share vs Interface &
  // Protocol). Colours are presentation-only, keyed by the split label; the
  // percentages themselves are never fabricated — a failed fetch degrades to
  // "—" and an undrawn pie rather than a baked default.
  const FEE_COLOR = { Protocol: SERIES.emerald, Bankr: SERIES.amber, Clanker: PALETTE.purple };
  Alpine.data("feeChart", () => ({
    _chart: null,
    metrics: null,
    async init() {
      try { this.metrics = await api.get(ROUTES.dashboards.tokenMetrics); }
      catch (e) { this.metrics = null; }
      this.$nextTick(() => this.draw());
    },
    feeSplit() { return this.metrics?.feeSplit || []; },
    // Legend/card cell text: "Protocol (57%)" and the bare "57%".
    feeLegend(i) { const f = this.feeSplit()[i]; return f ? `${f.label} (${f.pct}%)` : "—"; },
    feePctLabel(i) { const f = this.feeSplit()[i]; return f ? `${f.pct}%` : "—"; },
    feeColor(i) { const f = this.feeSplit()[i]; return (f && FEE_COLOR[f.label]) || PALETTE.textMuted; },
    // Home fee-routing card: Creator share = the Protocol leg; Interface &
    // Protocol = every other leg (Bankr + Clanker) summed.
    feeCreatorPct() { const fs = this.feeSplit(); return fs.length ? fs[0].pct : null; },
    feeInterfacePct() { const fs = this.feeSplit(); return fs.length ? fs.slice(1).reduce((a, f) => a + f.pct, 0) : null; },
    pctLabel(v) { return v == null ? "—" : `${v}%`; },
    pctWidth(v) { return `width:${v == null ? 0 : v}%;`; },
    draw() {
      const canvas = this.$refs.fee;
      if (!canvas || !window.Chart) return;
      const fs = this.feeSplit();
      this._chart?.destroy();
      // Honest degrade: no live split → leave the canvas empty, never a baked pie.
      if (!fs.length) { this._chart = null; return; }
      this._chart = new window.Chart(canvas, {
        type: "pie",
        data: {
          labels: fs.map((f) => `${f.label} (${f.pct}%)`),
          datasets: [{ data: fs.map((f) => f.pct), backgroundColor: fs.map((f) => FEE_COLOR[f.label] || PALETTE.textMuted), borderColor: PALETTE.deep, borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } },
      });
    },
    destroy() { this._chart?.destroy(); this._chart = null; },
  }));

  // ── Buyback summary (tokenomics page) ─────────────────────────────────────
  // Compact live view of GET /api/dashboards/buybacks for the tokenomics
  // "Buyback History" card (Date / WETH / Value / $RM + total). Same endpoint
  // and formatters as the full allocation table; a stub feed is flagged and a
  // failed fetch degrades to an empty state — never the old baked rows.
  Alpine.data("buybackSummary", () => ({
    loading: true,
    buybacks: null,
    async init() {
      try { this.buybacks = await api.get(ROUTES.dashboards.buybacks); }
      catch (e) { this.buybacks = null; }
      this.loading = false;
    },
    rows() { return this.buybacks?.rows || []; },
    totals() { return this.buybacks?.totals || null; },
    nonLive() { return this.buybacks?.source === "stub"; },
    fmtWeth(v) { return v == null ? "—" : Number(v).toFixed(4); },
    fmtWethLabel(v) { return v == null ? "—" : Number(v).toFixed(6) + " WETH"; },
    fmtUsd0(v) { return v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }); },
    fmtRmoney(v) { return v == null ? "—" : (Number(v) / 1e6).toFixed(2) + "M"; },
  }));

  // ── Asset Allocation ───────────────────────────────────────────────────────
  // EVERY section is now data-driven — no baked DATA literals remain:
  //   • Strategy pie + 4 mini bucket pies + bucket-card target weights come
  //     from GET /api/dashboards/allocation (admin/committee-managed target
  //     weights seeded from committee/allocation.json). Slice/legend COLOURS
  //     are presentation-only and stay client-side (the DTO carries no colour).
  //   • Vault pie + holdings table + TVL come from GET /api/dashboards/vault-economics.
  //   • Wallet pie + aggregate holdings table come from the per-asset legs of
  //     GET /api/dashboards/wallet-balances (`holdings[]`).
  //   • The 3 per-wallet sleeve tables come from GET /api/dashboards/wallet-sleeves.
  //   • The buyback total chip + table come from GET /api/dashboards/buybacks.
  // Each endpoint is fetched independently (allSettled semantics) so one
  // degraded feed leaves only its own widget empty/"—" instead of blanking the
  // page, and nothing is ever fabricated. The three BIG pies (strategy, vault,
  // wallet) render % datalabels via a small inline plugin; the four MINI bucket
  // pies render none.

  // Asset dot colour by symbol (presentation-only, mirrors the original design
  // system). Used for the sleeve tables, whose per-holding DTO carries no colour
  // (the aggregate wallet-balances holdings do — those use `holding.color`).
  const ASSET_DOT = {
    USDC: "#10b981", "ZYFAI-SS1": "#10b981", "GIZA-SS1": "#10b981",
    ROBOTMONEY: "#3b82f6", BNKR: "#3b82f6",
    WETH: "#f59e0b", ETH: "#f59e0b", SP500: "#8b5cf6",
  };
  const assetDot = (sym) => ASSET_DOT[sym] || "#94a3b8";
  // Strategy-pie slice colours (4 buckets) + per-bucket mini-pie palettes, in
  // committee/allocation.json bucket order (defi-yield / agent / protocol / rwa).
  const STRATEGY_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#a855f7"];
  const BUCKET_PALETTES = [
    ["#047857", "#059669", "#10b981", "#34d399", "#6ee7b7"],
    ["#1e3a8a", "#1e40af", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe"],
    ["#b45309", "#d97706", "#f59e0b", "#fbbf24"],
    ["#7c3aed", "#a855f7", "#c084fc"],
  ];

  // The hero's "Total AUM" mirrors the original site's semantics
  // (robotmoney-site src/app/allocation/page.tsx: totalValue + vaultTotalValue)
  // — wallet holdings PLUS vault TVL, not vault TVL alone. Both halves are now
  // LIVE (issue #84): the wallet half comes from GET /api/dashboards/wallet-balances
  // (`wallet.totalUsd`), the vault half from vault-economics (`economics.tvlUsd`).
  // The baked static wallet-snapshot scalar that used to live here is retired.
  Alpine.data("allocationView", () => ({
    _charts: [],
    economics: null,   // GET /api/dashboards/vault-economics
    wallet: null,      // GET /api/dashboards/wallet-balances (aggregate holdings)
    sleeves: null,     // GET /api/dashboards/wallet-sleeves (per-wallet breakdown)
    allocationFw: null,// GET /api/dashboards/allocation (target weights)
    buybacks: null,    // GET /api/dashboards/buybacks
    loading: true,
    error: null,
    // Inline datalabels plugin: white mono-bold % just inside each slice edge,
    // mirroring chartjs-plugin-datalabels {anchor:"end", align:"start", offset:10}.
    _pieLabels: {
      id: "allocPieLabels",
      afterDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.show) return;
        const ds = chart.data.datasets[0];
        const total = ds.data.reduce((a, b) => a + (Number(b) || 0), 0);
        if (!total) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = "bold 11px 'JetBrains Mono', monospace";
        ctx.fillStyle = PALETTE.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = PALETTE.deep;
        ctx.shadowBlur = 4;
        chart.getDatasetMeta(0).data.forEach((arc, i) => {
          const v = Number(ds.data[i]) || 0;
          if (v <= 0) return;
          const angle = (arc.startAngle + arc.endAngle) / 2;
          const r = arc.outerRadius - 20;
          ctx.fillText(`${((v / total) * 100).toFixed(0)}%`, arc.x + Math.cos(angle) * r, arc.y + Math.sin(angle) * r);
        });
        ctx.restore();
      },
    },
    init() {
      this.$nextTick(() => this.draw());
      this.load();
    },
    // Fetch live vault economics; redraw so the vault pie reflects real
    // per-adapter balances once the response (or the degraded/stale fallback)
    // arrives. Alpine's x-text bindings on economics.* update reactively on
    // their own — this only needs to touch the imperative Chart.js canvas.
    async load() {
      // Each feed is fetched and assigned INDEPENDENTLY: the reactive x-text
      // bindings (hero AUM, tables) update the instant that endpoint resolves,
      // so a slow or failed feed only leaves its own widget in the loading/"—"
      // state instead of blocking the page. A failed leg becomes null (never a
      // fabricated value). Total AUM stays null-until-both-live (issue #84).
      const fetchInto = (key, route) =>
        api.get(route).then((d) => { this[key] = d; }).catch(() => { this[key] = null; });
      await Promise.allSettled([
        fetchInto("economics", ROUTES.dashboards.vaultEconomics),
        fetchInto("wallet", ROUTES.dashboards.walletBalances),
        fetchInto("sleeves", ROUTES.dashboards.walletSleeves),
        fetchInto("allocationFw", ROUTES.dashboards.allocation),
        fetchInto("buybacks", ROUTES.dashboards.buybacks),
      ]);
      // Imperative Chart.js pies are (re)drawn once, after every feed has
      // settled, from whatever data arrived (missing feeds simply skip their pie).
      this.loading = false;
      this.destroy();
      this.$nextTick(() => this.draw());
    },
    // True when any live source (vault or wallet) is serving stub/degraded data,
    // so the hero can flag that Total AUM is not fully live chain data.
    walletNonLive() {
      return this.wallet?.source === "stub" || (this.wallet?.holdings || []).some((h) => h.provenance === "stub");
    },
    walletStale() {
      return (this.wallet?.holdings || []).some((h) => h.provenance === "stale");
    },
    fmtUsd(v) {
      if (v == null) return "—";
      const n = Number(v);
      return "$" + n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1000 ? 2 : 0 });
    },
    fmtPct(v) { return v == null ? "—" : (Number(v) * 100).toFixed(2) + "%"; },
    // Hero Total AUM = live prop-wallet total (wallet-balances) + live vault TVL
    // (vault-economics) — issue #84. Null-until-live: if EITHER half is unknown
    // (still loading, or degraded with no persisted sample) this returns null so
    // fmtUsd() renders "—" rather than showing one half alone, which would
    // understate the true total without disclosing why.
    totalAum() {
      const vault = this.economics?.tvlUsd;
      const wallet = this.wallet?.totalUsd;
      if (vault == null || wallet == null) return null;
      return wallet + vault;
    },
    // Per-adapter Value cell (issue #50): an adapter still at its placeholder
    // address is reported configured:false with balanceUsd:null by the API —
    // render an explicit unconfigured state, never a live-looking $0 / dash.
    adapterValue(a) {
      return a && a.configured === false ? "Not configured" : this.fmtUsd(a?.balanceUsd);
    },
    // Balance/Price columns (vault TVL table layout parity): every adapter is
    // a USDC-denominated lending position, so its balance is the same figure
    // as balanceUsd at a fixed $1.00/unit peg — not a second, independently
    // fabricated number. Unconfigured/unknown adapters show "—", never a
    // live-looking $0 or invented price.
    adapterBalance(a) {
      return a && a.configured !== false && a.balanceUsd != null
        ? Number(a.balanceUsd).toLocaleString("en-US", { maximumFractionDigits: 4 })
        : "—";
    },
    adapterPrice(a) {
      return a && a.configured !== false && a.balanceUsd != null ? "$1.00" : "—";
    },
    asOfLabel() {
      const asOf = this.economics?.asOf;
      if (!asOf) return "—";
      const label = new Date(asOf).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
      }) + " UTC";
      return this.economics?.stale ? `${label} (stale)` : label;
    },
    sharesLabel() {
      const shares = this.economics?.totalShares;
      const price = this.economics?.sharePrice;
      if (shares == null || price == null) return "—";
      return `${Number(shares).toLocaleString("en-US", { maximumFractionDigits: 2 })} rmUSDC shares @ $${Number(price).toFixed(4)}`;
    },
    // ── holdings / sleeve table formatters (presentation over live DTOs) ──────
    dotColor(sym) { return assetDot(sym); },
    // Token balance: millions-suffixed for large counts, else up to 4 dp.
    fmtAmount(v) {
      if (v == null || !isFinite(v)) return "—";
      const a = Math.abs(v);
      if (a >= 1e6) return (v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "M";
      return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
    },
    // Unit price: sub-cent prices keep 3 significant figures ($0.00000451),
    // everything else 2–4 dp ($0.9983 / $1,550.76).
    fmtPrice(v) {
      if (v == null || !isFinite(v)) return "—";
      const a = Math.abs(v);
      if (a === 0) return "$0";
      if (a < 0.01) return "$" + Number(v.toPrecision(3)).toString();
      return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    },
    // Always-2dp USD (buyback value cells / totals, which are < $1k but need cents).
    fmtUsd2(v) { return v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
    // ── target weights (allocation framework) ─────────────────────────────────
    stratPct(i) { const s = this.allocationFw?.strategy?.[i]; return s == null ? "—" : Math.round(Number(s.targetPct)) + "%"; },
    // ── sleeves ───────────────────────────────────────────────────────────────
    sleeveWallets() { return this.sleeves?.wallets || []; },
    walletCount() { return this.sleeveWallets().length; },
    // ── buybacks ──────────────────────────────────────────────────────────────
    buybackRows() { return this.buybacks?.rows || []; },
    fmtWeth(v) { return v == null ? "—" : Number(v).toFixed(6); },
    fmtWethLabel(v) { return v == null ? "—" : Number(v).toFixed(6) + " WETH"; },
    // $ROBOTMONEY token count → millions-suffixed ("18.45M").
    fmtRmoney(v) { return v == null ? "—" : (Number(v) / 1e6).toFixed(2) + "M"; },
    shortHash(h) { return h ? `${h.slice(0, 8)}...${h.slice(-6)}` : "—"; },
    txUrl(h) { return `https://basescan.org/tx/${h}`; },
    buybackNonLive() { return this.buybacks?.source === "stub"; },
    _pie(ref, labels, data, colors, big) {
      const canvas = this.$refs[ref];
      if (!canvas || !window.Chart) return;
      const total = data.reduce((a, b) => a + b, 0);
      const instance = new window.Chart(canvas, {
        type: "pie",
        data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: PALETTE.deep, borderWidth: big ? 2 : 1.5, hoverOffset: big ? 8 : 4 }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          layout: { padding: big ? 20 : 2 },
          plugins: {
            legend: { display: false },
            allocPieLabels: { show: !!big },
            tooltip: { callbacks: { label: (c) => `${c.label}: ${((c.parsed / total) * 100).toFixed(1)}%` } },
          },
        },
        plugins: [this._pieLabels],
      });
      this._charts.push(instance);
    },
    draw() {
      // Big strategy pie + 4 mini bucket pies — target weights from the live
      // allocation framework (committee/allocation.json). Slice colours are
      // presentation-only (the DTO carries no colour); weights are never baked.
      // Honest degrade: if a feed is missing, its pie is simply not drawn — no
      // fabricated placeholder split.
      const strat = this.allocationFw?.strategy || [];
      if (strat.length) {
        this._pie("strategy",
          strat.map((s) => s.label),
          strat.map((s) => Number(s.targetPct) || 0),
          strat.map((_, i) => STRATEGY_COLORS[i % STRATEGY_COLORS.length]), true);
      }
      const buckets = this.allocationFw?.buckets || [];
      ["mini1", "mini2", "mini3", "mini4"].forEach((ref, i) => {
        const items = buckets[i]?.items || [];
        if (!items.length) return;
        const palette = BUCKET_PALETTES[i] || STRATEGY_COLORS;
        this._pie(ref,
          items.map((it) => it.label),
          items.map((it) => Number(it.targetPct) || 0),
          items.map((_, j) => palette[j % palette.length]), false);
      });
      // Vault pie — three adapter slices from the live vault-economics fetch
      // (issue #40). Before the fetch resolves, or when it degrades to
      // stale/null balances, falls back to an equal-thirds placeholder rather
      // than a fabricated split.
      const adapters = this.economics?.adapters ?? [];
      const hasLiveBalances = adapters.length === 3 && adapters.some((a) => a.balanceUsd != null && a.balanceUsd > 0);
      const vaultLabels = adapters.length === 3 ? adapters.map((a) => a.name.toUpperCase()) : ["MORPHO", "AAVE", "COMPOUND"];
      const vaultValues = hasLiveBalances ? adapters.map((a) => Math.max(0, Number(a.balanceUsd) || 0)) : [1, 1, 1];
      this._pie("vault", vaultLabels, vaultValues, ["#10b981", "#10b981", "#10b981"], true);
      // Wallet pie — live USD value per asset from wallet-balances holdings[]
      // (colour-grouped via each holding's own `color`). Assets with no live
      // value are dropped rather than drawn as a zero/fabricated slice; if the
      // feed is missing the pie is not drawn at all (honest degrade).
      const holdings = (this.wallet?.holdings || []).filter((h) => (Number(h.valueUsd) || 0) > 0);
      if (holdings.length) {
        this._pie("wallet",
          holdings.map((h) => h.symbol),
          holdings.map((h) => Number(h.valueUsd) || 0),
          holdings.map((h) => h.color || assetDot(h.symbol)), true);
      }
    },
    destroy() { this._charts.forEach((c) => c.destroy()); this._charts = []; },
  }));

  // ── Investment Committee ──────────────────────────────────────────────────
  Alpine.data("committeeView", () => ({
    loading: true,
    error: null,
    members: [],
    sessions: [],
    subjectCache: {},
    async load() {
      try {
        const [memberData, sessionData] = await Promise.all([
          api.get(ROUTES.committee.members),
          api.get(ROUTES.committee.sessions),
        ]);
        this.members = memberData.members || [];
        this.sessions = sessionData.sessions || [];
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    publishedSessions() { return this.sessions.filter((s) => s.state === "published"); },
    subjects() {
      const map = new Map();
      for (const s of this.sessions) {
        const id = s.subjectId;
        if (!id) continue;
        const meta = this.subjectCache[id] || {};
        const row = map.get(id) || {
          id,
          name: meta.name || s.subjectName || id,
          operator: meta.operator,
          thesisBlurb: meta.thesisBlurb,
          count: 0,
          latest: null,
        };
        row.count += 1;
        if (!row.latest || String(s.date) > String(row.latest)) row.latest = s.date;
        map.set(id, row);
      }
      return [...map.values()].sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
    },
    memberTagline(m) { return m.tagline || m.mandate || `${m.name} reads the session through a ${m.lens || "committee"} lens.`; },
    memberBiases(m) {
      if (Array.isArray(m.biases)) return m.biases.filter(Boolean);
      return m.lens ? [m.lens] : [];
    },
    initials(name = "") {
      return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("") || "IC";
    },
    stanceEntries(s) { return Object.entries(s.committeeRecommendation?.stances || {}); },
    quorumText(s) {
      const q = s.committeeRecommendation?.quorum;
      return q ? `${q.submitted}/${q.active} submitted` : "";
    },
    regimeLabel(r) { return r ? String(r).replace(/_/g, "-") : "—"; },
    stanceColor(s) {
      return ({ bullish: "#10b981", constructive: "#84cc16", neutral: "#94a3b8", cautious: "#f59e0b", bearish: "#ef4444" }[s] || "#94a3b8");
    },
    formatDate(value, style = "short") {
      const date = String(value || "").includes("T") ? new Date(value) : new Date(`${value}T00:00:00Z`);
      const opts = style === "long"
        ? { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }
        : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
      try { return date.toLocaleDateString("en-US", opts); } catch (_) { return value; }
    },
  }));

  // ── Public comment thread ─────────────────────────────────────────────────
  // Re-creates the original site's comment thread, now backed by Postgres.
  // Fed a page slug; fetches GET /api/comments and POSTs new comments. Renders
  // optimistically and surfaces the 429 rate-limit message inline.
  Alpine.data("commentsThread", (page) => ({
    page,
    loading: true,
    error: null,
    notice: null,
    posting: false,
    comments: [],
    form: { author: "", content: "" },
    async load() {
      try {
        const data = await api.get(ROUTES.comments.list, { page: this.page });
        this.comments = data.comments || [];
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    async submit() {
      this.notice = null;
      const author = this.form.author.trim();
      const content = this.form.content.trim();
      if (!author || !content) {
        this.notice = "Name and comment are both required.";
        return;
      }
      this.posting = true;
      try {
        const created = await api.post(ROUTES.comments.create, { page: this.page, author, content });
        this.comments.push(created); // optimistic append (oldest → newest)
        this.form.content = "";
      } catch (e) {
        // ApiError exposes .status; 429 = rate limited.
        this.notice = e.status === 429
          ? "You're commenting too fast — please wait a moment and try again."
          : `Could not post your comment (${e.message}).`;
      } finally {
        this.posting = false;
      }
    },
    when(iso) {
      try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
    },
  }));

  // ── Committee application (apply → pending activation) ─────────────────────
  // The real onboarding entry point. POSTs the prospective member's public key
  // to /api/committee/apply; the member is recorded 'applied' and an admin must
  // activate it before it can submit. No token is minted here.
  Alpine.data("applyForm", () => ({
    form: { memberId: "", name: "", lens: "", publicKey: "" },
    submitting: false,
    error: null,
    result: null,
    async submit() {
      this.error = null;
      this.submitting = true;
      try {
        const body = {
          memberId: this.form.memberId.trim(),
          name: this.form.name.trim(),
          lens: this.form.lens.trim() || undefined,
          publicKey: this.form.publicKey.trim(),
        };
        this.result = await api.post(ROUTES.committee.apply, body);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  }));
}
