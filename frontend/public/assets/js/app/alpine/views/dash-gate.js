// Session/password gate for the analytics dashboard (issue #380, P0.4 —
// docs/bot-analytics-ui-port-plan.md §5.0, §8 D2). The original's
// PasswordGate verified a raw password against a Supabase edge function;
// this repo already has an operator credential, and the plan's own
// mechanism line is explicit: "POST /api/admin/auth (existing); token in
// sessionStorage; re-verified on mount" — a documented fidelity exception
// (§1's forced-deviation list, item 1), not a new design.
//
// Shares sessionStorage['rm_admin_token'] with the existing /admin surface
// (alpine/views/admin-surface.js) so an operator already signed in there
// does not have to re-enter the password here. §8 D2 flags "a separate
// viewer token" as an OPEN recommendation for a later issue — splitting
// credentials needs a new backend token type, which is out of scope for
// this frontend-only routing/shell issue.
//
// Exported as a plain state/method bag rather than its own Alpine.data
// factory: this repo's existing gate (admin-surface.js) is ONE flat x-data
// component that x-show-toggles between the login form and the shell, not
// nested components — dash-shell.js composes this into that same shape
// (`...createDashGateState()`) so the dashboard gate follows the identical
// convention.
import { api, ROUTES } from "../../lib/api.js";
import { startAuthentication } from "https://esm.sh/@simplewebauthn/browser@13.3.0";

export const ADMIN_TOKEN_KEY = "rm_admin_token";

export function createDashGateState() {
  return {
    authed: false,
    // Starts true: the gate must not flash a login form before a stored
    // token's re-verify resolves (§5.0 "session restore without flash") —
    // dash-shell.js's markup keeps both the gate AND the shell hidden while
    // this is true.
    verifying: true,
    password: "",
    showPassword: false,
    passkeyLoading: false,
    loginError: null,

    // POST /api/admin/auth doubles as a stateless "is this token still
    // valid?" check — the same call login() makes, just re-run for a value
    // already in sessionStorage. A 403 (or any failure) clears it and falls
    // back to requiring a fresh login; this is fail-closed by construction.
    async _verifyToken(token) {
      await api.adminPost(ROUTES.admin.auth, token);
    },

    async initGate() {
      const stored = sessionStorage.getItem(ADMIN_TOKEN_KEY);
      if (stored) {
        try {
          await this._verifyToken(stored);
          this.authed = true;
        } catch (_e) {
          sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        }
      }
      this.verifying = false;
    },

    togglePasswordVisible() {
      this.showPassword = !this.showPassword;
    },

    async login() {
      this.loginError = null;
      const token = this.password.trim();
      if (!token) {
        this.loginError = "Enter your access key.";
        return;
      }
      this.verifying = true;
      try {
        await this._verifyToken(token);
        sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
        this.authed = true;
        this.password = "";
      } catch (e) {
        this.loginError = e.status === 403 ? "Incorrect access key." : e.message || "Sign-in failed.";
      } finally {
        this.verifying = false;
      }
    },

    async loginWithPasskey() {
      this.loginError = null;
      this.passkeyLoading = true;
      try {
        const options = await api.adminGet(ROUTES.admin.webauthnAuthOptions);
        const asseResp = await startAuthentication({ optionsJSON: options });
        const verifyRes = await api.adminPost(ROUTES.admin.webauthnAuthVerify, null, asseResp);
        if (verifyRes.verified && verifyRes.token) {
          sessionStorage.setItem("rm_admin_token", verifyRes.token);
          this.authed = true;
        } else {
          this.loginError = "PASSKEY VERIFICATION FAILED";
        }
      } catch (e) {
        this.loginError = e.name === "NotAllowedError" ? "PASSKEY INTERACTION CANCELLED" : e.message;
      } finally {
        this.passkeyLoading = false;
      }
    },

    logout() {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      this.authed = false;
      this.password = "";
      this.loginError = null;
    },
  };
}
