// Single JS source of truth for Chart.js theming. Mirrors the CSS design tokens
// in frontend/public/assets/css/tokens.css so chart colours stop drifting from
// the site palette. Buildless: no imports, `window.Chart` is the global.
//
// The reference look is the research-record pages (/swarm/sessions/<id>,
// /vault/rmusdc, /allocation and their .rr-* rules in views.css): hairline
// chrome, square tips, round series dots, no gridline the reader does not need.
// This file consolidated the hexes the charts already drew; it is not a palette
// of its own.
//
// RM-102 lifted the night-register text ramp and retired its bottom rung, so
// `text` and `textMuted` below carry the new tokens.css values and `textDim` is
// gone. Chart TYPE moved with the ramp; the SERIES and CATEGORICAL hexes below
// did not, because they encode data.

// ── Design tokens (verbatim from tokens.css) ────────────────────────────────
export const PALETTE = {
  void: "#06080c",
  deep: "#0b0e14",
  surface: "#10141c",
  surfaceLight: "#181d28",
  border: "#222a38",
  borderLight: "#2e3a4e",
  text: "#f2f4f9",
  textMuted: "#8f9ab0",
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
//
// `slate` is #7e889e, which was also the --color-text-muted hex until RM-102
// lifted that rung to #8f9ab0. Slate did not follow and must not: it names a
// bucket, an overlay and the hodl baselines, and a series keeps the one hex it
// is recognised by wherever it is drawn.
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

// One regime palette, site-wide. A regime reading keeps these hues wherever it
// appears: the session page's market-context dots, /regime and the blog's band
// charts. Stance runs green to beacon; neutral is slate. Beacon is a POINT
// colour (a dot, a line, a strip of 12px or less), never a filled area.
export const REGIME = { risk_on: "#10b981", neutral: "#7e889e", risk_off: "#ff7a29" };

/** @param {string} key risk_on | neutral | risk_off. Unknown keys read as neutral. */
export function regimeHue(key) {
  return REGIME[/** @type {keyof typeof REGIME} */ (key)] || REGIME.neutral;
}

// Shared axis typography (regime uses JetBrains Mono 10 everywhere).
// A fallback stack, not the face alone: before the web font arrives Chart.js
// would otherwise draw its ticks in the browser's default serif.
export const MONO_FONT = { family: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace", size: 10 };
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
    ticks: { color: PALETTE.textMuted, font: MONO_FONT, ...ticks },
    grid: { color: GRID_COLOR, ...grid },
  };
}

// A legend key for a dashed series: a 10px run of its line in its dash, drawn
// once per colour and dash and reused. Chart.js draws a canvas point style at
// its own size, centred on the key's box. The dash is scaled down so a 10px
// sample still shows two or three repeats and [6,3], [2,3] and [10,3,2,3]
// stay tellable apart.
/** @type {Map<string, HTMLCanvasElement>} */
const _dashSamples = new Map();
/** @param {string} color @param {number[]} dash @param {number} [width] */
function dashSample(color, dash, width) {
  const lw = Math.max(1.25, Number(width) || 0);
  const key = `${color}|${dash.join(",")}|${lw}`;
  let c = _dashSamples.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = 10;
    c.height = 4;
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.setLineDash(dash.map((v) => Math.max(1, v * 0.6)));
    g.beginPath();
    g.moveTo(0, 2);
    g.lineTo(10, 2);
    g.stroke();
    _dashSamples.set(key, c);
  }
  return c;
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

  // Gridlines belong to the value axis. Every chart on the site draws its x
  // axis as a category scale (dates or groups), so that axis loses its grid
  // here; a chart that wants one back sets `grid.display` itself.
  d.set("scales.category", { grid: { display: false } });

  // Legend keys are round 6px dots, not Chart.js's 40x10 hollow boxes. The
  // legend draws a point of radius boxHeight * SQRT2 / 2, so this boxHeight is
  // what makes the radius 3; the 8px box leaves room for a dash sample. A line
  // series' dot takes its line colour (its fill is usually empty). A dashed
  // line is a reference, and several share the slate family, told apart only
  // by their dash, so its key is a short sample of that dash instead of a dot.
  // The dash is read off the dataset: with point styles on, Chart.js builds a
  // legend item from the POINT style, whose lineDash is always empty. Bars keep
  // their own fill and edge.
  const labels = d.plugins.legend.labels;
  labels.color = PALETTE.textMuted;
  labels.usePointStyle = true;
  labels.pointStyle = "circle";
  labels.boxWidth = 8;
  labels.boxHeight = 6 / Math.SQRT2;
  const generateLabels = labels.generateLabels;
  /** @this {any} @param {any} chart */
  labels.generateLabels = function (chart) {
    return generateLabels.call(this, chart).map((/** @type {any} */ item) => {
      if (chart.getDatasetMeta(item.datasetIndex)?.type !== "line") return item;
      const ds = chart.data.datasets[item.datasetIndex] || {};
      if (Array.isArray(ds.borderDash) && ds.borderDash.length) {
        return { ...item, pointStyle: dashSample(item.strokeStyle, ds.borderDash, ds.borderWidth) };
      }
      return { ...item, fillStyle: item.strokeStyle, lineWidth: 0 };
    });
  };

  const t = d.plugins.tooltip;
  t.backgroundColor = rgba(PALETTE.deep, 0.95);
  t.borderColor = PALETTE.border;
  t.borderWidth = 1;
  t.cornerRadius = 0;
  t.titleColor = PALETTE.text;
  t.bodyColor = PALETTE.text;
}
