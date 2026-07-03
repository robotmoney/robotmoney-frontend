// Alpine.data factories for the data-driven views (regime + committee). They
// fetch the API through app/lib/api.js (HTTP-only boundary) and expose plain
// state the HTML renders with x-for/x-text. No build, no Web Components.
import { api, ROUTES, path } from "../lib/api.js";

// ── Shared regime-dashboard chart helpers ───────────────────────────────────
// Background regime bands painted behind the line datasets, matching the
// original RegimeDashboard: risk-off amber @10%, risk-on cyan @8%, neutral bare.
const REGIME_BAND = { risk_off: "rgba(232,166,64,0.10)", risk_on: "rgba(0,229,255,0.08)", neutral: null };
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
  composite: { label: "Composite", color: "#00e5ff" },
  macro: { label: "Macro", color: "#e8a640" },
  onchain: { label: "On-chain", color: "#5fb3a1" },
  factor: { label: "Equity factor", color: "#a374e0" },
  macro_inverted: { label: "Macro inv.", color: "#ff6b6b" },
  conservative: { label: "Conservative", color: "#9cffd2" },
  aggressive: { label: "Aggressive", color: "#ffcf80" },
  eth_hodl: { label: "ETH HODL", color: "#a374e0", baseline: true },
  sp500_hodl: { label: "SP500 HODL", color: "#a374e0", baseline: true },
  blend_hodl: { label: "50/50 HODL", color: "#a374e0", baseline: true },
  stables_only: { label: "Stables", color: "#7e889e", baseline: true },
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
const ASSET_COLOR = { cash: "#7e889e", eth: "#a374e0", sp500: "#5fb3a1" };
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
  { label: "risk-off", color: "rgba(232,166,64,0.50)" },
  { label: "neutral", color: "rgba(126,136,158,0.15)" },
  { label: "risk-on", color: "rgba(0,229,255,0.40)" },
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
    regimeColor(r) { return r === "risk_off" ? "#ff6644" : r === "risk_on" ? "#00e5ff" : "#7e889e"; },
    regimeCardStyle(r) { const c = this.regimeColor(r); return `border-color:${c};background:${this._alpha(c, 0.1)}`; },
    _alpha(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; },
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
    signedColor(v) { return v == null ? "#4a5268" : v >= 0.5 ? "#00e5ff" : "#ff6644"; },

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
      const stroke = last >= 0.5 ? "#00e5ff" : "#ff6644";
      const pts = []; let lastX = pad, lastY = yAt(0.5);
      vals.forEach((v, i) => { if (typeof v === "number" && isFinite(v)) { const px = xAt(i), py = yAt(v); pts.push(px.toFixed(1) + "," + py.toFixed(1)); lastX = px; lastY = py; } });
      const mid = yAt(0.5).toFixed(1);
      return '<svg class="rv__spark-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
        + '<line x1="' + pad + '" y1="' + mid + '" x2="' + (W - pad) + '" y2="' + mid + '" stroke="#222a38" stroke-width="0.5" stroke-dasharray="2 2"/>'
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
    rhoColor(cell) { if (!cell || cell.rho == null) return "#4a5268"; const r = cell.rho; if (Math.abs(r) < 0.15) return "#7e889e"; return r > 0 ? "#00e5ff" : "#ff6644"; },
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
    ddColor(v) { return v == null ? "#4a5268" : v < -0.5 ? "#ff6644" : "#7e889e"; },
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
        line("Composite", this.history.map((h) => h.composite), "#00e5ff", { fill: true, bg: "rgba(0,229,255,0.10)", bw: 2 }),
        line("Macro", this.history.map((h) => this._idx(h, "macro")), "#7e889e"),
        line("On-chain", this.history.map((h) => this._idx(h, "onchain")), "#e8a640"),
      ];
      const hasFactor = this.history.some((h) => this._idx(h, "factor") != null);
      if (hasFactor) ds.push(line("Equity factor", this.history.map((h) => this._idx(h, "factor")), "#a374e0"));
      const extras = this.latest?.extras || {};
      const showSpx = this.visible.spx && (extras.spx || []).length > 0;
      const showEth = this.visible.eth && (extras.eth || []).length > 0;
      if (showSpx) ds.push(line("S&P 500", alignToDates(extras.spx, labels), "#5fb3a1", { axis: "yPrice" }));
      if (showEth) ds.push(line("ETH", alignToDates(extras.eth, labels), "#a374e0", { axis: "yPrice" }));
      const chart = new window.Chart(canvas, {
        type: "line",
        data: { labels, datasets: ds },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            regimeBands: { enabled: this.visible.bands, regimes: this.history.map((h) => h.regime ?? null) },
            legend: { position: "bottom", labels: { color: "#7e889e", font: { family: "JetBrains Mono", size: 10 } } },
            tooltip: { backgroundColor: "rgba(11,14,20,0.95)", borderColor: "#222a38", borderWidth: 1, titleColor: "#e2e4ec", bodyColor: "#e2e4ec" },
          },
          scales: {
            x: { ticks: { color: "#4a5268", font: { family: "JetBrains Mono", size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: "rgba(34,42,56,0.4)" } },
            y: { min: 0, max: 1, ticks: { color: "#4a5268", font: { family: "JetBrains Mono", size: 10 }, stepSize: 0.25 }, grid: { color: "rgba(34,42,56,0.4)" } },
            yPrice: { type: "logarithmic", display: !!(showSpx || showEth), position: "right", ticks: { color: "#4a5268", font: { family: "JetBrains Mono", size: 10 } }, grid: { drawOnChartArea: false } },
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
              legend: { position: "bottom", labels: { color: "#7e889e", font: { family: "JetBrains Mono", size: 10 } } },
              tooltip: { backgroundColor: "rgba(11,14,20,0.95)", borderColor: "#222a38", borderWidth: 1, titleColor: "#e2e4ec", bodyColor: "#e2e4ec", callbacks: { label: (ctx) => ctx.dataset.label + ": " + (+ctx.parsed.y).toFixed(2) + "×" } },
            },
            scales: {
              x: { ticks: { color: "#4a5268", font: { family: "JetBrains Mono", size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: "rgba(34,42,56,0.4)" } },
              y: { type: "logarithmic", ticks: { color: "#4a5268", font: { family: "JetBrains Mono", size: 10 }, callback: (v) => (+v).toFixed(v < 10 ? 1 : 0) + "×" }, grid: { color: "rgba(34,42,56,0.4)" } },
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
            datasets: [{ data: pts.map((p) => p.value), borderColor: "#4488ff", borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false }],
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { ticks: { color: "#4a5268", maxTicksLimit: 3 }, grid: { color: "rgba(255,255,255,0.05)" } } },
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
            borderColor: "#4488ff", backgroundColor: "rgba(68,136,255,0.12)", fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: { grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#7e889e" } },
            x: { grid: { display: false }, ticks: { color: "#4a5268", maxTicksLimit: 8 } } },
          plugins: { legend: { labels: { color: "#7e889e" } } },
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
  // Static baked series (approximated from the unified-wallet-history snapshots,
  // the same numbers the CSS bars used) drawn as Chart.js stacked areas to match
  // the original. No fetch; draws once on init. Stacks bottom→top:
  // Stable, Protocol, Agent, Stocks.
  Alpine.data("walletPerfView", () => ({
    _charts: [],
    labels: ["Mar 18", "Mar 28", "Apr 17", "Apr 27", "May 17", "Jun 7", "Jun 17", "Jun 26"],
    aumSeries: [
      { label: "Stable (USDC, ZYFAI-SS1)", color: "#10b981", data: [0, 6460, 10020, 8720, 13080, 14530, 16340, 13970] },
      { label: "Protocol (WETH, ETH)", color: "#e8a640", data: [21790, 22240, 27570, 20340, 27890, 29960, 29960, 24270] },
      { label: "Agent (ROBOTMONEY, BNKR)", color: "#4488ff", data: [50850, 43040, 45950, 29060, 41840, 40860, 39040, 30890] },
      { label: "Stocks (SP500)", color: "#8b5cf6", data: [0, 0, 0, 0, 4360, 5450, 5450, 4410] },
    ],
    pctSeries: [
      { label: "Stable (USDC, ZYFAI-SS1)", color: "#10b981", data: [0, 9, 12, 15, 15, 16, 18, 19] },
      { label: "Protocol (WETH, ETH)", color: "#e8a640", data: [30, 31, 33, 35, 32, 33, 33, 33] },
      { label: "Agent (ROBOTMONEY, BNKR)", color: "#4488ff", data: [70, 60, 55, 50, 48, 45, 43, 42] },
      { label: "Stocks (SP500)", color: "#8b5cf6", data: [0, 0, 0, 0, 5, 6, 6, 6] },
    ],
    init() { this.$nextTick(() => this.draw()); },
    _rgba(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    },
    _chart(canvas, series, max, tick) {
      if (!canvas || !window.Chart) return;
      const instance = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: this.labels,
          datasets: series.map((s) => ({
            label: s.label, data: s.data, borderColor: s.color,
            backgroundColor: this._rgba(s.color, 0.45),
            fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          scales: {
            y: { stacked: true, beginAtZero: true, max, grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#7e889e", callback: tick } },
            x: { grid: { display: false }, ticks: { color: "#4a5268", maxTicksLimit: 8 } },
          },
          plugins: { legend: { display: false } },
        },
      });
      this._charts.push(instance);
    },
    draw() {
      this._chart(this.$refs.aum, this.aumSeries, 91000, (v) => "$" + Math.round(v / 1000) + "k");
      this._chart(this.$refs.alloc, this.pctSeries, 100, (v) => v + "%");
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
          datasets: [{ data: [57, 40, 3], backgroundColor: ["#10b981", "#f59e0b", "#8b5cf6"], borderColor: "#0a0a0f", borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } },
      });
    },
    destroy() { this._chart?.destroy(); this._chart = null; },
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
