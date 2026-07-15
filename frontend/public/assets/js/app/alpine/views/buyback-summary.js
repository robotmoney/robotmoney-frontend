// Alpine factory for the tokenomics Buyback History card. Moved verbatim
// from the monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";

export function registerBuybackSummary(Alpine) {
  // ── Buyback summary (tokenomics page) ─────────────────────────────────────
  // Compact live view of GET /api/dashboards/buybacks for the tokenomics
  // "Buyback History" card (Date / WETH / Value / $RM + total). Same endpoint
  // and formatters as the full allocation table; a stub feed is flagged and a
  // failed fetch degrades to an empty state — never the old baked rows.
  Alpine.data("buybackSummary", () => ({
    loading: true,
    buybacks: null,
    async init() {
      try { this.buybacks = await api.get(ROUTES.dashboards.buybacks); }
      catch (e) { this.buybacks = null; }
      this.loading = false;
    },
    rows() { return this.buybacks?.rows || []; },
    totals() { return this.buybacks?.totals || null; },
    nonLive() { return this.buybacks?.source === "stub"; },
    fmtWeth(v) { return v == null ? "—" : Number(v).toFixed(4); },
    fmtWethLabel(v) { return v == null ? "—" : Number(v).toFixed(6) + " WETH"; },
    fmtUsd0(v) { return v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }); },
    fmtRmoney(v) { return v == null ? "—" : (Number(v) / 1e6).toFixed(2) + "M"; },
  }));
}
