// backend/src/chain/wallet-history-seed.ts — issue #649 (per-symbol array
// length invariant) and #648 (SP500's unmarked v0-Hyperliquid/v1-Yahoo seam).
//
// Fully offline: this is a pure literal-data module, no fetch/db involved.
import { describe, expect, test } from "bun:test";
import { AUM, LABELS, walletHistorySeedRows } from "../src/chain/wallet-history-seed.ts";

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

describe("#648 / PD7 / D39 — SP500's source seam is marked, not silently spliced", () => {
  test("the SP500 seed array is all 99 pre-launch days (index 0-98), no more", () => {
    expect(AUM["SP500"]!.length).toBe(99);
  });

  test("index 98 (Jun 26, the marked seam) is the last value in the seed — everything after is live-sampled Yahoo data, outside this array", () => {
    expect(LABELS[98]).toBe("Jun 26");
    expect(AUM["SP500"]![98]).toBe(4656);
    // A future edit that appends more entries (shifting the seam past index
    // 98) or removes trailing entries (pulling it before Jun 26) must update
    // the inline seam comment in wallet-history-seed.ts and D39 — this pins
    // the array length so that edit cannot happen silently.
    expect(AUM["SP500"]!.length - 1).toBe(98);
  });

  test("SP500 is unheld (0, correctly sparse) before the position opens on Apr 17 (index 29)", () => {
    for (let i = 0; i < 29; i++) expect(AUM["SP500"]![i]).toBe(0);
    expect(LABELS[29]).toBe("Apr 17");
    expect(AUM["SP500"]![29]).toBeGreaterThan(0);
  });

  test("walletHistorySeedRows() emits an SP500 row for every held day, none for the pre-Apr-17 gap", () => {
    const rows = walletHistorySeedRows().filter((r) => r.symbol === "SP500");
    expect(rows.length).toBe(99 - 29);
    expect(rows[0]!.date).toBe("2026-04-17");
    expect(rows[rows.length - 1]!.date).toBe("2026-06-26");
  });
});
