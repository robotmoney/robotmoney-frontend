// Issue 1655: each indicator declares its fill policy and the SDK has no
// default. The registry declares the former global cap for every indicator, so
// every figure is unchanged. A missing or malformed policy is a definition
// error that names the indicator before any computation. A changed policy takes
// effect exactly as it says, through a copied indicator list passed to
// prepareRegimeInputs and through runRegime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FillPolicyError, INDICATORS, fillMaxAgeDays, fillPolicyOf, type FillPolicy, type Indicator } from "../src/analyze/indicators.ts";
import { computeRegime } from "../src/analyze/compute.ts";
import { knowledgeTimeHistory, prepareRegimeInputs } from "../src/prepare.ts";
import { BACKFILL_START, requireComplete, runRegime } from "../src/run.ts";
import { MAX_FORWARD_FILL_DAYS, alignDailyForwardFill, forwardFillAge } from "../src/transform/math.ts";
import { applyTransform } from "../src/transform/transforms.ts";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { ratiosFromLegs } from "../src/transform/ratios.ts";
import { resolveInputHistory } from "../src/series-ids.ts";

const mk = (id: string, fill: unknown, fillReason: unknown): Indicator =>
  ({ id, name: id, panel: "macro", source: "test", sign: 1, transform: "level", unit: "x", fill, fillReason, calendar: "daily", publication: { kind: "same-day" } }) as Indicator;
const START = "2024-01-01";
const ASOF = "2024-01-10";
// Real observations on Jan 2 and Jan 3 only.
const SERIES = [{ date: "2024-01-02", value: 5 }, { date: "2024-01-03", value: 7 }];

// Swap one registry indicator's policy for the length of `fn`.
function withPolicy<T>(id: string, fill: unknown, fn: () => T, fillReason?: unknown): T {
  const ind = INDICATORS.find((i) => i.id === id)! as unknown as { fill: unknown; fillReason: unknown };
  const saved = { fill: ind.fill, fillReason: ind.fillReason };
  ind.fill = fill;
  if (fillReason !== undefined) ind.fillReason = fillReason;
  try {
    return fn();
  } finally {
    ind.fill = saved.fill;
    ind.fillReason = saved.fillReason;
  }
}

describe("the registry declares the former global cap for every indicator", () => {
  test("every registry indicator is forward with maxAgeDays MAX_FORWARD_FILL_DAYS (120) and the declared reason", () => {
    expect(MAX_FORWARD_FILL_DAYS).toBe(120);
    expect(INDICATORS.length).toBe(26);
    for (const ind of INDICATORS) {
      expect({ id: ind.id, fill: ind.fill, fillReason: ind.fillReason }).toEqual({
        id: ind.id,
        fill: { kind: "forward", maxAgeDays: 120 },
        fillReason: "Carried forward up to the former global cap",
      });
      expect(fillPolicyOf(ind)).toEqual({ kind: "forward", maxAgeDays: 120 });
    }
  });
});

describe("a missing or malformed policy is a definition error naming the indicator, before any computation", () => {
  const bad: Array<[string, unknown, unknown]> = [
    ["no fill", undefined, "r"],
    ["no fillReason", { kind: "none" }, undefined],
    ["blank fillReason", { kind: "none" }, " "],
    ["unknown kind", { kind: "carry" }, "r"],
    ["forward without maxAgeDays", { kind: "forward" }, "r"],
    ["forward with 0", { kind: "forward", maxAgeDays: 0 }, "r"],
    ["forward with a fraction", { kind: "forward", maxAgeDays: 2.5 }, "r"],
    ["forward with a negative", { kind: "forward", maxAgeDays: -3 }, "r"],
  ];

  test("fillPolicyOf and prepareRegimeInputs refuse each case and name the indicator", () => {
    for (const [name, fill, reason] of bad) {
      const ind = mk("BAD_ONE", fill, reason);
      expect(() => fillPolicyOf(ind), name).toThrow(FillPolicyError);
      expect(() => prepareRegimeInputs({ BAD_ONE: SERIES }, { start: START, asof: ASOF, indicators: [mk("OK", { kind: "zero" }, "test"), ind] }), name).toThrow(/BAD_ONE/);
    }
  });

  test("runRegime refuses a registry indicator with a malformed policy before computing, naming it", () => {
    const fixture = { VIX: SERIES, HY_OAS: SERIES };
    for (const [name, fill, reason] of bad) {
      const reasonArg = reason === undefined ? null : reason;
      expect(() => withPolicy("HY_OAS", fill, () => runRegime(fixture, { start: START }), reasonArg), name).toThrow(FillPolicyError);
      expect(() => withPolicy("HY_OAS", fill, () => runRegime(fixture, { start: START }), reasonArg), name).toThrow(/HY_OAS/);
    }
  });
});

// Issue 1554: the forward form with no age limit, maxAgeDays null, which the
// backtest's price and cash-rate series declare. Any other maxAgeDays is refused
// with the same FillPolicyError.
describe("forward with no age limit (maxAgeDays null)", () => {
  test("the validator accepts { kind: 'forward', maxAgeDays: null, reason }", () => {
    const fill = { kind: "forward", maxAgeDays: null, reason: "Reproduces the undeclared carry" };
    expect(fillPolicyOf(mk("NOLIMIT", fill, fill.reason))).toEqual({ kind: "forward", maxAgeDays: null });
    expect(fillMaxAgeDays({ kind: "forward", maxAgeDays: null })).toBe(Infinity);
  });

  test("the validator refuses maxAgeDays 0, -1, 1.5 and '4'", () => {
    for (const n of [0, -1, 1.5, "4"]) {
      expect(() => fillPolicyOf(mk("BAD_AGE", { kind: "forward", maxAgeDays: n, reason: "r" }, "r")), String(n)).toThrow(FillPolicyError);
      expect(() => fillPolicyOf(mk("BAD_AGE", { kind: "forward", maxAgeDays: n, reason: "r" }, "r")), String(n)).toThrow(/BAD_AGE/);
    }
  });

  test("an indicator declared forward with no age limit carries its last observation on every later day", () => {
    const p = prepareRegimeInputs({ X: SERIES }, { start: START, asof: ASOF, indicators: [mk("X", { kind: "forward", maxAgeDays: null }, "test")] });
    expect(p.transformed.X).toEqual([NaN, 5, 7, 7, 7, 7, 7, 7, 7, 7]);
  });
});

describe("each fill policy form", () => {
  const run = (fill: FillPolicy) => prepareRegimeInputs({ X: SERIES }, { start: START, asof: ASOF, indicators: [mk("X", fill, "test")] });

  test("none: a day without a real observation is missing (NaN)", () => {
    expect(run({ kind: "none" }).transformed.X).toEqual([NaN, 5, 7, NaN, NaN, NaN, NaN, NaN, NaN, NaN]);
    expect(fillMaxAgeDays({ kind: "none" })).toBe(0);
  });

  test("forward: the last real observation is carried for at most maxAgeDays days, then missing", () => {
    const p = run({ kind: "forward", maxAgeDays: 4 });
    expect(p.transformed.X).toEqual([NaN, 5, 7, 7, 7, 7, 7, NaN, NaN, NaN]);
    expect(p.ages.X).toEqual([NaN, 0, 0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("zero: a gap after the first observation is a real 0, and has no age", () => {
    const p = run({ kind: "zero" });
    expect(p.transformed.X).toEqual([NaN, 5, 7, 0, 0, 0, 0, 0, 0, 0]);
    expect("X" in p.ages).toBe(false);
  });
});

// On the committed fixture: VIX has no rows on weekends and holidays, so each
// policy acts on real gaps. The expected series is built here from the raw rows
// alone, not through the SDK's fill code.
describe("a changed policy takes effect exactly as it says, on the fixture", () => {
  const history = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "utf8")));
  const resolved = ratiosFromLegs(history, resolveInputHistory(history));
  const ASOF_F = "2026-08-14"; // a trading day: VIX has a row on it
  const declared = prepareRegimeInputs(resolved, { start: BACKFILL_START, asof: ASOF_F });
  const axis = declared.dateAxis;
  const vixRows = resolved.VIX!.filter((r) => r.date <= ASOF_F);
  const byDate = new Map(vixRows.map((r) => [r.date, r.value]));
  const age = forwardFillAge(vixRows, axis);
  const expected = (fill: FillPolicy): number[] => {
    let last = NaN;
    let seen = false;
    return axis.map((d, i) => {
      if (byDate.has(d)) {
        last = byDate.get(d)!;
        seen = true;
        return last;
      }
      if (!seen) return NaN;
      if (fill.kind === "zero") return 0;
      if (fill.kind === "none") return NaN;
      return age[i]! <= (fill.maxAgeDays ?? Infinity) ? last : NaN;
    });
  };
  const policies: Array<[string, FillPolicy]> = [
    ["none", { kind: "none" }],
    ["forward 1", { kind: "forward", maxAgeDays: 1 }],
    ["zero", { kind: "zero" }],
  ];

  for (const [name, fill] of policies) {
    test(`${name}: a copied indicator list changes VIX's prepared series and the composite exactly; runRegime agrees`, () => {
      const copied = INDICATORS.map((i) => (i.id === "VIX" ? { ...i, fill } : i));
      const changed = prepareRegimeInputs(resolved, { start: BACKFILL_START, asof: ASOF_F, indicators: copied });
      const want = expected(fill);
      expect(changed.transformed.VIX!.map((v) => (Number.isNaN(v) ? null : v))).toEqual(want.map((v) => (Number.isNaN(v) ? null : v)));
      // Every other indicator is untouched.
      for (const ind of INDICATORS) if (ind.id !== "VIX") expect(JSON.stringify(changed.transformed[ind.id])).toBe(JSON.stringify(declared.transformed[ind.id]));
      // The composite is exactly the composite over the declared inputs with VIX replaced by the expected series.
      const composite = computeRegime(changed.transformed, axis, undefined, undefined, undefined, undefined, undefined, undefined, undefined, changed.carried).composite;
      const byHand = computeRegime({ ...declared.transformed, VIX: want }, axis, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { ...declared.carried, VIX: changed.carried.VIX! }).composite;
      expect(JSON.stringify(composite)).toBe(JSON.stringify(byHand));
      expect(JSON.stringify(composite)).not.toBe(JSON.stringify(computeRegime(declared.transformed, axis, undefined, undefined, undefined, undefined, undefined, undefined, undefined, declared.carried).composite));
      // Through runRegime, with the registry row changed.
      const viaRun = withPolicy("VIX", fill, () => requireComplete(runRegime(history, { asof: ASOF_F })));
      expect(JSON.stringify(viaRun.result.composite)).toBe(JSON.stringify(composite));
    }, 120_000);
  }
});

// computeRegime keeps its `ages` and `maxForwardFillDays` arguments. Main
// passed the UNMASKED transformed series with the ages and the 120-day cap; the
// policy now masks the same series first. On an input where HY_OAS is more than
// 120 days stale (so the mask is not vacuous), both give the same figures.
describe("computeRegime with ages and maxForwardFillDays, as on main", () => {
  test("the main path (unmasked series + ages + cap) and the policy path give identical figures", () => {
    const history = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "utf8")));
    const raw = ratiosFromLegs(history, resolveInputHistory(history));
    raw.HY_OAS = raw.HY_OAS!.filter((r) => r.date <= "2026-01-15");
    const asof = "2026-08-14";
    // Forward-filled windows (the rule of main): this test pins the ages and cap arguments, not issue 1741.
    const prepared = prepareRegimeInputs(raw, { start: BACKFILL_START, asof, observationDays: false });
    const axis = prepared.dateAxis;
    // Both paths read the series by knowledge time (issue 1733).
    const known = knowledgeTimeHistory(raw, { asof });
    const unmasked: Record<string, number[]> = {};
    for (const ind of INDICATORS) unmasked[ind.id] = applyTransform(ind.transform, alignDailyForwardFill(known[ind.id] ?? [], axis));
    // Not vacuous: the policy masked some HY_OAS days the unmasked series still carries.
    const maskedDays = prepared.transformed.HY_OAS!.filter((v, i) => Number.isNaN(v) && Number.isFinite(unmasked.HY_OAS![i]!)).length;
    expect(maskedDays).toBeGreaterThan(30);
    for (const panels of [undefined, ["macro", "onchain", "factor"] as const]) {
      const main = computeRegime(unmasked, axis, panels as never, prepared.ages, MAX_FORWARD_FILL_DAYS);
      const now = computeRegime(prepared.transformed, axis, panels as never, prepared.ages, MAX_FORWARD_FILL_DAYS);
      const nowNoAges = computeRegime(prepared.transformed, axis, panels as never);
      expect(JSON.stringify(now)).toBe(JSON.stringify(main));
      expect(JSON.stringify(nowNoAges)).toBe(JSON.stringify(main));
    }
    // And runRegime (shipped values) gives those figures, counting observation days (issue 1741).
    const real = prepareRegimeInputs(raw, { start: BACKFILL_START, asof });
    expect(JSON.stringify(requireComplete(runRegime(history.HY_OAS ? { ...history, HY_OAS: raw.HY_OAS } : history, { asof })).result)).toBe(
      JSON.stringify(computeRegime(real.transformed, axis, undefined, real.ages, MAX_FORWARD_FILL_DAYS, undefined, undefined, undefined, undefined, real.carried)),
    );
  }, 120_000);
});
