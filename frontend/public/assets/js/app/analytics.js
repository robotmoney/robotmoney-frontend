// Google Analytics 4 pageviews for a client-rendered SPA.
//
// The loader and `gtag('config', ...)` live in index.html's <head> (the tag
// Google issues, kept recognisable so it can be diffed against the console).
// This module owns the half a standard snippet gets wrong on an SPA: the
// router swaps view fragments through the history API without a document
// navigation, so gtag's automatic page_view fires exactly once, on the shell,
// and every route after that goes unrecorded. GA4's enhanced-measurement
// "history change" option is not a substitute either: it fires on pushState,
// which here is BEFORE the fragment is fetched and before seo.js has rewritten
// the title, so it reports the previous page's title against the new URL.
//
// So the config in <head> sets `send_page_view: false` and every pageview,
// including the first, is sent from here on `rm:view-changed` — the event the
// router dispatches last, after the view is in the DOM, the nav is synced and
// applyRouteMeta() has run. At that moment document.title and location.href
// are the ones a reader sees, which is what makes the GA4 report line up with
// the page rather than with the navigation that preceded it.
//
// Degrades to nothing if the tag is absent or blocked: gtag() is defined
// synchronously by the inline snippet, so the guard below is about consent
// blockers and offline preview, not about load order.

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
