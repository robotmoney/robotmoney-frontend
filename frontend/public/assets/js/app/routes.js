const VIEW_DIR = "/views";
export const HOME_VIEW = `${VIEW_DIR}/home.html`;
export const ALLOCATION_VIEW = `${VIEW_DIR}/allocation.html`;
export const PERFORMANCE_VIEW = `${VIEW_DIR}/performance.html`;
export const PROJECTS_VIEW = `${VIEW_DIR}/projects.html`;
export const ADMIN_VIEW = `${VIEW_DIR}/admin.html`;
export const NOT_FOUND_VIEW = `${VIEW_DIR}/not-found.html`;

// Analytics dashboard shell (issue #380, P0.3/P0.4 — docs/bot-analytics-ui-
// port-plan.md §3, §4.1, §5.0). `DASH_LAYOUT_VIEW` is the shared
// DashboardLayout-equivalent fragment: any route below carrying a `layout`
// entry gets fetched, injected once, and reused across same-layout
// navigations by router.js's layout composition (the view itself is then
// injected into the layout's `[data-outlet]`, matching react-router's
// `<Outlet/>` semantics per §3's architecture table).
export const DASH_LAYOUT_VIEW = `${VIEW_DIR}/dash/_layout.html`;
// Every dashboard page below is wired (path, layout, gate) by THIS issue but
// still ships its real content in a LATER phase issue (§8: P2.x/P3.x/P4.x/
// P5.x) — until then every one of them points at this shared "coming soon"
// placeholder fragment so the route, the gate, and the sidebar's active-link
// state are all real and testable today without inventing per-page content
// this issue does not own.
const DASH_COMING_SOON_VIEW = `${VIEW_DIR}/dash/coming-soon.html`;

// Static dashboard routes (§4.1's list) that render inside DASH_LAYOUT_VIEW.
// `gated: true` means dash-shell.js's gate must pass before the outlet
// content is shown (§5.0) — everything here is gated EXCEPT `/submit`, which
// is linked directly off the (pre-auth) gate screen itself ("Submit a
// community commit") and is explicitly called out as public in the plan
// (§5.17 header) — it could not be reachable pre-auth if it required the
// gate. `/market` and `/dashboard` intentionally alias the same fragment
// (the original's own aliasing, §4.1).
/** @typedef {{ view: string; layout?: string; gated?: boolean }} DashRoute */
/** @type {Record<string, DashRoute>} */
const DASH_ROUTES = {
  "/list": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/list2": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/list3": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/market": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/dashboard": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/agents": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/lobster": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/vaults": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/wallets": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/methodology": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/about": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/ask-mr-roboto": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/submit": { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: false },
};

// Param-route regexes (§4.1's "5 param regexes"). `/projects/:slug` is the
// odd one out: its header in the plan (§5.5) explicitly marks ProjectProfile
// "— public" (unlike its siblings) because /projects (the list) is already a
// live, ungated page in this repo (INV-C §4) — gating its own profile
// sub-route would be a product regression this issue does not own.
/** @type {Array<{ test: RegExp; route: DashRoute }>} */
const DASH_PARAM_ROUTES = [
  { test: /^\/agents\/[^/]+\/?$/, route: { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true } },
  { test: /^\/lobster\/[^/]+\/?$/, route: { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true } },
  { test: /^\/vaults\/[^/]+\/?$/, route: { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true } },
  { test: /^\/wallets\/[^/]+\/?$/, route: { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: true } },
  { test: /^\/projects\/[^/]+\/?$/, route: { view: DASH_COMING_SOON_VIEW, layout: DASH_LAYOUT_VIEW, gated: false } },
];

/** @param {string} pathname @returns {DashRoute | null} */
function dashRouteFor(pathname) {
  if (DASH_ROUTES[pathname]) return DASH_ROUTES[pathname];
  for (const { test, route } of DASH_PARAM_ROUTES) {
    if (test.test(pathname)) return route;
  }
  return null;
}

/**
 * Route-composition metadata for the router's layout/gate extension
 * (router.js). Returns `null` for every non-dashboard route (unchanged
 * single-fragment rendering) so this is a strict addition, not a behavior
 * change, for every route that existed before issue #380.
 * @param {string} pathname
 * @returns {{ layout?: string; gated: boolean } | null}
 */
export function routeMetaFor(pathname) {
  const route = dashRouteFor(pathname);
  if (!route) return null;
  return { layout: route.layout, gated: !!route.gated };
}

/** @type {Record<string, string>} */
const ROUTES = {
  "/": HOME_VIEW,
  "/research": HOME_VIEW,
  "/allocation": ALLOCATION_VIEW,
  "/performance": PERFORMANCE_VIEW,
  "/allocation2": PERFORMANCE_VIEW, // legacy redirect
  "/projects": PROJECTS_VIEW,
  // Legacy article URL, still live on robotmoney.net and still linked from the
  // synthesis prose of twenty archived committee sessions (they cite
  // "/articles/treasury-allocation" inline, and rewriting archived session text
  // is not an option). Same treatment as /allocation2 above: resolve the old
  // path to the view that now owns the content rather than 404 it.
  "/articles/treasury-allocation": `${VIEW_DIR}/blog/treasury-allocation.html`,
  // Admin task-queue dashboard. Explicit for clarity; the catch-all below already
  // resolves /admin → /views/admin.html. Intentionally NOT in the public nav.
  "/admin": ADMIN_VIEW,
  // Admin committee operations surface (issue #159). Same buildless-shell
  // pattern as the public /committee tree below: one fragment per section/
  // detail page, dynamic :id segments matched by regex. NOT in the public nav.
  "/admin/committee": `${VIEW_DIR}/admin/committee.html`,
  // No separate /admin/audit route: issue #159 originally shipped one, but
  // #155/PR#170's real, backend-backed audit feed landed as an in-shell
  // /admin section first, so the standalone page was dropped as a duplicate
  // (see PR #172).
};

/** @param {string} pathname */
export function viewFor(pathname) {
  if (ROUTES[pathname]) return ROUTES[pathname];
  // Dashboard routes (issue #380) checked next: DASH_ROUTES/DASH_PARAM_ROUTES
  // above are the single source of truth for both the fragment AND the
  // layout/gate metadata (routeMetaFor), so a path can't drift between the
  // two lookups.
  const dashRoute = dashRouteFor(pathname);
  if (dashRoute) return dashRoute.view;
  // Committee detail sub-routes resolve to their own dedicated fragments
  // (issue #159) — checked before the generic /admin catch-all below.
  if (/^\/admin\/committee\/subjects\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/admin/committee-subject.html`;
  }
  if (/^\/admin\/committee\/members\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/admin/committee-member.html`;
  }
  if (/^\/admin\/committee\/sessions\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/admin/committee-session.html`;
  }
  // Every other /admin subpath (research, research/runs/:id, queue, ...)
  // resolves to the one buildless admin shell fragment; the shell itself
  // reads location.pathname to pick a section. Otherwise the catch-all
  // below would request a nonexistent per-path view fragment and 404.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return ADMIN_VIEW;
  if (/^\/committee\/members\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/committee/member.html`;
  }
  // Public subject profile. The admin tree has had a subject detail page since
  // #159; this is the reader-facing counterpart, and production robotmoney.net
  // has published one per subject all along. Checked here (not by the catch-all)
  // because /committee/subjects/<id> would otherwise resolve to a per-id
  // fragment that does not exist and 404.
  if (/^\/committee\/subjects\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/committee/subject.html`;
  }
  if (/^\/committee\/takes\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/committee/take.html`;
  }
  // Application status page (docs/architecture.md §11 R2) — checked before the generic
  // catch-all below so /committee/apply/<id> doesn't 404 by resolving to a
  // nonexistent per-id fragment. /committee/apply (no id) still falls through
  // to the catch-all → committee/apply.html, the application form itself.
  if (/^\/committee\/apply\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/committee/apply-status.html`;
  }
  if (/^\/committee\/\d{4}-\d{2}-\d{2}\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/committee/session.html`;
  }
  const clean = pathname.replace(/\/+$/, "");
  return `${VIEW_DIR}${clean}.html`;
}
