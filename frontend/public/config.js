// Runtime config injected per environment (no build, no secrets — only the
// public API origin). The host substitutes this file at deploy time:
//   single-box (API serves this page) -> ""  (same origin, recommended)
//   separate-origin local dev          -> "http://localhost:8787"
// "" means same origin: the Bun server serves both this static site and the API,
// so no reverse proxy and no CORS are needed.
window.RM_CONFIG = {
  API_BASE_URL: "",
};
