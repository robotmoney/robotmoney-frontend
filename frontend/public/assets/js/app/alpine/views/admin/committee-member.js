// Alpine factory for /admin/committee/members/:id — member detail, activation/
// deactivation/reactivation/key-rotation/rejection with confirm+reason, and a
// one-time credential reveal. Issue #159 — docs/plan-admin-surface.md §4 US-C2.
import { api, ROUTES, path } from "../../../lib/api.js";
import { adminAuthState, fmtUtc, redactForDisplay } from "./shared.js";

// Actions that mint a brand-new bearer credential require a fresh public key.
const REQUIRES_PUBLIC_KEY = new Set(["reactivate", "rotate-key"]);

export function registerAdminCommitteeMember(Alpine) {
  Alpine.data("adminCommitteeMember", () => ({
    ...adminAuthState(),
    loading: false,
    error: null,
    member: null,
    memberId: null,

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
        this.member = await api.adminGet(path(ROUTES.admin.committee.member, { id: this.memberId }), this._token());
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

    canActivate() { return this.member?.status === "applied" && this.member?.applicationStatus === "pending"; },
    canDeactivate() { return this.member?.status === "active"; },
    canReactivate() { return this.member?.status === "inactive"; },
    canRotateKey() { return this.member?.status === "active"; },
    canReject() { return this.member?.status === "applied" && this.member?.applicationStatus === "pending"; },

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
      if (REQUIRES_PUBLIC_KEY.has(action) && !publicKey.trim()) {
        this.confirmError = "A new public key is required for this action.";
        return;
      }
      this.submitting = true;
      this.confirmError = null;
      try {
        const routeKey = {
          activate: "memberActivate",
          deactivate: "memberDeactivate",
          reactivate: "memberReactivate",
          "rotate-key": "memberRotateKey",
          reject: "memberReject",
        }[action];
        const body = { version: this.member.version, reason: trimmedReason };
        if (REQUIRES_PUBLIC_KEY.has(action)) body.publicKey = publicKey.trim();
        const res = await api.adminPost(
          path(ROUTES.admin.committee[routeKey], { id: this.memberId }),
          this._token(),
          body,
        );
        this.confirm = null;
        if (res.credential?.token) this.credentialReveal = { token: res.credential.token };
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

    participationRows() { return this.member?.participation || []; },
  }));
}
