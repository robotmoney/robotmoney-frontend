// Alpine factory for /agents — "OpenClaw Agents" (issue #385,
// docs/bot-analytics-ui-port-plan.md §5.7, P2.2): the tracked-agent
// directory over GET /api/dashboards/agents. Renders inside views/dash/
// _layout.html's [data-outlet] — the ancestor shell already carries the
// `.a3` scope class (issue #379), so this fragment's root does NOT repeat
// it.
//
// Sparkline rendering (RowSparkline, §4.3) is a page-local hand-rolled SVG
// helper here, matching the existing precedent in alpine/views/projects.js's
// sparkSvg() — the shared alpine/lib/sparkline.js (P0.5, issue #381) has not
// landed yet; this view should switch to that import once it does rather
// than keep two implementations.
import { api, ROUTES } from "../../lib/api.js";

const TABS = [
  { id: "all", label: "All", match: () => true },
  { id: "agents", label: "Agents", match: (r) => !r.isFacilitator },
  { id: "facilitators", label: "Facilitators", match: (r) => r.isFacilitator },
];

// Reduced to the 5 badge variants dash.css actually ships (issue #379) — the
// plan's original 8-color protocol palette (§5.7) is a nice-to-have beyond
// what P0.1/P0.2 shipped; this mapping groups protocols onto the closest
// existing hue rather than adding new CSS variants for this one column.
const PROTOCOL_BADGE = {
  x402: "cyan",
  acp: "cyan",
  facilitator: "cyan",
  virtuals: "purple",
  olas: "green",
  bankr: "amber",
  eliza: "amber",
};

const SPARK_OPTIONS = [
  { value: "score", label: "Score" },
  { value: "x402", label: "x402 Vol" },
  { value: "balance", label: "Balance" },
];

export function registerAgentsView(Alpine) {
  Alpine.data("agentsView", () => ({
    loading: true,
    error: null,
    agents: [],
    summary: { active: 0, idle: 0, x402Txns: 0, x402VolumeUsd: 0, totalBalanceUsd: 0 },

    tab: "all",
    tabs: TABS,
    sortKey: "score",
    sortDir: "desc",

    sparkOpen: false,
    sparkMetric: "score",
    sparkOptions: SPARK_OPTIONS,

    async init() {
      await this.load();
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const res = await api.get(ROUTES.dashboards.agents);
        this.agents = res.agents || [];
        this.summary = res.summary || this.summary;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // ── tabs ──────────────────────────────────────────────────────────────
    selectTab(id) {
      this.tab = id;
    },
    isTab(id) {
      return this.tab === id;
    },
    tabCount(id) {
      const t = TABS.find((x) => x.id === id);
      if (!t) return 0;
      return this.agents.filter(t.match).length;
    },

    // ── rows ──────────────────────────────────────────────────────────────
    get filteredRows() {
      const t = TABS.find((x) => x.id === this.tab);
      return t ? this.agents.filter(t.match) : this.agents;
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
          case "protocol":
            av = (a.protocol || "").toLowerCase();
            bv = (b.protocol || "").toLowerCase();
            break;
          case "active":
            av = a.active ? 1 : 0;
            bv = b.active ? 1 : 0;
            break;
          case "x402Txns":
            av = a.x402Txns ?? 0;
            bv = b.x402Txns ?? 0;
            break;
          case "x402VolumeUsd":
            av = a.x402VolumeUsd ?? 0;
            bv = b.x402VolumeUsd ?? 0;
            break;
          case "balanceUsd":
            av = a.balanceUsd ?? -Infinity;
            bv = b.balanceUsd ?? -Infinity;
            break;
          case "score":
          default:
            av = a.score ?? 0;
            bv = b.score ?? 0;
            break;
        }
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

    protocolBadgeClass(row) {
      const key = row.isFacilitator ? "facilitator" : (row.protocol || "").toLowerCase();
      return "a3-badge--" + (PROTOCOL_BADGE[key] || "muted");
    },

    sparkLabel() {
      const found = this.sparkOptions.find((o) => o.value === this.sparkMetric);
      return found ? found.label : "Score";
    },

    // ── formatting ──────────────────────────────────────────────────────────
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
    fmtWallet(addr) {
      if (!addr || addr.length < 10) return addr || "—";
      return addr.slice(0, 6) + "..." + addr.slice(-4);
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
