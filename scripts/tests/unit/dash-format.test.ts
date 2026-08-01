// Unit coverage for the shared compact-currency formatter (issue #449).
//
// Before this module existed, the `$X.XXB` / `$X.XXM` / `$X.XK` compact-USD
// branch body was hand-copied into 15 alpine/views/*.js files, and the copies
// had already diverged: dash-vaults.js (plus dash-wallets.js,
// dash-lobster.js, and projects.js) checked the tier threshold against the
// RAW signed value instead of `Math.abs(n)`, so a negative billions/millions/
// thousands value fell through every tiered branch and rendered as an
// unscaled "$-500" rather than a properly scaled "$-2.00B". This test
// exercises the shared `fmtUsdCompact` directly (bun:test importing a pure
// production function straight out of an ES module, same pattern
// ask-roboto-matcher.test.ts already uses for matchAgents()) across the
// negative-value regression case, zero, and each K/M/B boundary — then
// structurally asserts none of the 15 listed view files re-implements its
// own compact-currency branch body instead of importing the shared one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fmtUsdCompact } from "../../../frontend/public/assets/js/app/alpine/lib/dash-format.js";

const repoRoot = join(import.meta.dir, "../../..");
const viewsDir = join(repoRoot, "frontend/public/assets/js/app/alpine/views");

describe("fmtUsdCompact — defaults (majority behavior: abs-checked tiers, 2dp base)", () => {
  test("null/undefined/non-finite -> em dash", () => {
    expect(fmtUsdCompact(null)).toBe("—");
    expect(fmtUsdCompact(undefined)).toBe("—");
    expect(fmtUsdCompact(NaN)).toBe("—");
    expect(fmtUsdCompact(Infinity)).toBe("—");
    expect(fmtUsdCompact(-Infinity)).toBe("—");
  });

  test("zero -> $0.00 by default (no zeroDash)", () => {
    expect(fmtUsdCompact(0)).toBe("$0.00");
  });

  test("positive values at each tier boundary", () => {
    expect(fmtUsdCompact(999)).toBe("$999.00");
    expect(fmtUsdCompact(1000)).toBe("$1.0K");
    expect(fmtUsdCompact(1_500)).toBe("$1.5K");
    expect(fmtUsdCompact(999_999)).toBe("$1000.0K");
    expect(fmtUsdCompact(1_000_000)).toBe("$1.00M");
    expect(fmtUsdCompact(2_340_000)).toBe("$2.34M");
    expect(fmtUsdCompact(999_999_999)).toBe("$1000.00M");
    expect(fmtUsdCompact(1_000_000_000)).toBe("$1.00B");
    expect(fmtUsdCompact(5_670_000_000)).toBe("$5.67B");
  });

  // The regression this issue exists to fix: dash-vaults.js (and
  // dash-wallets.js/dash-lobster.js/projects.js) checked `n >= 1e9` against
  // the SIGNED value, so a negative value never reached the tiered branches.
  test("negative values at each tier are scaled AND signed (the issue #449 regression)", () => {
    expect(fmtUsdCompact(-500)).toBe("$-500.00");
    expect(fmtUsdCompact(-1_500)).toBe("$-1.5K");
    expect(fmtUsdCompact(-2_340_000)).toBe("$-2.34M");
    expect(fmtUsdCompact(-5_670_000_000)).toBe("$-5.67B");
  });

  test("negative zero behaves like zero", () => {
    expect(fmtUsdCompact(-0)).toBe("$0.00");
  });
});

describe("fmtUsdCompact — baseDecimals option (dash-vaults.js/dash-wallets.js/dash-lobster.js/projects.js)", () => {
  test("baseDecimals:0 preserves the sub-$1K precision these views already had", () => {
    expect(fmtUsdCompact(500, { baseDecimals: 0 })).toBe("$500");
    expect(fmtUsdCompact(-500, { baseDecimals: 0 })).toBe("$-500");
    expect(fmtUsdCompact(0, { baseDecimals: 0 })).toBe("$0");
  });

  test("baseDecimals does not affect the K/M/B tiers", () => {
    expect(fmtUsdCompact(-1_500, { baseDecimals: 0 })).toBe("$-1.5K");
    expect(fmtUsdCompact(-2_000_000_000, { baseDecimals: 0 })).toBe("$-2.00B");
  });
});

describe("fmtUsdCompact — zeroDash option (projects.js)", () => {
  test("zeroDash renders exact zero as an em dash", () => {
    expect(fmtUsdCompact(0, { zeroDash: true })).toBe("—");
    expect(fmtUsdCompact(-0, { zeroDash: true })).toBe("—");
  });

  test("zeroDash does not affect nonzero values", () => {
    expect(fmtUsdCompact(500, { zeroDash: true, baseDecimals: 0 })).toBe("$500");
    expect(fmtUsdCompact(-500, { zeroDash: true, baseDecimals: 0 })).toBe("$-500");
  });
});

describe("fmtUsdCompact — smallPrecision option (dash-coin-profile.js)", () => {
  test("sub-$1 uses 6dp, $1-$1000 uses 4dp, same tiers above $1K", () => {
    expect(fmtUsdCompact(0.0000123, { smallPrecision: true })).toBe("$0.000012");
    expect(fmtUsdCompact(0.5, { smallPrecision: true })).toBe("$0.500000");
    expect(fmtUsdCompact(1, { smallPrecision: true })).toBe("$1.0000");
    expect(fmtUsdCompact(42.5, { smallPrecision: true })).toBe("$42.5000");
    expect(fmtUsdCompact(1_500, { smallPrecision: true })).toBe("$1.5K");
  });

  test("negative sub-$1 values are still signed", () => {
    expect(fmtUsdCompact(-0.5, { smallPrecision: true })).toBe("$-0.500000");
  });
});

describe("fmtUsdCompact — trillion + skipKTier + baseInteger options (regime.js)", () => {
  test("trillion tier above $1T", () => {
    expect(fmtUsdCompact(2_500_000_000_000, { trillion: true, skipKTier: true, baseInteger: true })).toBe("$2.50T");
    expect(fmtUsdCompact(-2_500_000_000_000, { trillion: true, skipKTier: true, baseInteger: true })).toBe("$-2.50T");
  });

  test("without trillion:true, values above $1T fall through to the B tier", () => {
    expect(fmtUsdCompact(2_500_000_000_000)).toBe("$2500.00B");
  });

  test("skipKTier: values under $1M fall to the rounded, comma-grouped base case, never a K tier", () => {
    expect(fmtUsdCompact(5_000, { skipKTier: true, baseInteger: true })).toBe("$5,000");
    expect(fmtUsdCompact(-5_000, { skipKTier: true, baseInteger: true })).toBe("$-5,000");
    expect(fmtUsdCompact(999_999, { skipKTier: true, baseInteger: true })).toBe("$999,999");
  });

  test("baseInteger rounds instead of using decimals", () => {
    expect(fmtUsdCompact(1234.6, { skipKTier: true, baseInteger: true })).toBe("$1,235");
  });
});

// Every listed view file must import the shared helper and must not
// re-implement its own `abs >= 1e9 ... 1e6 ... 1e3` compact-currency branch
// body — otherwise a 16th copy could silently reintroduce the same
// divergence this issue consolidates away.
const CONSOLIDATED_VIEWS = [
  "dash-vaults.js",
  "dash-agents.js",
  "dash-wallets.js",
  "dash-wallet-profile.js",
  "dash-vault-profile.js",
  "dash-agent-profile.js",
  "dash-project-profile.js",
  "dash-coin-profile.js",
  "dash-ask-roboto.js",
  "dash-lobster.js",
  "projects.js",
  "list.js",
  "list2.js",
  "list3.js",
  "regime.js",
];

// Matches the literal `"$" + (n / 1e9).toFixed(2) + "B"` shape every
// hand-rolled compact-CURRENCY branch body shared, regardless of which
// variable (`n` vs `abs`) fed the division or what the base-case precision
// was — i.e. the actual duplicated business logic this issue consolidates.
// Requires the leading `"$" + ` so this does NOT flag regime.js's unrelated,
// out-of-scope `count`-unit branch (`Math.abs(v) >= 1e6 ? (v / 1e6)...`),
// which has no "$" and was never one of the 15 divergent copies.
const BILLION_BRANCH_RE = /["']\$["']\s*\+\s*\(\s*\w+\s*\/\s*1e9\)\.toFixed\(2\)\s*\+\s*["']B["']/;
const MILLION_BRANCH_RE = /["']\$["']\s*\+\s*\(\s*\w+\s*\/\s*1e6\)\.toFixed\(2\)\s*\+\s*["']M["']/;

describe("consolidation: every listed view imports the shared helper, none re-implements it", () => {
  for (const file of CONSOLIDATED_VIEWS) {
    test(`${file} imports fmtUsdCompact from alpine/lib/dash-format.js`, () => {
      const src = readFileSync(join(viewsDir, file), "utf8");
      expect(src).toMatch(/from\s+["']\.\.\/lib\/dash-format\.js["']/);
      expect(src).toContain("fmtUsdCompact");
    });

    test(`${file} does not re-implement its own tiered compact-currency branch body`, () => {
      const src = readFileSync(join(viewsDir, file), "utf8");
      expect(src).not.toMatch(BILLION_BRANCH_RE);
      expect(src).not.toMatch(MILLION_BRANCH_RE);
    });
  }
});
