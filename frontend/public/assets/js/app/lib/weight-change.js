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

// Direction is the GLYPH first and the colour second, so the column survives
// colourblindness, greyscale and forced-colors. Up takes Pool green and down
// takes --color-warn (see .alp__mv in views.css).
/** @param {number | null} d */
export function changeGlyph(d) { return d != null && d > 0 ? "▲" : d != null && d < 0 ? "▼" : ""; }
/** @param {number | null} d */
export function changeLabel(d) {
  if (d == null || !Number.isFinite(d) || d === 0) return "—";
  return (d > 0 ? "+" : "−") + Math.abs(Number(d)).toFixed(2) + "%";
}
/** @param {number | null} d */
export function changeClass(d) {
  if (d == null || !Number.isFinite(d) || d === 0) return "flat";
  return d > 0 ? "up" : "down";
}
// The change between two weights, rounded to the hundredth of a point the
// label prints, so a float residue (97 - 95 = 2.0000000000000018) can never
// read as a move of its own and "flat" means the label says "—".
/** @param {number | null} now @param {number | null} was */
export function weightDelta(now, was) {
  if (now == null || was == null || !Number.isFinite(now) || !Number.isFinite(was)) return null;
  return Math.round((now - was) * 100) / 100;
}
