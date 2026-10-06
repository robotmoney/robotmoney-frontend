// Alpine factory for the $ROBOTMONEY token figures: the tokenomics page (its
// facts row and the fee-split ring) and the home fee-routing card.
import { api, ROUTES } from "../../lib/api.js";
import { CATEGORICAL } from "../../lib/chart-theme.js";
import { sessionSummary } from "../../lib/session-summary.js";

export function registerFeeChart(Alpine) {
  // ── $ROBOTMONEY fee split + token metrics ─────────────────────────────────
  // Everything here is LIVE from GET /api/dashboards/token-metrics: the price,
  // supply and market cap, and `feeSplit`, the fixed beneficiary shares of the
  // token's Doppler pool, served so the frontend stops baking the
  // Protocol/Bankr/Doppler/Ecosystem % literals. The split draws as the ring
  // every weight mix on the site uses (sessionSummary.ringSvg), each leg in the
  // CATEGORICAL hue of its position in the served order, so a leg keeps its
  // colour wherever it appears. Nothing is fabricated: a failed read degrades
  // to "—" and the ring's empty state, never a baked default.
  //
  // Each leg's name and note, keyed by the split label. A leg the API adds
  // later still renders, under its own label and with no note.
  const FEE_COPY = {
    Protocol: { name: "Protocol wallet", note: "Creator share, funds buybacks" },
    Bankr: { name: "Bankr", note: "Interface, distribution partner" },
    Doppler: { name: "Doppler", note: "Launch protocol" },
    Ecosystem: { name: "Ecosystem", note: "Reserved by Bankr at launch" },
  };
  Alpine.data("feeChart", () => ({
    metrics: null,
    failed: false,
    async init() {
      try { this.metrics = await api.get(ROUTES.dashboards.tokenMetrics); }
      catch (e) { this.metrics = null; this.failed = true; }
    },
    feeSplit() { return this.metrics?.feeSplit || []; },
    // The ring's empty state (.rm-nodata), once the read has settled: null
    // while it is in flight and whenever there is a split to draw.
    feeEmptyTitle() {
      if (this.failed) return "No data available";
      return this.metrics && !this.feeSplit().length ? "No data yet" : null;
    },
    // What the legend iterates: the served split, or, until it lands (and
    // after a failed read), one placeholder per known leg so the figure keeps
    // its height. A placeholder has no pct and reads "—".
    feeRows() { const fs = this.feeSplit(); return fs.length ? fs : Object.keys(FEE_COPY).map((label) => ({ label })); },
    feeName(f) { return FEE_COPY[f.label]?.name ?? f.label; },
    feeNote(f) { return FEE_COPY[f.label]?.note ?? ""; },
    feeHue(i) { return CATEGORICAL[i % CATEGORICAL.length]; },
    feePctLabel(i) { const f = this.feeSplit()[i]; return f ? `${f.pct}%` : "—"; },
    feeRingSvg() {
      const fs = this.feeSplit();
      return fs.length ? sessionSummary.ringSvg(fs.map((f, i) => ({ key: f.label, label: f.label, pct: f.pct, colour: this.feeHue(i) }))) : "";
    },
    feeRingLabel() { return this.feeSplit().map((f) => `${f.label} ${f.pct}%`).join(", "); },
    // The facts row. Price keeps three significant figures: the token trades
    // in millionths of a dollar, where fixed decimals read as zero.
    priceLabel() {
      const v = this.metrics?.robotmoney?.priceUsd;
      return v == null ? "—" : `$${Number(v).toPrecision(3)}`;
    },
    marketCapLabel() {
      const v = this.metrics?.robotmoney?.marketCapUsd;
      return v == null ? "—" : `$${Math.round(v).toLocaleString("en-US")}`;
    },
    supplyLabel() {
      const v = this.metrics?.robotmoney?.totalSupply;
      return v == null ? "—" : `${Math.round(v / 1e9).toLocaleString("en-US")}B`;
    },
    // Home fee-routing card: Creator share = the Protocol leg; Interface &
    // Protocol = every other leg (Bankr + Doppler + Ecosystem) summed.
    feeCreatorPct() { const fs = this.feeSplit(); return fs.length ? fs[0].pct : null; },
    feeInterfacePct() { const fs = this.feeSplit(); return fs.length ? fs.slice(1).reduce((a, f) => a + f.pct, 0) : null; },
    pctLabel(v) { return v == null ? "—" : `${v}%`; },
    pctWidth(v) { return `width:${v == null ? 0 : v}%;`; },
  }));
}
