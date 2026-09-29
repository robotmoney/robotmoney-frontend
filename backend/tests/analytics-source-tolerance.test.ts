// Issue #1035 AC8: every source_key an extractor writes has a declared
// tolerance (analytics/source-tolerance.ts), decision D56 names each one, and
// the compaction migration applied the same values.
//
// WHY THE KEYS ARE READ OUT OF THE SOURCE. The table is only useful if it
// cannot silently fall behind the extractors: an unlisted key is compared
// exactly, which is safe but means its float noise keeps growing the ledger.
// So the expected key set is not written in this file — it is extracted from
// every capture call site under src/analytics/extract and src/analytics/access,
// and a call site whose key this resolver does not understand fails the test
// instead of being skipped.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { TOP7 } from "../src/analytics/analyze/research-signals.ts";
import { SOURCE_TOLERANCES, toleranceFor, withinTolerance } from "../src/analytics/source-tolerance.ts";

const srcDir = join(import.meta.dir, "..", "src", "analytics");
const repoRoot = join(import.meta.dir, "..", "..");

function extractorFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["extract", "access"]) {
    for (const f of readdirSync(join(srcDir, dir))) if (f.endsWith(".ts")) out.push(join(srcDir, dir, f));
  }
  return out;
}

// Every source-key EXPRESSION at a capture call site, resolved to the concrete
// keys it produces at runtime.
function resolve(expression: string, file: string): string[] {
  const e = expression.trim();
  const literal = /^"([^"]+)"$/.exec(e);
  if (literal) return [literal[1]!];
  if (e === "`raw_indicator_history:${ind.id}`") return INDICATORS.map((i) => `raw_indicator_history:${i.id}`);
  if (e === "`research:${sym}`") return TOP7.map((sym) => `research:${sym}`);
  throw new Error(
    `${file}: a capture call site names its source_key as \`${e}\`, which this test cannot resolve. ` +
      "Teach resolve() what it expands to, and give every resulting key an entry in SOURCE_TOLERANCES and D56.",
  );
}

function extractorSourceKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of extractorFiles()) {
    const text = readFileSync(file, "utf8");
    // captureSourceAcquisition({ ..., sourceKey: <expr>, ... }). `sourceKey: key`
    // is data-source.ts's local `acquire` wrapper forwarding its parameter; the
    // keys it forwards are read from the acquire(...) calls below.
    for (const m of text.matchAll(/sourceKey:\s*("[^"]*"|`[^`]*`|[\w.]+)/g)) {
      if (m[1]!.trim() === "key") continue;
      for (const k of resolve(m[1]!, file)) keys.add(k);
    }
    // acquire("<provider>", <key>, ...)
    for (const m of text.matchAll(/\bacquire\(\s*"[^"]+",\s*("[^"]*"|`[^`]*`|[\w.]+)/g)) {
      for (const k of resolve(m[1]!, file)) keys.add(k);
    }
  }
  return keys;
}

describe("issue #1035 AC8: a declared tolerance for every source_key the extractors write", () => {
  test("every extractor source_key has an entry in SOURCE_TOLERANCES", () => {
    const keys = extractorSourceKeys();
    // Non-vacuity: the registry alone is 26 keys; research and backtest add 17.
    expect(keys.size).toBeGreaterThanOrEqual(INDICATORS.length + 17);
    const missing = [...keys].filter((k) => !(k in SOURCE_TOLERANCES)).sort();
    expect(missing, "add these keys to SOURCE_TOLERANCES and to decision D56").toEqual([]);
  });

  test("the table lists no key an extractor no longer writes", () => {
    const keys = extractorSourceKeys();
    expect(Object.keys(SOURCE_TOLERANCES).filter((k) => !keys.has(k)).sort()).toEqual([]);
  });

  test("decision D56 in docs/decisions.md names every key with its tolerance", () => {
    const decisions = readFileSync(join(repoRoot, "docs", "decisions.md"), "utf8");
    const start = decisions.indexOf("## D56 ");
    expect(start, "docs/decisions.md must contain decision D56").toBeGreaterThan(-1);
    const next = decisions.indexOf("\n## D", start + 1);
    const d56 = decisions.slice(start, next === -1 ? undefined : next);
    for (const [key, tolerance] of Object.entries(SOURCE_TOLERANCES)) {
      const line = d56.split("\n").find((l) => l.includes(`\`${key}\``));
      expect(line, `D56 must name ${key}`).toBeDefined();
      const stated = tolerance.relative === 0 ? "exact" : "1e-6";
      expect({ key, line: line!.includes(stated) }).toEqual({ key, line: true });
    }
  });

  test("migration 0080 compacted with exactly D56's non-zero tolerances", () => {
    // 0080 is a frozen artefact: it applied the tolerances in force when it
    // shipped. If D56 changes later, pin this assertion to 0080's own snapshot
    // rather than editing the migration.
    const sql = readFileSync(join(import.meta.dir, "..", "migrations", "0080_analytics_ledger_compaction.sql"), "utf8");
    const map = /tol constant jsonb := '(\{[\s\S]*?\})'::jsonb/.exec(sql);
    expect(map).not.toBeNull();
    const applied = JSON.parse(map![1]!) as Record<string, number>;
    const declared = Object.fromEntries(
      Object.entries(SOURCE_TOLERANCES).filter(([, t]) => t.relative > 0).map(([k, t]) => [k, t.relative]),
    );
    expect(applied).toEqual(declared);
  });
});

describe("withinTolerance", () => {
  test("an exact source counts only equal values as the same observation", () => {
    expect(withinTolerance("raw_indicator_history:T10Y2Y", 1.25, 1.25)).toBe(true);
    expect(withinTolerance("raw_indicator_history:T10Y2Y", 1.25, 1.25 * (1 + 1e-12))).toBe(false);
  });

  test("a Yahoo source absorbs float32 jitter up to a relative 1e-6 and no further", () => {
    const v = 4523.68017578125;
    expect(withinTolerance("raw_indicator_history:VIX", v, v * (1 + 1e-7))).toBe(true);
    expect(withinTolerance("raw_indicator_history:VIX", v, v * (1 - 9e-7))).toBe(true);
    expect(withinTolerance("raw_indicator_history:VIX", v, v * (1 + 2e-6))).toBe(false);
    // Symmetric: which value is the head does not change the answer.
    expect(withinTolerance("raw_indicator_history:VIX", v * (1 + 1e-7), v)).toBe(true);
  });

  test("an unlisted key is compared exactly — the conservative default", () => {
    expect(toleranceFor("not-a-real:key")).toEqual({ relative: 0, basis: "exact" });
    expect(withinTolerance("not-a-real:key", 10, 10 * (1 + 1e-9))).toBe(false);
  });
});
