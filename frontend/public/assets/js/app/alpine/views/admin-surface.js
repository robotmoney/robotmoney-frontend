// Alpine factory for the admin operator surface (/admin and its subpaths).
// Supersedes the old single-table adminJobsView (issue #157;
// docs/plan-admin-surface.md §7). One shell fragment serves every /admin/*
// path (frontend/public/assets/js/app/routes.js maps the whole subtree to
// this view); this component reads location.pathname at init to decide which
// section to render and keeps navigating with history.pushState so deep links
// like /admin/research/runs/:id are shareable. Committee topic/member/roster/
// session management is explicitly OUT of scope for this view (#157 scope) —
// only overview, research (pipeline telemetry), and queue (jobs/schedules/
// retry) operate through it.
//
// Auth: unchanged from the prior dashboard — the ADMIN_TOKEN secret is sent as
// X-Admin-Token and kept in sessionStorage (rm_admin_token) so a refresh stays
// signed in for the tab; any 403 forces re-login (fail-closed) and clears all
// section state so nothing sensitive lingers in memory.
import { api, ROUTES, path } from "../../lib/api.js";

const ADMIN_TOKEN_KEY = "rm_admin_token";

function sectionFromPath(pathname) {
  if (pathname.startsWith("/admin/research")) return "research";
  if (pathname.startsWith("/admin/queue")) return "queue";
  return "overview";
}

function researchRunIdFromPath(pathname) {
  const m = pathname.match(/^\/admin\/research\/runs\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function registerAdminSurfaceView(Alpine) {
  Alpine.data("adminSurfaceView", () => ({
    // ── auth ──────────────────────────────────────────────────────────────
    authed: false,
    password: sessionStorage.getItem(ADMIN_TOKEN_KEY) || "",
    loginError: null,

    // ── shell ─────────────────────────────────────────────────────────────
    section: sectionFromPath(location.pathname),
    paused: false,
    pollTimer: null,
    lastRefreshedAt: null,

    // ── overview ──────────────────────────────────────────────────────────
    overview: null,
    overviewLoading: false,
    overviewError: null,

    // ── queue ─────────────────────────────────────────────────────────────
    jobs: [],
    schedules: [],
    summary: { byStatus: {}, byKind: {} },
    runs: [],
    selectedJob: null, // { job, runs } detail for the opened job
    queueFilters: { kind: "", status: "", scopeType: "", scopeId: "" },
    queueLoading: false,
    queueError: null,
    retryResult: null,
    retryError: null,

    // ── research ──────────────────────────────────────────────────────────
    researchRuns: [],
    researchFilters: { kind: "", tool: "", asof: "", status: "", jobId: "" },
    researchLoading: false,
    researchError: null,
    selectedResearchRunId: researchRunIdFromPath(location.pathname),
    selectedResearchRun: null, // { run, stages, artifacts }
    researchDetailLoading: false,
    researchDetailError: null,

    // ── rerun form (US-R4) ───────────────────────────────────────────────
    rerun: { kind: "regime.classify", toolId: "", asof: "", reason: "" },
    rerunSubmitting: false,
    rerunError: null,
    rerunResult: null,

    // A stored token (from a prior login this tab) → try to load straight into
    // the current section; a 403 there clears it and drops back to the login gate.
    async init() {
      if (this.password) {
        try {
          await this.loadSection();
          this.authed = true;
          this.startPolling();
        } catch (e) {
          if (e.status === 403) this._forgetToken();
        }
      }
    },
    destroy() { this.stopPolling(); },

    _forgetToken() {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      this.authed = false;
      this.stopPolling();
    },
    _token() { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || this.password.trim(); },

    // Any 403 anywhere: fail closed — drop the token, stop polling, wipe every
    // section's state, and surface the session-expired message on the login form.
    _handleError(e) {
      if (e?.status === 403) {
        this.logout();
        this.loginError = "Session expired — sign in again.";
        return true;
      }
      return false;
    },

    // Validate the entered password against POST /api/admin/auth; on ok persist
    // it and enter the shell, else surface the failure on the login card.
    async login() {
      this.loginError = null;
      const token = this.password.trim();
      if (!token) { this.loginError = "Enter the admin password."; return; }
      try {
        await api.adminPost(ROUTES.admin.auth, token);
        sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
        this.authed = true;
        await this.loadSection();
        this.startPolling();
      } catch (e) {
        this.loginError = e.status === 403 ? "Incorrect admin password." : e.message;
      }
    },

    logout() {
      this._forgetToken();
      this.password = "";
      this.overview = null;
      this.jobs = [];
      this.schedules = [];
      this.summary = { byStatus: {}, byKind: {} };
      this.runs = [];
      this.selectedJob = null;
      this.retryResult = null;
      this.retryError = null;
      this.researchRuns = [];
      this.selectedResearchRun = null;
      this.rerunResult = null;
    },

    // ── navigation ───────────────────────────────────────────────────────
    // Section nav buttons (not <a> tags, so the top-level SPA router's
    // click-interception never fires): update in-memory state, reflect the
    // path for shareable/back-button URLs, and load the new section's data.
    goSection(name) {
      this.section = name;
      this.selectedResearchRunId = null;
      this.selectedResearchRun = null;
      history.pushState({}, "", name === "overview" ? "/admin" : `/admin/${name}`);
      this.loadSection();
    },

    async loadSection() {
      this.lastRefreshedAt = new Date().toISOString();
      if (this.section === "overview") return this.loadOverview();
      if (this.section === "queue") return this.loadQueue();
      if (this.section === "research") {
        if (this.selectedResearchRunId) return this.openResearchRun(this.selectedResearchRunId, { pushUrl: false });
        return this.loadResearchRuns();
      }
    },

    // ── overview (US-A2) ─────────────────────────────────────────────────
    async loadOverview() {
      this.overviewLoading = true;
      this.overviewError = null;
      try {
        this.overview = await api.adminGet(ROUTES.admin.overview, this._token());
        this.summary = this.overview?.queueCounts ? { byStatus: this.overview.queueCounts, byKind: {} } : this.summary;
      } catch (e) {
        if (!this._handleError(e)) this.overviewError = e.message;
      } finally {
        this.overviewLoading = false;
      }
    },
    overviewAlerts() { return this.overview?.alerts || []; },

    // ── queue (US-Q1) ────────────────────────────────────────────────────
    async loadQueue() {
      this.queueLoading = true;
      this.queueError = null;
      try {
        const query = this._queueQuery();
        const data = await api.adminGet(ROUTES.admin.jobs, this._token(), query);
        this.jobs = data.jobs || [];
        this.schedules = data.schedules || [];
        this.summary = data.summary || this.summary;
        const runsData = await api.adminGet(ROUTES.admin.runs, this._token(), query);
        this.runs = runsData.runs || [];
      } catch (e) {
        if (!this._handleError(e)) this.queueError = e.message;
      } finally {
        this.queueLoading = false;
      }
    },
    _queueQuery() {
      const f = this.queueFilters;
      const query = {};
      if (f.kind) query.kind = f.kind;
      if (f.status) query.status = f.status;
      if (f.scopeType) query.scope_type = f.scopeType;
      if (f.scopeId) query.scope_id = f.scopeId;
      return query;
    },
    applyQueueFilters() { this.loadQueue(); },
    clearQueueFilters() {
      this.queueFilters = { kind: "", status: "", scopeType: "", scopeId: "" };
      this.loadQueue();
    },

    // GET /api/admin/jobs/:id → the job + its recent runs (output/error = logs).
    async openJob(id) {
      this.retryResult = null;
      this.retryError = null;
      try {
        this.selectedJob = await api.adminGet(path(ROUTES.admin.job, { id }), this._token());
      } catch (e) {
        if (!this._handleError(e)) this.queueError = e.message;
      }
    },
    closeJob() { this.selectedJob = null; },

    // Retry is available only for a dead job; it clones into a new pending job
    // and never mutates the dead row (docs/plan-admin-surface.md US-Q1).
    canRetry(job) { return job?.status === "dead"; },
    async retryJob(id) {
      this.retryResult = null;
      this.retryError = null;
      const reason = window.prompt("Reason for retrying this dead job (10-500 characters):", "");
      if (reason == null) return; // cancelled
      const trimmed = reason.trim();
      if (trimmed.length < 10 || trimmed.length > 500) {
        this.retryError = "Reason must be 10-500 characters.";
        return;
      }
      try {
        this.retryResult = await api.adminPost(path(ROUTES.admin.jobRetry, { id }), this._token(), { reason: trimmed });
        await this.loadQueue();
      } catch (e) {
        if (!this._handleError(e)) this.retryError = e.message;
      }
    },

    // ── research (US-R1..US-R4) ──────────────────────────────────────────
    async loadResearchRuns() {
      this.researchLoading = true;
      this.researchError = null;
      try {
        const f = this.researchFilters;
        const query = {};
        if (f.kind) query.kind = f.kind;
        if (f.tool) query.tool = f.tool;
        if (f.asof) query.asof = f.asof;
        if (f.status) query.status = f.status;
        if (f.jobId) query.jobId = f.jobId;
        const data = await api.adminGet(ROUTES.admin.researchRuns, this._token(), query);
        this.researchRuns = data.items || [];
      } catch (e) {
        if (!this._handleError(e)) this.researchError = e.message;
      } finally {
        this.researchLoading = false;
      }
    },
    applyResearchFilters() { this.loadResearchRuns(); },
    clearResearchFilters() {
      this.researchFilters = { kind: "", tool: "", asof: "", status: "", jobId: "" };
      this.loadResearchRuns();
    },

    async openResearchRun(id, opts = {}) {
      this.selectedResearchRunId = id;
      this.researchDetailLoading = true;
      this.researchDetailError = null;
      if (opts.pushUrl !== false) history.pushState({}, "", `/admin/research/runs/${encodeURIComponent(id)}`);
      try {
        this.selectedResearchRun = await api.adminGet(path(ROUTES.admin.researchRun, { id }), this._token());
      } catch (e) {
        if (!this._handleError(e)) this.researchDetailError = e.message;
      } finally {
        this.researchDetailLoading = false;
      }
    },
    closeResearchRun() {
      this.selectedResearchRunId = null;
      this.selectedResearchRun = null;
      history.pushState({}, "", "/admin/research");
    },

    stagesOf(detail) { return detail?.stages || []; },

    // regime → the /regime dashboard; a single research tool → its /research/:key
    // page; multiple/unknown tools fall back to the /research index.
    publicReportHref(tools) {
      const list = tools || [];
      if (list.includes("regime")) return "/regime";
      if (list.length === 1) return `/research/${list[0]}`;
      return "/research";
    },
    rawSeriesHref(indicator) { return `/research/${indicator}`; },

    // ── rerun (US-R4) ────────────────────────────────────────────────────
    rerunReasonValid() {
      const len = this.rerun.reason.trim().length;
      return len >= 10 && len <= 500;
    },
    rerunValid() { return !!this.rerun.kind && !!this.rerun.asof && this.rerunReasonValid(); },
    async submitRerun() {
      this.rerunError = null;
      this.rerunResult = null;
      if (!this.rerunValid()) {
        this.rerunError = "kind, as-of date, and a 10-500 character reason are required.";
        return;
      }
      this.rerunSubmitting = true;
      try {
        const body = { kind: this.rerun.kind, asof: this.rerun.asof, reason: this.rerun.reason.trim() };
        if (this.rerun.kind === "research.refresh" && this.rerun.toolId) body.toolId = this.rerun.toolId;
        this.rerunResult = await api.adminPost(ROUTES.admin.researchRerun, this._token(), body);
        await this.loadResearchRuns();
      } catch (e) {
        if (!this._handleError(e)) this.rerunError = e.message;
      } finally {
        this.rerunSubmitting = false;
      }
    },

    // ── polling ──────────────────────────────────────────────────────────
    // Refresh the active section every 5s while signed in, tab visible, and
    // not explicitly paused. Historical detail (an already-open research run
    // stays open, not silently swapped) still refreshes via the same call.
    togglePause() { this.paused = !this.paused; },
    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(() => {
        if (!this.authed || this.paused || document.hidden) return;
        this.loadSection().catch(() => {});
      }, 5000);
    },
    stopPolling() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    },

    // ── formatting ───────────────────────────────────────────────────────
    statusList() {
      // Fixed order matching the jobs.status CHECK constraint, plus any extras.
      const order = ["pending", "running", "succeeded", "failed", "dead", "cancelled"];
      const seen = new Set(order);
      const keys = [...order, ...Object.keys(this.summary.byStatus || {}).filter((k) => !seen.has(k))];
      return keys.map((k) => ({ status: k, count: this.summary.byStatus?.[k] || 0 }));
    },
    statusClass(status) {
      const s = String(status || "");
      if (s === "succeeded" || s === "healthy") return "adm-badge adm-badge--ok";
      if (s === "failed" || s === "dead" || s === "degraded") return "adm-badge adm-badge--err";
      if (s === "running") return "adm-badge adm-badge--run";
      return "adm-badge adm-badge--idle"; // pending / warning / other
    },
    alertClass(level) { return `adm-alert adm-alert--${level || "healthy"}`; },
    fmtTime(iso) {
      if (!iso) return "—";
      try {
        return new Date(iso).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
      } catch (_) { return String(iso); }
    },
    // Pretty-print jsonb output/summary/preview fields (the logs). Objects/arrays
    // → indented JSON; primitives/strings pass through; null/undefined → empty so
    // x-show can hide it. Bound with x-text everywhere (never x-html), so any
    // embedded markup renders as inert text rather than executing.
    prettyJson(value) {
      if (value == null) return "";
      if (typeof value === "string") return value;
      try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
    },
    hasOutput(run) { return !!run && run.output != null; },
  }));
}
