// A book's positions as shares of its value over time, stacked to 100%: the
// chart a subject page and a vault's page draw (RM-121). Geometry only; the
// page supplies the readings, the bands and their colours.
//
// Bands rather than lines: positions at equal weight draw on top of each other
// as lines, and a long tail of small holdings tangles along the axis. Stacked
// to a fixed 100%, share reads as area. The largest band sits on the bottom,
// the only one with a flat, honest baseline.
//
// Geometry lives in a 1000 x 100 unit box that stretches to the column, and
// every label (axes, ticks, tooltip) is HTML over it, so text keeps its real
// size at any width.

/** @param {unknown} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
/** @param {number} v */
const clamp = (v) => Math.max(0, Math.min(100, v));

/**
 * x for each reading by DATE, not by index: one reading per session rather
 * than per day would otherwise draw a three-week gap as wide as a one-day one.
 * Index spacing is the fallback when a date will not parse.
 * @param {unknown[]} dates
 */
export function shareChartXs(dates) {
  const stamps = dates.map((d) => Date.parse(`${String(d ?? "").slice(0, 10)}T00:00:00Z`));
  const n = dates.length;
  const dated = n > 1 && stamps.every((t) => Number.isFinite(t)) && stamps[n - 1] > stamps[0];
  const span = dated ? stamps[n - 1] - stamps[0] : 0;
  return dates.map((_, i) => (dated ? 1000 * ((stamps[i] - stamps[0]) / span) : 1000 * (i / Math.max(1, n - 1))));
}

/**
 * The bands, bottom-up over a running baseline: a calm fill with a crisp top
 * edge in its own colour, separated from its neighbour by a hairline of the
 * page ground, with faint gridlines over them (at 50% one position is the
 * majority of the book). `overlay` is drawn last (a target line).
 * @param {{ xs: number[], series: { token: string, color: string, shares: number[], mark?: string }[], overlay?: string }} m
 */
export function shareChartSvg({ xs, series, overlay = "" }) {
  const y = (/** @type {number} */ frac) => (100 - clamp(frac * 100)).toFixed(2);
  const base = xs.map(() => 0);
  const fills = [];
  const edges = [];
  for (const b of series) {
    const top = base.map((v, i) => v + (b.shares[i] || 0));
    const upper = top.map((v, i) => `${xs[i].toFixed(1)},${y(v)}`);
    const lower = base.map((v, i) => `${xs[i].toFixed(1)},${y(v)}`).reverse();
    for (let i = 0; i < base.length; i++) base[i] = top[i];
    const tok = esc(b.token);
    const mark = b.mark ? ` data-mark="${esc(b.mark)}"` : "";
    fills.push(`<polygon data-token="${tok}"${mark} points="${upper.concat(lower).join(" ")}" fill="${b.color}" fill-opacity="0.62"`
      + ` stroke="var(--color-void)" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
    edges.push(`<polyline data-token="${tok}"${mark} points="${upper.join(" ")}" fill="none" stroke="${b.color}"`
      + ` stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`);
  }
  const grid = [25, 50, 75].map((t) => `<line x1="0" x2="1000" y1="${100 - t}" y2="${100 - t}"`
    + ` stroke="rgba(237,239,241,${t === 50 ? 0.22 : 0.1})" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("");
  return `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">${fills.join("")}${edges.join("")}${grid}${overlay}</svg>`;
}

/**
 * A tick under every reading. Past eight readings only every step-th is
 * dated between the ends, or dozens of dates print over one another; the rest
 * show under the crosshair.
 * @param {unknown[]} dates @param {number[]} xs
 * @param {(d: unknown, first: boolean) => string} label
 */
export function shareChartTicks(dates, xs, label) {
  const last = dates.length - 1;
  const step = Math.max(1, Math.ceil(dates.length / 8));
  const dated = (/** @type {number} */ i) => i % step === 0 && last - i >= step / 2;
  return dates.map((d, i) => ({
    key: `${d}-${i}`,
    left: xs[i] / 10,
    label: label(d, i === 0),
    i,
    cls: i === 0 ? "is-first" : i === last ? "is-last" : dated(i) ? "is-mid" : "is-mid is-sparse",
  }));
}

/**
 * The reading nearest the pointer, for the crosshair.
 * @param {number[]} xs @param {{ clientX: number, currentTarget: any }} ev
 */
export function nearestReading(xs, ev) {
  const rect = ev.currentTarget.getBoundingClientRect();
  const at = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 1000;
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - at) < Math.abs(xs[best] - at)) best = i;
  return best;
}
