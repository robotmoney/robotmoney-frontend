// Alpine factory for the /lobster "Lobster Coins" directory (issue #386,
// docs/bot-analytics-ui-port-plan.md §5.9, P2.3). Fetches the read-only
// GET /api/dashboards/coins feed and handles interactive sorting/formatting —
// the backend (dash/lists.ts) already applies the default mcap-desc sort.
import { api, ROUTES } from "../../lib/api.js";

export function registerDashLobsterView(Alpine) {
  Alpine.data("dashLobster", () => ({
    loading: true,
    error: null,
    rows: [],
    sortKey: "marketCap",
    sortDir: "desc",

    async init() {
      try {
        const data = await api.get(ROUTES.dashboards.coins);
        this.rows = data.coins || [];
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
          case "name":         av = a.name.toLowerCase();          bv = b.name.toLowerCase(); break;
          case "priceUsd":     av = a.priceUsd ?? -Infinity;       bv = b.priceUsd ?? -Infinity; break;
          case "volume24h":    av = a.volume24h ?? -Infinity;      bv = b.volume24h ?? -Infinity; break;
          case "percentChange24h": av = a.percentChange24h ?? -Infinity; bv = b.percentChange24h ?? -Infinity; break;
          case "chain":        av = (a.chain || "").toLowerCase(); bv = (b.chain || "").toLowerCase(); break;
          case "marketCap":
          default:             av = a.marketCap ?? -Infinity;      bv = b.marketCap ?? -Infinity; break;
        }
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
      return arr;
    },

    // Sort icon shown ONLY on the active column (§5.9 note: this differs
    // from other list pages, which always show a sort affordance).
    sortBy(key) {
      if (key === this.sortKey) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortKey = key;
        this.sortDir = key === "name" || key === "chain" ? "asc" : "desc";
      }
    },
    isSort(key) { return this.sortKey === key; },
    sortIcon(key) { return this.sortDir === "asc" ? "▲" : "▼"; },

    // Freshest refreshedAt across all rows — a single "Last refreshed" line
    // rather than a per-row indicator (FreshnessIndicator itself is P0.5/P0.6
    // scope, not yet built).
    get lastRefreshedLabel() {
      const times = this.rows.map((r) => r.refreshedAt).filter(Boolean).map((t) => new Date(t).getTime());
      if (!times.length) return "never refreshed";
      return fmtRel(new Date(Math.max(...times)).toISOString());
    },

    // ── formatting ──────────────────────────────────────────────────────
    fmtUsd(n) {
      if (n == null || !isFinite(n)) return "—";
      if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
      return "$" + n.toFixed(0);
    },
    // Smart price precision (§5.9): more decimals the smaller the price gets,
    // so a sub-cent token still shows a meaningful figure.
    fmtPrice(n) {
      if (n == null || !isFinite(n)) return "—";
      if (n >= 1000) return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
      if (n >= 1) return "$" + n.toFixed(4);
      if (n >= 0.01) return "$" + n.toFixed(6);
      return "$" + Number(n.toPrecision(4));
    },
    pctText(v) { return v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%"; },
    pctClass(v) {
      if (v == null) return "";
      return v > 0 ? "a3-pct-up" : v < 0 ? "a3-pct-down" : "";
    },
  }));
}

// "3h ago" / "2d ago" style relative time. Local to this view for now — the
// shared dash-format lib (P0.6) hasn't landed yet; the first list page to
// need it after this one should extract it rather than re-copy it a third
// time.
function fmtRel(iso) {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
