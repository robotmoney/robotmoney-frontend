// Analytics dashboard shell — sidebar + topbar + gate composition (issue
// #380, P0.3/P0.4 — docs/bot-analytics-ui-port-plan.md §5.0). Registered
// Alpine.data factory for the layout fragment (views/dash/_layout.html),
// which the router injects once per `layout: DASH_LAYOUT_VIEW` route and
// reuses across same-layout navigations (router.js's layout composition) —
// so this component's own state (sidebar collapse, gate session) survives a
// route change; only the `[data-outlet]` content underneath it is swapped.
//
// ONE flat component (gate state + shell state), matching the existing
// admin surface's convention (alpine/views/admin-surface.js: a single
// x-data toggling between a login form and a shell via x-show) rather than
// nesting a separate Alpine component for the gate — createDashGateState()
// (dash-gate.js) supplies that half, spread in below.
import { routeMetaFor } from "../../routes.js";
import { createDashGateState } from "./dash-gate.js";

// Exact order/icons from the plan (§5.0). Hrefs point at real target paths
// registered by routes.js even before their own phase issue (§8) ships real
// content — until then they render the shared "coming soon" placeholder
// (routes.js's DASH_COMING_SOON_VIEW), so a click never 404s.
const NAV_ITEMS = [
  { href: "/list", label: "List", icon: "list-ordered" },
  { href: "/list2", label: "List v2 (WIP)", icon: "list-ordered" },
  { href: "/list3", label: "List v3", icon: "trophy" },
  { href: "/projects", label: "Projects", icon: "layers" },
  { href: "/about", label: "About", icon: "help-circle" },
];
const TOOLS_ITEMS = [
  { href: "/ask-mr-roboto", label: "Ask Mr. Roboto", icon: "message-square" },
  { href: "/dashboard", label: "Activity Log", icon: "activity" },
  { href: "/methodology", label: "Methodology", icon: "book-open" },
];

export function registerDashShellView(Alpine) {
  Alpine.data("dashShell", () => ({
    ...createDashGateState(),

    // ── shell chrome ──────────────────────────────────────────────────────
    collapsed: false,
    pathname: location.pathname,
    // Whether the CURRENT route requires the gate — can change between
    // navigations even while this same layout instance stays mounted (e.g.
    // /submit is ungated, /list is gated; both share DASH_LAYOUT_VIEW).
    gated: routeMetaFor(location.pathname)?.gated ?? false,
    navItems: NAV_ITEMS,
    toolsItems: TOOLS_ITEMS,

    async init() {
      await this.initGate();
      // Subsequent navigations: routeMetaFor is the single source of truth
      // (routes.js) for whether the new route is gated, so re-derive both
      // fields from the SAME event router.js already dispatches at the end
      // of every render() — no dashboard-specific event needed.
      this._onRouteChanged = (e) => {
        this.pathname = e.detail.pathname;
        this.gated = routeMetaFor(this.pathname)?.gated ?? false;
      };
      window.addEventListener("rm:view-changed", this._onRouteChanged);
    },
    destroy() {
      window.removeEventListener("rm:view-changed", this._onRouteChanged);
    },

    toggleCollapsed() {
      this.collapsed = !this.collapsed;
    },
    isActive(href) {
      return this.pathname === href;
    },
    // Topbar title: the active nav/tools item's label, else the original's
    // own fallback for routes with no matching sidebar entry (e.g.
    // /agents/:id) — §5.0 acceptance: 'title fallback "Dashboard" on
    // non-nav routes'.
    pageTitle() {
      const item = [...this.navItems, ...this.toolsItems].find((i) => i.href === this.pathname);
      return item ? item.label : "Dashboard";
    },
    // Ghost "Sign Out" in the Tools group: clear the session and fall back
    // to the gate (§5.0) rather than navigating anywhere.
    signOut() {
      this.logout();
    },
  }));
}
