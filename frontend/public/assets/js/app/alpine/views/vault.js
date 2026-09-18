import { api, ROUTES } from "../../lib/api.js";
import {
  VAULTS,
  normalizeOverview,
  legacyOverview,
  money,
  weight,
  gapLabel,
  dateLabel,
  numberOrNull,
  statusLabel,
  explorerLink,
  receiptApplied,
} from "../../lib/vault-data.js";
import { positionComposition } from "../../components/positions.js";
import { weightLayers, vaultTooltip } from "../../components/vaults.js";
import {
  researchRecord,
  escapeHtml,
} from "../../components/subject-research.js";
/** @returns {any} */
export function vaultData() {
  return {
    vaultOverview: normalizeOverview(null),
    vaultLoading: true,
    vaultError: "",
    detail: null,
    detailError: "",
    selectedVault: "rmusdc",
    historyMetric: "tvl",
    historyRange: "30",
    activityPage: 0,
    observationPage: 0,
    selectedObservation: null,
    chartWidth: 760,
    allHoldings: false,
    money,
    weight,
    gapLabel,
    dateLabel,
    statusLabel,
    weightLayers,
    positionComposition,
    vaultTooltip,
    researchAnchor: researchRecord.researchAnchor,
    vaultRows() {
      return this.vaultOverview.vaults;
    },
    vaultRow() {
      return (
        this.vaultRows().find((r) => r.slug === this.selectedVault) || null
      );
    },
    vaultRecord() {
      return {
        ...this.vaultRow(),
        ...this.detail,
        ...VAULTS.find((r) => r.slug === this.selectedVault),
      };
    },
    networkLabel() {
      const n = this.vaultOverview.network;
      return n
        ? `${n.label}${n.testData ? " · Test data" : ""}`
        : "Network not reported";
    },
    freshnessLabel() {
      const d = this.vaultOverview;
      return `${d.freshness?.stale ? "Stale · " : ""}${dateLabel(d.freshness?.indexedAt || d.asOf)}${d.freshness?.blockNumber != null ? " · Block " + d.freshness.blockNumber : ""}`;
    },
    receiptLabel() {
      const r = this.vaultOverview.recommendation;
      return !r
        ? "No published recommendation reported"
        : r.releasedOnChain === true
          ? "Published · Released on chain"
          : r.releasedOnChain === false
            ? "Published · Not released on chain"
            : "Published · Release not reported";
    },
    receiptHref(id) {
      return /^[0-9a-f-]{36}$/i.test(id || "")
        ? `/swarm/sessions/${id}`
        : "/swarm/subjects/robotmoney-allocation";
    },
    async loadVaults() {
      this.vaultLoading = true;
      this.vaultError = "";
      try {
        this.vaultOverview = normalizeOverview(
          await api.get("/api/dashboards/robotmoney-vaults"),
        );
      } catch (e) {
        // Legacy fallback only when the new route does not exist. A failed
        // four-vault read must never silently turn into a one-vault total.
        if (e.status === 404) {
          try {
            this.vaultOverview = legacyOverview(
              await api.get(ROUTES.dashboards.vaultEconomics),
            );
          } catch {
            this.vaultError = "Vault data is unavailable. Please try again.";
          }
        } else this.vaultError = "Vault data is unavailable. Please try again.";
      }
      this.vaultLoading = false;
    },
    async loadDetail() {
      this.activityPage = 0;
      this.resetHistory();
      this.detail = null;
      this.detailError = "";
      await this.loadVaults();
      if (this.vaultOverview.legacy) {
        this.detail = this.vaultRow();
        return;
      }
      try {
        const d = await api.get(
          `/api/dashboards/robotmoney-vaults/${this.selectedVault}`,
        );
        if (
          d.slug !== this.selectedVault ||
          (d.network?.chainId &&
            d.network.chainId !== this.vaultOverview.network?.chainId)
        )
          throw new Error("Mismatched vault");
        this.detail = d;
      } catch {
        this.detailError =
          "Detailed vault data is unavailable. Summary figures retain their own observation time.";
      }
    },
    contractHref(address) {
      return explorerLink(this.vaultOverview.network, address);
    },
    txHref(tx) {
      return explorerLink(this.vaultOverview.network, tx, "tx");
    },
    holdings() {
      return this.vaultRecord().holdings || [];
    },
    visibleHoldings() {
      return this.allHoldings ? this.holdings() : this.holdings().slice(0, 8);
    },
    activity() {
      return [...(this.vaultRecord().activity || [])].sort(
        (a, b) => Date.parse(b.t) - Date.parse(a.t),
      );
    },
    visibleActivity() {
      return this.activity().slice(this.activityPage * 6, (this.activityPage + 1) * 6);
    },
    historyPoints() {
      const points = (this.vaultRecord().history?.[this.historyMetric] || [])
        .map((r) => ({
          t: r.t,
          value: numberOrNull(
            this.historyMetric === "tvl" ? r.tvlUsd : r.value,
          ),
        }))
        .filter((r) => r.value !== null && Number.isFinite(Date.parse(r.t)))
        .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      const end = Date.parse(this.vaultOverview.asOf || "") || Date.now();
      return this.historyRange === "all"
        ? points
        : points.filter(
            (p) =>
              Date.parse(p.t) >= end - Number(this.historyRange) * 86400000,
          );
    },
    chartPoints() {
      const p = this.historyPoints();
      if (!p.length) return [];
      const lo = Math.min(...p.map((r) => r.value)),
        hi = Math.max(...p.map((r) => r.value));
      const start = Date.parse(p[0].t),
        span = Date.parse(p[p.length - 1].t) - start;
      return p.map((r) => ({
        ...r,
        x: span ? 60 + ((Date.parse(r.t) - start) / span) * (this.chartWidth - 76) : (this.chartWidth + 44) / 2,
        y: hi === lo ? 100 : 170 - ((r.value - lo) / (hi - lo)) * 140,
      }));
    },
    measureHistory() { this.chartWidth = Math.max(260, this.$refs?.historyPlot?.clientWidth || 760); },
    historyAxis() {
      const points = this.historyPoints();
      if (!points.length) return [];
      const lo = Math.min(...points.map(p => p.value)), hi = Math.max(...points.map(p => p.value));
      const values = lo === hi ? [{ value: lo, y: 100 }] : [{value:hi,y:30},{value:(hi+lo)/2,y:100},{value:lo,y:170}];
      return values.map(p => ({ ...p, label: this.historyMetric === 'tvl' ? new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:1}).format(p.value) : this.historyValue(p.value) }));
    },
    chartAxisLabels() { return this.historyAxis().map(p => `<text x="0" y="${p.y + 3}" class="vv-axis-label">${escapeHtml(p.label)}</text>`).join(''); },
    historySelection() {
      const points = this.chartPoints();
      return points[Math.min(this.selectedObservation ?? points.length - 1, points.length - 1)] || null;
    },
    selectHistory(event) {
      const box = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * this.chartWidth;
      const points = this.chartPoints();
      if (points.length) this.selectedObservation = points.reduce((best, p, i) => Math.abs(p.x - x) < Math.abs(points[best].x - x) ? i : best, 0);
    },
    moveHistory(delta) {
      const end = this.historyPoints().length - 1;
      this.selectedObservation = Math.max(0, Math.min(end, (this.selectedObservation ?? end) + delta));
    },
    resetHistory() { this.selectedObservation = null; this.observationPage = 0; },
    visibleObservations() { return this.historyPoints().slice(this.observationPage * 10, (this.observationPage + 1) * 10); },
    chartMarkers() {
      return this.chartPoints()
        .map(
          (p) =>
            `<circle cx="${p.x}" cy="${p.y}" r="4" data-mark="series" fill="${this.vaultRecord().color}"><title>${escapeHtml(dateLabel(p.t) + ": " + this.historyValue(p.value))}</title></circle>`,
        )
        .join("");
    },
    chartPath() {
      const p = this.chartPoints();
      // Sparse observations remain points. Never bridge gaps over three days.
      return p.length < 7
        ? ""
        : p
            .map(
              (r, i) =>
                `${i && Date.parse(r.t) - Date.parse(p[i - 1].t) <= 3 * 86400000 ? "L" : "M"}${r.x},${r.y}`,
            )
            .join(" ");
    },
    historyValue(v) {
      return this.historyMetric === "apy"
        ? numberOrNull(v) === null
          ? "Not reported"
          : (v * 100).toFixed(2) + "%"
        : this.historyMetric === "sharePrice" && numberOrNull(v) !== null ? "$" + Number(v).toFixed(4) : money(v);
    },
    apy(v) {
      return numberOrNull(v) === null
        ? "Not reported"
        : `${(v * 100).toFixed(2)}%`;
    },
    receipts() {
      const d = this.vaultRecord();
      return (d.history?.receipts || []).map((r) => ({
        ...r,
        matched: receiptApplied(r, d.history?.weights || []),
      }));
    },
    canDeposit() {
      const r = this.vaultRecord();
      return (
        this.selectedVault === "rmusdc" &&
        this.vaultOverview.legacy &&
        this.vaultOverview.network?.chainId === 8453 &&
        !this.vaultOverview.network?.testData &&
        r.availability === "live" &&
        !r.flags?.shutdown &&
        !r.flags?.depositsPaused
      );
    },
  };
}
export function registerVaultView(Alpine) {
  Alpine.data("vaultView", () => ({
    ...vaultData(),
    init() {
      this.selectedVault = location.pathname.split("/").filter(Boolean).pop();
      this.loadDetail().then(() => this.$nextTick(() => researchRecord.restoreResearchAnchor()));
    },
  }));
}
