// Alpine factory for /vaults/:id — VaultProfile "vault dossier" (issue #391,
// docs/bot-analytics-ui-port-plan.md §5.12, P3.4): GET
// /api/dashboards/vaults/:id. Renders inside views/dash/_layout.html's
// [data-outlet]; the ancestor `.a3` shell (issue #379) already supplies the
// scoped theme, so nothing here repeats that class.
//
// Data-source badge (§5.12: original had LIVE/SIMULATED/UPCOMING): this
// backend's `agent_vaults.data_source` column only ever holds 'live' |
// 'static' (migration 0014) — there is no SIMULATED/UPCOMING value in this
// schema. Rather than invent a three-way distinction the data can't back,
// this view follows the SAME live-vs-muted convention list2.html already
// renders for the identical column (frontend/public/views/dash/list2.html).
//
// Yield History (§5.12, D11): the original rendered a deterministic seeded
// random-walk simulation around the current APY — fabricated data, and a
// violation of this repo's honesty contract. `profile.yieldHistory` is
// always `[]` today (no per-vault APY history table/writer exists), so this
// view always shows the honest empty chart (.rm-nodata), never a synthetic
// series.
import { api, ROUTES, path } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";
import { applyDashChartDefaults, dashChartOptions, dashLineDatasetDefaults } from "../lib/chart-theme.js";

const PERIODS = [
  { id: "30d", label: "30D", days: 30 },
  { id: "90d", label: "90D", days: 90 },
  { id: "1y", label: "1Y", days: 365 },
];

export function registerVaultProfileView(Alpine) {
  Alpine.data("vaultProfileView", () => ({
    loading: true,
    error: null,
    notFound: false,
    id: null,
    profile: null,

    period: "30d",
    periods: PERIODS,
    _chart: null,

    async init() {
      this.id = location.pathname.split("/").filter(Boolean).pop();
      await this.load();
      this.$nextTick(() => this.drawChart());
    },

    async load() {
      this.loading = true;
      this.error = null;
      this.notFound = false;
      try {
        this.profile = await api.get(path(ROUTES.dashboards.vaultDetail, { id: this.id }));
      } catch (e) {
        if (e.status === 404) this.notFound = true;
        else this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    setPeriod(id) {
      this.period = id;
      // The canvas is only in the DOM while the period has a line to draw,
      // so drawing waits for Alpine to add or remove it.
      this.$nextTick(() => this.drawChart());
    },
    isPeriod(id) {
      return this.period === id;
    },
    get filteredTvlHistory() {
      const rows = this.profile?.tvlHistory || [];
      const p = PERIODS.find((x) => x.id === this.period);
      if (!p) return rows;
      const cutoff = Date.now() - p.days * 86_400_000;
      return rows.filter((r) => new Date(r.date).getTime() >= cutoff);
    },

    // The TVL chart's empty state (.rm-nodata). A line needs two daily
    // readings: one alone is a lone invisible point (pointRadius 0) on blank
    // axes. The detail only speaks when it adds something the title can't:
    // that the vault does have history, just not in the chosen period, or
    // that there is exactly one reading.
    get tvlChartEmpty() {
      return this.filteredTvlHistory.length < 2;
    },
    tvlChartEmptyTitle() {
      return this.filteredTvlHistory.length ? "Not enough data yet" : "No data yet";
    },
    tvlChartEmptyDetail() {
      const shown = this.filteredTvlHistory.length;
      const total = this.profile?.tvlHistory?.length ?? 0;
      if (shown === 1) return total > 1 ? "One reading in this period" : "One reading so far";
      return total > 0 ? "No TVL history in this period" : "";
    },

    drawChart() {
      this._chart?.destroy();
      this._chart = null;
      const canvas = this.$refs.tvlChart;
      if (!canvas || !window.Chart || this.tvlChartEmpty) return;
      const rows = this.filteredTvlHistory;
      this._chart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: rows.map((r) => r.date),
          datasets: [{ data: rows.map((r) => r.tvlUsd), fill: false, ...dashLineDatasetDefaults(canvas) }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          ...dashChartOptions(canvas, { yTickCallback: (v) => this.fmtUsd(v) }),
        },
      });
      applyDashChartDefaults(this._chart, { yTickCallback: (v) => this.fmtUsd(v) });
    },
    destroy() {
      this._chart?.destroy();
      this._chart = null;
    },

    isLive() {
      return this.profile?.dataSource === "live";
    },

    // ── formatting ──────────────────────────────────────────────────────────
    fmtUsd(n) {
      return fmtUsdCompact(n);
    },
    fmtApy(n) {
      if (n == null || !isFinite(n)) return "—";
      return (n * 100).toFixed(2) + "%";
    },
    fmtAddr(addr) {
      if (!addr || addr.length < 10) return addr || "—";
      return addr.slice(0, 6) + "..." + addr.slice(-4);
    },
    fmtDate(iso) {
      if (!iso) return "—";
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
    },
  }));
}
