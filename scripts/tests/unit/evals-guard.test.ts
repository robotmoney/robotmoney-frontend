// The WIRING that keeps the eval tree off the per-PR path (docs/decisions.md
// D22 rule 2, docs/architecture.md §11.3 E2, D23's cost classes).
//
// WHAT THIS FILE IS NOT ANY MORE. It used to also execute
// the withdrawn `check-eval-keyless.sh` — issue #278's proposed guard that
// evals/ and scripts/agent/ hold no provider key and read no environment.
// #292 amended D22 rule 1: the eval now runs a FUNDED, registry-selected model,
// `main` ships `scripts/checks/check-model-selection.sh` instead, and that
// keyless guard was withdrawn rather than deferred. Everything in this file
// that asserted keylessness went with it. Everything below is orthogonal to
// which model an eval runs and survives the amendment unchanged:
//
//   * `bun run test` is path-scoped to scripts/tests and never reaches evals/;
//   * the evals/ scaffold exists and tsconfig can see it (without which the
//     suite #279 populates is invisible to `bun run typecheck`);
//   * an empty test selection is RED (0 collected can never be a green); and
//   * NO workflow runs an eval on a `pull_request` trigger — the one edit that
//     would put hours of real model inference on every PR.
//
// The successor to the withdrawn keyless properties lives in
// scripts/tests/unit/model-selection-guard.test.ts (which executes the shell
// guard) and scripts/tests/unit/model-selection-single-signal.test.ts (which
// proves resolveAgentModel is the only selection path).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("eval wiring keeps evals/ off the per-PR path", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };

  test("`test` is path-scoped to scripts/tests and never reaches into evals/", () => {
    expect(pkg.scripts.test).toBe("bun test scripts/tests");
    expect(pkg.scripts.test).not.toContain("evals");
  });

  test("the evals/ scaffold exists — the tree #279 and #280 populate", () => {
    expect(existsSync(join(repoRoot, "evals"))).toBe(true);
    expect(existsSync(join(repoRoot, "evals", "README.md"))).toBe(true);
  });

  test("tsconfig includes evals/**/*.ts — without it the eval is invisible to typecheck", () => {
    const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as { include: string[] };
    expect(tsconfig.include).toContain("evals/**/*.ts");
  });

  test("`bun test` over an empty eval selection is RED — 0 tests collected can never be a green", () => {
    const r = Bun.spawnSync(["bun", "test", "evals/does-not-exist"], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(r.exitCode).not.toBe(0);
  });

  test("the model-selection guard — not a keyless one — is what runs per PR now", () => {
    // The rescope in one assertion: the withdrawn guard is absent, its
    // successor is present and wired.
    expect(existsSync(join(repoRoot, "scripts", "checks", "check-eval-keyless.sh"))).toBe(false);
    const integration = readFileSync(join(repoRoot, ".github", "workflows", "integration.yml"), "utf8");
    expect(integration).toContain("bash scripts/checks/check-model-selection.sh");
    expect(integration).not.toContain("check-eval-keyless.sh");
  });
});

// ── the TRIGGER half of "off the per-PR path" ───────────────────────────────
// Everything above reads package.json, tsconfig.json, and the filesystem. None
// of it reads a workflow's TRIGGERS, so the one edit that actually puts real
// model inference (hours of wall clock, and now real spend) on every PR — a
// `pull_request:` trigger on committee-opencode-nightly.yml, or `bun test
// evals/...` wired into e2e.yml — would land with every guard above still
// green. That is the "a guard that proves one thing and is assumed to prove
// another" class exactly. This closes it (D22 rule 2 / §11.3 E2).
describe("real-inference evals stay OFF the per-PR trigger", () => {
  const wfDir = join(repoRoot, ".github", "workflows");

  // Matched against PARSED `run` scalars, never raw file text — and against a
  // COMMAND SHAPE, never the bare word. Three things in this repo legitimately
  // say "eval" inside a per-PR `run:` and must not go red:
  //   * e2e.yml's job-summary step, whose prose explains where the eval DOES
  //     run and mentions "per-PR evals" in so many words;
  //   * e2e.yml's inference-off rails step, which executes
  //     scripts/tests/integration/onboarding-eval-infra.test.ts; and
  //   * this very suite, scripts/tests/unit/evals-guard.test.ts.
  // A false RED on any of them is as much an instrument lie as a false green,
  // so the patterns require something that would actually EXECUTE the eval
  // tree: a path under `evals/`, or the `eval:onboarding` package target.
  const EVAL_RUN_PATTERNS = [
    // A path INTO the eval tree, in command position: `bun test evals/…`,
    // `node ./evals/…`, `evals/x.ts` at the start of a command. The trailing
    // slash is what separates it from prose about "evals" and from the
    // `evals-guard.test.ts` filename.
    /(?:^|[\n;&|]\s*|\b(?:bun|bunx|node|npx|test|run)\s+)\.?\/?evals\//,
    // the eval package targets this directory will carry: eval:onboarding{,:*}.
    /\beval:onboarding/,
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
  test("FIRES when an eval target is wired into the per-PR e2e workflow", () => {
    const e2e = readFileSync(join(wfDir, "e2e.yml"), "utf8").replace("bun run scripts/demo.ts", "bun run eval:onboarding");
    expect(evalRunsUnderPullRequest(e2e)).toEqual(["bun run eval:onboarding"]);
  });

  test("FIRES on a bare `bun test evals` path, not just the named package targets", () => {
    const planted = "on:\n  pull_request: {}\njobs:\n  j:\n    steps:\n      - run: bun test evals/onboarding/isolated\n";
    expect(evalRunsUnderPullRequest(planted)).toEqual(["bun test evals/onboarding/isolated"]);
  });

  test("FIRES when a schedule-only eval workflow gains a pull_request trigger", () => {
    const scheduled = "on:\n  schedule:\n    - cron: '0 4 * * *'\njobs:\n  j:\n    steps:\n      - run: bun run eval:onboarding:isolated\n";
    expect(evalRunsUnderPullRequest(scheduled)).toEqual([]); // schedule-only: its eval step is legitimate
    const withPr = scheduled.replace(/^on:\n/m, "on:\n  pull_request: {}\n");
    expect(withPr).not.toBe(scheduled);
    expect(evalRunsUnderPullRequest(withPr)).toEqual(["bun run eval:onboarding:isolated"]);
  });

  // ── false-RED controls: it must NOT fire on the legitimate per-PR work ────
  test("does NOT fire on e2e.yml's job-summary step, whose PROSE says the word", () => {
    const e2e = readFileSync(join(wfDir, "e2e.yml"), "utf8");
    // The trap is really present, so this control cannot go stale unnoticed:
    // a `run:` scalar on a pull_request-triggered workflow containing the bare
    // word — a word-boundary matcher would have cried wolf here.
    expect(e2e).toMatch(/run:[\s\S]{0,4000}?per-PR evals/);
    expect(evalRunsUnderPullRequest(e2e)).toEqual([]);
  });

  test("does NOT fire on integration.yml either", () => {
    expect(evalRunsUnderPullRequest(readFileSync(join(wfDir, "integration.yml"), "utf8"))).toEqual([]);
  });

  test("does NOT fire on the per-PR eval INFRA test — inference-off rails belong on every PR", () => {
    const planted =
      "on:\n  pull_request: {}\njobs:\n  j:\n    steps:\n      - run: bun test scripts/tests/integration/onboarding-eval-infra.test.ts\n      - run: bun test scripts/tests/unit/evals-guard.test.ts\n";
    expect(evalRunsUnderPullRequest(planted)).toEqual([]);
  });
});
