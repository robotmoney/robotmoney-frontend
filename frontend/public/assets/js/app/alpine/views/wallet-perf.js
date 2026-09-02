// Alpine factory for the wallet performance view (allocation2). Moved
// verbatim from the monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, MONO_FONT, rgba, monoAxis } from "../../lib/chart-theme.js";
import { assetDot } from "./shared.js";

export function registerWalletPerfView(Alpine) {
  // ── Wallet performance (allocation2) ──────────────────────────────────────
  // WHOSE MONEY: the Robot Money protocol wallets, and only those. This factory
  // reads GET /api/dashboards/wallet-balances and NOTHING else: never
  // vault-economics, never vault TVL. The page it drives calls the figures
  // "protocol wallets", not "AUM": depositor capital is not in this series, and
  // "AUM" read as if it were. The internal names below (`totalAum`, the
  // `x-ref="aum"` canvas, `_series("aum")`) are deliberately unchanged.
  // Renaming them buys nothing a reader can see and would break the issue #614
  // gap specs, which query canvas[x-ref="aum"] directly.
  //
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
    // issue #614 AC5: "the UI discloses ... any unrecoverable window."
    // `source` itself stays config-resolved (whether the CURRENT sampler is
    // wired to live RPC), so the disclosure is additive: gapDayCount,
    // computed from the dense-calendar gap count, drives seamMessage() below
    // rather than overloading `source`'s existing meaning.
    gapDayCount: 0,
    init() { this.load(); },
    // ISO calendar day ("2026-03-18") → the compact "Mar 18" label.
    _fmtDay(iso) {
      return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    },
    // issue #614 AC5: `history` from the endpoint is PERSISTED days only — it
    // skips straight over any gap (seed-source hole, the scheduler wedge this
    // issue was filed from, ...). Charting it directly (one array slot per
    // PERSISTED day) is exactly the bug: Chart.js's category scale spaces
    // slots by ARRAY INDEX, so a 40-day hole between two adjacent slots draws
    // as one ordinary-width step — a ~$73k→$54k cliff that reads as a price
    // move, not six weeks of missing samples. Synthesizing every CALENDAR day
    // between the first and last persisted date (one array slot per day, gap
    // days included) makes the x-axis proportional to elapsed time again: a
    // 40-day hole now occupies 40 slots, same width as any other 40 days.
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
    // Fetch the endpoint and build the series/table from it. Colours + series
    // order come from holdings[] (Stable→Protocol→Agent→Stocks); an asset absent
    // from a PERSISTED day's byAsset stacks as 0 (held nothing that day). A day
    // with NO persisted row at all is `null` (a genuine gap — Chart.js's default
    // spanGaps:false breaks the line there instead of interpolating across it).
    async load() {
      try {
        const data = await api.get(ROUTES.dashboards.walletBalances);
        const holdings = data.holdings || [];
        const history = data.history || [];
        const days = this._denseCalendarDays(history);
        const byDate = new Map(history.map((pt) => [pt.date, pt]));

        // Unrecoverable window (Class C, D16): dense calendar days minus
        // persisted days = days this pipeline has no row for at all.
        this.gapDayCount = days.length - history.length;

        this.labels = days.map((d) => this._fmtDay(d));
        this.totalAum = days.map((d) => byDate.get(d)?.totalUsd ?? null);
        this.columns = holdings.map((h) => ({ sym: h.symbol, color: assetDot(h.symbol) }));
        this.assets = holdings.map((h) => ({
          label: h.symbol, color: assetDot(h.symbol),
          aum: days.map((d) => {
            const pt = byDate.get(d);
            return pt ? (pt.byAsset[h.symbol] ?? 0) : null;
          }),
        }));
        // The Historical Data table lists PERSISTED days only (a list of rows,
        // not a spatial axis — a missing day is simply an absent row, which
        // already discloses the gap honestly without needing a placeholder).
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
    // issue #614 AC5: a non-null return renders the seam banner
    // (performance.html).
    seamMessage() {
      const parts = [];
      if (this.gapDayCount > 0) {
        parts.push(`${this.gapDayCount} day${this.gapDayCount === 1 ? "" : "s"} in this range ${this.gapDayCount === 1 ? "is" : "are"} in process of being retrieved from the blockchain.`);
      }
      return parts.length ? parts.join(" ") : null;
    },
    // Collapsed = last 5 snapshots; "Show All" expands to the full series.
    visibleRows() { return this.showAll ? this.rows : this.rows.slice(-5); },
    fmtUsd(v) { return "$" + Number(v).toLocaleString("en-US"); },
    // Build the eight stacked series. kind "aum" → raw $; "pct" → % of total AUM.
    // A gap day (v === null, synthesized by _denseCalendarDays/load) must stay
    // null through the pct transform too — dividing null/total would coerce to
    // 0 and draw a false dip to zero on a day with no data at all, exactly the
    // "smoothed into a fake reading" defect issue #614 exists to stop.
    _series(kind) {
      return this.assets.map((a) => ({
        label: a.label, color: a.color,
        data: a.aum.map((v, i) => {
          const total = this.totalAum[i];
          if (v === null || total === null) return null;
          return kind === "pct" ? (total ? (v / total) * 100 : 0) : v;
        }),
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
            // spanGaps:false is Chart.js's own default, set explicitly here
            // (issue #614 AC5) so a `null` day breaks the line/fill instead of
            // ever silently interpolating across a gap, regardless of any
            // future Chart.js default change.
            fill: true, tension: 0, pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, spanGaps: false,
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
