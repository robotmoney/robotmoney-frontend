// Alpine factory for a project's page, /projects/:slug (RM-186), over
// GET /api/projects/:slug. A research record, as a swarm member's page is:
// the breadcrumb, the project, a row of facts, what it is, its figures, its
// tokens and their history, then its agents, wallets, vaults, activity and
// how complete its record is.
//
// Every field the API returns is shown. One the data cannot back yet reads
// "Missing" with the reason on hover (lib/project-format.js MISSING_WHY),
// never a wrong number or a zero that means "unknown" (RM-180's audit of
// 15 Oct 2026):
// • a wallet's balance counts native ETH only, so the ETH is shown as what it
//   is and the total balance is Missing;
// • a wallet's "last transaction" is the time it was last read, so Missing;
// • revenue, and everything computed from it, reads 0 where it was never
//   read, so a zero is Missing; x402 figures and agent productivity the same;
// • a token's other chains and its liquidity are not on record, so Missing.
// Each fills in as frontend issues 1359 to 1365 land.
import { api, path, ROUTES } from "../../lib/api.js";
import { agentKind, listingText, projectCopy } from "../../lib/project-copy.js";
import {
  initials, missing, num, pctClass, pctText, primaryCoin, readOrMissing, shown, tokenPrice, trendSvg, usdCompact,
} from "../../lib/project-format.js";
import { fmtDate, fmtUsd } from "../../lib/vault-data.js";
import { tvlChart } from "../tvl-chart.js";

const EXPLORERS = /** @type {Record<string, string>} */ ({
  base: "https://basescan.org/address/",
});

// The history the API keeps a day at a time. A series is drawn when it has two
// readings; revenue and productivity count only readings above zero, since a
// zero there is "not read". The treasury adds wallet balances, which count
// ETH only, so it stays Missing whatever it holds.
const SERIES = [
  { key: "marketCapUsd", label: "Market cap", fmt: "usd" },
  { key: "tokenPriceUsd", label: "Price", fmt: "price" },
  { key: "dailyRevenueUsd", label: "Daily revenue", fmt: "usd", zeroIsMissing: true, why: "revenue" },
  { key: "treasuryUsd", label: "Treasury", fmt: "usd", always: "treasury" },
  { key: "avgProductivity", label: "Agent productivity", fmt: "num", zeroIsMissing: true, why: "productivity" },
];

// What a project covers, as the old directory's pills named them.
const FACETS = [
  { key: "agent", label: "Agent" },
  { key: "x402", label: "x402" },
  { key: "coin", label: "Token" },
  { key: "wallet", label: "Wallet" },
  { key: "vault", label: "Vault" },
];

const SCORES = [
  { key: "breadthScore", label: "Breadth" },
  { key: "identityScore", label: "Identity" },
  { key: "onchainScore", label: "Onchain" },
  { key: "activityScore", label: "Activity" },
];

/** @param {unknown} v */
const ratio = (v) => {
  const n = num(v);
  if (n === null) return null;
  // A small ratio keeps two significant figures: 0.00092×, not 0.00×.
  return `${Math.abs(n) >= 0.1 ? n.toFixed(2) : Number(n.toPrecision(2)).toString()}×`;
};

export function registerProjectView(Alpine) {
  Alpine.data("projectView", () => ({
    ...tvlChart(),
    loading: true,
    error: null,
    notFound: false,
    /** @type {any} */
    project: null,
    series: "marketCapUsd",
    seriesList: SERIES,
    scores: SCORES,

    async init() {
      const slug = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
      try {
        const res = await api.get(path(ROUTES.projects.detail, { slug }));
        this.project = res?.project ?? null;
        if (!this.project) this.notFound = true;
        else if (!projectCopy(this.project.slug)) document.title = `${this.name()} | Agent Projects | Robot Money`;
      } catch (e) {
        if (/** @type {any} */ (e)?.status === 404) this.notFound = true;
        else this.error = "This project could not be loaded. Try again in a moment.";
      } finally {
        this.loading = false;
      }
    },

    copy() { return this.project ? projectCopy(this.project.slug) : null; },
    name() { return this.copy()?.name ?? this.project?.displayName ?? ""; },
    // What it is, in a line under the name: ours, else the project's own short line.
    short() { return this.copy()?.short ?? ""; },
    // The paragraph under About: ours, else the project's listing, quoted.
    about() { return this.copy()?.long ?? ""; },
    listing() {
      if (this.copy()) return "";
      const p = this.project;
      return listingText(p?.overviewLong) || listingText(p?.overviewShort);
    },
    initials() { return initials(this.name()); },
    // The project's links: ours where the roster's point at the wrong place.
    websiteUrl() { return this.copy()?.website ?? this.project?.websiteUrl ?? ""; },
    handle() { return String(this.copy()?.x ?? this.project?.twitterHandle ?? "").replace(/^@/, ""); },
    twitterUrl() { return this.handle() ? `https://x.com/${encodeURIComponent(this.handle())}` : ""; },
    twitterLabel() { return "@" + this.handle(); },
    // The agents' kinds, once each, under the name: "Virtuals agent".
    kinds() { return [...new Set((this.project?.agents || []).map((a) => agentKind(a.protocolStandard)))].join(", "); },
    facets() { return FACETS.map((f) => ({ ...f, on: !!this.project?.facets?.[f.key] })); },

    coins() { return this.project?.coins || []; },
    coin() { return primaryCoin(this.project); },
    facts() {
      const c = this.coin();
      const chain = this.project?.primaryChain ? [{ k: "Chain", v: this.chainName(this.project.primaryChain) }] : [];
      if (!c) {
        return [
          { k: "Agents", v: String((this.project?.agents || []).length) },
          { k: "Wallets", v: String((this.project?.wallets || []).length) },
          ...chain,
        ];
      }
      return [
        { k: `${c.ticker || c.name} price`, v: tokenPrice(c.priceUsd) },
        { k: "24h", v: pctText(c.percentChange24h), cls: pctClass(c.percentChange24h) },
        { k: "Market cap", v: usdCompact(c.marketCap) },
        { k: "FDV", v: usdCompact(c.fdv) },
        { k: "Volume 24h", v: usdCompact(c.volume24h) },
        ...chain,
      ];
    },
    asOf() {
      const c = this.coin();
      return c?.refreshedAt ? fmtDate(c.refreshedAt) : "";
    },

    // The money and the ratios, label and figure, with what is not read yet
    // in place as Missing.
    figures() {
      const k = this.project?.kpis || {};
      const r = this.project?.ratios || {};
      const hasVault = (this.project?.vaults || []).length > 0;
      const hasWallet = (this.project?.wallets || []).length > 0;
      const none = shown("—");
      return [
        { k: "Revenue, 30 days", c: readOrMissing(k.revenue30dUsd, usdCompact, "revenue") },
        { k: "Price to sales, annualized", c: ratio(k.psRatioAnnualized) ? shown(ratio(k.psRatioAnnualized)) : missing("needsRevenue") },
        { k: "Revenue growth, 15 days", c: num(r.revenueGrowthPct) === null ? missing("needsRevenue") : shown(pctText(r.revenueGrowthPct)) },
        { k: "Capital efficiency", c: ratio(r.capitalEfficiency) ? shown(ratio(r.capitalEfficiency)) : missing("needsRevenue") },
        { k: "Wallet balance", c: hasWallet ? missing("balance") : none },
        { k: "Vault TVL", c: hasVault ? shown(usdCompact(k.vaultTvlUsd)) : none },
        { k: "Vault yield, weighted", c: !hasVault ? none : num(k.vaultWeightedApy) ? shown(`${k.vaultWeightedApy.toFixed(2)}%`) : missing("apy") },
        { k: "x402 volume", c: readOrMissing(k.x402VolumeUsd, usdCompact, "x402") },
        { k: "x402 transactions", c: readOrMissing(k.x402TxnCount, (n) => Math.round(n).toLocaleString("en-US"), "x402") },
        { k: "FDV to market cap", c: ratio(r.fdvToMarketCap) ? shown(ratio(r.fdvToMarketCap)) : none },
        { k: "TVL to market cap", c: hasVault && ratio(r.tvlToMarketCap) ? shown(ratio(r.tvlToMarketCap)) : none },
      ];
    },

    // ── History: one chart, a chip per series. tvl-chart.js draws the area;
    // a series without two readings shows the empty chart, Missing when the
    // gap is the data's and not the calendar's.
    seriesDef() { return SERIES.find((s) => s.key === this.series) ?? SERIES[0]; },
    /** @param {string} key */
    seriesPoints(key) {
      const def = SERIES.find((s) => s.key === key);
      return (this.project?.history || [])
        .filter((h) => num(h[key]) !== null && !(def?.zeroIsMissing && !h[key]))
        .map((h) => ({ t: `${h.date}T00:00:00Z`, tvlUsd: h[key] }));
    },
    // Why the selected series is not drawn, or "" when it is.
    seriesGap() {
      const def = this.seriesDef();
      if (def.always) return { title: "Missing", why: missing(def.always).why };
      const n = this.seriesPoints(def.key).length;
      if (n >= 2) return null;
      if (def.why) return { title: "Missing", why: missing(def.why).why };
      return { title: n === 1 ? "Not enough data yet" : "No data yet", why: n === 1 ? "One reading so far" : "" };
    },
    tvlPoints() { return this.seriesGap() ? [] : this.seriesPoints(this.series); },
    tvlAsOf() { return null; },
    tvlColor() { return "var(--color-green)"; },
    tvlName() {
      const def = this.seriesDef();
      return def.key === "marketCapUsd" || def.key === "tokenPriceUsd" ? `${this.coin()?.ticker || this.name()} ${def.label.toLowerCase()}` : def.label;
    },
    tvlMark() { return ""; },
    /** @param {number} v */
    seriesFmt(v) {
      const f = this.seriesDef().fmt;
      return f === "price" ? tokenPrice(v) : f === "num" ? v.toFixed(1) : usdCompact(v);
    },
    tvlYTicks() {
      const m = this.tvl();
      if (m.max === null || m.min === null) return [];
      const lo = Math.min(0, m.min);
      const hi = /** @type {number} */ (m.max);
      return [1, 0.5, 0].map((f) => ({ key: f, top: (1 - f) * 100, label: this.seriesFmt(lo + (hi - lo) * f) }));
    },
    tvlLabel() {
      const pts = this.tvl().points;
      if (!pts.length) return "";
      return `${this.tvlName()}, ${fmtDate(pts[0].t)} to ${fmtDate(pts[pts.length - 1].t)}: ${this.seriesFmt(pts[0].value)} to ${this.seriesFmt(pts[pts.length - 1].value)}. Use the arrow keys to step through the readings.`;
    },
    tvlPoint(i) {
      const pts = this.tvl().points;
      if (i == null || !pts[i]) return null;
      const p = pts[i];
      return { left: p.x * 100, top: (1 - p.y) * 100, date: fmtDate(p.t), value: this.seriesFmt(p.value) };
    },
    /** @param {string} key */
    pickSeries(key) { this.series = key; this.tvlAt = null; },

    // ── Tokens
    /** @param {any} c */
    coinTrend(c) { return trendSvg(c.sparkline90d); },
    trendMissing: missing("trend"),
    liquidityMissing: missing("liquidity"),
    chainsMissing: missing("chains"),

    // ── Agents. x402 figures apply to x402 services only; another kind of
    // agent shows "—" there, not Missing.
    agents() { return this.project?.agents || []; },
    agentKind,
    /** @param {any} a */
    agentCells(a) {
      const x402 = a.protocolStandard === "x402";
      const none = shown("—");
      return {
        score: !x402 ? none : readOrMissing(a.x402Score, (n) => n.toFixed(1), "x402"),
        txns: !x402 ? none : readOrMissing(a.x402TxnCount, (n) => Math.round(n).toLocaleString("en-US"), "x402"),
        revenue: readOrMissing(a.revenue30dUsd, usdCompact, "revenue"),
        productivity: num(a.productivityScore) ? shown(a.productivityScore.toFixed(1)) : missing("productivity"),
      };
    },

    // ── Wallets
    wallets() { return this.project?.wallets || []; },
    balanceMissing: missing("balance"),
    lastTxMissing: missing("lastTx"),

    // ── Vaults
    vaults() { return this.project?.vaults || []; },
    /** @param {any} v */
    vaultApy(v) { return num(v.yieldApy) ? shown(`${v.yieldApy.toFixed(2)}%`) : missing("apy"); },
    /** @param {string | null} s */
    strategyName(s) { return s === "erc4626" ? "ERC-4626" : s === "lp" ? "Liquidity pool" : s || "—"; },

    // ── Activity
    activity() { return this.project?.activity || []; },
    activityMissing: missing("activity"),

    // ── Coverage
    /** @param {unknown} v */
    score(v) { return num(v) === null ? "—" : String(Math.round(/** @type {number} */ (v))); },
    /** @param {unknown} v */
    scoreWidth(v) { return `${Math.max(0, Math.min(100, num(v) ?? 0))}%`; },
    coverageAsOf() { return this.project?.coverageCalculatedAt ? fmtDate(this.project.coverageCalculatedAt) : ""; },

    /** @param {string | null} chain @param {string | null} addr */
    explorerHref(chain, addr) {
      const base = EXPLORERS[String(chain ?? "").toLowerCase()];
      return base && addr ? base + addr : "";
    },
    /** @param {string | null} addr */
    shortAddr(addr) {
      if (!addr) return "—";
      return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    },
    /** @param {string | null} chain */
    chainName(chain) {
      const c = String(chain ?? "").toLowerCase();
      if (!c) return "—";
      // peaq writes its name in lower case.
      return c === "peaq" ? "peaq" : c.charAt(0).toUpperCase() + c.slice(1);
    },
    // A wallet's ETH in dollars. Under a dollar shows as "<$1"; none read, "—".
    /** @param {unknown} v */
    ethUsd(v) {
      const n = num(v);
      if (n === null) return "—";
      if (n > 0 && n < 1) return "<$1";
      return fmtUsd(n);
    },

    usdCompact,
    tokenPrice,
    pctText,
    pctClass,
  }));
}
