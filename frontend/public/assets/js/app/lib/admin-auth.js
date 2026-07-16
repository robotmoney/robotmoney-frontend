// Shared admin-token session helpers (issue #176 integration seam). The
// Admin surface phase (docs/plan-admin-surface.md) is growing several Alpine
// modules — the existing task-queue dashboard (alpine/views/admin-jobs.js)
// plus research/operations and committee modules (issues #157/#159) that will
// live under alpine/views/admin/ — and every one of them needs the SAME
// tab-session token behavior (spec US-A1): persist `rm_admin_token` in
// sessionStorage, send it as `X-Admin-Token`, and on a 403 clear the token,
// stop polling, and drop back to the login form. Extracting that behavior
// here (instead of each module reimplementing it) is the decoupling seam:
// #157 and #159 both import from this module rather than duplicating —  or
// diverging on — the token lifecycle.
//
// This is a pure extraction of alpine/views/admin-jobs.js's existing
// sessionStorage logic; it changes no runtime behavior (see that file's
// updated call sites).
export const ADMIN_TOKEN_KEY = "rm_admin_token";

/** The token persisted from a prior login in this tab, or "" if none. */
export function readStoredAdminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

export function persistAdminToken(token) {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
}

/** Spec US-A1: a 403 anywhere clears the stored token so the caller falls back to login. */
export function forgetAdminToken() {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}

/** True for the shape the API client throws (lib/api.js ApiError) on a 403 response. */
export function isAdminAuthError(err) {
  return !!err && err.status === 403;
}
