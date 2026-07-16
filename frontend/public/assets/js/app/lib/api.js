// @ts-nocheck — browser-facing plain JS predating the root tsconfig's checkJs
// coverage; pulled into the root TS program transitively by
// frontend-routes.test.ts → static-views.js (never typechecked before that, so
// this pragma preserves the status quo). JSDoc-typing it is a follow-up.
// The ONLY way the frontend reaches the backend. Reads the public API origin
// from window.RM_CONFIG (set by /config.js) and never imports backend code.
import { ROUTES, path } from "../contract/index.js";

export { ROUTES, path };

function base() {
  const url = window.RM_CONFIG?.API_BASE_URL;
  // "" is valid and means "same origin" (single-box: the API serves this page).
  if (url == null) throw new Error("RM_CONFIG.API_BASE_URL is not set (load /config.js first)");
  return url.replace(/\/$/, "");
}

async function request(method, route, { query, body, headers } = {}) {
  let url = base() + route;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  // Merge any caller-supplied headers (e.g. the admin X-Admin-Token) with the
  // Content-Type we set for a JSON body.
  const merged = { ...(body ? { "Content-Type": "application/json" } : {}), ...headers };
  const res = await fetch(url, {
    method,
    headers: Object.keys(merged).length ? merged : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

export class ApiError extends Error {
  constructor(status, message) {
    super(`API ${status}: ${message}`);
    this.status = status;
  }
}

export const api = {
  get: (route, query) => request("GET", route, { query }),
  post: (route, body) => request("POST", route, { body }),
  health: () => request("GET", ROUTES.health),
  // Admin dashboard helpers: send the operator password as X-Admin-Token (the
  // same header the backend admin routes constant-time compare against ADMIN_TOKEN).
  adminGet: (route, token, query) => request("GET", route, { query, headers: { "X-Admin-Token": token } }),
  adminPost: (route, token, body) => request("POST", route, { body, headers: { "X-Admin-Token": token } }),
  adminPatch: (route, token, body) => request("PATCH", route, { body, headers: { "X-Admin-Token": token } }),
};
