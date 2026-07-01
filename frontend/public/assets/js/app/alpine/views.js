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
