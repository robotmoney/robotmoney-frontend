// Alpine factory for /admin/committee/members/:id — member detail, activation/
// deactivation/reactivation/key-rotation/rejection with confirm+reason, and a
// one-time credential reveal. Issue #159 — docs/plan-admin-surface.md §4 US-C2.
//
// Reconciled to the REAL backend (issue #152/PR #169) per PR #172 review:
// - No GET .../members/:id — this page fetches the admin members LIST and
//   picks its row client-side (same pattern as committee-subject.js).
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
import { adminAuthState, fmtUtc, redactForDisplay } from "./shared.js";

export function registerAdminCommitteeMember(Alpine) {
  Alpine.data("adminCommitteeMember", () => ({
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
          api.adminGet(ROUTES.committee.admin.members, this._token()),
          api.adminGet(ROUTES.committee.admin.applications, this._token(), { status: "pending" }),
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

    canActivate() { return this.member?.status === "applied" && !!this.pendingApplication; },
    canDeactivate() { return this.member?.status === "active"; },
    canReactivate() { return this.member?.status === "inactive"; },
    canRotateKey() { return this.member?.status === "active"; },
    canReject() { return this.member?.status === "applied" && !!this.pendingApplication; },

    openConfirm(action) {
      this.confirm = { action, publicKey: "", reason: "" };
      this.confirmError = null;
    },
    cancelConfirm() { this.confirm = null; this.confirmError = null; },

    async submitConfirm() {
      if (!this.confirm) return;
      const { action, publicKey, reason } = this.confirm;
      const trimmedReason = String(reason || "").trim();
      if (trimmedReason.length < 10 || trimmedReason.length > 500) {
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
          route = path(ROUTES.committee.admin.memberReview, { id: this.memberId });
          body = { decision: action === "activate" ? "approve" : "reject" };
        } else if (action === "deactivate" || action === "reactivate") {
          route = path(ROUTES.committee.admin[action === "deactivate" ? "memberDeactivate" : "memberReactivate"], { id: this.memberId });
          body = { expectedVersion: this.member.version };
        } else if (action === "rotate-key") {
          route = path(ROUTES.committee.admin.memberRotateKey, { id: this.memberId });
          body = {};
          if (publicKey.trim()) body.publicKey = publicKey.trim();
        } else {
          throw new Error(`unknown member action: ${action}`);
        }
        // `reason` is kept for local operator-audit context (harmless extra
        // field — the backend does not read or persist it for these routes).
        body.reason = trimmedReason;
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
