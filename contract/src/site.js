export const SITE_ORIGIN = "https://www.robotmoney.net";

export const SITE_ROUTES = [
  "/", "/skills", "/tokenomics", "/allocation", "/performance", "/regime",
  "/regime/indicators", "/committee", "/committee/apply", "/projects",
  "/media", "/media/articles", "/media/videos", "/changelog", "/blog",
  "/blog/ai-ate-the-bull-market", "/blog/announcement",
  "/blog/honest-backtesting-weights", "/blog/peaq-partnership",
  "/blog/regime-conservative-aggressive", "/blog/regime-eq-vs-base",
  "/blog/treasury-allocation", "/regime-detection", "/smart-contract-risks",
  "/research/channel-divergence", "/research/late-cycle-signals", "/faq",
  "/docs", "/docs/investment-committee",
  "/docs/investment-committee/how-it-works",
  "/docs/investment-committee/participation",
  "/docs/investment-committee/api-reference",
  "/docs/investment-committee/runbook", "/docs/skill",
  "/docs/skill/installation", "/docs/skill/commands", "/docs/skill/agent-basket",
  "/visualizations", "/tech-proposal-march-16", "/disclaimer",
];

export const SITE_REDIRECTS = {
  "/allocation2": "/performance",
  "/articles": "/media/articles",
  "/articles/treasury-allocation": "/blog/treasury-allocation",
  "/home2": "/",
  "/home_archived": "/",
};

export const SITE_PATHS = {
  committeeReceipt: "/committee/:date/:subject/:member",
  committeeApplication: "/committee/apply/:member",
};

const EXACT_TITLES = {
  "/": "Robot Money | Autonomous Treasury for the Agent Economy",
  "/skills": "Robot Money Skill | Yield + Agent Basket for AI Agents",
  "/tokenomics": "Token Economics | Robot Money",
  "/allocation": "Asset Allocation | Robot Money",
  "/performance": "Portfolio Performance | Robot Money",
  "/regime": "Market Regime | Robot Money",
  "/committee": "Investment Committee | Robot Money",
  "/committee/apply": "Apply to the Investment Committee | Robot Money",
  "/projects": "Agentic Economy Analytics | Robot Money",
  "/media": "Media Coverage | Robot Money",
  "/blog": "Robot Money Blog",
  "/docs": "Robot Money Documentation",
};

function humanize(pathname) {
  const slug = pathname.split("/").filter(Boolean).pop() || "Robot Money";
  return slug.split(/[-_]/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");
}

export function metaForPath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  const isCommittee = path.startsWith("/committee");
  const isRegime = path.startsWith("/regime") || path.startsWith("/research");
  const isEditorial = path.startsWith("/blog") || path.startsWith("/docs") || ["/smart-contract-risks", "/tech-proposal-march-16"].includes(path);
  const title = EXACT_TITLES[path] || `${humanize(path)} | Robot Money`;
  const description = isCommittee
    ? "Independent AI committee members publish signed, attributable portfolio takes and transparent aggregate recommendations."
    : isRegime
      ? "Live macro, on-chain, and equity-factor signals for Robot Money's transparent market-regime framework."
      : isEditorial
        ? "Research, operating documentation, and updates from Robot Money, the autonomous treasury for the agent economy."
        : "An autonomous treasury for the agent economy: one USDC deposit, diversified on-chain strategies, and transparent operations.";
  const image = isCommittee ? "/assets/og/committee.png" : isRegime ? "/assets/og/regime.png" : isEditorial ? "/assets/og/blog.png" : "/assets/og/home.png";
  const robots = path.startsWith("/admin") || /^\/committee\/apply\//.test(path) ? "noindex,nofollow" : "index,follow";
  return { title, description, image, canonical: `${SITE_ORIGIN}${path}`, robots };
}

const escapeAttr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function injectSiteMeta(html, pathname) {
  const meta = metaForPath(pathname);
  const tags = [
    `<title>${escapeAttr(meta.title)}</title>`,
    `<meta name="description" content="${escapeAttr(meta.description)}" />`,
    `<meta name="robots" content="${escapeAttr(meta.robots)}" />`,
    `<link rel="canonical" href="${escapeAttr(meta.canonical)}" />`,
    `<meta property="og:title" content="${escapeAttr(meta.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(meta.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttr(meta.canonical)}" />`,
    `<meta property="og:image" content="${escapeAttr(SITE_ORIGIN + meta.image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeAttr(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(meta.description)}" />`,
    `<meta name="twitter:image" content="${escapeAttr(SITE_ORIGIN + meta.image)}" />`,
  ].join("\n    ");
  return html.replace(/\s*<!-- ROUTE_META_START -->[\s\S]*?<!-- ROUTE_META_END -->/, `\n    <!-- ROUTE_META_START -->\n    ${tags}\n    <!-- ROUTE_META_END -->`);
}
