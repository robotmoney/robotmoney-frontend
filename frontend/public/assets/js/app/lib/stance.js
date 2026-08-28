// The stance ramp, once. It was written twice — STANCE_COLORS in
// alpine/static-views.js and an inline object literal in alpine/views/swarm.js
// — so the same five words could be painted two different ways depending on
// which page you were looking at, and changing one endpoint meant remembering
// the other existed.
//
// WHY STANCE OWNS HUE AT ALL. It is the only ORDINAL value on these surfaces:
// bearish through bullish is a direction, and a colour ramp is the one encoding
// that carries direction without being read. Everything else on the swarm gave
// up colour so this could keep it — see the mark contract in components.css.
//
// BEARISH IS RED, NOT BEACON ORANGE. Down is red by convention in every market
// surface a reader has seen, and #ff7a29 sat close enough to `cautious` #e8a640
// that the negative end of the ramp read as one colour in two shades. #ff6644
// is --color-warn from tokens.css rather than a new value.
//
// Values are literal hex rather than var() because they are handed to inline
// `style` and to SVG fills, where a custom property buys nothing and costs a
// resolution step.

/** @type {Readonly<Record<string, string>>} */
export const STANCE_COLORS = Object.freeze({
  bullish: "#10b981",      // --color-green   Pool: the value colour, conviction
  constructive: "#34d399", // lighter green, the common positive
  neutral: "#7e889e",      // --color-text-muted, slate: no direction
  cautious: "#e8a640",     // --color-warm
  bearish: "#ff6644",      // --color-warn
});

/** The ramp's neutral, for a stance this system does not know. */
export const STANCE_FALLBACK = STANCE_COLORS.neutral;

/** @param {unknown} stance */
export function stanceColor(stance) {
  return STANCE_COLORS[String(stance || "").toLowerCase()] || STANCE_FALLBACK;
}

/**
 * Inline style for the shared pill: a tinted border and the label in the ramp
 * colour. Never a fill — a column of filled pills becomes a column of coloured
 * blocks, which is the thing the mark contract exists to prevent.
 */
/** @param {unknown} stance */
export function stanceStyle(stance) {
  const c = stanceColor(stance);
  return `border-color:${c}66;color:${c};`;
}

/** Class for the shared pill (.sv__stance-badge), with its stance as a modifier. */
/** @param {unknown} stance */
export function stanceClass(stance) {
  const key = String(stance || "").toLowerCase();
  return STANCE_COLORS[key] ? `sv__stance-badge sv__stance-badge--${key}` : "sv__stance-badge";
}
