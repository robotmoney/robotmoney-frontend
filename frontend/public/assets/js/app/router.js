// Tiny history-API client router — zero dependencies. Fetches a view fragment
// and injects it into <main id="view">. Alpine's own MutationObserver picks up
// the injected light-DOM markup and initializes any x-data it finds, so we do
// not call Alpine.initTree() ourselves.
//
// Known routes map a pathname to a view file. Unknown same-origin paths fall
// back to the home view so internal links never 404 during early development.

const VIEW_DIR = "/views";
const HOME_VIEW = `${VIEW_DIR}/home.html`;

// Explicit path -> view file table. Paths without a dedicated view file map to
// the home view as a placeholder for now.
const ROUTES = {
  "/": HOME_VIEW,
  // /regime and /committee resolve to their own /views/<seg>.html via viewFor();
  // routes without a dedicated view file fall back to the home view.
  "/allocation": HOME_VIEW,
  "/research": HOME_VIEW,
};

const viewEl = () => document.getElementById("view");

// Resolve a pathname to the view file we should fetch. Prefer an explicit
// route; otherwise attempt /views/<first-segment>.html (the caller falls back
// to home if that fetch 404s).
function viewFor(pathname) {
  if (ROUTES[pathname]) return ROUTES[pathname];
  const seg = pathname.replace(/^\/+/, "").split("/")[0];
  if (seg) return `${VIEW_DIR}/${seg}.html`;
  return HOME_VIEW;
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

async function fetchView(file) {
  const res = await fetch(file, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`view fetch failed: ${file} (${res.status})`);
  return res.text();
}

async function render(pathname) {
  const host = viewEl();
  if (!host) return;
  const primary = viewFor(pathname);
  let html;
  try {
    html = await fetchView(primary);
  } catch (_) {
    // Unknown/missing view — fall back to the home view so links don't 404.
    html = await fetchView(HOME_VIEW);
  }
  host.innerHTML = html;
  window.scrollTo(0, 0);
  syncNav(pathname);
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
    history.pushState({}, "", url.pathname + url.search);
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
