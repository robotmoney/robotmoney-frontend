// Issue 1739: a day's weights, panel indices, composite, percentiles and label
// depend only on the methodology version and the data up to that day, never on
// the run's last day.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  computeRegime,
  parseRawHistory,
  prepareRegimeInputs,
  toHistory,
  WeightAnchorOutOfRangeError,
  REGIME_WEIGHT_REFRESH,
  isRefreshDate,
  refreshDateOn,
  PANELS,
} from "../src/index.ts";

const text = await Bun.file(join(import.meta.dir, "fixtures/raw-indicator-history.csv")).text();
const raw = toHistory(parseRawHistory(text));
let asof = "2018-01-01";
for (const id in raw) for (const r of raw[id]!) if (r.date > asof) asof = r.date;
const prepared = prepareRegimeInputs(raw, { start: "2018-01-01", asof });
const { dateAxis, transformed, ages } = prepared;
const N = dateAxis.length;

const slice = (n: number) => {
  const data: Record<string, number[]> = {};
  for (const k of Object.keys(transformed)) data[k] = transformed[k].slice(0, n);
  const a: Record<string, number[]> = {};
  for (const k of Object.keys(ages)) a[k] = ages[k].slice(0, n);
  return { data, axis: dateAxis.slice(0, n), ages: a };
};
const run = (n: number, version: "v3" | "v4" = "v4", rec = false) => {
  const s = slice(n);
  return computeRegime(s.data, s.axis, PANELS, s.ages, undefined, version, undefined, undefined, { recordWeightFits: rec });
};

describe("weights run invariance (issue 1739)", () => {
  const full = run(N, "v4", true);
  const sampled = [N - 1, N - 2, N - 30, N - 100, Math.floor(N / 2)];

  test("a run ending on day t equals row t of the full run", () => {
    for (const t of sampled) {
      const part = run(t + 1);
      const p = part.dateAxis.length - 1;
      expect(part.dateAxis[p]).toBe(full.dateAxis[t]);
      for (const panel of PANELS) {
        expect(part.panelIndices[panel][p]).toBe(full.panelIndices[panel][t]);
        expect(part.panelPercentiles[panel][p]).toBe(full.panelPercentiles[panel][t]);
        expect(part.panelRegimes[panel][p]).toBe(full.panelRegimes[panel][t]);
      }
      expect(part.composite[p]).toBe(full.composite[t]);
      expect(part.compositePercentile[p]).toBe(full.compositePercentile[t]);
      expect(part.regime[p]).toBe(full.regime[t]);
      const fitsAt = (r: typeof full) => r.weightFitDate;
      expect(fitsAt(part)).toBe(refreshDateOn(full.dateAxis[t], REGIME_WEIGHT_REFRESH.v4));
    }
  });

  test("every fit date is a refresh date and weightFitDate is the last day's refresh date", () => {
    for (const f of full.weightFits!) expect(isRefreshDate(f.date, REGIME_WEIGHT_REFRESH.v4)).toBe(true);
    expect(full.weightFitDate).toBe(refreshDateOn(dateAxis[N - 1], REGIME_WEIGHT_REFRESH.v4));
    const last = full.weightFits![full.weightFits!.length - 1];
    expect(last.date).toBe(full.weightFitDate!);
    expect(full.weightsByPanel).toEqual(last.weights);
  });

  test("weightFits is absent unless requested", () => {
    expect(run(N).weightFits).toBeUndefined();
  });

  test("a fit is unchanged when every row after it is removed", () => {
    const f = full.weightFits![full.weightFits!.length - 3];
    const idx = dateAxis.indexOf(f.date);
    expect(run(idx + 1).weightsByPanel).toEqual(f.weights);
  });

  test("v3 keeps the legacy refit on the run's last day", () => {
    const v3 = run(N - 5, "v3");
    expect(v3.weightFitDate).toBe(dateAxis[N - 6]);
  });

  test("an axis starting between refresh dates throws WeightAnchorOutOfRangeError", () => {
    const s = slice(N);
    const off = 10;
    const cut = (r: Record<string, number[]>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.slice(off)]));
    expect(() => computeRegime(cut(s.data), s.axis.slice(off), PANELS, cut(s.ages))).toThrow(WeightAnchorOutOfRangeError);
  });

  test("an axis starting on a refresh date fits at its own first day", () => {
    const s = slice(N);
    const off = 21 * 3;
    const cut = (r: Record<string, number[]>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.slice(off)]));
    const r = computeRegime(cut(s.data), s.axis.slice(off), PANELS, cut(s.ages), undefined, "v4", undefined, undefined, { recordWeightFits: true });
    expect(r.weightFits![0].date).toBe(s.axis[off]);
  });
});
