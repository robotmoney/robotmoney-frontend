// Alpine factory for /admin/swarm/sessions/:id — UTC-first timeline, the
// lifecycle the scheduler drove the session through, roster matrix
// (expected/excused/submitted/absent), read-only accepted recommendation
// detail and aggregate display. Issue #159 — docs/architecture.md §4
// US-C3/US-C4/US-C5.
//
// OBSERVE-ONLY (issue #1026, D55 decision 4; docs/architecture/admin-surface.md
// US-C4: "I can see every lifecycle transition the scheduler made, and I cannot
// fire one myself"). The cancel/close/reopen/aggregate/judge/publish buttons are
// gone with the routes they posted to: only `system-scheduler` drives the
// epoch lifecycle. Nothing here can edit or delete an accepted recommendation,
// and the roster mutations (add/excuse/restore) are offered only on a legacy
// `scheduled` session — an epoch's roster is seated when it opens and locked
// from its first instant.
//
// Reconciled to the REAL backend (issue #152/PR #169) per PR #172 review.
// The admin API has NO single-session GET, NO admin session list, and NO
// linked-jobs-by-session or per-transition event feed — this page composes
// its view from three real sources instead of one invented DTO:
//   1. ROUTES.swarm.sessions?full=1 (public list; issue #243 — the
//      default response is now a light, paginated projection that drops
//      `synthesis`, so this admin detail view, which needs synthesis and must
//      be able to find ANY session by id regardless of recency, asks for the
//      pre-#243 unpaginated/unprojected shape explicitly) — id/date/
//      subjectId/state/windowClosesAt/publishedAt, and — once aggregated —
//      the persisted `swarmRecommendation` rollup + `synthesis` prose
//      (swarm/domain.ts aggregateSession() writes both columns;
//      toSession() reads them back, so a normal reload picks up post-
//      aggregate data — no need to rely on the one-shot POST response).
//   2. ROUTES.swarm.admin.sessionRoster (admin GET) — the frozen
//      expected/excused roster (swarm_session_members).
//   3. ROUTES.swarm.session (public, by date+subject) — each member's
//      submitted stance/confidence/body/memoUrl/verified. There is no
//      nonce/signature/canonicalPayload anywhere in the read surface (only
//      used server-side to verify a submission) — the "disclosure" here
//      shows body/memoUrl/verified only.
// `session.version` and the two other timeline stamps (briefOpensAt/
// publishAt) are NEVER exposed by any GET route — they're dropped from the
// timeline display.
// "Linked jobs" was dropped outright: GET /api/admin/jobs's list query never
// selects `payload`/`scope_id`, so a job can't be attributed to a session
// from the list endpoint at all.
import { api, ROUTES, path } from "../../../lib/api.js";
import { adminAuthState, fmtUtc, fmtLocal } from "./shared.js";

// THE EPOCH LIFECYCLE, in order (system-scheduler-spec.md §4; the transitions
// admin-surface.md US-C4 tabulates). Each step is one the scheduler makes;
// this page shows which of them the session has passed, and fires none.
// `judging` and `judged` are passed only when the captured judge mode was
// `enforce` — under `off` finalize publishes straight from `aggregated`
// (§4.4), so a published session that skipped them shows them as skipped.
const LIFECYCLE_STEPS = [
  { state: "collecting", label: "Collecting — the submission window is open" },
  { state: "window_closed", label: "Window closed — turned over, absences recorded" },
  { state: "aggregated", label: "Aggregated — takes rolled up" },
  { state: "judging", label: "Judging requested — deadline stored" },
  { state: "judged", label: "Judged — the judge of record's consensus recorded" },
  { state: "published", label: "Published — finalized" },
];
const STEP_INDEX = Object.fromEntries(LIFECYCLE_STEPS.map((s, i) => [s.state, i]));

export function registerAdminSwarmSession(Alpine) {
  Alpine.data("adminSwarmSession", () => ({
    ...adminAuthState(),
    loading: false,
    error: null,
    sessionId: null,
    session: null, // { ...SwarmSessionSummary, roster: [...] }

    rosterFilter: "all", // all | expected | excused | submitted | absent
    rosterSort: "member", // member | stance | confidence | receivedAt
    expandedRecommendation: null, // memberId whose detail disclosure is open

    // Roster mutation (add/excuse/restore) — only enabled pre-collecting.
    rosterForm: null, // { operation, memberId, reason }
    rosterError: null,
    rosterSubmitting: false,

    // Consensus-judge record (issue #767). Every judge run for this session,
    // newest first, plus which opinion is IN FORCE. Loaded for every session,
    // not only `judged` ones: a `shadow` run records a judgement and NEVER
    // moves the session's state, so gating this on state === 'judged' would
    // hide the entire shadow soak — the exact reading this panel exists for.
    judgements: [],
    inForce: null,
    judgementsError: null,
    expandedJudgement: null,
    // The published consensus receipt (issue #754), if one exists. `null`
    // with no `receiptError` means "not published yet" — the common,
    // unremarkable case for any session whose judgement was `shadow` or
    // never reached `enforce` — distinct from a real fetch failure.
    receipt: null,
    receiptError: null,
    receiptRawExpanded: false,
    // Admin member list (issue #922), fetched best-effort purely to resolve a
    // judgement's judgedByMemberId to a display name in judgeIdentity() below
    // — never required for the roster/aggregate/lifecycle data above, which is
    // why it is not part of load()'s Promise.all.
    members: [],

    fmtUtc, fmtLocal,

    async init() {
      this.sessionId = location.pathname.split("/").filter(Boolean).pop();
      await this.bootWithStoredToken(() => this.load());
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const listRes = await api.adminGet(ROUTES.swarm.sessions, this._token(), { full: "1" });
        if (!Array.isArray(listRes.sessions)) throw new Error("swarm sessions response missing 'sessions' array");
        const summary = listRes.sessions.find((s) => s.id === this.sessionId);
        if (!summary) throw new Error(`session '${this.sessionId}' not found`);

        const rosterRes = await api.adminGet(
          path(ROUTES.swarm.admin.sessionRoster, { id: this.sessionId }),
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
            path(ROUTES.swarm.session, { date: summary.date, subject: summary.subjectId }),
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
        await this.loadJudgements();
        await this.loadConsensusReceipt();
      } catch (e) {
        if (e.status === 403) this._handle403();
        else this.error = e.message;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    // ── Consensus judge record (issue #767) ──────────────────────────────
    // Best-effort like the public take fetch above: a failure here must not
    // blank a page whose roster and aggregate loaded fine. It is reported in
    // place instead, because "no judgements" and "could not read judgements"
    // are different answers and an operator deciding whether to move the mode
    // to `enforce` must not confuse them.
    async loadJudgements() {
      this.judgementsError = null;
      try {
        const res = await api.adminGet(
          path(ROUTES.swarm.admin.sessionJudgements, { id: this.sessionId }),
          this._token(),
        );
        this.judgements = Array.isArray(res?.judgements) ? res.judgements : [];
        this.inForce = res?.inForce ?? null;
      } catch (e) {
        if (e.status === 403) throw e; // the page-level 403 handler owns this
        this.judgements = [];
        this.inForce = null;
        this.judgementsError = e.message;
      }
      // Admin member list, best-effort (issue #922) — the SAME "must not blank
      // a page whose real data loaded fine" shape as load()'s public take
      // fetch above. Only used to resolve judgedByMemberId to a display name;
      // judgeIdentity() falls back to the raw judgedBy string when this list
      // is empty or does not carry the id, so a failure here degrades display
      // only, never the judgements panel itself.
      try {
        const membersRes = await api.adminGet(ROUTES.swarm.admin.members, this._token());
        this.members = Array.isArray(membersRes?.members) ? membersRes.members : [];
      } catch (_) {
        this.members = [];
      }
    },
    // Who judged (issue #918/#922), resolved to a display name when
    // judgedByMemberId names a member on the admin roster — mirrors
    // swarm-subject.js's memberLabel() shape — else the raw judgedBy string:
    // 'robotmoney-in-house' for the anonymous default, or an id the roster no
    // longer carries.
    judgeIdentity(j) {
      if (!j || !j.judgedBy) return "—";
      if (!j.judgedByMemberId) return j.judgedBy;
      const m = this.members.find((x) => x.id === j.judgedByMemberId);
      return m ? `${m.name} (${m.id})` : j.judgedBy;
    },
    toggleJudgement(id) {
      this.expandedJudgement = this.expandedJudgement === id ? null : id;
    },

    // ── Consensus receipt (issue #754) ────────────────────────────────────
    // The route is public (GET /api/swarm/sessions/:id/consensus-receipt/verified,
    // the read-time-verified ENVELOPE — this page renders `verified`, the
    // per-signature verdicts and `unverifiedReasons`, so it wants the envelope
    // and not the anchored bare bytes its sibling path serves (decision D10) —
    // same admin-page-calls-a-public-route shape load()
    // already uses for the per-member take detail above), and 404 means "not
    // published yet", not a failure: an off/shadow-judged session, or an
    // enforce-judged one nobody has published a receipt for yet, is the
    // ordinary case this page must render quietly rather than as an error.
    async loadConsensusReceipt() {
      this.receipt = null;
      this.receiptError = null;
      try {
        this.receipt = await api.adminGet(
          path(ROUTES.swarm.sessionConsensusReceiptVerified, { id: this.sessionId }),
          this._token(),
        );
      } catch (e) {
        if (e.status === 403) throw e; // the page-level 403 handler owns this
        if (e.status === 404) return; // not published — leave receipt null, quietly
        this.receiptError = e.message;
      }
    },
    toggleReceiptRaw() {
      this.receiptRawExpanded = !this.receiptRawExpanded;
    },
    // `verified` is recomputed by the server on every read (never a stored
    // column) — the same badge classes the session-state pill uses (ok/err),
    // reused rather than invented, so "verified" reads the same green as
    // "published" everywhere else on this page.
    receiptStateClass() {
      return this.receipt?.verified ? "adm-badge adm-badge--ok" : "adm-badge adm-badge--err";
    },
    // bps -> a "NN.NN%" string, matching the convention `weight_bps` names —
    // basis points, not a fraction — so this is the one place that math is
    // done rather than every caller repeating it.
    receiptWeightPct(bps) {
      return `${(Number(bps || 0) / 100).toFixed(2)}%`;
    },
    // What actually happened to the session, in one phrase. `mode` alone does
    // not answer it: an `enforce` opinion formed while the session was
    // publishing is recorded and does NOT reach the prose.
    //
    // AND `applied` ALONE DOES NOT ANSWER IT EITHER (issue #806). `applied` is a
    // fact about the moment the judging committed. Two legal admin actions
    // afterwards — close, then aggregate — have `domain.aggregateSession`
    // replace `swarm_recommendation` wholesale, taking the judge's prose with
    // it. This panel used to render "applied to the session" over prose the
    // session no longer carried, which is the one sentence an operator grading a
    // soak must be able to trust. `carriedBySession` is the backend's
    // reconciliation of the row against the session as it stands now.
    judgementEffect(j) {
      if (!j) return "—";
      if (j.mode !== "enforce") return "recorded only (shadow)";
      if (!j.applied) return `recorded, NOT applied (${j.appliedSkippedReason || "unknown reason"})`;
      // `=== false` on purpose: a response from before this field existed leaves
      // it undefined, and that must read as the old answer rather than as loss.
      if (j.carriedBySession === false) {
        return `applied, then SUPERSEDED — the session no longer carries it (${j.supersededReason || "unknown reason"})`;
      }
      return "applied to the session";
    },
    // A partial drop is not a fallback — `source` stays "model" — so it needs
    // its own line or it reads as a clean model answer.
    judgementIntegrity(j) {
      if (!j) return "—";
      if (j.source === "fallback") return `template prose (${j.fallbackReason || "unknown reason"})`;
      if (!j.partiallyDegraded) return "model prose, complete";
      const d = j.dropped || {};
      return `model prose, PARTIAL — ${d.positions || 0} position(s), ${d.disagreements || 0} disagreement(s) dropped`;
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
    // Only a legacy `scheduled` session takes roster edits: the backend refuses
    // add/excuse/restore once collection begins, and an epoch is `collecting`
    // from its first instant, so offering them there would offer a 409.
    rosterEditable() { return this.session?.state === "scheduled"; },

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
          path(ROUTES.swarm.admin[routeKey], { id: this.sessionId }),
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

    // ── Lifecycle (observe-only) ─────────────────────────────────────────
    // One row per epoch step, marked `done`, `current`, `pending` or
    // `skipped`. A step before the current one that a published session never
    // held (judging/judged under judge mode `off`) is `skipped`, which is read
    // off the judgements panel: no judgement on record means judging never ran.
    lifecycleSteps() {
      const state = this.session?.state;
      const current = STEP_INDEX[state];
      const judged = this.judgements.length > 0;
      return LIFECYCLE_STEPS.map((step, i) => {
        let status = "pending";
        if (state === "cancelled") status = "skipped";
        else if (current === undefined) status = "pending";
        else if (i === current) status = "current";
        else if (i < current) status = (step.state === "judging" || step.state === "judged") && !judged ? "skipped" : "done";
        return { ...step, status };
      });
    },
    stepClass(status) {
      if (status === "done") return "adm-badge adm-badge--ok";
      if (status === "current") return "adm-badge adm-badge--run";
      return "adm-badge adm-badge--idle";
    },

    // ── Aggregate (read-only; persisted by aggregateSession() onto the
    // session row itself — swarmRecommendation + synthesis — so it
    // survives reload, unlike the rest of the invented AdminSessionAggregate
    // shape this page used to assume). ───────────────────────────────────
    aggregate() { return this.session?.swarmRecommendation || null; },
    synthesis() { return this.session?.synthesis || null; },

    stateClass(state) {
      const s = String(state || "");
      if (s === "published") return "adm-badge adm-badge--ok";
      if (s === "cancelled") return "adm-badge adm-badge--err";
      if (s === "collecting" || s === "window_closed" || s === "aggregated" || s === "judged") return "adm-badge adm-badge--run";
      return "adm-badge adm-badge--idle";
    },
  }));
}
