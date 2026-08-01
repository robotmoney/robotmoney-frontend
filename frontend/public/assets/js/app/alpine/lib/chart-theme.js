// Dash Chart.js theme extension (docs/bot-analytics-ui-port-plan.md §4.2,
// issue #381). Every recharts LineChart/AreaChart in the retired
// robotmoney-bot-analytics app (PerformanceChart, ProjectProfile ChartCard,
// VaultProfile Yield History) becomes Chart.js here — this file is the
// shared visual baseline all of those per-view factories apply on top of
// (§4.2's translation table: no-dot line, dashed 30%-alpha grid, hidden X
// axis, mono Y ticks).
//
// Deliberately NOT `app/lib/chart-theme.js` (the marketing chart theme):
// that file calls `Chart.defaults` ONCE, globally, via `applyChartDefaults()`
// — every marketing chart on the site inherits it. The dashboard needs a
// DIFFERENT look scoped to `.a3` fragments only (dash.css §2), so mutating
// the same global would leak dash styling onto marketing charts (or vice
// versa) the moment both are on the page. Chart.js supports per-instance
// option overrides that beat the global defaults for that one chart instead —
// `dashChartOptions`/`dashLineDatasetDefaults` build that per-instance config;
// marketing charts that never call them are completely unaffected.
//
// Bake the theme into `new Chart(canvas, config)`'s OWN config
// (`dashChartOptions`/`dashLineDatasetDefaults`) rather than mutating an
// already-constructed chart's `options`/`data.datasets` and forcing a
// `chart.update()`. Both read the SAME resolved theme and produce identical
// values, but only the construction-time path is safe here: reproduced while
// building this (see the dash-styleguide spec's "home has no .a3 element"
// test, which does not wait for the canvas before checking console errors,
// so it caught what a canvas-waiting assertion did not) — calling
// `chart.update()` synchronously right after constructing a chart mounted by
// Alpine (a `x-ref` canvas inside an `x-data` tree that is itself still being
// walked by Alpine's own initial-mount MutationObserver) threw "Maximum call
// stack size exceeded" inside Chart.js's option resolver. Deferring the
// `update()` call by a tick, a `requestAnimationFrame`, or even two, did not
// reliably avoid it either — it is a genuine race, not a fixed-delay problem.
// `applyDashChartDefaults(chart)` (below) still exists for the case a chart
// needs re-theming AFTER it has already painted with different options (no
// call site needs that today — every existing chart factory in this codebase
// destroys and reconstructs on data reload rather than re-theming in place);
// that function's own doc comment repeats this warning at its `chart.update()`
// call site.
//
// Colors are read from dash.css's `.a3` scope at call time (the chart's own
// canvas — CSS custom properties inherit from the nearest `.a3` ancestor)
// rather than redeclared here as hex literals, per the #380 integration
// handoff: "dash.css already has the `--chart-1..5` tokens... your dash
// Chart.js theme should read those, not redeclare hues." dash.css tokens are
// bare `H S% L%` triples (Tailwind/shadcn convention, no `hsl()` wrapper) so
// they can be dropped straight into CSS Color 4 `hsl(H S% L% / A)` syntax for
// alpha variants (grid lines, area gradients) with no RGB math needed.

const CHART_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

// Fallbacks only apply when a var is unset on the queried element — e.g. a
// bare `<canvas>` in a unit test with no dash.css loaded, or a chart mounted
// outside the `.a3` scope by mistake. Verbatim dash.css `.a3` values.
const FALLBACK = {
  series: [
    "186 100% 50%", // --chart-1 cyan
    "270 60% 55%", // --chart-2 purple
    "142 70% 45%", // --chart-3 green
    "38 90% 55%", // --chart-4 amber
    "340 75% 55%", // --chart-5 pink
  ],
  border: "216 24% 18%",
  mutedForeground: "220 12% 60%",
  foreground: "230 15% 90%",
  background: "222 33% 4%",
};

// Shared axis/tooltip typography — the original's mono tick font throughout
// (PerformanceChart Y width 60 fontSize 10, ChartCard Y width 50 fontSize 9;
// callers pass `{ tickFont: 9 }` for the ChartCard variant).
const MONO_FAMILY = "JetBrains Mono";

function hslVar(style, name, fallback) {
  const raw = style.getPropertyValue(name).trim();
  return raw || fallback;
}

/**
 * Read the five `--chart-1..5` series colors plus the border/muted-foreground
 * tokens off the nearest `.a3` ancestor of `el`, as ready-to-use
 * `hsl(...)`/`hsl(... / a)` strings.
 * @param {Element} el any element inside the `.a3` scope (a chart's canvas is fine)
 * @returns {{series:string[], hsl:(i:number, alpha?:number)=>string, border:(alpha?:number)=>string, mutedForeground:(alpha?:number)=>string, foreground:(alpha?:number)=>string, background:(alpha?:number)=>string}}
 */
export function readDashChartTheme(el) {
  const style = getComputedStyle(el);
  const seriesRaw = CHART_VARS.map((v, i) => hslVar(style, v, FALLBACK.series[i]));
  const borderRaw = hslVar(style, "--border", FALLBACK.border);
  const mutedRaw = hslVar(style, "--muted-foreground", FALLBACK.mutedForeground);
  const fgRaw = hslVar(style, "--foreground", FALLBACK.foreground);
  const bgRaw = hslVar(style, "--background", FALLBACK.background);
  const toHsl = (raw, alpha) => (alpha == null ? `hsl(${raw})` : `hsl(${raw} / ${alpha})`);
  return {
    series: seriesRaw.map((raw) => toHsl(raw)),
    /** @param {number} i 0-based series index, wraps past 5. @param {number} [alpha] */
    hsl: (i, alpha) => toHsl(seriesRaw[i % seriesRaw.length], alpha),
    border: (alpha) => toHsl(borderRaw, alpha),
    mutedForeground: (alpha) => toHsl(mutedRaw, alpha),
    foreground: (alpha) => toHsl(fgRaw, alpha),
    background: (alpha) => toHsl(bgRaw, alpha),
  };
}

/**
 * Build a `CanvasGradient` for the AreaChart fill fade (VaultProfile Yield
 * History: primary color 0.3 alpha at the top fading to 0 alpha at the
 * bottom, §4.2). Pass the chart's own canvas 2D context and chart area.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{top:number, bottom:number}} chartArea
 * @param {string} hslRaw bare `H S% L%` triple (e.g. from `readDashChartTheme`'s series entries before wrapping — pass a plain hue triple, not a full `hsl(...)` string)
 * @param {number} [fromAlpha]
 * @param {number} [toAlpha]
 */
export function dashAreaGradient(ctx, chartArea, hslRaw, fromAlpha = 0.3, toAlpha = 0) {
  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, `hsl(${hslRaw} / ${fromAlpha})`);
  gradient.addColorStop(1, `hsl(${hslRaw} / ${toAlpha})`);
  return gradient;
}

/**
 * Build a plain Chart.js `options` object carrying the dash theme (§4.2's
 * cross-cutting baseline: no-dot line, dashed 30%-alpha grid, hidden X axis,
 * mono ticks/tooltip), resolved from `canvas`'s `.a3` scope. Spread this
 * straight into a `new Chart(canvas, { options: {...} })` call so the
 * chart's very FIRST paint already carries the theme (Chart.js renders a
 * `responsive:true` chart from exactly the `options` it was constructed
 * with — no async gap to beat). This is the preferred, safe call site for
 * every new chart; see the module header comment for why mutating an
 * existing chart's options and forcing a redraw is NOT.
 * @param {Element} canvas the chart's own `<canvas>` (or any `.a3`-scoped element)
 * @param {{showXAxis?:boolean, gridAlpha?:number, tickFontSize?:number, yTickCallback?:(value:number)=>string}} [opts]
 */
export function dashChartOptions(canvas, opts = {}) {
  const showXAxis = opts.showXAxis ?? false;
  const gridAlpha = opts.gridAlpha ?? 0.3;
  const tickFontSize = opts.tickFontSize ?? 10;
  const theme = readDashChartTheme(canvas);
  const font = { family: MONO_FAMILY, size: tickFontSize };
  const tickOpts = { color: theme.mutedForeground(), font };
  const gridOpts = { color: theme.border(gridAlpha), borderDash: /** @type {[number,number]} */ ([3, 3]) };
  return {
    color: theme.mutedForeground(),
    animation: false,
    font: { family: MONO_FAMILY, size: tickFontSize },
    scales: {
      x: { display: showXAxis, grid: gridOpts, ticks: tickOpts },
      y: { grid: gridOpts, ticks: opts.yTickCallback ? { ...tickOpts, callback: opts.yTickCallback } : tickOpts },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: theme.background(0.95),
        titleColor: theme.foreground(),
        bodyColor: theme.foreground(),
        borderColor: theme.border(),
        borderWidth: 1,
        titleFont: { family: MONO_FAMILY },
        bodyFont: { family: MONO_FAMILY },
      },
    },
  };
}

/**
 * The no-dot-line leaf defaults (`tension:0, pointRadius:0, borderWidth:2,
 * borderColor:<series i>`) every dash line dataset shares (§4.2). Spread
 * into each `data.datasets[i]` at construction time, same rationale as
 * `dashChartOptions` above — dataset styling needs a real redraw to appear
 * too, so it belongs in the initial config, not a post-construction mutation.
 * @param {Element} canvas
 * @param {number} [seriesIndex] which of the 5 `--chart-1..5` colors (wraps)
 */
export function dashLineDatasetDefaults(canvas, seriesIndex = 0) {
  const theme = readDashChartTheme(canvas);
  return { tension: 0, pointRadius: 0, borderWidth: 2, borderColor: theme.hsl(seriesIndex) };
}

/**
 * Apply the dash Chart.js theme to one chart instance (§4.2's cross-cutting
 * baseline, shared by PerformanceChart/ChartCard/Yield History). Mutates
 * `chart.options`/`chart.data.datasets[*]` in place and returns the resolved
 * theme — it does NOT call `chart.update()`/`chart.draw()` (see the module
 * header comment for why forcing a redraw here is unsafe), so mutating an
 * ALREADY-PAINTED chart with this function leaves the old paint on screen
 * until something else redraws it.
 *
 * Prefer `dashChartOptions`/`dashLineDatasetDefaults` above at construction
 * time for every new call site. Use this function only when a chart must be
 * re-themed after it already exists (e.g. a future dashboard's theme toggle)
 * — call it, then let YOUR OWN existing redraw path (a chart destroy+
 * reconstruct on the next data load, same as every chart factory in this
 * codebase already does) pick up the mutated options; do not add a
 * `chart.update()` call after it.
 *
 * Defaults match the PerformanceChart/ChartCard row of §4.2: no-dot line
 * (`tension:0, pointRadius:0, borderWidth:2`), dashed grid at 30% alpha,
 * hidden X axis, mono Y ticks, mono tooltip. Pass `opts` to match a
 * differing row (Yield History shows its X axis and uses 40% grid alpha).
 * @param {import("chart.js").Chart} chart
 * @param {{showXAxis?:boolean, gridAlpha?:number, tickFontSize?:number, yTickCallback?:(value:number)=>string}} [opts]
 */
export function applyDashChartDefaults(chart, opts = {}) {
  const showXAxis = opts.showXAxis ?? false;
  const gridAlpha = opts.gridAlpha ?? 0.3;
  const tickFontSize = opts.tickFontSize ?? 10;

  const theme = readDashChartTheme(chart.canvas);
  const o = chart.options;

  // IMPORTANT: mutate LEAF properties in place; never replace a whole nested
  // option object with a spread copy (`x.grid = {...x.grid, ...}`). Chart.js
  // backs `chart.options` sub-objects (scales, plugins.*) with a "scriptable/
  // indexable" Proxy that resolves context-dependent values (functions,
  // per-index arrays) lazily on property access. Spreading one of those
  // triggers a GET on every enumerable key during the copy, which re-enters
  // Chart.js's own resolver and throws "Recursion detected: _scriptable-
  // >_scriptable" (reproduced while building this — see the dash-styleguide
  // spec). Deep, guarded leaf assignment is the documented-safe way to
  // update options on an already-constructed chart.
  o.color = theme.mutedForeground();
  o.animation = false; // matches the rest of the site's chart factories (fee-chart.js, regime.js)
  if (o.font) {
    o.font.family = MONO_FAMILY;
    o.font.size = tickFontSize;
  }

  const x = o.scales?.x;
  if (x) {
    x.display = showXAxis;
    if (x.grid) {
      x.grid.color = theme.border(gridAlpha);
      x.grid.borderDash = [3, 3];
    }
    if (x.ticks) {
      x.ticks.color = theme.mutedForeground();
      if (x.ticks.font) {
        x.ticks.font.family = MONO_FAMILY;
        x.ticks.font.size = tickFontSize;
      }
    }
  }

  const y = o.scales?.y;
  if (y) {
    if (y.grid) {
      y.grid.color = theme.border(gridAlpha);
      y.grid.borderDash = [3, 3];
    }
    if (y.ticks) {
      y.ticks.color = theme.mutedForeground();
      if (y.ticks.font) {
        y.ticks.font.family = MONO_FAMILY;
        y.ticks.font.size = tickFontSize;
      }
      if (opts.yTickCallback) y.ticks.callback = opts.yTickCallback;
    }
  }

  if (o.plugins?.legend) {
    if (o.plugins.legend.display === undefined) o.plugins.legend.display = false;
    if (o.plugins.legend.labels) o.plugins.legend.labels.color = theme.mutedForeground();
  }

  const tooltip = o.plugins?.tooltip;
  if (tooltip) {
    tooltip.backgroundColor = theme.background(0.95);
    tooltip.titleColor = theme.foreground();
    tooltip.bodyColor = theme.foreground();
    tooltip.borderColor = theme.border();
    tooltip.borderWidth = 1;
    if (tooltip.titleFont) tooltip.titleFont.family = MONO_FAMILY;
    else tooltip.titleFont = { family: MONO_FAMILY };
    if (tooltip.bodyFont) tooltip.bodyFont.family = MONO_FAMILY;
    else tooltip.bodyFont = { family: MONO_FAMILY };
  }

  for (const ds of chart.data?.datasets || []) {
    if (ds.type === "line" || chart.config.type === "line") {
      if (ds.tension === undefined) ds.tension = 0;
      if (ds.pointRadius === undefined) ds.pointRadius = 0;
      if (ds.borderWidth === undefined) ds.borderWidth = 2;
      if (ds.borderColor === undefined) ds.borderColor = theme.series[0];
    }
  }

  // Deliberately NO `chart.update()`/`chart.draw()` call here — see the
  // module header comment and this function's own doc comment above.
  return theme;
}
