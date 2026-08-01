// Alpine factory for the /dash/_styleguide fixture (issue #379, extended by
// #381 for the Chart.js dash theme + sparkline library). Purely local, static
// demo state — no API calls, matching the fixture's job: prove every dash.css
// class + dash-ui.js primitive renders and behaves, not exercise a real data
// path. The chart/sparkline sample series below are fixed literals for the
// same reason (deterministic golden screenshot, no live data).
import { applyDashChartDefaults, dashChartOptions, dashLineDatasetDefaults } from "../lib/chart-theme.js";
import { renderRowSparkline, renderSparkline } from "../lib/sparkline.js";

// Fixed 7-point demo series for the RowSparkline auto-color cases (§4.3):
// rises >0.5% end-to-end (green), falls (red), stays within +/-0.5% (muted).
const ROW_SPARKLINE_SAMPLES = {
  up: [10, 12, 11, 14, 13, 16, 18],
  down: [18, 16, 17, 14, 13, 11, 10],
  flat: [12, 12.1, 11.9, 12, 12.05, 11.95, 12],
  short: [10, 12, 11], // <4 finite points -> renders "—"
};

export function registerDashStyleguideView(Alpine) {
  Alpine.data("dashStyleguide", () => ({
    // Mirrors the <symbol id="i-*"> ids in assets/img/dash-icons.svg (minus
    // the "i-" prefix) — the plan's §3 glyph list.
    iconNames: [
      "triangle", "list-ordered", "trophy", "layers", "help-circle", "message-square", "activity", "book-open",
      "log-out", "lock", "eye", "eye-off", "send", "clock", "arrow-up", "arrow-down", "arrow-up-down", "globe",
      "twitter", "bot", "coins", "vault", "wallet", "search", "refresh-cw", "radio", "info", "copy", "external-link",
      "thumbs-up", "thumbs-down", "zap", "check-circle-2", "clipboard-list", "dollar-sign", "trending-up",
      "alert-circle", "radar", "upload", "trash", "star",
    ],
    rowSparklineSamples: ROW_SPARKLINE_SAMPLES,
    _chart: null,
    init() {
      this.$nextTick(() => this.drawChart());
    },
    // Demos the Chart.js dash theme (§4.2) on a plain line chart —
    // PerformanceChart/ChartCard shape (line, no dots, dashed grid, hidden X
    // axis, mono ticks), all sourced from dash.css tokens. The theme is
    // baked into the construction-time config via `dashChartOptions`/
    // `dashLineDatasetDefaults` so the chart's OWN first paint already
    // carries it (see those functions' doc comments: mutating
    // `chart.options` after construction needs a `chart.update()` to become
    // visible, and forcing that update landed a real, reproduced Chart.js
    // "Maximum call stack size exceeded" — a ResizeObserver/Chart.js
    // internal-resolver interaction specific to this Alpine-mounted canvas).
    // `applyDashChartDefaults` is still called afterward, exercising the
    // function the issue asks for — a safe no-op here since the options
    // already match (no forced update).
    drawChart() {
      const canvas = this.$refs.dashChartDemo;
      if (!canvas || !window.Chart) return;
      this._chart?.destroy();
      this._chart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: ["1", "2", "3", "4", "5", "6", "7"],
          datasets: [{ data: [10, 12, 11, 14, 13, 16, 18], fill: false, ...dashLineDatasetDefaults(canvas) }],
        },
        options: { responsive: true, maintainAspectRatio: false, ...dashChartOptions(canvas) },
      });
      applyDashChartDefaults(this._chart);
    },
    destroy() {
      this._chart?.destroy();
      this._chart = null;
    },
    // Sparkline (MetricCard/ProjectProfile KpiTile default 80x24; large mode
    // for WalletProfile passes {width:800,height:120}).
    sparklineSvg(values, opts) {
      return renderSparkline(values, opts);
    },
    // RowSparkline (List/List2/List3/Agents/Projects table cells, 80x22).
    rowSparklineSvg(values, opts) {
      return renderRowSparkline(values, opts);
    },
  }));
}
