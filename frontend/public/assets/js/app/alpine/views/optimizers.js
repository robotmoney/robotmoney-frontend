// /optimizers: the regime's risk-on / risk-off split, the six risk-on
// optimizers with today's mix, and each one's hypothetical backtest since 2018.
//
// The optimizer numbers come from a committed file, public/data/optimizers.json,
// built by the research workbench (src/reports/optimizers_page.ts, the analyst
// SDK's allocate/ solvers; the file's `asof` is the last price day). Today's regime
// comes from the live regime API, so the highlighted split and the whole-
// portfolio rings follow it. The chart is lib/line-chart.js, the part /regime
// draws; the rings and pictures are drawn here from the same data file.
import { api, ROUTES } from "../../lib/api.js";
import { REGIME, SERIES, PALETTE } from "../../lib/chart-theme.js";
import { regimeDialValid } from "../../lib/regime-dial.js";
import { yScale, lineChartSvg, nearestSample, stepAt, bandRuns } from "../../lib/line-chart.js";
import { REGIME_BAND_BG, REGIME_BG_LEGEND } from "./shared.js";

const STATES = ["risk_off", "neutral", "risk_on"];
// The regime methodology the backtest's labels come from. Asked for by name
// while it is published beside the served line; when v5 becomes the served
// line (D96), the parameter can go and the plain request returns the same.
const METHODOLOGY = "v5";
// How long today's regime may take before the data file's own reading is used.
const REGIME_WAIT_MS = 6000;
const STATE_LABEL = { risk_off: "Risk-off", neutral: "Neutral", risk_on: "Risk-on" };

// One colour per asset group, the same on every ring, bar and picture: four
// hues far apart, so no two groups can be confused. Risk-off is slate. The
// data file keys commodities as `gold` (the bucket holds GLD).
const ASSET = {
  risk_off: { label: "Risk-off assets", colour: SERIES.slate },
  crypto: { label: "Crypto", colour: PALETTE.accent },
  us_equities: { label: "US equities", colour: SERIES.emerald },
  gold: { label: "Commodities", colour: SERIES.sand },
};
const RISK_ON = ["crypto", "us_equities", "gold"];
const VOID = PALETTE.void;
const INK = "#f2f4f9";

// One colour per optimizer on the backtest chart, each a solid line. Only
// the comparisons (BENCH) are dashed.
const ENGINE = {
  naive: { label: "Equal weight", colour: SERIES.slate },
  inverse_vol: { label: "Inverse volatility", colour: "#c2c9d8" },
  equal_risk: { label: "Risk budget: parity", colour: SERIES.emerald },
  risk_budget: { label: "Risk budget: crypto", colour: PALETTE.accent },
  min_variance: { label: "Minimum variance", colour: SERIES.sand },
  markowitz: { label: "Markowitz", colour: SERIES.beacon },
};

// The comparisons a reader can tick on: each is held from the first day
// without trading, and dashed as /regime dashes its baselines.
const BENCH = {
  cash: { label: "Cash", long: "Cash (3-month T-bill)", colour: "#8f9ab0", dash: [2, 3] },
  sp500: { label: "S&P 500", long: "S&P 500 index", colour: "#f2f4f9", dash: [6, 3] },
  eth: { label: "ETH", long: "ETH", colour: SERIES.mint, dash: [6, 3] },
};

// Round steps for a linear dollar axis from 0: at most six lines.
function linearTicks(max) {
  const step = [0.25, 0.5, 1, 2, 5, 10, 20, 50].find((x) => max / x <= 6) || 100;
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(2));
  return out;
}

// ── rings: solid arcs with an even black divider at every boundary ─────────
function ringSvg(rows, active) {
  const R = 48, r = 33, C = 50;
  const drawn = rows.filter((x) => x.pct > 0.05);
  // Before the data file arrives: the ring's empty track, held at its size.
  if (!drawn.length) return `<svg class="op-donut" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><circle class="op-donut__skel" cx="50" cy="50" r="${(R + r) / 2}" fill="none" stroke-width="${R - r}"/></svg>`;
  const pt = (rad, a) => [(C + rad * Math.sin(a)).toFixed(2), (C - rad * Math.cos(a)).toFixed(2)];
  let a0 = 0, arcs = "", cuts = "";
  for (const x of drawn) {
    const a1 = a0 + (x.pct / 100) * 2 * Math.PI;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const [ox0, oy0] = pt(R, a0), [ox1, oy1] = pt(R, a1), [ix1, iy1] = pt(r, a1), [ix0, iy0] = pt(r, a0);
    const d = drawn.length === 1
      ? `M${C} ${C - R}A${R} ${R} 0 1 1 ${C - 0.01} ${C - R}L${C - 0.01} ${C - r}A${r} ${r} 0 1 0 ${C} ${C - r}Z`
      : `M${ox0} ${oy0}A${R} ${R} 0 ${big} 1 ${ox1} ${oy1}L${ix1} ${iy1}A${r} ${r} 0 ${big} 0 ${ix0} ${iy0}Z`;
    arcs += `<path d="${d}" fill="${x.colour}" data-sleeve="${x.key}"${active && active !== x.key ? ' class="is-muted"' : ""}/>`;
    if (drawn.length > 1) {
      const [a, b] = pt(r - 1, a0), [c, e] = pt(R + 1, a0);
      cuts += `<line x1="${a}" y1="${b}" x2="${c}" y2="${e}" stroke="${VOID}" stroke-width="2.2"/>`;
    }
    a0 = a1;
  }
  return `<svg class="op-donut" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${arcs}${cuts}</svg>`;
}

// ── icons: one small line drawing per optimizer, beside its name ─────────
// 48 by 48, hairline strokes in --color-text-soft, the optimizer's own chart
// colour for the part that carries the idea.
const SOFT = "#c2c9d8";
const icon = (body, label) => `<svg class="op-icon" viewBox="0 0 48 48" role="img" aria-label="${label}" fill="none" stroke="${SOFT}" stroke-width="1.25" stroke-linecap="square">${body}</svg>`;
const ICON = {
  // three equal bars under one level line
  naive: (a) => icon(
    `<path d="M5 42H43" /><path d="M5 12H43" stroke-dasharray="2 2"/>`
    + [9, 20, 31].map((x) => `<rect x="${x}" y="16" width="8" height="26" fill="${a}" fill-opacity="0.22" stroke="${a}"/><path d="M${x + 4} 42V45"/>`).join(""),
    "Three equal bars"),
  // wide swings get a short bar, calm swings a long one
  inverse_vol: (a) => icon(
    [[12, 5], [24, 3], [36, 1.2]].map(([y, amp], i) => {
      let d = `M4 ${y}`;
      for (let k = 1; k <= 8; k++) d += ` L${4 + k * 2.5} ${(y + (k % 2 ? -amp : amp)).toFixed(1)}`;
      return `<path d="${d}"/><path d="M26 ${y}h2" /><rect x="30" y="${y - 2.5}" width="${[5, 9, 14][i]}" height="5" fill="${a}" stroke="${a}"/>`;
    }).join(""),
    "Wide swings, little money; calm swings, more money"),
  // a balance with three equal weights level on the beam
  equal_risk: (a) => icon(
    `<path d="M24 9V40"/><path d="M16 42H32"/><path d="M6 15H42"/><circle cx="24" cy="9" r="1.6" fill="${SOFT}" stroke="none"/>`
    + [8, 24, 40].map((x) => `<path d="M${x} 15L${x - 3} 25M${x} 15L${x + 3} 25"/><path d="M${x - 4.5} 25H${x + 4.5}"/><rect x="${x - 2}" y="21" width="4" height="4" fill="${a}" stroke="none"/>`).join(""),
    "A balance with three equal weights"),
  // a risk circle: half to crypto, a quarter each to the others
  risk_budget: (a) => icon(
    `<path d="M24 24L24 7A17 17 0 1 1 14.01 10.25Z" fill="${a}" fill-opacity="0.9" stroke="${a}"/><circle cx="24" cy="24" r="17"/><path d="M24 24L24 7M24 24L14.01 10.25M24 24L18.75 7.83"/>`
    + `<path d="M24 3V5M24 43V45M3 24H5M43 24H45"/>`,
    "A circle, 90% filled for crypto"),
  // the bottom of a bowl
  min_variance: (a) => icon(
    `<path d="M5 4V43H44"/><path d="M9 8Q24 52 40 8"/><path d="M5 30H22" stroke-dasharray="2 2"/><path d="M24 43V33" stroke-dasharray="2 2"/>`
    + `<circle cx="24" cy="30" r="3" fill="${a}" stroke="none"/><path d="M3 30H5M24 43V45"/>`,
    "The lowest point of a curve"),
  // the line from cash that touches the curve of mixes
  markowitz: (a) => icon(
    `<path d="M4 4V44H44"/><path d="M16 40Q16 22 42 12"/>`
    + [[24, 34], [30, 30], [35, 24], [28, 39], [37, 33], [22, 40], [33, 37]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.9" fill="${SOFT}" stroke="none"/>`).join("")
    + `<path d="M4 35.6L44 8.3" stroke="${a}" stroke-dasharray="3 2"/><rect x="2.5" y="34.1" width="3" height="3" fill="${SOFT}" stroke="none"/><circle cx="28.7" cy="18.7" r="2.6" fill="${a}" stroke="none"/>`,
    "A line from cash touching the curve of mixes"),
};

// The firm, fund or paper each optimizer follows, linked to its own page.
// Each sentence is checked against the linked page (2026-11-23).
const FIRM = {
  naive: { name: "Invesco S&P 500 Equal Weight ETF (RSP)", url: "https://www.invesco.com/us/en/financial-products/etfs/invesco-sp-500-equal-weight-etf.html", text: "Since 2003 it has held every stock in the S&P 500 in the same amount." },
  inverse_vol: { name: "S&P 500 Low Volatility Index", url: "https://www.spglobal.com/spdji/en/indices/dividends-factors/sp-500-low-volatility-index/", text: "S&P Dow Jones Indices weights the 100 least volatile S&P 500 stocks by one over their volatility." },
  equal_risk: { name: "Bridgewater All Weather", url: "https://www.bridgewater.com/research-and-insights/the-all-weather-story", text: "Launched in 1996, it is built so that four economic environments each carry the same risk." },
  risk_budget: { name: "PanAgora Risk Parity Multi Asset", url: "https://www.panagora.com/strategies/multi-asset/risk-parity/", text: "PanAgora credits Edward Qian, who developed its approach, with defining the term risk parity and calls him a pioneer of risk budgeting." },
  min_variance: { name: "iShares MSCI USA Min Vol Factor ETF (USMV)", url: "https://www.ishares.com/us/products/239695/ishares-msci-usa-minimum-volatility-etf", text: "BlackRock's fund tracks the MSCI USA Minimum Volatility Index, which targets US stocks with lower volatility." },
  markowitz: { name: "Harry Markowitz, \"Portfolio Selection\" (1952)", url: "https://doi.org/10.1111/j.1540-6261.1952.tb01525.x", text: "The Journal of Finance paper that set out choosing a portfolio by expected return and variance." },
};

export function registerOptimizersView(Alpine) {
  Alpine.data("optimizersView", () => {
  // The chart model, built once from the data file (kept off the reactive
  // object, so building it never re-runs the bindings that read it).
  let memo = null;
  return {
    loading: true,
    error: null,
    data: null,
    regime: null,
    btAt: null,
    btFocus: null,
    // The chart's controls: comparisons ticked on, the scale, the regime shading.
    compare: { cash: false, sp500: false, eth: false },
    log: false,
    bands: true,
    // Per card, the asset the reader is pointing at: it lights up in the bars,
    // both rings and both legends at once.
    focus: {},

    async load() {
      // The data file and today's regime are read together and shown together:
      // the page holds its own shape with placeholders until both are in, so
      // nothing moves when the figures arrive (the regime read gives up after
      // REGIME_WAIT_MS, and the data file's own reading is used).
      const live = Promise.race([
        api.get(ROUTES.dashboards.regimeSnapshots, { range: 1, methodology: METHODOLOGY }).catch(() => null),
        new Promise((done) => setTimeout(() => done(null), REGIME_WAIT_MS)),
      ]);
      try {
        const res = await fetch("/data/optimizers.json", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`/data/optimizers.json (${res.status})`);
        this.data = await res.json();
      } catch (e) {
        this.error = e.message;
      }
      this.regime = this._regimeFrom(await live);
      this.loading = false;
    },
    // Today's regime is methodology v5, the model the backtest's labels come
    // from (the data file's regime golden is the one v5 reproduces byte for
    // byte, issue 1753). The API serves v5 beside the main line; the answer is
    // used only when it says it is v5, since an API without the parameter
    // ignores it and returns the main line. Until then, the data file's own
    // last v5 day. Never the main line: its label would contradict the bands.
    _regimeFrom(snap) {
      const l = snap?.latest;
      if (snap?.methodology === METHODOLOGY && l && STATES.includes(l.regime)) {
        return { state: l.regime, date: l.date, composite: l.composite ?? null, cuts: l.bucketThresholds || null };
      }
      const rm = this.data?.regime_model;
      return rm && STATES.includes(rm.state) ? { state: rm.state, date: rm.date, composite: rm.composite ?? null, cuts: null } : null;
    },

    // ── the split ────────────────────────────────────────────────────────
    states() {
      return STATES.map((k) => {
        // Before the data file: no share, so no bar and no figure (pct of null is a dash).
        const on = this.data ? this.data.label_share?.[k] ?? 0 : null;
        return { key: k, label: STATE_LABEL[k], colour: REGIME[k], riskOn: on, riskOff: on == null ? null : 1 - on, today: this.regime?.state === k };
      });
    },
    todayLabel() { return this.regime ? STATE_LABEL[this.regime.state] : ""; },
    // The site's regime dial (alpine/regime-dial.js), fed as /regime feeds it.
    dialModel() {
      const r = this.regime;
      const m = { value: r?.composite, riskOff: r?.cuts?.risk_off ?? 0.33, riskOn: r?.cuts?.risk_on ?? 0.67, regime: r?.state };
      return r && regimeDialValid(m) ? m : null;
    },
    scaleLabel() { return this.states().map((s) => `${s.label}: ${this.pct(s.riskOff * 100)} risk-off assets, ${this.pct(s.riskOn * 100)} risk-on assets`).join("; "); },
    asset(k) { return ASSET[k]; },
    updatedText() { return this.regime ? `Regime as of ${this.dateLong(this.regime.date)}` : ""; },

    // ── the optimizers ──────────────────────────────────────────────────
    engine(key) { return this.data?.engines.find((e) => e.key === key) || null; },
    rows(parts) { return RISK_ON.map((k) => ({ key: k, label: ASSET[k].label, colour: ASSET[k].colour, pct: parts ? (parts[k] ?? 0) * 100 : null })); },
    // Money and risk as two bars, the same three colours in the same order.
    bars(key) {
      const e = this.engine(key);
      // Before the data file: both bars, empty, so the card keeps its height.
      return [{ key: "money", label: "Share of money", tip: "The share of dollars in each asset.", parts: e ? this.rows(e.money) : [] }, { key: "risk", label: "Share of risk", tip: "The share of the mix's total swings that each asset causes.", parts: e ? this.rows(e.risk) : [] }];
    },
    focusOf(k) { return this.focus[k] || null; },
    setFocus(k, a) { this.focus[k] = a; },
    // Over an arc, that asset; over the ring's hole or its empty corners,
    // nothing, so the card never stays lit after the pointer moves off a slice.
    overRing(k, ev) {
      this.setFocus(k, ev.target?.closest?.("[data-sleeve]")?.dataset.sleeve || null);
    },
    // Dims the arcs that are not in focus, on the drawn SVG. Redrawing the ring
    // on every focus change replaced the arc under the pointer and could lose
    // the pointerleave that clears it.
    muteArcs(el, k) {
      const a = this.focusOf(k);
      el.querySelectorAll("[data-sleeve]").forEach((p) => p.classList.toggle("is-muted", !!a && p.dataset.sleeve !== a));
    },
    // The row a ring names in its centre: the one in focus, if the ring has it.
    ringRow(rows, k) { const a = this.focusOf(k); return a ? rows.find((r) => r.key === a) || null : null; },
    // The line under the bars: the asset in focus, its share of money and of risk.
    readout(k) {
      const e = this.engine(k), a = this.focusOf(k);
      if (!e || !a || !RISK_ON.includes(a)) return "";
      return `${ASSET[a].label}: ${this.pct(e.money[a] * 100)} of the money, ${this.pct(e.risk[a] * 100)} of the risk.`;
    },
    basketRows(key) { return this.rows(this.engine(key)?.money); },
    basketSvg(key) { return ringSvg(this.basketRows(key), null); },
    // The whole portfolio under today's regime: the basket scaled by the
    // risk-on share, in the same rows as the risk-on mix, then the risk-off
    // share.
    wholeRows(key) {
      const e = this.engine(key);
      if (this.loading) return [...this.rows(null), { key: "risk_off", label: ASSET.risk_off.label, colour: ASSET.risk_off.colour, pct: null }];
      if (!e || !this.regime) return [];
      const s = this.data.label_share[this.regime.state];
      return [...this.rows(e.money).map((r) => ({ ...r, pct: r.pct * s })), { key: "risk_off", label: ASSET.risk_off.label, colour: ASSET.risk_off.colour, pct: (1 - s) * 100 }];
    },
    wholeSvg(key) { return ringSvg(this.wholeRows(key), null); },
    icon(key) { return ICON[key] ? ICON[key](ENGINE[key].colour) : ""; },
    firm(key) { return FIRM[key]; },
    // The symbols a card's formula uses, in words.
    formulaTip(key) {
      const w = "w is an asset's weight.";
      const vol = "σ is its volatility: how much its daily returns swing, as a yearly figure.";
      const cov = "Σ is the covariance: how much the assets move together.";
      if (key === "naive") return w;
      if (key === "inverse_vol") return `${w} ${vol}`;
      if (key === "min_variance") return `${w} ${cov} wᵀΣw is the mix's variance, its volatility squared.`;
      if (key === "markowitz") return `${w} ${cov} μ is the expected returns and r is the 3-month T-bill rate.`;
      return `${w} ${cov} wᵢ(Σw)ᵢ ÷ wᵀΣw is asset i's share of the mix's risk.`;
    },
    pct(v) { return v == null || !isFinite(v) ? "—" : `${Math.round(+v)}%`; },

    // ── the backtest ────────────────────────────────────────────────────
    // Every line on one weekly date axis, with the regime's runs behind them.
    _bt() {
      if (memo) return memo;
      // Before the data file: an empty chart, never cached, so the real one is
      // built once the file is in.
      if (!this.data) return { days: [], n: 0, idx: [], lines: [], ticks: [], runs: [] };
      const d = this.data;
      const engines = d?.engines || [];
      const ref = engines.reduce((a, e) => (e.curve.length > (a?.curve.length ?? 0) ? e : a), null);
      const days = ref ? ref.curve.map((p) => p.date) : [];
      const mk = (row, style, baseline) => {
        const at = new Map(row.curve.map((p) => [p.date, p.value]));
        const values = days.map((day) => (at.has(day) ? +at.get(day) : null));
        let last = null;
        for (let k = values.length - 1; k >= 0; k--) if (values[k] != null) { last = values[k]; break; }
        return { token: row.key, label: style.label, long: style.long || style.label, colour: style.colour, dash: style.dash || null, baseline, values, last, stats: row.stats };
      };
      const lines = [...engines.map((e) => mk(e, ENGINE[e.key], false)), ...(d?.benchmarks || []).map((x) => mk(x, BENCH[x.key], true))];
      const ticks = [];
      for (let y = Number(days[0]?.slice(0, 4)) + 1; days.length && y <= Number(days[days.length - 1].slice(0, 4)); y++) {
        const i = days.findIndex((day) => day >= `${y}-01-01`);
        if (i > 0) ticks.push({ key: String(y), left: (i / Math.max(1, days.length - 1)) * 100, label: String(y), cls: "" });
      }
      const state = new Map((d?.regime || []).map((r) => [r.date, r.state]));
      memo = { days, n: days.length, idx: days.map((_, i) => i), lines, ticks, runs: bandRuns(days.map((day) => state.get(day) || null)) };
      return memo;
    },
    // The lines on show: the six optimizers and any comparison ticked on.
    _shown() { return this._bt().lines.filter((l) => !l.baseline || this.compare[l.token]); },
    // The y axis for what is on show: dollars from 0, or a log scale.
    _axis() {
      const flat = this._shown().flatMap((l) => l.values).filter((v) => v > 0);
      const lo = flat.length ? Math.min(...flat) : 0.5, hi = flat.length ? Math.max(...flat) : 2;
      const min = this.log ? lo * 0.92 : 0, max = hi * (this.log ? 1.08 : 1.05);
      // log: each line doubles the one below
      const doubles = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32].filter((v) => v >= min && v <= max);
      return { f: yScale({ min, max, log: this.log }), ticks: this.log ? doubles : linearTicks(max) };
    },
    btSvg() {
      if (!this.data) return "";
      const m = this._bt(), ax = this._axis();
      return lineChartSvg({
        n: m.n, y: ax.f, grid: ax.ticks.map(ax.f),
        series: this._shown().map((l) => ({ token: l.token, color: l.colour, width: l.dash ? 1.25 : 1.75, dash: l.dash, muted: !!this.btFocus && this.btFocus !== l.token, points: m.idx.map((i, k) => ({ i, v: l.values[k] })) })),
      });
    },
    btYTicks() {
      if (!this.data) return [];
      const ax = this._axis();
      return ax.ticks.map((v) => ({ key: v, top: (1 - ax.f(v)) * 100, label: `$${+v.toFixed(2)}` }));
    },
    btXTicks() { return this.data ? this._bt().ticks : []; },
    btBands() { return this.data && this.bands ? this._bt().runs : []; },
    bandBg(state) { return REGIME_BAND_BG[state] || "transparent"; },
    bandKey() { return REGIME_BG_LEGEND; },
    benchList() { return Object.entries(BENCH).map(([key, x]) => ({ key, label: x.long })); },
    // Each line named at its right end, highest first, nudged apart so no two
    // names sit on top of each other.
    btEnds() {
      // Before the data file: the six names, spaced, with no figure.
      if (!this.data) return this.loading ? Object.entries(ENGINE).map(([token, e], i) => ({ token, label: e.label, colour: e.colour, dash: null, value: "—", top: 10 + i * 14 })) : [];
      const ax = this._axis();
      const rows = this._shown().filter((l) => l.last != null).map((l) => ({ token: l.token, label: l.label, colour: l.colour, dash: l.dash, value: this.money(l.last), top: (1 - ax.f(l.last)) * 100 })).sort((a, x) => a.top - x.top);
      const gap = 7;
      for (let i = 1; i < rows.length; i++) if (rows[i].top - rows[i - 1].top < gap) rows[i].top = rows[i - 1].top + gap;
      const over = rows.length ? rows[rows.length - 1].top - 100 : 0;
      if (over > 0) { rows[rows.length - 1].top = 100; for (let i = rows.length - 2; i >= 0; i--) if (rows[i + 1].top - rows[i].top < gap) rows[i].top = rows[i + 1].top - gap; }
      return rows;
    },
    btMove(ev) { const m = this._bt(); if (m.n) this.btAt = nearestSample(m.idx, m.n, ev); },
    btKey(ev) { this.btAt = stepAt(ev, this.btAt, this._bt().idx.length); },
    btPoint() {
      if (this.btAt == null || !this.data) return null;
      const m = this._bt(), k = this.btAt;
      const items = this._shown().filter((l) => l.values[k] != null).sort((a, x) => x.values[k] - a.values[k]).map((l) => ({ token: l.token, label: l.label, colour: l.colour, value: this.money(l.values[k]) }));
      const state = (this.data.regime || [])[k]?.state;
      return { left: (k / Math.max(1, m.n - 1)) * 100, date: this.dateLong(m.days[k]), regime: STATE_LABEL[state] || "", regimeColour: REGIME[state] || REGIME.neutral, items };
    },
    btPeriod() {
      const m = this._bt();
      return m.n ? `${this.dateLong(m.days[0])} to ${this.dateLong(m.days[m.n - 1])}` : "";
    },
    // The finding in a line: the optimizer that grew most and the one that fell least.
    btSummary() {
      const es = this._bt().lines.filter((l) => !l.baseline);
      if (!es.length) return "";
      const top = es.reduce((a, l) => (l.stats.final_value > a.stats.final_value ? l : a));
      const calm = es.reduce((a, l) => (l.stats.max_drawdown > a.stats.max_drawdown ? l : a));
      return `${top.label} grew $1 to ${this.money(top.stats.final_value)}, with a max drawdown of ${this.fmtPct(top.stats.max_drawdown)}. ${calm.label} had the smallest max drawdown, ${this.fmtPct(calm.stats.max_drawdown)}, and grew $1 to ${this.money(calm.stats.final_value)}.`;
    },
    btLabel() {
      const m = this._bt();
      return m.n ? `Growth of $1 in ${this._shown().map((l) => l.label).join(", ")}, ${this.log ? "log" : "linear"} scale, ${this.btPeriod()}, weekly values. Use the arrow keys to step through the readings.` : "";
    },
    dashKey(colour, dash) {
      return `<svg width="14" height="8" aria-hidden="true"><line x1="0" y1="4" x2="14" y2="4" stroke="${colour}" stroke-width="1.5" stroke-dasharray="${(dash || []).map((v) => v / 2).join(" ")}"/></svg>`;
    },
    // The table: the six optimizers, then the three comparisons as baselines.
    tableRows() {
      if (this.data) return this._bt().lines.map((l) => ({ key: l.token, label: l.long, colour: l.colour, dash: l.dash, baseline: l.baseline, s: l.stats }));
      // Before the data file: the nine rows by name, with no figure.
      return this.loading ? [...Object.entries(ENGINE).map(([key, e]) => ({ key, label: e.label, colour: e.colour, dash: null, baseline: false, s: {} })), ...Object.entries(BENCH).map(([key, x]) => ({ key, label: x.long, colour: x.colour, dash: x.dash, baseline: true, s: {} }))] : [];
    },
    money(v) { return v == null || !isFinite(v) ? "—" : `$${(+v).toFixed(2)}`; },
    fmtPct(v) { return v == null || !isFinite(v) ? "—" : `${(+v * 100).toFixed(1).replace("-", "−")}%`; },
    fmtNum(v) { return v == null || !isFinite(v) ? "—" : (+v).toFixed(2); },
    monthYear(d) {
      const t = Date.parse(String(d || "") + "T00:00:00Z");
      return isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "";
    },
    dateLong(d) {
      const t = Date.parse(String(d || "") + "T00:00:00Z");
      return isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
    },
  };
  });
}
