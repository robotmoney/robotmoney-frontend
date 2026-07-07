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
    panelsList() { const p = this.latest?.panels; return Array.isArray(p) && p.length ? p : ["macro", "onchain"]; },
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
  // Full 99-snapshot daily series per asset, baked from unified-wallet-history.csv
  // (Mar 18–Jun 26 2026). Eight stacked-area series drawn bottom→top exactly as
  // the original React page: Stable (USDC/ZYFAI-SS1/GIZA-SS1) → Protocol
  // (WETH/ETH) → Agent (ROBOTMONEY/BNKR) → Stocks (SP500). No fetch; draws once
  // on init. The allocation chart's percent = value / total AUM * 100, computed
  // at runtime so the two charts share one data source. The Historical Data
  // table below reads `rows`/`columns`/`showAll` from this same component.
  Alpine.data("walletPerfView", () => ({
    _charts: [],
    showAll: false,
    labels: ["Mar 18","Mar 19","Mar 20","Mar 21","Mar 22","Mar 23","Mar 25","Mar 26","Mar 27","Mar 28","Mar 29","Mar 30","Mar 31","Apr 1","Apr 2","Apr 3","Apr 4","Apr 5","Apr 6","Apr 7","Apr 8","Apr 9","Apr 10","Apr 11","Apr 12","Apr 13","Apr 14","Apr 15","Apr 16","Apr 17","Apr 18","Apr 19","Apr 20","Apr 21","Apr 22","Apr 23","Apr 24","Apr 25","Apr 26","Apr 27","Apr 28","Apr 29","Apr 30","May 1","May 2","May 3","May 4","May 5","May 6","May 7","May 8","May 9","May 10","May 11","May 12","May 13","May 14","May 15","May 16","May 17","May 18","May 19","May 20","May 21","May 22","May 23","May 24","May 25","May 26","May 27","May 28","May 29","May 30","May 31","Jun 1","Jun 2","Jun 3","Jun 5","Jun 6","Jun 7","Jun 8","Jun 9","Jun 10","Jun 11","Jun 12","Jun 13","Jun 14","Jun 15","Jun 16","Jun 17","Jun 18","Jun 19","Jun 20","Jun 21","Jun 22","Jun 23","Jun 24","Jun 25","Jun 26"],
    // Per-asset AUM ($) series, index-aligned to `labels`. Colours per spec §3.
    assets: [
      { label: "USDC", color: SERIES.emerald, aum: [0,0,0,0,0,0,0,9962,9966,9955,9912,9951,9951,9912,10012,9951,9942,9936,9892,9971,9955,9981,9945,9921,9895,9946,943,935,934,942,940,937,943,939,939,939,937,938,937,934,937,940,933,938,935,934,936,934,941,942,935,942,935,936,936,936,939,935,936,942,941,941,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,9068,9007,9987,10006,14463,14532,14448,14442,14443,14420,14550,9042,9026,9021,9016,9054,9072,8994,9016,8995,9042,9052] },
      { label: "ZYFAI-SS1", color: SERIES.emerald, aum: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4500,4501,4501,4501,4502,4503,4503,4504,4505,4505,4505,4506,4507,4507,4508,4508,4509,4509,4510,4510,4511,4511,4511,4512,4513,4513,4514,4514,4515,4515,4516,4516,4517,4517,4518,4518,4519,4520,4520,4521,4521,4521,4522,4523,4523,4524,4524,4525,4526,4526,4527,4528,4528,4528,4529,4529,4530,4530,4531,4532,4532,4533,4533,4534,4535,4535,4536,4536,4537,4537,4538,4538] },
      { label: "GIZA-SS1", color: SERIES.emerald, aum: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4500,4501,4502,4502,4502,4503,4504,4504,4505,4505,0,0,4507,4508,0,0,0,0,0,0,4511,4512,4512,4513,4514,4514,4514,4515,4515,4516,4517,4517,4517,4519,4519,4519,4520,4520,4521,4522,4523,4523,4524,4524,4524,4524,4524,4524,4524,4524,4524,4524,4524,4524,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
      { label: "WETH", color: SERIES.amber, aum: [21519,20841,20441,20464,19855,19484,22252,13364,13758,14408,14743,15273,15764,16231,16268,16201,16592,16763,17480,17541,18784,18648,19230,20226,20399,20541,19670,20353,20780,18206,18285,18000,17590,18618,19211,20799,20740,20959,21324,21859,21617,22125,21964,22553,23683,24398,24796,26179,26245,26359,25862,26324,26582,27418,27417,26970,27273,28545,28010,27838,28674,28147,0,0,0,0,0,0,0,0,0,0,0,0,0,9478,9003,111,214,23424,24663,25891,24878,24510,25637,25515,25930,26578,28030,27742,26975,26426,26261,26872,26454,26553,25682,24916,24194] },
      { label: "ETH", color: SERIES.amber, aum: [0,0,0,0,0,0,2137,2069,2042,1995,2004,2031,2072,2100,2083,2044,2048,2059,2133,2106,2233,2181,2188,2249,2222,2193,2343,2323,2371,2426,2437,2356,2271,2320,2307,2395,2337,2309,2319,2360,2294,2290,2251,2254,2293,2323,2348,2371,2377,2355,2288,2314,2332,2372,2342,2286,2255,2297,2223,2180,2191,2105,105,106,106,104,106,104,105,103,101,100,100,101,101,100,93,88,80,78,82,85,82,80,84,83,84,86,91,90,87,86,85,87,86,86,83,81,78] },
      { label: "ROBOTMONEY", color: "#3b82f6", aum: [51300,45207,36397,31594,27998,27253,38817,35631,35013,45389,49311,45897,43041,39798,34421,40995,37994,36316,37678,39430,41470,46311,53361,42195,42296,42907,44926,42454,47711,48799,47545,41722,32117,31433,24208,27443,25760,21947,19920,18950,24315,28661,32806,32673,36368,33091,31319,41835,37694,32593,29302,26760,30437,35862,31280,39363,54623,42079,41513,42804,46834,74454,81744,81535,123009,100782,93489,85065,68328,60862,54076,55404,50705,54565,57460,59781,51124,40369,41733,43158,48334,49495,40740,38611,37276,36665,41163,40906,42951,44594,39936,38834,39088,40843,37936,37959,36143,31831,30652] },
      { label: "BNKR", color: "#3b82f6", aum: [12,12,10,10,10,10,10,9,9,9,9,9,9,9,9,8,8,8,8,7,8,8,8,9,9,9,10,9,9,9,9,9,8,9,8,9,8,8,8,8,8,8,8,8,8,8,8,8,8,9,9,9,8,8,8,8,11,10,13,15,16,14,13,14,12,12,13,14,12,13,13,13,15,19,16,16,13,15,13,14,13,13,12,11,11,12,12,12,12,12,12,11,11,12,12,11,11,10,9] },
      { label: "SP500", color: PALETTE.purple, aum: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4505,4506,4475,4476,4509,4491,4512,4505,4533,4517,4527,4552,4527,4520,4575,4579,4579,4586,4580,4607,4661,4639,4690,4696,4674,4698,4687,4724,4753,4686,4681,4691,4699,4660,4690,4725,4728,4801,4766,4773,4764,4774,4797,4800,4807,4808,4811,4820,4798,4684,4683,4665,4697,4665,4595,4696,4722,4721,4749,4789,4767,4731,4757,4737,4746,4733,4727,4669,4683,4656] },
    ],
    totalAum: [72831,66060,56848,52068,47864,46747,63215,61036,60789,71756,75978,73161,70836,68049,62793,69198,66585,65082,67191,69055,72450,77128,84732,74600,74822,75597,67891,75074,80806,83890,82726,76503,66411,66835,60172,65107,63296,55201,53532,57651,62737,63058,66989,67509,72374,69842,68504,84929,80896,75941,72059,70065,74018,80298,75710,83280,98857,87653,86413,87494,92384,119396,95559,95383,136892,114667,107451,98994,82263,74789,68011,69361,64668,68541,71434,83236,74104,63501,64782,90396,96815,99173,89439,86785,86677,85970,90861,91413,89447,90765,85295,83665,83772,86167,82751,82890,80120,75101,73180],
    // Table column headers (legend order) with their header-dot colour (spec §5).
    columns: [
      { sym: "USDC", color: "#10b981" },
      { sym: "ZYFAI-SS1", color: "#10b981" },
      { sym: "GIZA-SS1", color: "#10b981" },
      { sym: "WETH", color: "#f59e0b" },
      { sym: "ETH", color: "#f59e0b" },
      { sym: "ROBOTMONEY", color: "#3b82f6" },
      { sym: "BNKR", color: "#3b82f6" },
      { sym: "SP500", color: "#8b5cf6" },
    ],
    // 99 daily rows: d=date, aum=Total AUM, a={sym:[value_usd,balanceStr]}.
    // A symbol absent from `a` renders as "–". Balance is pre-formatted (spec §5a).
    rows: [{"d":"Mar 18","aum":72831,"a":{"WETH":[21519,"9.8392"],"ROBOTMONEY":[51300,"2393688781"],"BNKR":[12,"25081.3100"]}},{"d":"Mar 19","aum":66060,"a":{"WETH":[20841,"9.5076"],"ROBOTMONEY":[45207,"2393688781"],"BNKR":[12,"25081.3083"]}},{"d":"Mar 20","aum":56848,"a":{"WETH":[20441,"9.5076"],"ROBOTMONEY":[36397,"2393688781"],"BNKR":[10,"25081.3083"]}},{"d":"Mar 21","aum":52068,"a":{"WETH":[20464,"9.5076"],"ROBOTMONEY":[31594,"2393688781"],"BNKR":[10,"25081.3083"]}},{"d":"Mar 22","aum":47864,"a":{"WETH":[19855,"9.5076"],"ROBOTMONEY":[27998,"2393688781"],"BNKR":[10,"25081.3083"]}},{"d":"Mar 23","aum":46747,"a":{"WETH":[19484,"9.5076"],"ROBOTMONEY":[27253,"2393688781"],"BNKR":[10,"25081.3083"]}},{"d":"Mar 25","aum":63215,"a":{"WETH":[22252,"10.1715"],"ETH":[2137,"1.0000"],"ROBOTMONEY":[38817,"2982652434"],"BNKR":[10,"25081.3083"]}},{"d":"Mar 26","aum":61036,"a":{"USDC":[9962,"9937.6125"],"WETH":[13364,"6.4577"],"ETH":[2069,"1.0000"],"ROBOTMONEY":[35631,"3124178034"],"BNKR":[9,"25081.3083"]}},{"d":"Mar 27","aum":60789,"a":{"USDC":[9966,"9937.6125"],"WETH":[13758,"6.7372"],"ETH":[2042,"1.0000"],"ROBOTMONEY":[35013,"3178927720"],"BNKR":[9,"25081.3083"]}},{"d":"Mar 28","aum":71756,"a":{"USDC":[9955,"9937.6125"],"WETH":[14408,"7.2212"],"ETH":[1995,"1.0000"],"ROBOTMONEY":[45389,"3233776200"],"BNKR":[9,"25081.3083"]}},{"d":"Mar 29","aum":75978,"a":{"USDC":[9912,"9937.6125"],"WETH":[14743,"7.3564"],"ETH":[2004,"1.0000"],"ROBOTMONEY":[49311,"3251285654"],"BNKR":[9,"25081.3083"]}},{"d":"Mar 30","aum":73161,"a":{"USDC":[9951,"9937.6125"],"WETH":[15273,"7.5194"],"ETH":[2031,"1.0000"],"ROBOTMONEY":[45897,"3277678459"],"BNKR":[9,"25081.3083"]}},{"d":"Mar 31","aum":70836,"a":{"USDC":[9951,"9937.6125"],"WETH":[15764,"7.6079"],"ETH":[2072,"1.0000"],"ROBOTMONEY":[43041,"3294725510"],"BNKR":[9,"25081.3083"]}},{"d":"Apr 1","aum":68049,"a":{"USDC":[9912,"9937.6125"],"WETH":[16231,"7.7294"],"ETH":[2100,"1.0000"],"ROBOTMONEY":[39798,"3319302298"],"BNKR":[9,"25081.3083"]}},{"d":"Apr 2","aum":62793,"a":{"USDC":[10012,"9937.6125"],"WETH":[16268,"7.8088"],"ETH":[2083,"1.0000"],"ROBOTMONEY":[34421,"3338209124"],"BNKR":[9,"25081.3083"]}},{"d":"Apr 3","aum":69198,"a":{"USDC":[9951,"9937.6125"],"WETH":[16201,"7.9258"],"ETH":[2044,"1.0000"],"ROBOTMONEY":[40995,"3359096783"],"BNKR":[8,"25081.3083"]}},{"d":"Apr 4","aum":66585,"a":{"USDC":[9942,"9937.6125"],"WETH":[16592,"8.0997"],"ETH":[2048,"1.0000"],"ROBOTMONEY":[37994,"3388190766"],"BNKR":[8,"25081.3083"]}},{"d":"Apr 5","aum":65082,"a":{"USDC":[9936,"9937.6125"],"WETH":[16763,"8.1421"],"ETH":[2059,"1.0000"],"ROBOTMONEY":[36316,"3398031151"],"BNKR":[8,"25081.3083"]}},{"d":"Apr 6","aum":67191,"a":{"USDC":[9892,"9937.6125"],"WETH":[17480,"8.1954"],"ETH":[2133,"1.0000"],"ROBOTMONEY":[37678,"3408889442"],"BNKR":[8,"25081.3083"]}},{"d":"Apr 7","aum":69055,"a":{"USDC":[9971,"9937.6125"],"WETH":[17541,"8.3290"],"ETH":[2106,"1.0000"],"ROBOTMONEY":[39430,"3429828630"],"BNKR":[7,"25081.3083"]}},{"d":"Apr 8","aum":72450,"a":{"USDC":[9955,"9937.6125"],"WETH":[18784,"8.4136"],"ETH":[2233,"1.0000"],"ROBOTMONEY":[41470,"3447844330"],"BNKR":[8,"25081.3083"]}},{"d":"Apr 9","aum":77128,"a":{"USDC":[9981,"9937.6125"],"WETH":[18648,"8.5509"],"ETH":[2181,"1.0000"],"ROBOTMONEY":[46311,"3469320437"],"BNKR":[8,"25081.3083"]}},{"d":"Apr 10","aum":84732,"a":{"USDC":[9945,"9937.6125"],"WETH":[19230,"8.7874"],"ETH":[2188,"1.0000"],"ROBOTMONEY":[53361,"3494807669"],"BNKR":[8,"25081.3083"]}},{"d":"Apr 11","aum":74600,"a":{"USDC":[9921,"9937.6125"],"WETH":[20226,"8.9938"],"ETH":[2249,"1.0000"],"ROBOTMONEY":[42195,"3535189688"],"BNKR":[9,"25081.3083"]}},{"d":"Apr 12","aum":74822,"a":{"USDC":[9895,"9937.6125"],"WETH":[20399,"9.1784"],"ETH":[2222,"1.0000"],"ROBOTMONEY":[42296,"3571148139"],"BNKR":[9,"25081.3083"]}},{"d":"Apr 13","aum":75597,"a":{"USDC":[9946,"9937.6125"],"WETH":[20541,"9.3666"],"ETH":[2193,"1.0000"],"ROBOTMONEY":[42907,"3606900022"],"BNKR":[9,"25081.3083"]}},{"d":"Apr 14","aum":67891,"a":{"USDC":[943,"937.6126"],"WETH":[19670,"8.3955"],"ETH":[2343,"1.0000"],"ROBOTMONEY":[44926,"3469477631"],"BNKR":[10,"25081.3083"]}},{"d":"Apr 15","aum":75074,"a":{"USDC":[935,"937.6126"],"ZYFAI-SS1":[4500,"1.0000"],"GIZA-SS1":[4500,"1.0000"],"WETH":[20353,"8.7626"],"ETH":[2323,"1.0000"],"ROBOTMONEY":[42454,"3525787026"],"BNKR":[9,"25081.3083"]}},{"d":"Apr 16","aum":80806,"a":{"USDC":[934,"937.6126"],"ZYFAI-SS1":[4501,"1.0000"],"GIZA-SS1":[4501,"1.0000"],"WETH":[20780,"8.7626"],"ETH":[2371,"1.0000"],"ROBOTMONEY":[47711,"3525787026"],"BNKR":[9,"25081.3083"]}},{"d":"Apr 17","aum":83890,"a":{"USDC":[942,"937.6170"],"ZYFAI-SS1":[4501,"1.0000"],"GIZA-SS1":[4502,"1.0000"],"WETH":[18206,"7.5042"],"ETH":[2426,"1.0000"],"ROBOTMONEY":[48799,"3641285272"],"BNKR":[9,"25081.3083"],"SP500":[4505,"0.6330"]}},{"d":"Apr 18","aum":82726,"a":{"USDC":[940,"937.6170"],"ZYFAI-SS1":[4501,"1.0000"],"GIZA-SS1":[4502,"1.0000"],"WETH":[18285,"7.5042"],"ETH":[2437,"1.0000"],"ROBOTMONEY":[47545,"3641285272"],"BNKR":[9,"25081.3083"],"SP500":[4506,"0.6330"]}},{"d":"Apr 19","aum":76503,"a":{"USDC":[937,"937.6170"],"ZYFAI-SS1":[4502,"1.0000"],"GIZA-SS1":[4502,"1.0000"],"WETH":[18000,"7.6386"],"ETH":[2356,"1.0000"],"ROBOTMONEY":[41722,"3667553436"],"BNKR":[9,"25081.3083"],"SP500":[4475,"0.6330"]}},{"d":"Apr 20","aum":66411,"a":{"USDC":[943,"937.6170"],"ZYFAI-SS1":[4503,"1.0000"],"GIZA-SS1":[4503,"1.0000"],"WETH":[17590,"7.7459"],"ETH":[2271,"1.0000"],"ROBOTMONEY":[32117,"3695412759"],"BNKR":[8,"25081.3083"],"SP500":[4476,"0.6330"]}},{"d":"Apr 21","aum":66835,"a":{"USDC":[939,"937.6170"],"ZYFAI-SS1":[4503,"1.0000"],"GIZA-SS1":[4504,"1.0000"],"WETH":[18618,"8.0236"],"ETH":[2320,"1.0000"],"ROBOTMONEY":[31433,"3776208165"],"BNKR":[9,"25081.3083"],"SP500":[4509,"0.6330"]}},{"d":"Apr 22","aum":60172,"a":{"USDC":[939,"937.6170"],"ZYFAI-SS1":[4504,"1.0000"],"GIZA-SS1":[4504,"1.0000"],"WETH":[19211,"8.3257"],"ETH":[2307,"1.0000"],"ROBOTMONEY":[24208,"3851545949"],"BNKR":[8,"25081.3083"],"SP500":[4491,"0.6330"]}},{"d":"Apr 23","aum":65107,"a":{"USDC":[939,"937.6170"],"ZYFAI-SS1":[4505,"1.0000"],"GIZA-SS1":[4505,"1.0000"],"WETH":[20799,"8.6831"],"ETH":[2395,"1.0000"],"ROBOTMONEY":[27443,"3995291567"],"BNKR":[9,"25081.3083"],"SP500":[4512,"0.6330"]}},{"d":"Apr 24","aum":63296,"a":{"USDC":[937,"937.6170"],"ZYFAI-SS1":[4505,"1.0000"],"GIZA-SS1":[4505,"1.0000"],"WETH":[20740,"8.8743"],"ETH":[2337,"1.0000"],"ROBOTMONEY":[25760,"4057482162"],"BNKR":[8,"25081.3083"],"SP500":[4505,"0.6330"]}},{"d":"Apr 25","aum":55201,"a":{"USDC":[938,"937.6170"],"ZYFAI-SS1":[4505,"1.0000"],"WETH":[20959,"9.0750"],"ETH":[2309,"1.0000"],"ROBOTMONEY":[21947,"4141999486"],"BNKR":[8,"25081.3083"],"SP500":[4533,"0.6330"]}},{"d":"Apr 26","aum":53532,"a":{"USDC":[937,"937.6170"],"ZYFAI-SS1":[4506,"1.0000"],"WETH":[21324,"9.1947"],"ETH":[2319,"1.0000"],"ROBOTMONEY":[19920,"4197498481"],"BNKR":[8,"25081.3083"],"SP500":[4517,"0.6330"]}},{"d":"Apr 27","aum":57651,"a":{"USDC":[934,"937.6170"],"ZYFAI-SS1":[4507,"1.0000"],"GIZA-SS1":[4507,"1.0000"],"WETH":[21859,"9.2635"],"ETH":[2360,"1.0000"],"ROBOTMONEY":[18950,"4235947209"],"BNKR":[8,"25081.3083"],"SP500":[4527,"0.6330"]}},{"d":"Apr 28","aum":62737,"a":{"USDC":[937,"937.6170"],"ZYFAI-SS1":[4507,"1.0000"],"GIZA-SS1":[4508,"1.0000"],"WETH":[21617,"9.4211"],"ETH":[2294,"1.0000"],"ROBOTMONEY":[24315,"4327080369"],"BNKR":[8,"25081.3083"],"SP500":[4552,"0.6330"]}},{"d":"Apr 29","aum":63058,"a":{"USDC":[940,"937.6170"],"ZYFAI-SS1":[4508,"1.0000"],"WETH":[22125,"9.6600"],"ETH":[2290,"1.0000"],"ROBOTMONEY":[28661,"4415883884"],"BNKR":[8,"25081.3083"],"SP500":[4527,"0.6330"]}},{"d":"Apr 30","aum":66989,"a":{"USDC":[933,"937.6170"],"ZYFAI-SS1":[4508,"1.0000"],"WETH":[21964,"9.7565"],"ETH":[2251,"1.0000"],"ROBOTMONEY":[32806,"4445318355"],"BNKR":[8,"25081.3083"],"SP500":[4520,"0.6330"]}},{"d":"May 1","aum":67509,"a":{"USDC":[938,"937.6170"],"ZYFAI-SS1":[4509,"1.0000"],"WETH":[22553,"10.0068"],"ETH":[2254,"1.0000"],"ROBOTMONEY":[32673,"4516352257"],"BNKR":[8,"25081.3083"],"SP500":[4575,"0.6330"]}},{"d":"May 2","aum":72374,"a":{"USDC":[935,"937.6170"],"ZYFAI-SS1":[4509,"1.0000"],"WETH":[23683,"10.3279"],"ETH":[2293,"1.0000"],"ROBOTMONEY":[36368,"4621788005"],"BNKR":[8,"25081.3083"],"SP500":[4579,"0.6330"]}},{"d":"May 3","aum":69842,"a":{"USDC":[934,"937.6170"],"ZYFAI-SS1":[4510,"1.0000"],"WETH":[24398,"10.5030"],"ETH":[2323,"1.0000"],"ROBOTMONEY":[33091,"4677503556"],"BNKR":[8,"25081.3083"],"SP500":[4579,"0.6330"]}},{"d":"May 4","aum":68504,"a":{"USDC":[936,"937.6170"],"ZYFAI-SS1":[4510,"1.0000"],"WETH":[24796,"10.5591"],"ETH":[2348,"1.0000"],"ROBOTMONEY":[31319,"4702732114"],"BNKR":[8,"25081.3083"],"SP500":[4586,"0.6330"]}},{"d":"May 5","aum":84929,"a":{"USDC":[934,"937.6170"],"ZYFAI-SS1":[4511,"1.0000"],"GIZA-SS1":[4511,"1.0000"],"WETH":[26179,"11.0400"],"ETH":[2371,"1.0000"],"ROBOTMONEY":[41835,"4833452580"],"BNKR":[8,"25081.3083"],"SP500":[4580,"0.6330"]}},{"d":"May 6","aum":80896,"a":{"USDC":[941,"937.6170"],"ZYFAI-SS1":[4511,"1.0000"],"GIZA-SS1":[4512,"1.0000"],"WETH":[26245,"11.0400"],"ETH":[2377,"1.0000"],"ROBOTMONEY":[37694,"4833452580"],"BNKR":[8,"25081.3083"],"SP500":[4607,"0.6330"]}},{"d":"May 7","aum":75941,"a":{"USDC":[942,"937.6170"],"ZYFAI-SS1":[4511,"1.0000"],"GIZA-SS1":[4512,"1.0000"],"WETH":[26359,"11.1925"],"ETH":[2355,"1.0000"],"ROBOTMONEY":[32593,"4880899626"],"BNKR":[9,"25081.3083"],"SP500":[4661,"0.6330"]}},{"d":"May 8","aum":72059,"a":{"USDC":[935,"937.6170"],"ZYFAI-SS1":[4512,"1.0000"],"GIZA-SS1":[4513,"1.0000"],"WETH":[25862,"11.3030"],"ETH":[2288,"1.0000"],"ROBOTMONEY":[29302,"4929690686"],"BNKR":[9,"25081.3083"],"SP500":[4639,"0.6330"]}},{"d":"May 9","aum":70065,"a":{"USDC":[942,"937.6170"],"ZYFAI-SS1":[4513,"1.0000"],"GIZA-SS1":[4514,"1.0000"],"WETH":[26324,"11.3761"],"ETH":[2314,"1.0000"],"ROBOTMONEY":[26760,"4958714518"],"BNKR":[9,"25081.3083"],"SP500":[4690,"0.6330"]}},{"d":"May 10","aum":74018,"a":{"USDC":[935,"937.6170"],"ZYFAI-SS1":[4513,"1.0000"],"GIZA-SS1":[4514,"1.0000"],"WETH":[26582,"11.4004"],"ETH":[2332,"1.0000"],"ROBOTMONEY":[30437,"4976914168"],"BNKR":[8,"25081.3083"],"SP500":[4696,"0.6330"]}},{"d":"May 11","aum":80298,"a":{"USDC":[936,"937.6170"],"ZYFAI-SS1":[4514,"1.0000"],"GIZA-SS1":[4514,"1.0000"],"WETH":[27418,"11.5595"],"ETH":[2372,"1.0000"],"ROBOTMONEY":[35862,"5037879449"],"BNKR":[8,"25081.3083"],"SP500":[4674,"0.6330"]}},{"d":"May 12","aum":75710,"a":{"USDC":[936,"937.6170"],"ZYFAI-SS1":[4514,"1.0000"],"GIZA-SS1":[4515,"1.0000"],"WETH":[27417,"11.7069"],"ETH":[2342,"1.0000"],"ROBOTMONEY":[31280,"5077104494"],"BNKR":[8,"25081.3083"],"SP500":[4698,"0.6330"]}},{"d":"May 13","aum":83280,"a":{"USDC":[936,"937.6170"],"ZYFAI-SS1":[4515,"1.0000"],"GIZA-SS1":[4515,"1.0000"],"WETH":[26970,"11.7965"],"ETH":[2286,"1.0000"],"ROBOTMONEY":[39363,"5118258882"],"BNKR":[8,"25081.3083"],"SP500":[4687,"0.6330"]}},{"d":"May 14","aum":98857,"a":{"USDC":[939,"937.6170"],"ZYFAI-SS1":[4515,"1.0000"],"GIZA-SS1":[4516,"1.0000"],"WETH":[27273,"12.0962"],"ETH":[2255,"1.0000"],"ROBOTMONEY":[54623,"5195444294"],"BNKR":[11,"25081.3083"],"SP500":[4724,"0.6330"]}},{"d":"May 15","aum":87653,"a":{"USDC":[935,"937.6170"],"ZYFAI-SS1":[4516,"1.0000"],"GIZA-SS1":[4517,"1.0000"],"WETH":[28545,"12.4253"],"ETH":[2297,"1.0000"],"ROBOTMONEY":[42079,"5260035502"],"BNKR":[10,"25081.3083"],"SP500":[4753,"0.6330"]}},{"d":"May 16","aum":86413,"a":{"USDC":[936,"937.6170"],"ZYFAI-SS1":[4516,"1.0000"],"GIZA-SS1":[4517,"1.0000"],"WETH":[28010,"12.6004"],"ETH":[2223,"1.0000"],"ROBOTMONEY":[41513,"5322426946"],"BNKR":[13,"25081.3083"],"SP500":[4686,"0.6330"]}},{"d":"May 17","aum":87494,"a":{"USDC":[942,"937.6170"],"ZYFAI-SS1":[4517,"1.0000"],"GIZA-SS1":[4517,"1.0000"],"WETH":[27838,"12.7686"],"ETH":[2180,"1.0000"],"ROBOTMONEY":[42804,"5374824765"],"BNKR":[15,"25081.3083"],"SP500":[4681,"0.6330"]}},{"d":"May 18","aum":92384,"a":{"USDC":[941,"937.6170"],"ZYFAI-SS1":[4517,"1.0000"],"GIZA-SS1":[4519,"1.0000"],"WETH":[28674,"13.0865"],"ETH":[2191,"1.0000"],"ROBOTMONEY":[46834,"5469597730"],"BNKR":[16,"25081.3083"],"SP500":[4691,"0.6330"]}},{"d":"May 19","aum":119396,"a":{"USDC":[941,"937.6170"],"ZYFAI-SS1":[4518,"1.0000"],"GIZA-SS1":[4519,"1.0000"],"WETH":[28147,"13.3686"],"ETH":[2105,"1.0000"],"ROBOTMONEY":[74454,"5534884669"],"BNKR":[14,"25081.3083"],"SP500":[4699,"0.6330"]}},{"d":"May 20","aum":95559,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4518,"1.0000"],"GIZA-SS1":[4519,"1.0000"],"WETH":[0,"0.0000"],"ETH":[105,"0.0500"],"ROBOTMONEY":[81744,"5623021605"],"BNKR":[13,"25081.3083"],"SP500":[4660,"0.6330"]}},{"d":"May 21","aum":95383,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4519,"1.0000"],"GIZA-SS1":[4520,"1.0000"],"WETH":[0,"0.0000"],"ETH":[106,"0.0500"],"ROBOTMONEY":[81535,"5623021605"],"BNKR":[14,"25081.3083"],"SP500":[4690,"0.6330"]}},{"d":"May 22","aum":136892,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4520,"1.0000"],"GIZA-SS1":[4520,"1.0000"],"WETH":[0,"0.0000"],"ETH":[106,"0.0500"],"ROBOTMONEY":[123009,"5623021605"],"BNKR":[12,"25081.3083"],"SP500":[4725,"0.6330"]}},{"d":"May 23","aum":114667,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4520,"1.0000"],"GIZA-SS1":[4521,"1.0000"],"WETH":[0,"0.0000"],"ETH":[104,"0.0500"],"ROBOTMONEY":[100782,"5623021605"],"BNKR":[12,"25081.3083"],"SP500":[4728,"0.6330"]}},{"d":"May 24","aum":107451,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4521,"1.0000"],"GIZA-SS1":[4522,"1.0000"],"WETH":[0,"0.0000"],"ETH":[106,"0.0500"],"ROBOTMONEY":[93489,"5623021605"],"BNKR":[13,"25081.3083"],"SP500":[4801,"0.6330"]}},{"d":"May 25","aum":98994,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4521,"1.0000"],"GIZA-SS1":[4523,"1.0000"],"WETH":[0,"0.0000"],"ETH":[104,"0.0500"],"ROBOTMONEY":[85065,"5623021605"],"BNKR":[14,"25081.3083"],"SP500":[4766,"0.6330"]}},{"d":"May 26","aum":82263,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4521,"1.0000"],"GIZA-SS1":[4523,"1.0000"],"WETH":[0,"0.0000"],"ETH":[105,"0.0500"],"ROBOTMONEY":[68328,"5623021605"],"BNKR":[12,"25081.3083"],"SP500":[4773,"0.6330"]}},{"d":"May 27","aum":74789,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4522,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[0,"0.0000"],"ETH":[103,"0.0500"],"ROBOTMONEY":[60862,"5623021605"],"BNKR":[13,"25081.3083"],"SP500":[4764,"0.6330"]}},{"d":"May 28","aum":68011,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4523,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[0,"0.0000"],"ETH":[101,"0.0500"],"ROBOTMONEY":[54076,"5623021605"],"BNKR":[13,"25081.3083"],"SP500":[4774,"0.6330"]}},{"d":"May 29","aum":69361,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4523,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[0,"0.0000"],"ETH":[100,"0.0500"],"ROBOTMONEY":[55404,"5623021605"],"BNKR":[13,"25081.3083"],"SP500":[4797,"0.6330"]}},{"d":"May 30","aum":64668,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4524,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[0,"0.0000"],"ETH":[100,"0.0500"],"ROBOTMONEY":[50705,"5623021605"],"BNKR":[15,"25081.3083"],"SP500":[4800,"0.6330"]}},{"d":"May 31","aum":68541,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4524,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[0,"0.0000"],"ETH":[101,"0.0500"],"ROBOTMONEY":[54565,"5623021605"],"BNKR":[19,"25081.3083"],"SP500":[4807,"0.6330"]}},{"d":"Jun 1","aum":71434,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4525,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[0,"0.0000"],"ETH":[101,"0.0500"],"ROBOTMONEY":[57460,"5623021605"],"BNKR":[16,"25081.3083"],"SP500":[4808,"0.6330"]}},{"d":"Jun 2","aum":83236,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4526,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[9478,"4.7295"],"ETH":[100,"0.0500"],"ROBOTMONEY":[59781,"6305141583"],"BNKR":[16,"25081.3083"],"SP500":[4811,"0.6330"]}},{"d":"Jun 3","aum":74104,"a":{"USDC":[0,"0.0004"],"ZYFAI-SS1":[4526,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[9003,"4.8522"],"ETH":[93,"0.0500"],"ROBOTMONEY":[51124,"6335624373"],"BNKR":[13,"25081.3083"],"SP500":[4820,"0.6330"]}},{"d":"Jun 5","aum":63501,"a":{"USDC":[9068,"9037.4551"],"ZYFAI-SS1":[4527,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[111,"0.0629"],"ETH":[88,"0.0500"],"ROBOTMONEY":[40369,"6355729992"],"BNKR":[15,"25081.3083"],"SP500":[4798,"0.6330"]}},{"d":"Jun 6","aum":64782,"a":{"USDC":[9007,"9037.4551"],"ZYFAI-SS1":[4528,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[214,"0.1344"],"ETH":[80,"0.0500"],"ROBOTMONEY":[41733,"6382109598"],"BNKR":[13,"25081.3083"],"SP500":[4684,"0.6330"]}},{"d":"Jun 7","aum":90396,"a":{"USDC":[9987,"9975.0720"],"ZYFAI-SS1":[4528,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[23424,"15.0658"],"ETH":[78,"0.0500"],"ROBOTMONEY":[43158,"6402003229"],"BNKR":[14,"25081.3083"],"SP500":[4683,"0.6330"]}},{"d":"Jun 8","aum":96815,"a":{"USDC":[10006,"9975.0720"],"ZYFAI-SS1":[4528,"1.0000"],"GIZA-SS1":[4524,"1.0000"],"WETH":[24663,"15.1119"],"ETH":[82,"0.0500"],"ROBOTMONEY":[48334,"6406514796"],"BNKR":[13,"25081.3083"],"SP500":[4665,"0.6330"]}},{"d":"Jun 9","aum":99173,"a":{"USDC":[14463,"14505.3328"],"ZYFAI-SS1":[4529,"1.0000"],"WETH":[25891,"15.1486"],"ETH":[85,"0.0500"],"ROBOTMONEY":[49495,"6413315343"],"BNKR":[13,"25081.3083"],"SP500":[4697,"0.6330"]}},{"d":"Jun 10","aum":89439,"a":{"USDC":[14532,"14505.3328"],"ZYFAI-SS1":[4529,"1.0000"],"WETH":[24878,"15.1796"],"ETH":[82,"0.0500"],"ROBOTMONEY":[40740,"6420314208"],"BNKR":[12,"25081.3083"],"SP500":[4665,"0.6330"]}},{"d":"Jun 11","aum":86785,"a":{"USDC":[14448,"14505.3328"],"ZYFAI-SS1":[4530,"1.0000"],"WETH":[24510,"15.2584"],"ETH":[80,"0.0500"],"ROBOTMONEY":[38611,"6448212319"],"BNKR":[11,"25081.3083"],"SP500":[4595,"0.6330"]}},{"d":"Jun 12","aum":86677,"a":{"USDC":[14442,"14505.3328"],"ZYFAI-SS1":[4530,"1.0000"],"WETH":[25637,"15.3356"],"ETH":[84,"0.0500"],"ROBOTMONEY":[37276,"6469175207"],"BNKR":[11,"25081.3083"],"SP500":[4696,"0.6330"]}},{"d":"Jun 13","aum":85970,"a":{"USDC":[14443,"14505.3328"],"ZYFAI-SS1":[4531,"1.0000"],"WETH":[25515,"15.3686"],"ETH":[83,"0.0500"],"ROBOTMONEY":[36665,"6483871908"],"BNKR":[12,"25081.3083"],"SP500":[4722,"0.6330"]}},{"d":"Jun 14","aum":90861,"a":{"USDC":[14420,"14505.3328"],"ZYFAI-SS1":[4532,"1.0000"],"WETH":[25930,"15.4090"],"ETH":[84,"0.0500"],"ROBOTMONEY":[41163,"6495777062"],"BNKR":[12,"25081.3083"],"SP500":[4721,"0.6330"]}},{"d":"Jun 15","aum":91413,"a":{"USDC":[14550,"14505.3328"],"ZYFAI-SS1":[4532,"1.0000"],"WETH":[26578,"15.4378"],"ETH":[86,"0.0500"],"ROBOTMONEY":[40906,"6499612465"],"BNKR":[12,"25081.3083"],"SP500":[4749,"0.6330"]}},{"d":"Jun 16","aum":89447,"a":{"USDC":[9042,"9037.4050"],"ZYFAI-SS1":[4533,"1.0000"],"WETH":[28030,"15.4378"],"ETH":[91,"0.0500"],"ROBOTMONEY":[42951,"6499612465"],"BNKR":[12,"25081.3083"],"SP500":[4789,"0.6330"]}},{"d":"Jun 17","aum":90765,"a":{"USDC":[9026,"9037.4050"],"ZYFAI-SS1":[4533,"1.0000"],"WETH":[27742,"15.4378"],"ETH":[90,"0.0500"],"ROBOTMONEY":[44594,"6499612465"],"BNKR":[12,"25081.3083"],"SP500":[4767,"0.6330"]}},{"d":"Jun 18","aum":85295,"a":{"USDC":[9021,"9037.4050"],"ZYFAI-SS1":[4534,"1.0000"],"WETH":[26975,"15.4378"],"ETH":[87,"0.0500"],"ROBOTMONEY":[39936,"6499612465"],"BNKR":[12,"25081.3083"],"SP500":[4731,"0.6330"]}},{"d":"Jun 19","aum":83665,"a":{"USDC":[9016,"9037.4050"],"ZYFAI-SS1":[4535,"1.0000"],"WETH":[26426,"15.4378"],"ETH":[86,"0.0500"],"ROBOTMONEY":[38834,"6499612465"],"BNKR":[11,"25081.3083"],"SP500":[4757,"0.6330"]}},{"d":"Jun 20","aum":83772,"a":{"USDC":[9054,"9037.4050"],"ZYFAI-SS1":[4535,"1.0000"],"WETH":[26261,"15.4378"],"ETH":[85,"0.0500"],"ROBOTMONEY":[39088,"6499612465"],"BNKR":[11,"25081.3083"],"SP500":[4737,"0.6330"]}},{"d":"Jun 21","aum":86167,"a":{"USDC":[9072,"9037.4050"],"ZYFAI-SS1":[4536,"1.0000"],"WETH":[26872,"15.4378"],"ETH":[87,"0.0500"],"ROBOTMONEY":[40843,"6499612465"],"BNKR":[12,"25081.3083"],"SP500":[4746,"0.6330"]}},{"d":"Jun 22","aum":82751,"a":{"USDC":[8994,"9037.4050"],"ZYFAI-SS1":[4536,"1.0000"],"WETH":[26454,"15.4378"],"ETH":[86,"0.0500"],"ROBOTMONEY":[37936,"6499612465"],"BNKR":[12,"25081.3083"],"SP500":[4733,"0.6330"]}},{"d":"Jun 23","aum":82890,"a":{"USDC":[9016,"9037.4050"],"ZYFAI-SS1":[4537,"1.0000"],"WETH":[26553,"15.4378"],"ETH":[86,"0.0500"],"ROBOTMONEY":[37959,"6499612465"],"BNKR":[11,"25081.3083"],"SP500":[4727,"0.6330"]}},{"d":"Jun 24","aum":80120,"a":{"USDC":[8995,"9037.4050"],"ZYFAI-SS1":[4537,"1.0000"],"WETH":[25682,"15.4378"],"ETH":[83,"0.0500"],"ROBOTMONEY":[36143,"6499612465"],"BNKR":[11,"25081.3083"],"SP500":[4669,"0.6330"]}},{"d":"Jun 25","aum":75101,"a":{"USDC":[9042,"9037.4050"],"ZYFAI-SS1":[4538,"1.0000"],"WETH":[24916,"15.4378"],"ETH":[81,"0.0500"],"ROBOTMONEY":[31831,"6499612465"],"BNKR":[10,"25081.3083"],"SP500":[4683,"0.6330"]}},{"d":"Jun 26","aum":73180,"a":{"USDC":[9052,"9037.4050"],"ZYFAI-SS1":[4538,"1.0000"],"WETH":[24194,"15.4378"],"ETH":[78,"0.0500"],"ROBOTMONEY":[30652,"6499612465"],"BNKR":[9,"25081.3083"],"SP500":[4656,"0.6330"]}}],
    init() { this.$nextTick(() => this.draw()); },
    // Collapsed = last 5 snapshots; "Show All" expands to all 99.
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

  // ── Tokenomics fee distribution (pie) ─────────────────────────────────────
  // Static Chart.js pie matching the original FeePieChart. The custom legend
  // below the chart stays in the markup, so the chart's own legend is off.
  Alpine.data("feeChart", () => ({
    _chart: null,
    init() { this.$nextTick(() => this.draw()); },
    draw() {
      const canvas = this.$refs.fee;
      if (!canvas || !window.Chart) return;
      this._chart?.destroy();
      this._chart = new window.Chart(canvas, {
        type: "pie",
        data: {
          labels: ["Protocol (57%)", "Bankr (40%)", "Clanker (3%)"],
          datasets: [{ data: [57, 40, 3], backgroundColor: [SERIES.emerald, SERIES.amber, PALETTE.purple], borderColor: PALETTE.deep, borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } },
      });
    },
    destroy() { this._chart?.destroy(); this._chart = null; },
  }));

  // ── Asset Allocation ───────────────────────────────────────────────────────
  // Strategy/bucket/wallet pies are static Chart.js pies baked from the
  // allocation spec (reconciled against public/data snapshots) — unchanged,
  // out of scope for issue #40. The vault economics section (hero Total AUM,
  // 7-Day APY, vault pie, holdings table, Total Vault Assets) is LIVE: fetched
  // from GET /api/dashboards/vault-economics on init, then the pies are
  // (re)drawn once the fetch settles so the vault pie reflects real per-adapter
  // balances. The three BIG pies (strategy, vault, wallet) render % datalabels
  // via a small inline plugin; the four MINI bucket pies render none.
  Alpine.data("allocationView", () => ({
    _charts: [],
    economics: null,
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
      try {
        this.economics = await api.get(ROUTES.dashboards.vaultEconomics);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
        this.destroy();
        this.$nextTick(() => this.draw());
      }
    },
    fmtUsd(v) {
      if (v == null) return "—";
      const n = Number(v);
      return "$" + n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1000 ? 2 : 0 });
    },
    fmtPct(v) { return v == null ? "—" : (Number(v) * 100).toFixed(2) + "%"; },
    // Per-adapter Value cell (issue #50): an adapter still at its placeholder
    // address is reported configured:false with balanceUsd:null by the API —
    // render an explicit unconfigured state, never a live-looking $0 / dash.
    adapterValue(a) {
      return a && a.configured === false ? "Not configured" : this.fmtUsd(a?.balanceUsd);
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
      // Big strategy pie — 95% conservative, 5% agent, protocol/RWA at 0.
      this._pie("strategy",
        ["Conservative DeFi Yield", "Agent Tokens", "Protocol Tokens", "Real World Assets"],
        [95, 5, 0, 0], ["#10b981", "#3b82f6", "#f59e0b", "#a855f7"], true);
      // Mini bucket pies (no datalabels).
      this._pie("mini1", ["Aave", "Morpho", "Compound", "Sky"],
        [25, 25, 25, 25], ["#047857", "#059669", "#10b981", "#34d399"], false);
      this._pie("mini2", ["RobotMoney", "Juno", "Woon", "Peaq", "Zyfai", "Giza", "DEUS"],
        [14.29, 14.29, 14.29, 14.29, 14.29, 14.28, 14.27],
        ["#1e3a8a", "#1e40af", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe"], false);
      this._pie("mini3", ["BTC", "ETH", "HYPE"],
        [33.33, 33.33, 33.34], ["#b45309", "#d97706", "#f59e0b"], false);
      this._pie("mini4", ["SPY", "Gold"], [50, 50], ["#7c3aed", "#a855f7"], false);
      // Vault pie — three adapter slices from the live vault-economics fetch
      // (issue #40). Before the fetch resolves, or when it degrades to
      // stale/null balances, falls back to an equal-thirds placeholder rather
      // than a fabricated split.
      const adapters = this.economics?.adapters ?? [];
      const hasLiveBalances = adapters.length === 3 && adapters.some((a) => a.balanceUsd != null && a.balanceUsd > 0);
      const vaultLabels = adapters.length === 3 ? adapters.map((a) => a.name.toUpperCase()) : ["MORPHO", "AAVE", "COMPOUND"];
      const vaultValues = hasLiveBalances ? adapters.map((a) => Math.max(0, Number(a.balanceUsd) || 0)) : [1, 1, 1];
      this._pie("vault", vaultLabels, vaultValues, ["#10b981", "#10b981", "#10b981"], true);
      // Wallet pie — USD value per asset, colour-grouped.
      this._pie("wallet",
        ["USDC", "ZYFAI-SS1", "ROBOTMONEY", "BNKR", "WETH", "ETH", "SP500"],
        [9022.48, 4538.49, 29299.87, 9.45, 23940.33, 77.48, 4638.10],
        ["#10b981", "#10b981", "#3b82f6", "#3b82f6", "#f59e0b", "#f59e0b", "#8b5cf6"], true);
    },
    destroy() { this._charts.forEach((c) => c.destroy()); this._charts = []; },
  }));

  // ── Investment Committee ──────────────────────────────────────────────────
  Alpine.data("committeeView", () => ({
    loading: true,
    error: null,
    session: null,
    takes: [],
    aggregate: null,
    async load() {
      try {
        const { sessions } = await api.get(ROUTES.committee.sessions);
        const published = (sessions || []).filter((s) => s.state === "published");
        const pick = published[0] ?? (sessions || [])[0];
        if (!pick) { this.loading = false; return; }
        const detail = await api.get(path(ROUTES.committee.session, { date: pick.date, subject: pick.subjectId }));
        this.session = detail.session;
        this.takes = detail.takes || [];
        this.aggregate = detail.session?.committeeRecommendation ?? null;
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    stanceClass(s) { return `stance stance--${s}`; },
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
