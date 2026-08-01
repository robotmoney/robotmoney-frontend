// Alpine factory for the /projects directory view ("Agentic Economy
// Ecosystem"). Moved verbatim from the monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";

// Fidelity upgrades (issue #388, docs/bot-analytics-ui-port-plan.md §5.4/P2.8):
// column widths persist under the same key the original app used
// (`localStorage['projects-col-widths-v2']`, §4.4) so column order/keys below
// match the <colgroup> in projects.html 1:1.
const COL_WIDTHS_KEY = "projects-col-widths-v2";
const MIN_COL_WIDTH = 60;
const DEFAULT_COL_WIDTHS = {
  name: 220, mcap: 130, fdv: 130, mcfdv: 90, pct24h: 90, spark: 110,
  score: 110, desc: 260, website: 160, social: 140, facets: 170, wallet: 160,
};

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

    // ── Column resizing (§5.4 item 3) ────────────────────────────────────────
    colWidths: { ...DEFAULT_COL_WIDTHS },
    _resizeMove: null,
    _resizeUp: null,

    // ── Definitions dialog (§5.4 item 1; D9 keeps it regardless of the
    // BrandHeader chrome decision) ────────────────────────────────────────────
    defsOpen: false,

    init() {
      this._loadColWidths();
    },

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

    _loadColWidths() {
      try {
        const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || "null");
        if (saved && typeof saved === "object") {
          for (const key of Object.keys(DEFAULT_COL_WIDTHS)) {
            const v = saved[key];
            if (typeof v === "number" && isFinite(v)) this.colWidths[key] = Math.max(MIN_COL_WIDTH, v);
          }
        }
      } catch {
        // Corrupt/unavailable storage: fall back to defaults silently.
      }
    },
    _persistColWidths() {
      try {
        localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(this.colWidths));
      } catch {
        // Storage unavailable (private mode/quota) — resizing still works for
        // the session, it just won't survive a reload.
      }
    },
    // Drag handle mousedown handler: `key` is the column's DEFAULT_COL_WIDTHS key.
    startResize(key, ev) {
      ev.preventDefault();
      const startX = ev.clientX;
      const startWidth = this.colWidths[key];
      this._resizeMove = (e) => {
        this.colWidths[key] = Math.max(MIN_COL_WIDTH, startWidth + (e.clientX - startX));
      };
      this._resizeUp = () => {
        window.removeEventListener("mousemove", this._resizeMove);
        window.removeEventListener("mouseup", this._resizeUp);
        this._resizeMove = null;
        this._resizeUp = null;
        this._persistColWidths();
      };
      window.addEventListener("mousemove", this._resizeMove);
      window.addEventListener("mouseup", this._resizeUp);
    },
    get tableWidth() {
      return Object.values(this.colWidths).reduce((a, b) => a + b, 0);
    },

    // ── Dual synced horizontal scrollbars (§5.4 item 2) ──────────────────────
    // The thin top mirror bar and the main scroll container share one scroll
    // position; a re-entrancy guard stops the mirrored `scroll` events from
    // bouncing back and forth.
    _syncingScroll: false,
    onMainScroll(e) {
      if (this._syncingScroll) return;
      this._syncingScroll = true;
      this.$refs.scrollMirror.scrollLeft = e.target.scrollLeft;
      this._syncingScroll = false;
    },
    onMirrorScroll(e) {
      if (this._syncingScroll) return;
      this._syncingScroll = true;
      this.$refs.scrollMain.scrollLeft = e.target.scrollLeft;
      this._syncingScroll = false;
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
    // issue #449: was `n >= 1e9` (raw signed value) — negative values in the
    // B/M/K range fell through to the plain, unscaled branch. zeroDash
    // preserves this view's own n===0 -> "—" special case (its siblings
    // render "$0.00"/"$0" for exact zero instead).
    fmtUsd(n) {
      return fmtUsdCompact(n, { baseDecimals: 0, zeroDash: true });
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
    // §5.4 item 5: row name → /projects/:slug. The route already exists
    // (routes.js, issue #380) and resolves ungated to a "coming soon"
    // placeholder until the ProjectProfile page ships (P3.1) — the plan calls
    // for the link to land in this item regardless (§5.4: "profile page in
    // P3.1").
    profileHref(p) { return "/projects/" + encodeURIComponent(p.slug); },

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
