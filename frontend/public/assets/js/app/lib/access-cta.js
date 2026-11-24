// @ts-check
// Once this browser holds an early access code (lib/deposit/access.js), the
// site's "Request early access" calls to action lead to the deposit page
// instead (David, 23 Nov 2026: someone let in who loses the deposit page must
// find it again from anywhere on the site). Only call-to-action links change:
// the nav button and the buttons and CTA rows that point at /early-access.
// Prose links about the programme, the footer index and the early access form
// stay as they are. It runs in the browser only, so prerendered pages and
// search engines keep the default.
import { isOpen } from "./deposit/access.js";

const CTA = 'a[href="/early-access"]:is(.nav__cta, .btn-primary, .rr-cta, .rr-btn, .cl__lnk)';
const LABEL = /Request early access/;

function swap() {
  if (!isOpen()) return;
  document.querySelectorAll(CTA).forEach((a) => {
    a.setAttribute("href", "/deposit");
    const walk = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeValue && LABEL.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(LABEL, "Deposit");
    }
  });
}

/** Swap now, on every page change, when a code is accepted, and when a view renders a call to action late. */
export function initAccessCta() {
  swap();
  addEventListener("rm:view-changed", swap);
  addEventListener("rm:access", swap);
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; swap(); });
  }).observe(document.body, { childList: true, subtree: true });
}
