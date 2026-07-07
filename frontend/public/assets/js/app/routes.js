const VIEW_DIR = "/views";
export const HOME_VIEW = `${VIEW_DIR}/home.html`;
export const ALLOCATION_VIEW = `${VIEW_DIR}/allocation.html`;
export const PERFORMANCE_VIEW = `${VIEW_DIR}/performance.html`;
export const PROJECTS_VIEW = `${VIEW_DIR}/projects.html`;
export const NOT_FOUND_VIEW = `${VIEW_DIR}/not-found.html`;

/** @type {Record<string, string>} */
const ROUTES = {
  "/": HOME_VIEW,
  "/research": HOME_VIEW,
  "/allocation": ALLOCATION_VIEW,
  "/performance": PERFORMANCE_VIEW,
  "/allocation2": PERFORMANCE_VIEW, // legacy redirect
  "/projects": PROJECTS_VIEW,
};

/** @param {string} pathname */
export function viewFor(pathname) {
  if (ROUTES[pathname]) return ROUTES[pathname];
  if (/^\/committee\/members\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/committee/member.html`;
  }
  if (/^\/committee\/\d{4}-\d{2}-\d{2}\/[^/]+\/?$/.test(pathname)) {
    return `${VIEW_DIR}/committee/session.html`;
  }
  const clean = pathname.replace(/\/+$/, "");
  return `${VIEW_DIR}${clean}.html`;
}
