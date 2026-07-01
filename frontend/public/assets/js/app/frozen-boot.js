// Frozen-mode boot shim — ONLY present in the single-file offline build
// (dist/frozen/index.html). It runs as a classic <script> BEFORE the app bundle
// and the Alpine/Chart/p5 vendor scripts, so the network is fully neutralised
// before any view renders. It makes ZERO changes to app/lib/api.js or
// app/router.js; instead it substitutes their runtime dependencies:
//
//   • window.RM_CONFIG.FROZEN = true, API_BASE_URL = "" — api.js keeps building
//     "/api/..." URLs; we intercept them below.
//   • window.fetch override — GET /api/* resolves from window.RM_FROZEN (baked
//     API JSON, keyed by pathname); GET /views/* resolves from window.RM_VIEWS
//     (inlined HTML fragments); writes (POST/PUT/DELETE) are accepted no-ops.
//   • history.pushState / replaceState wrappers — the SPA router pushes absolute
//     paths ("/regime"); under file:// that throws SecurityError. We swallow that
//     one error so in-app navigation still calls router.render(pathname) and the
//     view swaps (the URL bar simply stays on index.html). Any other error is
//     rethrown untouched.
//
// window.RM_FROZEN and window.RM_VIEWS are defined by inline <script> blocks the
// build emits immediately before this file.
(function () {
  "use strict";

  var FROZEN = (window.RM_FROZEN = window.RM_FROZEN || {});
  var VIEWS = (window.RM_VIEWS = window.RM_VIEWS || {});

  // On the file: scheme the boot URL is the absolute filesystem path to
  // index.html, so the router's first render asks for the view of THAT path —
  // which maps to no fragment. We send that single boot miss to home (what a
  // double-click should show) instead of a 404. Only the first view request is
  // treated this way; later unknown in-app navigations still resolve not-found.
  var bootViewPending = true;

  // Force same-origin, frozen config regardless of any baked /config.js.
  window.RM_CONFIG = Object.assign({}, window.RM_CONFIG, {
    API_BASE_URL: "",
    FROZEN: true,
  });

  // ── history: tolerate file:// pushState/replaceState SecurityError ──────────
  // Absolute-path same-document navigations are blocked on the file: scheme.
  // Swallow ONLY that DOMException so the router's render() still runs.
  function harden(name) {
    var original = history[name];
    if (typeof original !== "function") return;
    history[name] = function () {
      try {
        return original.apply(this, arguments);
      } catch (err) {
        var isSecurity =
          (typeof DOMException !== "undefined" && err instanceof DOMException) ||
          (err && (err.name === "SecurityError" || err.name === "NotSupportedError"));
        if (isSecurity) return undefined; // file:// — keep going without a URL change
        throw err;
      }
    };
  }
  harden("pushState");
  harden("replaceState");

  // ── fetch: serve everything from the inlined bake, never touch the network ──
  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  function htmlResponse(html, status) {
    return new Response(html, {
      status: status || 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return String(input);
  }
  function methodOf(input, init) {
    if (init && init.method) return String(init.method).toUpperCase();
    if (input && typeof input === "object" && input.method) return String(input.method).toUpperCase();
    return "GET";
  }

  window.fetch = function (input, init) {
    var raw = urlOf(input);
    var method = methodOf(input, init);
    var pathname;
    try {
      // Base is irrelevant — we only need pathname; api.js builds "/api/..."
      // and the router builds "/views/...". Query params are dropped: the
      // frozen snapshot is a single point-in-time, keyed by pathname.
      pathname = new URL(raw, "http://frozen.invalid").pathname;
    } catch (_) {
      pathname = raw;
    }

    // View fragments requested by the router.
    if (pathname.indexOf("/views/") === 0) {
      var wasBoot = bootViewPending;
      bootViewPending = false;
      if (Object.prototype.hasOwnProperty.call(VIEWS, pathname)) {
        return Promise.resolve(htmlResponse(VIEWS[pathname]));
      }
      // The first (boot) request under file:// maps to the index.html path, not a
      // real route — land on home rather than a 404.
      if (wasBoot) {
        var home = VIEWS["/views/home.html"];
        if (home != null) return Promise.resolve(htmlResponse(home));
      }
      var nf = VIEWS["/views/not-found.html"];
      return Promise.resolve(htmlResponse(nf != null ? nf : "<p>Not found (frozen)</p>", 404));
    }

    // API surface.
    if (pathname.indexOf("/api/") === 0 || pathname === "/health") {
      // Writes are no-ops in a point-in-time snapshot: acknowledge without state.
      if (method !== "GET" && method !== "HEAD") {
        return Promise.resolve(jsonResponse({ ok: true, frozen: true }, 200));
      }
      if (Object.prototype.hasOwnProperty.call(FROZEN, pathname)) {
        return Promise.resolve(jsonResponse(FROZEN[pathname]));
      }
      // No baked entry: the bake step guarantees coverage of every endpoint the
      // frontend requests, so this is only reached for parameterised routes not
      // present in the snapshot. Return a shape-safe empty body so views render
      // their empty state instead of erroring — and never hit the network.
      return Promise.resolve(jsonResponse(emptyFor(pathname), 200));
    }

    // Anything else (should not happen in the bundle) — refuse loudly rather than
    // silently reach the network, so a regression can't leak a live request.
    return Promise.reject(new Error("[frozen] blocked non-baked request: " + raw));
  };

  // Best-effort empty shapes for unbaked parameterised GETs so the view's
  // x-for/x-text bindings render an empty state without throwing.
  function emptyFor(pathname) {
    if (pathname === "/api/comments") return { comments: [] };
    if (pathname === "/api/committee/members") return { members: [] };
    if (pathname === "/api/committee/sessions") return { sessions: [] };
    if (/\/snapshots$/.test(pathname)) return { snapshots: [] };
    return {};
  }
})();
