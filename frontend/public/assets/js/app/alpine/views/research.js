// Alpine factory for the /research/* signal views (channel-divergence /
// late-cycle-signals). Moved verbatim from the monolithic views.js (finding 025).
import { api, ROUTES, path } from "../../lib/api.js";
import { PALETTE, monoAxis } from "../../lib/chart-theme.js";

export function registerResearchView(Alpine) {
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
    seriesPoints(key) {
      const pts = this.payload?.indicators?.[key];
      return Array.isArray(pts) ? pts.filter((p) => p && p.value != null).slice(-180) : [];
    },
    // The chart's empty state (.rm-nodata), or null while it can draw. Nothing
    // is said while the read is in flight. A failed read is no data available;
    // a series that is missing or all gaps is no data yet; one reading is not
    // enough for a line (Chart.js draws a lone point as nothing at radius 0).
    seriesEmpty(key) {
      if (this.loading) return null;
      if (this.error) return "No data available";
      const n = this.seriesPoints(key).length;
      return n === 0 ? "No data yet" : n === 1 ? "Not enough data yet" : null;
    },
    seriesEmptyDetail(key) {
      return !this.loading && !this.error && this.seriesPoints(key).length === 1 ? "One reading so far" : "";
    },
    // The live panel's empty state: the same states, for the gauges.
    gaugesEmpty() {
      if (this.loading) return null;
      if (this.error) return "No data available";
      return this.payload?.gauges?.length ? null : "No data yet";
    },
    drawSeriesCharts() {
      if (!this.payload?.indicators || !window.Chart || !this.$root) return;
      for (const canvas of this.$root.querySelectorAll("canvas[data-series]")) {
        const pts = this.seriesPoints(canvas.getAttribute("data-series"));
        if (pts.length < 2) continue;
        new window.Chart(canvas, {
          type: "line",
          data: {
            labels: pts.map((p) => p.date),
            datasets: [{ data: pts.map((p) => p.value), borderColor: PALETTE.accent, borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false }],
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
          // A line with no area under it: cyan is a line, never a mass.
          datasets: [{ label: this.payload.series.label, data: pts.map((p) => p.value),
            borderColor: PALETTE.accent, fill: false, tension: 0.25, pointRadius: 0, borderWidth: 2 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: monoAxis(), x: monoAxis({ ticks: { maxTicksLimit: 8 } }) },
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
}
