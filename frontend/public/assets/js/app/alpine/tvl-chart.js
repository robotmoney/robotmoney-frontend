// TVL over time: a vault's value, or the vault stack's combined value, as one
// line (RM-121). A vault's page and the Robot Money Vault subject draw it the
// same way. Seven readings or more draw a line, broken wherever readings are
// more than three days apart (lib/vault-data.js historyModel); fewer draw as
// points.
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
    tvlCount() {
      const n = this.tvl().points.length;
      return n === 1 ? "1 reading" : `${n} readings`;
    },
    // One polyline per unbroken run; a line never bridges a gap.
    tvlSvg() {
      const m = this.tvl();
      if (m.sparse) return "";
      const host = /** @type {any} */ (this);
      const color = host.tvlColor() ?? "";
      const mark = typeof host.tvlMark === "function" ? host.tvlMark() : "series";
      const lines = m.segments.filter((s) => s.length > 1).map((seg) => {
        const pts = seg.map((p) => `${(p.x * 1000).toFixed(1)},${(100 - p.y * 100).toFixed(2)}`).join(" ");
        return `<polyline${mark ? ` data-mark="${mark}"` : ""} points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"`
          + ` stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      });
      const grid = `<line x1="0" x2="1000" y1="50" y2="50" stroke="rgba(237,239,241,0.1)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
      return `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" style="overflow:visible" aria-hidden="true" focusable="false">${grid}${lines.join("")}</svg>`;
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
      return { left: p.x * 100, date: fmtDate(p.t), value: fmtUsd(p.value) };
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
