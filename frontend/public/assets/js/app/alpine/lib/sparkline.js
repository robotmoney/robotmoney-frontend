// Pure SVG-string generators for the dashboard's hand-rolled sparklines —
// exact port of the retired robotmoney-bot-analytics app's `Sparkline` and
// `RowSparkline` components (docs/bot-analytics-ui-port-plan.md §4.2/§4.3,
// issue #381). These stay hand-rolled SVG on purpose: everything ELSE
// chart-shaped in the port becomes Chart.js (see `chart-theme.js` in this
// same directory) but sparklines never were recharts in the original, so
// there is nothing to migrate away from.
//
// No DOM reads, no Chart.js dependency, no side effects: every function here
// is `(values, opts) -> string`, so the geometry is unit-testable with fixed
// inputs and byte-exact expected output (docs/bot-analytics-ui-port-plan.md
// §4.3 test-plan cell) — see scripts/tests/unit/sparkline.test.ts.
//
// Colors mirror dash.css's `.a3` tokens as literal hex, the same pattern
// app/lib/chart-theme.js already uses for the marketing palette: a pure
// module can't do a CSSOM read (that would make it neither pure nor
// testable without a DOM), so the hex is a deliberate, commented duplicate of
// the source of truth rather than an independent guess.
export const DASH_COLOR = {
  // --success, hsl(142 70% 45%) — RowSparkline "up" trend.
  up: "#22c35d",
  // --destructive, hsl(0 65% 55%) — RowSparkline "down" trend.
  down: "#d74242",
  // --muted-foreground, hsl(220 12% 60%) — RowSparkline flat trend.
  flat: "#8d95a5",
  // --chart-1 / --primary, hsl(186 100% 50%) — default Sparkline color.
  accent: "#00e5ff",
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** @typedef {number|null|undefined} SparkValue */
/** @typedef {{x:number, y:number}} Point */

/**
 * @param {SparkValue} v
 * @returns {v is number}
 */
function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Map each value (finite or not) onto `{x,y}` plot coordinates over a
 * `width`×`height` box with `pad` vertical inset (so a thick stroke never
 * clips at the top/bottom edge). Null/undefined/NaN entries map to `null` so
 * callers can skip them without losing the x-position spacing of the rest of
 * the series. Returns `null` (not an array) when there are zero finite
 * values — nothing to scale against.
 * @param {SparkValue[]} values
 * @param {number} width
 * @param {number} height
 * @param {number} pad
 * @returns {(Point|null)[]|null}
 */
function plotPoints(values, width, height, pad) {
  const nums = values.filter(isFiniteNum);
  if (nums.length === 0) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1; // constant series -> flat mid-line, avoid /0
  const n = values.length;
  const stepX = n > 1 ? width / (n - 1) : 0;
  const usableH = Math.max(height - pad * 2, 0);
  return values.map((v, i) => {
    if (!isFiniteNum(v)) return null;
    const x = n > 1 ? i * stepX : width / 2;
    const t = (v - min) / span;
    const y = pad + (1 - t) * usableH;
    return { x: round2(x), y: round2(y) };
  });
}

/** @param {(Point|null)[]} points @returns {Point[]} */
function finitePoints(points) {
  return /** @type {Point[]} */ (points.filter((p) => p !== null));
}

/**
 * Default `Sparkline`: 80×24, stroke 1.5, single-color polyline, no fill, no
 * dots — a minimal trend line (INV-O `Sparkline.tsx`). Used at this default
 * size for MetricCard/ProjectProfile KpiTile, and at 800×120 for the
 * WalletProfile Balance History card (pass `{width:800,height:120}`).
 *
 * Renders "" (no original behavior is documented for this case — unlike
 * RowSparkline's explicit "—", plain Sparkline call sites in the original
 * always had ≥2 points by construction) when fewer than 2 finite points are
 * given, since a single point cannot draw a line.
 * @param {SparkValue[]} values
 * @param {{width?:number, height?:number, stroke?:number, color?:string, className?:string}} [opts]
 * @returns {string} a standalone `<svg>...</svg>` string, or "".
 */
export function renderSparkline(values, opts = {}) {
  const width = opts.width ?? 80;
  const height = opts.height ?? 24;
  const stroke = opts.stroke ?? 1.5;
  const color = opts.color ?? DASH_COLOR.accent;
  const pad = stroke;

  const list = Array.isArray(values) ? values : [];
  const pts = plotPoints(list, width, height, pad);
  const finitePts = pts ? finitePoints(pts) : [];
  if (finitePts.length < 2) return "";

  const pointsAttr = finitePts.map((p) => `${p.x},${p.y}`).join(" ");
  const cls = opts.className ? ` class="${opts.className}"` : "";
  return (
    `<svg${cls} viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `fill="none" xmlns="${SVG_NS}">` +
    `<polyline points="${pointsAttr}" fill="none" stroke="${color}" ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

/**
 * Table-cell `RowSparkline`: 80×22, stroke 1.25, 12%-opacity area fill under
 * the line, auto-colored by first→last trend — green ("up") if the last
 * finite value exceeds the first by more than 0.5%, red ("down") if it is
 * below the first at all, muted ("flat") otherwise (INV-O `RowSparkline.tsx`,
 * plan §4.3). Renders the literal em-dash "—" (not SVG markup) when fewer
 * than 4 finite points exist — the original's explicit floor for a
 * meaningful trend read in a small table cell.
 * @param {SparkValue[]} values
 * @param {{width?:number, height?:number, stroke?:number, className?:string}} [opts]
 * @returns {string} a standalone `<svg>...</svg>` string, or the "—" glyph.
 */
export function renderRowSparkline(values, opts = {}) {
  const list = Array.isArray(values) ? values : [];
  const finite = list.filter(isFiniteNum);
  if (finite.length < 4) return "—";

  const width = opts.width ?? 80;
  const height = opts.height ?? 22;
  const stroke = opts.stroke ?? 1.25;
  const pad = stroke;

  const rawPts = plotPoints(list, width, height, pad);
  const pts = finitePoints(rawPts ?? []);

  const first = finite[0];
  const last = finite[finite.length - 1];
  // Percent change off the first finite value; a zero baseline can't have a
  // ratio, so fall back to a sign-only reading (any rise/fall off exactly
  // zero still crosses the ±0.5% band below).
  const pctChange = first === 0 ? (last === 0 ? 0 : last > 0 ? 1 : -1) : ((last - first) / Math.abs(first)) * 100;
  const color = pctChange > 0.5 ? DASH_COLOR.up : pctChange < 0 ? DASH_COLOR.down : DASH_COLOR.flat;

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const firstPt = /** @type {Point} */ (pts[0]);
  const lastPt = /** @type {Point} */ (pts[pts.length - 1]);
  const areaPath = `${linePath} L${lastPt.x},${height} L${firstPt.x},${height} Z`;
  const pointsAttr = pts.map((p) => `${p.x},${p.y}`).join(" ");

  const cls = opts.className ? ` class="${opts.className}"` : "";
  return (
    `<svg${cls} viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `fill="none" xmlns="${SVG_NS}">` +
    `<path d="${areaPath}" fill="${color}" fill-opacity="0.12" stroke="none"/>` +
    `<polyline points="${pointsAttr}" fill="none" stroke="${color}" ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}
