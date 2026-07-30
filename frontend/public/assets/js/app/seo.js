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
    description: "Robot Money's AI Investment Committee analyzes agent portfolios daily on Base — multiple lenses, one subject per session, one signed take per member.",
  },
  "/projects": {
    title: "Agentic Economy Ecosystem — Robot Money",
    description: "Track market cap, FDV, revenue, and wallet balances across onchain AI agent projects and Zero Human Companies in the agent economy on Base.",
    // Kept out of the index while the table is backed by the development seed
    // (issue #346). ANALYTICS in the nav points at analytics.robotmoney.net, and
    // /projects is out of sitemap.xml, so this is the third of the three places
    // that would otherwise still advertise it. `follow` so the page's own
    // outbound links keep their value.
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
  "/smart-contract-risks": {
    title: "Smart Contract Risks — Robot Money",
    description: "Review the smart contract risks for the Robot Money USDC vault on Base: audit status, upgrade authority, and the non-custodial caveats you assume onchain.",
  },
  "/visualizations": {
    title: "Robot Money Visualizations — Live Vault Data",
    description: "Robot Money's visualizations hub links to live views: the regime classifier, USDC vault allocation, and the AI Investment Committee, updating on Base.",
  },
  "/blog": {
    title: "Robot Money Blog — Research & Vault Updates",
    description: "Research and announcements from Robot Money: market-regime signals, treasury-allocation backtests, smart-contract risk studies, and USDC vault updates on Base.",
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

function titleize(segment) {
  return String(segment || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function normalize(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

export function metaFor(pathname) {
  const p = normalize(pathname);
  if (META[p]) return META[p];
  for (const { prefix, suffix } of SECTIONS) {
    if (p === prefix || p.startsWith(prefix + "/")) {
      const seg = p.split("/").filter(Boolean).pop();
      const name = titleize(seg);
      return {
        title: name ? `${name} — ${suffix}` : suffix,
        description: (META[prefix] || META["/"]).description,
      };
    }
  }
  return META["/"];
}

// Create-or-update a <meta>/<link> tag identified by (attr=key). Reuses the
// static tag the shell already shipped when present, so we never duplicate.
function upsert(tag, attr, key, valueAttr, value) {
  let el = document.head.querySelector(`${tag}[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement(tag);
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute(valueAttr, value);
}

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
