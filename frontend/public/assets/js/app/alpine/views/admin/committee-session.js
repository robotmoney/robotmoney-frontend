// Alpine factory for /admin/committee/sessions/:id — UTC-first timeline,
// roster matrix (expected/excused/submitted/absent), read-only accepted
// recommendation detail, aggregate display, and guarded lifecycle transition
// controls. Issue #159 — docs/plan-admin-surface.md §4 US-C3/US-C4/US-C5.
// Nothing here can edit or delete an accepted recommendation — the roster
// mutations only add/excuse/restore expected members, and only before the
// session leaves `scheduled`/`collecting`.
//
// Reconciled to the REAL backend (issue #152/PR #169) per PR #172 review.
// The admin API has NO single-session GET, NO admin session list, and NO
// linked-jobs-by-session or per-transition event feed — this page composes
// its view from three real sources instead of one invented DTO:
//   1. ROUTES.committee.sessions (public list) — id/date/subjectId/state/
//      windowClosesAt/publishedAt, and — once aggregated — the persisted
//      `committeeRecommendation` rollup + `synthesis` prose (committee/
//      domain.ts aggregateSession() writes both columns; toSession() reads
//      them back, so a normal reload picks up post-aggregate data — no need
//      to rely on the one-shot POST response).
//   2. ROUTES.committee.admin.sessionRoster (admin GET) — the frozen
//      expected/excused roster (committee_session_members).
//   3. ROUTES.committee.session (public, by date+subject) — each member's
//      submitted stance/confidence/body/memoUrl/verified. There is no
//      nonce/signature/canonicalPayload anywhere in the read surface (only
//      used server-side to verify a submission) — the "disclosure" here
//      shows body/memoUrl/verified only.
// `session.version` and the two other timeline stamps (briefOpensAt/
// publishAt) are NEVER exposed by any GET route (only transiently on the
// create-session response) — they're dropped from the timeline display, and
// lifecycle actions omit `expectedVersion` (the backend treats it as
// optional: omitted, it skips the optimistic-lock check entirely).
// "Linked jobs" was dropped outright: GET /api/admin/jobs's list query never
// selects `payload`/`scope_id`, so a job can't be attributed to a session
// from the list endpoint at all.
import { api, ROUTES, path } from "../../../lib/api.js";
import { adminAuthState, fmtUtc, fmtLocal } from "./shared.js";

// The only 5 lifecycle actions the admin HTTP surface exposes
// (backend/src/api/routes/committee-admin.ts sessions dispatcher).
// scheduled→collecting ("publish_brief" in the job-kind vocabulary) is
// worker/job-queue-driven only — there is no manual admin action for it.
const ACTION_ROUTE_KEY = {
  cancel: "sessionCancel",
  close: "sessionClose",
  reopen: "sessionReopen",
  aggregate: "sessionAggregate",
  publish: "sessionPublish",
};
const ACTION_LABEL = {
  cancel: "Cancel session",
  close: "Close window",
  reopen: "Reopen window",
  aggregate: "Aggregate",
  publish: "Publish",
};
const REASON_REQUIRED = new Set(["cancel", "close", "reopen"]);

// Mirrors backend/src/committee/admin.ts's TRANSITIONS table, restricted to
// the 5 actions actually reachable over HTTP (guardedTransition's full legal
// matrix also includes scheduled->collecting and window_closed->collecting,
// but nothing in the REST layer can request "collecting" directly except via
// the "reopen" action, whose target state IS collecting).
const LEGAL_ACTIONS_FOR_STATE = {
  scheduled: ["cancel"],
  collecting: ["close", "cancel"],
  window_closed: ["reopen", "aggregate", "cancel"],
  aggregated: ["close", "publish"],
  published: [],
  cancelled: [],
};

export function registerAdminCommitteeSession(Alpine) {
  Alpine.data("adminCommitteeSession", () => ({
    ...adminAuthState(),
    loading: false,
    error: null,
    sessionId: null,
    session: null, // { ...CommitteeSessionSummary, roster: [...] }

    rosterFilter: "all", // all | expected | excused | submitted | absent
    rosterSort: "member", // member | stance | confidence | receivedAt
    expandedRecommendation: null, // memberId whose detail disclosure is open

    // Roster mutation (add/excuse/restore) — only enabled pre-collecting.
    rosterForm: null, // { operation, memberId, reason }
    rosterError: null,
    rosterSubmitting: false,

    // Lifecycle action confirmation dialog.
    actionConfirm: null, // { action, reason }
    actionError: null,
    actionResult: null, // last transition's { state, idempotent }
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
        const listRes = await api.adminGet(ROUTES.committee.sessions, this._token());
        if (!Array.isArray(listRes.sessions)) throw new Error("committee sessions response missing 'sessions' array");
        const summary = listRes.sessions.find((s) => s.id === this.sessionId);
        if (!summary) throw new Error(`session '${this.sessionId}' not found`);

        const rosterRes = await api.adminGet(
          path(ROUTES.committee.admin.sessionRoster, { id: this.sessionId }),
          this._token(),
        );
        if (!Array.isArray(rosterRes.roster)) throw new Error("session roster response missing 'roster' array");

        // Public per-member submission content (stance/confidence/body/memoUrl/
        // verified) — best-effort: a session with no brief/no submissions yet
        // still resolves (empty takes), a genuinely missing date/subject pair
        // (shouldn't happen — the row came from the same table) degrades to no
        // recommendation data rather than failing the whole page.
        let takes = [];
        try {
          const detail = await api.adminGet(
            path(ROUTES.committee.session, { date: summary.date, subject: summary.subjectId }),
            this._token(),
          );
          if (Array.isArray(detail?.takes)) takes = detail.takes;
        } catch (_) {
          // non-fatal — roster + summary still render
        }
        const takeByMember = new Map(takes.map((t) => [t.memberId, t]));

        const roster = rosterRes.roster.map((r) => {
          const take = takeByMember.get(r.member_id);
          return {
            memberId: r.member_id,
            memberName: r.member_name,
            memberLens: r.member_lens,
            rosterStatus: r.status, // expected | excused (frozen roster only)
            includedAt: r.included_at,
            excusedAt: r.excused_at,
            reason: r.reason,
            recommendation: take
              ? { stance: take.stance, confidence: take.confidence, body: take.body, memoUrl: take.memoUrl, verified: take.verified, receivedAt: take.receivedAt }
              : null,
          };
        });

        this.session = { ...summary, roster };
      } catch (e) {
        if (e.status === 403) this._handle403();
        else this.error = e.message;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    // ── Roster matrix ────────────────────────────────────────────────────
    // Derived status for filtering/display: `submitted` when a recommendation
    // was received, `absent` for an expected member with none, else the raw
    // frozen-roster status (expected/excused).
    rowStatus(row) {
      if (row.rosterStatus === "excused") return "excused";
      return row.recommendation ? "submitted" : row.rosterStatus === "expected" ? "absent" : row.rosterStatus;
    },

    rosterRows() {
      const rows = this.session?.roster || [];
      const filtered = this.rosterFilter === "all" ? rows : rows.filter((r) => this.rowStatus(r) === this.rosterFilter);
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
        // Three separate endpoints (add/excuse/restore), never a single PATCH
        // with an `operation` field. No version — roster rows aren't locked.
        const routeKey = { add: "rosterAdd", excuse: "rosterExcuse", restore: "rosterRestore" }[operation];
        await api.adminPost(
          path(ROUTES.committee.admin[routeKey], { id: this.sessionId }),
          this._token(),
          { memberId, reason: trimmed },
        );
        this.rosterForm = null;
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        if (e.status === 409) { this.rosterError = "The session's roster is locked (collection already began) — reload to confirm."; return; }
        if (e.status === 404) { this.rosterError = "That member is not on this session's roster."; return; }
        this.rosterError = e.message;
      } finally {
        this.rosterSubmitting = false;
      }
    },

    // ── Lifecycle actions ────────────────────────────────────────────────
    legalActions() { return LEGAL_ACTIONS_FOR_STATE[this.session?.state] || []; },
    isLegalAction(action) { return this.legalActions().includes(action); },
    actionLabel(action) { return ACTION_LABEL[action] || action; },

    openActionConfirm(action) {
      this.actionConfirm = { action, reason: "" };
      this.actionError = null;
      this.actionResult = null;
    },
    cancelActionConfirm() { this.actionConfirm = null; this.actionError = null; },

    async submitActionConfirm() {
      const { action, reason } = this.actionConfirm;
      const trimmed = String(reason || "").trim();
      if (REASON_REQUIRED.has(action) && (trimmed.length < 10 || trimmed.length > 500)) {
        this.actionError = "Reason must be 10–500 characters.";
        return;
      }
      this.actionSubmitting = true;
      this.actionError = null;
      try {
        // No `expectedVersion`: the backend never exposes a session's current
        // version over any GET route, and the field is optional — omitted, the
        // guarded transition skips the optimistic-lock check.
        const body = {};
        if (trimmed) body.reason = trimmed;
        const res = await api.adminPost(
          path(ROUTES.committee.admin[ACTION_ROUTE_KEY[action]], { id: this.sessionId }),
          this._token(),
          body,
        );
        // Synchronous {ok, status, session:{id,state,version}, idempotent?} —
        // never a 202 job envelope (no jobId/existing field exists on this
        // backend). Defensively tolerate either shape rather than assuming one.
        this.actionResult = {
          state: res?.session?.state ?? null,
          idempotent: !!res?.idempotent,
          jobId: res?.jobId ?? null, // stays null on this backend; kept for forward-compat
        };
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

    // ── Aggregate (read-only; persisted by aggregateSession() onto the
    // session row itself — committeeRecommendation + synthesis — so it
    // survives reload, unlike the rest of the invented AdminSessionAggregate
    // shape this page used to assume). ───────────────────────────────────
    aggregate() { return this.session?.committeeRecommendation || null; },
    synthesis() { return this.session?.synthesis || null; },

    stateClass(state) {
      const s = String(state || "");
      if (s === "published") return "adm-badge adm-badge--ok";
      if (s === "cancelled") return "adm-badge adm-badge--err";
      if (s === "collecting" || s === "window_closed" || s === "aggregated") return "adm-badge adm-badge--run";
      return "adm-badge adm-badge--idle";
    },
  }));
}
