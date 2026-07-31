// Alpine factories for the interactive Chart.js canvases restored on the
// research/blog posts (issue #350). Production ported these posts as static
// notes because the router injects view fragments with innerHTML, so a
// <script> inside a fragment never executes — same constraint solved by
// views/regime.js: register the factory at boot, carry only the x-data hook
// and a bare <canvas x-ref="…"> in the fragment.
//
// The series themselves are NOT live. Each post already describes itself as
// baked from a fixed "as of" date, so the chart draws from a committed JSON
// fixture under public/data/ rather than an API call — a dated article
// citing a live number it doesn't actually track would be worse than the
// static note it replaces. Two fixtures (regime-eq-comparison.json,
// weighting-comparison.json) are frozen copies of a still-served production
// endpoint named in the post's own header comment. The other two
// (treasury-allocation.json, regime-conservative-aggressive.json) have no
// such endpoint — production's own /data/regime-snapshot.json is a rolling
// file that drifts daily, not a per-post archive — so those are sourced
// straight from robotmoney-site's git history: the exact commit, on the
// post's own asof date, whose numbers round to the post's own published
// table (see each factory's comment below for the commit SHA).
import { PALETTE, SERIES, monoAxis } from "../../lib/chart-theme.js";
import { STRATEGY_STYLE, regimeBandsPlugin, alignToDates } from "./shared.js";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return res.json();
}

const LEGEND = { labels: { color: PALETTE.textMuted } };
const X_DATE_AXIS = { grid: { display: false }, ticks: { color: PALETTE.textDim, maxTicksLimit: 8 } };
const XMULT_AXIS = monoAxis({ ticks: { callback: (v) => `${Number(v).toFixed(1)}x` } });

// treasury-allocation and regime-conservative-aggressive both back their
// charts off /regime/eth+mixed backtest slices, so they share this equity-
// curve line-drawer: STRATEGY_STYLE (shared.js) supplies colour/dash per key,
// alignToDates forward-fills every series onto the reference curve's date
// axis. Reference is always "composite" (matches the site's original
// BacktestChart/RuleComparisonChart, which both hardcode composite as "the
// date-axis reference — it has full history"), falling back to the first key
// if a chart's `keys` doesn't include it.
function drawEquityLines(canvas, backtestGroup, keys, { logScale = true, refKey } = {}) {
  if (!canvas || !window.Chart || !backtestGroup) return;
  const ref = backtestGroup[refKey || (keys.includes("composite") ? "composite" : keys[0])]?.equity_curve || [];
  const labels = ref.map((p) => p.date);
  new window.Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: keys.map((k) => {
        const style = STRATEGY_STYLE[k] || { label: k, color: SERIES.slate };
        return {
          label: style.label,
          data: alignToDates(backtestGroup[k]?.equity_curve, labels),
          borderColor: style.color,
          borderWidth: style.baseline ? 1 : 2,
          borderDash: style.dash,
          pointRadius: 0,
          tension: 0.2,
          fill: false,
        };
      }),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: logScale ? { type: "logarithmic", ...XMULT_AXIS } : XMULT_AXIS,
        x: X_DATE_AXIS,
      },
      plugins: { legend: LEGEND },
    },
  });
}

export function registerBlogCharts(Alpine) {
  // ── /blog/regime-eq-vs-base — three canvases backed by one fixture ────────
  // (fixture: public/data/regime-eq-comparison.json, asof 2026-05-30, matches
  // the post's own baked table numbers exactly — verified against production).
  Alpine.data("regimeEqCompareCharts", () => ({
    data: null,
    error: null,
    async load() {
      try {
        this.data = await fetchJson("/data/regime-eq-comparison.json");
      } catch (e) {
        this.error = e.message;
      }
      this.$nextTick(() => this.draw());
    },
    draw() {
      if (!this.data || !window.Chart) return;
      this.drawEquity();
      this.drawSharpe();
      this.drawIndex();
    },
    // Colour key shared by all three charts in this post so a reader learns
    // one legend and reuses it: slate = legacy 2-panel, cyan = current
    // 3-panel, beacon = the factor panel run standalone.
    _series() {
      return [
        { key: "base", label: "/regime_2panel (legacy)", color: SERIES.slate, dash: [6, 3] },
        { key: "eq", label: "/regime (3-panel current)", color: PALETTE.accent, dash: [] },
        { key: "factor_alone", label: "Factor panel alone", color: SERIES.beacon, dash: [] },
      ];
    },
    drawEquity() {
      const canvas = this.$refs.equity;
      const bt = this.data.backtest?.mixed;
      if (!canvas || !bt) return;
      const s = this._series();
      const labels = bt.eq.equity_curve.map((p) => p.date);
      new window.Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: s.map((d) => ({
            label: d.label,
            data: bt[d.key].equity_curve.map((p) => p.value),
            borderColor: d.color, borderDash: d.dash, borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: monoAxis({ ticks: { callback: (v) => `${Number(v).toFixed(1)}x` } }), x: X_DATE_AXIS },
          plugins: { legend: LEGEND },
        },
      });
    },
    drawSharpe() {
      const canvas = this.$refs.sharpe;
      const bt = this.data.backtest;
      if (!canvas || !bt) return;
      const portfolios = [["eth", "ETH / cash"], ["spx", "SP500 / cash"], ["mixed", "Mixed 50/50"]];
      const series = [
        { key: "macro_alone", label: "Macro panel", color: PALETTE.warm },
        { key: "onchain_alone", label: "On-chain panel", color: SERIES.teal },
        { key: "factor_alone", label: "Factor panel", color: SERIES.beacon },
        { key: "base", label: "2-panel composite", color: SERIES.slate },
        { key: "eq", label: "3-panel composite", color: PALETTE.accent },
      ];
      new window.Chart(canvas, {
        type: "bar",
        data: {
          labels: portfolios.map(([, label]) => label),
          datasets: series.map((s) => ({
            label: s.label,
            data: portfolios.map(([key]) => bt[key][s.key].sharpe),
            backgroundColor: s.color,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: monoAxis({ ticks: { callback: (v) => Number(v).toFixed(2) } }), x: { grid: { display: false }, ticks: { color: PALETTE.textDim } } },
          plugins: { legend: LEGEND },
        },
      });
    },
    drawIndex() {
      const canvas = this.$refs.index;
      const h = this.data.history;
      if (!canvas || !h) return;
      const s = this._series().map((d) => ({ ...d, key: d.key === "base" ? "base_composite" : d.key === "eq" ? "eq_composite" : "factor_index" }));
      const labels = h.eq_composite.map((p) => p.date);
      new window.Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: s.map((d) => ({
            label: d.label,
            data: h[d.key].map((p) => p.value),
            borderColor: d.color, borderDash: d.dash, borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: monoAxis({ ticks: { maxTicksLimit: 5 } }), x: X_DATE_AXIS },
          plugins: { legend: LEGEND },
        },
      });
    },
  }));

  // ── /blog/honest-backtesting-weights — one canvas ──────────────────────────
  // (fixture: public/data/weighting-comparison.json, asof 2026-05-14, matches
  // the post's ETH/cash composite table row exactly: 8.0x / 12.8x / 10.2x).
  Alpine.data("weightingCompareChart", () => ({
    data: null,
    error: null,
    async load() {
      try {
        this.data = await fetchJson("/data/weighting-comparison.json");
      } catch (e) {
        this.error = e.message;
      }
      this.$nextTick(() => this.draw());
    },
    draw() {
      const canvas = this.$refs.chart;
      if (!canvas || !window.Chart || !this.data) return;
      const methods = [
        { key: "static_invcorr", label: "Static", color: SERIES.slate, dash: [6, 3] },
        { key: "equal_1n", label: "Equal 1/N", color: SERIES.teal, dash: [] },
        { key: "walk_forward", label: "Walk-forward (honest)", color: PALETTE.accent, dash: [] },
      ];
      const labels = this.data.methods.walk_forward.eth.composite.equity_curve.map((p) => p.date);
      new window.Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: methods.map((m) => ({
            label: m.label,
            data: this.data.methods[m.key].eth.composite.equity_curve.map((p) => p.value),
            borderColor: m.color, borderDash: m.dash, borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: monoAxis({ ticks: { callback: (v) => `${Number(v).toFixed(1)}x` } }), x: X_DATE_AXIS },
          plugins: { legend: LEGEND },
        },
      });
    },
  }));

  // ── /blog/treasury-allocation — two canvases ───────────────────────────────
  // (fixture: public/data/treasury-allocation.json, asof 2026-05-12, source
  // robotmoney/robotmoney-site@e340ddba — the day's intraday snapshot whose
  // mixed/eth/sp500 backtest metrics round to this post's own table exactly:
  // composite +25.0%/0.88/-44%, 50/50 HODL +22.1%/0.67/-73%, ETH HODL
  // +13.8%/0.58/-94%, SP500 HODL +12.8%/0.72/-34%, cash +2.6%).
  Alpine.data("treasuryAllocationCharts", () => ({
    data: null,
    error: null,
    async load() {
      try {
        this.data = await fetchJson("/data/treasury-allocation.json");
      } catch (e) {
        this.error = e.message;
      }
      this.$nextTick(() => this.draw());
    },
    draw() {
      if (!this.data || !window.Chart) return;
      this.drawBacktest();
      this.drawAttribution();
    },
    drawBacktest() {
      // Full 5-way comparison: the regime composite against every baseline
      // named in the post's own table.
      const bt = this.data.backtest;
      drawEquityLines(this.$refs.backtest, {
        composite: bt.mixed.composite,
        blend_hodl: bt.mixed.blend_hodl,
        eth_hodl: bt.eth.eth_hodl,
        sp500_hodl: bt.sp500.sp500_hodl,
        stables_only: bt.eth.stables_only,
      }, ["composite", "blend_hodl", "eth_hodl", "sp500_hodl", "stables_only"]);
    },
    drawAttribution() {
      // The port's original AttributionChart stacked cyan as a filled mass
      // (composite fill-to-hodl, hodl fill-to-cash) — the exact anti-pattern
      // #327 already flagged: cyan is a line, never a mass. This redraws the
      // same three-rung ladder (cash → diversified HODL → regime composite)
      // as plain strokes on a log scale; the vertical gap between adjacent
      // lines at any date IS the value-add the prose describes, without a
      // filled band claiming to be a quantity.
      const bt = this.data.backtest;
      drawEquityLines(this.$refs.attribution, {
        composite: bt.mixed.composite,
        blend_hodl: bt.mixed.blend_hodl,
        stables_only: bt.eth.stables_only,
      }, ["composite", "blend_hodl", "stables_only"]);
    },
  }));

  // ── /blog/regime-conservative-aggressive — four canvases ───────────────────
  // (fixture: public/data/regime-conservative-aggressive.json, asof
  // 2026-06-25, source robotmoney/robotmoney-site@e64a211e — the last daily
  // update on the post's own asof date, whose eth-bucket backtest matches this
  // post's table exactly: conservative 5.90x/+24.5%/0.71/-59.1%/122,
  // aggressive 5.35x/+23.0%/0.66/-64.8%/131, composite 13.73x/+38.1%/0.85/
  // -64.7%/56, eth_hodl 2.03x/+8.7%/0.52/-94.0%, stables_only 1.24x/+2.6%/
  // 26.86/0.0%).
  Alpine.data("regimeRuleCompareCharts", () => ({
    data: null,
    error: null,
    async load() {
      try {
        this.data = await fetchJson("/data/regime-conservative-aggressive.json");
      } catch (e) {
        this.error = e.message;
      }
      this.$nextTick(() => this.draw());
    },
    draw() {
      if (!this.data || !window.Chart) return;
      this.drawBands();
      this.drawRules();
    },
    // The three combination rules the post's truth tables define, ported
    // verbatim from the site's RegimeBandsCharts.tsx (combineConservative /
    // combineAggressive) so the bands drawn here match the same rule that
    // produced the eth.conservative / eth.aggressive backtest curves below.
    _conservative(m, o) {
      if (!m || !o) return null;
      if (m === "risk_off" || o === "risk_off") return "risk_off";
      if (m === "risk_on" && o === "risk_on") return "risk_on";
      return "neutral";
    },
    _aggressive(m, o) {
      if (!m || !o) return null;
      const score = (r) => (r === "risk_on" ? 1 : r === "risk_off" ? -1 : 0);
      const sum = score(m) + score(o);
      if (sum >= 1) return "risk_on";
      if (sum <= -1) return "risk_off";
      return "neutral";
    },
    drawBands() {
      const h = this.data.history;
      const eth = this.data.extras?.eth;
      if (!h || !eth) return;
      const dates = h.map((r) => r.date);
      const ethPrice = alignToDates(eth, dates);
      const panels = [
        ["bandsComposite", h.map((r) => r.regime)],
        ["bandsConservative", h.map((r) => this._conservative(r.macro_regime, r.onchain_regime))],
        ["bandsAggressive", h.map((r) => this._aggressive(r.macro_regime, r.onchain_regime))],
      ];
      for (const [ref, regimes] of panels) {
        const canvas = this.$refs[ref];
        if (!canvas || !window.Chart) continue;
        new window.Chart(canvas, {
          type: "line",
          plugins: [regimeBandsPlugin],
          data: {
            labels: dates,
            datasets: [{
              label: "ETH",
              data: ethPrice,
              borderColor: PALETTE.text,
              borderWidth: 1.25,
              pointRadius: 0,
              tension: 0.2,
              fill: false,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
              legend: { display: false },
              regimeBands: { enabled: true, regimes },
            },
            scales: {
              y: { type: "logarithmic", ...monoAxis({ ticks: { callback: (v) => ([100, 200, 500, 1000, 2000, 5000].includes(+v) ? `$${v}` : "") } }) },
              x: X_DATE_AXIS,
            },
          },
        });
      }
    },
    drawRules() {
      drawEquityLines(this.$refs.rules, this.data.backtest.eth, ["conservative", "aggressive", "composite", "eth_hodl", "stables_only"]);
    },
  }));
}
