// Alpine factories for the interactive Chart.js canvases restored on the
// research/blog posts (issue #350). Production ported these posts as static
// notes because the router injects view fragments with innerHTML, so a
// <script> inside a fragment never executes — same constraint solved by
// views/regime.js: register the factory at boot, carry only the x-data hook
// and a bare <canvas x-ref="…"> in the fragment.
//
// The series themselves are NOT live. Each post already describes itself as
// baked from a fixed "as of" date, so the chart draws from a committed JSON
// fixture under public/data/ (a frozen copy of the still-served production
// endpoint named in the post's own header comment) rather than an API call —
// a dated article citing a live number it doesn't actually track would be
// worse than the static note it replaces.
import { PALETTE, SERIES, monoAxis } from "../../lib/chart-theme.js";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return res.json();
}

const LEGEND = { labels: { color: PALETTE.textMuted } };
const X_DATE_AXIS = { grid: { display: false }, ticks: { color: PALETTE.textDim, maxTicksLimit: 8 } };

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
}
