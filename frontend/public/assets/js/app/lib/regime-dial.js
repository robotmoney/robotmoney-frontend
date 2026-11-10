// The regime dial: where a composite percentile sits between risk-off and
// risk-on, as a half circle. Risk-off is the left segment, neutral the top,
// risk-on the right, cut at the snapshot's own thresholds. One segment is lit
// (the current regime, or the one a reader points at) and the others recede;
// a round dot is the reading (a round mark is a reading site-wide). Styled by
// .rm-dial in components.css; alpine/regime-dial.js makes it explain itself
// on hover, focus or tap. The regime page's top line is the first user.

/** @typedef {"risk_off" | "neutral" | "risk_on"} DialKey */
/**
 * @typedef {{ percentile: number | null | undefined, riskOff: number, riskOn: number, regime?: string | null }} DialModel
 *   percentile and the cuts are fractions (0 to 1); regime is risk_off | neutral | risk_on.
 */

import { REGIME } from "./chart-theme.js";

// Geometry in the viewBox: a half circle over CY, and the gap either side of
// each cut, as a fraction of the half turn.
export const DIAL_VIEW = { w: 200, h: 104 };
const CX = 100, CY = 96, R = 88, GAP = 0.012;
// How near a segment's end the dot strands a sliver: its radius and halo plus
// a margin, as a fraction of the half turn.
const DOT_END_ZONE = 12 / (Math.PI * R);
/** @type {DialKey[]} */
export const DIAL_KEYS = ["risk_off", "neutral", "risk_on"];

/** @param {DialModel | null | undefined} m */
export function regimeDialValid(m) {
  return !!m && m.percentile != null && Number.isFinite(+m.percentile) && m.riskOff > 0 && m.riskOn > m.riskOff && m.riskOn < 1;
}

/** @param {string | null | undefined} r @returns {DialKey | null} */
const keyOf = (r) => { const k = String(r || "").replace(/-/g, "_"); return /** @type {DialKey[]} */ (DIAL_KEYS).includes(/** @type {DialKey} */ (k)) ? /** @type {DialKey} */ (k) : null; };

/**
 * The dial's SVG markup, or "" when the reading or the cuts are missing (the
 * caller then shows its plain readout). `focus` lights that segment instead of
 * the current regime's.
 * @param {DialModel & { focus?: DialKey | null }} m
 */
export function regimeDialSvg(m) {
  if (!regimeDialValid(m)) return "";
  const at = (/** @type {number} */ f) => { const t = Math.PI * (1 - f); return [CX + R * Math.cos(t), CY - R * Math.sin(t)]; };
  const arc = (/** @type {number} */ a, /** @type {number} */ b) => {
    const [x0, y0] = at(a), [x1, y1] = at(b);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const lit = m.focus || keyOf(m.regime);
  const dot = Math.max(0, Math.min(1, +(m.percentile ?? 0)));
  const spans = /** @type {[DialKey, number, number][]} */ ([["risk_off", 0, m.riskOff - GAP], ["neutral", m.riskOff + GAP, m.riskOn - GAP], ["risk_on", m.riskOn + GAP, 1]]);
  const segs = spans.map(([key, a0, b0]) => {
    // The dot's halo cuts the arc, so a dot this near a segment's end would
    // strand a sliver past it: the segment ends at the dot instead.
    const inside = dot >= a0 && dot <= b0;
    const a = inside && dot - a0 < DOT_END_ZONE ? dot : a0;
    const b = inside && b0 - dot < DOT_END_ZONE ? dot : b0;
    return `<path d="${arc(a, b)}" fill="none" stroke="${REGIME[key]}" stroke-width="7"${key === lit ? ' class="is-on"' : ""}/>`;
  }).join("");
  const [x, y] = at(dot);
  return `<svg viewBox="0 0 ${DIAL_VIEW.w} ${DIAL_VIEW.h}" aria-hidden="true" focusable="false">${segs}`
    + `<circle class="rm-dial__dot" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5.5"/></svg>`;
}

/**
 * The segment under a point in the dial's box, or null off the arc. `px`, `py`
 * are fractions of the box's width and height.
 * @param {DialModel} m @param {number} px @param {number} py @returns {DialKey | null}
 */
export function regimeDialAt(m, px, py) {
  const dx = px * DIAL_VIEW.w - CX, dy = CY - py * DIAL_VIEW.h;
  const r = Math.hypot(dx, dy);
  if (dy < -8 || r < R - 26 || r > R + 14) return null;
  const f = 1 - Math.atan2(Math.max(dy, 0), dx) / Math.PI;
  return f < m.riskOff ? "risk_off" : f > m.riskOn ? "risk_on" : "neutral";
}

/** Where each state's name sits, as percentages of the dial's box: the ends
 * flush with the arc's outer edges (components.css sets each side's anchor),
 * neutral over the top. */
export const DIAL_LABEL_AT = {
  risk_off: { left: 0, top: 100 },
  neutral: { left: 50, top: 0 },
  risk_on: { left: 100, top: 100 },
};

/**
 * Where a state's tip opens: at the middle of its segment, just inside the
 * arc, as percentages of the arc's box, and which way it opens into the bowl.
 * @param {DialModel} m @param {DialKey} key
 * @returns {{ left: number, top: number, side: "right" | "below" | "left" }}
 */
export function regimeDialTipAt(m, key) {
  const mid = { risk_off: m.riskOff / 2, neutral: (m.riskOff + m.riskOn) / 2, risk_on: (1 + m.riskOn) / 2 }[key];
  const t = Math.PI * (1 - mid), r = R - 12;
  return {
    left: ((CX + r * Math.cos(t)) / DIAL_VIEW.w) * 100,
    top: ((CY - r * Math.sin(t)) / DIAL_VIEW.h) * 100,
    side: key === "risk_off" ? "right" : key === "risk_on" ? "left" : "below",
  };
}

/** A 0-1 fraction as an ordinal's number and suffix, { n: "33", suffix: "rd" }. */
export function ordinalParts(/** @type {number} */ x) {
  const n = Math.round(x * 100);
  const rem100 = n % 100;
  const suffix = rem100 >= 11 && rem100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[/** @type {1 | 2 | 3} */ (n % 10)] || "th";
  return { n: String(n), suffix };
}

/** A 0-1 fraction as an ordinal percentile, "33rd". */
export function ordinalPct(/** @type {number} */ x) {
  const { n, suffix } = ordinalParts(x);
  return n + suffix;
}

/**
 * What a state means, for its tip: where the composite has to sit to read it,
 * and for the current one, where it sits today and how the label moves.
 * @param {DialModel} m @param {DialKey} key
 * @returns {{ title: string, body: string, now: string | null }}
 */
export function regimeDialTip(m, key) {
  const lo = ordinalPct(m.riskOff), hi = ordinalPct(m.riskOn);
  const where = { risk_off: `below the ${lo}`, neutral: `between the ${lo} and the ${hi}`, risk_on: `above the ${hi}` }[key];
  const title = { risk_off: "Risk-off", neutral: "Neutral", risk_on: "Risk-on" }[key];
  const now = key === keyOf(m.regime) && m.percentile != null
    ? `Today, at the ${ordinalPct(+m.percentile)}. A new label holds after five trading days, or at once on a 2σ move.`
    : null;
  return { title, body: `The composite is ${where} percentile of its last three years.`, now };
}
