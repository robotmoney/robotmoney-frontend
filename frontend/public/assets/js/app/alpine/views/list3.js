// Alpine factory for /list3 — "List v3 · Money Agents" (issue #387,
// docs/bot-analytics-ui-port-plan.md §5.3, P2.7): the money-agent leaderboard
// with an evidence drawer, over GET /api/dashboards/leaderboard. Renders
// inside views/dash/_layout.html's [data-outlet] — the ancestor shell already
// carries the `.a3` scope class (issue #379).
//
// Fidelity note (see backend/src/projects/leaderboard-projections.ts header):
// the original `list3Evidence.ts` source is unavailable (deprecated app); the
// signalScore formula is ported verbatim from the plan (§5.3), but the
// confidence/evidence heuristics are a documented, real-data-only
// approximation. Momentum sparklines are hidden entirely (never zero-padded)
// when an agent has no revenue history, matching the original's own
// "all-zero placeholders, normally hidden" behavior for that column.
import { api, ROUTES } from "../../lib/api.js";

export function registerList3View(Alpine) {
  Alpine.data("list3View", () => ({
    loading: true,
    error: null,
    rows: [],
    stats: null,
    debug: null,
    asOf: null,

    sortKey: "signalScore",
    sortDir: "desc",
    drawerOpen: false,
    selected: null,

    async init() {
      await this.load();
    },
    async load() {
      this.loading = true;
      this.error = null;
      try {
        const res = await api.get(ROUTES.dashboards.leaderboard);
        this.rows = res.rows || [];
        this.stats = res.stats;
        this.debug = res.debug;
        this.asOf = res.asOf;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // x402 is hidden entirely when every row's volume is null/zero (§5.3:
    // "hidden if column empty") — a data-driven decision, not a fabricated one.
    get hasX402() {
      return this.rows.some((r) => (r.x402VolumeUsd ?? 0) > 0);
    },

    get sortedRows() {
      const rows = [...this.rows];
      const dir = this.sortDir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const av = a[this.sortKey];
        const bv = b[this.sortKey];
        const an = av == null;
        const bn = bv == null;
        if (an && bn) return 0;
        if (an) return 1;
        if (bn) return -1;
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
      // "#" is recomputed after every sort (§5.3), independent of the
      // server's original signalScore-desc rank stored on each row.
      return rows.map((r, i) => ({ ...r, displayRank: i + 1 }));
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
      if (this.sortKey !== key) return "⇅";
      return this.sortDir === "asc" ? "▲" : "▼";
    },

    openEvidence(row) {
      this.selected = row;
      this.drawerOpen = true;
    },
    closeEvidence() {
      this.drawerOpen = false;
    },

    confidenceBadgeClass(label) {
      return label === "High" ? "a3-badge--cyan" : label === "Medium" ? "a3-badge--amber" : "a3-badge--muted";
    },
    evidenceBadgeClass(status) {
      return status === "verified" ? "a3-badge--cyan" : status === "partial" ? "a3-badge--amber" : "a3-badge--muted";
    },
    sourceStatusClass(status) {
      return status === "healthy" ? "a3-badge--green" : status === "partial" ? "a3-badge--amber" : "a3-badge--destructive";
    },

    // ── formatting (page-local until dash-format.js/#381 lands) ─────────────
    fmtUsd(n) {
      if (n == null || !isFinite(n)) return "—";
      const abs = Math.abs(n);
      if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
      if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
      if (abs >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
      return "$" + n.toFixed(2);
    },
    fmtInt(n) {
      return n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString();
    },
    fmtScore(n) {
      return n == null || !isFinite(n) ? "—" : n.toFixed(1);
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
    walletLabel(row) {
      if (row.walletBalanceUsd != null && row.walletBalanceUsd > 0) return this.fmtUsd(row.walletBalanceUsd);
      if (row.walletAddress) return this.shortAddr(row.walletAddress);
      return "Wallet unresolved";
    },

    // Hand-rolled RowSparkline SVG (§4.3), identical geometry to list2.js /
    // the /list view's sparkSvg (issue #384).
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
