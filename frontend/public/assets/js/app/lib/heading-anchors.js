// Section links on the long-read pages (RM-134).
//
// A view opts in with a `data-anchors` attribute on its content root, and
// every h2/h3 inside it that carries an id gets a small "#" link to itself.
// The ids are written into the view HTML, not generated here, so a reader
// without JavaScript, a crawler and an agent all see the same addresses the
// link copies. This file only adds the affordance.
//
// A heading can name a different target with `data-anchor="<id>"`. The
// indicator glossary does: each entry's canonical address is its section's
// id (#T10Y2Y), which the regime dashboard already links to, and a copied
// link should be that one rather than a second address for the same entry.
//
// Clicking the link is an ordinary same-page fragment link: the browser
// updates the hash and the router's popstate handler scrolls to it. On top of
// that, the full URL goes to the clipboard and the link shows "Copied" for a
// moment. A failed or unavailable clipboard shows nothing: the address bar
// already holds the link, and "Copied" would not be true.
//
// Idempotent: a heading that already has its link is left alone, so a second
// pass over the same view (the listener and the boot call racing, or a view
// that re-dispatches) adds nothing.

const ROOT = "#view [data-anchors]";
const HEADINGS = `${ROOT} :is(h2, h3)[id]`;
const LINK_CLASS = "rm-hlink";
const COPIED_CLASS = "is-copied";
const COPIED_MS = 1600;

let live = null;
const timers = new WeakMap();

/** The one visually hidden live region that announces a copy. */
function liveRegion() {
  if (live?.isConnected) return live;
  live = document.createElement("div");
  live.className = "rm-visually-hidden";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  document.body.appendChild(live);
  return live;
}

function announce(message) {
  const region = liveRegion();
  // Cleared first, and set a beat later, so a second copy of the same
  // sentence is still a change a screen reader will read out.
  region.textContent = "";
  setTimeout(() => { region.textContent = message; }, 60);
}

/** The id a heading's link points at. */
function targetId(heading) {
  return heading.getAttribute("data-anchor") || heading.id;
}

/** Add a link to every opted-in heading that does not have one yet. */
export function enhanceHeadings(root = document) {
  root.querySelectorAll(HEADINGS).forEach((heading) => {
    if (heading.querySelector(`:scope > .${LINK_CLASS}`)) return;
    // A link cannot sit inside another link: the blog index's card titles
    // are inside the card's own <a>, and keep their ids without a link.
    if (heading.closest("a")) return;
    const link = document.createElement("a");
    link.className = LINK_CLASS;
    link.href = `#${targetId(heading)}`;
    link.setAttribute("aria-label", "Link to this section");
    heading.appendChild(link);
  });
}

function showCopied(link) {
  clearTimeout(timers.get(link));
  link.classList.add(COPIED_CLASS);
  timers.set(link, setTimeout(() => link.classList.remove(COPIED_CLASS), COPIED_MS));
  announce("Link copied");
}

function onClick(e) {
  const link = e.target instanceof Element ? e.target.closest(`.${LINK_CLASS}`) : null;
  if (!link || !link.closest(ROOT)) return;
  // A modified click opens or saves the link; that is the reader's own
  // intent, and copying on top of it would be a surprise.
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  // No preventDefault: the hash updates and the page scrolls as for any
  // fragment link. The URL is built rather than read back from location, so
  // it does not depend on when the browser applies the new fragment.
  const id = (link.getAttribute("href") || "").slice(1);
  if (!id) return;
  const url = `${location.origin}${location.pathname}#${id}`;
  const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (!write) return;
  write(url).then(() => showCopied(link), () => {});
}

export function initHeadingAnchors() {
  if (document.documentElement.dataset.rmHlinks === "1") return;
  document.documentElement.dataset.rmHlinks = "1";
  addEventListener("rm:view-changed", () => enhanceHeadings());
  document.addEventListener("click", onClick);
  enhanceHeadings();
}
