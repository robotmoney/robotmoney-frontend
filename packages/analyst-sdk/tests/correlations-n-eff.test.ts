// Issue 1742 (R1): forward correlations over overlapping 30, 90 and 180-day
// windows carry n_eff = floor(n / horizon) beside n. Concurrent cells carry none.
import { describe, expect, test } from "bun:test";
import { addDaysIso, CORR_ASSETS, CORR_HORIZONS_DAYS, computeCorrelations } from "../src/analyze/correlations.ts";
import type { RegimeComputeResult } from "../src/analyze/compute.ts";

function fixture(days: number) {
  const dateAxis: string[] = [];
  for (let i = 0; i < days; i++) dateAxis.push(addDaysIso("2024-01-01", i));
  const series = dateAxis.map((_, i) => Math.sin(i / 17) * 50 + i * 0.1);
  const price = (base: number) => dateAxis.map((date, i) => ({ date, value: base + i + Math.cos(i / 9) * 5 }));
  const result = {
    composite: series,
    panels: ["macro"],
    panelIndices: { macro: series.map((v) => v * 0.5) },
  } as unknown as RegimeComputeResult;
  return { dateAxis, result, extras: { spx: price(4000), eth: price(2000) } };
}

describe("forward correlation effective sample size", () => {
  const f = fixture(420);
  const out = computeCorrelations(f.dateAxis, f.result, f.extras);

  test("every forward cell carries n_eff = floor(n / h), for both assets and all indices", () => {
    let cells = 0;
    for (const idx of Object.keys(out.forward)) {
      for (const asset of CORR_ASSETS) {
        for (const h of CORR_HORIZONS_DAYS) {
          const cell = out.forward[idx][`${asset}_${h}d`];
          expect(cell.n).toBeGreaterThan(0);
          expect(cell.n_eff).toBe(Math.floor(cell.n / h));
          cells++;
        }
      }
    }
    expect(cells).toBe(2 * 2 * 3);
  });

  test("a cell whose n is below the horizon has n_eff 0", () => {
    const short = fixture(60);
    const o = computeCorrelations(short.dateAxis, short.result, short.extras);
    const cell = o.forward.composite["spx_180d"];
    expect(cell.n).toBeLessThan(180);
    expect(cell.n_eff).toBe(0);
  });

  test("concurrent cells carry no n_eff", () => {
    for (const idx of Object.keys(out.concurrent)) {
      for (const asset of CORR_ASSETS) {
        const cell = out.concurrent[idx][asset];
        expect(cell.n).toBeGreaterThan(0);
        expect("n_eff" in cell).toBe(false);
      }
    }
  });
});
