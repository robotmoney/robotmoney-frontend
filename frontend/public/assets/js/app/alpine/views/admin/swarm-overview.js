// Alpine factory for /admin/swarm: topics/members/sessions overview,
// topic create, member manual-add (one-time credential reveal), and session
// scheduling. Issue #159 — see docs/architecture.md §4 US-C1/US-C2/US-C3.
//
// Reconciled to the REAL backend (issue #152/PR #169, backend/src/api/routes/
// swarm-admin.ts) per PR #172 review: routes live at
// ROUTES.swarm.admin.* (not a since-removed ROUTES.admin.swarm.*),
// topics/members list envelopes are keyed `subjects`/`members` (not `items`),
// and there is no admin session-list endpoint at all — the sessions tab reads
// the PUBLIC ROUTES.swarm.sessions list instead (issue #152's admin
// surface only exposes session CREATE + per-session roster/lifecycle).
import { api, ROUTES, path } from "../../../lib/api.js";
import { adminAuthState, fmtUtc, fmtLocal } from "./shared.js";

const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REASON_MIN = 10;
const REASON_MAX = 500;

function reasonError(reason) {
  const r = String(reason || "").trim();
  if (r.length < REASON_MIN || r.length > REASON_MAX) {
    return `Reason must be ${REASON_MIN}–${REASON_MAX} characters.`;
  }
  return null;
}

function emptyTopicForm() {
  return {
    id: "", name: "", operator: "", thesisBlurb: "",
    sourceType: "manual", recommendationType: "position_actions",
    wallets: [], linkedMemberId: "", reason: "",
  };
}

function validateTopic(form) {
  const errors = {};
  if (!TOPIC_ID_RE.test(form.id || "")) {
    errors.id = "Topic id must match ^[a-z0-9][a-z0-9-]{1,63}$.";
  }
  if (!form.name?.trim()) errors.name = "Name is required.";
  if (!form.operator?.trim()) errors.operator = "Operator is required.";
  if (!form.thesisBlurb?.trim()) errors.thesisBlurb = "Thesis is required.";
  if (form.sourceType === "framework" && form.wallets.length > 0) {
    errors.wallets = "framework topics must not have wallets.";
  }
  if (form.sourceType === "rpc" && form.wallets.length === 0) {
    errors.wallets = "rpc topics require at least one wallet.";
  }
  const reasonErr = reasonError(form.reason);
  if (reasonErr) errors.reason = reasonErr;
  return errors;
}

function emptyMemberForm() {
  return { memberId: "", name: "", publicKey: "", contactEmail: "", lens: "", reason: "" };
}

function validateManualMember(form) {
  const errors = {};
  if (!form.memberId?.trim()) errors.memberId = "Member id is required.";
  if (!form.name?.trim()) errors.name = "Name is required.";
  if (!form.publicKey?.trim()) errors.publicKey = "Public key is required.";
  const reasonErr = reasonError(form.reason);
  if (reasonErr) errors.reason = reasonErr;
  return errors;
}

function emptySessionForm() {
  return { subjectId: "", date: "", briefOpensAt: "", windowClosesAt: "", publishAt: "", reason: "" };
}

function validateSession(form) {
  const errors = {};
  if (!form.subjectId) errors.subjectId = "Select an active topic.";
  if (!form.date) errors.date = "Session date is required.";
  if (!form.briefOpensAt) errors.briefOpensAt = "Brief-open time is required.";
  if (!form.windowClosesAt) errors.windowClosesAt = "Window-close time is required.";
  if (!form.publishAt) errors.publishAt = "Publish time is required.";
  if (form.briefOpensAt && form.windowClosesAt && form.publishAt) {
    const opens = Date.parse(form.briefOpensAt);
    const closes = Date.parse(form.windowClosesAt);
    const publishes = Date.parse(form.publishAt);
    if (!(opens < closes && closes < publishes)) {
      errors.order = "Times must satisfy briefOpensAt < windowClosesAt < publishAt.";
    }
  }
  const reasonErr = reasonError(form.reason);
  if (reasonErr) errors.reason = reasonErr;
  return errors;
}

export function registerAdminSwarmOverview(Alpine) {
  Alpine.data("adminSwarmOverview", () => ({
    ...adminAuthState(),
    tab: "topics", // topics | members | sessions
    loading: false,
    error: null,
    topics: [],
    members: [],
    sessions: [],
    memberFilter: "active", // applied | active | inactive

    topicForm: emptyTopicForm(),
    topicErrors: {},
    topicSubmitting: false,
    showTopicForm: false,

    memberForm: emptyMemberForm(),
    memberErrors: {},
    memberSubmitting: false,
    showMemberForm: false,
    credentialReveal: null, // { memberId, token }

    sessionForm: emptySessionForm(),
    sessionErrors: {},
    sessionSubmitting: false,
    showSessionForm: false,

    fmtUtc, fmtLocal,

    async init() {
      await this.bootWithStoredToken(() => this.loadAll());
    },

    setTab(tab) { this.tab = tab; },

    async loadAll() {
      this.loading = true;
      this.error = null;
      try {
        const [topicsRes, membersRes, sessionsRes] = await Promise.all([
          api.adminGet(ROUTES.swarm.admin.subjects, this._token()),
          api.adminGet(ROUTES.swarm.admin.members, this._token()),
          // No admin session-list route exists — the public list is the only
          // place `state`/date/subject are ever enumerable together. ?full=1
          // (issue #243) keeps this admin view on the pre-#243 unpaginated/
          // unprojected response — the public route's default is now a light,
          // paginated projection.
          api.adminGet(ROUTES.swarm.sessions, this._token(), { full: "1" }),
        ]);
        // Defensive shape validation (PR #172 review): a response missing its
        // expected array key is a contract mismatch, not an empty list — treat
        // it the same as the existing 403/409 error path rather than silently
        // rendering an empty page.
        if (!Array.isArray(topicsRes.subjects)) throw new Error("admin subjects response missing 'subjects' array");
        if (!Array.isArray(membersRes.members)) throw new Error("admin members response missing 'members' array");
        if (!Array.isArray(sessionsRes.sessions)) throw new Error("swarm sessions response missing 'sessions' array");
        this.topics = topicsRes.subjects;
        this.members = membersRes.members;
        this.sessions = sessionsRes.sessions;
      } catch (e) {
        if (e.status === 403) this._handle403();
        else this.error = e.message;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    filteredMembers() {
      return this.members.filter((m) => (m.status || "applied") === this.memberFilter);
    },

    activeTopics() {
      return this.topics.filter((t) => t.status === "active");
    },

    // ── Topic create ─────────────────────────────────────────────────────
    addWalletRow() { this.topicForm.wallets.push({ address: "", chain: "", label: "" }); },
    removeWalletRow(i) { this.topicForm.wallets.splice(i, 1); },

    async submitTopic() {
      this.topicErrors = validateTopic(this.topicForm);
      if (Object.keys(this.topicErrors).length > 0) return;
      this.topicSubmitting = true;
      try {
        const body = {
          id: this.topicForm.id,
          name: this.topicForm.name,
          operator: this.topicForm.operator,
          thesisBlurb: this.topicForm.thesisBlurb,
          wallets: this.topicForm.wallets,
          nftContracts: [],
          source: { type: this.topicForm.sourceType },
          recommendationType: this.topicForm.recommendationType,
          linkedMemberId: this.topicForm.linkedMemberId || null,
          structuralNotes: [],
          reason: this.topicForm.reason,
        };
        await api.adminPost(ROUTES.swarm.admin.subjects, this._token(), body);
        this.showTopicForm = false;
        this.topicForm = emptyTopicForm();
        await this.loadAll();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        this.topicErrors.form = e.message;
      } finally {
        this.topicSubmitting = false;
      }
    },

    // ── Member manual add ────────────────────────────────────────────────
    async submitManualMember() {
      this.memberErrors = validateManualMember(this.memberForm);
      if (Object.keys(this.memberErrors).length > 0) return;
      this.memberSubmitting = true;
      try {
        const body = {
          memberId: this.memberForm.memberId,
          name: this.memberForm.name,
          publicKey: this.memberForm.publicKey,
          // Backend field is `contact`, not `contactEmail`
          // (backend/src/api/validation.ts parseManualMember).
          contact: this.memberForm.contactEmail || null,
          lens: this.memberForm.lens || null,
          reason: this.memberForm.reason,
        };
        const res = await api.adminPost(ROUTES.swarm.admin.members, this._token(), body);
        this.showMemberForm = false;
        // addMemberAdmin() returns `token` at the top level, not `credential.token`.
        this.credentialReveal = { memberId: this.memberForm.memberId, token: res.token || "" };
        this.memberForm = emptyMemberForm();
        await this.loadAll();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        this.memberErrors.form = e.message;
      } finally {
        this.memberSubmitting = false;
      }
    },
    dismissCredential() { this.credentialReveal = null; },

    // ── Session scheduling ───────────────────────────────────────────────
    async submitSession() {
      this.sessionErrors = validateSession(this.sessionForm);
      if (Object.keys(this.sessionErrors).length > 0) return;
      this.sessionSubmitting = true;
      try {
        const body = { ...this.sessionForm };
        await api.adminPost(ROUTES.swarm.admin.sessionCreate, this._token(), body);
        this.showSessionForm = false;
        this.sessionForm = emptySessionForm();
        await this.loadAll();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        this.sessionErrors.form = e.message;
      } finally {
        this.sessionSubmitting = false;
      }
    },

    stateClass(state) {
      const s = String(state || "");
      if (s === "published") return "adm-badge adm-badge--ok";
      if (s === "cancelled") return "adm-badge adm-badge--err";
      if (s === "collecting" || s === "window_closed" || s === "aggregated") return "adm-badge adm-badge--run";
      return "adm-badge adm-badge--idle";
    },

    memberHref(id) { return path(`/admin/swarm/members/:id`, { id }); },
    topicHref(id) { return path(`/admin/swarm/subjects/:id`, { id }); },
    sessionHref(id) { return path(`/admin/swarm/sessions/:id`, { id }); },
  }));
}
