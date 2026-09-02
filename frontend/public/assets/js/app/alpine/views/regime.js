// Alpine factory for the /regime classification dashboard. Moved verbatim
// from the monolithic views.js (finding 025); its chart/data helper tables
// live in ./shared.js.
import { api, ROUTES } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";
import { PALETTE, SERIES, MONO_FONT, rgba, monoAxis } from "../../lib/chart-theme.js";
import {
  regimeBandsPlugin,
  alignToDates,
  STRATEGY_STYLE,
  BASELINE_KEYS,
  BACKTESTS,
  ASSET_COLOR,
  ASSET_LABEL,
  FWD_COLS,
  CON_COLS,
  CORR_ROWS,
  SOURCE_LABEL,
  REGIME_BG_LEGEND,
} from "./shared.js";

export function registerRegimeView(Alpine) {
  // ── Regime classification ────────────────────────────────────────────────
  Alpine.data("regimeView", () => ({
    _charts: {},
    loading: true,
    error: null,
    latest: null,
    history: [],
    // Freshness of the served snapshot (backend computes it). When `stale`, the
    // analytics pipeline isn't refreshing in this deployment and the charts below
    // are frozen — surfaced as a loud banner rather than served silently.
    staleness: null,
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
        this.staleness = data.staleness || null;
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

    // ── freshness ─────────────────────────────────────────────────────────────
    isStale() { return !!(this.staleness && this.staleness.stale); },
    staleMessage() {
      const s = this.staleness;
      if (!s) return "";
      if (s.ageDays == null || s.asof == null) return "No regime data is available — the analytics pipeline has not produced any snapshots in this deployment.";
      return `Regime data is ${s.ageDays} day${s.ageDays === 1 ? "" : "s"} stale (latest ${s.asof}). The analytics pipeline is not refreshing in this deployment — the charts below are frozen and may not reflect current market data.`;
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
    // Row-level provenance badge label (issue #397): which AnalyticsDataSource
    // wrote the served snapshot — distinct from sourceLabel() above, which
    // labels a PER-INDICATOR upstream vendor (FRED/Yahoo/…). `latest.source`
    // is `null`/undefined on every pre-migration row (honestly unlabeled), so
    // the badge is hidden entirely rather than guessing "live".
    provenanceLabel(s) {
      return { live: "Live data", hermetic: "Demo data (hermetic)", fixture: "Test fixture data", seed: "Reference snapshot (seed)" }[s] || s;
    },
    // The panel-table row tooltip. It used to be the sign convention and
    // NOTHING else — every row explained percentile flipping and no row said
    // what the indicator was, which is the one thing a reader hovering an
    // unfamiliar name wants. The prose has always existed on the analytics
    // indicator universe as `description`; it just was not serialised into the
    // snapshot payload until now. Snapshots persisted before that carry no
    // description and are never rewritten, so the sign-only text stays as the
    // fallback rather than leaving those rows with an empty bubble.
    indicatorTooltip(ind) {
      if (!ind || !ind.description) return this.signTooltip(ind?.sign, ind?.name ?? "this indicator");
      return `${ind.description} ${this.signClause(ind.sign)}`;
    },
    // An indicator name, split so the info glyph cannot be orphaned on a line
    // of its own. CSS puts a soft wrap opportunity on both sides of an atomic
    // inline (which the glyph is) whatever characters sit next to it — a word
    // joiner does not close it, and `white-space: nowrap` on the link would
    // stop the name wrapping at all, in a 110px column. So everything up to the
    // last space wraps normally, and the last word rides with the glyph in a
    // nowrap box. Head keeps its trailing space; a one-word name has no head.
    nameHead(name) { const s = String(name ?? ""); const i = s.lastIndexOf(" "); return i < 0 ? "" : s.slice(0, i + 1); },
    nameTail(name) { const s = String(name ?? ""); const i = s.lastIndexOf(" "); return i < 0 ? s : s.slice(i + 1); },
    // Orientation in one clause. The full account of what sign-aligning does
    // belongs to the "Risk-on" column header tip, where it is read once,
    // instead of being restated in all 26 rows.
    signClause(sign) {
      return sign == null || sign >= 0
        ? "Sign +1: a rising value reads as risk-on."
        : "Sign −1: a rising value reads as risk-off, so its rank is flipped.";
    },
    // Fallback for pre-`description` snapshots (see indicatorTooltip).
    signTooltip(sign, name) {
      if (sign == null || sign >= 0) {
        return `Sign +1 — rising ${name} reads as risk-on, so the percentile is used as-is. The "Risk-on" column has the same orientation — high = risk-on — across every indicator.`;
      }
      return `Sign −1 — rising ${name} reads as risk-off, so we flip the percentile (1 − pctile) before averaging. That keeps the "Risk-on" column oriented high = risk-on across every indicator.`;
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
      // issue #449: this is the one view with a trillion tier (macro-scale
      // indicators), no K tier at all (anything below $1M falls to the
      // rounded/comma-grouped base case), and that base case is rounded
      // instead of toFixed(2) — preserved via {trillion, skipKTier,
      // baseInteger} rather than silently dropped in the consolidation.
      if (u === "usd") return fmtUsdCompact(v, { trillion: true, skipKTier: true, baseInteger: true });
      return v.toFixed(2);
    },
    fmtSigned(v) { return v == null ? "—" : Math.round(v * 100).toString(); },
    signedColor(v) { return v == null ? PALETTE.textMuted : v >= 0.5 ? PALETTE.accent : PALETTE.warn; },

    // Inline-SVG sparkline (percentiles in [0,1]); stroke cyan when the last
    // point is risk-on (>=0.5), amber otherwise. Mid-line reference at 0.5.
    sparklineSvg(values) {
      const vals = Array.isArray(values) ? values : [];
      const finite = vals.filter((v) => typeof v === "number" && isFinite(v));
      if (finite.length < 2) return '<span class="rv__spark-empty">—</span>';
      // 68 rather than 80: the sparkline column is the only fixed width in a
      // panel table, and the table has to fit its card at three across (see the
      // fit assertion in regime-visual.spec.ts). 24 monthly points still read
      // at 2.8px apart, and the column stopped being the reason the Weight
      // column had nowhere to go.
      const W = 68, H = 22, pad = 1, n = vals.length;
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
    rhoColor(cell) { if (!cell || cell.rho == null) return PALETTE.textMuted; const r = cell.rho; if (Math.abs(r) < 0.15) return PALETTE.textMuted; return r > 0 ? PALETTE.accent : PALETTE.warn; },
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
    ddColor(v) { return v == null ? PALETTE.textMuted : v < -0.5 ? PALETTE.warn : PALETTE.textMuted; },
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
    // issue #624: `history` is one array slot per PERSISTED date — Chart.js's
    // (default) category x-axis spaces slots by ARRAY INDEX, not elapsed time,
    // so a gap between two adjacent persisted rows would draw compressed to an
    // ordinary-width step instead of a real time gap (the same defect
    // wallet-perf.js's AUM chart had — see _denseCalendarDays there). Currently
    // latent (the analytics pipeline recomputes + upserts the full history
    // every run, so `history` never actually has a hole today), but the chart
    // itself shouldn't rely on that backend guarantee to stay honest.
    // Synthesizing one slot per CALENDAR day between the first and last
    // persisted date — gap days included — keeps the x-axis proportional to
    // elapsed time regardless.
    _denseCalendarDays(history) {
      if (history.length === 0) return [];
      const days = [];
      const start = new Date(history[0].date + "T00:00:00Z");
      const end = new Date(history[history.length - 1].date + "T00:00:00Z");
      for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      return days;
    },

    drawHistory() {
      const canvas = this.$refs.chart;
      if (!canvas || !window.Chart || !this.history.length) return;
      const labels = this._denseCalendarDays(this.history);
      const byDate = new Map(this.history.map((h) => [h.date, h]));
      const val = (fn) => labels.map((d) => { const h = byDate.get(d); return h ? fn(h) : null; });
      // spanGaps:false is Chart.js's own default, set explicitly (issue #624,
      // mirroring wallet-perf.js) so a `null` gap day breaks the line instead
      // of ever silently interpolating across it.
      const line = (label, data, color, o = {}) => ({ label, data, borderColor: color, backgroundColor: o.bg || "transparent", fill: !!o.fill, tension: 0.2, pointRadius: 0, borderWidth: o.bw || 1.25, yAxisID: o.axis || "y", spanGaps: false });
      const ds = [
        line("Composite", val((h) => h.composite), PALETTE.accent, { fill: true, bg: rgba(PALETTE.accent, 0.1), bw: 2 }),
        line("Macro", val((h) => this._idx(h, "macro")), PALETTE.textMuted),
        line("On-chain", val((h) => this._idx(h, "onchain")), PALETTE.warm),
      ];
      const hasFactor = this.history.some((h) => this._idx(h, "factor") != null);
      if (hasFactor) ds.push(line("Equity factor", val((h) => this._idx(h, "factor")), SERIES.emerald));
      const extras = this.latest?.extras || {};
      const showSpx = this.visible.spx && (extras.spx || []).length > 0;
      const showEth = this.visible.eth && (extras.eth || []).length > 0;
      if (showSpx) ds.push(line("S&P 500", alignToDates(extras.spx, labels), SERIES.teal, { axis: "yPrice" }));
      if (showEth) ds.push(line("ETH", alignToDates(extras.eth, labels), SERIES.mint, { axis: "yPrice" }));
      const chart = new window.Chart(canvas, {
        type: "line",
        data: { labels, datasets: ds },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            regimeBands: { enabled: this.visible.bands, regimes: val((h) => h.regime ?? null) },
            legend: { position: "bottom", labels: { color: PALETTE.textMuted, font: MONO_FONT } },
            tooltip: { backgroundColor: rgba(PALETTE.deep, 0.95), borderColor: PALETTE.border, borderWidth: 1, titleColor: PALETTE.text, bodyColor: PALETTE.text },
          },
          scales: {
            x: monoAxis({ ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }),
            y: { min: 0, max: 1, ...monoAxis({ ticks: { stepSize: 0.25 } }) },
            yPrice: { type: "logarithmic", display: !!(showSpx || showEth), position: "right", ticks: { color: PALETTE.textMuted, font: MONO_FONT }, grid: { drawOnChartArea: false } },
          },
        },
        plugins: [regimeBandsPlugin],
      });
      this._setChart("history", chart);
    },

    drawBacktests() {
      if (!this.latest?.backtest || !window.Chart || !this.$root) return;
      const labels = this._denseCalendarDays(this.history);
      const byDate = new Map(this.history.map((h) => [h.date, h]));
      const regimes = labels.map((d) => byDate.get(d)?.regime ?? null);
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
          ds.push({ label: style.label, data: alignToDates(s.equity_curve, labels), borderColor: style.color, borderWidth: style.baseline ? 1 : 1.5, borderDash: style.baseline ? (style.dash || [4, 3]) : undefined, pointRadius: 0, tension: 0.2, fill: false, spanGaps: true });
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
}
