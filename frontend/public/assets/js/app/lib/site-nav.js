// The site nav's sections, and which one a path belongs to (RM-124).
//
// PURE: no DOM. router.js syncNav() lights the section this returns, and
// alpine/site-nav.js drives the panels. The markup in index.html carries one
// `data-nav-section` per group, keyed on these same keys, and
// scripts/tests/unit/site-nav.test.ts holds the two lists equal.
//
// A section owns its prefixes on a segment boundary: "/regime" owns
// /regime/indicators and not /regime-detection, which is listed on its own.
// The longest prefix wins, so the Robot Money Vault's page lights Vaults and
// the RM Protocol Labs Treasury's lights Company, though both sit under /swarm.

/** @type {Array<{ key: string, prefixes: string[] }>} */
export const NAV_SECTIONS = [
  { key: "vaults", prefixes: ["/vault", "/allocation", "/swarm/subjects/robotmoney-vault"] },
  { key: "swarm", prefixes: ["/swarm", "/committee"] },
  {
    key: "research",
    prefixes: ["/regime", "/regime-detection", "/regime_2panel", "/blog", "/research", "/articles", "/smart-contract-risks"],
  },
  { key: "docs", prefixes: ["/skills", "/docs", "/changelog"] },
  { key: "company", prefixes: ["/tokenomics", "/media", "/performance", "/swarm/subjects/robotmoney-treasury"] },
];

/** @param {string} pathname */
function clean(pathname) {
  const p = String(pathname || "/").replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/**
 * The nav section a path sits in, or null (home, legal pages, the gated
 * dashboards, anything the nav does not list).
 * @param {string} pathname
 * @returns {string | null}
 */
export function navSectionFor(pathname) {
  const path = clean(pathname);
  let best = null;
  let bestLen = 0;
  for (const { key, prefixes } of NAV_SECTIONS) {
    for (const p of prefixes) {
      if ((path === p || path.startsWith(p + "/")) && p.length > bestLen) {
        best = key;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/**
 * Whether a nav link is the page being read. Only a page address counts: a
 * link to a section of a page (/swarm#members) is never "current", so the
 * page's own entry (/swarm) is the one marked.
 * @param {string} href
 * @param {string} pathname
 */
export function isCurrentLink(href, pathname) {
  if (!href || href.includes("#")) return false;
  let linkPath = href;
  try {
    linkPath = new URL(href, "http://x").pathname;
  } catch {
    return false;
  }
  return clean(linkPath) === clean(pathname);
}
