// Alpine factory for /admin/swarm/members/:id — member detail, activation/
// deactivation/reactivation/key-rotation/rejection with confirm+reason, and a
// one-time credential reveal. Issue #159 — docs/architecture.md §4 US-C2.
//
// Reconciled to the REAL backend (issue #152/PR #169) per PR #172 review:
// - No GET .../members/:id — this page fetches the admin members LIST and
//   picks its row client-side (same pattern as swarm-subject.js).
// - `applicationStatus`, `activeKeyId`, `activeKeyCreatedAt`, and cross-session
//   `participation` do not exist on the backend's member projection
//   (toMemberAdmin()) or any other admin route — "applied" status is
//   cross-referenced against GET .../applications instead, and the
//   participation/active-key sections are dropped rather than faked.
// - activate/reject are the SAME endpoint (POST .../review, body {decision}),
//   not two separate routes, and neither takes a version.
// - reactivate takes `expectedVersion` but NOT a new public key (it reuses the
//   member's last on-file key); only rotate-key takes an OPTIONAL publicKey.
// - Every action's credential comes back as a top-level `token`, not
//   `credential.token`.
import { api, ROUTES, path } from "../../../lib/api.js";
import { adminAuthState, apiErrorText, fmtUtc, redactForDisplay } from "./shared.js";

// Actions that require the operator to type a reason before the dialog will
// submit. APPROVE IS DELIBERATELY ABSENT (RM-45).
//
// The backend does not read or persist `reason` on ANY of these routes — it is
// operator-audit context that goes no further than the request body. Requiring
// it on approve therefore bought nothing: a mandatory 10-500 character field,
// validated client-side, discarded server-side. That is worse than no audit
// trail, because the ceremony implies a record that does not exist.
//
// The asymmetry is the point rather than an oversight. Approve is already
// explicit, attributable and ADMIN_TOKEN-gated, and it is the common path — the
// one an operator runs for every new member. The others are exceptional and
// destructive-adjacent: rejecting an applicant, deactivating a seated member,
// or rotating a key that invalidates their credential. A moment's friction
// there is the friction working. Making the whole set uniform would mean either
// gating the common path on a field that goes nowhere, or dropping the pause
// before the actions that warrant one.
//
// If we want `reason` to mean something, the fix is to persist it (there is an
// audit route at ROUTES.swarm.admin.audit), not to validate it harder here.
const REASON_REQUIRED = new Set(["reject", "deactivate", "reactivate", "rotate-key"]);

// ── Profile edit (issue #567) ───────────────────────────────────────────────
// Every field on this form is nullable on the row, so "" means CLEAR and is
// sent as an explicit null. `name` is deliberately absent from this list: a
// member row always has a display name, so its empty case is a validation
// error rather than a clear.
//
// `slug` is deliberately absent too. It shipped in neither half: swarm_members
// has no slug column, so backend validateMemberAdminPatch()'s MEMBER_ADMIN_KEYS
// omits it and the route answers `unknown field: slug`. It arrives with #562's
// migration, and the form grows the input then — offering it now would render
// an edit that 400s.
const NULLABLE_TEXT = ["lens", "contactEmail", "tagline", "mandate", "mode", "operator"];

// Mirrors the server's own shapes so the operator is corrected before the
// round-trip rather than by a 400. The server still validates; these are not
// the authority, they are the faster copy of it. Both constants are the
// backend's: CONTACT_EMAIL_RE and MAX_BIASES in api/validation.ts.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BIASES = 20;
const MAX_BIAS_LEN = 200;

const linesOf = (text) => String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);

export function registerAdminSwarmMember(Alpine) {
  Alpine.data("adminSwarmMember", () => ({
    ...adminAuthState(),
    loading: false,
    error: null,
    member: null,
    memberId: null,
    pendingApplication: null, // this member's row from GET .../applications?status=pending, if any

    // Confirmation dialog: { action, publicKey, reason } | null
    confirm: null,
    confirmError: null,
    submitting: false,

    editing: false,
    editForm: null,
    editErrors: {},

    credentialReveal: null, // { token } — cleared on dismiss/navigate
    fmtUtc,

    async init() {
      this.memberId = location.pathname.split("/").filter(Boolean).pop();
      await this.bootWithStoredToken(() => this.load());
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const [membersRes, applicationsRes] = await Promise.all([
          api.adminGet(ROUTES.swarm.admin.members, this._token()),
          api.adminGet(ROUTES.swarm.admin.applications, this._token(), { status: "pending" }),
        ]);
        if (!Array.isArray(membersRes.members)) throw new Error("admin members response missing 'members' array");
        if (!Array.isArray(applicationsRes.applications)) throw new Error("applications response missing 'applications' array");
        const found = membersRes.members.find((m) => m.id === this.memberId);
        if (!found) throw new Error(`member '${this.memberId}' not found`);
        this.member = found;
        // Application rows are raw DB rows (snake_case member_id) — listApplicationsAdmin()
        // returns unprojected SELECT output.
        this.pendingApplication = applicationsRes.applications.find((a) => a.member_id === this.memberId) || null;
      } catch (e) {
        if (e.status === 403) this._handle403();
        else this.error = e.message;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    // Redacted detail JSON for the collapsible <pre>. Belt-and-suspenders: the
    // server contract already omits token_hash/bearer tokens, this also
    // strips anything that looks like one client-side.
    memberJson() { return JSON.stringify(redactForDisplay(this.member), null, 2); },

    memberBiases() { return Array.isArray(this.member?.biases) ? this.member.biases : []; },

    // The route ships with #567. Until the vendored contract carries it, the
    // page renders without the edit affordance instead of posting to
    // `undefined` — which also covers the stale-bundle case this repo hits
    // often enough to have its own note in AGENTS.md: a cached copy of this
    // factory running against newer markup, or the reverse.
    canEdit() { return Boolean(ROUTES.swarm.admin.memberUpdate); },

    canActivate() { return this.member?.status === "applied" && !!this.pendingApplication; },
    canDeactivate() { return this.member?.status === "active"; },
    canReactivate() { return this.member?.status === "inactive"; },
    canRotateKey() { return this.member?.status === "active"; },
    canReject() { return this.member?.status === "applied" && !!this.pendingApplication; },

    // ── Profile edit ────────────────────────────────────────────────────────
    startEdit() {
      const m = this.member;
      this.editForm = {
        name: m.name || "",
        lens: m.lens || "",
        contactEmail: m.contactEmail || "",
        tagline: m.tagline || "",
        mandate: m.mandate || "",
        mode: m.mode || "",
        operator: m.operator || "",
        biases: this.memberBiases().join("\n"),
        reason: "",
      };
      this.editErrors = {};
      this.editing = true;
    },
    cancelEdit() { this.editing = false; this.editForm = null; this.editErrors = {}; },

    // ONLY what the operator actually changed. The route is a partial patch,
    // so posting the whole row would overwrite a field someone else edited
    // between this page's load and this save — the version guard catches a
    // concurrent write, but only if we are not the one re-sending the stale
    // value. It also keeps the audit row's `fields` list honest: it names what
    // moved, not what the form happened to contain.
    buildPatch() {
      const patch = {};
      const f = this.editForm;
      const name = f.name.trim();
      if (name !== (this.member.name || "")) patch.name = name;
      for (const key of NULLABLE_TEXT) {
        const next = f[key].trim();
        if (next !== (this.member[key] || "")) patch[key] = next || null;
      }
      const biases = linesOf(f.biases);
      const current = this.memberBiases();
      if (biases.length !== current.length || biases.some((b, i) => b !== current[i])) {
        patch.biases = biases.length ? biases : null;
      }
      return patch;
    },

    validateEdit(patch) {
      const errors = {};
      const f = this.editForm;
      if (!f.name.trim()) errors.name = "Name is required.";
      if (f.contactEmail.trim() && !EMAIL_RE.test(f.contactEmail.trim())) {
        errors.contactEmail = "Enter a valid email address, or leave it empty to clear it.";
      }
      const biases = linesOf(f.biases);
      if (biases.length > MAX_BIASES) errors.biases = `At most ${MAX_BIASES} biases, one per line.`;
      else if (biases.some((b) => b.length > MAX_BIAS_LEN)) errors.biases = `Each bias must be ${MAX_BIAS_LEN} characters or fewer.`;
      if (f.reason.trim().length > 500) errors.reason = "Reason must be 500 characters or fewer.";
      if (Object.keys(patch).length === 0 && !Object.keys(errors).length) errors.form = "Nothing changed.";
      return errors;
    },

    async submitEdit() {
      const patch = this.buildPatch();
      this.editErrors = this.validateEdit(patch);
      if (Object.keys(this.editErrors).length > 0) return;
      this.submitting = true;
      try {
        // `reason` is optional here and NOT ceremony: #567 persists it in the
        // audit scope, which is the fix RM-45 asked for. It stays optional
        // because a profile correction is the common path, and the actions
        // that do gate on a reason are the destructive-adjacent ones.
        const body = { expectedVersion: this.member.version, ...patch };
        const reason = this.editForm.reason.trim();
        if (reason) body.reason = reason;
        await api.adminPost(path(ROUTES.swarm.admin.memberUpdate, { id: this.memberId }), this._token(), body);
        this.editing = false;
        this.editForm = null;
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        const message = apiErrorText(e);
        if (e.status === 409) {
          // `stale_version` is the only 409 updateMemberAdmin() emits today,
          // and it is the one an operator can act on: reload and retry. Any
          // other 409 is passed through verbatim rather than given that
          // sentence — telling someone to reload past a conflict a reload
          // cannot clear sends them round a loop that has no end. The branch
          // is defensive, not speculative contract: it costs one comparison
          // and keeps a future uniqueness conflict (#562's slug) from
          // inheriting the wrong advice.
          this.editErrors.form = message === "stale_version"
            ? "This member changed since you loaded it (stale version) — reload and try again."
            : message;
          return;
        }
        this.editErrors.form = message;
      } finally {
        this.submitting = false;
      }
    },

    openConfirm(action) {
      this.confirm = { action, publicKey: "", reason: "" };
      this.confirmError = null;
    },
    cancelConfirm() { this.confirm = null; this.confirmError = null; },

    // Approve does NOT require a reason; every other action does. See
    // REASON_REQUIRED above for why the asymmetry is deliberate.
    reasonRequired() { return REASON_REQUIRED.has(this.confirm?.action); },

    async submitConfirm() {
      if (!this.confirm) return;
      const { action, publicKey, reason } = this.confirm;
      const trimmedReason = String(reason || "").trim();
      if (REASON_REQUIRED.has(action) && (trimmedReason.length < 10 || trimmedReason.length > 500)) {
        this.confirmError = "Reason must be 10–500 characters.";
        return;
      }
      this.submitting = true;
      this.confirmError = null;
      try {
        let route;
        let body;
        if (action === "activate" || action === "reject") {
          // Both are the SAME endpoint: POST .../review, distinguished only by decision.
          route = path(ROUTES.swarm.admin.memberReview, { id: this.memberId });
          body = { decision: action === "activate" ? "approve" : "reject" };
        } else if (action === "deactivate" || action === "reactivate") {
          route = path(ROUTES.swarm.admin[action === "deactivate" ? "memberDeactivate" : "memberReactivate"], { id: this.memberId });
          body = { expectedVersion: this.member.version };
        } else if (action === "rotate-key") {
          route = path(ROUTES.swarm.admin.memberRotateKey, { id: this.memberId });
          body = {};
          if (publicKey.trim()) body.publicKey = publicKey.trim();
        } else {
          throw new Error(`unknown member action: ${action}`);
        }
        // `reason` is local operator-audit context only: the backend does not
        // read or persist it for any of these routes. Sent when the operator
        // supplied one, omitted when they did not, rather than shipping an
        // empty string that reads like a recorded blank.
        if (trimmedReason) body.reason = trimmedReason;
        const res = await api.adminPost(route, this._token(), body);
        this.confirm = null;
        // Credential-minting actions (manual add / reactivate / rotate-key /
        // approve) return `token` at the top level, never `credential.token`.
        if (res.token) this.credentialReveal = { token: res.token };
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        if (e.status === 409) { this.confirmError = "This member changed since you loaded it (stale version) — reload and try again."; return; }
        this.confirmError = e.message;
      } finally {
        this.submitting = false;
      }
    },

    dismissCredential() { this.credentialReveal = null; },
  }));
}
