// Optional pageview adapter for a client-rendered SPA. Executable third-party
// loaders are deliberately absent: static documents use a same-origin script
// CSP because privileged routes can hold rm_admin_token. A future analytics
// integration must therefore expose a reviewed same-origin window.gtag bridge.
// The event is dispatched after the router has updated both DOM and metadata,
// so that bridge can report the final title and URL rather than a stale route.

export function startAnalytics() {
  window.addEventListener("rm:view-changed", () => {
    if (typeof window.gtag !== "function") return;
    window.gtag("event", "page_view", {
      page_title: document.title,
      page_location: window.location.href,
      page_path: window.location.pathname + window.location.search,
    });
  });
}
