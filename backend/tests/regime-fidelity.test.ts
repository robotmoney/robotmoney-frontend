// REGIME FIDELITY: deterministic replay of the vendored raw-indicator-history
// fixture through our ported transform + computeRegime must reproduce the
// original's committed numbers.
//
// Replay path (verified against scripts/regime/update.js):
//   load raw-indicator-history.csv (aligned RAW, pre-transform)
//   → build date axis 2018-01-01..maxDate
//   → align each registry indicator (forward-fill; zero-fill if align==='zero_fill')
//   → applyTransform(ind.transform, aligned)
//   → computeRegime(transformed, dateAxis)
// Registry indicators absent from the fixture (e.g. BTC_MVRV — the fixture was
// captured while blockchain.com's mvrv chart was dead, before the #127 repoint
// to Coinmetrics CapMVRVCur) are fed an all-NaN series so they are excluded via
// minValidObs, never throw.
//
// ── Why the historical rows can't be matched to <1e-6, and why that is correct ──
// update.js's normal cron path calls mergeFrozenIntoResult(): every PAST row is
// kept FROZEN from the regime-history.csv baseline (locked against the raw data
// vintage available when that day was first computed), and only the `asof` day is
// recomputed fresh. Meanwhile raw-indicator-history.csv keeps being revised
// (append-only mergeSeries; "fetched wins on overlap"). So a fresh recompute from
// the *committed* raw will NOT reproduce frozen historical rows that were computed
// from an *earlier* raw vintage. We verified the original JS itself reproduces its
// own committed regime-history.csv only to maxCompositeDiff≈0.0725 / 9 label rows —
// i.e. the residual is inherent data vintage, not a port defect. Our TS port was
// separately confirmed BYTE-IDENTICAL to the original JS compute (maxDiff = 0 over
// all 2968 rows). Therefore the strict proof of methodology fidelity is the exact
// reproduction of the FRESH artifacts (the `asof` row + the live regime-snapshot.json
// last day, all weights/percentiles), and the historical rows are asserted to TRACK
// the committed baseline within the inherent drift bound.
import { test, expect } from "bun:test";
import {
  loadRawIndicatorHistory,
  loadRegimeHistory,
  loadJsonGz,
  loadRegimeComputeReference,
} from "./fixtures/regime/load.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { computeRegime } from "../src/analytics/analyze/compute.ts";
import {
  buildDateAxis,
  alignDailyForwardFill,
  alignDailyZeroFill,
} from "../src/analytics/transform/math.ts";
import { applyTransform } from "../src/analytics/transform/transforms.ts";

const BACKFILL_START = "2018-01-01";

async function replay() {
  const raw = await loadRawIndicatorHistory();
  let maxDate = BACKFILL_START;
  for (const id in raw) {
    const rows = raw[id];
    if (rows.length && rows[rows.length - 1].date > maxDate) maxDate = rows[rows.length - 1].date;
  }
  const dateAxis = buildDateAxis(BACKFILL_START, maxDate);
  const nanSeries = new Array(dateAxis.length).fill(NaN);
  const transformed: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const series = raw[ind.id] ?? [];
    if (series.length === 0) {
      transformed[ind.id] = nanSeries.slice();
      continue;
    }
    const aligner = (ind as any).align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill;
    transformed[ind.id] = applyTransform(ind.transform, aligner(series, dateAxis));
  }
  const result = computeRegime(transformed, dateAxis);
  return { result, dateAxis, transformed, raw };
}

const NUMERIC = [
  "macro_index", "onchain_index", "composite", "composite_percentile",
  "macro_percentile", "onchain_percentile",
] as const;

test("regime fidelity (STRICT): the fresh `asof` row of regime-history.csv reproduces exactly", async () => {
  const { result, dateAxis } = await replay();
  const expected = await loadRegimeHistory();
  expect(expected.length).toBeGreaterThan(2900);

  const idxOf = new Map(dateAxis.map((d, i) => [d, i]));
  const asof = expected[expected.length - 1]; // the only freshly-computed (non-frozen) row
  const i = idxOf.get(asof.date)!;
  expect(i, `asof ${asof.date} must be on the date axis`).toBeGreaterThan(0);

  const got: Record<string, number> = {
    macro_index: result.macroIndex![i],
    onchain_index: result.onchainIndex![i],
    composite: result.composite[i],
    composite_percentile: result.compositePercentile[i],
    macro_percentile: result.macroPercentile![i],
    onchain_percentile: result.onchainPercentile![i],
  };
  let assertions = 0;
  for (const col of NUMERIC) {
    expect(Math.abs(got[col] - (asof as any)[col]), `asof ${col}`).toBeLessThan(1e-6);
    assertions++;
  }
  expect(result.macroRegime![i]).toBe(asof.macro_regime);
  expect(result.onchainRegime![i]).toBe(asof.onchain_regime);
  expect(result.regime[i]).toBe(asof.regime);
  expect(assertions).toBeGreaterThan(0);
});

test("regime fidelity (STRICT): full last-day pipeline matches the committed regime-snapshot.json exactly", async () => {
  const { result, dateAxis, transformed } = await replay();
  const snap: any = await loadJsonGz("regime-snapshot.json.gz");
  const i = dateAxis.length - 1; // snapshot is always the last axis day
  expect(dateAxis[i]).toBe(snap.asof);

  // composite / percentile / regime / panel indices + percentiles
  expect(Math.abs(result.composite[i] - snap.composite)).toBeLessThan(1e-9);
  expect(Math.abs(result.compositePercentile[i] - snap.composite_percentile)).toBeLessThan(1e-9);
  expect(result.regime[i]).toBe(snap.regime);
  expect(Math.abs(result.macroIndex![i] - snap.macro_index)).toBeLessThan(1e-9);
  expect(Math.abs(result.onchainIndex![i] - snap.onchain_index)).toBeLessThan(1e-9);
  expect(Math.abs(result.macroPercentile![i] - snap.macro_percentile)).toBeLessThan(1e-9);
  expect(Math.abs(result.onchainPercentile![i] - snap.onchain_percentile)).toBeLessThan(1e-9);

  // every macro+onchain indicator: percentile, signed_percentile, panel_weight,
  // transformed_value — all match to floating-point tolerance.
  let perInd = 0;
  for (const ind of snap.indicators) {
    const p = result.ranks[ind.id]?.[i];
    const sgn = result.signed[ind.id]?.[i];
    const w = result.weightsByPanel[ind.panel]?.[ind.id] ?? 0;
    const tv = transformed[ind.id]?.[i];
    if (ind.percentile == null) {
      expect(Number.isFinite(p), `${ind.id} should be NaN-percentile`).toBe(false);
    } else {
      expect(Math.abs(p - ind.percentile), `${ind.id} percentile`).toBeLessThan(1e-9);
      expect(Math.abs(sgn - ind.signed_percentile), `${ind.id} signed`).toBeLessThan(1e-9);
      expect(Math.abs(tv - ind.transformed_value), `${ind.id} transformed`).toBeLessThanOrEqual(
        Math.max(1e-6, Math.abs(ind.transformed_value) * 1e-9),
      );
    }
    expect(Math.abs(w - (ind.panel_weight ?? 0)), `${ind.id} weight`).toBeLessThan(1e-9);
    perInd++;
  }
  expect(perInd).toBeGreaterThan(15);
});

// ── STRICT multi-day proof of ALGORITHM-PORT fidelity (option B) ──────────────
// The committed regime-history.csv can only be matched to <1e-9 on the single
// freshly-recomputed `asof` row (see the two STRICT tests above): every earlier
// row is FROZEN from an earlier raw-data vintage, so a fresh recompute from the
// committed raw legitimately diverges (empirically: 2nd-most-recent row already
// ~1.7e-2, historical rows up to ~0.27). That divergence is a data-vintage
// artifact, NOT a port defect — so to prove multi-day methodology fidelity we
// compare against a REFERENCE computed by the ORIGINAL JS pipeline over the SAME
// vendored raw fixture.
//
// regime-compute-reference.json.gz (≈127 KB gz, 3102 rows) was produced by
// driving agentjuno/robotmoney scripts/regime end-to-end — lib/utils
// (buildDateAxis + alignDailyForwardFill/ZeroFill) → lib/transforms.applyTransform
// → compute.js computeRegime (2-panel [macro, onchain] default) — over
// raw-indicator-history.csv.gz, i.e. the identical align+transform+compute path
// update.js uses. Our TS port must reproduce it BYTE-IDENTICALLY (<1e-12) across
// EVERY axis row plus exact regime/macro/onchain labels. A regression in the
// ported math (rank, sign-align, inverse-correlation weights, composite,
// smoothing) fails here even though the frozen-CSV tracking test would still pass.
test("regime fidelity (STRICT, multi-day): our TS computeRegime reproduces the ORIGINAL JS pipeline to <1e-12 across ALL rows + exact labels", async () => {
  const { result, dateAxis } = await replay();
  const ref = await loadRegimeComputeReference();

  // Same raw fixture → identical date axis (same length + values).
  expect(dateAxis.length).toBe(ref.dateAxis.length);
  expect(dateAxis.length).toBeGreaterThan(2900);
  expect(dateAxis[0]).toBe(ref.dateAxis[0]);
  expect(dateAxis[dateAxis.length - 1]).toBe(ref.dateAxis[dateAxis.length - 1]);
  // Registry parity: same indicator set fed to both pipelines.
  expect(ref.meta.indicators.length).toBe(26);

  const NUM_SERIES = [
    "composite", "compositePercentile", "macroIndex", "onchainIndex",
    "macroPercentile", "onchainPercentile",
  ] as const;
  const LABEL_SERIES = ["regime", "macroRegime", "onchainRegime"] as const;

  const tsNum: Record<(typeof NUM_SERIES)[number], number[]> = {
    composite: result.composite,
    compositePercentile: result.compositePercentile,
    macroIndex: result.macroIndex!,
    onchainIndex: result.onchainIndex!,
    macroPercentile: result.macroPercentile!,
    onchainPercentile: result.onchainPercentile!,
  };
  const tsLbl: Record<(typeof LABEL_SERIES)[number], (string | null)[]> = {
    regime: result.regime,
    macroRegime: result.macroRegime!,
    onchainRegime: result.onchainRegime!,
  };

  let maxDiff = 0;
  let numericCompared = 0;
  let labelCompared = 0;
  let firstRegimeIdx = -1;
  for (let i = 0; i < dateAxis.length; i++) {
    for (const s of NUM_SERIES) {
      const a = tsNum[s][i];
      const b = ref[s][i];
      const aFin = Number.isFinite(a);
      const bFin = b != null && Number.isFinite(b);
      expect(aFin, `${s}[${dateAxis[i]}] finiteness must match reference`).toBe(bFin);
      if (aFin && bFin) {
        const d = Math.abs(a - (b as number));
        maxDiff = Math.max(maxDiff, d);
        expect(d, `${s}[${dateAxis[i]}]`).toBeLessThan(1e-12);
        numericCompared++;
      }
    }
    for (const s of LABEL_SERIES) {
      expect(tsLbl[s][i], `${s}[${dateAxis[i]}]`).toBe(ref[s][i]);
      if (ref[s][i] != null) labelCompared++;
    }
    if (firstRegimeIdx < 0 && ref.regime[i] != null) firstRegimeIdx = i;
  }

  // Prove the strict window is the WHOLE classified history, not a lone row.
  const classifiedRows = ref.regime.filter((r) => r != null).length;
  console.log(
    `[regime-fidelity] STRICT vs original-JS reference: axisRows=${dateAxis.length} ` +
      `classifiedRows=${classifiedRows} numericCompared=${numericCompared} ` +
      `labelCompared=${labelCompared} maxAbsDiff=${maxDiff.toExponential(3)}`,
  );
  expect(classifiedRows).toBeGreaterThan(2900); // strict labels span the entire history
  expect(numericCompared).toBeGreaterThan(6 * 2900); // 6 numeric series × ~2960 rows
  expect(maxDiff).toBeLessThan(1e-12);
});

test("regime fidelity (TRACKING): full history tracks the frozen regime-history.csv within the inherent data-vintage drift", async () => {
  const { result, dateAxis } = await replay();
  const expected = await loadRegimeHistory();
  const idxOf = new Map(dateAxis.map((d, i) => [d, i]));

  let compared = 0;
  let within1e3 = 0;
  let labelMatch = 0;
  let maxComposite = 0;
  for (const e of expected) {
    const i = idxOf.get(e.date);
    if (i == null || !result.regime[i]) continue;
    compared++;
    const d = Math.abs(result.composite[i] - e.composite);
    maxComposite = Math.max(maxComposite, d);
    if (d < 1e-3) within1e3++;
    if (result.regime[i] === e.regime) labelMatch++;
  }
  const pctWithin = within1e3 / compared;
  const pctLabel = labelMatch / compared;
  console.log(
    `[regime-fidelity] tracking: compared=${compared} composite<1e-3=${(100 * pctWithin).toFixed(2)}% ` +
      `regimeLabelMatch=${(100 * pctLabel).toFixed(2)}% maxCompositeDiff=${maxComposite}`,
  );
  // These bounds reflect the frozen-baseline data vintage (the original JS shows
  // the identical residual against its own committed CSV). A regression in the
  // methodology would blow past them.
  expect(compared).toBeGreaterThan(2900);
  expect(pctWithin).toBeGreaterThan(0.94); // ≈95.5% of rows track within 1e-3
  expect(pctLabel).toBeGreaterThan(0.995); // ≈99.7% regime-label agreement
  expect(maxComposite).toBeLessThan(0.08);
});
