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

  // ── Research signal (channel-divergence / late-cycle-signals) ─────────────
  Alpine.data("researchView", (key) => ({
    key,
    loading: true,
    error: null,
    payload: null,
    async load() {
      try {
        const data = await api.get(path(ROUTES.dashboards.researchSignal, { key: this.key }));
        this.payload = data.payload;
        this.loading = false;
        this.$nextTick(() => this.drawChart());
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    drawChart() {
      const canvas = this.$refs.chart;
      const pts = this.payload?.series?.points ?? [];
      if (!canvas || !window.Chart || !pts.length) return;
      new window.Chart(canvas, {
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
    pct(x) { return x == null ? "—" : Math.round(x * 100) + "%"; },
    readClass(read) {
      const r = String(read || "");
      if (r.includes("intact") || r === "benign") return "read read--ok";
      if (r.includes("break") || r.includes("saturated")) return "read read--warn";
      return "read read--mid";
    },
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
