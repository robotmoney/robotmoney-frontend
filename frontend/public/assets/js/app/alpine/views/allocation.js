// Alpine factory for the /allocation view. Moved verbatim from the
// monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE } from "../../lib/chart-theme.js";

export function registerAllocationView(Alpine) {
  // ── Asset Allocation ───────────────────────────────────────────────────────
  // EVERY section is now data-driven — no baked DATA literals remain:
  //   • Strategy pie + 4 mini bucket pies + bucket-card target weights come
  //     from GET /api/dashboards/allocation (admin/committee-managed target
  //     weights seeded from committee/allocation.json). Slice/legend COLOURS
  //     are presentation-only and stay client-side (the DTO carries no colour).
  //   • Vault pie + holdings table + TVL come from GET /api/dashboards/vault-economics.
  //   • Wallet pie + aggregate holdings table come from the per-asset legs of
  //     GET /api/dashboards/wallet-balances (`holdings[]`).
  //   • The 3 per-wallet sleeve tables come from GET /api/dashboards/wallet-sleeves.
  //   • The buyback total chip + table come from GET /api/dashboards/buybacks.
  // Each endpoint is fetched independently (allSettled semantics) so one
  // degraded feed leaves only its own widget empty/"—" instead of blanking the
  // page, and nothing is ever fabricated. The three BIG pies (strategy, vault,
  // wallet) render % datalabels via a small inline plugin; the four MINI bucket
  // pies render none.

  // Asset dot colour by symbol (presentation-only, mirrors the original design
  // system). Used for the sleeve tables, whose per-holding DTO carries no colour
  // (the aggregate wallet-balances holdings do — those use `holding.color`).
  const ASSET_DOT = {
    USDC: "#10b981", "ZYFAI-SS1": "#10b981", "GIZA-SS1": "#10b981",
    ROBOTMONEY: "#3b82f6", BNKR: "#3b82f6",
    WETH: "#f59e0b", ETH: "#f59e0b", SP500: "#8b5cf6",
  };
  const assetDot = (sym) => ASSET_DOT[sym] || "#94a3b8";
  // Strategy-pie slice colours (4 buckets) + per-bucket mini-pie palettes, in
  // committee/allocation.json bucket order (defi-yield / agent / protocol / rwa).
  const STRATEGY_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#a855f7"];
  const BUCKET_PALETTES = [
    ["#047857", "#059669", "#10b981", "#34d399", "#6ee7b7"],
    ["#1e3a8a", "#1e40af", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe"],
    ["#b45309", "#d97706", "#f59e0b", "#fbbf24"],
    ["#7c3aed", "#a855f7", "#c084fc"],
  ];

  // The hero's "Total AUM" mirrors the original site's semantics
  // (robotmoney-site src/app/allocation/page.tsx: totalValue + vaultTotalValue)
  // — wallet holdings PLUS vault TVL, not vault TVL alone. Both halves are now
  // LIVE (issue #84): the wallet half comes from GET /api/dashboards/wallet-balances
  // (`wallet.totalUsd`), the vault half from vault-economics (`economics.tvlUsd`).
  // The baked static wallet-snapshot scalar that used to live here is retired.
  Alpine.data("allocationView", () => ({
    _charts: [],
    economics: null,   // GET /api/dashboards/vault-economics
    wallet: null,      // GET /api/dashboards/wallet-balances (aggregate holdings)
    sleeves: null,     // GET /api/dashboards/wallet-sleeves (per-wallet breakdown)
    allocationFw: null,// GET /api/dashboards/allocation (target weights)
    buybacks: null,    // GET /api/dashboards/buybacks
    loading: true,
    error: null,
    // Inline datalabels plugin: white mono-bold % just inside each slice edge,
    // mirroring chartjs-plugin-datalabels {anchor:"end", align:"start", offset:10}.
    _pieLabels: {
      id: "allocPieLabels",
      afterDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.show) return;
        const ds = chart.data.datasets[0];
        const total = ds.data.reduce((a, b) => a + (Number(b) || 0), 0);
        if (!total) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = "bold 11px 'JetBrains Mono', monospace";
        ctx.fillStyle = PALETTE.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = PALETTE.deep;
        ctx.shadowBlur = 4;
        chart.getDatasetMeta(0).data.forEach((arc, i) => {
          const v = Number(ds.data[i]) || 0;
          if (v <= 0) return;
          const angle = (arc.startAngle + arc.endAngle) / 2;
          const r = arc.outerRadius - 20;
          ctx.fillText(`${((v / total) * 100).toFixed(0)}%`, arc.x + Math.cos(angle) * r, arc.y + Math.sin(angle) * r);
        });
        ctx.restore();
      },
    },
    init() {
      this.$nextTick(() => this.draw());
      this.load();
    },
    // Fetch live vault economics; redraw so the vault pie reflects real
    // per-adapter balances once the response (or the degraded/stale fallback)
    // arrives. Alpine's x-text bindings on economics.* update reactively on
    // their own — this only needs to touch the imperative Chart.js canvas.
    async load() {
      // Each feed is fetched and assigned INDEPENDENTLY: the reactive x-text
      // bindings (hero AUM, tables) update the instant that endpoint resolves,
      // so a slow or failed feed only leaves its own widget in the loading/"—"
      // state instead of blocking the page. A failed leg becomes null (never a
      // fabricated value). Total AUM stays null-until-both-live (issue #84).
      const fetchInto = (key, route) =>
        api.get(route).then((d) => { this[key] = d; }).catch(() => { this[key] = null; });
      await Promise.allSettled([
        fetchInto("economics", ROUTES.dashboards.vaultEconomics),
        fetchInto("wallet", ROUTES.dashboards.walletBalances),
        fetchInto("sleeves", ROUTES.dashboards.walletSleeves),
        fetchInto("allocationFw", ROUTES.dashboards.allocation),
        fetchInto("buybacks", ROUTES.dashboards.buybacks),
      ]);
      // Imperative Chart.js pies are (re)drawn once, after every feed has
      // settled, from whatever data arrived (missing feeds simply skip their pie).
      this.loading = false;
      this.destroy();
      this.$nextTick(() => this.draw());
    },
    // True when any live source (vault or wallet) is serving stub/degraded data,
    // so the hero can flag that Total AUM is not fully live chain data.
    walletNonLive() {
      return this.wallet?.source === "stub" || (this.wallet?.holdings || []).some((h) => h.provenance === "stub");
    },
    walletStale() {
      return (this.wallet?.holdings || []).some((h) => h.provenance === "stale");
    },
    fmtUsd(v) {
      if (v == null) return "—";
      const n = Number(v);
      return "$" + n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1000 ? 2 : 0 });
    },
    fmtPct(v) { return v == null ? "—" : (Number(v) * 100).toFixed(2) + "%"; },
    // Hero Total AUM = live prop-wallet total (wallet-balances) + live vault TVL
    // (vault-economics) — issue #84. Null only while BOTH halves are unknown
    // (still loading, or neither feed has ever resolved). If exactly one half
    // degrades to null (issue #160 — e.g. a live RPC read fails for a tracked
    // wallet leg, or the vault feed has no persisted fallback yet), sum
    // whatever DID resolve rather than blanking the whole figure to "—": a
    // partial-but-real total is more useful than hiding it, as long as
    // aumPartial() below surfaces that it's not the full picture.
    totalAum() {
      const vault = this.economics?.tvlUsd;
      const wallet = this.wallet?.totalUsd;
      if (vault == null && wallet == null) return null;
      return (wallet ?? 0) + (vault ?? 0);
    },
    // True when the hero Total AUM is a PARTIAL sum — exactly one of the two
    // live halves (wallet total, vault TVL) failed to resolve, so the number
    // shown understates the true total. Mirrors the existing
    // walletNonLive()/walletStale() provenance badges (issue #160): a
    // degraded input must never be presented as a silently "full-looking"
    // figure.
    aumPartial() {
      const vault = this.economics?.tvlUsd;
      const wallet = this.wallet?.totalUsd;
      return (vault == null) !== (wallet == null);
    },
    // Per-adapter Value cell (issue #50): an adapter still at its placeholder
    // address is reported configured:false with balanceUsd:null by the API —
    // render an explicit unconfigured state, never a live-looking $0 / dash.
    adapterValue(a) {
      return a && a.configured === false ? "Not configured" : this.fmtUsd(a?.balanceUsd);
    },
    // Balance/Price columns (vault TVL table layout parity): every adapter is
    // a USDC-denominated lending position, so its balance is the same figure
    // as balanceUsd at a fixed $1.00/unit peg — not a second, independently
    // fabricated number. Unconfigured/unknown adapters show "—", never a
    // live-looking $0 or invented price.
    adapterBalance(a) {
      return a && a.configured !== false && a.balanceUsd != null
        ? Number(a.balanceUsd).toLocaleString("en-US", { maximumFractionDigits: 4 })
        : "—";
    },
    adapterPrice(a) {
      return a && a.configured !== false && a.balanceUsd != null ? "$1.00" : "—";
    },
    asOfLabel() {
      const asOf = this.economics?.asOf;
      if (!asOf) return "—";
      const label = new Date(asOf).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
      }) + " UTC";
      return this.economics?.stale ? `${label} (stale)` : label;
    },
    sharesLabel() {
      const shares = this.economics?.totalShares;
      const price = this.economics?.sharePrice;
      if (shares == null || price == null) return "—";
      return `${Number(shares).toLocaleString("en-US", { maximumFractionDigits: 2 })} rmUSDC shares @ $${Number(price).toFixed(4)}`;
    },
    // ── holdings / sleeve table formatters (presentation over live DTOs) ──────
    dotColor(sym) { return assetDot(sym); },
    // Token balance: millions-suffixed for large counts, else up to 4 dp.
    fmtAmount(v) {
      if (v == null || !isFinite(v)) return "—";
      const a = Math.abs(v);
      if (a >= 1e6) return (v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "M";
      return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
    },
    // Unit price: sub-cent prices keep 3 significant figures ($0.00000451),
    // everything else 2–4 dp ($0.9983 / $1,550.76).
    fmtPrice(v) {
      if (v == null || !isFinite(v)) return "—";
      const a = Math.abs(v);
      if (a === 0) return "$0";
      if (a < 0.01) return "$" + Number(v.toPrecision(3)).toString();
      return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    },
    // Always-2dp USD (buyback value cells / totals, which are < $1k but need cents).
    fmtUsd2(v) { return v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
    // ── target weights (allocation framework) ─────────────────────────────────
    stratPct(i) { const s = this.allocationFw?.strategy?.[i]; return s == null ? "—" : Math.round(Number(s.targetPct)) + "%"; },
    // ── sleeves ───────────────────────────────────────────────────────────────
    sleeveWallets() { return this.sleeves?.wallets || []; },
    walletCount() { return this.sleeveWallets().length; },
    // ── buybacks ──────────────────────────────────────────────────────────────
    buybackRows() { return this.buybacks?.rows || []; },
    fmtWeth(v) { return v == null ? "—" : Number(v).toFixed(6); },
    fmtWethLabel(v) { return v == null ? "—" : Number(v).toFixed(6) + " WETH"; },
    // $ROBOTMONEY token count → millions-suffixed ("18.45M").
    fmtRmoney(v) { return v == null ? "—" : (Number(v) / 1e6).toFixed(2) + "M"; },
    shortHash(h) { return h ? `${h.slice(0, 8)}...${h.slice(-6)}` : "—"; },
    txUrl(h) { return `https://basescan.org/tx/${h}`; },
    buybackNonLive() { return this.buybacks?.source === "stub"; },
    _pie(ref, labels, data, colors, big) {
      const canvas = this.$refs[ref];
      if (!canvas || !window.Chart) return;
      const total = data.reduce((a, b) => a + b, 0);
      const instance = new window.Chart(canvas, {
        type: "pie",
        data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: PALETTE.deep, borderWidth: big ? 2 : 1.5, hoverOffset: big ? 8 : 4 }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          layout: { padding: big ? 20 : 2 },
          plugins: {
            legend: { display: false },
            allocPieLabels: { show: !!big },
            tooltip: { callbacks: { label: (c) => `${c.label}: ${((c.parsed / total) * 100).toFixed(1)}%` } },
          },
        },
        plugins: [this._pieLabels],
      });
      this._charts.push(instance);
    },
    draw() {
      // Big strategy pie + 4 mini bucket pies — target weights from the live
      // allocation framework (committee/allocation.json). Slice colours are
      // presentation-only (the DTO carries no colour); weights are never baked.
      // Honest degrade: if a feed is missing, its pie is simply not drawn — no
      // fabricated placeholder split.
      const strat = this.allocationFw?.strategy || [];
      if (strat.length) {
        this._pie("strategy",
          strat.map((s) => s.label),
          strat.map((s) => Number(s.targetPct) || 0),
          strat.map((_, i) => STRATEGY_COLORS[i % STRATEGY_COLORS.length]), true);
      }
      const buckets = this.allocationFw?.buckets || [];
      ["mini1", "mini2", "mini3", "mini4"].forEach((ref, i) => {
        const items = buckets[i]?.items || [];
        if (!items.length) return;
        const palette = BUCKET_PALETTES[i] || STRATEGY_COLORS;
        this._pie(ref,
          items.map((it) => it.label),
          items.map((it) => Number(it.targetPct) || 0),
          items.map((_, j) => palette[j % palette.length]), false);
      });
      // Vault pie — three adapter slices from the live vault-economics fetch
      // (issue #40). Before the fetch resolves, or when it degrades to
      // stale/null balances, falls back to an equal-thirds placeholder rather
      // than a fabricated split.
      const adapters = this.economics?.adapters ?? [];
      const hasLiveBalances = adapters.length === 3 && adapters.some((a) => a.balanceUsd != null && a.balanceUsd > 0);
      const vaultLabels = adapters.length === 3 ? adapters.map((a) => a.name.toUpperCase()) : ["MORPHO", "AAVE", "COMPOUND"];
      const vaultValues = hasLiveBalances ? adapters.map((a) => Math.max(0, Number(a.balanceUsd) || 0)) : [1, 1, 1];
      this._pie("vault", vaultLabels, vaultValues, ["#10b981", "#10b981", "#10b981"], true);
      // Wallet pie — live USD value per asset from wallet-balances holdings[]
      // (colour-grouped via each holding's own `color`). Assets with no live
      // value are dropped rather than drawn as a zero/fabricated slice; if the
      // feed is missing the pie is not drawn at all (honest degrade).
      const holdings = (this.wallet?.holdings || []).filter((h) => (Number(h.valueUsd) || 0) > 0);
      if (holdings.length) {
        this._pie("wallet",
          holdings.map((h) => h.symbol),
          holdings.map((h) => Number(h.valueUsd) || 0),
          holdings.map((h) => h.color || assetDot(h.symbol)), true);
      }
    },
    destroy() { this._charts.forEach((c) => c.destroy()); this._charts = []; },
  }));
}
