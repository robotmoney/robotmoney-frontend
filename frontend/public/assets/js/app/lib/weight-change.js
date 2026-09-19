// How a weight and a change in weight read, wherever one weight is set against
// another: /allocation's "What changed" ledger and a session's outcome. One
// implementation, so the same move cannot be written two ways on two pages.
//
// Weights are percentages (0 to 100). A change is in percentage points.

// A weight at one decimal with a trailing ".0" trimmed: 95%, 14.3%.
/** @param {unknown} v */
export function fmtPctTrimBare(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(1).replace(/\.0$/, "");
}
/** @param {unknown} v */
export function fmtPctTrim(v) {
  const bare = fmtPctTrimBare(v);
  return bare === "—" ? bare : `${bare}%`;
}

// A change in a weight is in PERCENTAGE POINTS and says so: 5% to 3% is
// "−2 pp". It printed "▼ −2.00%", which reads as a relative change (a 2% cut)
// of what was in fact a 40% cut of that sleeve (David, 2026-09-19). No arrow:
// an arrow over a percentage reads as a rate of change, and the sign already
// carries direction through greyscale and forced-colors. Colour is second, as
// ever: up takes Pool green and down --color-warn (.alp__mv in views.css).
/** @param {number | null} d */
export function changeLabel(d) {
  if (d == null || !Number.isFinite(d) || d === 0) return "—";
  const pts = Math.abs(Number(d)).toFixed(2).replace(/\.?0+$/, "");
  return `${d > 0 ? "+" : "−"}${pts} pp`;
}
/** @param {number | null} d */
export function changeClass(d) {
  if (d == null || !Number.isFinite(d) || d === 0) return "flat";
  return d > 0 ? "up" : "down";
}
// The change between two weights, rounded to the hundredth of a point the
// label prints at most, so a float residue (97 - 95 = 2.0000000000000018) can never
// read as a move of its own and "flat" means the label says "—".
/** @param {number | null} now @param {number | null} was */
export function weightDelta(now, was) {
  if (now == null || was == null || !Number.isFinite(now) || !Number.isFinite(was)) return null;
  return Math.round((now - was) * 100) / 100;
}
