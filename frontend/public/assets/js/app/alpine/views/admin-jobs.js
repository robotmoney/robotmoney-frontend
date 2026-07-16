// Alpine factory for the admin task-queue dashboard (/admin). Moved verbatim
// from the monolithic views.js (finding 025).
import { api, ROUTES, path } from "../../lib/api.js";
import {
  forgetAdminToken,
  isAdminAuthError,
  persistAdminToken,
  readStoredAdminToken,
} from "../../lib/admin-auth.js";

export function registerAdminJobsView(Alpine) {
  // ── Admin task-queue dashboard (/admin) ───────────────────────────────────
  // A password-gated operator view over the research/analytics job queue. The
  // password is the ADMIN_TOKEN secret, sent as X-Admin-Token; the demo prints a
  // random per-launch password to the interactive TUI only. All four endpoints
  // are READ-ONLY (GET /api/admin/jobs|jobs/:id|runs; POST /api/admin/auth just
  // validates the password). The token is kept in sessionStorage (lib/admin-auth.js,
  // shared with the other admin modules) so a refresh stays signed in for the tab,
  // and a 403 anywhere forces re-login (fail-closed).
  Alpine.data("adminJobsView", () => ({
    authed: false,
    password: readStoredAdminToken(),
    loginError: null,
    loading: false,
    error: null,
    jobs: [],
    schedules: [],
    summary: { byStatus: {}, byKind: {} },
    runs: [],
    selectedJob: null, // { job, runs } detail for the opened job
    pollTimer: null,

    // A stored token (from a prior login this tab) → try to load straight into the
    // dashboard; a 403 there clears it and drops back to the login gate.
    async init() {
      if (this.password) {
        try {
          await this.load();
          this.authed = true;
          this.startPolling();
        } catch (e) {
          if (isAdminAuthError(e)) this._forgetToken();
        }
      }
    },

    _forgetToken() {
      forgetAdminToken();
      this.authed = false;
      this.stopPolling();
    },

    // Validate the entered password against POST /api/admin/auth; on ok persist it
    // and enter the dashboard, else surface the failure on the login card.
    async login() {
      this.loginError = null;
      const token = this.password.trim();
      if (!token) { this.loginError = "Enter the admin password."; return; }
      try {
        await api.adminPost(ROUTES.admin.auth, token);
        persistAdminToken(token);
        this.authed = true;
        await this.load();
        this.loadRuns();
        this.startPolling();
      } catch (e) {
        this.loginError = isAdminAuthError(e) ? "Incorrect admin password." : e.message;
      }
    },

    logout() {
      this._forgetToken();
      this.password = "";
      this.jobs = [];
      this.schedules = [];
      this.summary = { byStatus: {}, byKind: {} };
      this.runs = [];
      this.selectedJob = null;
    },

    _token() { return readStoredAdminToken() || this.password.trim(); },

    // GET /api/admin/jobs → jobs + schedules + summary. A 403 here (token revoked
    // or rotated) logs out; other errors surface inline. Rethrows so init() can
    // distinguish the 403 case on first load.
    async load() {
      this.loading = true;
      this.error = null;
      try {
        const data = await api.adminGet(ROUTES.admin.jobs, this._token());
        this.jobs = data.jobs || [];
        this.schedules = data.schedules || [];
        this.summary = data.summary || { byStatus: {}, byKind: {} };
      } catch (e) {
        if (isAdminAuthError(e)) { this.logout(); this.loginError = "Session expired — sign in again."; }
        else this.error = e.message;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    // GET /api/admin/jobs/:id → the job + its recent runs (output/error = logs).
    async openJob(id) {
      try {
        this.selectedJob = await api.adminGet(path(ROUTES.admin.job, { id }), this._token());
      } catch (e) {
        if (isAdminAuthError(e)) this.logout();
        else this.error = e.message;
      }
    },
    closeJob() { this.selectedJob = null; },

    // GET /api/admin/runs → the recent job_runs feed across all jobs.
    async loadRuns() {
      try {
        const data = await api.adminGet(ROUTES.admin.runs, this._token());
        this.runs = data.runs || [];
      } catch (e) {
        if (isAdminAuthError(e)) this.logout();
      }
    },

    // Refresh the jobs table (and open detail, if any) every 5s while signed in.
    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(() => {
        if (!this.authed) return;
        this.load().catch(() => {});
        this.loadRuns();
        if (this.selectedJob?.job?.id != null) this.openJob(this.selectedJob.job.id);
      }, 5000);
    },
    stopPolling() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    },
    destroy() { this.stopPolling(); },

    // ── formatting ────────────────────────────────────────────────────────
    statusList() {
      // Fixed order matching the jobs.status CHECK constraint, plus any extras.
      const order = ["pending", "running", "succeeded", "failed", "dead"];
      const seen = new Set(order);
      const keys = [...order, ...Object.keys(this.summary.byStatus || {}).filter((k) => !seen.has(k))];
      return keys.map((k) => ({ status: k, count: this.summary.byStatus?.[k] || 0 }));
    },
    statusClass(status) {
      const s = String(status || "");
      if (s === "succeeded") return "adm-badge adm-badge--ok";
      if (s === "failed" || s === "dead") return "adm-badge adm-badge--err";
      if (s === "running") return "adm-badge adm-badge--run";
      return "adm-badge adm-badge--idle"; // pending / other
    },
    fmtTime(iso) {
      if (!iso) return "—";
      try {
        return new Date(iso).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
      } catch (_) { return String(iso); }
    },
    // Pretty-print a run's jsonb output (the log). Objects/arrays → indented JSON;
    // primitives/strings pass through; null/undefined → empty so x-show can hide it.
    prettyJson(value) {
      if (value == null) return "";
      if (typeof value === "string") return value;
      try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
    },
    hasOutput(run) { return !!run && run.output != null; },
  }));
}
