// Alpine factory for /treasury (RM-157): Robot Money's own money, the protocol
// wallets, read live. It replaces /performance's walletPerfView, and draws on
// the site's components rather than Chart.js: the ring every weight mix uses,
// the vault page's value-over-time area (tvl-chart.js) and its share-over-time
// bands (lib/share-chart.js).
//
// WHAT COUNTS. Only what is read on chain. The backend also values an S&P 500
// position from a hard-coded size (config.ts SP500_SIZE, owner-stated, last set
// March 2026); nothing on chain can check it, so the treasury leaves it out of
// every figure here, today's and every day's in the history (David, 2026-10-07).
//
// Reads, all public and unauthenticated:
//   wallet-balances  today's holdings across the wallets + the daily history
//   wallet-sleeves   the same holdings per wallet
//   token-metrics    the protocol's swap-fee income (RM-156)
//   buybacks         the buyback record
// Each read fails on its own: a section whose read failed says so, and the
// others stand.
import { api, ROUTES } from "../../lib/api.js";
import { CATEGORICAL } from "../../lib/chart-theme.js";
import { sessionSummary } from "../../lib/session-summary.js";
import { nearestReading, shareChartSvg, shareChartTicks, shareChartXs } from "../../lib/share-chart.js";
import { fmtDate, fmtUsd, numberOrNull } from "../../lib/vault-data.js";
import { fmtPctTrim } from "../../lib/weight-change.js";
import { tvlChart } from "../tvl-chart.js";

/** "Mar 18": the charts' axis label. @param {unknown} d */
const monthDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Not read on chain, so not counted (see above).
const OFF_CHAIN = new Set(["SP500"]);

// Each asset's colour follows its place in this order, never its size, so a
// token keeps one hue in the ring, the table and the chart, whatever it weighs
// that day. An asset outside the list takes the next free hue.
const ASSET_ORDER = ["ROBOTMONEY", "WETH", "USDC", "ETH", "BNKR", "ZYFAI-SS1", "GIZA-SS1"];
const ASSET_NAME = {
  ROBOTMONEY: "$ROBOTMONEY",
  WETH: "WETH",
  USDC: "USDC",
  ETH: "ETH",
  BNKR: "BNKR",
  "ZYFAI-SS1": "Zyfai position",
  "GIZA-SS1": "Giza position",
};

// The wallets, named by what they are for and what they hold rather than by
// their configured names ("Bankr", "Stablecoin Strategy 1"). A strategy
// wallet's delegated position says whether its strategy account holds anything.
const WALLET_NAME = { primary: "Primary wallet", strategy: "Strategy wallet" };
const DELEGATED = { "ZYFAI-SS1": "Zyfai", "GIZA-SS1": "Giza" };

// A holding under a dollar is dust (a delegated account's leftover cents); it
// keeps no row and no slice.
const DUST_USD = 1;
const HISTORY_PAGE = 10;
const DAY_MS = 86_400_000;

/** @param {string} sym */
const nameOf = (sym) => ASSET_NAME[sym] ?? sym;
/** @param {string} a */
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export function registerTreasuryView(Alpine) {
  Alpine.data("treasuryView", () => ({
    ...tvlChart(),
    loading: true,
    balances: null,
    sleeves: null,
    metrics: null,
    buybacks: null,
    failed: { balances: false, sleeves: false, metrics: false, buybacks: false },
    historyPage: 0,
    /** @type {number | null} */
    posAt: null,
    /** @type {string | null} */
    posFocus: null,

    async init() {
      const read = async (key, route) => {
        try { this[key] = await api.get(route); } catch (e) { this[key] = null; this.failed[key] = true; }
      };
      await Promise.allSettled([
        read("balances", ROUTES.dashboards.walletBalances),
        read("sleeves", ROUTES.dashboards.walletSleeves),
        read("metrics", ROUTES.dashboards.tokenMetrics),
        read("buybacks", ROUTES.dashboards.buybacks),
      ]);
      this.loading = false;
    },

    // ── colour, by the asset's place in ASSET_ORDER ─────────────────────────
    /** @param {string} sym */
    hueOf(sym) {
      const known = ASSET_ORDER.indexOf(sym);
      return CATEGORICAL[(known >= 0 ? known : ASSET_ORDER.length) % CATEGORICAL.length];
    },

    // ── today ───────────────────────────────────────────────────────────────
    holdings() {
      const hs = Array.isArray(this.balances?.holdings) ? this.balances.holdings : [];
      return hs
        .filter((h) => !OFF_CHAIN.has(h.symbol) && (numberOrNull(h.valueUsd) ?? 0) >= DUST_USD)
        .map((h) => ({ symbol: h.symbol, name: nameOf(h.symbol), amount: numberOrNull(h.amount), valueUsd: numberOrNull(h.valueUsd) ?? 0 }))
        .sort((a, b) => b.valueUsd - a.valueUsd);
    },
    totalUsd() {
      if (!this.balances) return null;
      return this.holdings().reduce((s, h) => s + h.valueUsd, 0);
    },
    totalLabel() { return fmtUsd(this.totalUsd()); },
    asOfLabel() { return this.balances?.asOf ? fmtDate(this.balances.asOf) : "—"; },
    /** @param {number} v */
    weightOf(v) {
      const t = this.totalUsd();
      if (!t) return "—";
      // A holding that rounds to nothing still exists: "<0.1%", never "0%".
      const pct = (v / t) * 100;
      return pct > 0 && pct < 0.05 ? "<0.1%" : fmtPctTrim(pct);
    },
    ringSvg() {
      const t = this.totalUsd();
      if (!t) return "";
      return sessionSummary.ringSvg(this.holdings().map((h) => ({ key: h.symbol, label: h.name, pct: (h.valueUsd / t) * 100, colour: this.hueOf(h.symbol) })));
    },
    ringLabel() {
      return `The treasury by asset: ${this.holdings().map((h) => `${h.name} ${this.weightOf(h.valueUsd)}`).join(", ")}`;
    },
    holdingsEmptyTitle() {
      if (this.failed.balances) return "No data available";
      return this.balances && !this.holdings().length ? "No holdings" : null;
    },

    // ── per wallet ──────────────────────────────────────────────────────────
    wallets() {
      const ws = Array.isArray(this.sleeves?.wallets) ? this.sleeves.wallets : [];
      let strategy = 0;
      return ws.map((w) => {
        const isStrategy = w.type === "strategy";
        if (isStrategy) strategy += 1;
        const all = Array.isArray(w.holdings) ? w.holdings : [];
        const delegated = all.find((h) => DELEGATED[h.symbol]);
        const rows = all
          .filter((h) => !OFF_CHAIN.has(h.symbol) && !DELEGATED[h.symbol] && (numberOrNull(h.valueUsd) ?? 0) >= DUST_USD)
          .map((h) => ({ symbol: h.symbol, name: nameOf(h.symbol), amount: numberOrNull(h.amount), priceUsd: numberOrNull(h.priceUsd), valueUsd: numberOrNull(h.valueUsd) ?? 0 }))
          .sort((a, b) => b.valueUsd - a.valueUsd);
        const delegatedUsd = numberOrNull(delegated?.valueUsd) ?? 0;
        if (delegated && delegatedUsd >= DUST_USD) {
          rows.push({ symbol: delegated.symbol, name: nameOf(delegated.symbol), amount: numberOrNull(delegated.amount), priceUsd: numberOrNull(delegated.priceUsd), valueUsd: delegatedUsd });
        }
        const provider = delegated ? DELEGATED[delegated.symbol] : null;
        return {
          address: String(w.address || ""),
          name: isStrategy ? `${WALLET_NAME.strategy} ${strategy}` : WALLET_NAME.primary,
          note: provider ? (delegatedUsd >= DUST_USD ? `${provider} strategy account: ${fmtUsd(delegatedUsd)}` : `${provider} strategy account: empty`) : "",
          totalUsd: rows.reduce((s, r) => s + r.valueUsd, 0),
          rows,
        };
      });
    },
    walletsEmptyText() { return this.failed.sleeves ? "No data available" : "No wallets"; },
    /** @param {string} a */
    addrHref(a) { return /^0x[0-9a-fA-F]{40}$/.test(a) ? `https://basescan.org/address/${a}` : null; },
    shortAddr,
    /** @param {number | null} v @param {string} sym */
    amountLabel(v, sym) {
      if (v == null) return "—";
      if (sym === "ROBOTMONEY") return `${(v / 1e9).toFixed(2)}B`;
      if (v >= 1000) return Math.round(v).toLocaleString("en-US");
      return v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 4 : 2 });
    },
    /** @param {number | null} v */
    priceLabel(v) {
      if (v == null) return "—";
      return v < 0.01 ? `$${v.toPrecision(3)}` : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    },
    fmtUsd,

    // ── the history, on chain only ──────────────────────────────────────────
    history() {
      const h = Array.isArray(this.balances?.history) ? this.balances.history : [];
      return h.map((d) => {
        const byAsset = {};
        let total = 0;
        for (const [sym, v] of Object.entries(d?.byAsset || {})) {
          if (OFF_CHAIN.has(sym)) continue;
          const n = numberOrNull(v) ?? 0;
          byAsset[sym] = n;
          total += n;
        }
        return { date: String(d?.date || "").slice(0, 10), byAsset, total };
      }).filter((d) => d.date && d.total > 0).sort((a, b) => a.date.localeCompare(b.date));
    },
    // Every asset that reaches 1% of the treasury on some day, in ASSET_ORDER:
    // the chart's bands and the history table's columns.
    historyAssets() {
      const rows = Array.isArray(this.balances?.history) ? this.history() : [];
      const syms = new Set();
      for (const r of rows) for (const [s, v] of Object.entries(r.byAsset)) if (r.total && v / r.total >= 0.01) syms.add(s);
      const rank = (/** @type {string} */ s) => (ASSET_ORDER.indexOf(s) < 0 ? 99 : ASSET_ORDER.indexOf(s));
      return [...syms].sort((a, b) => rank(a) - rank(b));
    },

    // Value over time: the vault page's area (tvl-chart.js), the treasury's
    // total on each day. Gaps in the readings stay gaps.
    tvlPoints() { return this.history().map((d) => ({ t: `${d.date}T00:00:00Z`, tvlUsd: d.total })); },
    tvlAsOf() { return this.balances?.asOf ?? null; },
    tvlColor() { return "var(--color-green)"; },
    tvlName() { return "the treasury"; },
    tvlMark() { return ""; },
    // The By asset chart's ticks, so the two axes read alike and line up; laid
    // over this chart's own points, so the pointer still lights its date.
    tvlXTicks() {
      const pts = this.tvl().points;
      if (pts.length < 2) return [];
      return shareChartTicks(pts.map((p) => p.t.slice(0, 10)), pts.map((p) => p.x * 1000), monthDay);
    },
    tvlLabel() {
      const pts = this.tvl().points;
      if (!pts.length) return "";
      return `The treasury's value, ${fmtDate(pts[0].t)} to ${fmtDate(pts[pts.length - 1].t)}: ${fmtUsd(pts[0].value)} to ${fmtUsd(pts[pts.length - 1].value)}. Use the arrow keys to step through the readings.`;
    },
    historyEmptyTitle() {
      if (this.failed.balances) return "No data available";
      return this.history().length === 1 ? "Not enough data yet" : "No data yet";
    },
    // The change over the last 30 days, in dollars and as a share of where it
    // started. Fees paid in and tokens moving both count: it is the treasury's
    // value, not a return.
    change30d() {
      const rows = this.history();
      if (rows.length < 2) return null;
      const last = rows[rows.length - 1];
      const cutoff = Date.parse(`${last.date}T00:00:00Z`) - 30 * DAY_MS;
      const start = [...rows].reverse().find((r) => Date.parse(`${r.date}T00:00:00Z`) <= cutoff);
      if (!start || !start.total) return null;
      return { usd: last.total - start.total, pct: ((last.total - start.total) / start.total) * 100 };
    },
    // The value chart's whole span, start to end, signed as the 30-day change
    // is. The vault's TVL leaves out the percentage because deposits move it;
    // the treasury holds no depositors' money, so here the percentage reads true.
    tvlSpan() {
      const pts = this.tvl().points;
      if (pts.length < 2) return null;
      const a = pts[0];
      const b = pts[pts.length - 1];
      const usd = b.value - a.value;
      const sign = usd > 0 ? "+" : usd < 0 ? "−" : "";
      const pct = a.value ? ` (${sign}${Math.abs((usd / a.value) * 100).toFixed(1)}%)` : "";
      return {
        fromDate: fmtDate(a.t), from: fmtUsd(a.value),
        toDate: fmtDate(b.t), to: fmtUsd(b.value),
        delta: `${sign}${fmtUsd(Math.abs(usd))}${pct}`,
        cls: !usd ? "flat" : usd > 0 ? "up" : "down",
      };
    },
    change30dLabel() {
      const c = this.change30d();
      if (!c) return "—";
      const sign = c.usd > 0 ? "+" : c.usd < 0 ? "−" : "";
      return `${sign}${fmtUsd(Math.abs(c.usd))} (${sign}${Math.abs(c.pct).toFixed(1)}%)`;
    },
    change30dClass() {
      const c = this.change30d();
      return !c || !c.usd ? "flat" : c.usd > 0 ? "up" : "down";
    },

    // Composition over time: each asset's share, stacked to 100% (share-chart.js).
    posModel() {
      const rows = this.history();
      const syms = this.historyAssets();
      if (rows.length < 2 || !syms.length) return null;
      const series = syms.map((s) => ({ token: s, label: nameOf(s), color: this.hueOf(s), mark: "series", shares: rows.map((r) => (r.byAsset[s] || 0) / r.total) }));
      const other = rows.map((_, i) => Math.max(0, 1 - series.reduce((t, b) => t + b.shares[i], 0)));
      if (other.some((v) => v > 0.005)) series.push({ token: "other", label: "Other", color: "var(--color-border-light)", mark: "", shares: other });
      return { rows, series, xs: shareChartXs(rows.map((r) => r.date)) };
    },
    posSvg() {
      const m = this.posModel();
      return m ? shareChartSvg({ xs: m.xs, series: m.series }) : "";
    },
    posTicks() {
      const m = this.posModel();
      if (!m) return [];
      return shareChartTicks(m.rows.map((r) => r.date), m.xs, monthDay);
    },
    posLegend() {
      const m = this.posModel();
      return m ? m.series.map((b) => ({ token: b.token, label: b.label, color: b.color })) : [];
    },
    posLabel() {
      const m = this.posModel();
      if (!m) return "";
      const last = m.series.map((b) => `${b.label} ${fmtPctTrim((b.shares[b.shares.length - 1] || 0) * 100)}`).join(", ");
      return `Each asset's share of the treasury, stacked to 100%, ${fmtDate(m.rows[0].date)} to ${fmtDate(m.rows[m.rows.length - 1].date)}. Latest reading: ${last}. Use the arrow keys to step through the readings.`;
    },
    /** @param {number | null} i */
    posPoint(i) {
      const m = this.posModel();
      if (!m || i == null || !m.rows[i]) return null;
      return {
        left: m.xs[i] / 10,
        date: fmtDate(m.rows[i].date),
        total: fmtUsd(m.rows[i].total),
        items: m.series.filter((b) => (b.shares[i] || 0) >= 0.0005)
          .map((b) => ({ token: b.token, label: b.label, color: b.color, pct: fmtPctTrim((b.shares[i] || 0) * 100) })).reverse(),
      };
    },
    /** @param {PointerEvent} ev */
    posMove(ev) {
      const m = this.posModel();
      if (m) this.posAt = nearestReading(m.xs, /** @type {any} */ (ev));
    },
    /** @param {KeyboardEvent} ev */
    posKey(ev) {
      const m = this.posModel();
      if (!m) return;
      const last = m.rows.length - 1;
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const from = this.posAt ?? (ev.key === "ArrowRight" ? -1 : last + 1);
        this.posAt = Math.max(0, Math.min(last, from + (ev.key === "ArrowRight" ? 1 : -1)));
      } else if (ev.key === "Home") { ev.preventDefault(); this.posAt = 0; }
      else if (ev.key === "End") { ev.preventDefault(); this.posAt = last; }
      else if (ev.key === "Escape") { this.posAt = null; }
    },
    /** @param {HTMLElement} host */
    posSync(host) {
      for (const el of host.querySelectorAll("[data-token]")) {
        el.classList.toggle("is-muted", !!this.posFocus && el.getAttribute("data-token") !== this.posFocus);
      }
    },

    // ── the daily history table: newest first, ten to a page ────────────────
    historyRows() { return [...this.history()].reverse(); },
    historyPageRows() { return this.historyRows().slice(this.historyPage * HISTORY_PAGE, (this.historyPage + 1) * HISTORY_PAGE); },
    historyPaged() { return this.historyRows().length > HISTORY_PAGE; },
    historyRange() {
      const n = this.historyRows().length;
      const from = this.historyPage * HISTORY_PAGE + 1;
      return `${from}–${Math.min(n, from + HISTORY_PAGE - 1)} of ${n}`;
    },
    historyOlder() { return (this.historyPage + 1) * HISTORY_PAGE < this.historyRows().length; },
    /** @param {string} d */
    dayLabel(d) { return fmtDate(`${d}T00:00:00Z`); },
    /** @param {{ byAsset: Record<string, number> }} r @param {string} s */
    cellUsd(r, s) { return r.byAsset[s] ? fmtUsd(r.byAsset[s]) : "—"; },
    nameOf,

    // ── money in and out ────────────────────────────────────────────────────
    feesLifetimeLabel() { return fmtUsd(this.metrics?.feeIncome?.lifetimeUsd); },
    feesWethLabel() {
      const w = this.metrics?.feeIncome?.lifetimeWeth;
      return w == null ? "—" : `${w.toFixed(2)} WETH`;
    },
    feesRobotmoneyLabel() {
      const r = this.metrics?.feeIncome?.lifetimeRobotmoney;
      return r == null ? "—" : `${(r / 1e9).toFixed(2)}B`;
    },
    feesShareLabel() {
      const p = (this.metrics?.feeSplit ?? []).find((/** @type {{ label: string }} */ x) => x.label === "Protocol")?.pct;
      return p == null ? "—" : `${p}%`;
    },
    // Estimated (see the token page), so it reads as approximate.
    fees30dLabel() {
      const v = this.metrics?.feeIncome?.last30DaysUsd;
      return v == null ? "—" : `~${fmtUsd(v)}`;
    },
    buybackRows() {
      const r = this.buybacks?.rows;
      return Array.isArray(r) ? [...r].sort((a, b) => String(b.date).localeCompare(String(a.date))) : [];
    },
    buybackCountLabel() { return this.buybacks ? String(this.buybackRows().length) : "—"; },
    lastBuybackLabel() {
      const r = this.buybackRows()[0];
      return r ? fmtDate(`${String(r.date).slice(0, 10)}T00:00:00Z`) : "—";
    },
    buybackUsdLabel() { return fmtUsd(this.buybacks?.totals?.valueUsd); },
    buybackWethLabel() {
      const w = this.buybacks?.totals?.wethSpent;
      return w == null ? "—" : `${Number(w).toFixed(4)} WETH`;
    },
    // The WETH spent on buybacks against the WETH the fees have paid: the
    // same unit on both sides, so no price enters it.
    buybackOfFeesLabel() {
      const w = this.buybacks?.totals?.wethSpent;
      const f = this.metrics?.feeIncome?.lifetimeWeth;
      return w == null || !f ? "—" : fmtPctTrim((Number(w) / f) * 100);
    },
    buybackBoughtLabel() {
      const r = this.buybacks?.totals?.robotmoneyReceived;
      return r == null ? "—" : `${(Number(r) / 1e6).toFixed(2)}M`;
    },
  }));
}
