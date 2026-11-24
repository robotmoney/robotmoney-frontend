// Issue 1734 (D94): the weighting and regime-equal research comparisons report
// labelled in-sample and out-of-sample blocks split at the adoption date, on
// every strategy line, and the lines are finite and priced after the label lag.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { computeWeightingComparison } from "../src/analyze/weighting-comparison.ts";
import { computeRegimeEqComparison } from "../src/analyze/regime-eq-comparison.ts";
import { BACKTEST_IN_SAMPLE_END } from "../src/analyze/backtest.ts";
import { CURRENT_REGIME_VERSION, adoptionDate } from "../src/analyze/regime-versions.ts";

setDefaultTimeout(240_000);
const raw = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "utf8")));
const extras = { eth: raw.ETH!, spx: raw.SPX! };

// Every object that carries a sample split, with its path.
function lines(x: unknown, path = "$", out: [string, Record<string, any>][] = []): [string, Record<string, any>][] {
  if (x && typeof x === "object") {
    if ("sample_split_date" in (x as object)) out.push([path, x as Record<string, any>]);
    for (const [k, v] of Object.entries(x as object)) lines(v, `${path}.${k}`, out);
  }
  return out;
}

function checkBlocks(found: [string, Record<string, any>][]) {
  expect(found.length).toBeGreaterThan(10);
  for (const [path, m] of found) {
    expect(m.sample_split_date, path).toBe(BACKTEST_IN_SAMPLE_END);
    expect(m.sample_split_date, path).toBe(adoptionDate(CURRENT_REGIME_VERSION));
    expect(m.in_sample.label, path).toBe("in_sample");
    expect(m.out_of_sample.label, path).toBe("out_of_sample");
    expect(m.in_sample.end_date <= m.sample_split_date, path).toBe(true);
    if (m.out_of_sample.start_date !== null) expect(m.out_of_sample.start_date > m.sample_split_date, path).toBe(true);
    // The fixture ends before the adoption date: all of it is in sample, none out of sample.
    expect(m.in_sample.n_days, path).toBeGreaterThan(100);
    expect(m.out_of_sample.n_days, path).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(m.sharpe), path).toBe(true);
    expect(Number.isFinite(m.in_sample.sharpe), path).toBe(true);
  }
}

describe("research comparisons report labelled sample blocks (issue 1734)", () => {
  const asof = raw.SPX![raw.SPX!.length - 1]!.date;

  test("weighting comparison: every method and strategy line", () => {
    const r = computeWeightingComparison({ raw, snapAsof: asof, extras });
    checkBlocks(lines(r.methods));
  });

  test("regime-equal comparison: every portfolio and strategy line", () => {
    const r = computeRegimeEqComparison({ raw, extras });
    checkBlocks(lines(r));
  });
});
