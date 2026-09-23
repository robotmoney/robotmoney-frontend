// TVL: a vault's value, or the vault stack's combined value, over time
// (RM-121), the figure the team tracks first. A vault's page and the Robot
// Money Vault subject draw it the same way: an AREA, the value as mass on the
// axis, with a crisp line along its top and a flat, faint fill (no gradient).
// Seven readings or more draw it, broken wherever readings are more than
// three days apart (lib/vault-data.js historyModel); fewer draw as points.
//
// A mixin. The host supplies `tvlPoints()` ([{t, tvlUsd}]), `tvlAsOf()` (the
// read's time, so readings that stopped early show as the gap they are),
// `tvlColor()` and `tvlName()`, and may say the line is no vault's series
// (`tvlMark()` returning "": the vault stack's combined line is neutral). Its
// crosshair is its own (`tvlAt`), so a page with a second chart does not move
// both.
import { fmtDate, fmtUsd, historyModel, numberOrNull } from "../lib/vault-data.js";

/** @param {unknown} v */
const compactUsd = (v) => {
  const n = numberOrNull(v);
  if (n === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 0 }).format(n);
};
// "Sep 3" beside a last tick in the same year, "Sep 3, 2025" otherwise.
/** @param {string} t @param {boolean} sameYear */
const tickDate = (t, sameYear) => (sameYear ? fmtDate(t).replace(/, \d{4}$/, "") : fmtDate(t));

export function tvlChart() {
  return {
    /** @type {number | null} */
    tvlAt: null,
    tvl() {
      const host = /** @type {any} */ (this);
      return historyModel(host.tvlPoints() ?? [], host.tvlAsOf());
    },
    // How it moved across the window, beside the title: the change in dollars
    // and in percent since the first reading. Empty with fewer than two.
    tvlChange() {
      const pts = this.tvl().points;
      if (pts.length < 2) return "";
      const a = pts[0].value;
      const b = pts[pts.length - 1].value;
      const d = b - a;
      const sign = d > 0 ? "+" : d < 0 ? "−" : "";
      const pct = a > 0 ? ` · ${sign}${Math.abs((d / a) * 100).toFixed(1)}%` : "";
      return `${sign}${fmtUsd(Math.abs(d))}${pct} since ${tickDate(pts[0].t, fmtDate(pts[0].t).slice(-4) === fmtDate(pts[pts.length - 1].t).slice(-4))}`;
    },
    // One area and one edge per unbroken run; neither bridges a gap.
    tvlSvg() {
      const m = this.tvl();
      if (m.sparse) return "";
      const host = /** @type {any} */ (this);
      const color = host.tvlColor() ?? "";
      const mark = typeof host.tvlMark === "function" ? host.tvlMark() : "series";
      const attr = mark ? ` data-mark="${mark}"` : "";
      const runs = m.segments.filter((s) => s.length > 1).map((seg) => {
        const xy = seg.map((p) => `${(p.x * 1000).toFixed(1)},${(100 - p.y * 100).toFixed(2)}`);
        const floor = `${(seg[seg.length - 1].x * 1000).toFixed(1)},100 ${(seg[0].x * 1000).toFixed(1)},100`;
        return `<polygon${attr} points="${xy.join(" ")} ${floor}" fill="${color}" fill-opacity="0.14" stroke="none"/>`
          + `<polyline${attr} points="${xy.join(" ")}" fill="none" stroke="${color}" stroke-width="1.75"`
          + ` stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
      });
      const grid = [50].map((y) => `<line x1="0" x2="1000" y1="${y}" y2="${y}" stroke="rgba(237,239,241,0.08)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("");
      return `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" style="overflow:visible" aria-hidden="true" focusable="false">${grid}${runs.join("")}</svg>`;
    },
    // Points instead of a line: every reading of a sparse series, and a
    // reading that stands alone between two gaps.
    tvlDots() {
      const m = this.tvl();
      const pts = m.sparse ? m.points : m.segments.filter((s) => s.length === 1).flat();
      return pts.map((p) => ({ key: p.t, left: p.x * 100, top: (1 - p.y) * 100 }));
    },
    tvlYTicks() {
      const m = this.tvl();
      if (m.max === null || m.min === null) return [];
      const lo = Math.min(0, m.min);
      const hi = /** @type {number} */ (m.max);
      return [1, 0.5, 0].map((f) => ({ key: f, top: (1 - f) * 100, label: compactUsd(lo + (hi - lo) * f) }));
    },
    // The axis's two ends: the first reading, and the later of the last
    // reading and the read's time.
    tvlXTicks() {
      const m = this.tvl();
      if (!m.points.length || m.start === null || m.end === null) return [];
      const last = m.points.length - 1;
      const first = m.points[0];
      if (m.end === m.start) return [{ key: first.t, left: first.x * 100, cls: "", label: fmtDate(first.t), i: 0 }];
      const endT = new Date(m.end).toISOString();
      const sameYear = fmtDate(first.t).slice(-4) === fmtDate(endT).slice(-4);
      return [
        { key: `a-${first.t}`, left: 0, cls: "is-first", label: tickDate(first.t, sameYear), i: 0 },
        { key: `b-${endT}`, left: 100, cls: "is-last", label: tickDate(endT, true), i: m.points[last].ms === m.end ? last : -1 },
      ];
    },
    tvlLabel() {
      const pts = this.tvl().points;
      if (!pts.length) return "";
      const a = pts[0];
      const b = pts[pts.length - 1];
      return `TVL of ${/** @type {any} */ (this).tvlName() ?? "the vault"}, ${fmtDate(a.t)} to ${fmtDate(b.t)}: ${fmtUsd(a.value)} to ${fmtUsd(b.value)}. Use the arrow keys to step through the readings.`;
    },
    /** @param {number | null} i */
    tvlPoint(i) {
      const pts = this.tvl().points;
      if (i == null || !pts[i]) return null;
      const p = pts[i];
      return { left: p.x * 100, top: (1 - p.y) * 100, date: fmtDate(p.t), value: fmtUsd(p.value) };
    },
    /** @param {PointerEvent} ev */
    tvlMove(ev) {
      const pts = this.tvl().points;
      if (!pts.length) return;
      const rect = /** @type {any} */ (ev.currentTarget).getBoundingClientRect();
      const at = (ev.clientX - rect.left) / Math.max(1, rect.width);
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - at) < Math.abs(pts[best].x - at)) best = i;
      this.tvlAt = best;
    },
    /** @param {KeyboardEvent} ev */
    tvlKey(ev) {
      const n = this.tvl().points.length;
      if (!n) return;
      const last = n - 1;
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const from = this.tvlAt ?? (ev.key === "ArrowRight" ? -1 : last + 1);
        this.tvlAt = Math.max(0, Math.min(last, from + (ev.key === "ArrowRight" ? 1 : -1)));
      } else if (ev.key === "Home") { ev.preventDefault(); this.tvlAt = 0; }
      else if (ev.key === "End") { ev.preventDefault(); this.tvlAt = last; }
      else if (ev.key === "Escape") { this.tvlAt = null; }
    },
  };
}
