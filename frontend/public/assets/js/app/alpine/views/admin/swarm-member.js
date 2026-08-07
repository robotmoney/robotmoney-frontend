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
import { adminAuthState, fmtUtc, redactForDisplay } from "./shared.js";

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
