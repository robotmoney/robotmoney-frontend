// @ts-check
// An address on the deposit pages links to Basescan and copies in one tap
// (David, 25 Nov). The views spread these into their Alpine components.

import { MANIFEST } from "./manifest.js";

/** Basescan for a full address, or null for anything else. @param {string | null | undefined} a */
export const addrHref = (a) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${MANIFEST.explorer}/address/${a}` : null);

/**
 * Copy an address. The button shows a check for a moment and says so to a
 * screen reader through its label.
 * @param {string} a @param {HTMLElement} [btn]
 */
export async function copyAddr(a, btn) {
  try { await navigator.clipboard.writeText(a); } catch { return; }
  if (!btn) return;
  const label = btn.getAttribute("aria-label") || "";
  btn.setAttribute("data-copied", "");
  btn.setAttribute("aria-label", "Copied");
  setTimeout(() => { btn.removeAttribute("data-copied"); btn.setAttribute("aria-label", label); }, 1500);
}
