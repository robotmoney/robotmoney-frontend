// Alpine factory for the tokenomics fee-distribution chart (also feeds the
// home fee-routing card). Moved verbatim from the monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, SERIES } from "../../lib/chart-theme.js";

export function registerFeeChart(Alpine) {
  // ── Tokenomics fee distribution (pie + legend + breakdown cards) ──────────
  // The fee split is LIVE from GET /api/dashboards/token-metrics (`feeSplit`) —
  // the fixed beneficiary shares of the token's Doppler pool, surfaced through
  // the API so the frontend stops baking the Protocol/Bankr/Doppler/Ecosystem %
  // literals. This factory backs both the tokenomics fee section (pie + custom
  // legend + breakdown cards) and the home page fee-routing card (Creator share
  // vs Interface & Protocol). Colours are presentation-only, keyed by the split
  // label; the percentages themselves are never fabricated — a failed fetch
  // degrades to "—" and an undrawn pie under the empty state, never a baked
  // default.
  const FEE_COLOR = { Protocol: SERIES.emerald, Bankr: SERIES.amber, Doppler: SERIES.slate, Ecosystem: SERIES.teal };
  // Breakdown-card copy, keyed by the split label. A leg the API adds later
  // still renders, under its own label and with no note.
  const FEE_COPY = {
    Protocol: { name: "Protocol wallet", note: "Creator share, funds buybacks" },
    Bankr: { name: "Bankr", note: "Interface, distribution partner" },
    Doppler: { name: "Doppler", note: "Launch protocol" },
    Ecosystem: { name: "Ecosystem", note: "Reserved by Bankr at launch" },
  };
  Alpine.data("feeChart", () => ({
    _chart: null,
    metrics: null,
    failed: false,
    async init() {
      try { this.metrics = await api.get(ROUTES.dashboards.tokenMetrics); }
      catch (e) { this.metrics = null; this.failed = true; }
      this.$nextTick(() => this.draw());
    },
    feeSplit() { return this.metrics?.feeSplit || []; },
    // What the legend and the cards iterate: the served split, or, until it
    // lands (and after a failed read), one placeholder per known leg so the
    // section keeps its height. A placeholder has no pct and reads "—".
    feeRows() { const fs = this.feeSplit(); return fs.length ? fs : Object.keys(FEE_COPY).map((label) => ({ label })); },
    feeName(f) { return FEE_COPY[f.label]?.name ?? f.label; },
    feeNote(f) { return FEE_COPY[f.label]?.note ?? ""; },
    // The pie's empty state (.rm-nodata), once the read has settled: null
    // while it is in flight and whenever there is a split to draw.
    feeEmptyTitle() {
      if (this.failed) return "No data available";
      return this.metrics && !this.feeSplit().length ? "No data yet" : null;
    },
    // Legend/card cell text: "Protocol (57%)" and the bare "57%".
    feeLegend(i) { const f = this.feeSplit()[i]; return f ? `${f.label} (${f.pct}%)` : "—"; },
    feePctLabel(i) { const f = this.feeSplit()[i]; return f ? `${f.pct}%` : "—"; },
    feeColor(i) { const f = this.feeRows()[i]; return (f && FEE_COLOR[f.label]) || PALETTE.textMuted; },
    // Home fee-routing card: Creator share = the Protocol leg; Interface &
    // Protocol = every other leg (Bankr + Doppler + Ecosystem) summed.
    feeCreatorPct() { const fs = this.feeSplit(); return fs.length ? fs[0].pct : null; },
    feeInterfacePct() { const fs = this.feeSplit(); return fs.length ? fs.slice(1).reduce((a, f) => a + f.pct, 0) : null; },
    pctLabel(v) { return v == null ? "—" : `${v}%`; },
    pctWidth(v) { return `width:${v == null ? 0 : v}%;`; },
    draw() {
      const canvas = this.$refs.fee;
      if (!canvas || !window.Chart) return;
      const fs = this.feeSplit();
      this._chart?.destroy();
      // Honest degrade: no live split → leave the canvas undrawn under its empty
      // state (feeEmptyTitle), never a baked pie.
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
