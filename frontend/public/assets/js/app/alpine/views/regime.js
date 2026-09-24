// Alpine factory for the /regime classification dashboard. Moved verbatim
// from the monolithic views.js (finding 025); its chart/data helper tables
// live in ./shared.js.
import { api, ROUTES } from "../../lib/api.js";
import { scrollToFragment } from "../../router.js";
import { fmtUsdCompact } from "../lib/dash-format.js";
import { PALETTE, MONO_FONT, REGIME, rgba, monoAxis } from "../../lib/chart-theme.js";
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

// A figure as the site prints one: a true minus sign, a plus only where asked,
// and no sign at all on a value that rounds to zero ("-0.0%" read as a loss).
function signedFig(n, digits, suffix, plus) {
  const s = Math.abs(n).toFixed(digits);
  if (Number(s) === 0) return s + suffix;
  return (n < 0 ? "\u2212" : plus ? "+" : "") + s + suffix;
}

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
        // `latest.backtest` (~126 KB) is off by default on the backend
        // (issue #866b) — this page is the one place that reads it, so ask
        // for it explicitly rather than falling back to a blank panel.
        const data = await api.get(ROUTES.dashboards.regimeSnapshots, { range: 4000, include: "backtest" });
        this.latest = data.latest;
        this.history = data.history || [];
        this.staleness = data.staleness || null;
        this.loading = false;
        // #composite and #panel-<key> exist only now: a session page links
        // its market context rows to them.
        this.$nextTick(() => { this.drawHistory(); this.drawBacktests(); scrollToFragment(); });
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
    // Stale data is flagged over the charts it froze. No snapshot at all is
    // not stale data: the empty chart in the dashboard's place says it.
    isStale() { return !!(this.staleness && this.staleness.stale && this.staleness.asof != null); },
    staleMessage() {
      const s = this.staleness;
      if (!s || s.ageDays == null || s.asof == null) return "";
      return `Latest reading ${s.asof}, ${s.ageDays} day${s.ageDays === 1 ? "" : "s"} old.`;
    },

    // ── formatting ──────────────────────────────────────────────────────────
    posPct(x) { return x == null ? 0 : Math.max(0, Math.min(1, x)) * 100; },
    // A 0-1 percentile as an ordinal, "91st". Appending "th" to the integer
    // printed "91th", "92th" and "93th".
    ordinalPct(x) {
      if (x == null || !isFinite(x)) return "—";
      const n = Math.round(x * 100);
      const rem100 = n % 100;
      if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
      return `${n}${({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"}`;
    },
    fmtWeight(w) { return w == null ? "—" : (w * 100).toFixed(1) + "%"; },
    regimeLabel(r) { return r == null ? "—" : ({ risk_off: "Risk-off", neutral: "Neutral", risk_on: "Risk-on" }[r] || String(r).replace(/_/g, "-")); },
    // One regime palette, the session page's: green risk-on, slate neutral,
    // beacon risk-off. It marks a reading as a small round dot or a line,
    // never as type or a filled area, so the regime card's label stays in the
    // text colour beside its dot.
    regimeColor(r) { return REGIME[String(r || "").replace(/-/g, "_")] || REGIME.neutral; },
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
        return `Sign +1: a rising ${name} reads as risk-on, so its percentile is used as is. A high reading means risk-on for every indicator.`;
      }
      return `Sign −1: a rising ${name} reads as risk-off, so its percentile is flipped (1 − percentile) before averaging. A high reading means risk-on for every indicator.`;
    },
    // Component methodology footer: bucket thresholds as integer percentiles.
    // The live snapshot can carry no thresholds (bucketThresholds null), which
    // printed a placeholder dash into the sentence. The method buckets at
    // 0.33 / 0.67, the value every snapshot that does carry them holds.
    bucketPct(key) {
      const t = this.latest?.bucketThresholds;
      const v = t && t[key] != null ? t[key] : ({ risk_off: 0.33, risk_on: 0.67 })[key];
      return v == null ? "—" : (v * 100).toFixed(0);
    },

    // Last visible value (transformed for change series), formatted by unit.
    fmtLast(ind) {
      const t = ind.transform;
      const v = (t === "change30" || t === "change90") ? ind.transformed_value : ind.raw_value;
      if (v == null) return "—";
      const u = ind.unit;
      if (u === "percent") return v.toFixed(2) + "%";
      if (u === "percent_change") return signedFig(v * 100, 1, "%", true);
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
    // The reading a sign-aligned percentile gives, at the method's own cuts
    // (0.33 / 0.67, see bucketPct) rather than at 0.5, which read 44 as
    // risk-off. It colours the sparkline, a line; the figure beside it stays
    // in the text colour.
    signedColor(v) {
      if (v == null || !isFinite(v)) return PALETTE.textMuted;
      const lo = +this.bucketPct("risk_off") / 100, hi = +this.bucketPct("risk_on") / 100;
      return v > hi ? REGIME.risk_on : v < lo ? REGIME.risk_off : REGIME.neutral;
    },

    // Inline-SVG sparkline (percentiles in [0,1]), stroked in the reading its
    // last point gives (signedColor). Mid-line reference at 0.5.
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
      const stroke = this.signedColor(last);
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
    rhoText(cell) { if (!cell || cell.rho == null) return "—"; return signedFig(cell.rho, 2, "", true); },
    // A correlation is a figure, not a regime reading, so it takes no regime
    // hue: the sign glyph leads, a meaningful |ρ| is in the text colour and one
    // under 0.15 recedes to muted. It used to paint 21 figures cyan.
    rhoColor(cell) { if (!cell || cell.rho == null) return PALETTE.textMuted; return Math.abs(cell.rho) < 0.15 ? PALETTE.textMuted : PALETTE.text; },
    rhoTitle(cell) { return cell && cell.n != null ? "n = " + cell.n + " paired observations" : ""; },
    // The span the correlations are measured over, from the history's first
    // and last dates. n / 252 treated a count of calendar days as trading days
    // and printed "~12.1y" over 8.4 years of data.
    corrSampleMeta() {
      const h = this.history;
      let days = 0;
      if (h.length >= 2) {
        days = (Date.parse(h[h.length - 1].date + "T00:00:00Z") - Date.parse(h[0].date + "T00:00:00Z")) / 86_400_000;
      } else {
        const c = this.latest?.correlations;
        days = c?.forward?.composite?.spx_30d?.n ?? c?.concurrent?.composite?.spx?.n ?? 0;
      }
      if (!isFinite(days) || days <= 0) return "Spearman ρ";
      const trailing = days >= 365 ? "~" + (days / 365.25).toFixed(1) + "y" : "~" + Math.max(1, Math.round(days / 30.44)) + "mo";
      return "Spearman ρ · trailing " + trailing;
    },

    // ── backtests ───────────────────────────────────────────────────────────
    backtests() { return BACKTESTS; },
    hasBacktest(key) { const s = this.latest?.backtest?.[key]; return !!s && Object.keys(s).length > 0; },
    backtestRows(bt) {
      const data = this.latest?.backtest?.[bt.key] || {};
      return bt.strategies.filter(([k]) => data[k]).map(([k, label, desc]) => ({ key: k, label, desc, s: data[k], baseline: BASELINE_KEYS.has(k) }));
    },
    // The strategies whose equity curve the chart can draw, in table order.
    // drawBacktests() and the card's empty state both read this, so the chart
    // and the line saying it has nothing to draw cannot disagree.
    _curveKeys(key) {
      const strategies = this.latest?.backtest?.[key];
      if (!strategies) return [];
      const bt = BACKTESTS.find((b) => b.key === key);
      const order = bt ? bt.strategies.map(([k]) => k) : Object.keys(strategies);
      return order.filter((sk) => STRATEGY_STYLE[sk] && Array.isArray(strategies[sk]?.equity_curve) && strategies[sk].equity_curve.length);
    },
    // An equity chart plots its curves against the history's dates, so it is
    // empty when the history chart is, and when no strategy carries a curve.
    // Null when there is something to draw.
    btEmptyTitle(key) {
      if (!this._curveKeys(key).length) return "No data yet";
      return this.historyEmpty() ? this.historyEmptyTitle() : null;
    },
    btEmptyDetail(key) { return this._curveKeys(key).length ? this.historyEmptyDetail() : ""; },
    fmtNum2(v) { return v == null ? "—" : (+v).toFixed(2); },
    fmtPctSigned(v) { return v == null ? "—" : signedFig(v * 100, 1, "%", true); },
    fmtPctUnsigned(v) { return v == null ? "—" : signedFig(v * 100, 1, "%", false); },
    ddColor(v) { return v == null ? PALETTE.textMuted : v < -0.5 ? PALETTE.warn : PALETTE.textMuted; },
    tradesText(row) { return row.baseline ? "—" : (row.s.transitions ?? "—"); },
    describeWeights(w) { return Object.keys(ASSET_COLOR).filter((a) => w[a]).map((a) => Math.round(w[a] * 100) + "% " + ASSET_LABEL[a]).join(" / "); },
    // Allocation pie glyph (inline SVG) for a per-regime weight map.
    statePie(w) {
      const size = 28, r = size / 2 - 1, cx = size / 2, cy = size / 2;
      const order = Object.keys(ASSET_COLOR).filter((a) => (w[a] || 0) > 0);
      const total = order.reduce((s, a) => s + w[a], 0) || 1;
      // The slices are CATEGORICAL hues (cash, ETH, SP500) and declare it.
      if (order.length === 1) return '<svg class="rv__pie" width="' + size + '" height="' + size + '" aria-hidden="true"><circle data-mark="series" cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + ASSET_COLOR[order[0]] + '"/></svg>';
      let a0 = -Math.PI / 2, paths = "";
      for (const a of order) {
        const frac = w[a] / total, a1 = a0 + frac * Math.PI * 2, large = frac > 0.5 ? 1 : 0;
        const x0 = (cx + r * Math.cos(a0)).toFixed(2), y0 = (cy + r * Math.sin(a0)).toFixed(2);
        const x1 = (cx + r * Math.cos(a1)).toFixed(2), y1 = (cy + r * Math.sin(a1)).toFixed(2);
        paths += '<path data-mark="series" d="M ' + cx + ' ' + cy + ' L ' + x0 + ' ' + y0 + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + ' Z" fill="' + ASSET_COLOR[a] + '"/>';
        a0 = a1;
      }
      return '<svg class="rv__pie" width="' + size + '" height="' + size + '" aria-hidden="true">' + paths + '</svg>';
    },

    // ── history-chart overlay toggles + legend ────────────────────────────────
    bgLegend() { return REGIME_BG_LEGEND; },
    // A price overlay is reference context, so it is drawn the way the
    // backtests draw the same asset's buy-and-hold line: slate, with that
    // line's dash. Teal and mint named On-chain and Conservative elsewhere on
    // this page. The chip's dot reads the same colour.
    overlayStyle(key) { return STRATEGY_STYLE[key === "spx" ? "sp500_hodl" : "eth_hodl"]; },
    overlayColor(key) { return this.overlayStyle(key).color; },
    hasSpx() { return (this.latest?.extras?.spx || []).length > 0; },
    hasEth() { return (this.latest?.extras?.eth || []).length > 0; },
    isVisible(key) { return !!this.visible[key]; },
    toggle(key) { this.visible[key] = !this.visible[key]; this.drawHistory(); },
    // The history chart's empty state (.rm-nodata): a line needs two readings,
    // and with one Chart.js draws its axes around nothing.
    historyEmpty() { return this.history.length < 2; },
    historyEmptyTitle() { return this.history.length === 1 ? "Not enough data yet" : "No data yet"; },
    historyEmptyDetail() { return this.history.length === 1 ? "One reading so far" : ""; },
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
      // Not drawn at all when empty: an empty Chart.js still paints its axes
      // and gridlines under the empty state laid over the canvas.
      if (!canvas || !window.Chart || this.historyEmpty()) return;
      const labels = this._denseCalendarDays(this.history);
      const byDate = new Map(this.history.map((h) => [h.date, h]));
      const val = (fn) => labels.map((d) => { const h = byDate.get(d); return h ? fn(h) : null; });
      // spanGaps:false is Chart.js's own default, set explicitly (issue #624,
      // mirroring wallet-perf.js) so a `null` gap day breaks the line instead
      // of ever silently interpolating across it.
      // Lines only: the composite no longer fills to zero, which made its hue
      // a mass over the whole plot. Each series takes the colour its name has
      // in the backtest charts below (STRATEGY_STYLE), so Macro, On-chain and
      // Equity factor are one hue each on the whole page.
      const line = (label, data, color, o = {}) => ({ label, data, borderColor: color, backgroundColor: "transparent", fill: false, tension: 0.2, pointRadius: 0, borderWidth: o.bw || 1.25, borderDash: o.dash, yAxisID: o.axis || "y", spanGaps: false });
      const ds = [
        line("Composite", val((h) => h.composite), STRATEGY_STYLE.composite.color, { bw: 2 }),
        line("Macro", val((h) => this._idx(h, "macro")), STRATEGY_STYLE.macro.color),
        line("On-chain", val((h) => this._idx(h, "onchain")), STRATEGY_STYLE.onchain.color),
      ];
      const hasFactor = this.history.some((h) => this._idx(h, "factor") != null);
      if (hasFactor) ds.push(line("Equity factor", val((h) => this._idx(h, "factor")), STRATEGY_STYLE.factor.color));
      const extras = this.latest?.extras || {};
      const showSpx = this.visible.spx && (extras.spx || []).length > 0;
      const showEth = this.visible.eth && (extras.eth || []).length > 0;
      const spx = this.overlayStyle("spx"), eth = this.overlayStyle("eth");
      if (showSpx) ds.push(line("S&P 500", alignToDates(extras.spx, labels), spx.color, { axis: "yPrice", dash: spx.dash }));
      if (showEth) ds.push(line("ETH", alignToDates(extras.eth, labels), eth.color, { axis: "yPrice", dash: eth.dash }));
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
            // Two decimals: Chart.js's own label rounded the 0.25 and 0.75
            // ticks to "0.3" and "0.8".
            y: { min: 0, max: 1, ...monoAxis({ ticks: { stepSize: 0.25, callback: (v) => (+v).toFixed(2) } }) },
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
        if (this.btEmptyTitle(key)) continue;
        const strategies = this.latest.backtest[key];
        const ds = this._curveKeys(key).map((sk) => {
          const s = strategies[sk];
          const style = STRATEGY_STYLE[sk];
          return { label: style.label, data: alignToDates(s.equity_curve, labels), borderColor: style.color, borderWidth: style.baseline ? 1 : 1.5, borderDash: style.baseline ? (style.dash || [4, 3]) : undefined, pointRadius: 0, tension: 0.2, fill: false, spanGaps: true };
        });
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
