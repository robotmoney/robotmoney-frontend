// @ts-nocheck — browser-facing plain JS predating the root tsconfig's checkJs
// coverage; pulled into the root TS program transitively by
// frontend-routes.test.ts → static-views.js (never typechecked before that, so
// this pragma preserves the status quo). JSDoc-typing it is a follow-up.
// The ONLY way the frontend reaches the backend. Reads the public API origin
// from window.RM_CONFIG (set by /config.js) and never imports backend code.
//
// IT IS ALSO THE SITE'S ERROR COPY. ~30 views do `this.error = e.message` and
// render it, so whatever is thrown here is what a reader sees. Issue #968: a
// call answered with the SPA shell (HTTP 200, text/html — what comes back when
// the api is not reachable and a proxy or static fallback answers instead)
// used to reach `res.json()` and put the parser's own words on the page:
//
//     Unexpected token '<', "<!doctype "... is not valid JSON
//
// which reads as a bug in that page's data rather than as an outage. The three
// neighbouring failures were no better: a dead api gave "Failed to fetch", a
// proxy's 502 put its HTML in the banner, and a database outage arrived as the
// serialized envelope `API 500: {"error":"internal error"}`.
//
// So every failure below is classified BEFORE it becomes a message: the reader
// is told the backend is the problem, and the raw material (body snippet,
// underlying error) stays on the error object for whoever opens a console
// rather than being printed to one — several specs assert the app logs no
// console errors while deliberately failing API calls.
import { ROUTES, path } from "../contract/index.js";

export { ROUTES, path };

function base() {
  const url = window.RM_CONFIG?.API_BASE_URL;
  // "" is valid and means "same origin" (single-box: the API serves this page).
  if (url == null) throw new Error("RM_CONFIG.API_BASE_URL is not set (load /config.js first)");
  return url.replace(/\/$/, "");
}

// `application/json`, and the `+json` structured-suffix family (RFC 6839), with
// or without parameters.
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

// A body worth showing a reader: short, and not a document. An error page, a
// stack trace or a whole SPA shell fails one or both, and goes in `detail`
// instead of into the message.
const MAX_DETAIL_LENGTH = 200;
const LOOKS_LIKE_MARKUP = /^\s*(?:<|﻿<)/;

function readableDetail(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_DETAIL_LENGTH || LOOKS_LIKE_MARKUP.test(trimmed)) return null;
  return trimmed;
}

// The API's own error convention, `{ error: "..." }`. Returned SEPARATELY from
// the display text because it is a token, not prose: admin/shared.js's
// apiErrorText() hands it to callers that compare it (`=== "stale_version"`)
// to decide which advice an operator gets. It rides on the error as `reason`.
function envelopeError(text) {
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object") {
      const message = body.error ?? body.message;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

// The message an error RESPONSE carries, if it carries one at all. A route that
// answers plain text (or mislabels plain text as JSON, which the admin password
// routes do) is read as text rather than dropped.
function detailFrom(text) {
  return readableDetail(envelopeError(text) ?? text);
}

const NOT_THE_API =
  "The API did not answer this request — a web page came back instead of data, which means the backend is unreachable and something else answered in its place.";

async function request(method, route, { query, body, headers } = {}) {
  let url = base() + route;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  // Merge any caller-supplied headers (e.g. the admin X-Admin-Token) with the
  // Content-Type we set for a JSON body.
  const merged = { ...(body ? { "Content-Type": "application/json" } : {}), ...headers };

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: Object.keys(merged).length ? merged : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "include",
    });
  } catch (cause) {
    // fetch only rejects when there was no answer at all: nothing listening
    // (the api container is down, or never started because its database is),
    // DNS, TLS, a blocked or aborted request. Status 0 — there is no HTTP
    // status to report, and callers branching on `e.status === 404` and
    // friends must not mistake this for one.
    throw new ApiError(0, "Can't reach the API — the backend is unreachable (it may be down, restarting, or blocked by the network).", {
      code: "unreachable",
      url,
      cause,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = detailFrom(text);
    const reason = envelopeError(text);
    // 5xx with nothing readable is an infrastructure answer — a proxy's error
    // page, or an empty body — so it is reported as an outage rather than by
    // pasting a document into the banner.
    const message = detail
      ? `API ${res.status}: ${detail}`
      : res.status >= 500
        ? `The API is unavailable — it answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`
        : `API ${res.status}${res.statusText ? `: ${res.statusText}` : ""}`;
    throw new ApiError(res.status, message, { code: "http", url, detail: text, reason });
  }

  if (res.status === 204) return null;

  // A 2xx that is not JSON was not answered by the API. The usual author is a
  // static/SPA fallback (`try_files ... /index.html`, routeShell) or an edge
  // rule catching a path the backend would have served, so the body is a whole
  // HTML page and the page underneath is fine — only the backend is missing.
  const type = res.headers.get("content-type") || "";
  const text = await res.text().catch(() => "");
  if (!JSON_TYPE.test(type)) {
    throw new ApiError(res.status, NOT_THE_API, { code: "not_json", url, contentType: type, detail: text });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    // Labelled JSON, isn't. Same cause, same message: something other than the
    // API answered, and the parser's wording helps nobody reading the page.
    throw new ApiError(res.status, NOT_THE_API, { code: "not_json", url, contentType: type, detail: text, cause });
  }
}

export class ApiError extends Error {
  // `status` is the HTTP status, or 0 when the request never got an answer.
  // `code` says which of the three shapes this is — "http", "not_json",
  // "unreachable" — for callers that want to branch without matching prose.
  // `detail` is the raw body (untruncated, never rendered): the thing you want
  // in the console when a deployment is answering with someone else's page.
  // `reason` is the `{ error }` token out of the API's own envelope, kept
  // unwrapped for the callers that BRANCH on it rather than print it.
  constructor(status, message, { code = "http", url, detail, contentType, reason, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.url = url;
    this.detail = detail;
    this.contentType = contentType;
    this.reason = reason;
  }
}

export const api = {
  get: (route, query) => request("GET", route, { query }),
  post: (route, body) => request("POST", route, { body }),
  health: () => request("GET", ROUTES.health),
  // Admin dashboard helpers: send the operator password as X-Admin-Token (the
  // same header the backend admin routes constant-time compare against ADMIN_TOKEN).
  adminGet: (route, token, query) => request("GET", route, { query, headers: { "X-Admin-Token": token } }),
  adminPost: (route, token, body) => request("POST", route, {
    body,
    headers: token == null ? undefined : { "X-Admin-Token": token },
  }),
  adminPatch: (route, token, body) => request("PATCH", route, { body, headers: { "X-Admin-Token": token } }),
};
