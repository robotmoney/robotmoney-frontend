// Alpine factory for /agents/:id — the "Money-agent dossier" AgentProfile
// (issue #390, docs/bot-analytics-ui-port-plan.md §5.8, P3.2) over
// GET /api/dashboards/agents/:id. Renders inside views/dash/_layout.html's
// [data-outlet]; the ancestor shell already carries the `.a3` scope class
// (issue #379), so this fragment's root does NOT repeat it.
//
// The id is read off `location.pathname` (the router injects this fragment's
// markup verbatim for every `/agents/:id`; there is no template-per-param
// mechanism) — same pattern as the public committee subject profile,
// `alpine/static-views.js`'s `subjectProfile()`.
//
// Two sections the plan (§5.8) describes are deliberately NOT rendered here:
// Voting & Reputation (explicitly "hidden until agent_score_votes backing
// exists, P1.6" in the plan itself) and Recent Transactions (needs a
// Blockscout proxy, P1.7 — no such endpoint exists in this repo yet). Per
// the plan's D10 ("never render a button that does nothing"), this view
// does not stub either as a dead control; both are separate, already-listed
// follow-up work items, not a silent drop.
import { api, ROUTES, path } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";
import { renderSparkline } from "../lib/sparkline.js";
import { dashChartOptions, dashLineDatasetDefaults, applyDashChartDefaults } from "../lib/chart-theme.js";

const EXPLORER_BASE = {
  ethereum: "https://etherscan.io/address/",
  base: "https://basescan.org/address/",
  arbitrum: "https://arbiscan.io/address/",
  polygon: "https://polygonscan.com/address/",
};

function explorerUrl(chain, address) {
  if (!address) return null;
  const base = EXPLORER_BASE[(chain || "").toLowerCase()] || EXPLORER_BASE.base;
  return base + address;
}

export function registerAgentProfileView(Alpine) {
  Alpine.data("agentProfileView", () => ({
    loading: true,
    error: null,
    agent: null,
    copied: false,
    _chart: null,

    async init() {
      const id = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
      try {
        this.agent = await api.get(path(ROUTES.dashboards.agentDetail, { id }));
        this.loading = false;
        this.$nextTick(() => this.drawChart());
      } catch (e) {
        this.error = e.status === 404 ? "Agent not found." : e.message || "Failed to load agent.";
        this.loading = false;
      }
    },

    // PerformanceChart (§5.8): x402 volume weekly series, dash Chart.js
    // theme (§4.2). Only drawn when there is at least one nonzero week —
    // the template shows the "No attributed x402 payment history yet."
    // placeholder instead of an empty/flat chart otherwise.
    drawChart() {
      const canvas = this.$refs.perfChart;
      if (!canvas || !window.Chart || !this.hasX402History) return;
      this._chart?.destroy();
      const series = this.agent.x402Sparkline;
      this._chart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: series.map((_, i) => String(i)),
          datasets: [{ data: series, fill: false, ...dashLineDatasetDefaults(canvas) }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          ...dashChartOptions(canvas, { yTickCallback: (v) => this.fmtUsd(v) }),
        },
      });
      applyDashChartDefaults(this._chart);
    },
    destroy() {
      this._chart?.destroy();
      this._chart = null;
    },

    get hasX402History() {
      return (this.agent?.x402Sparkline || []).some((v) => typeof v === "number" && v > 0);
    },

    // Wallet status copy (MoneyStrip, §5.8): trusted-balance rule collapsed
    // to the three states the plan describes — a verified positive balance,
    // an identified-but-unconfirmed wallet, or none at all.
    get walletStatusLabel() {
      const a = this.agent;
      if (!a?.walletAddress) return "Wallet missing";
      if (a.walletBalanceUsd != null && a.walletBalanceUsd > 0) return "Verified liquid wallet balance";
      return "Wallet identified";
    },

    evidenceLabel(status) {
      return { verified: "Verified", partial: "Partial", missing: "Missing" }[status] || "Missing";
    },
    evidenceClass(status) {
      return { verified: "a3-badge--green", partial: "a3-badge--amber", missing: "a3-badge--muted" }[status] || "a3-badge--muted";
    },

    explorerUrl(chain, address) {
      return explorerUrl(chain, address);
    },
    // The agent's own wallet has no chain column on openclaw_agents itself
    // (only tracked_wallets carries `chain`) — default to base, this repo's
    // native chain, same default list2.js's explorerUrl() falls back to.
    walletExplorerUrl() {
      return explorerUrl("base", this.agent?.walletAddress);
    },

    async copyWallet() {
      if (!this.agent?.walletAddress) return;
      try {
        await navigator.clipboard.writeText(this.agent.walletAddress);
        this.copied = true;
        setTimeout(() => { this.copied = false; }, 2000);
      } catch (_) { /* clipboard unavailable — non-fatal */ }
    },

    shortAddr(addr) {
      if (!addr) return "—";
      return addr.length <= 10 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    },
    fmtUsd(n) {
      return fmtUsdCompact(n);
    },
    fmtScore(n) {
      return n == null || !isFinite(n) ? "—" : n.toFixed(1);
    },
    fmtDate(iso) {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "—";
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    },

    // Sparkline (§4.3 default Sparkline, not RowSparkline) for the money-strip
    // metric cards, matching the styleguide/list precedent of a page-local
    // wrapper over the shared lib.
    sparklineSvg(values) {
      return renderSparkline(values, { width: 120, height: 32 });
    },
  }));
}
