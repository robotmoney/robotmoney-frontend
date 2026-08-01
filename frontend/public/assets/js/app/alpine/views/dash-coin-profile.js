// Alpine factory for /lobster/:id — CoinProfile "coin dossier" (issue #391,
// docs/bot-analytics-ui-port-plan.md §5.10, P3.3): GET
// /api/dashboards/coins/:id. Renders inside views/dash/_layout.html's
// [data-outlet] — the ancestor `.a3` shell (issue #379) already supplies the
// scoped theme, so nothing here repeats that class.
//
// About-card description, rank/liquidity/ATH stats, and the ExtLink chip row
// (§5.10) all depend on P1.7 (CoinGecko/DexScreener proxy endpoints), which
// has not landed as of this issue — this view renders an honest `.a3-notice`
// in their place rather than fabricating that content (see the DTO's own
// header comment in contract/src/dashboards.d.ts).
//
// PerformanceChart period tabs: the doc's original set is 24h/7d/30d/90d/1y/
// all, but daily_coin_snapshots (this backend's only price history) is
// one-point-per-UTC-day — there is no intraday series to give 24h its own
// shape, so this view drops that tab rather than rendering a duplicate of 7d
// under a misleading label (an honest resolution-limit, not a fabricated
// finer-grained series).
import { api, ROUTES, path } from "../../lib/api.js";
import { applyDashChartDefaults, dashChartOptions, dashLineDatasetDefaults } from "../lib/chart-theme.js";
import { fmtUsdCompact } from "../lib/dash-format.js";

const PERIODS = [
  { id: "7d", label: "7D", days: 7 },
  { id: "30d", label: "30D", days: 30 },
  { id: "90d", label: "90D", days: 90 },
  { id: "1y", label: "1Y", days: 365 },
  { id: "all", label: "ALL", days: Infinity },
];

export function registerCoinProfileView(Alpine) {
  Alpine.data("coinProfileView", () => ({
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
        this.profile = await api.get(path(ROUTES.dashboards.coinDetail, { id: this.id }));
      } catch (e) {
        if (e.status === 404) this.notFound = true;
        else this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // ── period toggle ──────────────────────────────────────────────────────
    setPeriod(id) {
      this.period = id;
      this.drawChart();
    },
    isPeriod(id) {
      return this.period === id;
    },
    get filteredHistory() {
      const rows = this.profile?.priceHistory || [];
      const p = PERIODS.find((x) => x.id === this.period);
      if (!p || !Number.isFinite(p.days)) return rows;
      const cutoff = Date.now() - p.days * 86_400_000;
      return rows.filter((r) => new Date(r.date).getTime() >= cutoff);
    },

    drawChart() {
      const canvas = this.$refs.priceChart;
      if (!canvas || !window.Chart) return;
      this._chart?.destroy();
      const rows = this.filteredHistory;
      this._chart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: rows.map((r) => r.date),
          datasets: [{
            data: rows.map((r) => r.priceUsd),
            fill: false,
            ...dashLineDatasetDefaults(canvas),
          }],
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

    // ── formatting ──────────────────────────────────────────────────────────
    // Doubles as this view's price formatter (used for both market cap/FDV/
    // volume AND profile.priceUsd, which can be sub-cent) — smallPrecision
    // preserves the >=1 -> 4dp / <1 -> 6dp smart precision (§5.9) a fixed
    // 2dp base would round to "$0.00".
    fmtUsd(n) {
      return fmtUsdCompact(n, { smallPrecision: true });
    },
    fmtPct(n) {
      if (n == null || !isFinite(n)) return "—";
      return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
    },
    fmtAddr(addr) {
      if (!addr || addr.length < 10) return addr || "—";
      return addr.slice(0, 6) + "..." + addr.slice(-4);
    },
  }));
}
