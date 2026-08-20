// Per-route SEO metadata + a client-side applier.
//
// This is a client-rendered SPA: the shell (index.html) ships ONE static
// <title>/description, and the router swaps route fragments into <main> without
// a full navigation. On every route change the router calls applyRouteMeta(),
// which rewrites <title>, meta description, canonical, and the Open Graph /
// Twitter tags so each route is distinct to crawlers that execute JS (Googlebot)
// and to in-app history/bookmarks.
//
// Crawlers and link-unfurlers that do NOT run JS still see only the shell's
// static tags — the real per-route fix for them is the deploy-time prerender
// step (tracked separately, outside the frontend). This module is the client
// half of that story and the single source of per-route copy the prerender can
// reuse.

const ORIGIN = "https://robotmoney.network";
const SITE_NAME = "Robot Money";
const OG_IMAGE = ORIGIN + "/assets/og-image.png";

// The shell's own robots directive (index.html). A route may override it with a
// `robots` key below; every other route is restored to this on navigation, so a
// noindex route can never leak its directive onto the next one.
const DEFAULT_ROBOTS = "index, follow, max-image-preview:large, max-snippet:-1";

// route -> { title, description }. Titles are unique and <= 60 chars; meta
// descriptions are 120-155 chars, grounded in each page's real copy.
/** @type {Record<string, { title: string; description: string; robots?: string }>} */
const META = {
  "/": {
    title: "Robot Money — Autonomous Treasury for the Agent Economy",
    description: "Robot Money is an autonomous USDC treasury on Base. One deposit spreads across multi-protocol DeFi yield and agent tokens; withdraw at NAV anytime.",
  },
  "/skills": {
    title: "Robot Money Skill — MCP Agent Vault Docs",
    description: "Install the Robot Money skill into any MCP agent runtime. One USDC deposit splits 95% into a multi-protocol yield vault and 5% into a 6-token agent basket.",
  },
  "/tokenomics": {
    title: "$ROBOTMONEY Tokenomics & Governance — Robot Money",
    description: "$ROBOTMONEY directs allocation of the Robot Money USDC vault on Base. Holders vote which agent tokens it holds; protocol revenue funds buybacks and burns.",
  },
  "/allocation": {
    title: "Allocation — Live Vault & Wallet AUM | Robot Money",
    description: "Track Robot Money's live allocation: vault strategy breakdown, per-adapter TVL, 7-day APY, agent wallet holdings, and $ROBOTMONEY buyback history on Base.",
  },
  "/performance": {
    title: "Wallet Performance & AUM History — Robot Money",
    description: "Track Robot Money's historical AUM and allocation since inception. Daily portfolio snapshots across all strategy wallets, drawn from live onchain data.",
  },
  "/regime": {
    title: "Market Regime Classifier — Robot Money",
    description: "Robot Money's live regime classifier blends macro, onchain, and equity-factor panels into a daily cross-asset risk-on/risk-off score, recomputed every 24h.",
  },
  "/swarm": {
    title: "AI Investment Swarm — Robot Money",
    // The trailing caveat is production's and is not decoration: this string is
    // the swarm's search-results surface, where a reader meets stances and
    // "recommendation" with none of the page's own disclaimer around them.
    description: "Robot Money's AI Investment Swarm analyzes agent portfolios daily on Base — multiple lenses, one subject per session, one signed take per member. Auto-generated content, not financial advice.",
  },
  "/projects": {
    title: "Agentic Economy Ecosystem — Robot Money",
    description: "Track market cap, FDV, revenue, and wallet balances across onchain AI agent projects and Zero Human Companies in the agent economy on Base.",
    // Kept out of the index while the table is backed by the development seed
    // (issue #346). /projects is also out of sitemap.xml, so this is the second
    // of the two places that would otherwise advertise it. `follow` so the
    // page's own outbound links keep their value. (The third was the ANALYTICS
    // nav item, removed until that surface actually serves.)
    robots: "noindex, follow",
  },
  "/media": {
    title: "Media Coverage & Press — Robot Money",
    description: "Browse press, research, token listings, and partner coverage of Robot Money, the autonomous treasury and USDC vault on Base for AI agents.",
  },
  "/changelog": {
    title: "Changelog & Roadmap — Robot Money",
    description: "See what Robot Money has shipped and what's next: a public build log and phased roadmap covering the USDC vault on Base, AI Swarm, and regime work.",
  },
  "/docs": {
    title: "Robot Money Docs — Vault, Swarm & Agent Skill",
    description: "Explore Robot Money's developer docs: the ERC-4626 USDC vault on Base, the daily AI Investment Swarm, and the robotmoney-cli skill for AI agents.",
  },
  "/faq": {
    title: "Robot Money FAQ — Autonomous Treasury Vault on Base",
    description: "Find answers about Robot Money — the ERC-4626 USDC vault on Base, autonomous DeFi allocation, the regime classifier, and permissionless NAV withdrawals.",
  },
  "/disclaimer": {
    title: "Legal Disclaimers — Robot Money",
    description: "Read the legal disclaimers for the Robot Money protocol on Base: experimental DeFi software with smart contract, regulatory, and market risks.",
  },
  // Static site policy pages (issue #395) — general marketing pages, not part
  // of the bot-analytics UI port (that plan's 20 routes are all analytics-
  // dashboard pages, see the dashboard entries further below). Indexable
  // like /disclaimer above; no `robots` override needed.
  "/terms": {
    title: "Terms of Service — Robot Money",
    description: "The Terms of Service governing your use of the Robot Money website and analytics dashboard on Base.",
  },
  "/privacy": {
    title: "Privacy Policy — Robot Money",
    description: "What data the Robot Money website collects, what it does not, and how onchain data is treated as public.",
  },
  "/visualizations": {
    title: "Robot Money Visualizations — Live Vault Data",
    description: "Robot Money's visualizations hub links to live views: the regime classifier, USDC vault allocation, and the AI Investment Swarm, updating on Base.",
  },
  "/blog": {
    title: "Robot Money Blog — Research & Vault Updates",
    description: "Research and announcements from Robot Money: market-regime signals, treasury-allocation backtests, smart-contract risk studies, and USDC vault updates on Base.",
  },
  // The research pages below carried real titles on production and were
  // inheriting the home page's here, so every one of them shared a title and a
  // description in search results and link unfurls.
  "/smart-contract-risks": {
    title: "Smart Contract Risks — How DeFi Vaults Get Exploited",
    description: "A field guide to DeFi vault exploits from 2020 to 2026: chronological case studies with the financial impact, the parties involved, and the precise technical attack vector for each.",
  },
  "/regime-detection": {
    title: "Regime Detection — Prior Art, Methods and Data Sources",
    description: "A model-agnostic survey of cross-asset regime detection: institutional prior art, quantitative methods, the indicator universe, data infrastructure, and a recommended starting architecture.",
  },
  "/regime/indicators": {
    title: "The 26 Indicators Behind the Regime Classifier",
    description: "Plain-language explanation of every indicator in the Robot Money regime composite: what each one is, how it is derived, and how to read it, with the numeric thresholds that matter.",
  },
  "/research/late-cycle-signals": {
    title: "Late-Cycle Signals — How Late in the Rally Are We?",
    description: "Four slow-moving gauges rebuilt from free data: index concentration, M&A activity, broker-dealer margin debt, and consumer sentiment, read against prior market peaks.",
  },
  "/research/channel-divergence": {
    title: "Channel Divergence — Is the Macro-to-Crypto Channel Breaking?",
    description: "Three transmission indicators that measure whether risk-on macro conditions are still reaching crypto: BTC beta to risk appetite, BTC/Nasdaq relative strength, and the stablecoin flow proxy.",
  },
  // Placeholder stubs kept alive so links out of /changelog do not 404
  // (views/{flow-field,regime_2panel,tech-proposal-march-16}.html). They are
  // already out of sitemap.xml, but that only stops us ADVERTISING them; with
  // no entry here they fell through to the shell's own metadata, so all three
  // served the home page's title, description and `index, follow` at three
  // more URLs. Three routes claiming to be the home page is the duplicate
  // content RM-41 is about, arriving from the opposite direction to the old
  // site's soft 404s. `follow` (not `nofollow`, unlike the styleguide below)
  // because each stub's only links are /changelog and /, both real indexed
  // pages whose value should carry.
  "/flow-field": {
    title: "Flow Field (in progress) — Robot Money",
    description: "Placeholder for an experimental flow-field visualization of capital movement across the Robot Money vault's strategies. Not yet released.",
    robots: "noindex, follow",
  },
  "/regime_2panel": {
    title: "Regime Classifier, 2-panel reference — Robot Money",
    description: "The original two-panel regime classifier, macro and on-chain indicators only, preserved for reference. The current three-panel composite lives at /regime.",
    robots: "noindex, follow",
  },
  "/tech-proposal-march-16": {
    title: "Technical Proposal, March 16 (archived) — Robot Money",
    description: "An archived technical proposal documenting an early Robot Money protocol design decision. Kept addressable for historical links; the text is being ported into the docs.",
    robots: "noindex, follow",
  },
  // Dev/test fixture only (issue #379's dash.css/dash-ui.js styleguide),
  // unlinked from nav and out of sitemap.xml — noindexed like every other
  // analytics-dashboard route ahead of the go-live cutover
  // (docs/bot-analytics-ui-port-plan.md §4.1), and `nofollow` since it links
  // nowhere a crawler should treat as real content.
  "/dash/_styleguide": {
    title: "Dash UI Styleguide (internal) — Robot Money",
    description: "Internal component styleguide for the analytics dashboard UI primitives. Not a public page.",
    robots: "noindex, nofollow",
  },
  // Analytics dashboard routes (issue #380, P0.3/P0.4): every one of these
  // renders the shared "coming soon" placeholder today (routes.js), so
  // `nofollow` matches the styleguide entry above — a stub page that links
  // nowhere real is not something a crawler should treat as content. ALL
  // dashboard routes stay noindexed until the go-live cutover regardless of
  // content status (docs/bot-analytics-ui-port-plan.md §4.1); a later issue
  // that ships real content for one of these should revisit its `robots`
  // value at that point, not before.
  "/list": {
    title: "Total Market — Robot Money Analytics",
    description: "Aggregate view across every tracked agent, coin, vault, and wallet in the Robot Money analytics dashboard.",
    robots: "noindex, nofollow",
  },
  "/list2": {
    title: "List v2 (WIP) — Robot Money Analytics",
    description: "Work-in-progress per-entity dashboard tables for agents, coins, vaults, and wallets.",
    robots: "noindex, nofollow",
  },
  "/list3": {
    title: "List v3 · Money Agents — Robot Money Analytics",
    description: "Money-agent index and leaderboard ranking wallet-backed agents by evidence-scored revenue signal.",
    robots: "noindex, nofollow",
  },
  "/market": {
    title: "Agent Activity Log — Robot Money Analytics",
    description: "Live feed of every tracked agent action across the Robot Money analytics network.",
    robots: "noindex, nofollow",
  },
  "/dashboard": {
    title: "Agent Activity Log — Robot Money Analytics",
    description: "Live feed of every tracked agent action across the Robot Money analytics network.",
    robots: "noindex, nofollow",
  },
  "/agents": {
    title: "OpenClaw Agents — Robot Money Analytics",
    description: "Tracked OpenClaw agents with protocol, score, x402 volume, and wallet balance.",
    robots: "noindex, nofollow",
  },
  "/lobster": {
    title: "Lobster Coins — Robot Money Analytics",
    description: "Sub-$10M market cap tokens in agentic ecosystems, tracked by the Robot Money analytics dashboard.",
    robots: "noindex, nofollow",
  },
  "/vaults": {
    title: "Agent-Managed Vaults — Robot Money Analytics",
    description: "Vaults managed by tracked agents, with TVL, APY, and rebalance history.",
    robots: "noindex, nofollow",
  },
  "/wallets": {
    title: "Tracked Wallets — Robot Money Analytics",
    description: "Wallets tracked by the Robot Money analytics dashboard, merged with agent-linked wallets.",
    robots: "noindex, nofollow",
  },
  "/methodology": {
    title: "Scoring Methodology — Robot Money Analytics",
    description: "How the Robot Money analytics dashboard computes agent productivity scores and consensus voting.",
    robots: "noindex, nofollow",
  },
  "/about": {
    title: "About — Robot Money Analytics",
    description: "What the four tracked entity types are and how discovery works in the Robot Money analytics dashboard.",
    robots: "noindex, nofollow",
  },
  "/ask-mr-roboto": {
    title: "Ask Mr. Roboto — Robot Money Analytics",
    description: "Delegate a task to a tracked agent through the Robot Money analytics dashboard's chat assistant.",
    robots: "noindex, nofollow",
  },
  "/submit": {
    title: "Submit a Community Commit — Robot Money Analytics",
    description: "Submit an agent, coin, vault, or wallet for inclusion in the Robot Money analytics dashboard.",
    robots: "noindex, nofollow",
  },
};

// Dynamic detail routes (/docs/*, /blog/*, /swarm/*, /media/*) inherit a base
// description from their section and get a title derived from the last path
// segment, so they are still unique and descriptive without hand-authoring each.
//
// `/media` earns its prefix the same way the other three did: views/media/
// ships articles.html and videos.html, and views/media.html links to both
// ("All Articles →" / "All Videos →"). With no prefix here they fell past every
// branch to NOT_FOUND_META, so two real, internally-linked pages served the
// title "Page Not Found — Robot Money" under `noindex, follow`. The entry for
// `/media` itself is in META above and is found before this table is consulted.
const SECTIONS = [
  { prefix: "/docs", suffix: "Robot Money Docs" },
  { prefix: "/blog", suffix: "Robot Money Blog" },
  { prefix: "/swarm", suffix: "Robot Money Investment Swarm" },
  { prefix: "/media", suffix: "Robot Money Media" },
];

// Legacy path aliases, mirroring the rewrites `viewFor()` performs in routes.js
// (issue #263 pass 2, the /committee -> /swarm rename). routes.js resolves an
// old path to the NEW path's fragment, so both addresses render the same page
// and both return 200 — which makes every one of them a duplicate URL unless
// something names the new address as canonical.
//
// Keeping the table here rather than importing routes.js is deliberate: this
// module is imported by the deploy-time prerenderer under Bun, where routes.js's
// browser-facing view resolution has no business running. The cost is that the
// two lists must be kept in step, which is why they are spelled the same way.
//
// Order is not significant — `/admin/committee` does not start with
// `/committee/`, so no entry can shadow another.
const LEGACY_ALIASES = [
  ["/committee", "/swarm"],
  ["/admin/committee", "/admin/swarm"],
  ["/docs/investment-committee", "/docs/investment-swarm"],
];

// The last resort in metaFor(), reached only by a path that is in no META
// entry, under no SECTIONS prefix and no dashboard prefix — which is exactly
// the set that resolves to views/not-found.html. It used to return META["/"],
// so every 404 in the site advertised the HOME PAGE's title, description and
// canonical, under the indexable default robots directive: a soft-404 that
// invites Google to index unlimited nonexistent URLs as duplicates of the home
// page. Fails closed for the same reason the dashboard stub prefixes above do.
//
// Every page in sitemap.xml is covered before this line is reached: the ones
// without their own META entry are all under /docs, /blog or /swarm, which
// SECTIONS handles. A NEW top-level page added without a META entry would land
// here and be noindexed — deliberate, and the same trade the stub-prefix checks
// already make. Add the entry with the page.
const NOT_FOUND_META = {
  title: "Page Not Found — Robot Money",
  description: "This Robot Money page does not exist. Browse the vault, regime classifier, research and investment swarm from the navigation.",
  robots: "noindex, follow",
};

// Dashboard :id/:slug routes (issue #380's 5 param regexes in routes.js —
// /agents/:id, /lobster/:id, /vaults/:id, /wallets/:id, /projects/:slug).
// None has a per-slug META entry (their profile pages don't exist yet — every
// one resolves to the shared "coming soon" placeholder), so without this
// check they would silently fall through to home's title/description AND
// home's INDEXABLE default robots directive — exactly the kind of stub-page
// leak §4.1 says must never happen. `/projects/:slug` is handled separately
// below (issue #389 shipped its real page) — it is NOT in this list.
//
// `robots: noindex, nofollow` applies to EVERY prefix below regardless of
// content status — issue #380's rule (line ~136 above) is explicit that
// shipping real content does not, by itself, flip a dashboard route
// indexable; only the P5.4 go-live cutover does. /agents/:id still resolves
// to the shared "coming soon" placeholder (AgentProfile has not shipped as
// of issue #391), so its description keeps saying so. /lobster/:id,
// /vaults/:id, /wallets/:id shipped real dossier content in issue #391 —
// "not yet available" would now be a false claim about a page that exists,
// so those three get their own accurate copy below (
// DASH_SHIPPED_DETAIL_PARAM_PREFIXES) while keeping the SAME noindex/nofollow
// directive.
const DASH_STUB_PARAM_PREFIXES = ["/agents/"];
const DASH_SHIPPED_DETAIL_PARAM_PREFIXES = ["/lobster/", "/vaults/", "/wallets/"];

// `/projects/:slug` ProjectProfile (issue #389, §5.5, P3.1). Real content now
// ships (unlike the stub prefixes above), but per §6's provenance table this
// route stays `noindex` at launch, same as `/projects` (the list) — both are
// still behind the same PROJECTS_SOURCE=live cutover (issue #346) and this
// page's Holdings/Activity sections are honestly empty until P1.6 lands.
// `follow` (not `nofollow` like the DASH_STUB entries) because this page's own
// facet-table links (→ /agents/:id etc.) are real content worth a crawler
// following once those targets exist, unlike a placeholder page linking
// nowhere. The per-slug display name isn't known synchronously here (this
// runs before the page's own data fetch), so the title is generic rather than
// fabricated from the slug.
const PROJECT_PROFILE_PREFIX = "/projects/";

/**
 * @param {string} segment
 * @returns {string}
 */
function titleize(segment) {
  return String(segment || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * @param {string} pathname
 * @returns {string}
 */
function normalize(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * The address a path should be indexed under: normalized, with any legacy
 * prefix rewritten to the name the page actually has now.
 *
 * Every other path is returned unchanged, so an unknown path still reaches
 * NOT_FOUND_META rather than being rewritten into something plausible.
 *
 * @param {string} pathname
 * @returns {string}
 */
function canonicalPath(pathname) {
  const p = normalize(pathname);
  for (const [from, to] of LEGACY_ALIASES) {
    if (p === from) return to;
    if (p.startsWith(from + "/")) return to + p.slice(from.length);
  }
  return p;
}

/**
 * The absolute URL a path should declare as its canonical.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function canonicalUrlFor(pathname) {
  const p = canonicalPath(pathname);
  return ORIGIN + (p === "/" ? "/" : p);
}

/**
 * @param {string} pathname
 * @returns {{ title: string; description: string; robots?: string }}
 */
export function metaFor(pathname) {
  // Resolved through the alias table so a legacy path describes itself as the
  // page it actually renders. Without this, /committee/members/woon fell to
  // NOT_FOUND_META ("Page Not Found", noindex) while rendering a real member.
  const p = canonicalPath(pathname);
  if (META[p]) return META[p];
  for (const { prefix, suffix } of SECTIONS) {
    if (p === prefix || p.startsWith(prefix + "/")) {
      const seg = p.split("/").filter(Boolean).pop();
      const name = titleize(seg || "");
      return {
        title: name ? `${name} — ${suffix}` : suffix,
        description: (META[prefix] || META["/"]).description,
      };
    }
  }
  for (const prefix of DASH_STUB_PARAM_PREFIXES) {
    if (p.startsWith(prefix)) {
      return {
        title: "Robot Money Analytics",
        description: "Analytics dashboard page not yet available.",
        robots: "noindex, nofollow",
      };
    }
  }
  if (p.startsWith(PROJECT_PROFILE_PREFIX)) {
    return {
      title: "Project Profile — Robot Money Analytics",
      description: "Token metrics, revenue, and treasury breakdown for a tracked agentic-economy project.",
      robots: "noindex, follow",
    };
  }
  for (const prefix of DASH_SHIPPED_DETAIL_PARAM_PREFIXES) {
    if (p.startsWith(prefix)) {
      return {
        title: "Robot Money Analytics",
        description: "Analytics dashboard detail page — gated behind the dashboard access screen.",
        robots: "noindex, nofollow",
      };
    }
  }
  return NOT_FOUND_META;
}

/**
 * @param {string} tag
 * @param {string} attr
 * @param {string} key
 * @param {string} valueAttr
 * @param {string} value
 */
function upsert(tag, attr, key, valueAttr, value) {
  let el = document.head.querySelector(`${tag}[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement(tag);
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute(valueAttr, value);
}

/**
 * @param {string} pathname
 */
export function applyRouteMeta(pathname) {
  if (typeof document === "undefined") return;
  const p = normalize(pathname);
  const m = metaFor(p);
  const url = canonicalUrlFor(p);

  document.title = m.title;
  upsert("meta", "name", "description", "content", m.description);
  upsert("link", "rel", "canonical", "href", url);
  upsert("meta", "name", "robots", "content", m.robots || DEFAULT_ROBOTS);

  upsert("meta", "property", "og:title", "content", m.title);
  upsert("meta", "property", "og:description", "content", m.description);
  upsert("meta", "property", "og:url", "content", url);
  upsert("meta", "property", "og:site_name", "content", SITE_NAME);
  upsert("meta", "property", "og:image", "content", OG_IMAGE);

  upsert("meta", "name", "twitter:title", "content", m.title);
  upsert("meta", "name", "twitter:description", "content", m.description);
  upsert("meta", "name", "twitter:image", "content", OG_IMAGE);
}

/**
 * Point this page's canonical (and og:url) at a specific absolute URL.
 *
 * `applyRouteMeta` runs on navigation, before a view has fetched anything, so
 * it can only canonicalise the URL the visitor typed. A view that later learns
 * the record's OWN address calls this to correct it — the member profile is the
 * case that matters, because a member resolves by handle AND by id
 * (migration 0030 keeps every published id resolving on purpose), so the same
 * profile is reachable at two URLs and only one of them should be indexed.
 *
 * Deliberately narrow: it writes the two URL-valued tags and nothing else, so
 * it cannot fight `applyRouteMeta` over title, description or robots.
 *
 * `forPathname` is the route the caller was serving when it started. Every
 * caller of this function is late by construction — it runs after an await —
 * and the router does not cancel a superseded view's in-flight work
 * (`destroyTree` cannot abort a pending promise). Without the guard, a member
 * fetch still running when the visitor moves on lands its correction on
 * whatever route is showing, so /faq would declare itself a duplicate of a
 * member profile. This is the same cross-route leak spa.spec.ts already pins
 * for the `robots` directive.
 *
 * @param {string} url absolute URL, normally from `canonicalUrlFor`
 * @param {string} [forPathname] skip the write if the visitor has since navigated away
 */
export function setCanonicalUrl(url, forPathname) {
  if (typeof document === "undefined" || !url) return;
  if (forPathname !== undefined && normalize(location.pathname) !== normalize(forPathname)) return;
  upsert("link", "rel", "canonical", "href", url);
  upsert("meta", "property", "og:url", "content", url);
}

/**
 * Escape a value destined for a double-quoted HTML attribute.
 *
 * `<` and `>` are escaped as well as `&` and `"`. They are not strictly
 * required inside a quoted attribute, but every value passed here reaches
 * `<head>` and one of them is derived from a request path, so the safe superset
 * costs nothing and removes a class of question.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Substitute this module's per-route metadata into a copy of the shell's HTML.
 *
 * The string half of `applyRouteMeta`, for the two callers that have no DOM:
 * the deploy-time prerenderer (`scripts/prerender.ts`) and the api process's
 * shell fallback (`backend/src/api/static.ts`). Both currently ship raw HTML
 * carrying the HOME page's title, description, canonical and og:url on every
 * route they do not have a prerendered file for, which is every dynamic route —
 * so a shared member or session link unfurls as the home page.
 *
 * `robots` is substituted here and is NOT substituted by the prerenderer today,
 * which is why every `noindex` in this file has so far been render-time only.
 *
 * A tag missing from the shell is left missing rather than injected: each
 * replace is a no-op when its pattern does not match, so an unexpected shell
 * degrades to today's behaviour instead of producing malformed head markup.
 *
 * @param {string} shellHtml the shell document
 * @param {string} pathname the route being served
 * @returns {string}
 */
export function renderMeta(shellHtml, pathname) {
  const m = metaFor(pathname);
  // Escaped like every other substituted value. It is derived from the request
  // path, which for the api process's shell fallback is arbitrary attacker-
  // controlled input: `static.ts` decodes the pathname before it gets here, so
  // an unescaped `"` would close the attribute and everything after it would
  // parse as markup in <head>.
  const url = escapeAttr(canonicalUrlFor(pathname));
  const title = escapeHtml(m.title);
  const titleAttr = escapeAttr(m.title);
  const description = escapeAttr(m.description);
  const robots = escapeAttr(m.robots || DEFAULT_ROBOTS);

  // Every substitution goes through a FUNCTION replacer. With a string
  // replacement, `$&`, `$'`, "$`" and `$n` are replacement PATTERNS, and
  // metaFor's SECTIONS branch derives its title from the raw last path segment,
  // so a `$` in the URL would be expanded rather than inserted. `$&` re-injects
  // the matched tag (including its quote, reopening the attribute) and `$'`
  // inserts the entire remainder of the document, compounding across the nine
  // replaces: a 16KB shell became 256MB for a path of six `$'`. A function's
  // return value is always used verbatim.
  const TAGS = [
    [/(<meta name="description" content=")[^"]*(")/, description],
    [/(<link rel="canonical" href=")[^"]*(")/, url],
    [/(<meta name="robots" content=")[^"]*(")/, robots],
    [/(<meta property="og:title" content=")[^"]*(")/, titleAttr],
    [/(<meta property="og:description" content=")[^"]*(")/, description],
    [/(<meta property="og:url" content=")[^"]*(")/, url],
    [/(<meta name="twitter:title" content=")[^"]*(")/, titleAttr],
    [/(<meta name="twitter:description" content=")[^"]*(")/, description],
  ];

  let html = shellHtml.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
  for (const [pattern, value] of TAGS) {
    html = html.replace(pattern, (_match, open, close) => `${open}${value}${close}`);
  }
  return html;
}
