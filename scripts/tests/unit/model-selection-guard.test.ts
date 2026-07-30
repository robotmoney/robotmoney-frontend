// EXECUTES scripts/checks/check-model-selection.sh — it is not enough for a
// guard to exist in the tree and be named in a workflow. A guard whose scan
// silently matches nothing exits 0 forever and reports a green that means
// nothing, which is exactly the failure mode docs/decisions.md D22's amendment
// and the repo's test-coverage policy call out. So every test below runs the
// real script as a subprocess against a PLANTED fixture tree and asserts on the
// exit code: each property is proven to go RED on a violation and GREEN on a
// clean tree.
//
// Fixture trees are built in a temp dir per test and always contain
// scripts/lib/model-registry.ts, because that file is the script's existence
// anchor — its absence is itself a failure (asserted below).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const GUARD = join(import.meta.dir, "../../checks/check-model-selection.sh");

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "model-selection-guard-"));
  made.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function run(root: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bash", GUARD, root], { stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode ?? -1,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}

// Every fixture needs the anchor, or the script aborts before scanning.
const ANCHOR = { "scripts/lib/model-registry.ts": 'export const ZEN_PREFIX = "opencode/";\n' };

describe("check-model-selection.sh (executed, not merely present)", () => {
  test("a clean tree passes", () => {
    const root = tree({
      ...ANCHOR,
      "scripts/lib/demo.ts": 'import { resolveAgentModel } from "./model-registry.ts";\nconst m = resolveAgentModel();\n',
    });
    const r = run(root);
    expect(r.out).toContain("check-model-selection: OK");
    expect(r.code).toBe(0);
  });

  test("property 1: a raw model-id literal outside the registry is RED", () => {
    const root = tree({
      ...ANCHOR,
      "scripts/lib/sneaky.ts": 'const model = "opencode/gpt-5.4";\n',
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/model ids belong ONLY in scripts\/lib\/model-registry\.ts/);
    expect(r.out).toContain("scripts/lib/sneaky.ts");
  });

  test("property 1: a raw model id in a WORKFLOW is RED (the ambient-selection case)", () => {
    const root = tree({
      ...ANCHOR,
      ".github/workflows/some.yml": 'jobs:\n  x:\n    steps:\n      - run: opencode run --model "opencode/kimi-k2.6"\n',
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain("some.yml");
  });

  test("property 1 does NOT fire on a comment, a backticked doc mention, or an opencode release URL", () => {
    // All three appear in the real tree today; a guard that reds on them is a
    // guard nobody can keep green, and each is the opposite of ambient
    // selection — prose and a binary download, not a model selection.
    const root = tree({
      ...ANCHOR,
      "scripts/lib/documented.ts": '// default is `opencode/deepseek-v4-flash`, resolved via the registry\nconst m = resolveAgentModel();\n',
      ".github/workflows/dl.yml": '      - run: curl -L "https://github.com/anomalyco/opencode/releases/download/v1.2.3/opencode-linux-x64.tar.gz"\n',
      "docker-compose.demo.yml": "  # unset takes the repo default (`opencode/deepseek-v4-flash`)\n",
    });
    const r = run(root);
    expect(r.out).toContain("check-model-selection: OK");
    expect(r.code).toBe(0);
  });

  test("property 2: a retired credential/model knob is RED", () => {
    for (const knob of ["OPENCODE_MODEL", "ONBOARDING_EVAL_MODEL", "ANTHROPIC_API_KEY"]) {
      const root = tree({ ...ANCHOR, "scripts/lib/old.ts": `const v = process.env.${knob};\n` });
      const r = run(root);
      expect(r.code, knob).toBe(1);
      expect(r.out, knob).toMatch(/retired model\/credential knob/);
    }
  });

  test("property 5: an advisory reviewer that does not resolve via keylessModel() is RED", () => {
    const root = tree({
      ...ANCHOR,
      "scripts/contribution-advisory-reviewer.ts": "export const CONTRIBUTION_REVIEW_MODEL = someOtherThing();\n",
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/must resolve its model via keylessModel\(\)/);
  });

  test("property 5 passes when it does resolve via keylessModel()", () => {
    const root = tree({
      ...ANCHOR,
      "scripts/contribution-advisory-reviewer.ts": 'import { keylessModel } from "./lib/model-registry.ts";\nexport const M = keylessModel();\n',
    });
    expect(run(root).code).toBe(0);
  });

  test("properties 3 and 4 fire ONLY when evals/ exists, and are announced as unscanned when it does not", () => {
    const absent = run(tree({ ...ANCHOR }));
    expect(absent.code).toBe(0);
    // Loud about the gap — never a silent pass that reads as full coverage.
    expect(absent.out).toContain("NOT SCANNED");
    expect(absent.out).toContain("#278");

    const skip = run(tree({ ...ANCHOR, "evals/a.ts": "test.skip('x', () => {});\n" }));
    expect(skip.code).toBe(1);
    expect(skip.out).toMatch(/no conditional skip/);

    const mock = run(tree({ ...ANCHOR, "evals/b.ts": "const m = mock(() => 1);\n" }));
    expect(mock.code).toBe(1);
    expect(mock.out).toMatch(/no mock, stub, or injection seam/);
  });

  test("a missing registry anchor is RED — the guard can never be silently empty", () => {
    // The failure this exists to prevent: someone renames/moves the registry,
    // every scan path still resolves, nothing matches, and the check goes green
    // while enforcing nothing at all.
    const root = tree({ "scripts/lib/something-else.ts": "export const x = 1;\n" });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/expected the model registry/);
    expect(r.out).toMatch(/silently empty guard/);
  });

  // ── declared-roots meta-assertion (issue #276) ────────────────────────────
  // Same shape as runtime-import-guard.test.ts's declaredRoots(): read the
  // guard's OWN scan_roots=() declaration out of the shell source rather than
  // hand-maintaining a second list, so a root ADDED to the script without a
  // corresponding planted-violation control below goes red here instead of
  // shipping a guard that silently never scans it.
  function declaredRoots(scriptText: string): string[] {
    const block = /^scan_roots=\(\n([\s\S]*?)^\)/m.exec(scriptText);
    if (!block) throw new Error("check-model-selection.sh no longer declares a scan_roots=() array");
    return block[1]
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        const m = /^"([^"]+)"$/.exec(l);
        if (!m) throw new Error(`unparsed entry in scan_roots(): ${l}`);
        return m[1];
      });
  }

  // The docker-compose*.yml glob root cannot live in scan_roots (it is a glob,
  // not a directory) — declared and controlled separately below.
  const SCAN_ROOTS = ["scripts", ".github/workflows", "evals"];

  test("the guard declares exactly the roots this suite proves — a new root must arrive with its own control", () => {
    expect(declaredRoots(readFileSync(GUARD, "utf8")).sort()).toEqual([...SCAN_ROOTS].sort());
  });

  test("an ADDED root is caught even behind a trailing comment, and an unparsable entry THROWS rather than being silently dropped", () => {
    const src = readFileSync(GUARD, "utf8");
    const tampered = src.replace('  "evals"\n', '  "evals"\n  "newroot" # added later\n');
    expect(tampered).not.toBe(src);
    expect(declaredRoots(tampered)).toContain("newroot");
    expect(declaredRoots(tampered).sort()).not.toEqual([...SCAN_ROOTS].sort());
    expect(() => declaredRoots(src.replace('  "evals"\n', '  "evals"\n  $EXTRA_ROOT\n'))).toThrow(/unparsed entry/);
  });

  for (const rel of SCAN_ROOTS) {
    test(`property 1 FAILS on a raw model-id literal planted in ${rel}/ — that root is really scanned`, () => {
      const root = tree({ ...ANCHOR, [`${rel}/planted.ts`]: 'const m = "opencode/planted-model";\n' });
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/model ids belong ONLY in scripts\/lib\/model-registry\.ts/);
    });

    test(`property 2 FAILS on a retired knob planted in ${rel}/ — that root is really scanned`, () => {
      const root = tree({ ...ANCHOR, [`${rel}/planted.ts`]: "const v = process.env.OPENCODE_MODEL;\n" });
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/retired model\/credential knob/);
    });
  }

  // The docker-compose*.yml glob root: declared separately from scan_roots
  // (see the comment above SCAN_ROOTS), so it gets its own explicit control
  // rather than riding the loop above.
  test("property 1 FAILS on a raw model-id literal planted in a root docker-compose*.yml — the glob root is really scanned", () => {
    const root = tree({ ...ANCHOR, "docker-compose.instance.yml": '# model: "opencode/planted-model"\n  AGENT_MODEL_FALLBACK: "opencode/planted-model"\n' });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/model ids belong ONLY in scripts\/lib\/model-registry\.ts/);
  });

  test("the docker-compose*.yml glob root is still declared in the script — removing it must be caught", () => {
    const src = readFileSync(GUARD, "utf8");
    expect(src).toContain('"$target_root"/docker-compose*.yml');
  });

  test("the guard passes on THIS repository's real tree", () => {
    // Binds the fixture-proven behaviour to the actual codebase: without this,
    // every test above could pass while the real tree violates the rule.
    const repoRoot = join(import.meta.dir, "../../..");
    const p = Bun.spawnSync(["bash", GUARD], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    expect(out).toContain("check-model-selection: OK");
    expect(p.exitCode).toBe(0);
  });
});
