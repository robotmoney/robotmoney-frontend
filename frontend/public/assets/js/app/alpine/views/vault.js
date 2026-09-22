// Alpine factory for /vault/:slug, one vault's factsheet
// (docs/plans/vault-pages.md, views/vault.html).
//
// Every read goes through lib/vault-source.js: first the overview of all four
// vaults, so this vault's Recommended, Applied and Actual are the figures
// /allocation prints for it, then this vault's detail from the same source.
// Which source that is belongs to the mock-data switch (?vaults=devnet on a
// local host, documented in vault-source.js); the label it returns rides on
// every region that prints the source's figures.
//
// The overview's figures win over the detail's where both carry one, so the
// two pages cannot disagree about a vault. The detail adds what only it has:
// holdings, history, activity, flags, mechanics.
//
// No APY: the feed does not establish the net-of-fee treatment. No yield
// promise and no "principal-protected": the risk note is fixed text.
import {
  DETAIL_UNAVAILABLE,
  VAULT_UNAVAILABLE,
  loadLatestRecommendation,
  loadVaultDetail,
  loadVaultOverview,
  loadVaultSubjectFixture,
} from "../../lib/vault-source.js";
import { nearestReading, shareChartSvg, shareChartTicks, shareChartXs } from "../../lib/share-chart.js";
import { latestRecommendation } from "../latest-recommendation.js";
import { tvlChart } from "../tvl-chart.js";
import {
  canDeposit,
  explorerLink,
  fmtBps,
  fmtDate,
  fmtUsd,
  freshnessLabel,
  gapParts,
  hasTargetLayer,
  holdingsComplete,
  numberOrNull,
  receiptApplied,
  recommendationDate,
  recommendationHref,
  sleeveNote,
  statusLabel,
  VAULTS,
  vaultBySlug,
} from "../../lib/vault-data.js";
import { scrollToFragment } from "../../router.js";
import { sessionSummary } from "../../lib/session-summary.js";
import { sleeveExplorer } from "../../lib/sleeve-explorer.js";
import * as weightChange from "../../lib/weight-change.js";

/** @param {number | null} v */
const fmtPctOrDash = (v) => (v == null ? "—" : weightChange.fmtPctTrim(v));

const HOLDINGS_SHOWN = 8;
const ACTIVITY_PAGE = 10;
const KIND_LABEL = { adapter: "Lending venue", token: "Token", idle: "Idle" };
// What a lending venue and idle cash are held in: every vault takes USDC.
const DEPOSIT_ASSET = "USDC";
// An activity event as the feed names it, in the page's words. A kind this
// map does not know is printed in sentence case rather than as a raw enum.
const ACTIVITY_LABEL = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  withdraw: "Withdrawal",
  redeem: "Redemption",
  redemption: "Redemption",
};
const sentenceCase = (v) => {
  const s = String(v ?? "").replace(/[_-]+/g, " ").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
};
const ROUTER_NOTE = "Routes new deposits by the applied weights. Existing positions do not move.";

const shortAddress = (a) => {
  const s = String(a || "");
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};

// A fee or a guard is a small figure whose second decimal is the point
// (0.25%, not 0.3%): fmtBps rounds weights to one decimal.
const fmtBpsExact = (v) => {
  const n = numberOrNull(v);
  return n === null ? "—" : `${(n / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
};

const newestFirst = (a, b) => (Date.parse(b?.t) || 0) - (Date.parse(a?.t) || 0);


export function registerVaultView(Alpine) {
  // The ring's hover and focus (lib/sleeve-explorer.js) with one vault in
  // focus at rest: the page's own. Hovering or selecting another vault names
  // it in the centre, and letting go comes back to this one.
  Alpine.data("vaultAllocExplorer", (focusKey) => ({
    ...sleeveExplorer(),
    focusKey,
    active() { return this.pinned ?? this.hovered ?? this.focusKey; },
  }));
  Alpine.data("vaultView", () => ({
    slug: "",
    id: null,           // the vault's identity (lib/vault-data.js VAULTS)
    loading: true,
    error: null,
    load: null,         // loadVaultOverview()'s result: overview, source, label
    detail: null,
    detailError: null,
    showAllHoldings: false,
    activityPage: 0,
    posSnaps: null,     // the vault's positions over time, from the vault subject's book
    posAt: null,        // the positions reading under the crosshair
    posFocus: null,     // a position in focus from the legend

    fmtUsd,
    fmtDate,
    fmtBps,
    // The latest allocation recommendation, the panel /allocation sets beside
    // its ring (alpine/latest-recommendation.js).
    ...latestRecommendation(),
    ...tvlChart(),

    async init() {
      this.slug = String(location.pathname.split("/").filter(Boolean)[1] || "").toLowerCase();
      this.id = vaultBySlug(this.slug);
      if (!this.id) {
        this.error = VAULT_UNAVAILABLE;
        this.loading = false;
        return;
      }
      let load = null;
      // One read of the session list, for the panel and the overview alike.
      const recRead = loadLatestRecommendation({ hostname: location.hostname }).catch(() => ({ rec: null, error: true }));
      this.loadRecommendation(location.hostname, recRead);
      try {
        load = await loadVaultOverview({ hostname: location.hostname, recommendation: recRead });
      } catch (_) {
        load = null;
      }
      this.load = load;
      if (!load?.overview) {
        this.error = load?.error || VAULT_UNAVAILABLE;
        this.loading = false;
        return;
      }
      // A vault that is not live has no holdings, history or activity to read.
      if (this.isLive()) {
        try {
          const r = await loadVaultDetail(this.slug, load);
          this.detail = r.detail;
          this.detailError = r.error;
        } catch (_) {
          this.detailError = DETAIL_UNAVAILABLE;
        }
        // Its positions over time are the vault subject's book, each position
        // tagged with its vault: the devnet fixture's, and nothing on Base,
        // whose feed reads one day and keeps no position history.
        if (load.mode === "devnet") {
          const fixture = await loadVaultSubjectFixture({ hostname: location.hostname }).catch(() => null);
          this.posSnaps = fixture?.snapshots ?? null;
        }
      }
      this.loading = false;
      // The sections draw only now, so a deep link (#holdings) that the router
      // could not reach at render time lands here.
      this.$nextTick(() => scrollToFragment());
    },

    // ── the vault as read ────────────────────────────────────────────────────
    overview() {
      return this.load?.overview ?? null;
    },
    network() {
      return this.overview()?.network ?? null;
    },
    row() {
      return this.overview()?.vaults?.find((v) => v.slug === this.slug) ?? null;
    },
    record() {
      const row = this.row();
      if (!row) return null;
      if (!this.detail || this.detail === row) return row;
      return { ...this.detail, ...row, flags: this.detail.flags ?? row.flags ?? null };
    },
    isLive() {
      return this.row()?.availability === "live";
    },
    // The read failed: the vault may well be live, and nothing it holds is known.
    isUnreadable() {
      return this.row()?.availability === "unavailable";
    },
    dataLabel() {
      return this.load?.label ?? null;
    },
    lede() {
      return sleeveNote(this.id?.key);
    },

    // ── facts ────────────────────────────────────────────────────────────────
    networkLabel() {
      return this.network()?.label || "—";
    },
    // A vault taking deposits is Live, and one not deployed on this network is
    // Coming soon (the Network fact beside it names the network). Every other
    // state is its own word: Paused, Deposits paused, Data unavailable.
    status() {
      const r = this.record();
      if (r?.availability === "not_on_network") return "Coming soon";
      const s = statusLabel(r, this.network()?.label);
      return s === "Active" ? "Live" : s;
    },
    sharePrice() {
      const n = numberOrNull(this.record()?.sharePrice);
      return n === null ? null : `$${n.toFixed(4)}`;
    },
    readLabel() {
      return freshnessLabel(this.overview());
    },
    contractHref() {
      return explorerLink(this.network(), this.record()?.address);
    },
    contractLabel() {
      return shortAddress(this.record()?.address);
    },

    // ── holdings ─────────────────────────────────────────────────────────────
    holdings() {
      const h = this.record()?.holdings;
      return Array.isArray(h) ? h : [];
    },
    showsHoldings() {
      return this.isLive() && !this.detailError && this.holdings().length > 0;
    },
    visibleHoldings() {
      const h = this.holdings();
      return this.showAllHoldings ? h : h.slice(0, HOLDINGS_SHOWN);
    },
    moreHoldings() {
      return this.holdings().length > HOLDINGS_SHOWN;
    },
    // Bars only for a complete set of weights; otherwise the figures alone.
    holdingsBars() {
      return holdingsComplete(this.holdings());
    },
    holdingHref(h) {
      return explorerLink(this.network(), h?.address);
    },
    holdingType(h) {
      return h?.venueType || KIND_LABEL[h?.kind] || "—";
    },
    // A position's size in its own unit: a lending venue and idle cash hold
    // the deposit asset, a token position its token. "—" when the source
    // reports a value and no amount.
    holdingAmount(h) {
      const n = numberOrNull(h?.balance);
      if (n === null) return "—";
      const unit = h?.kind === "adapter" || h?.kind === "idle" ? DEPOSIT_ASSET : String(h?.symbol || "");
      const digits = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 6;
      return `${n.toLocaleString("en-US", { maximumFractionDigits: digits })}${unit ? ` ${unit}` : ""}`;
    },
    shareWidth(v) {
      const n = numberOrNull(v);
      return n === null ? 0 : Math.max(0, Math.min(100, n / 100));
    },
    // Only when the positions were read on a different day from the rest.
    holdingsDate() {
      const held = this.record()?.holdingsAsOf;
      if (!held) return null;
      const o = this.overview();
      const read = o?.freshness?.indexedAt ?? o?.asOf;
      return fmtDate(held) !== fmtDate(read) ? fmtDate(held) : null;
    },

    // ── allocation ───────────────────────────────────────────────────────────
    // Three layers once there is a target (the router's weights, else the
    // published policy's, RM-115); without one Recommended and Actual, and
    // the one gap between them.
    threeLayers() {
      return hasTargetLayer(this.overview());
    },
    // ── the allocation, as a ring ────────────────────────────────────────────
    // The ring every allocation view draws: each vault at its share of the
    // four vaults' combined TVL, set against the target in force (the
    // recommendation, when there is no target to read), and the gap in
    // points, this vault in focus: the /allocation ring's gap. The vault subject's By vault ring, read
    // from this vault.
    explorerRows() {
      const o = this.overview();
      const three = this.threeLayers();
      const pp = (v) => { const n = numberOrNull(v); return n === null ? null : n / 100; };
      return VAULTS.map((v) => {
        const r = o?.vaults?.find((x) => x.slug === v.slug) ?? null;
        const gap = numberOrNull(three ? r?.gaps?.flow : r?.gaps?.total);
        return {
          key: v.slug, label: v.symbol, hue: v.color, meta: "", assets: [],
          pct: pp(r?.actualBps),
          was: pp(three ? r?.targetBps : r?.recommendedBps),
          d: gap === null ? null : Math.round(gap) / 100,
        };
      });
    },
    explorerSvg() {
      return sessionSummary.ringSvg(this.explorerRows().map((r) => ({ ...r, pct: r.pct ?? 0, colour: r.hue })));
    },
    explorerLabel() {
      return this.explorerRows().map((r) => `${r.label} ${fmtPctOrDash(r.pct)}`).join(", ");
    },
    // Named apart from the explorer's own legendBasis(), which the nested
    // component would otherwise answer first.
    allocBasis() { return this.threeLayers() ? "Target" : "Recommended"; },
    // Actual against the target is drift (RM-97); against a recommendation,
    // with no target to read, it is only a gap.
    gapName() { return this.threeLayers() ? "Drift" : "Gap"; },
    hasBook() { return false; },
    fmtPctTrim(v) { return weightChange.fmtPctTrim(v); },
    changeClass(d) { return weightChange.changeClass(d); },
    changeLabel(d) { return weightChange.changeLabel(d); },
    // What the legend does not carry, once there is a target: this vault's
    // recommended weight and the governance gap between it and the target.
    pipelineFacts() {
      if (!this.threeLayers()) return [];
      const r = this.row();
      return [
        { key: "recommended", name: "Recommended", value: fmtBps(r?.recommendedBps) },
        { key: "governance", name: "Governance gap", part: gapParts(r?.gaps?.governance) },
      ];
    },
    recommendation() {
      return this.overview()?.recommendation ?? null;
    },
    recommendationDate() {
      const d = recommendationDate(this.recommendation());
      return d ? fmtDate(d) : null;
    },
    recommendationHref() {
      return recommendationHref(this.recommendation());
    },
    // linked: a date that opens its session; date: a date with no record to
    // open; none: the source answered with no recommendation; unknown: it
    // could not be read.
    recState() {
      const rec = this.recommendation();
      if (!rec) return this.load?.recommendationError ? "unknown" : "none";
      if (!this.recommendationDate()) return "unknown";
      return this.recommendationHref() ? "linked" : "date";
    },
    released() {
      const v = this.recommendation()?.releasedOnChain;
      return typeof v === "boolean" ? (v ? "Yes" : "No") : null;
    },
    routerLive() {
      return this.overview()?.router?.availability === "live";
    },
    // null when the source reports no router weights at all (the Base feed,
    // where no router exists), so the disclosure is left out; [] when it
    // answered with none.
    routerWeights() {
      const w = this.record()?.history?.weights;
      return Array.isArray(w) ? [...w].sort(newestFirst) : null;
    },
    // Only with a live router, and only when the source serves the field (or
    // the detail failed, which the disclosure then says).
    showRouterWeights() {
      return this.routerLive() && (this.routerWeights() !== null || !!this.detailError);
    },
    // null when the source reports no receipts at all (the Base feed), so the
    // disclosure is left out rather than contradicting the Recommendation row.
    receipts() {
      const h = this.record()?.history;
      if (!Array.isArray(h?.receipts)) return null;
      const weights = Array.isArray(h.weights) ? h.weights : [];
      return h.receipts.map((r) => ({ ...r, applied: receiptApplied(r, weights) })).sort(newestFirst);
    },
    // One recommendation is the Recommendation row already: the list opens
    // only once there is an earlier one to read.
    showReceipts() {
      return (this.receipts()?.length ?? 0) > 1;
    },

    // ── history ──────────────────────────────────────────────────────────────
    // Whether the source serves the series at all. The Base feed never does,
    // so its vault page has no History section rather than a permanent empty
    // one; a source that answers with no readings says so.
    hasHistory() {
      return Array.isArray(this.record()?.history?.tvl);
    },
    // The TVL chart (alpine/tvl-chart.js) reads the vault's own series.
    tvlPoints() { return this.record()?.history?.tvl ?? []; },
    tvlAsOf() { return this.overview()?.asOf; },
    tvlColor() { return this.id?.color ?? ""; },
    tvlName() { return this.id?.symbol ?? "the vault"; },

    // ── activity ─────────────────────────────────────────────────────────────
    // As hasHistory(): the Base feed serves no activity.
    hasActivity() {
      return Array.isArray(this.record()?.activity);
    },
    activityKind(a) {
      const k = String(a?.kind ?? "");
      return ACTIVITY_LABEL[k.toLowerCase()] || sentenceCase(k) || "—";
    },
    activity() {
      const a = this.record()?.activity;
      return Array.isArray(a) ? [...a].sort(newestFirst) : [];
    },
    activityRows() {
      return this.activity().slice(this.activityPage * ACTIVITY_PAGE, (this.activityPage + 1) * ACTIVITY_PAGE);
    },
    activityPaged() {
      return this.activity().length > ACTIVITY_PAGE;
    },
    activityRange() {
      const n = this.activity().length;
      const from = this.activityPage * ACTIVITY_PAGE + 1;
      return `${from}–${Math.min(n, from + ACTIVITY_PAGE - 1)} of ${n}`;
    },
    activityOlder() {
      return (this.activityPage + 1) * ACTIVITY_PAGE < this.activity().length;
    },
    // What moved, in the vault's own token, and its value: a deposit or a
    // withdrawal is the USDC that went in or out, at $1.
    activityAmount(a) {
      const n = numberOrNull(a?.shares);
      return n === null ? "—" : `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${this.id?.symbol || ""}`.trim();
    },
    activityValue(a) {
      const n = numberOrNull(a?.assets);
      return n === null ? "—" : fmtUsd(n);
    },

    // ── positions over time ──────────────────────────────────────────────────
    // Each position's share of the vault, stacked to 100%, the chart the
    // subject pages draw (lib/share-chart.js). Bands are tints of the vault's
    // own hue: its other hues are the other vaults', in the ring below.
    posRows() {
      const snaps = Array.isArray(this.posSnaps) ? this.posSnaps : [];
      return snaps.map((sn) => {
        const positions = (sn?.positions || []).filter((p) => p?.vault === this.slug);
        const total = positions.reduce((s, p) => s + (Number(p?.value_usd) || 0), 0);
        return { date: String(sn?.date || "").slice(0, 10), total, positions };
      }).filter((r) => r.date && r.total > 0);
    },
    posSeries() {
      const rows = this.posRows();
      if (rows.length < 2) return [];
      const share = (/** @type {any} */ r, /** @type {string} */ tok) => {
        const hit = r.positions.find((/** @type {any} */ p) => p.token === tok);
        return hit ? (Number(hit.value_usd) || 0) / r.total : 0;
      };
      const last = rows[rows.length - 1];
      const names = new Map();
      for (const r of rows) for (const p of r.positions) if (!names.has(p.token)) names.set(p.token, p.name || p.token);
      // Largest in the latest reading first, and only what reaches 1% at some
      // point: a sliver no reader can see still spends a tint and a legend row.
      const tokens = [...names.keys()]
        .filter((t) => rows.some((r) => share(r, t) >= 0.01))
        .sort((a, b) => share(last, b) - share(last, a));
      const TINTS = [92, 62, 40, 24, 14, 8];
      const hue = this.id?.color || "var(--color-text-muted)";
      const bands = tokens.slice(0, TINTS.length).map((t, i) => ({
        token: t,
        label: names.get(t),
        color: `color-mix(in srgb, ${hue} ${TINTS[i]}%, var(--color-void))`,
        shares: rows.map((r) => share(r, t)),
      }));
      const other = rows.map((_, i) => Math.max(0, 1 - bands.reduce((s, b) => s + b.shares[i], 0)));
      if (other.some((v) => v > 0.005)) bands.push({ token: "other", label: "Other", color: "var(--color-border-light)", shares: other });
      return bands;
    },
    posModel() {
      const rows = this.posRows();
      const series = this.posSeries();
      if (rows.length < 2 || !series.length) return null;
      return { rows, series, xs: shareChartXs(rows.map((r) => r.date)) };
    },
    posSvg() {
      const m = this.posModel();
      return m ? shareChartSvg({ xs: m.xs, series: m.series }) : "";
    },
    posSpan() {
      const n = this.posRows().length;
      return n > 1 ? `${n} readings` : "";
    },
    posEmptyLabel() { return this.posRows().length === 1 ? "One reading so far" : "No position history yet"; },
    posTicks() {
      const m = this.posModel();
      if (!m) return [];
      const md = (/** @type {unknown} */ d) => {
        try { return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); } catch (_) { return String(d); }
      };
      return shareChartTicks(m.rows.map((r) => r.date), m.xs, (d) => md(d));
    },
    posLegend() {
      return this.posSeries().map((b) => ({ token: b.token, label: b.label, color: b.color }));
    },
    posLabel() {
      const m = this.posModel();
      if (!m) return "";
      const named = m.series.map((b) => `${b.label} ${weightChange.fmtPctTrim((b.shares[b.shares.length - 1] || 0) * 100)}`).join(", ");
      return `Each position's share of ${this.id?.symbol || "the vault"}, stacked to 100%, ${fmtDate(m.rows[0].date)} to ${fmtDate(m.rows[m.rows.length - 1].date)}. Latest reading: ${named}. Use the arrow keys to step through the readings.`;
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
          .map((b) => ({ token: b.token, label: b.label, color: b.color, pct: weightChange.fmtPctTrim((b.shares[i] || 0) * 100) })).reverse(),
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
    // A band in focus from the legend: the others recede.
    /** @param {Element} host */
    posSync(host) {
      for (const el of host.querySelectorAll("[data-token]")) {
        el.classList.toggle("is-muted", this.posFocus !== null && el.getAttribute("data-token") !== this.posFocus);
      }
    },
    txHref(a) {
      return explorerLink(this.network(), a?.tx, "tx");
    },
    // The Transaction column goes when no row has one to link.
    activityHasTx() {
      return this.activity().some((a) => this.txHref(a));
    },
    shortHash(v) {
      return shortAddress(v);
    },

    // ── mechanics and risk ───────────────────────────────────────────────────
    // Only what the source states. Pauses are the Status fact and are not
    // repeated here; the vault's own address is the Contract fact.
    mechanics() {
      const r = this.record() || {};
      const rows = [];
      const m = r.mechanics || null;
      if (typeof m?.redeemOnly === "boolean") rows.push({ k: "Withdrawals", v: m.redeemOnly ? "Redeem only" : "Withdraw or redeem" });
      if (numberOrNull(r.exitFeeBps) !== null) rows.push({ k: "Exit fee", v: fmtBpsExact(r.exitFeeBps) });
      if (this.overview()?.router?.availability === "live") rows.push({ k: "Router", v: ROUTER_NOTE });
      const venues = Array.isArray(m?.venues) ? m.venues.filter(Boolean).map(String) : [];
      if (venues.length && !this.showsHoldings()) rows.push({ k: "Venues", v: venues.join(", ") });
      const g = r.guards || null;
      if (numberOrNull(g?.navDeviationGuardBps) !== null) rows.push({ k: "NAV deviation guard", v: fmtBpsExact(g.navDeviationGuardBps) });
      if (typeof g?.oracleFresh === "boolean") rows.push({ k: "Oracle", v: g.oracleFresh ? "Fresh" : "Stale" });
      const c = r.caps || null;
      if (numberOrNull(c?.tvlCap) !== null) rows.push({ k: "TVL cap", v: fmtUsd(c.tvlCap) });
      if (numberOrNull(c?.perDepositCap) !== null) rows.push({ k: "Per-deposit cap", v: fmtUsd(c.perDepositCap) });
      if (r.auditStatus) rows.push({ k: "Audit", v: String(r.auditStatus) });
      return rows;
    },
    contractLinks() {
      const c = this.record()?.contracts || {};
      return [["Router", c.router], ["Registry", c.registry]]
        .map(([label, a]) => ({ label, address: a, href: explorerLink(this.network(), a), text: `${label} ${shortAddress(a)}` }))
        .filter((x) => x.href);
    },

    // ── deposit ──────────────────────────────────────────────────────────────
    canDepositHere() {
      const r = this.record();
      return canDeposit(r, this.network(), r?.flags);
    },
  }));
}
