// Alpine factory for /blog/swarm-announcement, the swarm launch post.
//
// The engines figure draws on the site's own chart (.rr-area, lib/line-chart.js),
// the one the regime page's backtests use: a crosshair readout, a legend that
// focuses a line, and range chips. The two ranges are the research map's two
// panels ("All engines against each other, regime rule, monthly rebalancing"):
// the full period, and since January 2024 rebased to 1.
//
// The series are a committed fixture, public/data/engine-comparison.json,
// built from the research map's derived-backtest.json; its stats are the map's
// "Headline variant of each" table word for word. The post is dated, so the
// figure does not track anything live.
//
// The contents rail marks the section in view with an IntersectionObserver;
// it is hidden on a phone, where the page is one column.
import { PALETTE, SERIES } from "../../lib/chart-theme.js";
import { denseDays, yScale, lineChartSvg, dateTicks, nearestSample, logTicks } from "../../lib/line-chart.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateLong = (/** @type {string} */ d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
const times = (/** @type {number} */ v) => (v == null || !isFinite(v) ? "—" : v.toFixed(2) + "×");

// One hue per engine, the same in the chart, its legend, the engines table
// and the results table. v1 is the money hue and the heaviest line; the two
// risk budgets share sand, the 95% one dashed.
/** @type {Record<string, { color: string, width?: number, dash?: number[] }>} */
export const ENGINE_STYLE = {
  erc: { color: SERIES.emerald, width: 2.5 },
  naive: { color: SERIES.slate },
  invvol: { color: SERIES.teal },
  minvar: { color: PALETTE.accent },
  rb60: { color: SERIES.sand },
  rb95: { color: SERIES.sand, dash: [5, 4] },
  panel: { color: SERIES.mint },
  markowitz: { color: SERIES.beacon },
};

const RANGES = [
  { id: "full", label: "Full period" },
  { id: "recent", label: "Since Jan 2024" },
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return res.json();
}

export function registerSwarmAnnouncement(Alpine) {
  Alpine.data("swarmAnnouncement", () => ({
    data: null,
    error: null,
    ranges: RANGES,
    range: "full",
    at: null,     // hovered sample, an index into the model's idx
    focus: null,  // engine key whose line stands out
    current: "",  // section in view, for the contents rail
    _memo: new Map(),
    _io: null,

    async load() {
      this.spy();
      try {
        this.data = await fetchJson("/data/engine-comparison.json");
      } catch (e) {
        this.error = e.message;
      }
    },

    spy() {
      if (!("IntersectionObserver" in window)) return;
      const secs = [...this.$root.querySelectorAll("[data-toc]")];
      this._io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.current = e.target.id;
      }, { rootMargin: "-30% 0px -60% 0px" });
      secs.forEach((s) => this._io.observe(s));
    },
    destroy() { if (this._io) this._io.disconnect(); },

    rows() { return this.data ? this.data.strategies : []; },
    ruled() { return this.rows().filter((r) => r.curve); },
    held() { return this.rows().filter((r) => !r.curve); },
    style(key) { return ENGINE_STYLE[key] || { color: SERIES.slate }; },
    swatch(key) { return `background:${this.style(key).color}`; },
    times,

    setRange(id) { this.range = id; this.at = null; },

    // The chart's geometry for the range on show: one unit per calendar day,
    // a point at each month-end, each line rebased to 1 at the range's first
    // month-end when the range starts after the backtest does.
    model() {
      if (!this.data) return null;
      const key = this.range;
      if (this._memo.has(key)) return this._memo.get(key);
      const { dates, rebaseFrom } = this.data;
      const start = key === "recent" ? dates.indexOf(rebaseFrom) : 0;
      const months = dates.slice(start);
      const days = denseDays(months);
      const pos = new Map(days.map((d, i) => [d, i]));
      const idx = months.map((d) => pos.get(d));
      const lines = this.ruled().map((r) => {
        let vals = r.curve.slice(start);
        if (start > 0) { const base = vals[0]; vals = vals.map((v) => (v == null || !base ? null : v / base)); }
        return { key: r.key, label: r.name, values: vals, end: vals[vals.length - 1] };
      });
      const flat = lines.flatMap((l) => l.values).filter((v) => v > 0);
      const min = Math.min(...flat) * 0.94, max = Math.max(...flat) * 1.06;
      const m = { days, n: days.length, idx, lines, min, max, ticks: dateTicks(days), from: months[0], to: months[months.length - 1] };
      this._memo.set(key, m);
      return m;
    },
    svg() {
      const m = this.model();
      if (!m) return "";
      const y = yScale({ min: m.min, max: m.max, log: true });
      const series = m.lines.map((l) => {
        const st = this.style(l.key);
        return { token: l.key, color: st.color, width: st.width, dash: st.dash || null, muted: !!this.focus && this.focus !== l.key, points: l.values.map((v, k) => ({ i: m.idx[k], v })) };
      });
      // v1 draws last, so it sits over the lines it crosses.
      series.sort((a, b) => (a.token === "erc") - (b.token === "erc"));
      return lineChartSvg({ n: m.n, y, grid: logTicks(m.min, m.max).map(y), series });
    },
    yTicks() {
      const m = this.model();
      if (!m) return [];
      const y = yScale({ min: m.min, max: m.max, log: true });
      return logTicks(m.min, m.max).map((v) => ({ key: v, top: (1 - y(v)) * 100, label: `${+v.toPrecision(2)}×` }));
    },
    xTicks() { const m = this.model(); return m ? m.ticks : []; },
    move(ev) { const m = this.model(); if (m) this.at = nearestSample(m.idx, m.n, ev); },
    key(ev) {
      const m = this.model();
      if (!m) return;
      const last = m.idx.length - 1;
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const from = this.at ?? (ev.key === "ArrowRight" ? -1 : last + 1);
        this.at = Math.max(0, Math.min(last, from + (ev.key === "ArrowRight" ? 1 : -1)));
      }
    },
    point() {
      const m = this.model();
      if (!m || this.at == null) return null;
      const i = m.idx[this.at];
      const items = m.lines
        .map((l) => ({ key: l.key, label: l.label, color: this.style(l.key).color, v: l.values[this.at] }))
        .filter((it) => it.v != null)
        .sort((a, b) => b.v - a.v)
        .map((it) => ({ ...it, value: times(it.v) }));
      return { left: (i / Math.max(1, m.n - 1)) * 100, date: dateLong(m.days[i]), items };
    },
    legend() {
      const m = this.model();
      return m ? m.lines.map((l) => ({ key: l.key, label: l.label, value: times(l.end), dash: this.style(l.key).dash })) : [];
    },
    dashKey(key) {
      const st = this.style(key);
      return `<svg width="14" height="8" aria-hidden="true"><line x1="0" y1="4" x2="14" y2="4" stroke="${st.color}" stroke-width="1.5" stroke-dasharray="${(st.dash || []).map((v) => v / 2).join(" ")}"/></svg>`;
    },
    intro() {
      const m = this.model();
      if (!m) return "";
      return this.range === "recent" ? `Rebased to 1 on ${dateLong(m.from)} · log scale` : `${dateLong(m.from)} to ${dateLong(m.to)} · log scale`;
    },
    label() {
      const m = this.model();
      if (!m) return "";
      return `Growth of 1 under each portfolio engine with the regime rule, log scale, ${dateLong(m.from)} to ${dateLong(m.to)}, month-end values. Use the arrow keys to step through the readings.`;
    },
  }));
}
