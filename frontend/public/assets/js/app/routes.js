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
// /list "Total Market" (issue #384, §5.1, P2.1) — the flagship page, the
// first dashboard route to ship real content ahead of the coming-soon
// placeholder above.
const LIST_VIEW = `${VIEW_DIR}/dash/list.html`;
// /list2 "List v2 (WIP)" and /list3 "List v3 · Money Agents" (issue #387,
// §5.2/§5.3, P2.6/P2.7) — the second and third dashboard routes to ship real
// content ahead of the coming-soon placeholder above.
const LIST2_VIEW = `${VIEW_DIR}/dash/list2.html`;
const LIST3_VIEW = `${VIEW_DIR}/dash/list3.html`;
// /submit — public intake (issue #393, §5.17): the CommitForm + REST/skills
// onboarding card. Ships real content ahead of the coming-soon placeholder
// (like LIST_VIEW above); public/ungated per the DASH_ROUTES entry below.
const SUBMIT_VIEW = `${VIEW_DIR}/dash/submit.html`;
// /market + /dashboard "Agent Activity Log" TerminalFeed (issue #392, §5.6,
// P4.1) — both routes intentionally alias this SAME fragment (the original's
// own aliasing, §4.1).
const ACTIVITY_VIEW = `${VIEW_DIR}/dash/activity.html`;
// /agents "OpenClaw Agents" (issue #385, §5.7, P2.2) — the first per-entity
// directory page to ship real content ahead of the coming-soon placeholder
// above.
const AGENTS_VIEW = `${VIEW_DIR}/dash/agents.html`;
// /agents/:id "Money-agent dossier" AgentProfile (issue #390, §5.8, P3.2) —
// the first param-route dashboard page to ship real content ahead of the
// coming-soon placeholder every other `:id`/`:slug` route still points at.
const AGENT_PROFILE_VIEW = `${VIEW_DIR}/dash/agent-profile.html`;
// Real fragments (issue #386, §5.9/§5.11/§5.13, P2.3/P2.4/P2.5) — the first
// three DASH_ROUTES entries to graduate off DASH_COMING_SOON_VIEW.
const LOBSTER_VIEW = `${VIEW_DIR}/dash/lobster.html`;
const VAULTS_VIEW = `${VIEW_DIR}/dash/vaults.html`;
const WALLETS_VIEW = `${VIEW_DIR}/dash/wallets.html`;
// /methodology "Scoring Methodology" (issue #395, §5.15, P4.3) and /about
// (issue #395, §5.16, P4.2) — both static content pages (no API), the last
// two of the shell's original nav-wired routes to ship real content ahead of
// the coming-soon placeholder above.
const METHODOLOGY_VIEW = `${VIEW_DIR}/dash/methodology.html`;
const ABOUT_VIEW = `${VIEW_DIR}/dash/about.html`;
// /ask-mr-roboto "Ask Mr. Roboto" (issue #394, §5.18, P5.1) — AI
// recommendation assistant + side-by-side comparison tool. Ships real content
// ahead of the coming-soon placeholder above; see dash-ask-roboto.js for why
// this is a deterministic rule-based matcher, never an LLM call.
const ASK_ROBOTO_VIEW = `${VIEW_DIR}/dash/ask-roboto.html`;
// /projects/:slug "ProjectProfile" dossier (issue #389, §5.5, P3.1) — the
// first PARAM route (DASH_PARAM_ROUTES below, not DASH_ROUTES) to ship real
// content ahead of the coming-soon placeholder.
const PROJECT_PROFILE_VIEW = `${VIEW_DIR}/dash/project-profile.html`;
// /lobster/:id, /vaults/:id, /wallets/:id detail dossiers (issue #391, §5.10/
// §5.12/§5.14, P3.3/P3.4/P3.5) — the first PARAM routes to ship real content
// ahead of the coming-soon placeholder (§4.1's "5 param regexes").
const COIN_PROFILE_VIEW = `${VIEW_DIR}/dash/coin-profile.html`;
const VAULT_PROFILE_VIEW = `${VIEW_DIR}/dash/vault-profile.html`;
const WALLET_PROFILE_VIEW = `${VIEW_DIR}/dash/wallet-profile.html`;

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
  "/list": { view: LIST_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/list2": { view: LIST2_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/list3": { view: LIST3_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/market": { view: ACTIVITY_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/dashboard": { view: ACTIVITY_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/agents": { view: AGENTS_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/lobster": { view: LOBSTER_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/vaults": { view: VAULTS_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/wallets": { view: WALLETS_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/methodology": { view: METHODOLOGY_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/about": { view: ABOUT_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/ask-mr-roboto": { view: ASK_ROBOTO_VIEW, layout: DASH_LAYOUT_VIEW, gated: true },
  "/submit": { view: SUBMIT_VIEW, layout: DASH_LAYOUT_VIEW, gated: false },
};

// Param-route regexes (§4.1's "5 param regexes"). `/projects/:slug` is the
// odd one out: its header in the plan (§5.5) explicitly marks ProjectProfile
// "— public" (unlike its siblings) because /projects (the list) is already a
// live, ungated page in this repo (INV-C §4) — gating its own profile
// sub-route would be a product regression this issue does not own. Issue
// #389 (P3.1) graduates it off the shared placeholder onto its own real
// fragment — the first param route to do so; the other four are unchanged.
/** @type {Array<{ test: RegExp; route: DashRoute }>} */
const DASH_PARAM_ROUTES = [
  { test: /^\/agents\/[^/]+\/?$/, route: { view: AGENT_PROFILE_VIEW, layout: DASH_LAYOUT_VIEW, gated: true } },
  { test: /^\/lobster\/[^/]+\/?$/, route: { view: COIN_PROFILE_VIEW, layout: DASH_LAYOUT_VIEW, gated: true } },
  { test: /^\/vaults\/[^/]+\/?$/, route: { view: VAULT_PROFILE_VIEW, layout: DASH_LAYOUT_VIEW, gated: true } },
  { test: /^\/wallets\/[^/]+\/?$/, route: { view: WALLET_PROFILE_VIEW, layout: DASH_LAYOUT_VIEW, gated: true } },
  { test: /^\/projects\/[^/]+\/?$/, route: { view: PROJECT_PROFILE_VIEW, layout: DASH_LAYOUT_VIEW, gated: false } },
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
  // NOTE: no "/research" entry. It used to resolve to HOME_VIEW, which served
  // the entire home page at a second URL — duplicate content for a crawler, and
  // a visitor who typed it got a page with no research on it. Nothing links to
  // it, and the old site 404s it. There is no research index to point at either:
  // /blog already lists both research pieces as cards, so a second listing would
  // just be /blog again under another address. Falling through to the catch-all
  // (→ views/research.html, absent → not-found) is the honest answer.
  "/allocation": ALLOCATION_VIEW,
  "/performance": PERFORMANCE_VIEW,
  "/allocation2": PERFORMANCE_VIEW, // legacy redirect
  "/projects": PROJECTS_VIEW,
  // Legacy article URL, still live on robotmoney.net and still linked from the
  // synthesis prose of twenty archived swarm sessions (they cite
  // "/articles/treasury-allocation" inline, and rewriting archived session text
  // is not an option). Same treatment as /allocation2 above: resolve the old
  // path to the view that now owns the content rather than 404 it.
  "/articles/treasury-allocation": `${VIEW_DIR}/blog/treasury-allocation.html`,
  // Admin task-queue dashboard. Explicit for clarity; the catch-all below already
  // resolves /admin → /views/admin.html. Intentionally NOT in the public nav.
  "/admin": ADMIN_VIEW,
  // Admin swarm operations surface (issue #159). Same buildless-shell
  // pattern as the public /swarm tree below: one fragment per section/
  // detail page, dynamic :id segments matched by regex. NOT in the public nav.
  "/admin/swarm": `${VIEW_DIR}/admin/swarm.html`,
  // No separate /admin/audit route: issue #159 originally shipped one, but
  // #155/PR#170's real, backend-backed audit feed landed as an in-shell
  // /admin section first, so the standalone page was dropped as a duplicate
  // (see PR #172).
};

/** @param {string} pathname */
export function viewFor(pathname) {
  // Legacy path redirect (issue #263 pass 2): the whole /committee tree,
  // including /admin/committee, renamed to /swarm. Rewrite the prefix and
  // fall through to the same swarm resolution below rather than duplicating
  // every param regex for the old prefix too — this covers every old
  // sub-path (/committee/members/:id, /admin/committee/sessions/:id, ...)
  // the same way /allocation2 covers its one legacy path above.
  if (pathname === "/committee" || pathname.startsWith("/committee/")) {
    return viewFor("/swarm" + pathname.slice("/committee".length));
  }
  if (pathname === "/admin/committee" || pathname.startsWith("/admin/committee/")) {
    return viewFor("/admin/swarm" + pathname.slice("/admin/committee".length));
  }
  // Same treatment for the doc tree's old product-name path
  // (/docs/investment-committee → /docs/investment-swarm).
  if (pathname === "/docs/investment-committee" || pathname.startsWith("/docs/investment-committee/")) {
    return viewFor("/docs/investment-swarm" + pathname.slice("/docs/investment-committee".length));
  }
  if (ROUTES[pathname]) return ROUTES[pathname];
  // Dashboard routes (issue #380) checked next: DASH_ROUTES/DASH_PARAM_ROUTES
  // above are the single source of truth for both the fragment AND the
  // layout/gate metadata (routeMetaFor), so a path can't drift between the
  // two lookups.
  const dashRoute = dashRouteFor(pathname);
  if (dashRoute) return dashRoute.view;
  // Swarm detail sub-routes resolve to their own dedicated fragments
  // (issue #159) — checked before the generic /admin catch-all below.
  if (/^\/admin\/swarm\/subjects\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/admin/swarm-subject.html`;
  }
  if (/^\/admin\/swarm\/members\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/admin/swarm-member.html`;
  }
  if (/^\/admin\/swarm\/sessions\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/admin/swarm-session.html`;
  }
  // Every other /admin subpath (research, research/runs/:id, queue, ...)
  // resolves to the one buildless admin shell fragment; the shell itself
  // reads location.pathname to pick a section. Otherwise the catch-all
  // below would request a nonexistent per-path view fragment and 404.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return ADMIN_VIEW;
  if (/^\/swarm\/members\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/swarm/member.html`;
  }
  // Public subject profile. The admin tree has had a subject detail page since
  // #159; this is the reader-facing counterpart, and production robotmoney.net
  // has published one per subject all along. Checked here (not by the catch-all)
  // because /swarm/subjects/<id> would otherwise resolve to a per-id
  // fragment that does not exist and 404.
  if (/^\/swarm\/subjects\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/swarm/subject.html`;
  }
  if (/^\/swarm\/takes\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/swarm/take.html`;
  }
  // Application status page (docs/architecture.md §11 R2) — checked before the generic
  // catch-all below so /swarm/apply/<id> doesn't 404 by resolving to a
  // nonexistent per-id fragment. /swarm/apply (no id) still falls through
  // to the catch-all → swarm/apply.html, the application form itself.
  if (/^\/swarm\/apply\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/swarm/apply-status.html`;
  }
  if (/^\/swarm\/\d{4}-\d{2}-\d{2}\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/swarm/session.html`;
  }
  // /swarm/sessions/<uuid> — one session by its own id, the same fragment as
  // the dated form above. A subject may convene more than once a day (migration
  // 0022), so the dated URL can only ever reach the LAST session of a day; this
  // is how a list row links to the exact session it describes. The uuid shape is
  // matched explicitly so this can never swallow some future
  // /swarm/sessions/<word> page.
  if (/^\/swarm\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(pathname)) {
    return `${VIEW_DIR}/swarm/session.html`;
  }
  const clean = pathname.replace(/\/+$/, "");
  return `${VIEW_DIR}${clean}.html`;
}
