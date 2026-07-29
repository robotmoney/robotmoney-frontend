const VIEW_DIR = "/views";
export const HOME_VIEW = `${VIEW_DIR}/home.html`;
export const ALLOCATION_VIEW = `${VIEW_DIR}/allocation.html`;
export const PERFORMANCE_VIEW = `${VIEW_DIR}/performance.html`;
export const PROJECTS_VIEW = `${VIEW_DIR}/projects.html`;
export const ADMIN_VIEW = `${VIEW_DIR}/admin.html`;
export const NOT_FOUND_VIEW = `${VIEW_DIR}/not-found.html`;

/** @type {Record<string, string>} */
const ROUTES = {
  "/": HOME_VIEW,
  "/research": HOME_VIEW,
  "/allocation": ALLOCATION_VIEW,
  "/performance": PERFORMANCE_VIEW,
  "/allocation2": PERFORMANCE_VIEW, // legacy redirect
  "/projects": PROJECTS_VIEW,
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
