// The allocation engine (issue 1403): neutral at a signal of 0.5, each sleeve at
// its band edge when its signal saturates, a null signal at neutral, the yield
// program inside every universe cap with the remainder in the buffer, volatility
// scaling inside the band, a loud error for a missing research input, the
// within-sleeve seam, and the prototype's weekly E1 and E3 weights to 1e-9
// (tests/fixtures/PROVENANCE.md, "allocate/engine-*.csv").
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  asofLabel, checkHoldings, EngineInputError, engineWeights, equalWeight, fillYieldBook, loadUniverse, parseRawHistory,
  parseRuleFile, tiltWeight, toHistory, type EngineRuleFile, type EngineSignals, type Holdings, type Universe, type Yields,
} from "../src/index.ts";

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
  compositePercentile: composite,
  panels: { macro: { label: null, percentile: composite }, onchain: { label: null, percentile: composite } },
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
      expect(asofLabel(raw, { date: r[0]!, asof: r[1]! }).compositePercentile).toBe(num(r[col("composite_pct")]!));
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
