// Tiny history-API client router — zero dependencies. Fetches a view fragment
// and injects it into <main id="view">. Alpine's own MutationObserver picks up
// the injected light-DOM markup and initializes any x-data it finds, so we do
// not call Alpine.initTree() ourselves.
//
// Known routes map a pathname to a view file. Unknown same-origin paths fall
// back to the home view so internal links never 404 during early development.

import { NOT_FOUND_VIEW, routeMetaFor, viewFor } from "./routes.js";
import { applyRouteMeta } from "./seo.js";
import { isCurrentLink, navSectionFor } from "./lib/site-nav.js";

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

// Mark where the reader is in the site nav (RM-124): the group that owns the
// path by prefix keeps its underline, so /vault/rmagent lights Vaults, and the
// link to the page itself is aria-current. A group's button carries
// aria-current too, since its panel (and the current link in it) is closed.
// Sections: lib/site-nav.js.
function syncNav(pathname) {
  const section = navSectionFor(pathname);
  document.querySelectorAll(".nav__group").forEach((g) => {
    const top = g.querySelector(".nav__top");
    if (!top) return;
    const on = g.dataset.navSection === section;
    top.classList.toggle("nav__top--active", on);
    if (top.tagName === "BUTTON") {
      if (on) top.setAttribute("aria-current", "true");
      else top.removeAttribute("aria-current");
    }
  });
  document.querySelectorAll(".nav a").forEach((a) => {
    if (isCurrentLink(a.getAttribute("href") || "", pathname)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

async function fetchView(file, signal) {
  const res = await fetch(file, { headers: { Accept: "text/html" }, signal });
  if (!res.ok) throw new Error(`view fetch failed: ${file} (${res.status})`);
  return res.text();
}

let activeRender = null;
// The path the mounted view was rendered for. A popstate that leaves it
// unchanged moved only the fragment (see onPopState).
let renderedPath = null;

async function render(pathname) {
  // Bare /vault is the four vaults on /allocation. The address moves there,
  // query kept (the vault data switch rides on it), so the page, its canonical
  // and its #vaults section all agree on where the reader is.
  if (pathname === "/vault" || pathname === "/vault/") {
    history.replaceState(history.state, "", "/allocation" + location.search + "#vaults");
    pathname = "/allocation";
  }
  const host = viewEl();
  if (!host) return;
  stopSettling();
  renderedPath = pathname;
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
  stopSettling();
  const found = scrollToFragment();
  if (!found) window.scrollTo(0, 0);
  if (location.hash) settleOnFragment();
}

// A view that draws its sections only once its data lands has no target yet
// when the route renders: the swarm page wraps every section in
// x-if="!loading", so a link to /swarm#history from another page landed at the
// top and stayed there (RM-127). And a target that does exist moves as the
// content above it fills in. So for a while after a route renders, the target
// is scrolled to when it appears and held there as the view changes size.
// It hands off the moment the reader scrolls, clicks or types, on the next
// route, or after SETTLE_MS, whichever comes first.
const SETTLE_MS = 8000;
let settling = null;

function stopSettling() {
  if (settling) settling();
  settling = null;
}

function settleOnFragment() {
  const view = viewEl();
  if (!view || typeof ResizeObserver !== "function") return;
  const hold = () => {
    const target = fragmentTarget();
    if (!target) return;
    const top = fragmentTop(target);
    if (Math.abs(top - window.scrollY) > 1) window.scrollTo(0, top);
  };
  const resized = new ResizeObserver(hold);
  const mutated = new MutationObserver(hold);
  resized.observe(view);
  mutated.observe(view, { childList: true, subtree: true });
  const intents = ["wheel", "touchstart", "pointerdown", "keydown"];
  const handOff = () => stopSettling();
  intents.forEach((t) => window.addEventListener(t, handOff, { passive: true, capture: true }));
  const timer = setTimeout(handOff, SETTLE_MS);
  settling = () => {
    resized.disconnect();
    mutated.disconnect();
    intents.forEach((t) => window.removeEventListener(t, handOff, { capture: true }));
    clearTimeout(timer);
  };
}

// The site header is fixed, so a target scrolled to the very top sits under
// it. Clear the header's bottom edge, then the usual breathing room.
function anchorOffset() {
  const nav = document.querySelector(".nav");
  const pos = nav ? getComputedStyle(nav).position : "";
  const covered = nav && (pos === "fixed" || pos === "sticky") ? Math.max(0, nav.getBoundingClientRect().bottom) : 0;
  return covered + ANCHOR_OFFSET;
}

// The element the fragment names, or null.
function fragmentTarget() {
  let id = "";
  try { id = location.hash ? decodeURIComponent(location.hash.slice(1)) : ""; } catch (_) { return null; }
  return id ? document.getElementById(id) : null;
}

// Where the page scrolls to show a target. A target that sets its own
// scroll-margin-top (the changelog's entries, a take card) keeps it;
// everything else clears the fixed header.
function fragmentTop(target) {
  const offset = parseFloat(getComputedStyle(target).scrollMarginTop) || anchorOffset();
  return Math.max(0, Math.round(target.getBoundingClientRect().top + window.scrollY - offset));
}

// Scroll to the element the fragment names; false when there is none.
// Exported for a view whose sections draw only after its data lands (a vault
// page's #holdings): it calls this once they exist.
export function scrollToFragment() {
  const target = fragmentTarget();
  if (!target) return false;
  // A frame later: the view is in the DOM but not yet laid out, and Alpine has
  // not had its pass, so anything above the target can still change height.
  requestAnimationFrame(() => window.scrollTo(0, fragmentTop(target)));
  return true;
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
  // A file, not a route (llms.txt, openapi.json, skill.md): let the browser
  // load it. Same rule as website-server/nginx.conf's file location.
  if (/\.(?!html$)[a-z0-9]+$/i.test(url.pathname)) return;
  if (url.hash && url.pathname === location.pathname) return; // in-page anchor

  e.preventDefault();
  if (url.pathname !== location.pathname || url.search !== location.search) {
    history.pushState({}, "", url.pathname + url.search + url.hash);
  }
  render(url.pathname);
}

function onPopState() {
  // Browsers fire popstate when only the fragment changes: an in-page anchor
  // (a take, a docs section) or Back across one. That is the same page, so it
  // scrolls to the fragment and keeps the view. Rendering again here re-ran
  // every fetch the view makes and scrolled to the top before the target
  // existed, so every in-page link on the site landed the reader at the top.
  if (location.pathname === renderedPath) {
    scrollToFragment();
    return;
  }
  render(location.pathname);
}

export function start() {
  document.addEventListener("click", onClick);
  window.addEventListener("popstate", onPopState);
  render(location.pathname);
}
