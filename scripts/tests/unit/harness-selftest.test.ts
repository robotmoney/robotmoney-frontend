// Harness self-tests (issue #276): proves the runners themselves fail when
// they should. A green CI signal means "nobody objected," not "the code ran" —
// nothing before this suite proved that an empty test selection, a
// passWithNoTests-style false green, or a mis-piped exit code in a workflow
// step would actually turn CI red. This is the per-PR battery that closes
// that gap for every runner selector that exists at land time: the `bun test`
// mechanism behind test:unit and test:integration, and the Playwright
// collection/exit-code contract (no browser required — see the "Playwright
// collection contract" section below).
//
// Every fixture this file spawns lives under
// scripts/tests/fixtures/harness/. The `bun test` fixtures are named
// `*.fixture.ts` — NOT `*.test.ts`/`*.spec.ts` — specifically so bun's own
// default test-file discovery never auto-collects them into the real per-PR
// `bun test scripts/tests` run; they are only ever executed by an EXPLICIT
// `bun test ./path/to/file.fixture.ts` invocation below (Bun.spawnSync), which
// bypasses the naming-convention filter (verified empirically: bun still
// requires an explicit "./"-prefixed path for a non-conventionally-named file
// to be treated as a test target rather than silently ignored).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const FIXTURES = join(repoRoot, "scripts", "tests", "fixtures", "harness");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };

function decode(buf: Uint8Array | undefined): string {
  return buf ? new TextDecoder().decode(buf) : "";
}

function spawn(argv: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(argv, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: decode(r.stdout) + decode(r.stderr) };
}

// ── the `bun test` runner mechanism behind test:unit and test:integration ───
//
// test:unit and test:integration are both LITERALLY `bun test <cost-class
// dir>` (package.json: "bun test scripts/tests/unit" /
// "bun test scripts/tests/integration") — the same runner mechanism, applied
// to a different directory argument. Rather than assume that and duplicate a
// fixture tree per selector, this derives each selector's own `bun test`
// argv directly from package.json and re-points it at the shared fixture
// trees below — a genuine per-selector proof, not an assumed one.
describe("bun test runner mechanism (test:unit and test:integration)", () => {
  const SELECTORS = ["test:unit", "test:integration"] as const;

  function runnerArgv(npmScript: (typeof SELECTORS)[number]): string[] {
    const parts = pkg.scripts[npmScript]!.trim().split(/\s+/);
    if (parts[0] !== "bun" || parts[1] !== "test") {
      throw new Error(`package.json's "${npmScript}" is no longer "bun test <dir>" (got "${pkg.scripts[npmScript]}") — update this suite's runner-mechanism assumption`);
    }
    return parts.slice(0, 2);
  }

  for (const selector of SELECTORS) {
    describe(selector, () => {
      test(`${selector}'s own selector string is exactly "bun test scripts/tests/${selector === "test:unit" ? "unit" : "integration"}"`, () => {
        expect(pkg.scripts[selector]).toBe(`bun test scripts/tests/${selector === "test:unit" ? "unit" : "integration"}`);
      });

      test("an empty selection exits nonzero — 0 tests collected can never be green", () => {
        const r = spawn([...runnerArgv(selector), join(FIXTURES, "bun-runner", "empty-selection")]);
        expect(r.code).not.toBe(0);
      });

      test("a planted failing fixture exits nonzero", () => {
        const r = spawn([...runnerArgv(selector), "./" + join("scripts/tests/fixtures/harness/bun-runner", "planted-fail.fixture.ts")]);
        expect(r.code).not.toBe(0);
        expect(r.out).toContain("1 fail");
      });

      test("a planted passing fixture exits 0 — the control", () => {
        const r = spawn([...runnerArgv(selector), "./" + join("scripts/tests/fixtures/harness/bun-runner", "planted-pass.fixture.ts")]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("1 pass");
      });
    });
  }
});

// ── Playwright collection/exit-code contract — no browser required ─────────
//
// Scoped deliberately to COLLECTION (`--list`), which never launches a
// browser: a load-time failure in a spec (a throw at module scope, a bad
// import) surfaces during collection, before Playwright ever reaches for a
// browser binary. This suite running to completion inside the browserless
// unit job (unit.yml has no Chromium/browser-install step; see the
// "no service containers or browser install" test in the workflow-wiring
// section below) IS the no-browser proof — nothing here launches `page`.
describe("Playwright collection contract (no browser launch)", () => {
  const PW = join(repoRoot, "node_modules", ".bin", "playwright");

  function list(fixtureDir: string): { code: number; out: string } {
    return spawn([PW, "test", "--list", "--config", join(FIXTURES, fixtureDir, "playwright.config.ts")]);
  }

  test("an empty project (zero spec files) exits nonzero", () => {
    const r = list("playwright-empty");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no tests found/i);
  });

  test("a planted spec that throws at module load time exits nonzero — caught during collection, before any browser launch", () => {
    const r = list("playwright-load-fail");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("planted load-time failure");
  });

  test("a normal passing spec's collection exits 0 — the control", () => {
    const r = list("playwright-pass");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 test in 1 file/);
  });
});

// ── workflow-wiring assertions ───────────────────────────────────────────────
//
// A runner that fails correctly is worthless if a workflow step swallows its
// exit code. This asserts every TEST-EXECUTING step (a `run:` invoking
// `bun test`, `bun run test*`, or `playwright test`) in every workflow is free
// of `|| true`, a leading `!` negation (the "invert then ignore" pattern), and
// `continue-on-error: true` — the three shapes that turn a real failure into a
// reported success.
describe("workflow wiring: test-executing steps propagate their exit code", () => {
  const wfDir = join(repoRoot, ".github", "workflows");
  const workflowFiles = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  interface Step {
    name?: string;
    run?: string;
    "continue-on-error"?: boolean;
  }
  interface Job {
    steps?: Step[];
  }
  interface Workflow {
    jobs?: Record<string, Job>;
  }

  const TEST_RUN_MARKERS = [/\bbun\s+run\s+test\b/, /\bbun\s+test\b/, /\bplaywright\s+test\b/, /\bbunx\s+playwright\s+test\b/];

  function isTestExecutingRun(run: string): boolean {
    return TEST_RUN_MARKERS.some((p) => p.test(run));
  }

  interface Offender {
    file: string;
    step: string;
    reason: string;
  }

  function findOffenders(text: string, file: string): Offender[] {
    const wf = Bun.YAML.parse(text) as Workflow;
    const offenders: Offender[] = [];
    for (const job of Object.values(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const run = step.run;
        if (typeof run !== "string" || !isTestExecutingRun(run)) continue;
        const label = step.name ?? run.split("\n")[0];
        if (/\|\|\s*true\b/.test(run)) offenders.push({ file, step: label!, reason: "|| true" });
        if (/(^|\n)\s*!\s*(bun|bunx|playwright)/.test(run)) offenders.push({ file, step: label!, reason: "leading ! negation" });
        if (step["continue-on-error"] === true) offenders.push({ file, step: label!, reason: "continue-on-error: true" });
      }
    }
    return offenders;
  }

  test("no test-executing step anywhere carries || true, a leading ! negation, or continue-on-error: true", () => {
    const offenders = workflowFiles.flatMap((f) => findOffenders(readFileSync(join(wfDir, f), "utf8"), f));
    expect(offenders).toEqual([]);
  });

  test("the scan is not vacuous — at least one real test-executing step is found across the workflows", () => {
    let found = 0;
    for (const f of workflowFiles) {
      const wf = Bun.YAML.parse(readFileSync(join(wfDir, f), "utf8")) as Workflow;
      for (const job of Object.values(wf.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (typeof step.run === "string" && isTestExecutingRun(step.run)) found++;
        }
      }
    }
    expect(found).toBeGreaterThan(5);
  });

  // ── negative control: the detector must be able to FIRE ───────────────────
  test("FIRES on a planted || true, leading !, and continue-on-error: true — each independently", () => {
    const orTrue = "on: push\njobs:\n  j:\n    steps:\n      - name: t\n        run: bun test scripts/tests/unit || true\n";
    expect(findOffenders(orTrue, "planted.yml").map((o) => o.reason)).toEqual(["|| true"]);

    const bang = "on: push\njobs:\n  j:\n    steps:\n      - name: t\n        run: |\n          ! bun test scripts/tests/unit\n";
    expect(findOffenders(bang, "planted.yml").map((o) => o.reason)).toEqual(["leading ! negation"]);

    const coe = "on: push\njobs:\n  j:\n    steps:\n      - name: t\n        run: bun test scripts/tests/unit\n        continue-on-error: true\n";
    expect(findOffenders(coe, "planted.yml").map((o) => o.reason)).toEqual(["continue-on-error: true"]);
  });

  test("does NOT fire on a non-test step's || true (e.g. teardown/cleanup) — the detector does not cry wolf", () => {
    const teardown = "on: push\njobs:\n  j:\n    steps:\n      - name: teardown\n        run: docker compose down || true\n";
    expect(findOffenders(teardown, "planted.yml")).toEqual([]);
  });

  // ── issue #276 AC: the unit job carries no service containers / browser install ──
  // The full battery must pass with network disabled and no docker daemon —
  // pinned here so a future edit that adds a `services:` block or a
  // `playwright install` step to unit.yml is caught, not silently absorbed.
  test("unit.yml (the required per-PR unit job) defines no service containers and no browser-binary install step", () => {
    const unitYml = readFileSync(join(wfDir, "unit.yml"), "utf8");
    const wf = Bun.YAML.parse(unitYml) as { jobs?: Record<string, { services?: unknown; steps?: Step[] }> };
    for (const job of Object.values(wf.jobs ?? {})) {
      expect(job.services).toBeUndefined();
      for (const step of job.steps ?? []) {
        if (typeof step.run === "string") expect(step.run).not.toMatch(/playwright install/);
      }
    }
  });

  // ── issue #276 AC: harness-selftest.test.ts is reachable from the required unit selector ──
  // Runs `bun test scripts/tests/unit` — the EXACT command test:unit resolves
  // to — filtered by --test-name-pattern to this one canary test, so only ONE
  // test body executes (this canary, in a DIFFERENT process) while bun still
  // has to discover every file under scripts/tests/unit to know it doesn't
  // match anything else. This bounds the spawn to depth 1 (the canary itself
  // spawns nothing) and keeps the assertion cheap, while still proving —
  // against the runner's own REAL reported output, not a static path check —
  // that this very file is inside the directory test:unit selects.
  const REACHABILITY_CANARY_NAME = "harness selftest reachability canary — do not rename without updating the reachability test above";
  const REACHABILITY_MARKER = "HARNESS_SELFTEST_REACHABILITY_MARKER";

  test(REACHABILITY_CANARY_NAME, () => {
    console.log(REACHABILITY_MARKER);
  });

  test("the harness-selftest suite is reachable from the required unit selector (bun test scripts/tests/unit collects it)", () => {
    const r = spawn(["bun", "test", "scripts/tests/unit", "--test-name-pattern", REACHABILITY_CANARY_NAME]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(REACHABILITY_MARKER);
    expect(r.out).toMatch(/Ran 1 test across \d+ files/);
  });
});
