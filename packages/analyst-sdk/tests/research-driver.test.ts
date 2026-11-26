// Issue 1765 (AC 18): the research driver, over the committed fixture input
// (tests/fixtures/raw-indicator-history.json) with MODELS.v4.
//
// screen over a two-by-two rule grid (weightRefresh.intervalDays 21 or 63,
// crossed with labelCut "series" or "percentile") changes only the fit and the
// combine stages, so with a fresh stage cache it scores the registry once. It
// returns the variants ranked by the metric, and each variant's run equals
// runModel on the merged rules with no cache, day for day. Control: one more
// variant that changes lookback.rank scores once more, so the rank window is in
// the score key.
//
// A custom DerivedSeries op with lag L, run through the engine's prepare stage,
// reads no input value dated after the day minus L on any day of the axis, and
// on each day reads exactly the points dated up to then. Negative control: with
// lag 0 it reads the day's own value. The stage cache names the op by its
// declared id and version, never by its function.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sdk from "../src/index.ts";
import * as research from "../src/research/index.ts";
import {
  MODELS, modelOf, parseRawHistory, ratiosFromLegs, resolveInputHistory, runModel, screen, stageCache, stageKey, toHistory,
  type DerivedCustom, type ModelRun, type RegimeModel, type RuleVariant, type ScreenMetric,
} from "../src/index.ts";
import { ratioDeclarationsFor } from "../src/transform/ratios.ts";

const raw = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.json"), "utf8")));
const v4 = MODELS.v4;
// The run input of v4: storage names resolved and each ratio set from its legs, as runRegime does.
const input = ratiosFromLegs(raw, resolveInputHistory(raw, v4.seriesMapping, v4.storedUnder), ratioDeclarationsFor(v4.rules));
let asof = "2018-01-01";
for (const id in raw) for (const r of raw[id]!) if (r.date > asof) asof = r.date;

const refresh = (intervalDays: number) => ({ ...v4.rules.weightRefresh, intervalDays });
// The two-by-two grid: two refit calendars crossed with two label cuts. Neither is read by the score stage.
const GRID: readonly RuleVariant[] = [21, 63].flatMap((d) => (["series", "percentile"] as const).map((labelCut) => ({ weightRefresh: refresh(d), labelCut })));
// The rank window is the score stage itself (engine/score.ts), so a variant that changes it scores again.
const RANK_400: RuleVariant = { lookback: { ...v4.rules.lookback, rank: { kind: "trailing", days: 400 } } };

/** The mean of the finite composite values: the label cut does not change it, so the grid scores in two tied pairs. */
const meanComposite: ScreenMetric = (run) => {
  let sum = 0;
  let n = 0;
  for (const v of run.result.composite) {
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return sum / n;
};
const gridIndex = (variant: RuleVariant) => GRID.indexOf(variant);
const merged = (variant: RuleVariant): RegimeModel => modelOf({ ...MODELS.v4, rules: { ...MODELS.v4.rules, ...variant } });

describe("screen over a rule grid (issue 1765, AC 18)", () => {
  test("a two-by-two grid of the refit calendar and the label cut scores the registry once: one score-stage miss", () => {
    const cache = stageCache();
    const ranked = screen(input, v4, GRID, meanComposite, { asof, cache });
    expect(ranked.length).toBe(4);
    expect(cache.misses.score).toBe(1);
    // One prepared input and one score for all four; one fit per refit calendar; one combine per variant.
    expect(cache.misses).toEqual({ prepare: 1, score: 1, fit: 2, combine: 4 });
    expect(cache.hits).toEqual({ prepare: 3, score: 3, fit: 2, combine: 0 });
  }, 120_000);

  test("the variants are ranked by the metric, highest first; tied scores keep their grid order", () => {
    const cache = stageCache();
    const ranked = screen(input, v4, GRID, meanComposite, { asof, cache });
    const scores = ranked.map((e) => e.score);
    for (let k = 1; k < scores.length; k++) expect(scores[k - 1]!).toBeGreaterThanOrEqual(scores[k]!);
    for (const e of ranked) {
      expect(e.score).toBe(meanComposite(e.run));
      expect(e.model.id).toBe(`v4+variant${gridIndex(e.variant)}`);
      expect(e.run.model).toBe(e.model);
    }
    // Two refit calendars give two scores, each held by its two label cuts, in grid order.
    expect(new Set(scores).size).toBe(2);
    const order = ranked.map((e) => gridIndex(e.variant));
    expect(order[0]! < order[1]! && order[2]! < order[3]!).toBe(true);
    expect(GRID[order[0]!]!.weightRefresh).toEqual(GRID[order[1]!]!.weightRefresh);
    expect(GRID[order[0]!]!.weightRefresh).not.toEqual(GRID[order[2]!]!.weightRefresh);
    // The opposite metric swaps the pairs and keeps the grid order inside each: the order is the metric's, not the grid's.
    const reversed = screen(input, v4, GRID, (run) => -meanComposite(run), { asof, cache }).map((e) => gridIndex(e.variant));
    expect(reversed).toEqual([order[2], order[3], order[0], order[1]]);
    // A NaN score ranks after every number.
    const nan = screen(input, v4, GRID, (run) => (run.model.id.endsWith("+variant0") ? NaN : meanComposite(run)), { asof, cache });
    expect(gridIndex(nan[3]!.variant)).toBe(0);
    expect(Number.isNaN(nan[3]!.score)).toBe(true);
  }, 120_000);

  test("each variant's run equals runModel on the merged rules with no cache, day for day", () => {
    const ranked = screen(input, v4, GRID, meanComposite, { asof });
    const runs = new Map<number, ModelRun>();
    for (const e of ranked) {
      const i = gridIndex(e.variant);
      const want = runModel(merged(GRID[i]!), input, { asof });
      expect(e.model.rules).toEqual({ ...v4.rules, ...GRID[i]! });
      expect(e.run.dateAxis).toEqual(want.dateAxis);
      expect(e.run.result).toEqual(want.result);
      expect(e.run.backtest).toEqual(want.backtest);
      expect(e.run.correlations).toEqual(want.correlations);
      // Day for day, the published figures of the day.
      want.dateAxis.forEach((day, k) => {
        if (!Object.is(e.run.result.composite[k], want.result.composite[k]) || e.run.result.regime[k] !== want.result.regime[k]) {
          throw new Error(`variant ${i} differs from runModel on the merged rules on ${day}`);
        }
      });
      runs.set(i, e.run);
    }
    // The variants are four runs: the refit calendar moves the composite, the label cut moves the labels.
    expect(runs.get(0)!.result.composite).not.toEqual(runs.get(2)!.result.composite);
    expect(runs.get(0)!.result.composite).toEqual(runs.get(1)!.result.composite);
    expect(runs.get(0)!.result.regime).not.toEqual(runs.get(1)!.result.regime);
    expect(runs.get(0)!.backtest).toBeDefined();
  }, 120_000);

  test("control: one more variant that changes lookback.rank adds exactly one score-stage miss", () => {
    const cache = stageCache();
    const ranked = screen(input, v4, [...GRID, RANK_400], meanComposite, { asof, cache });
    expect(ranked.length).toBe(5);
    expect(cache.misses.score).toBe(2);
    expect(cache.misses).toEqual({ prepare: 1, score: 2, fit: 3, combine: 5 });
    const rank = ranked.find((e) => e.variant === RANK_400)!;
    expect(rank.model.id).toBe("v4+variant4");
    expect(rank.run.result.ranks).not.toEqual(runModel(v4, input, { asof, extras: false }).result.ranks);
    expect(rank.run.result).toEqual(runModel(merged(RANK_400), input, { asof, extras: false }).result);
  }, 120_000);

  test("a bad grid, variant or metric is refused, and an empty grid runs nothing", () => {
    const cache = stageCache();
    expect(screen(input, v4, [], meanComposite, { asof, cache })).toEqual([]);
    expect(cache.misses).toEqual({ prepare: 0, score: 0, fit: 0, combine: 0 });
    expect(() => screen(input, v4, {} as unknown as RuleVariant[], meanComposite, { asof })).toThrow(/grid must be a list/);
    expect(() => screen(input, v4, [null as unknown as RuleVariant], meanComposite, { asof })).toThrow(/grid\[0\] must be an object/);
    // A misspelt rule would merge as a rule no stage reads, and the variant would silently equal its base.
    expect(() => screen(input, v4, [{ labelcut: "series" } as unknown as RuleVariant], meanComposite, { asof })).toThrow(/grid\[0\]\.labelcut names no rule/);
    // Each variant's model is checked by modelOf.
    expect(() => screen(input, v4, [{ labelCut: "median" } as unknown as RuleVariant], meanComposite, { asof })).toThrow(/rules\.labelCut/);
    expect(() => screen(input, v4, GRID, (() => "high") as unknown as ScreenMetric, { asof, extras: false })).toThrow(/metric must return a number/);
    // runModel's options are checked by runModel.
    expect(() => screen(input, v4, GRID, meanComposite, {} as unknown as { asof: string })).toThrow(/asof/);
  }, 120_000);

  test("screen, stageCache and the custom op types are on the package entry and on src/research", () => {
    expect(typeof sdk.screen).toBe("function");
    expect(sdk.screen).toBe(research.screen);
    expect(sdk.stageCache).toBe(research.stageCache);
    expect(research.STAGES).toEqual(["prepare", "score", "fit", "combine"]);
  });
});

describe("a custom DerivedSeries op reads no value dated after the day minus its lag (issue 1765, AC 18)", () => {
  const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  // A daily input of the fixture, read by the op under its own id.
  const VIX = input.VIX!;
  /** A custom op over VIX that records, on each day it is called, the newest date it was given. */
  const recording = (lagDays: number, log: { day: string; newest: string | null }[], version = "1"): DerivedCustom => ({
    op: "custom",
    id: "VIX_SEEN",
    version,
    inputs: ["VIX"],
    lagDays,
    fn: (inputs, day) => {
      let newest: string | null = null;
      for (const p of inputs.VIX!) if (newest === null || p.date > newest) newest = p.date;
      log.push({ day, newest });
      const s = inputs.VIX!;
      return s.length > 0 ? s[s.length - 1]!.value : null;
    },
  });
  const withOp = (op: DerivedCustom, id: string): RegimeModel => modelOf({ ...v4, id, derived: [op] });
  // The newest VIX date on or before `day`.
  const newestBy = (day: string): string | null => {
    let out: string | null = null;
    for (const p of VIX) if (p.date <= day && (out === null || p.date > out)) out = p.date;
    return out;
  };

  for (const lag of [1, 3, 10]) {
    test(`lag ${lag}: on every day of the axis the op reads only VIX points dated on or before the day minus ${lag}, and every one of them`, () => {
      const log: { day: string; newest: string | null }[] = [];
      const run = runModel(withOp(recording(lag, log), `v4-custom-${lag}`), input, { asof, extras: false });
      expect(log.length).toBeGreaterThan(1000);
      for (const { day, newest } of log) {
        if (newest !== null && newest > addDays(day, -lag)) throw new Error(`on ${day} the op read a value dated ${newest}, after ${addDays(day, -lag)}`);
        expect(newest).toBe(newestBy(addDays(day, -lag)));
      }
      // The op ran on every axis day from the first day a VIX point was known (its date plus the lag).
      const firstKnown = addDays(VIX.map((p) => p.date).sort()[0]!, lag);
      const called = new Set(log.map((e) => e.day));
      const axisDays = run.dateAxis.filter((d) => d >= firstKnown);
      expect(axisDays.length).toBeGreaterThan(1000);
      for (const d of axisDays) if (!called.has(d)) throw new Error(`the op was not called on axis day ${d}`);
      expect(called.has(addDays(firstKnown, -1))).toBe(false);
    }, 120_000);
  }

  test("negative control: with lag 0 the op reads the day's own value", () => {
    const log: { day: string; newest: string | null }[] = [];
    runModel(withOp(recording(0, log), "v4-custom-0"), input, { asof, extras: false });
    const sameDay = log.filter((e) => e.newest === e.day);
    expect(sameDay.length).toBeGreaterThan(1000);
    expect(sameDay.length).toBe(VIX.filter((p) => log.some((e) => e.day === p.date)).length);
  }, 120_000);

  test("a custom indicator in the registry is scored like any other: no SDK change needed", () => {
    const vix = v4.registry.find((i) => i.id === "VIX")!;
    const op: DerivedCustom = {
      op: "custom",
      id: "VIX_LAGGED",
      version: "1",
      inputs: ["VIX"],
      lagDays: 2,
      fn: (inputs) => (inputs.VIX!.length > 0 ? inputs.VIX![inputs.VIX!.length - 1]!.value : null),
    };
    const model = modelOf({ ...v4, id: "v4-vix-lagged", registry: [...v4.registry, { ...vix, id: "VIX_LAGGED", name: "VIX, two days late", calendar: "daily" }], derived: [op] });
    const run = runModel(model, input, { asof, extras: false });
    const ranks = run.result.ranks.VIX_LAGGED!;
    expect(ranks.length).toBe(run.dateAxis.length);
    expect(ranks.filter(Number.isFinite).length).toBeGreaterThan(500);
    expect(run.result.weightsByPanel.macro!.VIX_LAGGED).toBeDefined();
  }, 120_000);

  test("the stage cache names a custom op by its declared id and version, never by its function", () => {
    const opts = { asof, extras: false };
    const a = recording(3, []);
    const b = recording(3, []);
    expect(a.fn).not.toBe(b.fn);
    // The function is a tag in the key: two functions under one id and version give one key, without either body.
    const key = stageKey(input, "prepare", { derived: [a] });
    expect(key).toBe(stageKey(input, "prepare", { derived: [b] }));
    expect(key).toContain("\\u0000function");
    expect(key).not.toContain("newest");
    expect(key).not.toBe(stageKey(input, "prepare", { derived: [{ ...b, version: "2" }] }));

    const cache = stageCache();
    let calls = 0;
    const counted = (op: DerivedCustom): DerivedCustom => ({ ...op, fn: (inputs, day) => (calls++, op.fn(inputs, day)) });
    runModel(withOp(counted(a), "v4-a"), input, { ...opts, cache });
    expect(cache.misses.prepare).toBe(1);
    expect(calls).toBeGreaterThan(0);
    // A changed fn under the same id and version is served the old fn's stages (documented): it is never called.
    calls = 0;
    runModel(withOp(counted(b), "v4-b"), input, { ...opts, cache });
    expect(cache.misses.prepare).toBe(1);
    expect(cache.hits.prepare).toBe(1);
    expect(calls).toBe(0);
    // Bumping the version computes the prepare stage again.
    runModel(withOp(counted({ ...b, version: "2" }), "v4-b2"), input, { ...opts, cache });
    expect(cache.misses.prepare).toBe(2);
    expect(calls).toBeGreaterThan(0);
  }, 120_000);
});
