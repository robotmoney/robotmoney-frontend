// Alpine factory for /list2 — "List v2 (WIP)" (issue #387,
// docs/bot-analytics-ui-port-plan.md §5.2, P2.6): one single-entity table per
// tab (Agents/Coins/Vaults/Wallets), each with its own per-facet columns over
// GET /api/dashboards/list2. Renders inside views/dash/_layout.html's
// [data-outlet] — the ancestor shell already carries the `.a3` scope class
// (issue #379), so this fragment's root does NOT repeat it.
//
// Sparkline rendering is a page-local hand-rolled SVG helper, matching the
// existing precedent in alpine/views/projects.js's sparkSvg() and the /list
// view (issue #384) — the shared alpine/lib/sparkline.js (P0.5, issue #381)
// has not landed yet; this view should switch to that import once it does.
import { api, ROUTES } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";

const TABS = [
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "coins", label: "Coins", icon: "coins" },
  { id: "vaults", label: "Vaults", icon: "vault" },
  { id: "wallets", label: "Wallets", icon: "wallet" },
];

// Default sort per tab (§5.2's table).
const DEFAULT_SORT = {
  agents: { key: "earned30d", dir: "desc" },
  coins: { key: "marketCapUsd", dir: "desc" },
  vaults: { key: "tvlUsd", dir: "desc" },
  wallets: { key: "balanceUsd", dir: "desc" },
};

export function registerList2View(Alpine) {
  Alpine.data("list2View", () => ({
    loading: true,
    error: null,
    data: { agents: [], coins: [], vaults: [], wallets: [] },
    tab: "agents",
    sortKey: DEFAULT_SORT.agents.key,
    sortDir: DEFAULT_SORT.agents.dir,

    async init() {
      await this.load();
    },
    async load() {
      this.loading = true;
      this.error = null;
      try {
        this.data = await api.get(ROUTES.dashboards.list2);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    tabs: TABS,
    selectTab(id) {
      this.tab = id;
      this.sortKey = DEFAULT_SORT[id].key;
      this.sortDir = DEFAULT_SORT[id].dir;
    },
    isTab(id) {
      return this.tab === id;
    },
    tabCount(id) {
      return (this.data[id] || []).length;
    },

    get activeRows() {
      return this.data[this.tab] || [];
    },
    get sortedRows() {
      const rows = [...this.activeRows];
      const dir = this.sortDir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const av = a[this.sortKey];
        const bv = b[this.sortKey];
        const an = av == null;
        const bn = bv == null;
        if (an && bn) return 0;
        if (an) return 1; // nulls sort last regardless of direction
        if (bn) return -1;
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
      return rows;
    },
    sortBy(key) {
      if (key === this.sortKey) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortKey = key;
        this.sortDir = "desc";
      }
    },
    isSort(key) {
      return this.sortKey === key;
    },
    sortIcon(key) {
      if (this.sortKey !== key) return "↕";
      return this.sortDir === "asc" ? "▲" : "▼";
    },

    // ── formatting (fmtUsd shared via alpine/lib/dash-format.js, issue #449) ─
    fmtUsd(n) {
      return fmtUsdCompact(n);
    },
    fmtInt(n) {
      return n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString();
    },
    fmtApy(n) {
      return n == null || !isFinite(n) ? "—" : (n * 100).toFixed(2) + "%";
    },
    fmtPct(v) {
      if (v == null || !isFinite(v)) return "—";
      return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
    },
    pctColor(v) {
      if (v == null) return "hsl(var(--muted-foreground))";
      return v > 0 ? "hsl(var(--success))" : v < 0 ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))";
    },
    fmtRel(iso) {
      if (!iso) return "—";
      const ms = Date.now() - new Date(iso).getTime();
      if (!isFinite(ms) || ms < 0) return "—";
      const min = Math.floor(ms / 60_000);
      if (min < 1) return "just now";
      if (min < 60) return min + "m ago";
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + "h ago";
      const day = Math.floor(hr / 24);
      if (day < 30) return day + "d ago";
      return Math.floor(day / 30) + "mo ago";
    },
    shortAddr(addr) {
      if (!addr) return "—";
      return addr.length <= 10 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    },
    explorerUrl(chain, address) {
      if (!address) return null;
      const map = {
        ethereum: "https://etherscan.io/address/",
        base: "https://basescan.org/address/",
        arbitrum: "https://arbiscan.io/address/",
        polygon: "https://polygonscan.com/address/",
      };
      const base = map[(chain || "").toLowerCase()] || "https://basescan.org/address/";
      return base + address;
    },

    // Hand-rolled sparkline SVG (§4.3 RowSparkline geometry) — same shape as
    // the /list view's sparkSvg (issue #384): "—" under 4 finite points.
    sparkSvg(values) {
      const vals = (values || []).filter((v) => typeof v === "number" && isFinite(v));
      if (vals.length < 4) return '<span class="a3-spark-empty">—</span>';
      const W = 80, H = 22, pad = 2, n = vals.length;
      const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
      const xAt = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
      const yAt = (v) => pad + (1 - (v - min) / span) * (H - 2 * pad);
      const first = vals[0], last = vals[n - 1];
      const pctMove = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
      const color = pctMove > 0.5 ? "hsl(var(--success))" : pctMove < -0.5 ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))";
      const pts = vals.map((v, i) => xAt(i).toFixed(1) + "," + yAt(v).toFixed(1)).join(" ");
      const areaPts = `${xAt(0).toFixed(1)},${H - pad} ${pts} ${xAt(n - 1).toFixed(1)},${H - pad}`;
      return (
        `<svg class="a3-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">` +
        `<polyline points="${areaPts}" fill="${color}" fill-opacity="0.12" stroke="none"/>` +
        `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>` +
        `</svg>`
      );
    },
  }));
}
