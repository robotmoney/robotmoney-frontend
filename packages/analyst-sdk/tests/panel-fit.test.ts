// Issue 1751, gap 4: fitPanelWeights and weightedMeanOnDay are the two
// functions computeRegime fits and averages with, so one day fitted from scores
// computed once equals what the full run produced on that day, as doubles.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  computeRegime,
  fitPanelWeights,
  parseRawHistory,
  prepareRegimeInputs,
  toHistory,
  weightedMeanOnDay,
  INDICATORS,
  PANELS,
  REGIME_RULES,
  type RegimeVersion,
} from "../src/index.ts";

setDefaultTimeout(120_000);

const raw = toHistory(parseRawHistory(await Bun.file(join(import.meta.dir, "fixtures/raw-indicator-history.json")).text()));
let asof = "2018-01-01";
for (const id in raw) for (const r of raw[id]!) if (r.date > asof) asof = r.date;
const panelIndicators = (p: string) => INDICATORS.filter((i) => i.panel === p);

function fullRun(version: RegimeVersion) {
  const prepared = prepareRegimeInputs(raw, { start: "2018-01-01", asof, version });
  const result = computeRegime(prepared.transformed, prepared.dateAxis, PANELS, prepared.ages, undefined, version, undefined, undefined, { recordWeightFits: true }, prepared.carried);
  return { prepared, result };
}

describe("one-day panel fit (issue 1751)", () => {
  for (const version of ["v4", "v3"] as const) {
    test(`${version}: every recorded weight fit and that day's panel index are reproduced exactly`, () => {
      const { prepared, result } = fullRun(version);
      const fits = result.weightFits!;
      expect(fits.length).toBeGreaterThan(100);
      let finiteIndices = 0;
      for (const fit of fits) {
        const day = result.dateAxis.indexOf(fit.date);
        expect(day).toBeGreaterThanOrEqual(0);
        for (const p of PANELS) {
          const weights = fitPanelWeights(result.signed, panelIndicators(p), day, { rules: REGIME_RULES[version], carried: prepared.carried });
          expect(Object.keys(weights)).toEqual(Object.keys(fit.weights[p]!));
          for (const id of Object.keys(weights)) expect(Object.is(weights[id], fit.weights[p]![id])).toBe(true);
          const index = weightedMeanOnDay(result.signed, weights, panelIndicators(p), day);
          expect(Object.is(index, result.panelIndices[p]![day])).toBe(true);
          if (Number.isFinite(index)) finiteIndices++;
        }
      }
      expect(finiteIndices).toBeGreaterThan(200);
    });
  }

  test("a day between two fits is the weighted mean under the weights of the fit before it", () => {
    const { prepared, result } = fullRun("v4");
    const fits = result.weightFits!;
    const fit = fits[fits.length - 3]!;
    const day = result.dateAxis.indexOf(fit.date) + 10;
    expect(result.dateAxis[day]! < fits[fits.length - 2]!.date).toBe(true);
    for (const p of PANELS) {
      expect(Object.is(weightedMeanOnDay(result.signed, fit.weights[p]!, panelIndicators(p), day), result.panelIndices[p]![day])).toBe(true);
      // Weights refitted on that day itself are not the ones in force: the calendar decides.
      const refit = fitPanelWeights(result.signed, panelIndicators(p), day, { carried: prepared.carried });
      expect(refit).not.toEqual(fit.weights[p]!);
    }
  });

  test("the default rules are the current version's; the carried mask matters under them and not under v3", () => {
    const { prepared, result } = fullRun("v4");
    const day = result.dateAxis.indexOf(result.weightFits!.at(-1)!.date);
    const inds = panelIndicators("factor");
    const masked = fitPanelWeights(result.signed, inds, day, { carried: prepared.carried });
    expect(masked).toEqual(fitPanelWeights(result.signed, inds, day, { rules: REGIME_RULES.v4, carried: prepared.carried }));
    expect(fitPanelWeights(result.signed, inds, day)).not.toEqual(masked);
    expect(fitPanelWeights(result.signed, inds, day, { rules: REGIME_RULES.v3, carried: prepared.carried })).toEqual(fitPanelWeights(result.signed, inds, day, { rules: REGIME_RULES.v3 }));
  });

  test("with no finite score or weight the day has no index", () => {
    const signed = { A: [NaN, 0.25], B: [0.5, 0.75] };
    const inds = [{ id: "A" }, { id: "B" }] as never;
    expect(weightedMeanOnDay(signed, { A: 0.5, B: 0.5 }, inds, 0)).toBe(0.5);
    expect(weightedMeanOnDay(signed, { A: 0.5, B: 0.5 }, inds, 1)).toBe(0.5);
    expect(weightedMeanOnDay(signed, { A: 0.5, B: NaN }, inds, 0)).toBeNaN();
    expect(weightedMeanOnDay(signed, {}, inds, 1)).toBeNaN();
  });
});
