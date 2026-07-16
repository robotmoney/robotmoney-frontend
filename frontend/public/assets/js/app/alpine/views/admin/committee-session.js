// Alpine factory for /admin/committee/sessions/:id — UTC-first timeline, roster
// matrix (expected/excused/submitted/absent), read-only accepted recommendation
// detail with a collapsed signature/canonical-payload disclosure, aggregate
// display, and guarded lifecycle transition controls. Issue #159 —
// docs/plan-admin-surface.md §4 US-C3/US-C4/US-C5. Nothing here can edit or
// delete an accepted recommendation — the roster patch only adds/excuses/
// restores expected members, and only before the session reaches `collecting`.
import { api, ROUTES, path } from "../../../lib/api.js";
import { adminAuthState, fmtUtc, fmtLocal } from "./shared.js";

// Actions requiring a reason per docs/plan-admin-surface.md §6.3.
const REASON_REQUIRED = new Set(["cancel", "close_window", "reopen_window"]);
const ACTION_LABEL = {
  publish_brief: "Publish brief (open collection)",
  close_window: "Close window",
  reopen_window: "Reopen window",
  aggregate: "Aggregate",
  publish: "Publish",
  cancel: "Cancel session",
};

export function registerAdminCommitteeSession(Alpine) {
  Alpine.data("adminCommitteeSession", () => ({
    ...adminAuthState(),
    loading: false,
    error: null,
    sessionId: null,
    session: null,

    rosterFilter: "all", // all | expected | excused | submitted | absent
    rosterSort: "member", // member | stance | confidence | receivedAt
    expandedRecommendation: null, // memberId whose signature/payload disclosure is open

    // Roster mutation (add/excuse/restore) — only enabled pre-collecting.
    rosterForm: null, // { operation, memberId, reason }
    rosterError: null,
    rosterSubmitting: false,

    // Lifecycle action confirmation dialog.
    actionConfirm: null, // { action, reason, windowClosesAt }
    actionError: null,
    actionResult: null, // last 202 envelope: { jobId, existing }
    actionSubmitting: false,

    fmtUtc, fmtLocal,

    async init() {
      this.sessionId = location.pathname.split("/").filter(Boolean).pop();
      await this.bootWithStoredToken(() => this.load());
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        this.session = await api.adminGet(path(ROUTES.admin.committee.session, { id: this.sessionId }), this._token());
      } catch (e) {
        if (e.status === 403) this._handle403();
        else this.error = e.message;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    // ── Roster matrix ────────────────────────────────────────────────────
    rosterRows() {
      const rows = this.session?.roster || [];
      const filtered = this.rosterFilter === "all" ? rows : rows.filter((r) => r.status === this.rosterFilter);
      const sorted = [...filtered].sort((a, b) => {
        if (this.rosterSort === "stance") return String(a.recommendation?.stance || "").localeCompare(String(b.recommendation?.stance || ""));
        if (this.rosterSort === "confidence") return (b.recommendation?.confidence || 0) - (a.recommendation?.confidence || 0);
        if (this.rosterSort === "receivedAt") return String(b.recommendation?.receivedAt || "").localeCompare(String(a.recommendation?.receivedAt || ""));
        return String(a.memberName || a.memberId).localeCompare(String(b.memberName || b.memberId));
      });
      return sorted;
    },
    toggleDisclosure(memberId) {
      this.expandedRecommendation = this.expandedRecommendation === memberId ? null : memberId;
    },
    rosterEditable() { return this.session?.state === "scheduled" || this.session?.state === "collecting"; },

    openRosterForm(operation, memberId = "") {
      this.rosterForm = { operation, memberId, reason: "" };
      this.rosterError = null;
    },
    cancelRosterForm() { this.rosterForm = null; this.rosterError = null; },

    async submitRosterForm() {
      const { operation, memberId, reason } = this.rosterForm;
      const trimmed = String(reason || "").trim();
      if (!memberId) { this.rosterError = "Member id is required."; return; }
      if (trimmed.length < 10 || trimmed.length > 500) { this.rosterError = "Reason must be 10–500 characters."; return; }
      this.rosterSubmitting = true;
      try {
        await api.adminPatch(
          path(ROUTES.admin.committee.sessionRoster, { id: this.sessionId }),
          this._token(),
          { version: this.session.version, operation, memberId, reason: trimmed },
        );
        this.rosterForm = null;
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        if (e.status === 409) { this.rosterError = "The session changed since you loaded it (stale version or illegal state) — reload and try again."; return; }
        this.rosterError = e.message;
      } finally {
        this.rosterSubmitting = false;
      }
    },

    // ── Lifecycle actions ────────────────────────────────────────────────
    legalActions() { return this.session?.nextLegalActions || []; },
    isLegalAction(action) { return this.legalActions().includes(action); },
    actionLabel(action) { return ACTION_LABEL[action] || action; },

    openActionConfirm(action) {
      this.actionConfirm = { action, reason: "", windowClosesAt: "" };
      this.actionError = null;
      this.actionResult = null;
    },
    cancelActionConfirm() { this.actionConfirm = null; this.actionError = null; },

    async submitActionConfirm() {
      const { action, reason, windowClosesAt } = this.actionConfirm;
      const trimmed = String(reason || "").trim();
      if (REASON_REQUIRED.has(action) || action === "reopen_window") {
        if (trimmed.length < 10 || trimmed.length > 500) {
          this.actionError = "Reason must be 10–500 characters.";
          return;
        }
      }
      if (action === "reopen_window" && !windowClosesAt) {
        this.actionError = "A new window-close time is required to reopen.";
        return;
      }
      this.actionSubmitting = true;
      this.actionError = null;
      try {
        const body = { version: this.session.version };
        if (trimmed) body.reason = trimmed;
        if (action === "reopen_window") body.windowClosesAt = windowClosesAt;
        const res = await api.adminPost(
          path(ROUTES.admin.committee.sessionAction, { id: this.sessionId, action }),
          this._token(),
          body,
        );
        this.actionResult = { jobId: res.jobId, existing: !!res.existing };
        this.actionConfirm = null;
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        if (e.status === 409) {
          this.actionError = "That transition is not legal from the session's current state (409).";
          return;
        }
        this.actionError = e.message;
      } finally {
        this.actionSubmitting = false;
      }
    },

    stateClass(state) {
      const s = String(state || "");
      if (s === "published") return "adm-badge adm-badge--ok";
      if (s === "cancelled") return "adm-badge adm-badge--err";
      if (s === "collecting" || s === "window_closed" || s === "aggregated") return "adm-badge adm-badge--run";
      return "adm-badge adm-badge--idle";
    },
  }));
}
