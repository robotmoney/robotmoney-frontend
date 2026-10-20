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
import { memberAvatarMarkup } from "../../../lib/member-mark.js";
import { isUploadedAvatar, memberAvatarSrc, memberLogo } from "../../../lib/member-logos.js";
import { helpers } from "../../static-views.js";
import { adminAuthState, apiErrorText, fmtUtc, redactForDisplay } from "./shared.js";

// ── Avatar upload (RM-184) ──────────────────────────────────────────────────
// The bytes go to the #626 route, which stores them in Postgres so they
// survive a redeploy, and points avatar.path at the public GET that serves
// them. An upload outranks the curated logo map (lib/member-logos.js), so this
// is how a logo is set or replaced without a PR. The type list and the size
// limit are the server's (AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES in
// swarm/admin.ts): no SVG, because a served SVG is a document, not a picture.
const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
// The server refuses any other id shape with a 404 (MEMBER_ID_RE), so the
// legacy handle-shaped ids (themis) keep their curated mark and get no picker.
const UPLOADABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVATAR_SOURCE_LABELS = {
  upload: "Uploaded here. It replaces any curated logo.",
  logo: "Curated logo from the repo. An upload replaces it.",
  path: "Seeded path. An upload replaces it.",
  mark: "Derived mark. No logo is set.",
};

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
const REASON_REQUIRED = new Set(["reject", "deactivate", "reactivate", "rotate-key", "grant-judge", "revoke-judge"]);

// ── Profile edit (issue #567) ───────────────────────────────────────────────
// Every field on this form is nullable on the row, so "" means CLEAR and is
// sent as an explicit null. `name` is deliberately absent from this list: a
// member row always has a display name, so its empty case is a validation
// error rather than a clear.
//
// `handle` is absent from it for the same reason as `name` and one more: it is
// the member's PUBLIC URL segment (issue #593), so an empty one would leave the
// member unaddressable. It is the only field on this form that changes what a
// visitor's link points at, which is why the server audits its before/after
// value and why this form spells the rule out beside the input. The immutable
// `id` — what signatures and child rows are keyed on — is never editable here.
const NULLABLE_TEXT = ["lens", "contactEmail", "tagline", "mandate", "mode", "operator"];

// Mirrors the server's own shapes so the operator is corrected before the
// round-trip rather than by a 400. The server still validates; these are not
// the authority, they are the faster copy of it. Both constants are the
// backend's: CONTACT_EMAIL_RE and MAX_BIASES in api/validation.ts.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// MEMBER_HANDLE_RE in api/validation.ts.
const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BIASES = 20;
const MAX_BIAS_LEN = 200;

// ── Approval (RM-177) ───────────────────────────────────────────────────────
// Approving an application is where an admin decides what the agent is: a
// member that files takes, or a judge that never does. The review route has
// always accepted `role` (default `member`); this dialog now sends it, so the
// default can no longer be the decision by omission.
//
// The operator is required at approval because each operator runs one agent in
// the swarm, and the backend's policy for that (issue #1335) keys on it. It is
// saved through the existing versioned profile update FIRST, then the review is
// sent: two requests, ordered so a failed save never approves anyone.
//
// The in-house operator is REFUSED here, not exempted. `robotmoney` makes an
// agent in-house, and an in-house judge skips the third-party gate: it becomes
// eligible at once and, if its id sorts below Themis's, its judgement is the one
// adopted on every session (judgeOfRecordTx, lowest member id). Approved by
// mistake onto an agent that is not running the judge loop, that leaves every
// session unjudged. In-house agents are seeded, not approved; an admin who
// means it sets the operator from Edit profile first.
const IN_HOUSE_OPERATOR = "robotmoney";
const MAX_OPERATOR_LEN = 200; // requiredString(body, "operator", 200) in api/validation.ts
const ROLES = ["member", "judge"];
const sameOperator = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

const linesOf = (text) => String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);

export function registerAdminSwarmMember(Alpine) {
  Alpine.data("adminSwarmMember", () => ({
    ...adminAuthState(),
    loading: false,
    error: null,
    member: null,
    members: [], // the full admin list: the approval dialog reads operators from it
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

    avatarFile: null, // the picked File, held until Upload
    avatarPreview: null, // a data: URL of it (the CSP's img-src allows data:, not blob:)
    avatarError: null,
    avatarBusy: false,

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
        this.members = membersRes.members;
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

    // ── Avatar (RM-184) ──────────────────────────────────────────────────────
    canUploadAvatar() {
      return Boolean(ROUTES.swarm.admin.memberAvatar) && UPLOADABLE_ID_RE.test(this.member?.id || "");
    },

    avatarSource() {
      const p = this.member?.avatar?.path;
      if (isUploadedAvatar(p)) return "upload";
      if (memberLogo({ handle: this.member?.handle })) return "logo";
      return String(p || "").trim() ? "path" : "mark";
    },

    avatarSourceLabel() { return AVATAR_SOURCE_LABELS[this.avatarSource()]; },

    // The same chain and markup the public pages render, so what shows here
    // is what a visitor sees.
    avatarMarkup() {
      const m = this.member;
      if (!m) return "";
      return memberAvatarMarkup(memberAvatarSrc(m.handle, m.avatar?.path), m.keyFingerprint || m.id, m.name, 80, (n) => helpers.initials(n));
    },

    pickAvatar(event) {
      const file = event.target.files?.[0] || null;
      this.avatarError = null;
      this.avatarFile = null;
      this.avatarPreview = null;
      if (!file) return;
      if (!AVATAR_TYPES.includes(file.type)) {
        this.avatarError = "PNG, JPEG, WebP or GIF only. SVG is not accepted.";
        event.target.value = "";
        return;
      }
      if (file.size > AVATAR_MAX_BYTES) {
        this.avatarError = "The image must be 5 MB or smaller.";
        event.target.value = "";
        return;
      }
      this.avatarFile = file;
      const reader = new FileReader();
      reader.onload = () => { if (this.avatarFile === file) this.avatarPreview = String(reader.result); };
      reader.readAsDataURL(file);
    },

    clearAvatarPick() {
      this.avatarFile = null;
      this.avatarPreview = null;
      this.avatarError = null;
      if (this.$refs.avatarInput) this.$refs.avatarInput.value = "";
    },

    async uploadAvatar() {
      if (!this.avatarFile) return;
      this.avatarBusy = true;
      this.avatarError = null;
      try {
        await api.adminUpload(path(ROUTES.swarm.admin.memberAvatar, { id: this.memberId }), this._token(), this.avatarFile);
        this.clearAvatarPick();
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        this.avatarError = apiErrorText(e);
      } finally {
        this.avatarBusy = false;
      }
    },

    // Clears the POINTER through the versioned profile edit, which accepts
    // `avatar: null`, so the member falls back to its curated logo or its mark.
    // The bytes stay in swarm_member_avatars (rm_app cannot DELETE there) and
    // the old URL still serves them until the next upload overwrites the row.
    // Hence the button says "Stop showing", not "Delete".
    async removeAvatar() {
      this.avatarBusy = true;
      this.avatarError = null;
      try {
        await api.adminPost(path(ROUTES.swarm.admin.memberUpdate, { id: this.memberId }), this._token(), {
          expectedVersion: this.member.version,
          avatar: null,
          reason: "Removed the uploaded avatar.",
        });
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        const message = apiErrorText(e);
        this.avatarError = message === "stale_version"
          ? "This member changed since you loaded it (stale version). Reload and try again."
          : message;
      } finally {
        this.avatarBusy = false;
      }
    },

    // The route ships with #567. Until the vendored contract carries it, the
    // page renders without the edit affordance instead of posting to
    // `undefined` — which also covers the stale-bundle case this repo hits
    // often enough to have its own note in AGENTS.md: a cached copy of this
    // factory running against newer markup, or the reverse.
    canEdit() { return Boolean(ROUTES.swarm.admin.memberUpdate); },

    canActivate() { return this.member?.status === "applied" && !!this.pendingApplication; },
    canDeactivate() { return this.member?.status === "active"; },
    canReactivate() { return this.member?.status === "inactive"; },
    // Issue #794. NOT active-only. `CARRIED_KEY_UNREGISTRABLE` — the 409 that
    // reactivate answers when the member's on-file key is a low-order point
    // registered before issue #789's gate shipped — names exactly one remedy:
    // "use rotate-key with a freshly generated publicKey". The member who reads
    // that sentence is INACTIVE by construction, because reactivate is the path
    // that refused. Active-only meant the refusal pointed at a button that was
    // not on the page, and the only way out was a hand-rolled curl.
    //
    // Widening it is safe rather than a new grant: rotateMemberKeyAdmin()
    // (swarm/admin.ts) has never had a member-status check, so this POST was
    // always available to an authenticated admin — the button was the only
    // thing hiding it. And rotating an inactive member's key is exactly what
    // reactivation needs to succeed afterwards: reactivate reads the newest key
    // by created_at, which is the freshly rotated one.
    //
    // `applied` and `rejected` stay out on purpose. An applicant's key arrives
    // with the application and is the thing under review; rotating it before a
    // decision would change what was reviewed, and rejection is terminal.
    canRotateKey() { return this.member?.status === "active" || this.member?.status === "inactive"; },
    canGrantJudge() { return this.member?.status === "active" && this.member?.role === "member" && Boolean(ROUTES.swarm.admin.memberRole); },
    canRevokeJudge() { return this.member?.status === "active" && this.member?.role === "judge" && Boolean(ROUTES.swarm.admin.memberRole); },
    canReject() { return this.member?.status === "applied" && !!this.pendingApplication; },

    // ── Profile edit ────────────────────────────────────────────────────────
    startEdit() {
      const m = this.member;
      this.editForm = {
        handle: m.handle || m.id || "",
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
      const handle = f.handle.trim();
      if (handle !== (this.member.handle || this.member.id || "")) patch.handle = handle;
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
      if (!HANDLE_RE.test(f.handle.trim())) {
        errors.handle = "Use lowercase kebab-case, for example noop-analyst.";
      }
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
          // is defensive, not speculative contract: it costs one comparison,
          // and it is what keeps `handle already taken` (issue #593's
          // uniqueness conflict, which a reload cannot clear) from inheriting
          // the wrong advice.
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
      this.confirm = { action, publicKey: "", reason: "", role: "member", operator: this.member?.operator || "" };
      this.confirmError = null;
    },

    confirmLabel() {
      return this.confirm?.action === "activate" ? `Approve as ${this.confirm.role}` : "Confirm";
    },

    // Operators already on file, for the input's suggestions: reusing the exact
    // spelling is what lets the one-agent-per-operator rule recognise a match.
    knownOperators() {
      const seen = new Map();
      for (const m of this.members) {
        const op = String(m.operator || "").trim();
        if (op && !sameOperator(op, IN_HOUSE_OPERATOR) && !seen.has(op.toLowerCase())) seen.set(op.toLowerCase(), op);
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b));
    },

    // The active member this operator already runs, if any. A heads-up the
    // admin sees before submitting; the server is the authority once #1335
    // lands. Case-insensitive, since the column is free text. The in-house
    // operator is refused outright in submitApprove(), so it never gets here.
    operatorConflict() {
      const op = String(this.confirm?.operator || "").trim();
      if (!op || sameOperator(op, IN_HOUSE_OPERATOR)) return null;
      return this.members.find((m) => m.id !== this.memberId && m.status === "active" && sameOperator(m.operator, op)) || null;
    },

    async submitApprove() {
      const { role } = this.confirm;
      const operator = String(this.confirm.operator || "").trim();
      if (!ROLES.includes(role)) { this.confirmError = "Choose a role."; return; }
      if (!operator) { this.confirmError = "Operator is required."; return; }
      if (sameOperator(operator, IN_HOUSE_OPERATOR)) {
        this.confirmError = `"${IN_HOUSE_OPERATOR}" is reserved for in-house agents. Set it from Edit profile if this agent is ours.`;
        return;
      }
      if (operator.length > MAX_OPERATOR_LEN) { this.confirmError = `Operator must be ${MAX_OPERATOR_LEN} characters or fewer.`; return; }
      const conflict = this.operatorConflict();
      if (conflict) { this.confirmError = `${conflict.name} already runs for ${conflict.operator}. Each operator runs one agent.`; return; }

      this.submitting = true;
      this.confirmError = null;
      let operatorSaved = false;
      try {
        if (operator !== (this.member.operator || "")) {
          await api.adminPost(path(ROUTES.swarm.admin.memberUpdate, { id: this.memberId }), this._token(), {
            expectedVersion: this.member.version, operator,
          });
          operatorSaved = true;
        }
        const res = await api.adminPost(path(ROUTES.swarm.admin.memberReview, { id: this.memberId }), this._token(), {
          decision: "approve", role,
        });
        this.confirm = null;
        if (res.token) this.credentialReveal = { token: res.token };
        await this.load();
      } catch (e) {
        if (e.status === 403) return this._handle403();
        const message = apiErrorText(e);
        const reason = e.status === 409 && message === "stale_version"
          ? "This member changed since you loaded it (stale version). Reload and try again."
          : message;
        // The operator may already be saved when the review fails. Say so, and
        // reload, so a retry sends only the review against the current version.
        this.confirmError = operatorSaved ? `Operator saved, but approval failed: ${reason}` : reason;
        if (operatorSaved) {
          const draft = this.confirm;
          try { await this.load(); } catch { /* load() reports its own error */ }
          this.confirm = draft;
        }
      } finally {
        this.submitting = false;
      }
    },
    cancelConfirm() { this.confirm = null; this.confirmError = null; },

    // Approve does NOT require a reason; every other action does. See
    // REASON_REQUIRED above for why the asymmetry is deliberate.
    reasonRequired() { return REASON_REQUIRED.has(this.confirm?.action); },

    async submitConfirm() {
      if (!this.confirm) return;
      if (this.confirm.action === "activate") return this.submitApprove();
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
        if (action === "reject") {
          // Approve shares this endpoint (POST .../review, by decision) but has
          // its own path, submitApprove(), because it carries a role and an
          // operator.
          route = path(ROUTES.swarm.admin.memberReview, { id: this.memberId });
          body = { decision: "reject" };
        } else if (action === "deactivate" || action === "reactivate") {
          route = path(ROUTES.swarm.admin[action === "deactivate" ? "memberDeactivate" : "memberReactivate"], { id: this.memberId });
          body = { expectedVersion: this.member.version };
        } else if (action === "rotate-key") {
          route = path(ROUTES.swarm.admin.memberRotateKey, { id: this.memberId });
          body = {};
          if (publicKey.trim()) body.publicKey = publicKey.trim();
        } else if (action === "grant-judge" || action === "revoke-judge") {
          route = path(ROUTES.swarm.admin.memberRole, { id: this.memberId });
          body = { expectedVersion: this.member.version, role: action === "grant-judge" ? "judge" : "member" };
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
        const message = apiErrorText(e);
        if (e.status === 409) {
          // Same rule the profile edit above applies (issue #567), and now
          // load-bearing here too: since issue #789 reactivate and rotate-key
          // answer 409 when the member's ON-FILE key cannot be carried forward
          // (a low-order row registered before the gate existed). A reload
          // cannot clear that — the remedy is in the sentence the server sent,
          // which names it: rotate with a freshly generated publicKey.
          this.confirmError = message === "stale_version"
            ? "This member changed since you loaded it (stale version) — reload and try again."
            : message;
          return;
        }
        // Likewise the 400 rotate-key answers for a supplied key that is not a
        // usable Ed25519 public key: render the sentence, not the envelope.
        this.confirmError = message;
      } finally {
        this.submitting = false;
      }
    },

    dismissCredential() { this.credentialReveal = null; },
  }));
}
