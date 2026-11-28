// The allocation engine (issue 1403): neutral at a signal of 0.5, each sleeve at
// its band edge when its signal saturates, a null signal at neutral, the yield
// program inside every universe cap with the remainder in the buffer, volatility
// scaling inside the band, a loud error for a missing research input, the
// within-sleeve seam, and the prototype's weekly E1 and E3 weights to 1e-9
// (tests/fixtures/PROVENANCE.md, "allocate/engine-*.csv").
//
// Issue 1765 (AC 10): the regime engine's stage cache. One runModel call for v4
// scores the registry once, counted by the cache's score-stage misses; an
// identical second call scores nothing; a variant whose rank window differs
// scores once more. Every stage-cache test builds its own cache, so each one
// passes alone. A kept run and a recompute run without ages over one cache
// score under two keys (the score key names the driver), with a red control
// that drops the driver from the key.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { labelAt } from "../src/allocate/labels.ts";
import { runRegime } from "../src/run.ts";
import { join } from "node:path";
import {
  checkHoldings, EngineInputError, engineWeights, equalWeight, fillYieldBook, loadUniverse, parseRawHistory,
  parseRuleFile, tiltWeight, toHistory, type EngineRuleFile, type EngineSignals, type Holdings, type Universe, type Yields,
  MODELS, modelOf, ratiosFromLegs, resolveInputHistory, runModel, stageCache, STAGES, type RegimeModel, type StageCache,
} from "../src/index.ts";
import { ratioDeclarationsFor } from "../src/transform/ratios.ts";

const PKG = join(import.meta.dir, "..");
const FIX = join(import.meta.dir, "fixtures/allocate");
const UNIVERSE = loadUniverse();
const rule = (id: string) => parseRuleFile(JSON.parse(readFileSync(join(PKG, `rules/${id}.json`), "utf8"))) as EngineRuleFile;
const E1 = rule("E1");
const E3 = rule("E3");
const R2 = rule("R2");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const sum = (h: Holdings) => Object.values(h).reduce((a, b) => a + b, 0);
const BOOK = E1.engine.dollarBook.instruments;
const flatYields = (y = 4): Yields => Object.fromEntries(BOOK.map((h) => [h, y]));
const at = (composite: number | null, extra: Partial<EngineSignals> = {}): EngineSignals => ({
  composite,
  panels: { macro: { label: null, index: composite, percentile: composite }, onchain: { label: null, index: composite, percentile: composite } },
  indicators: {},
  ...extra,
});

/** A universe whose instrument caps are the neutral book weights, so a full fill is the neutral book. */
function neutralCapUniverse(r: EngineRuleFile): Universe {
  const u = clone(UNIVERSE);
  for (const a of u.assets) if (r.engine.dollarBook.instruments.includes(a.id)) a.maxWeight = r.engine.neutral[a.id]!;
  u.groups = [];
  return u;
}

/** E1 with both sleeves on signals that read 1.0 together and a scale small enough that tanh saturates. */
function saturatingRule(): EngineRuleFile {
  const r = clone(E1);
  r.engine.neutral = { USDC: 2, SUSDS: 24, SPARK: 11, GT: 12, STEAK: 7, AAVE: 28, COMP: 7, GOLD: 4, BTC: 5 };
  r.engine.sleeves = [
    { holding: "BTC", signal: "composite", min: 0, max: 10, scale: 0.02 },
    { holding: "GOLD", signal: "macro", min: 2, max: 6, scale: 0.02 },
  ];
  return r;
}

describe("tilts", () => {
  test("all signals at 0.5: the neutral weights exactly", () => {
    // With caps equal to the neutral book, the fill is the neutral book, so every holding is neutral.
    const out = engineWeights(E1, at(0.5), flatYields(), neutralCapUniverse(E1));
    expect(out.weights).toEqual(E1.engine.neutral);
    for (const s of out.sleeves) expect([s.z, s.tilt]).toEqual([0, 0]);
    // With the shipped caps the sleeves and the buffer are neutral and the book keeps its neutral total.
    const shipped = engineWeights(E1, at(0.5), flatYields(), UNIVERSE);
    for (const h of ["BTC", "GOLD", "USDC"]) expect(shipped.weights[h]).toBe(E1.engine.neutral[h]!);
    expect(shipped.dollarBook.total).toBe(87);
    expect(sum(shipped.weights)).toBeCloseTo(100, 9);
  });

  test("all signals at 1.0: every tilted sleeve at its max, the dollar book shrinks by the same amount", () => {
    const r = saturatingRule();
    const mid = engineWeights(r, at(0.5), flatYields(), UNIVERSE);
    const top = engineWeights(r, at(1), flatYields(), UNIVERSE);
    expect(top.weights.BTC).toBe(10);
    expect(top.weights.GOLD).toBe(6);
    const rise = 10 - 5 + (6 - 4);
    expect(mid.dollarBook.total - top.dollarBook.total).toBeCloseTo(rise, 12);
    expect(sum(top.weights)).toBeCloseTo(100, 9);
    // The shipped scale (0.17) reaches tanh(0.5 / 0.17) = 0.9944 of the band at 1.0.
    const e1 = engineWeights(E1, at(1), flatYields(), UNIVERSE);
    expect(e1.weights.BTC!).toBeCloseTo(5 + 5 * Math.tanh(0.5 / 0.17), 12);
    expect(e1.weights.BTC!).toBeLessThanOrEqual(10);
    expect(e1.weights.GOLD!).toBeCloseTo(6 - 4 * Math.tanh(0.5 / 0.17), 12);
  });

  test("a null signal: tilt 0, the sleeve at its neutral weight, the raw null kept in the trace", () => {
    const out = engineWeights(E1, at(null), flatYields(), UNIVERSE);
    expect(out.weights.BTC).toBe(5);
    expect(out.weights.GOLD).toBe(6);
    for (const s of out.sleeves) expect(s).toMatchObject({ value: null, z: 0, tilt: 0 });
    const s = E1.engine.sleeves[0]!;
    for (const v of [NaN, Infinity, -Infinity]) expect(tiltWeight(s, 5, v)).toEqual({ weight: 5, z: 0, tilt: 0 });
  });

  test("a steepness gives z = steepness (2p - 1) exactly, the scale form's tilt without rounding 1 / (2 steepness)", () => {
    const band = { min: 0, max: 1 } as const;
    for (const p of [0, 0.1, 0.2, 0.33, 0.5, 0.67, 0.73, 0.9, 1]) {
      const { weight, z } = tiltWeight({ ...band, steepness: 3 }, 0.5, p);
      expect(z).toBe(3 * (2 * p - 1));
      expect(weight).toBe(0.5 + 0.5 * Math.tanh(3 * (2 * p - 1)));
      expect(Math.abs(weight - tiltWeight({ ...band, scale: 1 / 6 }, 0.5, p).weight)).toBeLessThanOrEqual(2 ** -52);
    }
    expect(tiltWeight({ ...band, steepness: 2 }, 0.5, 0.8)).toEqual(tiltWeight({ ...band, scale: 0.25 }, 0.5, 0.8));
  });

  test("a signal outside 0..1 is clamped before the tilt, the raw value kept in the trace", () => {
    const out = engineWeights(E1, at(1.7), flatYields(), UNIVERSE);
    expect(out.sleeves[0]!.value).toBe(1.7);
    expect(out.sleeves[0]!.z).toBeCloseTo(0.5 / 0.17, 12);
    expect(engineWeights(E1, at(-3), flatYields(), UNIVERSE).weights.BTC).toBe(tiltWeight(E1.engine.sleeves[0]!, 5, 0).weight);
  });

  test("the trace carries the signal value, z and tilt per sleeve", () => {
    const out = engineWeights(E1, at(0.67), flatYields(), UNIVERSE);
    const [btc, gold] = out.sleeves;
    expect(btc).toMatchObject({ holding: "BTC", signal: "composite", value: 0.67, volScale: null });
    expect(btc!.z).toBeCloseTo(1, 12);
    expect(btc!.tilt).toBeCloseTo(Math.tanh(1), 12);
    expect(btc!.weight).toBeCloseTo(5 + 5 * Math.tanh(1), 12);
    expect(gold!.value).toBeCloseTo(0.33, 12);
    expect(gold!.weight).toBeCloseTo(6 - 4 * Math.tanh(1), 12);
  });
});

describe("research signals", () => {
  test("a rule on a research: signal without research values fails loudly", () => {
    expect(() => engineWeights(R2, at(0.8), flatYields(), UNIVERSE)).toThrow(EngineInputError);
    expect(() => engineWeights(R2, at(0.8), flatYields(), UNIVERSE)).toThrow(/research:channel_divergence/);
    expect(() => engineWeights(R2, at(0.8, { research: { channel_divergence: 0.4 } }), flatYields(), UNIVERSE)).toThrow(/research:late_cycle/);
  });

  test("research values passed: null days stay out of the mean, values move the sleeve", () => {
    const btc = (research: EngineSignals["research"]) =>
      engineWeights(R2, at(0.8, { research }), flatYields(), UNIVERSE).sleeves.find((s) => s.holding === "BTC")!;
    expect(btc({ channel_divergence: null, late_cycle: null }).value).toBeCloseTo(0.8, 12);
    expect(btc({ channel_divergence: 0.2, late_cycle: 0.2 }).value).toBeCloseTo(0.4, 12);
  });
});

describe("yield program", () => {
  const rand = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

  test("fills the highest yield first; ties keep the listed order", () => {
    const y = { ...flatYields(1), COMP: 9, GT: 8 };
    const { weights, unplaced } = fillYieldBook(60, y, BOOK, UNIVERSE);
    expect(weights).toEqual({ COMP: 10, GT: 12, AAVE: 35, SUSDS: 3, SPARK: 0, STEAK: 0 });
    expect(unplaced).toBe(0);
    // A missing or non-finite yield ranks last.
    expect(fillYieldBook(35, { ...flatYields(1), AAVE: null, SUSDS: NaN }, BOOK, UNIVERSE).weights).toMatchObject({ GT: 12, SPARK: 12, STEAK: 6, COMP: 5, AAVE: 0, SUSDS: 0 });
  });

  test("never breaches an instrument or group cap, over random yields and signals", () => {
    const next = rand(7);
    for (let i = 0; i < 500; i++) {
      const y = Object.fromEntries(BOOK.map((h) => [h, next() * 10]));
      const out = engineWeights(E3, at(next(), { realizedVol: { BTC: 20 + next() * 100 } }), y, UNIVERSE);
      expect(checkHoldings({ week: out.weights }, UNIVERSE)).toEqual([]);
      expect(sum(out.weights)).toBeCloseTo(100, 9);
    }
  });

  test("tight caps: the buffer takes what the caps cannot place", () => {
    const tight = clone(UNIVERSE);
    for (const a of tight.assets) if (BOOK.includes(a.id)) a.maxWeight = 5;
    tight.groups.push({ id: "all", name: "All lending", members: [...BOOK], cap: 20 });
    const out = engineWeights(E1, at(0.5), flatYields(), tight);
    expect(checkHoldings({ week: out.weights }, tight)).toEqual([]);
    expect(BOOK.reduce((s, h) => s + out.weights[h]!, 0)).toBe(20);
    expect(out.dollarBook.unplaced).toBe(67);
    expect(out.weights.USDC).toBe(2 + 67);
    expect(sum(out.weights)).toBe(100);
  });

  test("a group's room counts weight held outside the book", () => {
    const u = clone(UNIVERSE);
    u.groups.push({ id: "btc_and_aave", name: "BTC and Aave", members: ["BTC", "AAVE"], cap: 30 });
    const { weights } = fillYieldBook(40, { ...flatYields(1), AAVE: 9 }, BOOK, u, { BTC: 8 });
    expect(weights.AAVE).toBe(22);
  });

  test("an instrument outside the universe is an error, not an uncapped fill", () => {
    expect(() => fillYieldBook(10, { NOPE: 5 }, ["NOPE"], UNIVERSE)).toThrow(/NOPE is not in the universe/);
  });
});

describe("volatility scaling", () => {
  test("never leaves the band and the factor stays in 0.5..1.5", () => {
    for (const p of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) {
      for (const rv of [1, 10, 30, 36.7, 55, 82.5, 110, 200, 1000]) {
        const out = engineWeights(E3, at(p, { realizedVol: { BTC: rv } }), flatYields(), UNIVERSE);
        const btc = out.sleeves[0]!;
        expect(btc.weight).toBeGreaterThanOrEqual(0);
        expect(btc.weight).toBeLessThanOrEqual(10);
        expect(btc.volScale!).toBeGreaterThanOrEqual(0.5);
        expect(btc.volScale!).toBeLessThanOrEqual(1.5);
        expect(btc.weight).toBeCloseTo(Math.min(10, btc.tiltedWeight * Math.min(1.5, Math.max(0.5, 55 / rv))), 12);
      }
    }
  });

  test("a null volatility leaves the weight unscaled; a missing entry fails loudly", () => {
    const out = engineWeights(E3, at(0.7, { realizedVol: { BTC: null } }), flatYields(), UNIVERSE);
    expect(out.sleeves[0]!.volScale).toBeNull();
    expect(out.sleeves[0]!.weight).toBe(out.sleeves[0]!.tiltedWeight);
    expect(() => engineWeights(E3, at(0.7), flatYields(), UNIVERSE)).toThrow(/realized volatility/);
  });
});

describe("within-sleeve seam", () => {
  test("equal weight by default; a caller's method splits the sleeve", () => {
    expect(equalWeight(9, ["A", "B", "C"])).toEqual({ A: 3, B: 3, C: 3 });
    const seen: [number, readonly string[]][] = [];
    const out = engineWeights(E1, at(0.5), flatYields(), UNIVERSE, {
      withinSleeve: (w, assets) => { seen.push([w, assets]); return equalWeight(w, assets); },
    });
    expect(seen).toEqual([[5, ["BTC"]], [6, ["GOLD"]]]);
    expect(out.weights.BTC).toBe(5);
  });
});

describe("the prototype's weekly weights (Oct 2018 to Oct 2026)", () => {
  const csv = (f: string) => {
    const [head, ...lines] = readFileSync(join(FIX, f), "utf8").trimEnd().split("\n");
    return { cols: head!.split(","), rows: lines.map((l) => l.split(",")) };
  };
  const inputs = csv("engine-inputs.csv");
  const col = (name: string) => inputs.cols.indexOf(name);
  const num = (v: string) => (v === "" ? null : Number(v));

  test("the composite percentiles in the inputs are the as-of labels of the 8-year fixture", () => {
    const raw = toHistory(parseRawHistory(readFileSync(join(FIX, "raw-indicator-history-8y.csv"), "utf8")));
    expect(inputs.rows.length).toBe(419);
    for (const i of [0, 200, 418]) {
      const r = inputs.rows[i]!;
      // The prototype refits its weights on each as-of day (v3's last-day refit, issue 1739).
      const run = runRegime(raw, { asof: r[1]!, panels: ["macro", "onchain"], version: "v3" });
      if (run.kind !== "complete") throw new Error(`incomplete ${r[1]}`);
      expect(labelAt(run, r[0]!, r[1]!).compositePercentile).toBe(num(r[col("composite_pct")]!));
    }
  }, 60_000);

  for (const id of ["E1", "E3"] as const) {
    test(`${id}: every week matches engine-weights-${id}.csv to 1e-9`, () => {
      const r = id === "E1" ? E1 : E3;
      const want = csv(`engine-weights-${id}.csv`);
      expect(want.rows.length).toBe(inputs.rows.length);
      let tilted = 0;
      inputs.rows.forEach((row, i) => {
        const yields = Object.fromEntries(BOOK.map((h) => [h, num(row[col(`yield_${h}`)]!)]));
        const out = engineWeights(r, at(num(row[col("composite_pct")]!), { realizedVol: { BTC: num(row[col("rv_BTC")]!) } }), yields, UNIVERSE);
        const w = want.rows[i]!;
        expect([w[0], w[1]]).toEqual([row[0], row[1]]);
        want.cols.slice(2).forEach((h, j) => {
          const diff = Math.abs((out.weights[h] ?? 0) - Number(w[j + 2]));
          if (diff > 1e-9) throw new Error(`${id} ${row[0]} ${h}: engine ${out.weights[h]} vs fixture ${w[j + 2]}`);
        });
        if (out.weights.BTC !== 5) tilted++;
      });
      expect(tilted).toBeGreaterThan(300);
    });
  }
});

describe("the regime engine's stage cache (issue 1765)", () => {
  const raw = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.json"), "utf8")));
  const v4 = MODELS.v4;
  // The run input of v4: storage names resolved and each ratio set from its legs, as runRegime does.
  const input = ratiosFromLegs(raw, resolveInputHistory(raw, v4.seriesMapping, v4.storedUnder), ratioDeclarationsFor(v4.rules));
  let asof = "2018-01-01";
  for (const id in raw) for (const r of raw[id]!) if (r.date > asof) asof = r.date;
  const withRank = (days: number): RegimeModel => modelOf({ ...v4, id: `v4-rank-${days}`, rules: { ...v4.rules, lookback: { ...v4.rules.lookback, rank: { kind: "trailing", days } } } });
  // Every test builds its own cache, so each one passes alone (bun test -t '<name>').
  const counts = (cache: StageCache) => ({ hits: { ...cache.hits }, misses: { ...cache.misses } });

  test("one runModel call for v4 scores the registry once: one score-stage miss, and the run equals an uncached run", () => {
    const cache = stageCache();
    const run = runModel(v4, input, { asof, cache });
    expect(cache.misses.score).toBe(1);
    expect(counts(cache)).toEqual({ hits: { prepare: 0, score: 0, fit: 0, combine: 0 }, misses: { prepare: 1, score: 1, fit: 1, combine: 1 } });
    expect(cache.entries.size).toBe(STAGES.length);
    expect(run.result).toEqual(runModel(v4, input, { asof }).result);
    expect(run.result.regime.filter((l) => l != null).length).toBeGreaterThan(1000);
  }, 120_000);

  test("a second identical call adds no score-stage miss: every stage is read from the cache", () => {
    const cache = stageCache();
    const first = runModel(v4, input, { asof, cache });
    expect(cache.misses.score).toBe(1);
    expect(cache.hits.score).toBe(0);
    const before = counts(cache);
    const again = runModel(v4, input, { asof, cache });
    expect(cache.misses).toEqual(before.misses);
    expect(cache.hits.combine).toBe(before.hits.combine + 1);
    // The cached result is the stored one: shared, never recomputed.
    expect(again.result).toBe(first.result);
  }, 120_000);

  test("a variant whose lookback.rank differs adds exactly one score-stage miss, and reads the prepared inputs from the cache", () => {
    const cache = stageCache();
    runModel(v4, input, { asof, cache });
    const before = counts(cache);
    const variant = runModel(withRank(400), input, { asof, cache });
    expect(cache.misses.score).toBe(before.misses.score + 1);
    expect(cache.hits.prepare).toBe(before.hits.prepare + 1);
    expect(cache.misses.prepare).toBe(before.misses.prepare);
    expect(variant.result.ranks).not.toEqual(runModel(v4, input, { asof }).result.ranks);
    expect(variant.result).toEqual(runModel(withRank(400), input, { asof }).result);
  }, 120_000);

  test("control: a variant that changes only the label cut scores nothing and fits nothing again; only the combine stage runs", () => {
    const cache = stageCache();
    runModel(v4, input, { asof, cache });
    const before = counts(cache);
    const cut = modelOf({ ...v4, id: "v4-percentile-cut", rules: { ...v4.rules, labelCut: "percentile" } });
    const run = runModel(cut, input, { asof, cache });
    expect(cache.misses.score).toBe(before.misses.score);
    expect(cache.misses.fit).toBe(before.misses.fit);
    expect(cache.misses.combine).toBe(before.misses.combine + 1);
    expect(run.result).toEqual(runModel(cut, input, { asof }).result);
    // A key names its stage; a key of another shape is refused.
    expect(() => cache.get("no-digest")).toThrow(RangeError);
  }, 120_000);

  // The wave 4 review: the kept driver stores DayScores (the scores with their
  // axis) under the score stage and the recompute driver StageScores. Over one
  // input, one registry and one rank window, a recompute run without ages and a
  // kept run named the same score params, so a shared cache handed one
  // driver's value to the other. The score key now names the driver.
  describe("a kept run and a recompute run without ages share one cache", () => {
    // The kept record's rules on v4's registry (calendar-day windows, the series label cut, a daily refit), and its recomputing twin.
    const keptRules = { ...v4.rules, keptHistory: true, observationWindows: false, labelCut: "series" as const, weightRefresh: { ...v4.rules.weightRefresh, intervalDays: 1 } };
    const kept = modelOf({ ...v4, id: "v4-kept", history: "kept", rules: keptRules });
    const recompute = modelOf({ ...v4, id: "v4-daily", history: "recompute", rules: { ...keptRules, keptHistory: false } });
    const opts = { asof, start: "2025-06-01", extras: false } as const;
    const runKept = (cache?: StageCache) => runModel(kept, input, { ...opts, ...(cache ? { cache } : {}) });
    const runRecompute = (cache?: StageCache) => runModel(recompute, input, { ...opts, ages: false, ...(cache ? { cache } : {}) });
    // A cache whose keys drop the driver: the key the score stage had before the fix.
    const withoutDriver = (inner: StageCache): StageCache & { rewritten: () => number } => {
      let rewritten = 0;
      const strip = (key: string): string => {
        const out = key.replace(/"driver":"(?:kept|recompute)",/g, "");
        if (out !== key) rewritten++;
        return out;
      };
      return { entries: inner.entries, hits: inner.hits, misses: inner.misses, get: (key) => inner.get(strip(key)), set: (key, value) => inner.set(strip(key), value), rewritten: () => rewritten };
    };
    // Whether a cached kept run fails: it throws, or it differs from the uncached run.
    const keptFails = (cache: StageCache, want: unknown): boolean => {
      try {
        return !Bun.deepEquals(runKept(cache).result, want);
      } catch {
        return true;
      }
    };

    test("in either order both equal their uncached runs, and the two drivers score under two keys", () => {
      const wantKept = runKept().result;
      const wantRecompute = runRecompute().result;
      for (const order of [["recompute", "kept"], ["kept", "recompute"]] as const) {
        const cache = stageCache();
        const got: Record<string, unknown> = {};
        for (const driver of order) got[driver] = (driver === "kept" ? runKept(cache) : runRecompute(cache)).result;
        expect(got.kept, order.join(" then ")).toEqual(wantKept);
        expect(got.recompute, order.join(" then ")).toEqual(wantRecompute);
        // The prepared inputs are one value; the scores are two.
        expect(cache.misses.prepare).toBe(1);
        expect(cache.misses.score).toBe(2);
        expect(cache.hits.score).toBe(0);
      }
    }, 120_000);

    test("red control: with the driver dropped from the key, the kept run reads the recompute run's scores and fails", () => {
      const wantKept = runKept().result;
      const cache = withoutDriver(stageCache());
      runRecompute(cache);
      expect(keptFails(cache, wantKept)).toBe(true);
      // The two runs met on one score entry: one miss, then a hit.
      expect(cache.misses.score).toBe(1);
      expect(cache.hits.score).toBe(1);
      expect(cache.rewritten()).toBeGreaterThan(0);
      // The same sequence on a real cache passes.
      const real = stageCache();
      runRecompute(real);
      expect(keptFails(real, wantKept)).toBe(false);
    }, 120_000);
  });
});
