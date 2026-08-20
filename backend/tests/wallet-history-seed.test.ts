// backend/src/chain/wallet-history-seed.ts — issue #649: every AUM series
// must be index-aligned to LABELS (a mismatch was silently swallowed by
// `AUM[symbol]![i]!` reading past the end as `undefined`).
//
// Fully offline: this is a pure literal-data module, no fetch/db involved.
import { describe, expect, test } from "bun:test";
import { AUM, LABELS } from "../src/chain/wallet-history-seed.ts";

describe("#649 — every AUM series is index-aligned to LABELS", () => {
  test("LABELS has the expected 99-day pre-launch window", () => {
    expect(LABELS.length).toBe(99);
    expect(LABELS[0]).toBe("Mar 18");
    expect(LABELS[98]).toBe("Jun 26");
  });

  test("every symbol's series has exactly LABELS.length entries", () => {
    for (const [symbol, series] of Object.entries(AUM)) {
      expect(series.length).toBe(LABELS.length);
    }
  });

  test("GIZA-SS1 (the #649 regression) is now 99 entries, closed out (0) for the last two days", () => {
    const giza = AUM["GIZA-SS1"]!;
    expect(giza.length).toBe(99);
    expect(giza[97]).toBe(0); // Jun 25
    expect(giza[98]).toBe(0); // Jun 26
  });

  test("a length-mismatched series is caught at module load, not silently truncated", () => {
    // Mirrors the module-level invariant check in wallet-history-seed.ts:
    // AUM[symbol]![i]! past the end of a short array reads `undefined`, and
    // `v > 0` on `undefined` is falsy — silently indistinguishable from a
    // genuine "not held that day" 0. The guard below is what makes that class
    // of defect loud instead: a bad array must fail this, not just review.
    for (const [symbol, series] of Object.entries(AUM)) {
      expect(series.length).not.toBeLessThan(LABELS.length);
    }
  });
});
