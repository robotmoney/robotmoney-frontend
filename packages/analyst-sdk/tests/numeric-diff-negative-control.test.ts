// Decision D78 negative control: the value-by-value comparison the parity
// tests now use (expectSameUpToRounding, support/numeric-diff.ts) must reject
// a frozen original changed in any way that is more than rounding: a label, a
// null, a field order, an array length, an integer, or a number moved by more
// than 1e-9 of its size, whether that number is below 1 or above it. It must
// accept the unmutated copy and a change of one ulp. Each mutation is applied
// alone to the production SDK report original.
import { describe, expect, test } from "bun:test";
import { DISCRETE_TOL, expectSameUpToRounding } from "./support/numeric-diff.ts";
import { originalFile, readOriginal } from "./support/originals.ts";

const original = readOriginal(originalFile.sdkReport("production"));
type Json = Record<string, any>;
const fresh = (): Json => JSON.parse(original) as Json;
const text = (o: unknown): string => JSON.stringify(o, null, 2) + "\n";

// The next double above x (x finite and positive).
function nextUp(x: number): number {
  const b = new Float64Array([x]);
  const u = new BigUint64Array(b.buffer);
  u[0] = u[0]! + 1n;
  return b[0]!;
}

function mutate(edit: (o: Json) => void): string {
  const o = fresh();
  edit(o);
  return text(o);
}

// Fixed targets in the production report: a sub-1 panel index and a final value above 1.
const SUB1 = fresh().regime.panels.onchain.index as number;
const ABOVE1 = fresh().backtest.eth.composite.final_value as number;

const mutations: Record<string, string> = {
  "a changed label": mutate((o) => {
    expect(o.regime.label).toBe("neutral");
    o.regime.label = "risk_on";
  }),
  "a null turned to 0": mutate((o) => {
    expect(o.indicators[8].weight).toBeNull();
    o.indicators[8].weight = 0;
  }),
  "swapped key order": (() => {
    const o = fresh();
    const [a, b, ...rest] = Object.keys(o);
    const reordered: Json = { [b!]: o[b!], [a!]: o[a!] };
    for (const k of rest) reordered[k] = o[k];
    return text(reordered);
  })(),
  "a changed array length": mutate((o) => {
    o.indicators.pop();
  }),
  "an integer + 1": mutate((o) => {
    expect(Number.isInteger(o.days)).toBe(true);
    o.days += 1;
  }),
  "a sub-1 number moved by 2e-9 of its size": mutate((o) => {
    o.regime.panels.onchain.index = SUB1 * (1 + 2e-9);
  }),
  "a number above 1 moved by 2e-9 of its size": mutate((o) => {
    o.backtest.eth.composite.final_value = ABOVE1 * (1 + 2e-9);
  }),
};

describe("numeric-diff negative control (D78)", () => {
  test("the fixed targets are a number below 1 and a number above 1", () => {
    expect(SUB1).toBeGreaterThan(0);
    expect(SUB1).toBeLessThan(1);
    expect(ABOVE1).toBeGreaterThan(1);
  });

  test("the unmutated copy is accepted with no changed number", () => {
    const d = expectSameUpToRounding(text(fresh()), original, "unmutated");
    expect(d.numbers).toBeGreaterThan(100);
    expect(d.changed).toBe(0);
  });

  test("a one-ulp change below and above 1 is accepted as rounding", () => {
    const after = mutate((o) => {
      o.regime.panels.onchain.index = nextUp(SUB1);
      o.backtest.eth.composite.final_value = nextUp(ABOVE1);
    });
    const d = expectSameUpToRounding(after, original, "one ulp");
    expect(d.changed).toBe(2);
  });

  for (const [name, mutated] of Object.entries(mutations)) {
    test(`${name} is rejected`, () => {
      expect(mutated).not.toBe(text(fresh()));
      expect(() => expectSameUpToRounding(mutated, original, name)).toThrow(/beyond rounding/);
    });
  }

  test("the sub-1 mutation moves less than 1e-9 in absolute terms, so only a size-relative threshold catches it", () => {
    const moved = Math.abs(SUB1 * (1 + 2e-9) - SUB1);
    expect(moved).toBeLessThan(DISCRETE_TOL);
    expect(moved).toBeGreaterThan(DISCRETE_TOL * SUB1);
  });
});
