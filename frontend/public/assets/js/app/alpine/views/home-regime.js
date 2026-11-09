// The market regime under the home page's model portfolio (Lex: the portfolio,
// then the regime it is read against): the dial with the regime beside it, and
// the last year on the site's chart. The composite is plotted as a percentile
// of its last three years, so the dial, the bands and the axis read on one
// scale; the raw composite is the supporting number beside it. One read of the
// regime snapshots, made as the section nears the viewport: a visitor who never
// scrolls this far never pays for it.
import { api, ROUTES } from "../../lib/api.js";
import { ordinalPct, regimeDialValid } from "../../lib/regime-dial.js";
import { bandRuns, dateTicks, denseDays, lineChartSvg, nearestSample, stepAt } from "../../lib/line-chart.js";
import { REGIME } from "../../lib/chart-theme.js";
import { COMPOSITE_AREA, REGIME_BAND_BG, REGIME_BG_LEGEND } from "./shared.js";

const YEAR_DAYS = 365;
// A little past the year, so the run the regime is in can start before it.
const FETCH_DAYS = 400;
const NEAR_VIEWPORT = "800px 0px";
const LABEL = { risk_off: "Risk-off", neutral: "Neutral", risk_on: "Risk-on" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** @param {string} d an ISO date */
const short = (d) => { const [y, m, day] = d.split("-").map(Number); return `${MONTHS[m - 1]} ${day}, ${y}`; };
/** @param {string | null | undefined} r @returns {keyof typeof LABEL | ""} */
const keyOf = (r) => /** @type {any} */ (String(r || "").replace(/-/g, "_"));

/**
 * The last year as the chart draws it: one unit per calendar day, a gap in the
 * readings keeping its width, or null with fewer than two readings to draw.
 * @param {any[]} rows sorted by date @param {number} riskOff @param {number} riskOn
 */
function yearModel(rows, riskOff, riskOn) {
  if (!rows.length) return null;
  const end = Date.parse(`${rows[rows.length - 1].date}T00:00:00Z`);
  const first = new Date(end - (YEAR_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const inYear = rows.filter((r) => r.date >= first);
  const days = denseDays(inYear.map((r) => r.date));
  const byDate = new Map(inYear.map((r) => [r.date, r]));
  const values = days.map((d) => { const v = byDate.get(d)?.compositePercentile; return v == null ? null : +v; });
  const levels = days.map((d) => { const v = byDate.get(d)?.composite; return v == null ? null : +v; });
  if (values.filter((v) => v != null).length < 2) return null;
  const n = days.length;
  const regimes = days.map((d) => keyOf(byDate.get(d)?.regime) || null);
  return {
    n, days, values, levels, regimes,
    idx: days.map((_, i) => i),
    ticks: dateTicks(days),
    bands: bandRuns(regimes).map((b) => ({ ...b, bg: REGIME_BAND_BG[/** @type {keyof typeof REGIME_BAND_BG} */ (b.state)] || "transparent" })),
    svg: lineChartSvg({
      n, y: (v) => v, grid: [riskOff, riskOn],
      series: [{ token: "composite", color: REGIME.neutral, width: 1.5, area: COMPOSITE_AREA, points: values.map((v, i) => ({ i, v })) }],
    }),
  };
}

/** @param {import("alpinejs").Alpine} Alpine */
export function registerHomeRegime(Alpine) {
  Alpine.data("homeRegime", () => {
    // Read once and never changed, so kept out of Alpine's proxies.
    /** @type {any[]} */ let rows = [];
    /** @type {ReturnType<typeof yearModel>} */ let year = null;
    /** @type {IntersectionObserver | null} */ let near = null;
    return {
      /** @type {{ regime: string, composite: number | null, compositePercentile: number, bucketThresholds?: Record<string, number> | null } | null} */
      latest: null,
      regimeLoaded: false,
      regimeFailed: false,
      /** @type {number | null} */ yearAt: null,

      init() {
        if (!("IntersectionObserver" in globalThis)) { this.loadRegime(); return; }
        near = new IntersectionObserver((entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          near?.disconnect();
          this.loadRegime();
        }, { rootMargin: NEAR_VIEWPORT });
        near.observe(this.$el);
      },
      destroy() { near?.disconnect(); },
      async loadRegime() {
        try {
          const data = await api.get(ROUTES.dashboards.regimeSnapshots, { range: FETCH_DAYS });
          const l = data.latest;
          this.latest = l ? { regime: l.regime, composite: l.composite ?? null, compositePercentile: l.compositePercentile, bucketThresholds: l.bucketThresholds } : null;
          rows = (data.history || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
          const { riskOff, riskOn } = this.cuts();
          year = yearModel(rows, riskOff, riskOn);
        } catch { this.regimeFailed = true; }
        this.regimeLoaded = true;
      },

      cuts() {
        const t = this.latest?.bucketThresholds || {};
        return { riskOff: t.risk_off ?? 0.33, riskOn: t.risk_on ?? 0.67 };
      },
      dialModel() {
        const l = this.latest;
        if (!l) return null;
        const m = { percentile: l.compositePercentile, regime: l.regime, ...this.cuts() };
        return regimeDialValid(m) ? m : null;
      },
      regimeReady() { return !!this.dialModel(); },
      regimeLabel() { return LABEL[/** @type {keyof typeof LABEL} */ (keyOf(this.latest?.regime))] || "—"; },
      regimeColour() { return REGIME[/** @type {keyof typeof REGIME} */ (keyOf(this.latest?.regime))] || REGIME.neutral; },
      // The first day of the run the regime is in now.
      regimeSince() {
        const now = keyOf(this.latest?.regime);
        if (!rows.length || !now) return "";
        let i = rows.length - 1;
        while (i > 0 && keyOf(rows[i - 1].regime) === now) i--;
        return short(rows[i].date);
      },
      regimeSentence() {
        const since = this.regimeSince(), raw = this.latest?.composite;
        const level = raw == null ? "," : ` reads ${(+raw).toFixed(2)},`;
        return `${since ? `Since ${since}. ` : ""}The composite of macro and on-chain conditions${level} ranked against its last three years.`;
      },

      // ── The last year ──
      yearReady() { return this.regimeLoaded && !!year; },
      yearSvg() { return year?.svg || ""; },
      yearBands() { return year?.bands || []; },
      yearXTicks() { return year?.ticks || []; },
      // The percentile axis, marked at the regime's cuts, as the regime page
      // marks it on this scale.
      yearYTicks() {
        const { riskOff: lo, riskOn: hi } = this.cuts();
        return /** @type {[number, string][]} */ ([[1, "100"], [hi, ordinalPct(hi)], [0.5, "50th"], [lo, ordinalPct(lo)], [0, "0"]])
          .map(([v, label]) => ({ key: v, top: (1 - v) * 100, label, cut: v === lo || v === hi }));
      },
      bgLegend() { return REGIME_BG_LEGEND; },
      // The latest reading, the dial's own dot on the line.
      yearLast() {
        if (!year) return null;
        let k = year.n - 1;
        while (k > 0 && year.values[k] == null) k--;
        const v = year.values[k];
        return v == null ? null : { left: (k / Math.max(1, year.n - 1)) * 100, top: (1 - v) * 100 };
      },
      yearLabel() {
        if (!year) return "";
        return `The composite as a percentile of its last three years, ${short(year.days[0])} to ${short(year.days[year.n - 1])}. Latest: ${this.regimeLabel()}, ${ordinalPct(this.latest?.compositePercentile ?? 0)} percentile. Use the arrow keys to step through the readings.`;
      },
      yearMove(/** @type {PointerEvent} */ ev) { if (year) this.yearAt = nearestSample(year.idx, year.n, ev); },
      yearKey(/** @type {KeyboardEvent} */ ev) { if (year) this.yearAt = stepAt(ev, this.yearAt, year.n); },
      yearPoint() {
        const k = this.yearAt;
        if (!year || k == null) return null;
        const v = year.values[k], level = year.levels[k], regime = year.regimes[k];
        return {
          left: (k / Math.max(1, year.n - 1)) * 100,
          date: short(year.days[k]),
          regime: regime ? LABEL[regime] : "",
          regimeColor: regime ? REGIME[regime] : REGIME.neutral,
          label: level == null ? "Composite" : `Composite ${level.toFixed(2)}`,
          value: v == null ? "—" : ordinalPct(v),
          color: v == null ? REGIME.neutral : v >= COMPOSITE_AREA.base ? COMPOSITE_AREA.above.line : COMPOSITE_AREA.below.line,
        };
      },
    };
  });
}
