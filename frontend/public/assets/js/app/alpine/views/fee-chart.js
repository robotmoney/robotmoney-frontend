// Alpine factory for the tokenomics fee-distribution chart (also feeds the
// home fee-routing card). Moved verbatim from the monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, SERIES } from "../../lib/chart-theme.js";

export function registerFeeChart(Alpine) {
  // ── Tokenomics fee distribution (pie + legend + breakdown cards) ──────────
  // The fee split is LIVE from GET /api/dashboards/token-metrics (`feeSplit`) —
  // a fixed Clanker-pool config constant surfaced through the API so the
  // frontend stops baking the Protocol/Bankr/Clanker % literals. This factory
  // backs both the tokenomics fee section (pie + custom legend + breakdown
  // cards) and the home page fee-routing card (Creator share vs Interface &
  // Protocol). Colours are presentation-only, keyed by the split label; the
  // percentages themselves are never fabricated — a failed fetch degrades to
  // "—" and an undrawn pie rather than a baked default.
  const FEE_COLOR = { Protocol: SERIES.emerald, Bankr: SERIES.amber, Clanker: SERIES.slate };
  Alpine.data("feeChart", () => ({
    _chart: null,
    metrics: null,
    async init() {
      try { this.metrics = await api.get(ROUTES.dashboards.tokenMetrics); }
      catch (e) { this.metrics = null; }
      this.$nextTick(() => this.draw());
    },
    feeSplit() { return this.metrics?.feeSplit || []; },
    // Legend/card cell text: "Protocol (57%)" and the bare "57%".
    feeLegend(i) { const f = this.feeSplit()[i]; return f ? `${f.label} (${f.pct}%)` : "—"; },
    feePctLabel(i) { const f = this.feeSplit()[i]; return f ? `${f.pct}%` : "—"; },
    feeColor(i) { const f = this.feeSplit()[i]; return (f && FEE_COLOR[f.label]) || PALETTE.textMuted; },
    // Home fee-routing card: Creator share = the Protocol leg; Interface &
    // Protocol = every other leg (Bankr + Clanker) summed.
    feeCreatorPct() { const fs = this.feeSplit(); return fs.length ? fs[0].pct : null; },
    feeInterfacePct() { const fs = this.feeSplit(); return fs.length ? fs.slice(1).reduce((a, f) => a + f.pct, 0) : null; },
    pctLabel(v) { return v == null ? "—" : `${v}%`; },
    pctWidth(v) { return `width:${v == null ? 0 : v}%;`; },
    draw() {
      const canvas = this.$refs.fee;
      if (!canvas || !window.Chart) return;
      const fs = this.feeSplit();
      this._chart?.destroy();
      // Honest degrade: no live split → leave the canvas empty, never a baked pie.
      if (!fs.length) { this._chart = null; return; }
      this._chart = new window.Chart(canvas, {
        type: "pie",
        data: {
          labels: fs.map((f) => `${f.label} (${f.pct}%)`),
          datasets: [{ data: fs.map((f) => f.pct), backgroundColor: fs.map((f) => FEE_COLOR[f.label] || PALETTE.textMuted), borderColor: PALETTE.deep, borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } },
      });
    },
    destroy() { this._chart?.destroy(); this._chart = null; },
  }));
}
