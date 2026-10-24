// Issue 1421 negative control: the byte comparison every parity test relies on
// (bytesEqual, support/originals.ts) must reject a golden report changed in any
// of the four ways a lenient comparison would forgive: one number, one field
// order, one null, one formatting character. There is no numeric tolerance.
// This file passes only when all four mutations are rejected and the
// unmutated copy is accepted.
import { describe, expect, test } from "bun:test";
import { bytesEqual, originalFile, readOriginal } from "./support/originals.ts";

const golden = readOriginal(originalFile.sdkReport("production"));

function replaceOnce(text: string, find: RegExp, replace: (m: string) => string): string {
  const m = find.exec(text);
  if (!m) throw new Error(`mutation target ${find} not found in the golden report`);
  return text.slice(0, m.index) + replace(m[0]) + text.slice(m.index + m[0].length);
}

const mutations: Record<string, string> = {
  // Last digit of the first fractional number: the smallest numeric change JSON can carry.
  "one number": replaceOnce(golden, /-?\d+\.\d+/, (n) => n.slice(0, -1) + (n.endsWith("1") ? "2" : "1")),
  // Swap the first two fields of the top-level object.
  "one field order": (() => {
    const obj = JSON.parse(golden) as Record<string, unknown>;
    const [a, b, ...rest] = Object.keys(obj);
    const reordered: Record<string, unknown> = { [b!]: obj[b!], [a!]: obj[a!] };
    for (const k of rest) reordered[k] = obj[k];
    return JSON.stringify(reordered, null, 2) + "\n";
  })(),
  // Turn the first null into 0.
  "one null": replaceOnce(golden, /\bnull\b/, () => "0"),
  // Drop one space of indentation.
  "one formatting character": replaceOnce(golden, /\n {4}"/, (m) => m.replace("    ", "   ")),
};

describe("byte comparison negative control", () => {
  test("the unmutated copy is accepted", () => {
    expect(bytesEqual(String(golden), golden)).toBe(true);
  });

  for (const [name, mutated] of Object.entries(mutations)) {
    test(`a golden report with ${name} changed is rejected`, () => {
      expect(mutated).not.toBe(golden);
      expect(bytesEqual(mutated, golden)).toBe(false);
    });
  }

  test("each mutation still parses as JSON, so only a byte comparison can catch it", () => {
    for (const [name, mutated] of Object.entries(mutations)) {
      expect(() => JSON.parse(mutated), name).not.toThrow();
    }
    // The field-order and formatting mutations are semantically equal to the
    // golden: a parse-and-compare check would wrongly accept both.
    expect(JSON.parse(mutations["one field order"]!)).toEqual(JSON.parse(golden));
    expect(JSON.parse(mutations["one formatting character"]!)).toEqual(JSON.parse(golden));
  });

  test("all four mutations are rejected", () => {
    const rejected = Object.values(mutations).filter((m) => !bytesEqual(m, golden));
    expect(rejected.length).toBe(4);
  });
});
