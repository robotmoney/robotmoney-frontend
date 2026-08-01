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

const ORIGIN = "https://robotmoney.net";
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
  "/committee": {
    title: "AI Investment Committee — Robot Money",
    // The trailing caveat is production's and is not decoration: this string is
    // the committee's search-results surface, where a reader meets stances and
    // "recommendation" with none of the page's own disclaimer around them.
    description: "Robot Money's AI Investment Committee analyzes agent portfolios daily on Base — multiple lenses, one subject per session, one signed take per member. Auto-generated content, not financial advice.",
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
    description: "See what Robot Money has shipped and what's next: a public build log and phased roadmap covering the USDC vault on Base, AI Committee, and regime work.",
  },
  "/docs": {
    title: "Robot Money Docs — Vault, Committee & Agent Skill",
    description: "Explore Robot Money's developer docs: the ERC-4626 USDC vault on Base, the daily AI Investment Committee, and the robotmoney-cli skill for AI agents.",
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
    description: "Robot Money's visualizations hub links to live views: the regime classifier, USDC vault allocation, and the AI Investment Committee, updating on Base.",
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

// Dynamic detail routes (/docs/*, /blog/*, /committee/*) inherit a base
// description from their section and get a title derived from the last path
// segment, so they are still unique and descriptive without hand-authoring each.
const SECTIONS = [
  { prefix: "/docs", suffix: "Robot Money Docs" },
  { prefix: "/blog", suffix: "Robot Money Blog" },
  { prefix: "/committee", suffix: "Robot Money Investment Committee" },
];

// Dashboard :id/:slug routes (issue #380's 5 param regexes in routes.js —
// /agents/:id, /lobster/:id, /vaults/:id, /wallets/:id, /projects/:slug).
// None has a per-slug META entry (their profile pages don't exist yet — every
// one resolves to the shared "coming soon" placeholder), so without this
// check they would silently fall through to home's title/description AND
// home's INDEXABLE default robots directive — exactly the kind of stub-page
// leak §4.1 says must never happen. `/projects/:slug` is included even
// though its eventual page (§5.5) is public, because right now it renders
// the same placeholder as every other stub — noindex until real content
// ships, same rule as the static dashboard entries above.
const DASH_STUB_PARAM_PREFIXES = ["/agents/", "/lobster/", "/vaults/", "/wallets/", "/projects/"];

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
 * @param {string} pathname
 * @returns {{ title: string; description: string; robots?: string }}
 */
export function metaFor(pathname) {
  const p = normalize(pathname);
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
  return META["/"];
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
  const url = ORIGIN + (p === "/" ? "/" : p);

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
