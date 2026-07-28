// Single JS source of truth for Chart.js theming. Mirrors the CSS design tokens
// in frontend/public/assets/css/tokens.css so chart colours stop drifting from
// the site palette. Buildless: no imports, `window.Chart` is the global.
//
// The `regimeView` dashboard is the reference look; every value here equals the
// exact hex it already renders, so this is a pure consolidation — not a restyle.

// ── Design tokens (verbatim from tokens.css) ────────────────────────────────
export const PALETTE = {
  void: "#06080c",
  deep: "#0b0e14",
  surface: "#10141c",
  surfaceLight: "#181d28",
  border: "#222a38",
  borderLight: "#2e3a4e",
  text: "#e2e4ec",
  textMuted: "#7e889e",
  textDim: "#4a5268",
  accent: "#00e5ff",
  accentDim: "#00b8d4",
  warm: "#e8a640",
  warn: "#ff6644",
};

// Extended series colours for the categorical/multi-series charts (strategy,
// asset, wallet, regime overlays). Not design tokens (no CSS var), but drawn
// from the Beam/Pool/Beacon brand set — cyan / teal / green / sand / beacon /
// slate — so charts stay on-covenant while series remain distinguishable. The
// old Tailwind rainbow (blue #4488ff, purple #8b5cf6/#a374e0, red #ff6b6b,
// amber #f59e0b, #ffcf80) is retired.
export const SERIES = {
  teal: "#5fb3a1", // on-chain bucket / SP500 price overlay
  slate: "#7e889e", // equity-factor bucket / ETH overlay / hodl baselines (neutral secondary)
  beacon: "#ff7a29", // macro-inverted strategy (negative)
  mint: "#9cffd2", // conservative strategy (light green)
  sand: "#e8a640", // aggressive strategy (warm)
  emerald: "#10b981", // stable / protocol wallet + stable fee slice
  amber: "#e8a640", // bankr fee slice (warm, off Tailwind)
};

// Ordered categorical palette for "tell-apart" figures — pie/donut slices and
// any discrete series where each entry is a DISTINCT ENTITY (asset, protocol,
// bucket, wallet), not a magnitude. Slices here are separated by HUE, never by
// lightness: a green luminance ramp (green → light-green) reads as one
// indistinct blob the moment the slices are categories rather than one
// quantity's intensity — that mistake is what this palette exists to prevent.
// Green leads (Pool = value, the dominant brand hue, so the largest allocation
// still reads as money), then the set steps through maximally-contrasting hues.
// Consumers slice from the front by index; a pie with N slices uses the first N.
export const CATEGORICAL = [
  SERIES.emerald, // #10b981 green  — value anchor (Pool)
  PALETTE.accent, // #00e5ff cyan   — Beam
  SERIES.sand,    // #e8a640 sand
  SERIES.slate,   // #7e889e slate
  SERIES.beacon,  // #ff7a29 beacon
  SERIES.teal,    // #5fb3a1 teal
  SERIES.mint,    // #9cffd2 mint   — 7th (light), rare
];

// Shared axis typography (regime uses JetBrains Mono 10 everywhere).
export const MONO_FONT = { family: "JetBrains Mono", size: 10 };
// Regime grid-line colour: --color-border at 40% alpha.
export const GRID_COLOR = rgba(PALETTE.border, 0.4);

// Consolidates views.js `_alpha` and walletPerfView `_rgba`: 6-digit hex → rgba.
/** @param {string} hex 6-digit hex, leading '#'. @param {number} alpha 0..1. */
export function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Shared axis config builder: mono ticks + regime grid colour. Pass overrides
// to merge extra tick/grid options (e.g. stepSize, callback, display).
export function monoAxis({ ticks = {}, grid = {} } = {}) {
  return {
    ticks: { color: PALETTE.textDim, font: MONO_FONT, ...ticks },
    grid: { color: GRID_COLOR, ...grid },
  };
}

let _applied = false;
// Set Chart.defaults ONCE so factories stop repeating font/legend/tooltip
// blocks. No-ops if Chart.js has not loaded yet or if already applied.
export function applyChartDefaults() {
  if (_applied) return;
  const Chart = typeof window !== "undefined" ? window.Chart : undefined;
  if (!Chart) return;
  _applied = true;

  // Chart.js is a CDN global whose ambient type here only declares getChart /
  // instances, so `defaults` is not on it. Cast at the boundary rather than
  // widening the global.
  const d = /** @type {any} */ (Chart).defaults;
  d.color = PALETTE.textMuted;
  d.borderColor = PALETTE.border;
  d.font.family = MONO_FONT.family;
  d.font.size = MONO_FONT.size;

  d.plugins.legend.labels.color = PALETTE.textMuted;

  const t = d.plugins.tooltip;
  t.backgroundColor = rgba(PALETTE.deep, 0.95);
  t.borderColor = PALETTE.border;
  t.borderWidth = 1;
  t.titleColor = PALETTE.text;
  t.bodyColor = PALETTE.text;
}
