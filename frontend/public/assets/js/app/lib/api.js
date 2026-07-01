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

async function request(method, route, { query, body } = {}) {
  // Frozen static-data mode: the SPA is served from a dumb static host with no
  // API. GETs resolve to pre-generated JSON files under STATIC_DATA_BASE (keyed
  // by the request pathname, query dropped — a snapshot is one point in time);
  // writes are accepted no-ops. This is the ONLY networking difference between
  // the live app and the frozen distribution — no fetch/history monkeypatching.
  const staticBase = window.RM_CONFIG?.STATIC_DATA_BASE;
  if (staticBase != null) {
    if (method !== "GET") return null;
    const res = await fetch(`${staticBase.replace(/\/$/, "")}${route}.json`, { credentials: "omit" });
    if (!res.ok) throw new ApiError(res.status, `no frozen snapshot for ${route}`);
    return res.status === 204 ? null : res.json();
  }

  let url = base() + route;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
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
};
