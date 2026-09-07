// Tiny history-API client router — zero dependencies. Fetches a view fragment
// and injects it into <main id="view">. Alpine's own MutationObserver picks up
// the injected light-DOM markup and initializes any x-data it finds, so we do
// not call Alpine.initTree() ourselves.
//
// Known routes map a pathname to a view file. Unknown same-origin paths fall
// back to the home view so internal links never 404 during early development.

import { NOT_FOUND_VIEW, routeMetaFor, viewFor } from "./routes.js";
import { applyRouteMeta } from "./seo.js";

const viewEl = () => document.getElementById("view");

// Layout composition (issue #380, P0.3 — docs/bot-analytics-ui-port-plan.md
// §3's architecture-translation row: "DashboardLayout layout route + <Outlet/>
// → router layout composition"). `activeLayoutView` tracks which layout
// fragment (if any) is CURRENTLY mounted in #view, so navigating between two
// routes that share the same `layout` only swaps the outlet's content —
// the layout fragment itself (and its Alpine x-data: sidebar collapse state,
// the gate's `authed` flag) is never torn down and re-fetched. Navigating to
// a route with a different layout (or none) unmounts the previous one like
// any other view change.
let activeLayoutView = null;

function outletHost(host) {
  return host.querySelector("[data-outlet]");
}

// Mark the nav link whose href matches the current path as active/current.
function syncNav(pathname) {
  const links = document.querySelectorAll(".nav__link, .nav__mlink");
  links.forEach((a) => {
    const href = a.getAttribute("href") || "";
    let linkPath = href;
    try {
      linkPath = new URL(href, location.origin).pathname;
    } catch (_) {
      /* leave as-is for non-URL hrefs */
    }
    const active = linkPath === pathname;
    a.classList.toggle("nav__link--active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

async function fetchView(file, signal) {
  const res = await fetch(file, { headers: { Accept: "text/html" }, signal });
  if (!res.ok) throw new Error(`view fetch failed: ${file} (${res.status})`);
  return res.text();
}

let activeRender = null;

async function render(pathname) {
  const host = viewEl();
  if (!host) return;
  activeRender?.abort();
  const controller = new AbortController();
  activeRender = controller;
  const primary = viewFor(pathname);
  const meta = routeMetaFor(pathname);
  let html;
  try {
    html = await fetchView(primary, controller.signal);
  } catch (error) {
    if (error?.name === "AbortError") return;
    html = await fetchView(NOT_FOUND_VIEW, controller.signal);
  }
  if (controller.signal.aborted) return;
  // Alpine's MutationObserver sees removals after the DOM operation. Destroy
  // synchronously first so canvas render loops stop before their nodes detach.
  window.dispatchEvent(new CustomEvent("rm:before-view-change"));

  if (meta?.layout) {
    // Layout composition (issue #380): reuse the mounted layout fragment
    // across navigations that share it — only destroy+refetch it when the
    // route's layout differs from (or there is none) what is currently
    // mounted. dash-shell.js (the layout's own Alpine component) derives its
    // per-route `gated` flag itself, from routeMetaFor(pathname) — via
    // routes.js — read once at its own init() and again on every
    // `rm:view-changed` this same render() dispatches below, so no separate
    // signal is needed here for that.
    const outlet = activeLayoutView === meta.layout ? outletHost(host) : null;
    if (outlet) {
      // Same layout still mounted: tear down only the previous outlet
      // content (e.g. a chart's render loop) before swapping it, leaving the
      // layout shell's own x-data (sidebar collapse, auth session) alone.
      window.Alpine?.destroyTree?.(outlet);
      outlet.innerHTML = html;
    } else {
      const layoutHtml = await fetchView(meta.layout, controller.signal);
      if (controller.signal.aborted) return;
      window.Alpine?.destroyTree?.(host);
      host.innerHTML = layoutHtml;
      activeLayoutView = meta.layout;
      const freshOutlet = outletHost(host);
      if (freshOutlet) freshOutlet.innerHTML = html;
    }
  } else {
    activeLayoutView = null;
    window.Alpine?.destroyTree?.(host);
    host.innerHTML = html;
  }

  scrollForRoute();
  syncNav(pathname);
  // Rewrite <title>/description/canonical/OG per route so each view is distinct
  // to JS-rendering crawlers (Googlebot) and to history/bookmarks.
  applyRouteMeta(pathname);
  // The closing half of the pair opened by `rm:before-view-change` above: the
  // new view is in the DOM, the nav is synced, and the route's meta is applied,
  // so this is the first moment a consumer can observe the route as CHANGED
  // rather than as CHANGING. Dispatched last, deliberately.
  //
  // Until this existed, "the route finished rendering" was unobservable from
  // outside the router: render() awaits a view fetch, so anything that pushed
  // state and dispatched popstate returned while the swap was still in flight.
  // Every browser spec hand-rolled that fire-and-forget navigation and then
  // read the DOM, which was only safe when the very next assertion happened to
  // be a retrying locator matcher that waited the fetch out. One that was not
  // (the robots directive in projects.spec.ts) went red as soon as CI moved to
  // ephemeral runners with cold asset caches.
  window.dispatchEvent(new CustomEvent("rm:view-changed", { detail: { pathname } }));
}

// A fragment breathes rather than sitting flush against the viewport edge.
const ANCHOR_OFFSET = 16;

// Where a freshly rendered route should be scrolled to.
//
// CROSS-PAGE ANCHORS WERE INERT, and had been for every link that used one.
// Two independent causes, either of which was enough on its own:
//
//   * onClick pushed `pathname + search` and dropped the fragment, so
//     /docs/investment-swarm/participation#activation arrived as
//     /docs/investment-swarm/participation with no hash at all.
//   * this function's predecessor was an unconditional scrollTo(0, 0), so
//     even a DIRECT load carrying a fragment was scrolled back to the top
//     immediately after the view was injected.
//
// The browser's own anchor handling cannot cover for either: at load the view
// has not been fetched yet, so the target element does not exist to scroll to.
// Five docs cross-links, plus the swarm apply page's link to what `rmpc` is,
// all landed the reader at the top of a long page to hunt for the section.
//
// getElementById on the decoded fragment, never querySelector: a fragment is
// arbitrary text from the URL bar and must not be parsed as a selector.
function scrollForRoute() {
  const id = location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
  const target = id ? document.getElementById(id) : null;
  if (!target) { window.scrollTo(0, 0); return; }
  // A frame later: the view is in the DOM but not yet laid out, and Alpine has
  // not had its pass, so anything above the target can still change height.
  requestAnimationFrame(() => {
    const top = target.getBoundingClientRect().top + window.scrollY - ANCHOR_OFFSET;
    window.scrollTo(0, Math.max(0, Math.round(top)));
  });
}

// Intercept same-origin, plain left-clicks on anchors and route them in-app.
function onClick(e) {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const a = e.target.closest("a");
  if (!a) return;

  const href = a.getAttribute("href");
  if (!href) return;
  if (a.target && a.target !== "_self") return;
  if (a.hasAttribute("download")) return;
  if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;

  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return; // external link
  if (url.hash && url.pathname === location.pathname) return; // in-page anchor

  e.preventDefault();
  if (url.pathname !== location.pathname || url.search !== location.search) {
    history.pushState({}, "", url.pathname + url.search + url.hash);
  }
  render(url.pathname);
}

function onPopState() {
  render(location.pathname);
}

export function start() {
  document.addEventListener("click", onClick);
  window.addEventListener("popstate", onPopState);
  render(location.pathname);
}
