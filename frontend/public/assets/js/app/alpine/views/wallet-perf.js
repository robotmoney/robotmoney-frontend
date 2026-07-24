// Alpine factory for the wallet performance view (allocation2). Moved
// verbatim from the monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, MONO_FONT, rgba, monoAxis } from "../../lib/chart-theme.js";
import { assetDot } from "./shared.js";

export function registerWalletPerfView(Alpine) {
  // ── Wallet performance (allocation2) ──────────────────────────────────────
  // LIVE daily series per asset (issue #84): fetched on init from
  // GET /api/dashboards/wallet-balances, replacing the baked 99-snapshot literal
  // that used to be frozen here (Mar 18–Jun 26 2026). Eight stacked-area series
  // drawn bottom→top in the endpoint's holdings[] order: Stable
  // (USDC/ZYFAI-SS1/GIZA-SS1) → Protocol (WETH/ETH) → Agent (ROBOTMONEY/BNKR) →
  // Stocks (SP500). The allocation chart's percent = value / total AUM * 100,
  // computed at runtime so the two charts share one data source. The Historical
  // Data table reads `rows`/`columns`/`showAll` from this same component.
  Alpine.data("walletPerfView", () => ({
    _charts: [],
    showAll: false,
    loading: true,
    error: null,
    // Live prop-wallet feed (issue #84): the eight stacked series + Historical
    // Data table are derived on init from GET /api/dashboards/wallet-balances
    // (holdings[] = fixed group/colour order; history[] = continuous, sparse
    // byAsset per day), NOT baked here. The retired 99-day literal used to be
    // frozen (Mar 18–Jun 26 2026); it now updates as the daily sampler runs.
    labels: [],
    assets: [],
    totalAum: [],
    columns: [],
    rows: [],
    init() { this.load(); },
    // ISO calendar day ("2026-03-18") → the compact "Mar 18" label.
    _fmtDay(iso) {
      return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    },
    // Fetch the endpoint and build the series/table from it. Colours + series
    // order come from holdings[] (Stable→Protocol→Agent→Stocks); an asset absent
    // from a day's byAsset stacks as 0 (chart) / renders "–" (table).
    async load() {
      try {
        const data = await api.get(ROUTES.dashboards.walletBalances);
        const holdings = data.holdings || [];
        const history = data.history || [];
        this.labels = history.map((pt) => this._fmtDay(pt.date));
        this.totalAum = history.map((pt) => pt.totalUsd);
        this.columns = holdings.map((h) => ({ sym: h.symbol, color: assetDot(h.symbol) }));
        this.assets = holdings.map((h) => ({
          label: h.symbol, color: assetDot(h.symbol),
          aum: history.map((pt) => (pt.byAsset[h.symbol] ?? 0)),
        }));
        this.rows = history.map((pt) => ({
          d: this._fmtDay(pt.date), aum: pt.totalUsd,
          a: Object.fromEntries(Object.entries(pt.byAsset).map(([sym, v]) => [sym, [v, ""]])),
        }));
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
        this.destroy();
        this.$nextTick(() => this.draw());
      }
    },
    // Collapsed = last 5 snapshots; "Show All" expands to the full series.
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
}
