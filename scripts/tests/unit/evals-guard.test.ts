// PURE, per-PR execution of the eval guard (docs/decisions.md D22 rules 1-2,
// docs/architecture.md §11.3 E1/E2, §3 L3).
//
// A lint that is never executed is not a gate. This file RUNS
// scripts/checks/check-eval-keyless.sh — against the real tree (must pass) and
// against fixture trees that violate each rule (must fail). The negative
// controls are the load-bearing half: without them a broken pattern, a typo in
// a path, or a `grep` that silently matched nothing would leave the guard
// vacuously green forever.
//
// It also asserts the WIRING that keeps the eval off the per-PR path: `test`
// must not reach into evals/, the eval targets must exist and point at
// evals/onboarding, and tsconfig must include evals/**/*.ts (without which the
// whole suite is invisible to `bun run typecheck`).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const CHECK = join(repoRoot, "scripts", "checks", "check-eval-keyless.sh");

function runCheck(targetRoot?: string): { exitCode: number; output: string } {
  const r = Bun.spawnSync(["bash", CHECK, ...(targetRoot ? [targetRoot] : [])], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return { exitCode: r.exitCode ?? -1, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
}

// A minimal tree the check can scan: <root>/evals/onboarding/<file>.
function fixtureTree(fileName: string, contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "evals-guard-fixture-"));
  mkdirSync(join(root, "evals", "onboarding"), { recursive: true });
  writeFileSync(join(root, "evals", "onboarding", fileName), contents);
  return root;
}

describe("check-eval-keyless.sh", () => {
  test("the guard script exists and is executable content, not a stub", () => {
    expect(existsSync(CHECK)).toBe(true);
    expect(readFileSync(CHECK, "utf8")).toContain("check-eval-keyless");
  });

  test("the real tree PASSES (evals are keyless, env-free, skip-free, and double-free)", () => {
    const r = runCheck();
    expect(r.output).toContain("check-eval-keyless: OK");
    expect(r.exitCode).toBe(0);
  });

  // ── negative controls: the guard must be able to FAIL ─────────────────────
  const violations: Array<[string, string, string]> = [
    ["a provider key", "keyed.ts", 'const k = "ANTHROPIC_API_KEY";\n'],
    ["a model override knob", "model.ts", 'const m = process.env.OPENCODE_MODEL;\n'],
    ["any ambient-environment read", "env.ts", 'const v = process.env.SOMETHING;\n'],
    ["a conditional skip", "skip.ts", 'test.skip("nope", () => {});\n'],
    ["a skipIf guard", "skipif.ts", 'const t = test.skipIf(!hasDocker);\n'],
    ["an injection seam", "seam.ts", "export const runOnce = async () => ({ admitted: true });\n"],
    ["a test double", "double.ts", 'import { mock } from "bun:test";\n'],
  ];

  for (const [what, fileName, contents] of violations) {
    test(`FAILS on ${what} — the guard cannot be vacuously green`, () => {
      const root = fixtureTree(fileName, contents);
      try {
        const r = runCheck(root);
        expect(r.exitCode).not.toBe(0);
        expect(r.output).toContain("check-eval-keyless: FAILED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  // ── The SECOND scan root ──────────────────────────────────────────────────
  // Rule 1 scans scripts/agent/ as well as evals/, but every fixture above
  // plants only into evals/ — so dropping scripts/agent/ from the scan would
  // leave this suite green while the member-agent primitive went unchecked for
  // provider keys. This plants there instead, with a CLEAN evals/ alongside so
  // the failure can only come from the agent tree.
  test("FAILS on a provider key in scripts/agent/ — rule 1's second root is really scanned", () => {
    const root = fixtureTree("clean.ts", "export const LAYER = 'layer0';\n");
    try {
      mkdirSync(join(root, "scripts", "agent"), { recursive: true });
      writeFileSync(join(root, "scripts", "agent", "planted.ts"), 'const k = "ANTHROPIC_API_KEY";\n');
      const r = runCheck(root);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("check-eval-keyless: FAILED");
      expect(r.output).toContain(join("scripts", "agent", "planted.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── EVERY scan root, not just the two this suite happens to know ──────────
  // The two tests above are the only planted-violation controls that exist, and
  // each covers exactly one declared root. A THIRD root added to the script
  // would arrive with no control at all — scanned in name, unproven in fact —
  // and every test here would stay green. Pinning the declaration to a literal
  // makes that addition RED until its own control lands beside it.
  const EVAL_SCAN_ROOTS = ["evals", "scripts/agent"];

  // Read out of the script's OWN declarations (`<name>_dir="$target_root/<rel>"`),
  // with trailing comments stripped first: a line ending `# also scanned` must
  // not slip a root past this, or the meta-assertion only catches removals.
  function declaredScanRoots(scriptText: string): string[] {
    return scriptText
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .map((l) => /^[A-Za-z_][A-Za-z0-9_]*_dir="\$target_root\/([^"]+)"$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]);
  }

  test("the guard declares exactly the roots this suite proves — a new root must arrive with its own control", () => {
    expect(declaredScanRoots(readFileSync(CHECK, "utf8")).sort()).toEqual([...EVAL_SCAN_ROOTS].sort());
  });

  test("the root extractor sees an ADDED root, comment or not — otherwise it only catches removals", () => {
    const src = readFileSync(CHECK, "utf8");
    const tampered = src.replace(
      'agent_dir="$target_root/scripts/agent"',
      'agent_dir="$target_root/scripts/agent"\nlib_dir="$target_root/scripts/lib" # also scanned',
    );
    expect(tampered).not.toBe(src); // the anchor still exists; a rename must not silently no-op
    expect(declaredScanRoots(tampered)).toContain("scripts/lib");
    expect(declaredScanRoots(tampered).sort()).not.toEqual([...EVAL_SCAN_ROOTS].sort());
  });

  test("FAILS on a tree with no evals/ at all — a guard over zero paths is a green that means nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "evals-guard-empty-"));
    try {
      const r = runCheck(empty);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("silently empty guard");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("PASSES on a clean fixture tree — it is not failing for an unrelated reason", () => {
    const root = fixtureTree("clean.ts", "export const LAYER = 'layer0';\n");
    try {
      expect(runCheck(root).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("eval wiring keeps evals/ off the per-PR path (§3 L1)", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };

  test("`test` is path-scoped to scripts/tests and never reaches into evals/", () => {
    expect(pkg.scripts.test).toBe("bun test scripts/tests");
    expect(pkg.scripts.test).not.toContain("evals");
  });

  test("the eval targets exist and point at evals/onboarding", () => {
    expect(pkg.scripts["eval:onboarding"]).toBe("bun test evals/onboarding");
    expect(pkg.scripts["eval:onboarding:isolated"]).toBe("bun test evals/onboarding/isolated");
    expect(pkg.scripts["eval:onboarding:admission"]).toBe("bun test evals/onboarding/admission");
  });

  test("tsconfig includes evals/**/*.ts — without it the eval is invisible to typecheck", () => {
    const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as { include: string[] };
    expect(tsconfig.include).toContain("evals/**/*.ts");
  });

  test("every layer of §11.3's table has a file, and each is in the right cost directory", () => {
    for (const rel of [
      "evals/onboarding/isolated/layer0-runtime.eval.test.ts",
      "evals/onboarding/isolated/layer1-skill-install.eval.test.ts",
      "evals/onboarding/isolated/layer2-toolchain.eval.test.ts",
      "evals/onboarding/isolated/layer3-keygen-signing.eval.test.ts",
      "evals/onboarding/admission/layer4-admission.eval.test.ts",
    ]) {
      expect(existsSync(join(repoRoot, rel))).toBe(true);
    }
  });

  test("`bun test` over an empty eval selection is RED — 0 tests collected can never be a green", () => {
    const r = Bun.spawnSync(["bun", "test", "evals/onboarding/does-not-exist"], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(r.exitCode).not.toBe(0);
  });
});

// ── the TRIGGER half of "off the per-PR path" ───────────────────────────────
// Everything above reads package.json, tsconfig.json, and the filesystem. None
// of it reads .github/workflows/, so the one edit that actually puts real model
// inference (up to ~181 min of paid tokens) on every PR — a `pull_request:`
// trigger on committee-opencode-nightly.yml, or `bun run eval:onboarding` wired
// into e2e.yml — would land with every guard in this file still green. That is
// defect 6's class exactly: a guard that proves one thing and is assumed to
// prove another. This closes it (§11.3 E1, D22 rule 2).
describe("real-inference evals stay OFF the per-PR trigger", () => {
  const wfDir = join(repoRoot, ".github", "workflows");

  // Matched against PARSED `run` scalars, never raw file text: integration.yml
  // names evals/ in a comment and runs `bash scripts/checks/check-eval-keyless.sh`,
  // and e2e.yml runs scripts/tests/integration/onboarding-eval-infra.test.ts —
  // all three are legitimate per-PR work, and a false RED on any of them is as
  // much an instrument lie as a false green.
  const EVAL_RUN_PATTERNS = [
    // `bun test evals`, `evals/onboarding/...`, `./evals/...` — the directory
    // itself. The `-`/word guards keep it off `evals-guard.test.ts`.
    /(?<![\w-])evals(?![\w-])/,
    // every package.json eval target: eval:onboarding{,:isolated,:admission}.
    /eval:onboarding/,
  ];

  interface WorkflowStep {
    run?: string;
  }
  interface WorkflowJob {
    steps?: WorkflowStep[];
  }
  interface Workflow {
    on?: unknown;
    true?: unknown;
    jobs?: Record<string, WorkflowJob>;
  }

  function triggerNames(wf: Workflow): string[] {
    // YAML 1.1 folds the bare key `on` to boolean true; Bun.YAML keeps it a
    // string. Accept both, so this can never quietly observe zero triggers and
    // wave every workflow through.
    const on = wf.on ?? wf.true;
    if (typeof on === "string") return [on];
    if (Array.isArray(on)) return on.map(String);
    if (on && typeof on === "object") return Object.keys(on as object);
    return [];
  }

  /** The `run:` commands that would execute an eval on a pull_request event. */
  function evalRunsUnderPullRequest(yamlText: string): string[] {
    const wf = Bun.YAML.parse(yamlText) as Workflow;
    if (!triggerNames(wf).includes("pull_request")) return [];
    const offenders: string[] = [];
    for (const job of Object.values(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const run = step.run;
        if (typeof run === "string" && EVAL_RUN_PATTERNS.some((p) => p.test(run))) offenders.push(run.trim());
      }
    }
    return offenders;
  }

  const workflows = readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => [f, readFileSync(join(wfDir, f), "utf8")] as const);

  test("no workflow runs an eval on a pull_request trigger", () => {
    const offenders = workflows.flatMap(([name, text]) => evalRunsUnderPullRequest(text).map((run) => `${name}: ${run}`));
    expect(offenders).toEqual([]);
  });

  test("the scan is not vacuous — workflows exist, and some really are PR-triggered", () => {
    expect(workflows.length).toBeGreaterThan(0);
    const prTriggered = workflows.filter(([, text]) => triggerNames(Bun.YAML.parse(text) as Workflow).includes("pull_request"));
    expect(prTriggered.length).toBeGreaterThan(0);
  });

  // ── negative controls: the assertion above must be able to FAIL ───────────
  test("FIRES when the nightly eval workflow gains a pull_request trigger", () => {
    const nightly = readFileSync(join(wfDir, "committee-opencode-nightly.yml"), "utf8");
    expect(evalRunsUnderPullRequest(nightly)).toEqual([]); // schedule-only today: its eval steps are legitimate
    const withPr = nightly.replace(/^on:\n/m, "on:\n  pull_request: {}\n");
    expect(withPr).not.toBe(nightly);
    expect(evalRunsUnderPullRequest(withPr)).toEqual(["bun run eval:onboarding:isolated", "bun run eval:onboarding:admission"]);
  });

  test("FIRES when an eval target is wired into the per-PR e2e workflow", () => {
    const e2e = readFileSync(join(wfDir, "e2e.yml"), "utf8").replace("bun run scripts/demo.ts", "bun run eval:onboarding");
    expect(evalRunsUnderPullRequest(e2e)).toEqual(["bun run eval:onboarding"]);
  });

  test("FIRES on a bare `bun test evals` path, not just the named package targets", () => {
    const planted = "on:\n  pull_request: {}\njobs:\n  j:\n    steps:\n      - run: bun test evals/onboarding/isolated\n";
    expect(evalRunsUnderPullRequest(planted)).toEqual(["bun test evals/onboarding/isolated"]);
  });

  // ── false-RED controls: it must NOT fire on the legitimate per-PR work ────
  test("does NOT fire on integration.yml — evals/ in a COMMENT and the keyless guard are per-PR work", () => {
    const integration = readFileSync(join(wfDir, "integration.yml"), "utf8");
    // Both traps are really present, so this control cannot go stale unnoticed:
    expect(integration).toContain("evals/"); // ...in a comment — raw-text matching would have cried wolf here
    expect(integration).toContain("bash scripts/checks/check-eval-keyless.sh"); // a `run` that merely names "eval"
    expect(evalRunsUnderPullRequest(integration)).toEqual([]);
  });

  test("does NOT fire on the per-PR eval INFRA test — inference-off rails belong on every PR", () => {
    const planted =
      "on:\n  pull_request: {}\njobs:\n  j:\n    steps:\n      - run: bun test scripts/tests/integration/onboarding-eval-infra.test.ts\n      - run: bun test scripts/tests/unit/evals-guard.test.ts\n";
    expect(evalRunsUnderPullRequest(planted)).toEqual([]);
  });
});
