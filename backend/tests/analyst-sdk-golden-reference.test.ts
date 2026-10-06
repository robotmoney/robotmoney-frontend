// CROSS-IMPLEMENTATION CHECK of the analyst-sdk golden.
//
// packages/analyst-sdk/tests/golden/regime-report.json is produced by the SDK's
// own runRegime, so by itself it only proves "unchanged". This test drives the
// vendored ORIGINAL JS reference (scripts/vendor/regime-reference-js, the same
// driving code as scripts/regime-independent-reference-regenerate.ts) over the
// SDK's own fixture (packages/analyst-sdk/tests/fixtures/raw-indicator-history.csv)
// and asserts the golden's composite, percentiles, panel indices, labels,
// per-indicator rank/signed/weight, correlations and backtest equal it (<1e-9).
// A planted-violation control proves the comparison can fail.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK = join(HERE, "..", "..", "packages", "analyst-sdk", "tests");
const VENDOR = join(HERE, "..", "scripts", "vendor", "regime-reference-js");
const BACKFILL_START = "2018-01-01";
const TOL = 1e-9;

const require = createRequire(import.meta.url);
const { INDICATORS } = require(join(VENDOR, "lib", "indicators.js"));
const { applyTransform } = require(join(VENDOR, "lib", "transforms.js"));
const { buildDateAxis, alignDailyForwardFill, alignDailyZeroFill } = require(join(VENDOR, "lib", "utils.js"));
const { computeRegime } = require(join(VENDOR, "compute.js"));
const { computeCorrelations, computeBacktest, stripDailyFromSnapshot } = require(join(VENDOR, "backtest-correlations.js"));

type Row = { date: string; value: number };

function loadSdkFixture(): Record<string, Row[]> {
  const lines = readFileSync(join(SDK, "fixtures", "raw-indicator-history.csv"), "utf8").split("\n");
  const out: Record<string, Row[]> = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const [date, id, v] = lines[i]!.split(",");
    const value = parseFloat(v!);
    if (!date || !id || !Number.isFinite(value)) continue;
    (out[id] ||= []).push({ date, value });
  }
  for (const id in out) out[id]!.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Same driving code as regime-independent-reference-regenerate.ts.
function runReference() {
  const raw = loadSdkFixture();
  let maxDate = BACKFILL_START;
  for (const id in raw) {
    const rows = raw[id]!;
    if (rows.length && rows[rows.length - 1]!.date > maxDate) maxDate = rows[rows.length - 1]!.date;
  }
  const dateAxis: string[] = buildDateAxis(BACKFILL_START, maxDate);
  const transformed: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const series = raw[ind.id] ?? [];
    if (series.length === 0) {
      transformed[ind.id] = new Array(dateAxis.length).fill(NaN);
      continue;
    }
    const aligner = ind.align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill;
    transformed[ind.id] = applyTransform(ind.transform, aligner(series, dateAxis));
  }
  const result = computeRegime(transformed, dateAxis);
  const extras = { spx: raw.SPX ?? [], eth: raw.ETH ?? [], tbill3m: raw.TBILL3M ?? [] };
  const correlations = computeCorrelations(dateAxis, result, extras);
  const backtest = stripDailyFromSnapshot(computeBacktest(dateAxis, result, extras));
  return { dateAxis, result, correlations, backtest, nExtras: [extras.spx.length, extras.eth.length, extras.tbill3m.length] };
}

// The golden as the report prints it: the last day of the reference arrays,
// NaN as null (JSON has no NaN).
function referenceReport() {
  const { dateAxis, result, correlations, backtest } = runReference();
  const last = dateAxis.length - 1;
  const n = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? null : x);
  const panels: Record<string, unknown> = {};
  for (const p of result.panels as string[]) {
    panels[p] = {
      index: n(result.panelIndices[p][last]),
      percentile: n(result.panelPercentiles[p][last]),
      regime: result.panelRegimes[p]?.[last] ?? null,
    };
  }
  return {
    asof: dateAxis[last],
    days: dateAxis.length,
    regime: {
      label: result.regime[last] ?? null,
      composite: n(result.composite[last]),
      compositePercentile: n(result.compositePercentile[last]),
      panels,
    },
    indicators: (INDICATORS as Array<{ id: string; panel: string; sign: number }>).map((ind) => ({
      id: ind.id,
      panel: ind.panel,
      sign: ind.sign,
      rank: n(result.ranks[ind.id][last]),
      signed: n(result.signed[ind.id][last]),
      weight: result.weightsByPanel[ind.panel]?.[ind.id] ?? null,
    })),
    correlations: JSON.parse(JSON.stringify(correlations)),
    backtest: JSON.parse(JSON.stringify(backtest)),
  };
}

// Returns the list of differences (empty means equal). Numbers within TOL.
function diff(got: any, exp: any, path: string, out: string[], counter: { n: number }): void {
  if (typeof exp === "number" && typeof got === "number") {
    counter.n++;
    if (Math.abs(got - exp) > TOL * Math.max(1, Math.abs(exp))) out.push(`${path}: ${got} vs ${exp}`);
    return;
  }
  if (exp === null || typeof exp !== "object" || got === null || typeof got !== "object") {
    counter.n++;
    if (got !== exp) out.push(`${path}: ${JSON.stringify(got)} vs ${JSON.stringify(exp)}`);
    return;
  }
  if (Array.isArray(exp) !== Array.isArray(got)) {
    out.push(`${path}: array/object mismatch`);
    return;
  }
  const ek = Object.keys(exp).sort();
  const gk = Object.keys(got).sort();
  if (JSON.stringify(ek) !== JSON.stringify(gk)) {
    out.push(`${path}: keys ${gk.join("|")} vs ${ek.join("|")}`);
    return;
  }
  for (const k of ek) diff(got[k], exp[k], `${path}.${k}`, out, counter);
}

const golden = JSON.parse(readFileSync(join(SDK, "golden", "regime-report.json"), "utf8"));
const ref = referenceReport();

describe("analyst-sdk golden equals the original JS reference", () => {
  test("composite, percentiles, panel indices, labels, indicators, correlations and backtest match (<1e-9)", () => {
    const counter = { n: 0 };
    const out: string[] = [];
    // The golden also carries `version`, which is SDK metadata the reference has no notion of.
    const { version: _v, ...goldenBody } = golden;
    diff(goldenBody, ref, "report", out, counter);
    expect(out.slice(0, 10)).toEqual([]);
    // The comparison actually ran over a large surface, not a lone leaf.
    expect(counter.n).toBeGreaterThan(1000);
    expect(golden.regime.label).toBe(ref.regime.label);
    expect(golden.asof).toBe(ref.asof);
    expect(Number.isFinite(golden.regime.composite)).toBe(true);
  });

  test("the reference ran over the SDK fixture's full extras", () => {
    const { nExtras } = runReference();
    for (const n of nExtras) expect(n).toBeGreaterThan(1000);
  });

  test("planted violations are caught: one perturbed golden value fails the comparison", () => {
    const { version: _v, ...base } = golden;
    const cases: Array<[string, (g: any) => void]> = [
      ["composite", (g) => (g.regime.composite += 1e-6)],
      ["compositePercentile", (g) => (g.regime.compositePercentile += 1e-6)],
      ["panel index", (g) => (g.regime.panels.macro.index -= 1e-6)],
      ["panel percentile", (g) => (g.regime.panels.onchain.percentile += 1e-6)],
      ["label", (g) => (g.regime.label = g.regime.label === "neutral" ? "risk_on" : "neutral")],
      ["panel label", (g) => (g.regime.panels.macro.regime = "risk_off")],
      ["indicator weight", (g) => (g.indicators[0].weight += 1e-6)],
      ["correlation", (g) => (g.correlations.forward.composite.spx_30d.rho += 1e-6)],
    ];
    for (const [name, mutate] of cases) {
      const copy = JSON.parse(JSON.stringify(base));
      mutate(copy);
      const out: string[] = [];
      diff(copy, ref, "report", out, { n: 0 });
      expect(out.length, `perturbing ${name} must fail the comparison`).toBeGreaterThan(0);
    }
    // And the unperturbed copy passes, so the control is not failing for another reason.
    const clean: string[] = [];
    diff(JSON.parse(JSON.stringify(base)), ref, "report", clean, { n: 0 });
    expect(clean).toEqual([]);
  });
});
