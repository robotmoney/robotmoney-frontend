// Alpine.data factories for the data-driven views (regime + committee). They
// fetch the API through app/lib/api.js (HTTP-only boundary) and expose plain
// state the HTML renders with x-for/x-text. No build, no Web Components.
import { api, ROUTES, path } from "../lib/api.js";

export function registerViews(Alpine) {
  // ── Regime classification ────────────────────────────────────────────────
  Alpine.data("regimeView", () => ({
    _chart: null,
    _equityChart: null,
    loading: true,
    error: null,
    latest: null,
    history: [],
    portfolio: "eth", // backtest portfolio selector (eth | sp500 | mixed)
    async load() {
      try {
        const data = await api.get(ROUTES.dashboards.regimeSnapshots, { range: 180 });
        this.latest = data.latest;
        this.history = data.history;
        this.loading = false;
        this.$nextTick(() => { this.drawChart(); this.drawEquityChart(); });
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    drawChart() {
      const canvas = this.$refs.chart;
      if (!canvas || !window.Chart || !this.history.length) return;
      this._chart?.destroy();
      this._chart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: this.history.map((s) => s.date),
          datasets: [{
            label: "Composite (risk-on)",
            data: this.history.map((s) => s.composite),
            borderColor: "#00e5ff",
            backgroundColor: "rgba(0,229,255,0.12)",
            fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: {
            y: { min: 0, max: 1, grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#7e889e" } },
            x: { grid: { display: false }, ticks: { color: "#4a5268", maxTicksLimit: 8 } },
          },
          plugins: { legend: { labels: { color: "#7e889e" } } },
        },
      });
    },
    pct(x) { return x == null ? "—" : Math.round(x * 100) + "%"; },
    fmtWeight(w) { return w == null ? "—" : Math.round(w * 100) + "%"; },
    regimeClass(r) { return r ? `regime-pill regime-pill--${r}` : "regime-pill"; },
    regimeLabel(r) { return r ? String(r).replace(/_/g, "-") : "—"; },
    // Rich per-indicator objects come only on the latest (asof) row; historical
    // rows carry the numeric columns + `percentiles` map. Group the asof indicators
    // by panel so the view can render Macro / On-chain sections.
    indicatorsIn(panel) {
      const inds = this.latest?.indicators;
      return Array.isArray(inds) ? inds.filter((i) => i.panel === panel) : [];
    },
    panelIndex(p) { return p === "macro" ? this.latest?.macroIndex : this.latest?.onchainIndex; },
    panelPercentile(p) { return p === "macro" ? this.latest?.macroPercentile : this.latest?.onchainPercentile; },
    panelRegime(p) { return p === "macro" ? this.latest?.macroRegime : this.latest?.onchainRegime; },
    // Sign-aligned percentile (1 = risk-on) drives the bar; fall back to the raw
    // percentile if the signed value is absent.
    sigPct(ind) {
      const v = ind.signed_percentile != null ? ind.signed_percentile : ind.percentile;
      return v == null ? 0 : Math.round(v * 100);
    },
    // ── Backtest: month-end equity curves for the selected portfolio ──────────
    // The backtest payload is asof-only (latest row). Plot the headline strategies
    // (composite regime timing) vs the buy-and-hold + stables baselines.
    hasBacktest() { return !!(this.latest && this.latest.backtest); },
    portfolios() { return this.hasBacktest() ? Object.keys(this.latest.backtest) : []; },
    setPortfolio(p) { this.portfolio = p; this.$nextTick(() => this.drawEquityChart()); },
    _equitySeries() {
      const bt = this.latest?.backtest?.[this.portfolio];
      if (!bt) return [];
      const hodlKey = { eth: "eth_hodl", sp500: "sp500_hodl", mixed: "blend_hodl" }[this.portfolio];
      const specs = [
        { key: "composite", label: "Composite timing", color: "#00e5ff" },
        { key: "conservative", label: "Conservative", color: "#7cf5b0" },
        { key: "aggressive", label: "Aggressive", color: "#f5a623" },
        { key: hodlKey, label: "Buy & hold", color: "#b06cff" },
        { key: "stables_only", label: "Stables only", color: "#5a6b8c" },
      ];
      return specs.filter((s) => s.key && bt[s.key]?.equity_curve?.length).map((s) => ({ ...s, m: bt[s.key] }));
    },
    strategyMetrics() {
      const bt = this.latest?.backtest?.[this.portfolio];
      if (!bt) return [];
      return Object.entries(bt).map(([name, m]) => ({
        name: String(name).replace(/_/g, " "),
        cagr: m.cagr, sharpe: m.sharpe, maxDd: m.max_drawdown,
        transitions: m.transitions, finalValue: m.final_value,
      }));
    },
    drawEquityChart() {
      const canvas = this.$refs.equity;
      const series = this._equitySeries();
      if (!canvas || !window.Chart || !series.length) return;
      this._equityChart?.destroy();
      const labels = series[0].m.equity_curve.map((p) => p.date);
      const byDate = (curve) => { const m = new Map(curve.map((p) => [p.date, p.value])); return labels.map((d) => m.get(d) ?? null); };
      this._equityChart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: series.map((s) => ({
            label: s.label, data: byDate(s.m.equity_curve),
            borderColor: s.color, backgroundColor: "transparent",
            fill: false, tension: 0.2, pointRadius: 0, borderWidth: 2, spanGaps: true,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: {
            y: { type: "logarithmic", grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#7e889e" } },
            x: { grid: { display: false }, ticks: { color: "#4a5268", maxTicksLimit: 8 } },
          },
          plugins: { legend: { labels: { color: "#7e889e" } } },
        },
      });
    },
    // ── Predictive-power correlations (asof-only) ─────────────────────────────
    hasCorrelations() { return !!(this.latest && this.latest.correlations); },
    corrIndices() { return this.hasCorrelations() ? Object.keys(this.latest.correlations.forward) : []; },
    corrHorizons() { return ["30", "90", "180"]; },
    forwardCorr(index, asset, h) { return this.latest?.correlations?.forward?.[index]?.[`${asset}_${h}d`] ?? null; },
    concurrentCorr(index, asset) { return this.latest?.correlations?.concurrent?.[index]?.[asset] ?? null; },
    fmtRho(cell) { return cell && cell.rho != null ? (cell.rho >= 0 ? "+" : "") + cell.rho.toFixed(2) : "—"; },
    corrClass(cell) {
      if (!cell || cell.rho == null) return "rv__rho";
      return cell.rho >= 0 ? "rv__rho rv__rho--pos" : "rv__rho rv__rho--neg";
    },
    fmtCagr(x) { return x == null ? "—" : (x >= 0 ? "+" : "") + Math.round(x * 100) + "%"; },
    fmtNum(x, d = 2) { return x == null ? "—" : Number(x).toFixed(d); },
    destroy() { this._chart?.destroy(); this._chart = null; this._equityChart?.destroy(); this._equityChart = null; },
  }));

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
    drawSeriesCharts() {
      const inds = this.payload?.indicators;
      if (!inds || !window.Chart || !this.$root) return;
      for (const canvas of this.$root.querySelectorAll("canvas[data-series]")) {
        const key = canvas.getAttribute("data-series");
        const pts = (inds[key] || []).filter((p) => p && p.value != null).slice(-180);
        if (!pts.length) continue;
        new window.Chart(canvas, {
          type: "line",
          data: {
            labels: pts.map((p) => p.date),
            datasets: [{ data: pts.map((p) => p.value), borderColor: "#4488ff", borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false }],
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { ticks: { color: "#4a5268", maxTicksLimit: 3 }, grid: { color: "rgba(255,255,255,0.05)" } } },
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
          datasets: [{ label: this.payload.series.label, data: pts.map((p) => p.value),
            borderColor: "#4488ff", backgroundColor: "rgba(68,136,255,0.12)", fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: { y: { grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#7e889e" } },
            x: { grid: { display: false }, ticks: { color: "#4a5268", maxTicksLimit: 8 } } },
          plugins: { legend: { labels: { color: "#7e889e" } } },
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

  // ── Wallet performance (allocation2) ──────────────────────────────────────
  // Static baked series (approximated from the unified-wallet-history snapshots,
  // the same numbers the CSS bars used) drawn as Chart.js stacked areas to match
  // the original. No fetch; draws once on init. Stacks bottom→top:
  // Stable, Protocol, Agent, Stocks.
  Alpine.data("walletPerfView", () => ({
    _charts: [],
    labels: ["Mar 18", "Mar 28", "Apr 17", "Apr 27", "May 17", "Jun 7", "Jun 17", "Jun 26"],
    aumSeries: [
      { label: "Stable (USDC, ZYFAI-SS1)", color: "#10b981", data: [0, 6460, 10020, 8720, 13080, 14530, 16340, 13970] },
      { label: "Protocol (WETH, ETH)", color: "#e8a640", data: [21790, 22240, 27570, 20340, 27890, 29960, 29960, 24270] },
      { label: "Agent (ROBOTMONEY, BNKR)", color: "#4488ff", data: [50850, 43040, 45950, 29060, 41840, 40860, 39040, 30890] },
      { label: "Stocks (SP500)", color: "#8b5cf6", data: [0, 0, 0, 0, 4360, 5450, 5450, 4410] },
    ],
    pctSeries: [
      { label: "Stable (USDC, ZYFAI-SS1)", color: "#10b981", data: [0, 9, 12, 15, 15, 16, 18, 19] },
      { label: "Protocol (WETH, ETH)", color: "#e8a640", data: [30, 31, 33, 35, 32, 33, 33, 33] },
      { label: "Agent (ROBOTMONEY, BNKR)", color: "#4488ff", data: [70, 60, 55, 50, 48, 45, 43, 42] },
      { label: "Stocks (SP500)", color: "#8b5cf6", data: [0, 0, 0, 0, 5, 6, 6, 6] },
    ],
    init() { this.$nextTick(() => this.draw()); },
    _rgba(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    },
    _chart(canvas, series, max, tick) {
      if (!canvas || !window.Chart) return;
      const instance = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: this.labels,
          datasets: series.map((s) => ({
            label: s.label, data: s.data, borderColor: s.color,
            backgroundColor: this._rgba(s.color, 0.45),
            fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          scales: {
            y: { stacked: true, beginAtZero: true, max, grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#7e889e", callback: tick } },
            x: { grid: { display: false }, ticks: { color: "#4a5268", maxTicksLimit: 8 } },
          },
          plugins: { legend: { display: false } },
        },
      });
      this._charts.push(instance);
    },
    draw() {
      this._chart(this.$refs.aum, this.aumSeries, 91000, (v) => "$" + Math.round(v / 1000) + "k");
      this._chart(this.$refs.alloc, this.pctSeries, 100, (v) => v + "%");
    },
    destroy() { this._charts.forEach((item) => item.destroy()); this._charts = []; },
  }));

  // ── Tokenomics fee distribution (pie) ─────────────────────────────────────
  // Static Chart.js pie matching the original FeePieChart. The custom legend
  // below the chart stays in the markup, so the chart's own legend is off.
  Alpine.data("feeChart", () => ({
    _chart: null,
    init() { this.$nextTick(() => this.draw()); },
    draw() {
      const canvas = this.$refs.fee;
      if (!canvas || !window.Chart) return;
      this._chart?.destroy();
      this._chart = new window.Chart(canvas, {
        type: "pie",
        data: {
          labels: ["Protocol (57%)", "Bankr (40%)", "Clanker (3%)"],
          datasets: [{ data: [57, 40, 3], backgroundColor: ["#10b981", "#f59e0b", "#8b5cf6"], borderColor: "#0a0a0f", borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } },
      });
    },
    destroy() { this._chart?.destroy(); this._chart = null; },
  }));

  // ── Investment Committee ──────────────────────────────────────────────────
  Alpine.data("committeeView", () => ({
    loading: true,
    error: null,
    session: null,
    takes: [],
    aggregate: null,
    async load() {
      try {
        const { sessions } = await api.get(ROUTES.committee.sessions);
        const published = (sessions || []).filter((s) => s.state === "published");
        const pick = published[0] ?? (sessions || [])[0];
        if (!pick) { this.loading = false; return; }
        const detail = await api.get(path(ROUTES.committee.session, { date: pick.date, subject: pick.subjectId }));
        this.session = detail.session;
        this.takes = detail.takes || [];
        this.aggregate = detail.session?.committeeRecommendation ?? null;
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    stanceClass(s) { return `stance stance--${s}`; },
  }));

  // ── Public comment thread ─────────────────────────────────────────────────
  // Re-creates the original site's comment thread, now backed by Postgres.
  // Fed a page slug; fetches GET /api/comments and POSTs new comments. Renders
  // optimistically and surfaces the 429 rate-limit message inline.
  Alpine.data("commentsThread", (page) => ({
    page,
    loading: true,
    error: null,
    notice: null,
    posting: false,
    comments: [],
    form: { author: "", content: "" },
    async load() {
      try {
        const data = await api.get(ROUTES.comments.list, { page: this.page });
        this.comments = data.comments || [];
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    async submit() {
      this.notice = null;
      const author = this.form.author.trim();
      const content = this.form.content.trim();
      if (!author || !content) {
        this.notice = "Name and comment are both required.";
        return;
      }
      this.posting = true;
      try {
        const created = await api.post(ROUTES.comments.create, { page: this.page, author, content });
        this.comments.push(created); // optimistic append (oldest → newest)
        this.form.content = "";
      } catch (e) {
        // ApiError exposes .status; 429 = rate limited.
        this.notice = e.status === 429
          ? "You're commenting too fast — please wait a moment and try again."
          : `Could not post your comment (${e.message}).`;
      } finally {
        this.posting = false;
      }
    },
    when(iso) {
      try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
    },
  }));

  // ── Committee application (apply → pending activation) ─────────────────────
  // The real onboarding entry point. POSTs the prospective member's public key
  // to /api/committee/apply; the member is recorded 'applied' and an admin must
  // activate it before it can submit. No token is minted here.
  Alpine.data("applyForm", () => ({
    form: { memberId: "", name: "", lens: "", publicKey: "" },
    submitting: false,
    error: null,
    result: null,
    async submit() {
      this.error = null;
      this.submitting = true;
      try {
        const body = {
          memberId: this.form.memberId.trim(),
          name: this.form.name.trim(),
          lens: this.form.lens.trim() || undefined,
          publicKey: this.form.publicKey.trim(),
        };
        this.result = await api.post(ROUTES.committee.apply, body);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  }));
}
