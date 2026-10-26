// Alpine factory for the /projects directory (RM-186). Two lists over
// GET /api/projects: the projects with a token, as a table sorted by market
// cap, then every other project by name. Each row links to the project's page.
//
// Every field the roster has is shown. One the data cannot back yet (a
// wallet balance that counts ETH only, a trend with under two readings)
// reads "Missing" with the reason on hover, so the gaps stay in view until
// frontend issues 1359 to 1365 fill them (lib/project-format.js MISSING_WHY).
import { api, ROUTES } from "../../lib/api.js";
import { agentKind, projectCopy } from "../../lib/project-copy.js";
import { initials, missing, num, pctClass, pctText, primaryCoin, shown, tokenPrice, trendSvg } from "../../lib/project-format.js";
import { fmtUsdCompact } from "../lib/dash-format.js";

const OTHERS_PAGE = 50;

// What a project covers, in the order the old directory's pills ran.
const FACETS = [
  { key: "agent", label: "Agent" },
  { key: "x402", label: "x402" },
  { key: "coin", label: "Token" },
  { key: "wallet", label: "Wallet" },
  { key: "vault", label: "Vault" },
];

export function registerProjectsView(Alpine) {
  Alpine.data("projectsView", () => ({
    loading: true,
    error: null,
    /** @type {any[]} */
    projects: [],
    sortKey: "mcap",
    sortDir: "desc",
    // The projects with no token run to hundreds: a page at a time, and a
    // search over their names and what they are.
    othersQuery: "",
    othersPage: 0,

    async load() {
      try {
        const data = await api.get(ROUTES.projects.list);
        this.projects = Array.isArray(data?.projects) ? data.projects : [];
      } catch {
        this.error = "The directory could not be read. Try again in a minute.";
      } finally {
        this.loading = false;
      }
    },

    /** @param {any} p */
    row(p) {
      const copy = projectCopy(p.slug);
      const coin = primaryCoin(p);
      return {
        p,
        name: copy?.name ?? p.displayName,
        short: copy?.short ?? "",
        href: `/projects/${encodeURIComponent(p.slug)}`,
        tickers: (p.coins || []).map((c) => c.ticker).filter(Boolean).join(", "),
        mcap: num(coin?.marketCap),
        fdv: num(coin?.fdv),
        price: num(coin?.priceUsd),
        pct: num(coin?.percentChange24h),
        mcfdv: num(coin?.marketCap) && num(coin?.fdv) ? `${((coin.marketCap / coin.fdv) * 100).toFixed(1)}%` : "—",
        // The 30-day line: the main token's price, or an x402 service's
        // activity when it has no token.
        trend: trendSvg(p.sparkline),
        trendCell: trendSvg(p.sparkline) ? null : missing("trend"),
        wallet: (p.wallets || []).length ? missing("balance") : shown("—"),
        walletCount: (p.wallets || []).length,
        coverage: num(p.dataCoverageScore) === null ? "—" : String(Math.round(p.dataCoverageScore)),
        facets: FACETS.filter((f) => p.facets?.[f.key]).map((f) => f.label).join(" · "),
      };
    },

    tokenRows() {
      const rows = this.projects.filter((p) => (p.coins || []).length).map((p) => this.row(p));
      const dir = this.sortDir === "asc" ? 1 : -1;
      const key = this.sortKey;
      return rows.sort((a, b) => {
        if (key === "name") return a.name.localeCompare(b.name) * dir;
        if (key === "coverage") return ((Number(a.coverage) || 0) - (Number(b.coverage) || 0)) * dir;
        const av = /** @type {any} */ (a)[key];
        const bv = /** @type {any} */ (b)[key];
        if (av === bv) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av - bv) * dir;
      });
    },

    // Projects with no token: those we have written up first, then by name,
    // narrowed by the search.
    otherRows() {
      const q = this.othersQuery.trim().toLowerCase();
      return this.projects
        .filter((p) => !(p.coins || []).length)
        .map((p) => ({ ...this.row(p), kind: p.facets?.x402 ? agentKind("x402") : "" }))
        .filter((r) => !q || `${r.name} ${r.short} ${r.kind} ${r.p.slug}`.toLowerCase().includes(q))
        .sort((a, b) => Number(!!b.short) - Number(!!a.short) || a.name.localeCompare(b.name));
    },
    otherPageRows() { return this.otherRows().slice(this.othersPage * OTHERS_PAGE, (this.othersPage + 1) * OTHERS_PAGE); },
    othersPaged() { return this.otherRows().length > OTHERS_PAGE; },
    othersMore() { return (this.othersPage + 1) * OTHERS_PAGE < this.otherRows().length; },
    othersRange() {
      const n = this.otherRows().length;
      const from = this.othersPage * OTHERS_PAGE + 1;
      return `${from} to ${Math.min(n, from + OTHERS_PAGE - 1)} of ${n}`;
    },
    /** @param {string} q */
    searchOthers(q) { this.othersQuery = q; this.othersPage = 0; },

    /** @param {string} key */
    sortBy(key) {
      if (this.sortKey === key) this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      else {
        this.sortKey = key;
        this.sortDir = key === "name" ? "asc" : "desc";
      }
    },
    /** @param {string} key */
    ariaSort(key) {
      return this.sortKey === key ? (this.sortDir === "asc" ? "ascending" : "descending") : null;
    },

    facts() {
      const withToken = this.projects.filter((p) => (p.coins || []).length).length;
      const x402 = this.projects.filter((p) => p.facets?.x402).length;
      const stamps = this.projects.flatMap((p) => (p.coins || []).map((c) => Date.parse(c.refreshedAt ?? ""))).filter(Number.isFinite);
      const asOf = stamps.length
        ? new Date(Math.max(...stamps)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }) + " UTC"
        : "—";
      return [
        { k: "Projects", v: this.loading ? "—" : String(this.projects.length) },
        { k: "With a token", v: this.loading ? "—" : String(withToken) },
        { k: "x402 services", v: this.loading ? "—" : String(x402) },
        { k: "Prices as of", v: asOf },
      ];
    },

    /** @param {number | null} n */
    usdCompact(n) { return fmtUsdCompact(n, { baseDecimals: 0 }); },
    tokenPrice,
    pctText,
    pctClass,
    initials,
  }));
}
