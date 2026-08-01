// Alpine factory for the /wallets "Tracked Wallets" directory (issue #386,
// docs/bot-analytics-ui-port-plan.md §5.13, P2.5). Fetches the read-only
// GET /api/dashboards/wallets feed (already merged + balance-desc sorted
// server-side, dash/lists.ts) and handles the two toggle chips, the
// chain-column auto-hide, and per-row explorer/copy affordances.
import { api, ROUTES } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";

// A small, honest set of known chains → explorer base URL. Anything else
// renders no explorer link rather than guessing a wrong one.
const EXPLORERS = {
  base: "https://basescan.org/address/",
  ethereum: "https://etherscan.io/address/",
  arbitrum: "https://arbiscan.io/address/",
  polygon: "https://polygonscan.com/address/",
  solana: "https://solscan.io/account/",
};

export function registerDashWalletsView(Alpine) {
  Alpine.data("dashWallets", () => ({
    loading: true,
    error: null,
    rows: [],
    sortKey: "balanceUsd",
    sortDir: "desc",
    x402Only: false,
    hideEmpty: true, // defaults on, per §5.13

    async init() {
      try {
        const data = await api.get(ROUTES.dashboards.wallets);
        this.rows = data.wallets || [];
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    get filteredRows() {
      return this.rows.filter((w) => {
        if (this.x402Only && w.protocol !== "x402") return false;
        if (this.hideEmpty && !(w.balanceUsd > 0)) return false;
        return true;
      });
    },

    get sortedRows() {
      const arr = [...this.filteredRows];
      const dir = this.sortDir === "asc" ? 1 : -1;
      arr.sort((a, b) => {
        let av, bv;
        switch (this.sortKey) {
          case "label":    av = a.label.toLowerCase();          bv = b.label.toLowerCase(); break;
          case "source":   av = a.source;                       bv = b.source; break;
          case "protocol": av = (a.protocol || "").toLowerCase(); bv = (b.protocol || "").toLowerCase(); break;
          case "lastTxAt": av = a.lastTxAt ? new Date(a.lastTxAt).getTime() : -Infinity;
                           bv = b.lastTxAt ? new Date(b.lastTxAt).getTime() : -Infinity; break;
          case "balanceUsd":
          default:         av = a.balanceUsd ?? -Infinity;      bv = b.balanceUsd ?? -Infinity; break;
        }
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
      return arr;
    },

    // Sort arrows are TEXT ▲/▼ appended to labels here, not icons — §5.13
    // explicitly calls this out as a preserved divergence from other pages.
    sortBy(key) {
      if (key === this.sortKey) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortKey = key;
        this.sortDir = key === "label" || key === "source" || key === "protocol" ? "asc" : "desc";
      }
    },
    isSort(key) { return this.sortKey === key; },
    sortArrow(key) { return this.isSort(key) ? (this.sortDir === "asc" ? "▲" : "▼") : ""; },

    // CHAIN column is dropped entirely when every VISIBLE row shares one
    // chain (§5.13) — recomputed against the filtered set, not the raw feed.
    get showChainColumn() {
      const chains = new Set(this.filteredRows.map((w) => w.chain || null));
      return chains.size > 1;
    },

    // ── summary line ──────────────────────────────────────────────────
    get summary() {
      const withBalance = this.rows.filter((w) => w.balanceUsd > 0);
      const total = this.rows.reduce((s, w) => s + (w.balanceUsd || 0), 0);
      return { total: this.rows.length, withBalance: withBalance.length, totalUsd: total };
    },

    // ── row-click target: dual per §5.13 ("agent-source rows →
    // /agents/:agentId, tracked rows → /wallets/:id") ────────────────────
    href(w) {
      return w.source === "agent" ? `/agents/${w.agentId}` : `/wallets/${w.id}`;
    },

    explorerUrl(w) {
      if (!w.address || !w.chain) return null;
      const base = EXPLORERS[w.chain.toLowerCase()];
      return base ? base + w.address : null;
    },

    // ── formatting ──────────────────────────────────────────────────────
    fmtUsd(n) {
      // issue #449: was `n >= 1e9` (raw signed value) — negative balances
      // in the B/M/K range fell through to the plain, unscaled branch.
      return fmtUsdCompact(n, { baseDecimals: 0 });
    },
    shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"; },
    fmtLastActive(iso) {
      if (!iso) return "Never";
      return new Date(iso).toLocaleDateString();
    },
  }));
}
