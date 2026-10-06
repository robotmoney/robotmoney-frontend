// Decision D59 (issue #1095): `prepareRegimeInputs` in packages/analyst-sdk/src/
// prepare.ts is the only place the regime date axis, per-indicator alignment,
// transforms and forward-fill ages are built, and `cutAtAsof` beside it is how
// backtest extras are cut at the as-of day. Mechanical, not conventional: this
// file scans every .ts under packages/analyst-sdk/src, backend/src and
// backend/scripts and fails on any call to the axis/alignment primitives
// (`buildDateAxis`, `alignDailyForwardFill`, `alignDailyZeroFill`,
// `forwardFillAge`) or any `.filter(` on `.date <= asof` outside the seam and the
// listed exceptions. It also asserts that every caller D59 names still calls the
// seam, so a caller that quietly rebuilt its own axis would fail here before the
// equivalence test ever ran.
//
// Exceptions, each with its reason:
//   - packages/analyst-sdk/src/transform/math.ts defines the primitives.
//   - packages/analyst-sdk/src/analyze/research-signals.ts builds the axes for
//     the two research signals (channel divergence, late cycle). Those are not
//     regime inputs and have their own start dates; D59 does not cover them.
//   - backend/scripts/regime-independent-reference-regenerate.ts rebuilds the
//     axis on purpose: it is the independent reference the fidelity tests
//     compare the seam against, and sharing the seam would make that vacuous.
//
// RED CONTROL: the scanner is also run against planted violations and must flag
// every one, so a scanner that matches nothing cannot pass for a clean tree.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "../../..");
const SCAN_ROOTS = ["packages/analyst-sdk/src", "backend/src", "backend/scripts"];
const SEAM = "packages/analyst-sdk/src/prepare.ts";
const ALLOWED = new Set([
  SEAM,
  "packages/analyst-sdk/src/transform/math.ts",
  "packages/analyst-sdk/src/analyze/research-signals.ts",
  "backend/scripts/regime-independent-reference-regenerate.ts",
]);
// Every caller D59 and regime-engine.md section 8.1 name. Each must import the seam.
const REQUIRED_CALLERS = [
  "backend/src/analytics/index.ts",
  "packages/analyst-sdk/src/run.ts",
  "packages/analyst-sdk/src/analyze/regime-eq-comparison.ts",
  "packages/analyst-sdk/src/analyze/weighting-comparison.ts",
  "backend/scripts/regime-goldens-regenerate.ts",
];
const PRIMITIVE_CALL = /\b(buildDateAxis|alignDailyForwardFill|alignDailyZeroFill|forwardFillAge)\s*\(/;
// An inline as-of cut on a dated row set, the shape `cutAtAsof` replaced.
const INLINE_ASOF_CUT = /\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.date\s*<=\s*asof\s*\)/;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) tsFiles(full, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// Strip line and block comments so a mention in prose is not a call.
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

type Violation = { file: string; line: number; text: string };

export function scan(files: Record<string, string>): Violation[] {
  const out: Violation[] = [];
  for (const [file, src] of Object.entries(files)) {
    if (ALLOWED.has(file)) continue;
    code(src).split("\n").forEach((text, i) => {
      if (PRIMITIVE_CALL.test(text) || INLINE_ASOF_CUT.test(text)) out.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

function tree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const r of SCAN_ROOTS) for (const f of tsFiles(join(root, r))) files[relative(root, f)] = readFileSync(f, "utf8");
  return files;
}

describe("D59 seam guard: regime inputs are built only by prepareRegimeInputs", () => {
  test("no axis/alignment primitive is called outside the seam and the listed exceptions", () => {
    const v = scan(tree());
    expect(v.map((x) => `${x.file}:${x.line}: ${x.text}`)).toEqual([]);
  });

  test("every caller D59 names imports the seam, and the exceptions still exist", () => {
    const files = tree();
    for (const f of REQUIRED_CALLERS) {
      expect(files[f], f).toBeDefined();
      expect(code(files[f]!), `${f} must call prepareRegimeInputs`).toMatch(/\bprepareRegimeInputs\s*\(/);
    }
    for (const f of ALLOWED) expect(files[f], `${f} is listed as an exception but does not exist`).toBeDefined();
    // The seam exports both names the callers rely on.
    expect(files[SEAM]).toMatch(/export function prepareRegimeInputs\(/);
    expect(files[SEAM]).toMatch(/export function cutAtAsof</);
  });

  test("the backend job cuts extras through the seam, not inline", () => {
    const src = code(tree()["backend/src/analytics/index.ts"]!);
    expect(src).toMatch(/cutAtAsof\(fetchedExtras\.spx,\s*asof\)/);
    expect(src).toMatch(/cutAtAsof\(fetchedExtras\.eth,\s*asof\)/);
    expect(src).toMatch(/cutAtAsof\(fetchedExtras\.tbill3m,\s*asof\)/);
  });

  test("red control: planted violations are flagged, comments are not", () => {
    const planted: Record<string, string> = {
      "backend/src/analytics/other.ts": "const axis = buildDateAxis(start, asof);\n",
      "packages/analyst-sdk/src/analyze/x.ts": "// buildDateAxis(start, asof) in a comment is fine\nconst a = alignDailyForwardFill(s, axis);\n",
      "backend/scripts/y.ts": "const ages = forwardFillAge(s, axis); const z = alignDailyZeroFill(s, axis);\n",
      "backend/src/analytics/z.ts": "const spx = fetched.spx.filter((p) => p.date <= asof);\n",
      "packages/analyst-sdk/src/analyze/research-signals.ts": "buildDateAxis(CHANNEL_START, asof);\n",
      "backend/src/clean.ts": "/* alignDailyForwardFill( */ const ok = prepareRegimeInputs(raw, { start, asof });\n",
    };
    const v = scan(planted);
    expect(v.map((x) => `${x.file}:${x.line}`).sort()).toEqual([
      "backend/scripts/y.ts:1",
      "backend/src/analytics/other.ts:1",
      "backend/src/analytics/z.ts:1",
      "packages/analyst-sdk/src/analyze/x.ts:2",
    ]);
  });
});
