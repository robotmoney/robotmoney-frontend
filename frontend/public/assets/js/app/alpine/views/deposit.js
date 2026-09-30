// Alpine factory for /deposit (views/deposit.html, RM-146): what a depositor
// asks before depositing. How a deposit works, what it buys, what they hold,
// what it earns, how liquid it is, and what can go wrong, read from the same
// sources as the allocation and vault pages so the three cannot disagree.
//
// The reads, each settling on its own so one degraded feed leaves only its
// own part of the page on "—":
//   the policy    lib/allocation-framework.js loadAllocationDto(): the four
//                 sleeve targets and their constituents, the recipe
//                 /allocation draws. What a deposit buys.
//   the vaults    lib/vault-source.js loadVaultOverview(): status, TVL, share
//                 price and the target in force per vault, then each live
//                 vault's detail for where its USDC sits. The mock-data switch
//                 (?vaults=devnet on a local host) moves this page with the
//                 others, and its label rides on the sections it feeds.
//   the registry  lib/vault-data.js VAULTS[].onBase and contractNetworks():
//                 what each deployed contract sets (exit fee, caps, venues,
//                 admin, audit) and where it is.
//   the simulator each sleeve's daily index over the last year. No endpoint
//                 serves one yet, so production shows the empty chart; a
//                 local host reads a synthetic series (SIM_FIXTURE), labelled
//                 "Illustrative data", to review the layout against.
//
// A vault goes live by data: an overview that says so and a registry entry
// with its address. Nothing here names a vault.
import { CATEGORICAL } from "../../lib/chart-theme.js";
import { loadAllocationDto } from "../../lib/allocation-framework.js";
import { loadVaultDetail, loadVaultOverview, VAULT_UNAVAILABLE } from "../../lib/vault-source.js";
import {
  VAULTS,
  contractNetworks,
  explorerLink,
  fmtDate,
  fmtUsd,
  hasTargetLayer,
  isLocalHost,
  numberOrNull,
  sleeveNote,
  statusLabel,
  vaultForBucket,
} from "../../lib/vault-data.js";
import { dateTicks, lineChartSvg, nearestSample, yScale } from "../../lib/line-chart.js";
import { sessionSummary, bucketLabel, bucketShort } from "../../lib/session-summary.js";
import { scrollToFragment } from "../../router.js";
import * as weightChange from "../../lib/weight-change.js";

const BASE = { chainId: 8453 };
const SIM_FIXTURE = "/data/deposit/simulation-illustrative.json";
const PERIODS = [
  { id: "1m", label: "1M", days: 30 },
  { id: "3m", label: "3M", days: 91 },
  { id: "6m", label: "6M", days: 182 },
  { id: "1y", label: "1Y", days: 365 },
];
const AMOUNTS = [100, 1000, 5000];
// The returns table's horizons, in days back from the latest reading.
const HORIZONS = [
  { id: "24h", label: "24H", days: 1 },
  { id: "7d", label: "7D", days: 7 },
  { id: "30d", label: "30D", days: 30 },
  { id: "6m", label: "6M", days: 182 },
  { id: "1y", label: "1Y", days: 365 },
];
// The benchmark's line: a hue of its own, after the four sleeves' (teal).
const BENCH_COLOUR = CATEGORICAL[5];

// A fee is a small figure whose second decimal is the point (0.25%, not 0.3%).
/** @param {unknown} v */
const fmtBpsExact = (v) => {
  const n = numberOrNull(v);
  return n === null ? null : `${(n / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
};
/** @param {unknown} a */
const shortAddress = (a) => {
  const s = String(a || "");
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};
// "A, B and C".
/** @param {string[]} xs */
const listed = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
// Dollars to the cent under $1,000, whole dollars above.
/** @param {number | null} v */
const usd = (v) => {
  if (v === null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = a < 1000 ? a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(a).toLocaleString("en-US");
  return `${v < 0 ? "−" : ""}$${s}`;
};
// A signed move, glyph first: "+$48.20", "−$12".
/** @param {number | null} v */
const signedUsd = (v) => (v === null ? "—" : `${v >= 0 ? "+" : "−"}${usd(Math.abs(v))}`);
/** @param {number | null} v */
const signedPct = (v) => (v === null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`);
/** @param {number} i */
const sleeveColour = (i) => CATEGORICAL[i % CATEGORICAL.length];
/** @param {string} start @param {number} i */
const dayAt = (start, i) => new Date(Date.parse(start + "T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);

// Where a sleeve's return comes from: interest for lending, prices for the
// token sleeves. Keyed on the allocation's bucket key.
/** @type {Record<string, string>} */
const EARNS = {
  "defi-yield": "Interest from lending USDC. It accrues in the share price, so the token count stays the same and each token is worth more USDC.",
  "agent-tokens": "The prices of the agent tokens the vault holds. No interest.",
  "protocol-tokens": "The prices of the large-cap crypto assets the vault holds. No interest.",
  rwa: "The prices of the tokenised equity index and commodity the vault holds. No interest.",
};

export function registerDepositView(Alpine) {
  Alpine.data("depositView", () => ({
    fw: null,        // loadAllocationDto(): GET /api/dashboards/allocation
    load: null,      // loadVaultOverview(): { overview, source, label, error }
    details: {},     // live vaults' details, by slug
    sim: null,       // the simulator's series, or null
    simLabel: null,  // "Illustrative data" when the series is the fixture
    loading: true,
    amount: 1000,
    period: "1y",
    simAt: null,     // the chart's crosshair, as an index into the drawn days
    periods: PERIODS,
    amounts: AMOUNTS,
    horizons: HORIZONS,
    benchColour: BENCH_COLOUR,

    async init() {
      const host = location.hostname;
      const policyRead = loadAllocationDto(host).catch(() => null);
      const policy = policyRead.then((d) => { this.fw = d ?? null; });
      const vaults = loadVaultOverview({ hostname: host, recommendation: false, policy: policyRead })
        .catch(() => ({ overview: null, label: null, error: VAULT_UNAVAILABLE }))
        .then(async (r) => {
          this.load = r;
          const live = (r?.overview?.vaults ?? []).filter((v) => v.availability === "live");
          const got = await Promise.all(live.map((v) => loadVaultDetail(v.slug, r)));
          this.details = Object.fromEntries(live.map((v, i) => [v.slug, got[i]?.detail ?? null]));
        });
      const sim = isLocalHost(host)
        ? fetch(SIM_FIXTURE).then((x) => (x.ok ? x.json() : null)).then((d) => {
          if (Array.isArray(d?.sleeves) && d.start) { this.sim = d; this.simLabel = d.illustrative ? "Illustrative data" : null; }
        }).catch(() => {})
        : Promise.resolve();
      await Promise.allSettled([policy, vaults, sim]);
      this.loading = false;
      // The figures above #contracts fill in only now, so a deep link the
      // router scrolled to at render lands again.
      this.$nextTick(() => this.openFragment());
    },
    // A FAQ row opens and closes by animating its answer's height (and
    // fades it), rather than the native details' jump: opening sets `open`
    // and grows the answer from 0; closing shrinks it, then clears `open`.
    // A click mid-animation reverses from where the row is. Reduced motion,
    // or no Web Animations, toggles at once.
    toggleFaq(ev) {
      const d = ev.currentTarget?.parentElement;
      const a = d?.querySelector(".dp__faq-a");
      if (!(d instanceof HTMLDetailsElement) || !a) return;
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      const closing = d.open && d.dataset.faq !== "closing";
      if (reduce || typeof a.animate !== "function") { d.open = !closing; return; }
      // A closed row still measures its full answer, so an opening one
      // starts from nothing unless it is reversing a close. The padding
      // animates with the height, or the row would stop at its padding.
      const midway = !!d.dataset.faq;
      const from = midway || d.open ? a.getBoundingClientRect().height : 0;
      const pad = getComputedStyle(a).paddingBottom;
      a.getAnimations().forEach((x) => x.cancel());
      d.open = true;
      const full = a.scrollHeight;
      const at = (h) => ({ height: `${h}px`, paddingBottom: h ? pad : "0px", opacity: full ? Math.min(1, h / full) : 1 });
      d.dataset.faq = closing ? "closing" : "opening";
      const anim = a.animate([at(from), at(closing ? 0 : full)], { duration: closing ? 200 : 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
      anim.onfinish = () => {
        if (closing) d.open = false;
        delete d.dataset.faq;
      };
    },
    // A link to a FAQ row (#risks, #contracts) opens it, then lands on it.
    openFragment() {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      if (el instanceof HTMLDetailsElement) el.open = true;
      scrollToFragment();
    },

    // ── the read ────────────────────────────────────────────────────────────
    overview() { return this.load?.overview ?? null; },
    // "Devnet test data", "Saved Base snapshot", or none.
    dataLabel() { return this.overview() ? this.load?.label ?? null : null; },
    record(slug) { return this.overview()?.vaults?.find((r) => r.slug === slug) ?? null; },
    isLive(slug) { return this.record(slug)?.availability === "live"; },
    networkLabel() { return this.overview()?.network?.label || "Base"; },

    // ── the facts row ───────────────────────────────────────────────────────
    tvlLabel() { return fmtUsd(numberOrNull(this.overview()?.combined?.tvlUsd)); },
    vaultsLiveLabel() {
      const n = this.overview()?.combined?.vaultsLive;
      return typeof n === "number" ? `${n} of ${VAULTS.length}` : "—";
    },
    exitFeeLabel() {
      const fees = this.liveVaults().map((v) => fmtBpsExact(this.record(v.slug)?.exitFeeBps)).filter(Boolean);
      return fees.length && fees.every((f) => f === fees[0]) ? fees[0] : fees.length ? "By vault" : "—";
    },

    // ── what you buy: the policy's sleeves and their constituents ───────────
    // Each sleeve at the target in force, which is what a deposit is split
    // by: the router's applied weights once it reports them, else the
    // published policy's (normalizeOverview decides, as on /allocation's
    // Vaults table). The constituents are always the policy's recipe.
    sleeves() {
      const buckets = this.fw?.buckets || [];
      const strategy = this.fw?.strategy || [];
      const inForce = hasTargetLayer(this.overview());
      return buckets.map((b, i) => {
        const bps = inForce ? numberOrNull(this.record(vaultForBucket(b.key)?.slug ?? "")?.targetBps) : null;
        return {
          key: b.key,
          name: bucketLabel(b.label || strategy[i]?.label || b.key),
          target: bps !== null ? bps / 100 : Number(strategy[i]?.targetPct ?? 0),
          items: (b.items || []).map((it) => ({ label: it.label, target: Number(it.targetPct ?? 0) })),
        };
      });
    },
    hasTargets() { return this.sleeves().length > 0; },
    // Since when: the router's last application, else the policy's date.
    allocationAsOfLabel() {
      const o = this.overview();
      const when = o?.targetSource === "router" ? o?.router?.appliedAt : this.fw?.asOf;
      const d = when ? fmtDate(when) : "—";
      return d === "—" ? null : d;
    },
    // The ring and legend every weights page draws (lib/sleeve-explorer.js),
    // target only: where the money is against it is /allocation's.
    explorerRows() {
      return this.sleeves().map((s, i) => ({
        key: s.key, label: s.name, hue: sleeveColour(i), pct: s.target, meta: "",
        assets: s.items.map((c, j) => ({
          key: `${s.key}-${c.label}`, label: c.label, colour: sleeveColour(j),
          ofSleeve: c.target, ofAllocation: (c.target * s.target) / 100,
        })),
      }));
    },
    explorerSvg() { return sessionSummary.ringSvg(this.explorerRows().map((r) => ({ ...r, colour: r.hue }))); },
    explorerLabel() { return this.explorerRows().map((r) => `${r.label} ${this.fmtPctTrim(r.pct)}`).join(", "); },
    ringRestLabel() { return "Allocation"; },
    hasActual() { return false; },
    hasBook() { return false; },
    bucketNote(key) { return sleeveNote(key); },
    bucketShort(name) { return bucketShort(name); },
    fmtPctTrim(v) { return weightChange.fmtPctTrim(v); },
    vaultHref(key) { const v = vaultForBucket(key); return v ? `/vault/${v.slug}` : null; },
    vaultSymbol(key) { return vaultForBucket(key)?.symbol ?? ""; },
    vaultStatus(key) { const v = vaultForBucket(key); return v ? this.vaultState(v.slug) : ""; },
    // "Live", "Coming soon", or the state's own word; "—" before the read.
    vaultState(slug) {
      if (!this.overview()) return "—";
      const r = this.record(slug);
      if (r?.availability === "not_on_network") return "Coming soon";
      const s = statusLabel(r, this.networkLabel());
      return s === "Active" ? "Live" : s;
    },

    // ── what you hold: one token per vault ──────────────────────────────────
    tokenRows() {
      return VAULTS.map((v) => {
        const r = this.record(v.slug);
        const address = r?.address ?? v.baseAddress ?? null;
        const price = this.isLive(v.slug) ? numberOrNull(r?.sharePrice) : null;
        return {
          slug: v.slug, symbol: v.symbol, name: v.name, color: v.color,
          href: `/vault/${v.slug}`,
          status: this.vaultState(v.slug),
          live: this.isLive(v.slug),
          sharePrice: price === null ? "—" : price.toFixed(4),
          address,
          short: address ? shortAddress(address) : null,
          addressHref: address ? explorerLink(BASE, address) : null,
        };
      });
    },

    // ── what it earns ───────────────────────────────────────────────────────
    earnRows() {
      return this.sleeves().map((s, i) => {
        const v = vaultForBucket(s.key);
        let text = EARNS[s.key] ?? "";
        const venues = v?.onBase?.venues ?? [];
        if (s.key === "defi-yield" && venues.length) text = text.replace("lending USDC", `lending USDC on ${listed(venues)}`);
        return { key: s.key, name: s.name, hue: sleeveColour(i), symbol: v?.symbol ?? "", text };
      });
    },

    // ── the simulator ───────────────────────────────────────────────────────
    // A deposit split by the target in force on the first day, each part
    // following its sleeve's index, as a deposit does: new money is routed,
    // positions are not rebalanced. Each vault's exit fee comes off the value
    // today, where the registry has one.
    hasSim() { return !!this.sim && this.hasTargets(); },
    amountValue() {
      const n = Number(String(this.amount).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0;
    },
    setAmount(v) { this.amount = v; },
    fmtAmount(v) { return `$${Number(v).toLocaleString("en-US")}`; },
    periodDays() { return PERIODS.find((p) => p.id === this.period)?.days ?? 365; },
    // The window's day indices into the series: its last day is the series'.
    _window() {
      const n = Math.min(...(this.sim?.sleeves ?? []).map((s) => s.index.length));
      if (!Number.isFinite(n) || n < 2) return null;
      const from = Math.max(0, n - 1 - this.periodDays());
      return { from, to: n - 1, n: n - from };
    },
    _legs() {
      const w = this._window();
      if (!w) return [];
      const idx = Object.fromEntries((this.sim?.sleeves ?? []).map((s) => [s.key, s.index]));
      const amount = this.amountValue();
      return this.sleeves().filter((s) => s.target > 0 && idx[s.key]).map((s) => {
        const series = idx[s.key];
        const base = series[w.from];
        const put = (amount * s.target) / 100;
        const fee = numberOrNull(vaultForBucket(s.key)?.onBase?.exitFeeBps) ?? 0;
        const values = series.slice(w.from, w.to + 1).map((x) => (put * x) / base);
        return { key: s.key, name: s.name, target: s.target, put, values, fee, net: values[values.length - 1] * (1 - fee / 10000) };
      });
    },
    // The benchmark: the same amount parked in one lending market, over the
    // same window, after nothing (the market charges no exit fee).
    bench() { const b = this.sim?.benchmark; return b && Array.isArray(b.index) ? b : null; },
    benchLabel() { return this.bench()?.label ?? ""; },
    _benchValues() {
      const b = this.bench();
      const w = this._window();
      if (!b || !w || b.index.length <= w.to) return [];
      const base = b.index[w.from];
      const amount = this.amountValue();
      return b.index.slice(w.from, w.to + 1).map((x) => (amount * x) / base);
    },
    benchResult() {
      const v = this._benchValues();
      if (!v.length) return null;
      const put = this.amountValue();
      const last = v[v.length - 1];
      return { value: usd(last), gain: signedUsd(last - put), pct: signedPct(put ? ((last - put) / put) * 100 : null), up: last >= put };
    },
    // Each sleeve's return over each horizon, the deposit's (split by the
    // target in force at the start and not rebalanced, before the exit
    // fee), and the benchmark's. A horizon longer than the series is "—".
    returnRows() {
      const series = Object.fromEntries((this.sim?.sleeves ?? []).map((x) => [x.key, x.index]));
      const ret = (/** @type {number[] | undefined} */ xs, /** @type {number} */ d) => {
        if (!xs || xs.length <= d) return null;
        const a = xs[xs.length - 1 - d], b = xs[xs.length - 1];
        return a ? (b / a - 1) * 100 : null;
      };
      const cell = (/** @type {number | null} */ v) => ({ v: signedPct(v), cls: v === null ? "is-zero" : v >= 0 ? "is-up" : "is-down" });
      const sleeves = this.sleeves();
      const rows = sleeves.map((s, i) => ({
        key: s.key, kind: "sleeve", name: s.name, hue: sleeveColour(i), weight: this.fmtPctTrim(s.target), zero: !s.target,
        cells: HORIZONS.map((h) => cell(ret(series[s.key], h.days))),
      }));
      const funded = sleeves.filter((s) => s.target > 0 && series[s.key]);
      const total = funded.reduce((t, s) => t + s.target, 0);
      const mix = (/** @type {number} */ d) => {
        if (!total) return null;
        const parts = funded.map((s) => ({ w: s.target / total, r: ret(series[s.key], d) }));
        return parts.some((p) => p.r === null) ? null : parts.reduce((t, p) => t + p.w * p.r, 0);
      };
      rows.push({ key: "deposit", kind: "total", name: "Your deposit", hue: "", weight: this.fmtPctTrim(total), zero: false, cells: HORIZONS.map((h) => cell(mix(h.days))) });
      const b = this.bench();
      if (b) rows.push({ key: b.key, kind: "bench", name: b.label, hue: BENCH_COLOUR, weight: "", zero: false, cells: HORIZONS.map((h) => cell(ret(b.index, h.days))) });
      return rows;
    },
    simDays() {
      const w = this._window();
      if (!w || !this.sim) return [];
      return Array.from({ length: w.n }, (_, i) => dayAt(this.sim.start, w.from + i));
    },
    simTotals() {
      const legs = this._legs();
      const n = this._window()?.n ?? 0;
      return Array.from({ length: n }, (_, i) => legs.reduce((t, l) => t + l.values[i], 0));
    },
    simResult() {
      const legs = this._legs();
      if (!legs.length) return null;
      const put = legs.reduce((t, l) => t + l.put, 0);
      const net = legs.reduce((t, l) => t + l.net, 0);
      const days = this.simDays();
      const fees = legs.filter((l) => l.fee > 0);
      return {
        from: fmtDate(days[0]),
        put: usd(put),
        value: usd(net),
        gain: signedUsd(net - put),
        pct: signedPct(put ? ((net - put) / put) * 100 : null),
        up: net >= put,
        feeNote: fees.length ? `after ${listed(fees.map((l) => `${vaultForBucket(l.key)?.symbol}'s ${fmtBpsExact(l.fee)}`))} exit fee` : "",
      };
    },
    simLegRows() {
      return this._legs().map((l) => {
        const i = this.sleeves().findIndex((s) => s.key === l.key);
        return {
          key: l.key, name: l.name, hue: sleeveColour(i), symbol: vaultForBucket(l.key)?.symbol ?? "",
          weight: this.fmtPctTrim(l.target), put: usd(l.put), value: usd(l.net),
          pct: signedPct(((l.net - l.put) / l.put) * 100), up: l.net >= l.put,
        };
      });
    },
    // A single deposit over a vault's per-deposit cap is refused by the vault.
    capNote() {
      const over = this._legs().map((l) => ({ l, cap: numberOrNull(vaultForBucket(l.key)?.onBase?.caps?.perDepositCap) }))
        .filter(({ l, cap }) => cap !== null && l.put > cap);
      return over.map(({ l, cap }) => `A single deposit into ${vaultForBucket(l.key)?.symbol} is capped at ${fmtUsd(cap)}.`).join(" ");
    },
    _simScale() {
      const t = this.simTotals();
      const put = this.amountValue();
      if (!t.length) return null;
      const all = [...t, ...this._benchValues()];
      let min = Math.min(put, ...all), max = Math.max(put, ...all);
      const pad = (max - min || put * 0.02 || 1) * 0.12;
      min -= pad; max += pad;
      return { min, max, y: yScale({ min, max }) };
    },
    simSvg() {
      const t = this.simTotals();
      const s = this._simScale();
      if (!s) return "";
      const put = this.amountValue();
      const bench = this._benchValues();
      return lineChartSvg({
        n: t.length, y: s.y, grid: [0.125, 0.5, 0.875],
        series: [
          { token: "usdc", color: "var(--color-text-muted)", width: 1, dash: [3, 3], points: t.map((_, i) => ({ i, v: put })) },
          ...(bench.length === t.length ? [{ token: "bench", color: BENCH_COLOUR, width: 1.25, points: bench.map((v, i) => ({ i, v })) }] : []),
          { token: "value", color: "var(--color-text)", width: 1.5, points: t.map((v, i) => ({ i, v })) },
        ],
      });
    },
    simYTicks() {
      const s = this._simScale();
      if (!s) return [];
      return [0.125, 0.5, 0.875].map((f) => {
        const v = s.min + (s.max - s.min) * f;
        return { key: String(f), top: (1 - f) * 100, label: usd(v).replace(/\.\d\d$/, "") };
      });
    },
    simXTicks() { return dateTicks(this.simDays()); },
    simMove(ev) {
      const n = this.simTotals().length;
      if (n) this.simAt = nearestSample(Array.from({ length: n }, (_, i) => i), n, ev);
    },
    simPoint() {
      const t = this.simTotals();
      if (this.simAt === null || !t.length) return null;
      const i = Math.max(0, Math.min(t.length - 1, this.simAt));
      const b = this._benchValues();
      return { left: (i / Math.max(1, t.length - 1)) * 100, date: fmtDate(this.simDays()[i]), value: usd(t[i]), bench: b.length ? usd(b[i]) : null };
    },
    simAria() {
      const r = this.simResult();
      return r ? `${r.put} deposited on ${r.from} would be worth ${r.value} today` : "No simulation";
    },

    // ── TVL and liquidity ───────────────────────────────────────────────────
    liveVaults() { return VAULTS.filter((v) => this.isLive(v.slug)); },
    // The aggregate: combined TVL, how many vaults hold it, and the terms a
    // withdrawal runs on. Each vault's own breakdown is its page's.
    combinedTvl() { return fmtUsd(numberOrNull(this.overview()?.combined?.tvlUsd)); },
    vaultsLiveSub() {
      const n = this.overview()?.combined?.vaultsLive;
      return typeof n === "number" ? `Across ${n} of ${VAULTS.length} vaults` : "";
    },
    feeFacts() {
      return this.liveVaults().map((v) => ({ symbol: v.symbol, v: fmtBpsExact(this.record(v.slug)?.exitFeeBps ?? v.onBase?.exitFeeBps) })).filter((f) => f.v);
    },
    capFacts() {
      return this.liveVaults().map((v) => {
        const r = this.record(v.slug);
        const d = this.details[v.slug] ?? r;
        const tvl = numberOrNull(r?.tvlUsd);
        const cap = numberOrNull(d?.caps?.tvlCap ?? v.onBase?.caps?.tvlCap);
        const per = numberOrNull(d?.caps?.perDepositCap ?? v.onBase?.caps?.perDepositCap);
        if (cap === null && per === null) return null;
        const parts = [
          ...(cap !== null ? [`${fmtUsd(cap)} TVL cap${tvl !== null ? `, ${fmtUsd(Math.max(0, cap - tvl))} of room` : ""}`] : []),
          ...(per !== null ? [`${fmtUsd(per)} per deposit`] : []),
        ];
        return { symbol: v.symbol, v: parts.join("; ") };
      }).filter(Boolean);
    },
    vaultPages() { return VAULTS.map((v) => ({ slug: v.slug, symbol: v.symbol, name: v.name, color: v.color, href: `/vault/${v.slug}` })); },

    // ── risks and contracts: the registry ───────────────────────────────────
    deployed() { return VAULTS.filter((v) => v.onBase); },
    admins() {
      const seen = [...new Set(this.deployed().map((v) => v.onBase?.admin).filter(Boolean))];
      return seen.map((a) => ({ address: a, short: shortAddress(a), href: explorerLink(BASE, a) }));
    },
    audits() {
      return this.deployed().filter((v) => v.onBase?.audit).map((v) => ({ symbol: v.symbol, status: v.onBase?.audit.status, href: v.onBase?.audit.href }));
    },
    venueList() { return listed([...new Set(this.deployed().flatMap((v) => v.onBase?.venues ?? []))]); },
    contractRows() {
      return contractNetworks().flatMap((n) => n.contracts.map((c) => ({ ...c, network: n.label, href: explorerLink({ chainId: n.chainId }, c.address) })));
    },
    vaultLinks() {
      return this.deployed().map((v) => ({ symbol: v.symbol, href: explorerLink(BASE, v.baseAddress) })).filter((l) => l.href);
    },
  }));
}
