// Alpine factory for /list — "Total Market" (issue #384,
// docs/bot-analytics-ui-port-plan.md §5.1, P2.1), the flagship page of the
// bot-analytics UI port: TotalMarketOverview (RM ticker + 5 metric cards + 4
// leader cards) over GET /api/dashboards/overview, and the unified
// agent/coin/vault/wallet table over GET /api/dashboards/entities. Renders
// inside views/dash/_layout.html's [data-outlet] — the ancestor shell already
// carries the `.a3` scope class (issue #379), so this fragment's root does
// NOT repeat it.
//
// Sparkline rendering (RowSparkline, §4.3) is a page-local hand-rolled SVG
// helper here, matching the existing precedent in alpine/views/projects.js's
// sparkSvg() — the shared alpine/lib/sparkline.js (P0.5, issue #381) has not
// landed yet; this view should switch to that import once it does rather
// than keep two implementations.
import { api, ROUTES } from "../../lib/api.js";

const STATE_KEY = "list:state";
const LAST_VIEWED_KEY = "list:lastViewed";

const TABS = [
  { id: "all", label: "All", type: null },
  { id: "agents", label: "Agents", type: "agent" },
  { id: "coins", label: "Coins", type: "coin" },
  { id: "vaults", label: "Vaults", type: "vault" },
  { id: "wallets", label: "Wallets", type: "wallet" },
];

// Per-type contextual column header (MARKET CAP / SCORE / APY / LAST TX, §5.1).
const CONTEXTUAL_LABEL = { agent: "SCORE", coin: "MARKET CAP", vault: "APY", wallet: "LAST TX" };
const REVENUE_LABEL = { agent: "REVENUE (30D)", coin: "VOL", vault: "—", wallet: "—" };
const TYPE_BADGE = { agent: "cyan", coin: "purple", vault: "green", wallet: "amber" };

function loadState() {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveState(state) {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (_) {
    /* sessionStorage unavailable (private mode) — persistence is best-effort */
  }
}

export function registerListView(Alpine) {
  Alpine.data("listView", () => ({
    loading: true,
    error: null,
    overview: null,
    entities: [],

    tab: "all",
    sortKey: "contextual",
    sortDir: "desc",
    showUnverified: false,

    async init() {
      const saved = loadState();
      if (saved) {
        this.tab = saved.tab ?? "all";
        this.sortKey = saved.sortKey ?? "contextual";
        this.sortDir = saved.sortDir ?? "desc";
        this.showUnverified = !!saved.showUnverified;
      }
      await this.load();
      this._highlightLastViewed();
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const [overview, entitiesRes] = await Promise.all([
          api.get(ROUTES.dashboards.overview),
          api.get(ROUTES.dashboards.entities),
        ]);
        this.overview = overview;
        this.entities = entitiesRes.entities || [];
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    _persist() {
      saveState({ tab: this.tab, sortKey: this.sortKey, sortDir: this.sortDir, showUnverified: this.showUnverified });
    },

    // ── tabs ──────────────────────────────────────────────────────────────
    tabs: TABS,
    selectTab(id) {
      this.tab = id;
      // Reset sort on tab switch (§5.1: "default sort contextual desc, reset
      // on tab switch").
      this.sortKey = "contextual";
      this.sortDir = "desc";
      this._persist();
    },
    isTab(id) {
      return this.tab === id;
    },
    tabCount(id) {
      const t = TABS.find((x) => x.id === id);
      const visible = this.showUnverified ? this.entities : this.entities.filter((e) => !e.pending);
      if (!t || !t.type) return visible.length;
      return visible.filter((e) => e.type === t.type).length;
    },
    toggleUnverified() {
      this.showUnverified = !this.showUnverified;
      this._persist();
    },

    // ── rows ──────────────────────────────────────────────────────────────
    get activeType() {
      return TABS.find((t) => t.id === this.tab)?.type ?? null;
    },
    get filteredRows() {
      const type = this.activeType;
      let rows = this.entities;
      if (type) rows = rows.filter((e) => e.type === type);
      if (!this.showUnverified) rows = rows.filter((e) => !e.pending);
      return rows;
    },
    get sortedRows() {
      const rows = [...this.filteredRows];
      const dir = this.sortDir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        let av;
        let bv;
        switch (this.sortKey) {
          case "name":
            av = a.name.toLowerCase();
            bv = b.name.toLowerCase();
            break;
          case "type":
            av = a.type;
            bv = b.type;
            break;
          case "category":
            av = (a.category || "").toLowerCase();
            bv = (b.category || "").toLowerCase();
            break;
          case "revenue":
            av = a.revenue ?? -Infinity;
            bv = b.revenue ?? -Infinity;
            break;
          case "balance":
            av = a.balance ?? -Infinity;
            bv = b.balance ?? -Infinity;
            break;
          case "change24h":
            av = a.change24h ?? -Infinity;
            bv = b.change24h ?? -Infinity;
            break;
          case "contextual":
          default:
            av = this._contextualSortValue(a);
            bv = this._contextualSortValue(b);
            break;
        }
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
      return rows;
    },
    _contextualSortValue(row) {
      if (row.type === "wallet") return row.lastTxAt ? new Date(row.lastTxAt).getTime() : -Infinity;
      return row.contextual ?? -Infinity;
    },
    sortBy(key) {
      if (key === "sparkline") return; // 6M column is explicitly not sortable
      if (key === this.sortKey) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortKey = key;
        this.sortDir = "desc";
      }
      this._persist();
    },
    isSort(key) {
      return this.sortKey === key;
    },
    sortIcon(key) {
      if (this.sortKey !== key) return "↕";
      return this.sortDir === "asc" ? "▲" : "▼";
    },
    sortLabel() {
      const map = { name: "NAME", type: "TYPE", category: "CATEGORY", revenue: "REVENUE / VOL", balance: "BALANCE / TVL", change24h: "24H %" };
      return map[this.sortKey] || CONTEXTUAL_LABEL[this.activeType] || "SCORE";
    },

    contextualLabel(type) {
      return CONTEXTUAL_LABEL[type] || "SCORE";
    },
    revenueLabel(type) {
      return REVENUE_LABEL[type] || "REVENUE / VOL";
    },
    typeBadgeClass(type) {
      return "a3-badge--" + (TYPE_BADGE[type] || "cyan");
    },

    // ── last-viewed persistence + highlight (§4.4) ─────────────────────────
    rowKey(row) {
      return row.type + ":" + row.id;
    },
    recordViewed(row) {
      try {
        sessionStorage.setItem(LAST_VIEWED_KEY, this.rowKey(row));
      } catch (_) {
        /* best-effort */
      }
    },
    _highlightLastViewed() {
      let key;
      try {
        key = sessionStorage.getItem(LAST_VIEWED_KEY);
      } catch (_) {
        key = null;
      }
      if (!key) return;
      this.$nextTick(() => {
        const el = document.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "center" });
        el.classList.add("a3-row-highlight");
        setTimeout(() => el.classList.remove("a3-row-highlight"), 4000);
      });
    },

    // ── formatting (INV-O §2.9-alike; local until dash-format.js/#381 lands) ─
    fmtUsd(n) {
      if (n == null || !isFinite(n)) return "—";
      const abs = Math.abs(n);
      if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
      if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
      if (abs >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
      return "$" + n.toFixed(2);
    },
    fmtScore(n) {
      return n == null || !isFinite(n) ? "—" : n.toFixed(1);
    },
    fmtApy(n) {
      return n == null || !isFinite(n) ? "—" : (n * 100).toFixed(2) + "%";
    },
    fmtContextual(row) {
      if (row.type === "wallet") return this.fmtRel(row.lastTxAt);
      if (row.type === "vault") return this.fmtApy(row.contextual);
      if (row.type === "coin") return this.fmtUsd(row.contextual);
      return this.fmtScore(row.contextual);
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
    titleCase(s) {
      if (!s) return "—";
      return String(s)
        .replace(/[_-]+/g, " ")
        .replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
    },

    // ── RowSparkline (§4.3): 80x22, stroke 1.25, 12% opacity area fill,
    // auto-color green if last>first by >0.5%, red if down, muted if flat;
    // "—" under 4 finite points.
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
