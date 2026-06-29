// Alpine.data factories for the data-driven views (regime + committee). They
// fetch the API through app/lib/api.js (HTTP-only boundary) and expose plain
// state the HTML renders with x-for/x-text. No build, no Web Components.
import { api, ROUTES, path } from "../lib/api.js";

export function registerViews(Alpine) {
  // ── Regime classification ────────────────────────────────────────────────
  Alpine.data("regimeView", () => ({
    loading: true,
    error: null,
    latest: null,
    history: [],
    async load() {
      try {
        const data = await api.get(ROUTES.dashboards.regimeSnapshots, { range: 180 });
        this.latest = data.latest;
        this.history = data.history;
        this.loading = false;
        this.$nextTick(() => this.drawChart());
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    drawChart() {
      const canvas = this.$refs.chart;
      if (!canvas || !window.Chart || !this.history.length) return;
      new window.Chart(canvas, {
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
    regimeClass(r) { return r ? `regime-pill regime-pill--${r}` : "regime-pill"; },
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
        const detail = await api.get(path(ROUTES.committee.session, { date: pick.date, subject: pick.subject_id }));
        this.session = detail.session;
        this.takes = detail.takes || [];
        this.aggregate = detail.session?.committee_recommendation ?? null;
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    stanceClass(s) { return `stance stance--${s}`; },
  }));
}
