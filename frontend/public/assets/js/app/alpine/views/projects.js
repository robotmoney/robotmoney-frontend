// Alpine factory for the /projects directory view ("Agentic Economy
// Ecosystem"). Moved verbatim from the monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";

export function registerProjectsView(Alpine) {
  // ── Projects directory ("Agentic Economy Ecosystem") ─────────────────────
  // Ported from robotmoney-bot-analytics src/pages/Projects.tsx. The backend now
  // does the facet aggregation (sparkline, max mcap/fdv); this factory handles
  // interactive sorting + formatting over the /api/projects DTO.
  Alpine.data("projectsView", () => ({
    loading: true,
    error: null,
    rows: [],
    sortKey: "fdv",
    sortDir: "desc",
    // Sticky projects pin to the top on first load only; the first header click
    // releases the pin for the session (matches the source page).
    stickyActive: true,

    async load() {
      try {
        const data = await api.get(ROUTES.projects.list);
        this.rows = (data.projects || []).map((p) => this._enrich(p));
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },

    // Per-row derived metrics used only for sorting/display (the API supplies the
    // heavy aggregates). maxPct = the largest-magnitude 24h move across coins.
    _enrich(p) {
      const maxPct = p.coins.length
        ? p.coins.reduce((best, c) => {
            const v = c.percentChange24h;
            if (v == null) return best;
            if (best == null) return v;
            return Math.abs(v) > Math.abs(best) ? v : best;
          }, null)
        : null;
      const facetCount = ["agent", "coin", "wallet", "vault"].reduce((s, k) => s + (p.facets[k] ? 1 : 0), 0);
      return { p, maxPct, facetCount };
    },

    get sortedRows() {
      const arr = [...this.rows];
      const dir = this.sortDir === "asc" ? 1 : -1;
      arr.sort((a, b) => {
        if (this.stickyActive) {
          const aS = a.p.isSticky ? 1 : 0;
          const bS = b.p.isSticky ? 1 : 0;
          if (aS !== bS) return bS - aS;
        }
        let av = 0;
        let bv = 0;
        switch (this.sortKey) {
          case "name":    av = a.p.displayName.toLowerCase(); bv = b.p.displayName.toLowerCase(); break;
          case "mcap":    av = a.p.maxMarketCap; bv = b.p.maxMarketCap; break;
          case "fdv":     av = a.p.maxFdv; bv = b.p.maxFdv; break;
          case "pct24h":  av = a.maxPct ?? -Infinity; bv = b.maxPct ?? -Infinity; break;
          case "wallet":  av = a.p.walletTotalUsd; bv = b.p.walletTotalUsd; break;
          case "score":   av = a.p.dataCoverageScore ?? 0; bv = b.p.dataCoverageScore ?? 0; break;
          case "facets":  av = a.facetCount; bv = b.facetCount; break;
        }
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
      return arr;
    },

    sortBy(key) {
      if (this.stickyActive) this.stickyActive = false;
      if (key === this.sortKey) {
        this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      } else {
        this.sortKey = key;
        this.sortDir = key === "name" ? "asc" : "desc";
      }
    },
    isSort(key) { return this.sortKey === key; },
    sortIcon(key) { return this.sortKey === key ? (this.sortDir === "asc" ? "▲" : "▼") : "↕"; },

    // ── formatting ────────────────────────────────────────────────────────
    fmtUsd(n) {
      if (n == null || !isFinite(n) || n === 0) return "—";
      if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
      return "$" + n.toFixed(0);
    },
    mcFdvPct(p) {
      return p.maxFdv > 0 && p.maxMarketCap > 0 ? ((p.maxMarketCap / p.maxFdv) * 100).toFixed(1) + "%" : "—";
    },
    pctText(v) { return v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%"; },
    pctColor(v) {
      if (v == null) return "var(--color-text-dim)";
      return v > 0 ? "var(--color-accent)" : v < 0 ? "var(--color-warn)" : "var(--color-text-muted)";
    },
    facetPills(p) {
      return [
        { label: "AGT", on: p.facets.agent, hint: "Has agent" },
        { label: "X402", on: p.facets.x402, hint: "x402-enabled agent" },
        { label: "COIN", on: p.facets.coin, hint: "Has token" },
        { label: "WLT", on: p.facets.wallet, hint: p.wallets.length + " wallet(s)" },
        { label: "VLT", on: p.facets.vault, hint: "Has vault" },
      ];
    },
    twitterUrl(h) { return "https://x.com/" + String(h).replace(/^@/, ""); },
    twitterLabel(h) { return "@" + String(h).replace(/^@/, ""); },
    cleanUrl(u) { return String(u).replace(/^https?:\/\//, "").replace(/\/$/, ""); },
    initials(name) { return String(name || "").slice(0, 2).toUpperCase() || "?"; },

    // Inline-SVG price sparkline (normalized to the window min/max); cyan when the
    // window closes up, amber when down.
    sparkSvg(values) {
      const vals = (values || []).filter((v) => typeof v === "number" && isFinite(v));
      if (vals.length < 2) return '<span class="pj-spark-empty">—</span>';
      const W = 90, H = 24, pad = 2, n = vals.length;
      const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
      const xAt = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
      const yAt = (v) => pad + (1 - (v - min) / span) * (H - 2 * pad);
      const up = vals[n - 1] >= vals[0];
      const stroke = up ? "var(--color-accent)" : "var(--color-warn)";
      const pts = vals.map((v, i) => xAt(i).toFixed(1) + "," + yAt(v).toFixed(1)).join(" ");
      const lx = xAt(n - 1).toFixed(1), ly = yAt(vals[n - 1]).toFixed(1);
      return '<svg class="pj-spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
        + '<polyline points="' + pts + '" fill="none" stroke="' + stroke + '" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>'
        + '<circle cx="' + lx + '" cy="' + ly + '" r="1.5" fill="' + stroke + '"/></svg>';
    },
  }));
}
