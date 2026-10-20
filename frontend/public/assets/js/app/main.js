// SPA shell entry module. Loaded as a <script type="module"> BEFORE the Alpine
// CDN script (document order = execution order), so our `alpine:init` listener
// is registered before Alpine boots and starts processing the DOM. No build
// step, no Web Components — Alpine owns all behavior and lifecycle.
import { registerViews } from "./alpine/views.js";
import { registerHeroes } from "./alpine/heroes.js";
import { registerStaticViews } from "./alpine/static-views.js";
import { registerDashUi } from "./alpine/dash-ui.js";
import { registerSiteNav } from "./alpine/site-nav.js";
import { applyChartDefaults } from "./lib/chart-theme.js";
import { initTooltips } from "./lib/tooltip.js";
import { initHeadingAnchors } from "./lib/heading-anchors.js";
import { start } from "./router.js";
import { startAnalytics } from "./analytics.js";
import { apiUrl, gateApiOn, ROUTES } from "./lib/api.js";
import { checkApiCompat, renderReloadNotice } from "./lib/api-compat.js";
import { showMaintenance } from "./lib/maintenance-notice.js";

// Is the API one this page was built for? (D54) Started first, before the
// router renders anything or Alpine asks for data, and every lib/api.js call
// waits on the verdict — so an API outside this site's declared range (its own
// /version.json `apiRange`) gets a reload notice and no other /api/* request.
// An unanswerable check is "don't know" and lets the page carry on as before.
const apiCompat = checkApiCompat({ siteVersionUrl: "/version.json", apiVersionUrl: apiUrl(ROUTES.apiVersion) });
gateApiOn(apiCompat.then((r) => r.status !== "incompatible"));
apiCompat.then((r) => {
  if (r.status === "incompatible") renderReloadNotice(document, r);
});

// A planned or active maintenance window (issue 1220): a banner before it, a
// maintenance view during it. Never blocks. It waits on the compat verdict like
// every other /api/* call, so an out-of-range page makes no further request.
apiCompat.then((r) => {
  if (r.status !== "incompatible") showMaintenance(document, apiUrl(ROUTES.status.maintenance));
});

// Register every Alpine.data factory the views need, before Alpine starts.
// .rm-tip behaviour, bound once by delegation (see lib/tooltip.js).
initTooltips();
// Section links on the pages that opt in with data-anchors (lib/heading-anchors.js).
// Before start() below, so the first route's rm:view-changed is caught.
initHeadingAnchors();

document.addEventListener("alpine:init", () => {
  const Alpine = window.Alpine;

  // Chart.js CDN precedes Alpine in document order, so window.Chart is ready by
  // now — set the shared chart theme defaults once, before any chart draws.
  applyChartDefaults();

  registerSiteNav(Alpine);
  registerViews(Alpine);
  registerHeroes(Alpine);
  registerStaticViews(Alpine);
  // Dashboard (.a3 scope) UI primitives — issue #379. Registered once here,
  // like the other alpine/* helpers, so every future dashboard fragment can
  // use a3Tabs/a3Dialog/a3Sheet/etc. without its own registration step.
  registerDashUi(Alpine);
});

// Subscribe to the router's `rm:view-changed` BEFORE start() below fires the
// first one, so the landing route is counted like every later one.
startAnalytics();

// Boot the router once the document is parsed. The router renders the current
// path into #view; Alpine's MutationObserver initializes the injected markup.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

// Global delegated "copy to clipboard" handler. An element with a
// `data-copy="<text>"` attribute copies that literal text; an element with
// `data-copy-code` copies the textContent of the <pre> in its closest
// `.docs-codeblock`. Both show transient "Copied!" feedback. Registered once at
// boot so it works for router-injected views (whose inline scripts never run).
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy], [data-copy-code]");
  if (!btn) return;
  let text;
  if (btn.hasAttribute("data-copy")) {
    text = btn.getAttribute("data-copy");
  } else {
    const pre = btn.closest(".docs-codeblock")?.querySelector("pre");
    text = pre ? pre.textContent : "";
  }
  const done = () => {
    const label = btn.querySelector("[data-copy-label]") || btn;
    const prev = label.textContent;
    label.textContent = btn.getAttribute("data-copied-text") || "Copied!";
    btn.classList.add("is-copied");
    setTimeout(() => { label.textContent = prev; btn.classList.remove("is-copied"); }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(done);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta); done();
  }
});
