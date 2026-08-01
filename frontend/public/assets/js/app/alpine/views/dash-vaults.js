// Alpine factory for the /vaults "Agent-Managed Vaults" directory (issue
// #386, docs/bot-analytics-ui-port-plan.md §5.11, P2.4). Fetches the
// read-only GET /api/dashboards/vaults feed (already sorted tvl-desc server-side)
// and handles interactive sorting/formatting + the three summary cards.
import { api, ROUTES } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";

export function registerDashVaultsView(Alpine) {
  Alpine.data("dashVaults", () => ({
    loading: true,
    error: null,
    rows: [],
    sortKey: "tvlUsd",
    sortDir: "desc",

    async init() {
      try {
        const data = await api.get(ROUTES.dashboards.vaults);
        this.rows = data.vaults || [];
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    get sortedRows() {
      const arr = [...this.rows];
      const dir = this.sortDir === "asc" ? 1 : -1;
      arr.sort((a, b) => {
        let av, bv;
        switch (this.sortKey) {
          case "name":         av = a.name.toLowerCase();               bv = b.name.toLowerCase(); break;
          case "strategyType": av = (a.strategyType || "").toLowerCase(); bv = (b.strategyType || "").toLowerCase(); break;
          case "yieldApy":     av = a.yieldApy ?? -Infinity;            bv = b.yieldApy ?? -Infinity; break;
          case "chain":        av = (a.chain || "").toLowerCase();      bv = (b.chain || "").toLowerCase(); break;
          case "tvlUsd":
          default:             av = a.tvlUsd ?? -Infinity;              bv = b.tvlUsd ?? -Infinity; break;
        }
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
      return arr;
    },

    sortBy(key) {
      if (key === this.sortKey) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortKey = key;
        this.sortDir = key === "name" || key === "strategyType" || key === "chain" ? "asc" : "desc";
      }
    },
    isSort(key) { return this.sortKey === key; },
    sortIcon(key) { return this.isSort(key) ? (this.sortDir === "asc" ? "▲" : "▼") : "↕"; },

    // ── summary cards ─────────────────────────────────────────────────
    get totalTvl() {
      return this.rows.reduce((s, v) => s + (v.tvlUsd || 0), 0);
    },
    get avgApy() {
      const withApy = this.rows.filter((v) => v.yieldApy != null);
      if (!withApy.length) return null;
      return withApy.reduce((s, v) => s + v.yieldApy, 0) / withApy.length;
    },
    get activeVaultCount() {
      return this.rows.length;
    },

    // ── formatting ──────────────────────────────────────────────────────
    // issue #449: was `n >= 1e9` (raw signed value) instead of `Math.abs(n)`,
    // so negative TVL in the B/M/K range fell through to the plain branch
    // and rendered unscaled (e.g. "$-500" for -$500M). Shared helper fixes
    // the sign handling; baseDecimals:0 preserves this view's existing
    // (already-correct) sub-$1K precision.
    fmtUsd(n) {
      return fmtUsdCompact(n, { baseDecimals: 0 });
    },
    fmtApy(n) { return n == null ? "—" : n.toFixed(2) + "%"; },
    // TVL/APY are dashed out when the row has never gone through a live/
    // static refresh pass — §5.11's "— when data_source==='upcoming'".
    fmtTvlCell(v) {
      return v.dataSource === "upcoming" ? "—" : this.fmtUsd(v.tvlUsd);
    },
    fmtApyCell(v) {
      return v.dataSource === "upcoming" ? "—" : this.fmtApy(v.yieldApy);
    },
    fmtRefreshed(iso) {
      if (!iso) return "never";
      const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      return `${Math.floor(hours / 24)}d ago`;
    },
  }));
}
