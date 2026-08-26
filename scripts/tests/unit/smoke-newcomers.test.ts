// Unit tests for scripts/lib/smoke-newcomers.ts — the standing smoke's FIXED,
// FINITE newcomer roster. Previously this logic lived as a closure inside
// smoke-main.ts's main() (untestable without a full smoke boot) and fell back
// to a generated `Astra ${n+1}` name forever once its curated list ran out,
// which — combined with a separate silent-fallback bug in the roster-cap
// pre-check (see scripts/tests/unit/e2e-active-member-count.test.ts) — let the smoke
// keep admitting new named agents indefinitely instead of settling at a
// bounded size.
//
// Contract under test: exactly 5 named newcomers, in a fixed order: Helios,
// Selene, Rhea, Nyx, Eos. plannedNewcomer(n) returns null for n >= 5 — no
// generated fallback name, ever.
import { describe, expect, test } from "bun:test";
import { NEWCOMER_LENSES, NEWCOMER_NAMES, plannedNewcomer } from "../../lib/smoke-newcomers.ts";

describe("NEWCOMER_NAMES — fixed, finite roster", () => {
  test("is exactly 5 names, in this exact order", () => {
    expect(NEWCOMER_NAMES).toEqual(["Helios", "Selene", "Rhea", "Nyx", "Eos"]);
  });

  test("every name is unique", () => {
    expect(new Set(NEWCOMER_NAMES).size).toBe(NEWCOMER_NAMES.length);
  });
});

describe("plannedNewcomer(n)", () => {
  test("returns the correct name for each of the 5 valid indices", () => {
    const names = [0, 1, 2, 3, 4].map((n) => plannedNewcomer(n)?.name);
    expect(names).toEqual(["Helios", "Selene", "Rhea", "Nyx", "Eos"]);
  });

  test("returns a well-formed memberId, lens, and bias for a valid index", () => {
    const p = plannedNewcomer(0);
    expect(p).not.toBeNull();
    expect(p!.memberId).toBe("helios");
    expect(NEWCOMER_LENSES).toContain(p!.lens);
    expect(p!.bias).toBeGreaterThanOrEqual(-0.1);
    expect(p!.bias).toBeLessThanOrEqual(0.1);
  });

  test("memberId is lowercase with spaces replaced by hyphens (stable identity contract)", () => {
    // No current name has a space, but the transform must still hold — the
    // backend keys members by this exact id.
    for (let n = 0; n < NEWCOMER_NAMES.length; n++) {
      const p = plannedNewcomer(n)!;
      expect(p.memberId).toBe(p.name.toLowerCase().replace(/\s+/g, "-"));
    }
  });

  test("returns null at n=5 — the list boundary, no generated fallback", () => {
    expect(plannedNewcomer(5)).toBeNull();
  });

  test("returns null for every index past the fixed list — never generates an Astra-N-style name", () => {
    for (const n of [5, 6, 10, 100, 1000]) {
      expect(plannedNewcomer(n)).toBeNull();
    }
  });

  test("is deterministic — same n always plans the same newcomer", () => {
    expect(plannedNewcomer(2)).toEqual(plannedNewcomer(2));
  });
});
