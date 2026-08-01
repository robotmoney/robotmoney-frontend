// Alpine factory for /projects/:slug — ProjectProfile "dossier" (issue #389,
// docs/bot-analytics-ui-port-plan.md §5.5, P3.1): hero, KPI money strip, all
// four facet tables, a 90d raw-daily history (5 ChartCards), ratio tiles, and
// an activity feed, over GET /api/projects/:slug. Renders inside
// views/dash/_layout.html's [data-outlet] — the ancestor shell already
// carries the `.a3` scope class (issue #379), so this fragment's root does
// NOT repeat it.
//
// Two sections the plan (§5.5, §6) describes are NOT rendered — see
// contract/src/projects.d.ts's ProjectDetail doc comment for the full
// rationale: Holdings (no per-asset breakdown table exists for
// tracked_wallets) and per-agent Buyers/Holders + the Buyers/Txn ratio tile
// (no buyer/holder column anywhere in this schema). Both are omissions, not
// hidden-but-fetched sections — the DTO itself carries no such field.
//
// fmtUsd is now shared via alpine/lib/dash-format.js (issue #449). Chart
// rendering reuses the shared dash Chart.js theme (alpine/lib/chart-theme.js,
// issue #381) and the shared Sparkline lib (alpine/lib/sparkline.js) — both
// landed since #385/#387 shipped their own hand-rolled sparkline helpers, so
// this view is the first ProjectProfile-generation view to consume them
// directly instead of duplicating that logic.
import { api, path, ROUTES } from "../../lib/api.js";
import { dashChartOptions, dashLineDatasetDefaults } from "../lib/chart-theme.js";
import { renderRowSparkline, renderSparkline } from "../lib/sparkline.js";
import { fmtUsdCompact } from "../lib/dash-format.js";

// §5.5's four ScoreBars, in display order. Each sub-score is 0..100
// (backend/src/projects/transforms.ts::computeCoverage) — same scale as
// dataCoverageScore itself, so a plain width-percent bar needs no rescaling.
const SCORE_BARS = [
  { key: "breadthScore", label: "Breadth" },
  { key: "identityScore", label: "Identity" },
  { key: "onchainScore", label: "On-chain" },
  { key: "activityScore", label: "Activity" },
];

// The 5 history ChartCards (§5.5's 90d History section: Token Price gets its
// own row; Market Cap / Daily Revenue / Treasury / Avg Productivity share a
// 2-col grid). `key` indexes ProjectHistoryPoint; `ref` is the canvas's
// (static — see drawCharts()'s doc comment for why not looped) `x-ref` name
// in project-profile.html; `fmt` picks the y-tick formatter below.
const CHART_CARDS = [
  { key: "tokenPriceUsd", ref: "chartTokenPrice", label: "Token Price", fmt: "usd" },
  { key: "marketCapUsd", ref: "chartMarketCap", label: "Market Cap", fmt: "usd" },
  { key: "dailyRevenueUsd", ref: "chartDailyRevenue", label: "Daily Revenue", fmt: "usd" },
  { key: "treasuryUsd", ref: "chartTreasury", label: "Treasury (Wallets + TVL)", fmt: "usd" },
  { key: "avgProductivity", ref: "chartProductivity", label: "Avg Agent Productivity", fmt: "num" },
];

export function registerProjectProfileView(Alpine) {
  Alpine.data("projectProfileView", () => ({
    loading: true,
    error: null,
    notFound: false,
    project: null,
    scoreBars: SCORE_BARS,
    _charts: {},

    async init() {
      await this.load();
    },
    destroy() {
      for (const chart of Object.values(this._charts)) chart?.destroy();
      this._charts = {};
    },

    slug() {
      return decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
    },

    async load() {
      this.loading = true;
      this.error = null;
      this.notFound = false;
      try {
        const res = await api.get(path(ROUTES.projects.detail, { slug: this.slug() }));
        this.project = res.project;
        this.$nextTick(() => this.drawCharts());
      } catch (e) {
        if (e.status === 404) this.notFound = true;
        else this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // ── hero ──────────────────────────────────────────────────────────────
    initials() {
      const name = this.project?.displayName || "";
      return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0].toUpperCase())
        .join("") || "?";
    },
    facetLabels() {
      const f = this.project?.facets;
      if (!f) return [];
      const labels = [];
      if (f.agent) labels.push("AGENT");
      if (f.coin) labels.push("COIN");
      if (f.wallet) labels.push("WALLET");
      if (f.vault) labels.push("VAULT");
      return labels;
    },
    heroSparkSvg() {
      return renderSparkline(this.project?.sparkline || []);
    },

    // ── history charts (Chart.js, dash theme §4.2) ──────────────────────────
    // Five EXPLICIT static-ref canvases in project-profile.html (not an
    // x-for loop): Alpine's `x-ref`/`$refs` registration is collected from
    // literal `x-ref="..."` attributes at directive-parse time, not a
    // reactive binding — a dynamic `:x-ref` on a looped template does not
    // reliably register distinct refs. Every other Chart.js-using view in
    // this codebase (allocation.html, performance.html, regime.html) follows
    // the same one-static-ref-per-canvas convention.
    drawCharts() {
      const history = this.project?.history || [];
      const labels = history.map((h) => h.date);
      for (const card of CHART_CARDS) {
        const canvas = this.$refs[card.ref];
        if (!canvas || !window.Chart) continue;
        this._charts[card.key]?.destroy();
        const data = history.map((h) => h[card.key]);
        this._charts[card.key] = new window.Chart(canvas, {
          type: "line",
          data: {
            labels,
            datasets: [{ data, fill: false, spanGaps: true, ...dashLineDatasetDefaults(canvas) }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            ...dashChartOptions(canvas, {
              tickFontSize: 9,
              yTickCallback: card.fmt === "usd" ? (v) => this.fmtUsd(v) : (v) => this.fmtNum(v),
            }),
          },
        });
      }
    },
    // §5.5: "empty 'Not enough history yet.'" — a section-level empty state
    // (the whole 90d History block), not per-chart.
    historyEmpty() {
      return (this.project?.history?.length ?? 0) === 0;
    },

    // ── facet table sparklines ───────────────────────────────────────────────
    coinSparkSvg(coin) {
      return renderRowSparkline(coin.sparkline90d || [], { width: 90 });
    },

    // ── formatting (fmtUsd shared via alpine/lib/dash-format.js, issue #449) ─
    // issue #449: this was the one view that put the sign BEFORE the "$"
    // ("-$2.00B") instead of leaving it on the number ("$-2.00B") the way
    // the other 10+ views already did — converged onto the majority shape;
    // non-negative output is unchanged either way.
    fmtUsd(n) {
      return fmtUsdCompact(n);
    },
    fmtNum(n) {
      return n == null || !isFinite(n) ? "—" : n.toFixed(1);
    },
    fmtInt(n) {
      return n == null || !isFinite(n) ? "—" : Math.round(n).toLocaleString();
    },
    fmtPct(v) {
      if (v == null || !isFinite(v)) return "—";
      return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
    },
    fmtRatio(v) {
      return v == null || !isFinite(v) ? "—" : v.toFixed(2) + "×";
    },
    fmtApy(n) {
      return n == null || !isFinite(n) ? "—" : n.toFixed(2) + "%";
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
  }));
}
