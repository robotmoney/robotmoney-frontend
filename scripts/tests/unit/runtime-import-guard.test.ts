// PURE, per-PR execution of the dependency-direction guard
// (docs/decisions.md D23, docs/architecture.md §3 L3).
//
// L3: "tests and evals may import runtime and shared code; RUNTIME MUST NEVER
// IMPORT TEST OR EVAL CODE; both may import shared." A lint that is never
// executed is not a gate, so this file RUNS
// scripts/checks/check-no-test-imports-in-runtime.sh — against the real tree
// (must pass) and against fixture trees carrying a planted violation (must
// fail). The negative controls are the load-bearing half: without them a typo in
// the pattern, a renamed scan root, or a `grep` that silently matched nothing
// would leave the guard exit-0 theatre forever.
//
// It also asserts the WIRING (the guard runs in the required `integration` job)
// and the cost-class split the guard protects, per §3 L1: scripts/tests/ is
// unit/ + integration/, `test:unit`/`test:integration` select each class, and
// the recursive `test` aggregate still covers both.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const CHECK = join(repoRoot, "scripts", "checks", "check-no-test-imports-in-runtime.sh");

function runCheck(targetRoot?: string): { exitCode: number; output: string } {
  const r = Bun.spawnSync(["bash", CHECK, ...(targetRoot ? [targetRoot] : [])], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const dec = new TextDecoder();
  return { exitCode: r.exitCode ?? -1, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
}

// A minimal RUNTIME tree the check can scan: <root>/<dir>/<file>.
function fixtureTree(fileName: string, contents: string, dir = "scripts"): string {
  const root = mkdtempSync(join(tmpdir(), "runtime-import-guard-"));
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, fileName), contents);
  return root;
}

describe("check-no-test-imports-in-runtime.sh", () => {
  test("the guard script exists and is executable content, not a stub", () => {
    expect(existsSync(CHECK)).toBe(true);
    expect(readFileSync(CHECK, "utf8")).toContain("check-no-test-imports-in-runtime");
  });

  test("the real tree PASSES — no runtime tree imports test or eval code", () => {
    const r = runCheck();
    expect(r.output).toContain("check-no-test-imports-in-runtime: OK");
    expect(r.exitCode).toBe(0);
  });

  // ── negative controls: the guard must be able to FAIL ──────────────────────
  const violations: Array<[string, string, string]> = [
    ["an import from a tests/ tree", "a.ts", 'import { h } from "../tests/helpers.ts";\n'],
    ["an import of a *.test.ts module", "b.ts", 'import { x } from "./thing.test.ts";\n'],
    ["an import of a *.spec.ts module", "c.ts", 'import { x } from "./thing.spec.ts";\n'],
    ["a require() of a test tree", "d.ts", 'const h = require("../__tests__/helpers");\n'],
    ["an import from __mocks__/", "e.ts", 'import { db } from "../__mocks__/db.ts";\n'],
    ["an import from evals/", "f.ts", 'import { score } from "../evals/onboarding/support/scorecard.ts";\n'],
    ["a bare re-export from a test file", "g.ts", 'export { fixture } from "./x.test.ts";\n'],
  ];

  for (const [what, fileName, contents] of violations) {
    test(`FAILS on ${what} — the guard cannot be vacuously green`, () => {
      const root = fixtureTree(fileName, contents);
      try {
        const r = runCheck(root);
        expect(r.exitCode).not.toBe(0);
        expect(r.output).toContain("check-no-test-imports-in-runtime: FAILED");
        // The message must name the RULE, not just the file, or the next person
        // to hit it has to reverse-engineer the intent from a grep dump.
        expect(r.output).toContain("runtime code must never import test or eval code");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  // ── EVERY scan root, not just the first ───────────────────────────────────
  // The cases above all plant into scripts/, so dropping any OTHER entry from
  // the guard's `roots=()` array would leave this suite green while that tree
  // went unscanned forever. One planted violation per declared root closes it.
  const SCAN_ROOTS = ["backend/src", "contract/src", "frontend/public/assets/js", "scripts"];

  // Read out of the guard's OWN `roots=()` declaration rather than by scanning
  // the file for bare quoted lines: the older shape (`/^\s*"[^"]+"\s*$/`) caught
  // a REMOVED root but was bypassed by an ADDED one carrying a trailing comment
  // — `"newroot/src" # added later` failed the `\s*$` anchor, so the extracted
  // set came back unchanged and a root with no planted-violation control sailed
  // through. Comments are stripped first, and an entry that does not parse
  // THROWS rather than being quietly dropped.
  function declaredRoots(scriptText: string): string[] {
    const block = /^roots=\(\n([\s\S]*?)^\)/m.exec(scriptText);
    if (!block) throw new Error("check-no-test-imports-in-runtime.sh no longer declares a roots=() array");
    return block[1]
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        const m = /^"([^"]+)"$/.exec(l);
        if (!m) throw new Error(`unparsed entry in roots=(): ${l}`);
        return m[1];
      });
  }

  test("the guard declares exactly the roots this suite proves — a new root must arrive with its own control", () => {
    expect(declaredRoots(readFileSync(CHECK, "utf8")).sort()).toEqual([...SCAN_ROOTS].sort());
  });

  test("an ADDED root is caught even behind a trailing comment — the removal case was never the whole risk", () => {
    const src = readFileSync(CHECK, "utf8");
    const tampered = src.replace('  "scripts"\n', '  "scripts"\n  "newroot/src" # added later\n');
    expect(tampered).not.toBe(src); // the anchor still exists; a reshuffle must not silently no-op
    expect(declaredRoots(tampered)).toContain("newroot/src");
    expect(declaredRoots(tampered).sort()).not.toEqual([...SCAN_ROOTS].sort());
    // ...and an entry in a shape this test cannot verify is loud, not ignored.
    expect(() => declaredRoots(src.replace('  "scripts"\n', '  "scripts"\n  $EXTRA_ROOT\n'))).toThrow(/unparsed entry/);
  });

  for (const rel of SCAN_ROOTS) {
    test(`FAILS on a violation planted in ${rel}/ — that root is really scanned`, () => {
      const root = fixtureTree("planted.ts", 'import { x } from "./thing.test.ts";\n', rel);
      try {
        const r = runCheck(root);
        expect(r.exitCode).not.toBe(0);
        expect(r.output).toContain("runtime code must never import test or eval code");
        expect(r.output).toContain(join(rel, "planted.ts"));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("FAILS on a tree with no runtime directory at all — a guard over zero paths is a green that means nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "runtime-import-guard-empty-"));
    try {
      const r = runCheck(empty);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("no runtime tree to scan");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("PASSES on a clean fixture tree — it is not failing for an unrelated reason", () => {
    const root = fixtureTree("clean.ts", 'import { join } from "node:path";\nexport const P = join("a", "b");\n');
    try {
      expect(runCheck(root).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does NOT fire on prose that merely names a spec file — a guard that cries wolf gets deleted", () => {
    const root = fixtureTree("prose.ts", "// see frontend/test/browser/spa.spec.ts for the browser side\n");
    try {
      expect(runCheck(root).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is wired into the required repo-guards workflow — a guard nobody runs is not a gate", () => {
    const wf = readFileSync(join(repoRoot, ".github", "workflows", "repo-guards.yml"), "utf8");
    expect(wf).toContain("bash scripts/checks/check-no-test-imports-in-runtime.sh");
  });
});

describe("scripts/tests/ cost-class split (§3 L1)", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };

  test("both cost directories exist and hold tests — an empty class is a silent coverage hole", () => {
    for (const cls of ["unit", "integration"]) {
      const dir = join(repoRoot, "scripts", "tests", cls);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).filter((f) => f.endsWith(".test.ts")).length).toBeGreaterThan(0);
    }
  });

  test("no test file is left loose at the scripts/tests/ root — every test declares its cost class by path", () => {
    const loose = readdirSync(join(repoRoot, "scripts", "tests")).filter((f) => f.endsWith(".test.ts"));
    expect(loose).toEqual([]);
  });

  test("each class has its own selector, and the aggregate still covers BOTH", () => {
    expect(pkg.scripts["test:unit"]).toBe("bun test scripts/tests/unit");
    expect(pkg.scripts["test:integration"]).toBe("bun test scripts/tests/integration");
    // `bun test scripts/tests` recurses, so the aggregate cannot silently lose
    // the expensive half — and the workflow runs the two selectors by name.
    expect(pkg.scripts.test).toBe("bun test scripts/tests");
  });

  test("unit and integration workflows execute their respective cost classes per PR", () => {
    const unitWf = readFileSync(join(repoRoot, ".github", "workflows", "unit.yml"), "utf8");
    const integrationWf = readFileSync(join(repoRoot, ".github", "workflows", "integration.yml"), "utf8");
    expect(unitWf).toContain("bun run test:unit");
    expect(integrationWf).toContain("bun run test:integration");
  });

  test("`bun test` over an empty selection is RED — 0 tests collected can never be a green", () => {
    const r = Bun.spawnSync(["bun", "test", "scripts/tests/does-not-exist"], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(r.exitCode).not.toBe(0);
  });
});
