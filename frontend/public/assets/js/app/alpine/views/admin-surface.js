// Alpine factory for the admin operator surface (/admin and its subpaths).
// Supersedes the old single-table adminJobsView (issue #157;
// docs/architecture.md §7). One shell fragment serves every /admin/*
// path (frontend/public/assets/js/app/routes.js maps the whole subtree to
// this view); this component reads location.pathname at init to decide which
// section to render and keeps navigating with history.pushState so deep links
// like /admin/research/runs/:id are shareable. Swarm topic/member/roster/
// session management is explicitly OUT of scope for this view (#157 scope) —
// only overview, research (pipeline telemetry), queue (jobs/schedules/retry),
// and the audit log operate through it.
//
// Auth: unchanged from the prior dashboard — the ADMIN_TOKEN secret is sent as
// X-Admin-Token and kept in sessionStorage (rm_admin_token) so a refresh stays
// signed in for the tab; any 403 forces re-login (fail-closed) and clears all
// section state so nothing sensitive lingers in memory.
//
// Queue schedule toggles and the redacted audit log (issue #155,
// docs/architecture.md US-Q1 schedule-toggle acceptance / US-A3) are additive on top of the #157
// shell: schedule enable/disable lives inside the existing Queue section, and
// audit gets its own top-level nav section.
import { api, ROUTES, path } from "../../lib/api.js";
import { startRegistration, startAuthentication } from "../../lib/webauthn-client.js";

const ADMIN_TOKEN_KEY = "rm_admin_token";

function sectionFromPath(pathname) {
  if (pathname.startsWith("/admin/research")) return "research";
  if (pathname.startsWith("/admin/queue")) return "queue";
  if (pathname.startsWith("/admin/audit")) return "audit";
  if (pathname.startsWith("/admin/security")) return "security";
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
    isClaimed: null, // null = probing, true = claimed, false = unclaimed
    claimToken: "",
    newPassword: "",
    claimError: null,
    claimResult: null,
    claimSubmitting: false,
    passkeyLoading: false,
    passkeyError: null,
    passkeySuccess: null,

    // ── password recovery ────────────────────────────────────────────────
    recoveryMode: false,
    recoveryCode: "",
    recoveryNewPassword: "",
    recoveryError: null,
    recoveryResult: null,

    // ── password change ──────────────────────────────────────────────────
    changeCurrentPassword: "",
    changeNewPassword: "",
    changeError: null,
    changeResult: null,

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
    schedulePending: null, // schedule id currently being toggled (US-Q1 schedule-toggle acceptance)

    // ── audit (US-A3) ────────────────────────────────────────────────────
    auditItems: [],
    auditNextCursor: null,
    auditFilters: { actor: "", action: "", targetType: "", targetId: "" },
    auditLoading: false,
    auditError: null,

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
      await this.probeClaim();
      if (this.password && this.isClaimed) {
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

    async probeClaim() {
      try {
        const res = await api.get(ROUTES.admin.isClaimed);
        this.isClaimed = res.claimed === true;
      } catch (e) {
        this.isClaimed = true; // fail closed into the normal login gate on error
      }
    },

    async submitClaim() {
      this.claimError = null;
      this.claimResult = null;
      const setupToken = this.claimToken.trim();
      const password = this.newPassword.trim();
      if (!setupToken || !password) {
        this.claimError = "Setup token and durable password are required.";
        return;
      }
      this.claimSubmitting = true;
      try {
        // The setup token authorizes this one-time claim in the request header,
        // so it is not included in a JSON body that request middleware may log.
        this.claimResult = await api.adminPost(ROUTES.admin.claim, setupToken, { password });
        this.isClaimed = true;
      } catch (e) {
        this.claimError = e.message;
      } finally {
        this.claimSubmitting = false;
      }
    },

    finishClaim() {
      this.claimToken = "";
      this.newPassword = "";
      this.claimResult = null;
    },

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

    async loginWithPasskey() {
      this.loginError = null;
      this.passkeyLoading = true;
      try {
        const options = await api.adminGet(ROUTES.admin.webauthnAuthOptions);
        const asseResp = await startAuthentication({ optionsJSON: options });
        const verifyRes = await api.adminPost(ROUTES.admin.webauthnAuthVerify, null, asseResp);
        if (verifyRes.verified && verifyRes.token) {
          sessionStorage.setItem(ADMIN_TOKEN_KEY, verifyRes.token);
          this.authed = true;
          await this.loadSection();
          this.startPolling();
        } else {
          this.loginError = "Passkey verification failed.";
        }
      } catch (e) {
        this.loginError = e.name === "NotAllowedError" ? "Passkey interaction cancelled." : e.message;
      } finally {
        this.passkeyLoading = false;
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
      this.schedulePending = null;
      this.auditItems = [];
      this.auditNextCursor = null;
      this.auditError = null;
      this.claimToken = "";
      this.newPassword = "";
      this.claimError = null;
      this.claimResult = null;
      this.claimSubmitting = false;
      this.recoveryMode = false;
      this.recoveryCode = "";
      this.recoveryNewPassword = "";
      this.recoveryResult = null;
      this.recoveryError = null;
      this.changeCurrentPassword = "";
      this.changeNewPassword = "";
      this.changeResult = null;
      this.changeError = null;
    },

    // ── password management ──────────────────────────────────────────────
    async recoverPassword() {
      this.recoveryError = null;
      this.recoveryResult = null;
      const code = this.recoveryCode.trim();
      const pass = this.recoveryNewPassword.trim();
      if (!code || pass.length < 12) {
        this.recoveryError = "Code required, and new password must be at least 12 characters.";
        return;
      }
      try {
        const res = await api.adminPost(ROUTES.admin.passwordRecover, null, { recoveryCode: code, newPassword: pass });
        this.recoveryResult = res;
      } catch (e) {
        this.recoveryError = e.message;
      }
    },

    async changePassword() {
      this.changeError = null;
      this.changeResult = null;
      const curr = this.changeCurrentPassword.trim();
      const next = this.changeNewPassword.trim();
      if (next.length < 12) {
        this.changeError = "New password must be at least 12 characters.";
        return;
      }
      try {
        const res = await api.adminPost(ROUTES.admin.passwordChange, this._token(), { currentPassword: curr, newPassword: next });
        this.changeResult = res;
        this.changeCurrentPassword = "";
        this.changeNewPassword = "";
        sessionStorage.setItem(ADMIN_TOKEN_KEY, next);
        this.password = next;
      } catch (e) {
        this.changeError = e.message;
      }
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
      if (this.section === "audit") return this.loadAudit();
      if (this.section === "security") return; // No load action needed for security section
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
    // and never mutates the dead row (docs/architecture.md US-Q1).
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

    // PATCH /api/admin/schedules/:id — toggle ONLY `enabled` on an analytics
    // schedule (US-Q1 schedule-toggle acceptance). Cron/timezone/kind/payload are read-only; the
    // swarm.* demo rows are protected server-side (409) and never offered
    // a toggle control here.
    isSwarmSchedule(schedule) { return String(schedule?.kind || "").startsWith("swarm."); },
    async toggleSchedule(schedule) {
      const reason = window.prompt(
        `Reason for ${schedule.enabled ? "disabling" : "enabling"} "${schedule.kind}" (10-500 characters):`, "",
      );
      if (reason == null) return; // cancelled
      const trimmed = reason.trim();
      if (trimmed.length < 10 || trimmed.length > 500) {
        this.queueError = "Reason must be 10-500 characters.";
        return;
      }
      this.schedulePending = schedule.id;
      try {
        await api.adminPatch(path(ROUTES.admin.schedule, { id: schedule.id }), this._token(), {
          enabled: !schedule.enabled,
          reason: trimmed,
        });
        await this.loadQueue();
      } catch (e) {
        if (!this._handleError(e)) this.queueError = e.message;
      } finally {
        this.schedulePending = null;
      }
    },

    // ── audit (US-A3) ────────────────────────────────────────────────────
    // GET /api/admin/audit → redacted (token/header/cookie/secret/password/
    // signature keys stripped server-side before the row leaves the process),
    // filtered, cursor-paginated audit_log feed.
    _auditQuery() {
      const f = this.auditFilters;
      const query = {};
      if (f.actor) query.actor = f.actor;
      if (f.action) query.action = f.action;
      if (f.targetType) query.targetType = f.targetType;
      if (f.targetId) query.targetId = f.targetId;
      return query;
    },
    async loadAudit({ append = false } = {}) {
      this.auditLoading = true;
      this.auditError = null;
      try {
        const query = this._auditQuery();
        if (append && this.auditNextCursor) query.cursor = this.auditNextCursor;
        const data = await api.adminGet(ROUTES.admin.audit, this._token(), query);
        this.auditItems = append ? [...this.auditItems, ...(data.items || [])] : (data.items || []);
        this.auditNextCursor = data.nextCursor || null;
      } catch (e) {
        if (!this._handleError(e)) this.auditError = e.message;
      } finally {
        this.auditLoading = false;
      }
    },
    applyAuditFilters() { this.loadAudit(); },
    clearAuditFilters() {
      this.auditFilters = { actor: "", action: "", targetType: "", targetId: "" };
      this.loadAudit();
    },
    loadMoreAudit() { if (this.auditNextCursor) this.loadAudit({ append: true }); },

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

    // ── security (US-S1 passkeys) ────────────────────────────────────────
    async registerPasskey() {
      this.passkeyError = null;
      this.passkeySuccess = null;
      this.passkeyLoading = true;
      try {
        const options = await api.adminGet(ROUTES.admin.webauthnRegisterOptions, this._token());
        const attResp = await startRegistration({ optionsJSON: options });
        const verifyRes = await api.adminPost(ROUTES.admin.webauthnRegisterVerify, this._token(), attResp);

        if (verifyRes.verified) {
          this.passkeySuccess = "Passkey registered successfully.";
        } else {
          this.passkeyError = "Passkey registration failed.";
        }
      } catch (e) {
        if (!this._handleError(e)) {
          this.passkeyError = e.name === "NotAllowedError" ? "Passkey interaction cancelled." : e.message;
        }
      } finally {
        this.passkeyLoading = false;
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
