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
//
// Issue 1765 (AC 11): a methodology is one model value, and the version tag
// names its preset (packages/analyst-sdk/src/model/presets.ts). No other file
// under packages/analyst-sdk/src, and no file under backend/src/analytics,
// compares with or switches on the literals 'v3', 'v4' or 'v5': the engine
// reads the model, never the tag. The prepare stage of the SDK's regime engine
// (src/engine/prepare.ts) is the seam's caller for runRegime, runModel and the
// kept record; run.ts reaches it through runModel.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  "packages/analyst-sdk/src/engine/prepare.ts",
  "packages/analyst-sdk/src/research/legacy/regime-eq-comparison.ts",
  "packages/analyst-sdk/src/research/legacy/weighting-comparison.ts",
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

function tree(base: string = root, roots: readonly string[] = SCAN_ROOTS): Record<string, string> {
  const files: Record<string, string> = {};
  for (const r of roots) for (const f of tsFiles(join(base, r))) files[relative(base, f)] = readFileSync(f, "utf8");
  return files;
}

// ── AC 11: no version-literal branch outside the presets ─────────────────────
const VERSION_ROOTS = ["packages/analyst-sdk/src", "backend/src/analytics"];
// The MODELS preset module: the one place a tag is written as the id of its preset.
const PRESET_MODULE = "packages/analyst-sdk/src/model/presets.ts";
const VERSION_BRANCH = [/[!=]==?\s*['"]v[345]['"]/, /['"]v[345]['"]\s*[!=]==?/, /case\s+['"]v[345]['"]/];

export function versionBranches(files: Record<string, string>): Violation[] {
  const out: Violation[] = [];
  for (const [file, src] of Object.entries(files)) {
    if (file === PRESET_MODULE) continue;
    code(src).split("\n").forEach((text, i) => {
      if (VERSION_BRANCH.some((re) => re.test(text))) out.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return out;
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

describe("no version-literal branch outside the model presets (issue 1765, AC 11)", () => {
  test("no file under packages/analyst-sdk/src (but the preset module) or backend/src/analytics compares with or switches on 'v3', 'v4' or 'v5'", () => {
    const files = tree(root, VERSION_ROOTS);
    // The walk read each root, and the preset module is in it (and exempt).
    for (const r of VERSION_ROOTS) expect(Object.keys(files).filter((f) => f.startsWith(`${r}/`)).length, r).toBeGreaterThan(10);
    expect(files[PRESET_MODULE]).toMatch(/id: "v4"/);
    expect(versionBranches(files).map((x) => `${x.file}:${x.line}: ${x.text}`)).toEqual([]);
  });

  test("red control: planted branches are flagged with file and line in either order, as a case and with no spaces; prose and the preset module are not", () => {
    const planted: Record<string, string> = {
      "packages/analyst-sdk/src/engine/x.ts": 'const a = 1;\nif (version==="v5") return kept;\n',
      "packages/analyst-sdk/src/run.ts": "// version === \"v5\" in prose is fine\nif ('v4' !== v) throw e;\n",
      "backend/src/analytics/y.ts": 'switch (v) {\n  case "v3":\n    break;\n}\n',
      "backend/src/analytics/z.ts": "const keep = REGIME_LINE[v] === \"beside\";\nconst w = v === 'v6';\n",
      [PRESET_MODULE]: 'export const CURRENT: RegimeVersion = "v4";\nif (x === "v4") y();\n',
    };
    expect(versionBranches(planted).map((x) => `${x.file}:${x.line}`).sort()).toEqual([
      "backend/src/analytics/y.ts:2",
      "packages/analyst-sdk/src/engine/x.ts:2",
      "packages/analyst-sdk/src/run.ts:2",
    ]);
  });

  test("red control on disk: a planted file in a real tree is found by the same walk", () => {
    const tmp = mkdtempSync(join(tmpdir(), "regime-version-branch-"));
    try {
      for (const r of VERSION_ROOTS) mkdirSync(join(tmp, r, "analyze"), { recursive: true });
      writeFileSync(join(tmp, VERSION_ROOTS[0]!, "analyze", "planted.ts"), 'export const pick = (v: string) => (v === "v5" ? 1 : 0);\n');
      writeFileSync(join(tmp, VERSION_ROOTS[1]!, "analyze", "clean.ts"), "export const pick = (v: string) => v;\n");
      const files = tree(tmp, VERSION_ROOTS);
      expect(Object.keys(files).length).toBe(2);
      expect(versionBranches(files).map((x) => `${x.file}:${x.line}`)).toEqual([`${VERSION_ROOTS[0]}/analyze/planted.ts:1`]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
