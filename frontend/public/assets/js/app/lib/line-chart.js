// Lines over time on the site's chart: the frame the vault's TVL and the
// sleeves over time draw in (.rr-area, lib/share-chart.js, alpine/tvl-chart.js).
// The regime history and the backtest equity curves draw here. Geometry only;
// the page supplies the readings, the colours and the bands.
//
// The same contract as share-chart.js: geometry lives in a 1000 x 100 unit box
// that stretches to the column, and every label (axes, ticks, the crosshair's
// readout) is HTML over it, so text keeps its real size at any width. The x
// axis is one unit per calendar day, so a gap in the readings takes the width
// of the days it covers.

/** @param {unknown} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Every calendar day from the first reading's date to the last's.
 * @param {string[]} dates sorted YYYY-MM-DD
 */
export function denseDays(dates) {
  if (!dates.length) return [];
  const out = [];
  const end = Date.parse(dates[dates.length - 1] + "T00:00:00Z");
  for (let t = Date.parse(dates[0] + "T00:00:00Z"); t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * The day positions a line draws: every day, or past `weeklyAfter` days the
 * last day of each seven counted back from the latest, so the latest reading
 * is always a point.
 * @param {number} n @param {number} weeklyAfter
 */
export function sampleDays(n, weeklyAfter) {
  const idx = [];
  if (n > weeklyAfter) { for (let i = n - 1; i >= 0; i -= 7) idx.unshift(i); } else { for (let i = 0; i < n; i++) idx.push(i); }
  return idx;
}

/**
 * A y scale over [min, max], linear or logarithmic, as a 0 (bottom) to 1
 * (top) fraction.
 * @param {{ min: number, max: number, log?: boolean }} s
 */
export function yScale({ min, max, log = false }) {
  if (log) {
    const a = Math.log(min), b = Math.log(max);
    return (/** @type {number} */ v) => (v > 0 ? (Math.log(v) - a) / (b - a || 1) : 0);
  }
  return (/** @type {number} */ v) => (v - min) / (max - min || 1);
}

/**
 * The lines, each broken wherever a reading is missing, never bridged.
 * `points` are { i: day index, v: value or null }. A muted line recedes; a
 * dashed one keeps its dash at screen size.
 * @param {{ n: number, y: (v: number) => number, grid?: number[], series: { token: string, color: string, width?: number, dash?: number[] | null, muted?: boolean, points: { i: number, v: number | null }[] }[] }} m
 */
export function lineChartSvg({ n, y, grid = [], series }) {
  const x = (/** @type {number} */ i) => (1000 * i / Math.max(1, n - 1)).toFixed(1);
  const yy = (/** @type {number} */ v) => (100 - Math.max(0, Math.min(1, y(v))) * 100).toFixed(2);
  const lines = [];
  for (const s of series) {
    const runs = [];
    let run = [];
    for (const p of s.points) {
      if (p.v == null || !Number.isFinite(p.v)) { if (run.length) runs.push(run); run = []; continue; }
      run.push(`${x(p.i)},${yy(p.v)}`);
    }
    if (run.length) runs.push(run);
    const dash = s.dash && s.dash.length ? ` stroke-dasharray="${s.dash.join(" ")}"` : "";
    const cls = s.muted ? ` class="is-muted"` : "";
    for (const r of runs) {
      const pts = r.length === 1 ? `${r[0]} ${r[0]}` : r.join(" ");
      lines.push(`<polyline data-token="${esc(s.token)}"${cls} points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.5}"${dash}`
        + ` stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`);
    }
  }
  const g = grid.map((f) => `<line x1="0" x2="1000" y1="${(100 - f * 100).toFixed(2)}" y2="${(100 - f * 100).toFixed(2)}" stroke="rgba(237,239,241,0.08)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("");
  return `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" style="overflow:visible" aria-hidden="true" focusable="false">${g}${lines.join("")}</svg>`;
}

/**
 * Runs of one state across the days, for the bands drawn behind the lines,
 * as percentages of the plot's width. A day covers its own step, so the last
 * run reaches the right edge.
 * @param {(string | null)[]} states
 */
export function bandRuns(states) {
  const n = states.length;
  const out = [];
  const pct = (/** @type {number} */ i) => (Math.min(i, n - 1) / Math.max(1, n - 1)) * 100;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && states[j + 1] === states[i]) j++;
    if (states[i]) {
      const left = pct(i);
      const right = j + 1 >= n ? 100 : pct(j + 1);
      out.push({ key: `${i}-${j}`, state: states[i], from: i, to: j, left, width: Math.max(0, right - left) });
    }
    i = j + 1;
  }
  return out;
}

/**
 * Date ticks that say the span by their own form, as a price chart's do: days
 * ("Sep 8") across a few weeks, the 1st and 15th across a few months, months
 * ("Mar", January as "Jan '26") across a year or two, and years beyond. Every
 * other one is `is-mid`, which a phone hides, so a narrow axis keeps half.
 * @param {string[]} days
 */
export function dateTicks(days) {
  const n = days.length;
  const mon = (/** @type {string} */ d) => MONTHS[Number(d.slice(5, 7)) - 1];
  const dd = (/** @type {string} */ d) => Number(d.slice(8, 10));
  /** @type {{ i: number, label: string }[]} */
  const out = [];
  days.forEach((d, i) => {
    if (n <= 45) {
      if ((n - 1 - i) % 7 === 0) out.push({ i, label: `${mon(d)} ${dd(d)}` });
    } else if (n <= 120) {
      if (dd(d) === 1 || dd(d) === 15) out.push({ i, label: `${mon(d)} ${dd(d)}` });
    } else if (n <= 1200) {
      const step = n <= 250 ? 1 : n <= 500 ? 2 : 3;
      if (dd(d) === 1 && (Number(d.slice(5, 7)) - 1) % step === 0) out.push({ i, label: d.slice(5, 7) === "01" ? `Jan '${d.slice(2, 4)}` : mon(d) });
    } else if (d.slice(5) === "01-01") {
      out.push({ i, label: d.slice(0, 4) });
    }
  });
  return out.map((t, k) => ({ key: days[t.i], i: t.i, left: (t.i / Math.max(1, n - 1)) * 100, label: t.label, cls: k % 2 ? "is-mid" : "" }));
}

/**
 * A window over the whole axis, dragged by either end or by its middle: the
 * range navigator under a chart. Returns the new [from, to] day indices for a
 * pointer at `at` (a day index), given what was grabbed and where.
 * @param {"from" | "to" | "pan"} grab @param {number} at
 * @param {{ from: number, to: number, offset: number, n: number, min: number }} w
 */
export function dragWindow(grab, at, { from, to, offset, n, min }) {
  const last = n - 1;
  const clamp = (/** @type {number} */ v) => Math.max(0, Math.min(last, Math.round(v)));
  if (grab === "from") return [Math.min(clamp(at), to - min), to];
  if (grab === "to") return [from, Math.max(clamp(at), from + min)];
  const width = to - from;
  const start = Math.max(0, Math.min(last - width, Math.round(at - offset)));
  return [start, start + width];
}

/**
 * The sampled position nearest the pointer, as an index into `idx`.
 * @param {number[]} idx day indices drawn @param {number} n days on the axis
 * @param {{ clientX: number, currentTarget: any }} ev
 */
export function nearestSample(idx, n, ev) {
  const rect = ev.currentTarget.getBoundingClientRect();
  const at = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * Math.max(1, n - 1);
  let best = 0;
  for (let k = 1; k < idx.length; k++) if (Math.abs(idx[k] - at) < Math.abs(idx[best] - at)) best = k;
  return best;
}

/**
 * Round ticks on a log axis between min and max: 0.1, 0.3, 1, 3, 10 and so
 * on, filled in with 0.2, 0.5, 2, 5 when the span is short.
 * @param {number} min @param {number} max
 */
export function logTicks(min, max) {
  const coarse = [], fine = [];
  for (let e = -2; e <= 4; e++) {
    const p = 10 ** e;
    coarse.push(p, 3 * p);
    fine.push(p, 2 * p, 3 * p, 5 * p);
  }
  const within = (/** @type {number[]} */ a) => a.filter((v) => v >= min && v <= max);
  const c = within(coarse);
  if (c.length >= 3) return c;
  const f = within(fine);
  if (f.length >= 3) return f;
  // A short range (a year, six months) spans less than one step of those:
  // four ticks evenly spaced on the log axis, at two significant figures.
  const a = Math.log(min), b = Math.log(max);
  const out = [];
  for (let k = 0; k < 4; k++) {
    const v = Math.exp(a + ((b - a) * (k + 0.5)) / 4);
    const r = Number(v.toPrecision(2));
    if (!out.includes(r)) out.push(r);
  }
  return out;
}
