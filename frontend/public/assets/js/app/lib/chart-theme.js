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
  blue: "#4488ff",
  purple: "#8b5cf6",
};

// Extended series colours used by strategy/asset/wallet charts. Not design
// tokens (they have no CSS var), but centralised here so every chart draws
// from one place. Values are the exact hex previously hardcoded inline.
export const SERIES = {
  teal: "#5fb3a1", // on-chain bucket / SP500 price overlay
  violet: "#a374e0", // equity-factor bucket / ETH overlay / hodl baselines
  red: "#ff6b6b", // macro-inverted strategy
  mint: "#9cffd2", // conservative strategy
  amberLight: "#ffcf80", // aggressive strategy
  emerald: "#10b981", // stable / protocol wallet + stable fee slice
  amber: "#f59e0b", // bankr fee slice
};

// Shared axis typography (regime uses JetBrains Mono 10 everywhere).
export const MONO_FONT = { family: "JetBrains Mono", size: 10 };
// Regime grid-line colour: --color-border at 40% alpha.
export const GRID_COLOR = rgba(PALETTE.border, 0.4);

// Consolidates views.js `_alpha` and walletPerfView `_rgba`: 6-digit hex → rgba.
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

  const d = Chart.defaults;
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
