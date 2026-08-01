// Alpine factory for /wallets/:id — WalletProfile "wallet dossier" (issue
// #391, docs/bot-analytics-ui-port-plan.md §5.14, P3.5): GET
// /api/dashboards/wallets/:id. Renders inside views/dash/_layout.html's
// [data-outlet]; the ancestor `.a3` shell (issue #379) already supplies the
// scoped theme, so nothing here repeats that class.
//
// §5.14's OWN documented data caveat: `wallet_holdings` has no table here
// (P1.6) and live wallet refresh is unimplemented (D14 — the handler
// throws). This view therefore ships ONLY the DB-backed sections (identity,
// balance + 30d delta, linked agent, balance history) and renders an honest
// `.a3-notice` where TokenHoldingsCard/TokenDetailsDrawer/TransactionsCard/
// TxTransfersDialog/Recent Activity would have gone — never a fabricated
// holdings or transaction row.
//
// Balance History (30d): the doc's Sparkline is 800x120 — the shared
// `renderSparkline` helper (alpine/lib/sparkline.js, issue #381) already
// documents that exact size for this exact call site ("large mode for
// WalletProfile passes {width:800,height:120}"; dash_styleguide.html's own
// "Sparkline library" demo section labels it "(large 800x120,
// WalletProfile)"), so this view is that helper's first real call site.
import { api, ROUTES, path } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";
import { renderSparkline } from "../lib/sparkline.js";

export function registerWalletProfileView(Alpine) {
  Alpine.data("walletProfileView", () => ({
    loading: true,
    error: null,
    notFound: false,
    id: null,
    profile: null,

    async init() {
      this.id = location.pathname.split("/").filter(Boolean).pop();
      await this.load();
    },

    async load() {
      this.loading = true;
      this.error = null;
      this.notFound = false;
      try {
        this.profile = await api.get(path(ROUTES.dashboards.walletDetail, { id: this.id }));
      } catch (e) {
        if (e.status === 404) this.notFound = true;
        else this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // Full-width 800x120 Sparkline (§5.14) — see this file's header comment.
    balanceSparkSvg() {
      const values = (this.profile?.balanceHistory || []).map((p) => p.balanceUsd);
      return renderSparkline(values, { width: 800, height: 120 });
    },

    get balanceDeltaUsd() {
      const cur = this.profile?.balanceUsd;
      const then = this.profile?.balance30dAgoUsd;
      if (cur == null || then == null) return null;
      return cur - then;
    },

    // ── formatting ──────────────────────────────────────────────────────────
    fmtUsd(n) {
      return fmtUsdCompact(n);
    },
    fmtDelta(n) {
      if (n == null || !isFinite(n)) return "—";
      return (n >= 0 ? "+" : "") + this.fmtUsd(n);
    },
    fmtAddr(addr) {
      if (!addr || addr.length < 10) return addr || "—";
      return addr.slice(0, 6) + "..." + addr.slice(-4);
    },
    fmtDate(iso) {
      if (!iso) return "Never";
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "Never" : d.toLocaleDateString();
    },
  }));
}
