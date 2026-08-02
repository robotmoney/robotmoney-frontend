// Shared admin-surface plumbing (issue #159): the login/token/403 contract every
// /admin/swarm/* and /admin/audit page follows, plus small formatting
// helpers. NOT an Alpine.data factory itself — each page's factory spreads
// `adminAuthState()` into its returned object literal and calls the shared
// methods from its own init()/load(). This mirrors the existing
// admin-jobs.js pattern (AC: "Admin login stores rm_admin_token in
// sessionStorage, sends X-Admin-Token on every admin request, and a mocked 403
// clears the token, stops polling, clears sensitive state, and renders the
// session-expired message.") without forcing every page through one giant
// Alpine component.
import { ROUTES } from "../../../lib/api.js";

export const ADMIN_TOKEN_KEY = "rm_admin_token";

export function getStoredAdminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

/**
 * Common auth/session fields + methods for an admin page component. The
 * caller's `load()` (or equivalent) should call `this._token()` for the
 * header value and route any thrown ApiError through `this._handle403(e)`.
 */
export function adminAuthState() {
  return {
    authed: false,
    password: getStoredAdminToken(),
    loginError: null,
    sessionExpired: false,

    _token() {
      return sessionStorage.getItem(ADMIN_TOKEN_KEY) || this.password.trim();
    },

    // Validate the entered password against POST /api/admin/auth (same call
    // the queue dashboard's login makes); on ok, persist it and let the caller
    // load its own data.
    async loginAndLoad(loadFn) {
      this.loginError = null;
      this.sessionExpired = false;
      const token = this.password.trim();
      if (!token) { this.loginError = "Enter the admin password."; return; }
      const { api } = await import("../../../lib/api.js");
      try {
        await api.adminPost(ROUTES.admin.auth, token);
        sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
        this.authed = true;
        await loadFn();
      } catch (e) {
        this.loginError = e.status === 403 ? "Incorrect admin password." : e.message;
      }
    },

    // A stored token from a prior login in this tab → try to load straight
    // into the page; a 403 drops back to the login gate.
    async bootWithStoredToken(loadFn) {
      if (!this.password) return;
      try {
        this.authed = true;
        await loadFn();
      } catch (e) {
        if (e?.status === 403) this._handle403();
      }
    },

    // Fail-closed on any 403: clear the token, stop polling, clear sensitive
    // state, and surface "Session expired — sign in again."
    _handle403(stopPolling) {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      this.authed = false;
      this.sessionExpired = true;
      this.password = "";
      if (typeof stopPolling === "function") stopPolling();
      else if (typeof this.stopPolling === "function") this.stopPolling();
    },

    logout() {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      this.authed = false;
      this.password = "";
      this.sessionExpired = false;
      if (typeof this.stopPolling === "function") this.stopPolling();
    },
  };
}

// ── Formatting helpers shared across admin views ────────────────────────────

export function fmtUtc(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  } catch (_) {
    return String(iso);
  }
}

export function fmtLocal(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch (_) {
    return String(iso);
  }
}

export function prettyJson(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
}

/** Redact a raw JSON payload for display: drop keys that must never render. */
const REDACTED_KEYS = /token|authorization|header|cookie|secret|password|signature/i;
export function redactForDisplay(value) {
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACTED_KEYS.test(k) ? "[redacted]" : redactForDisplay(v);
    }
    return out;
  }
  return value;
}
