// PURE, per-PR pinning of the eval suite's COST MODEL against the workflow that
// has to honour it (evals/onboarding/support/budget.ts vs
// .github/workflows/committee-opencode-nightly.yml).
//
// Cost class `unit` (docs/architecture.md §3 L1, docs/decisions.md D23): reads
// two files and does arithmetic. No Docker, no network, no inference.
//
// WHY THIS GATE EXISTS
// committee-opencode-nightly.yml has never completed a run, so nothing has ever
// observed its budget being wrong — and it was wrong in both jobs at once:
//
//   - the isolated job allowed its layers up to 160 minutes of in-test timeout
//     while killing the CI step at 80;
//   - the sweep's in-test timeout and its step `timeout-minutes` were both
//     exactly 150, so they raced.
//
// Either way the runner SIGKILLs the step, and a SIGKILL destroys precisely what
// the nightly is for: the `timed-out` classification, explainLayerFailure()'s
// output, and the scorecard that `afterAll` writes for the `if: always()` upload
// to collect. A truncated nightly cannot even report that it was rate-limited.
//
// The invariant, asserted per job:
//
//     in-test timeout  <  step timeout-minutes  <  job timeout-minutes
//
// Importing budget.ts is safe and deliberate: it is a SUPPORT module with no
// `describe`/`test` registrations, so pulling it in cannot schedule a real eval.
// The layer files themselves are never imported here for exactly that reason —
// they are asserted as TEXT instead.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMISSION_JOB_BUDGET,
  ADMISSION_JOB_WORST_CASE_MS,
  IMAGE_BUILD_BUDGET_MS,
  ISOLATED_JOB_BUDGET,
  ISOLATED_JOB_WORST_CASE_MS,
  ISOLATED_SETUP_TIMEOUT_MS,
  LAYER0_SETUP_TIMEOUT_MS,
  layerWorstCaseMs,
  SWEEP_TIMEOUT_MS,
  toMinutes,
} from "../../../evals/onboarding/support/budget.ts";
import { ISOLATED_LAYER_TIMEOUT_MS, MAX_ATTEMPTS, RATE_LIMIT_BACKOFF_MS } from "../../../evals/onboarding/support/layer-run.ts";
// Pure builders, side-effect free by their own module contract (scripts/stack/
// config.ts:1-20), so importing them cannot start a container. These are the
// ACTUAL argv the eval's image build and teardown run, which is what makes the
// layer-cache assumption below checkable rather than merely asserted in prose.
import { buildArgs, downArgs } from "../../../scripts/stack/config.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const WORKFLOW = join(repoRoot, ".github", "workflows", "committee-opencode-nightly.yml");

interface Step {
  name?: string;
  run?: string;
  "timeout-minutes"?: number;
}
interface Job {
  "timeout-minutes"?: number;
  steps: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as Workflow;

function job(name: string): Job {
  const j = workflow.jobs?.[name];
  if (!j) throw new Error(`job ${name} is missing from committee-opencode-nightly.yml`);
  return j;
}

// The step that actually runs the eval, found by the command it runs — not by
// index, so reordering or inserting steps cannot silently point this at a
// checkout step whose absent timeout would read as 0.
function evalStep(j: Job, runContains: string): Step {
  const s = j.steps.find((st) => st.run?.includes(runContains));
  if (!s) throw new Error(`no step running ${runContains}`);
  return s;
}

describe("the cost model is internally consistent", () => {
  test("a layer's worst case is every attempt at full cap plus the n-1 backoffs", () => {
    expect(layerWorstCaseMs(10 * 60_000)).toBe(MAX_ATTEMPTS * 10 * 60_000 + (MAX_ATTEMPTS - 1) * RATE_LIMIT_BACKOFF_MS);
    // n-1, not n: there is no sleep after the final attempt.
    expect(layerWorstCaseMs(0)).toBe((MAX_ATTEMPTS - 1) * RATE_LIMIT_BACKOFF_MS);
  });

  test("a heavy layer's beforeAll budget can contain a FULL retry cycle", () => {
    // The old literal was 45 min against a 50.75-min retry pair, so bun killed
    // the hook mid-second-attempt and reported a `timed-out` that was really a
    // budget bug. This is the assertion that could not have been green then.
    expect(ISOLATED_SETUP_TIMEOUT_MS).toBeGreaterThan(layerWorstCaseMs(ISOLATED_LAYER_TIMEOUT_MS));
  });

  test("layer 0's budget contains its own (much smaller) retry cycle", () => {
    expect(LAYER0_SETUP_TIMEOUT_MS).toBeGreaterThan(layerWorstCaseMs(5 * 60_000));
    // …and is genuinely cheaper than a heavy layer's, or the split is pointless.
    expect(LAYER0_SETUP_TIMEOUT_MS).toBeLessThan(ISOLATED_SETUP_TIMEOUT_MS);
  });

  test("the isolated job total covers every layer's worst case", () => {
    const layers = layerWorstCaseMs(5 * 60_000) + 3 * layerWorstCaseMs(ISOLATED_LAYER_TIMEOUT_MS);
    expect(ISOLATED_JOB_WORST_CASE_MS).toBeGreaterThan(layers);
  });

  test("the sweep bound covers SAMPLE_COUNT full-length samples plus bring-up", () => {
    expect(ADMISSION_JOB_WORST_CASE_MS).toBe(SWEEP_TIMEOUT_MS);
    expect(SWEEP_TIMEOUT_MS).toBeGreaterThan(5 * 20 * 60_000); // 5 samples × 20 min
  });
});

describe("committee-opencode-nightly.yml honours the cost model", () => {
  const cases = [
    {
      what: "isolated layers 0-3",
      jobName: "onboarding-eval-isolated",
      runContains: "eval:onboarding:isolated",
      budget: ISOLATED_JOB_BUDGET,
      // The largest in-test bound inside this job: any single layer's beforeAll.
      // Deliberately Math.max and NOT the sum — the four caps add to 211 min
      // against a 191-min step. That is not a defect; see "the aggregate fits
      // the step only because builds 2-4 hit the layer cache" below, which is
      // the test that fails if the reasoning ever stops holding.
      inTestMs: Math.max(LAYER0_SETUP_TIMEOUT_MS, ISOLATED_SETUP_TIMEOUT_MS),
    },
    {
      what: "layer 4 admission sweep",
      jobName: "onboarding-real-inference-sweep",
      runContains: "eval:onboarding:admission",
      budget: ADMISSION_JOB_BUDGET,
      inTestMs: SWEEP_TIMEOUT_MS,
    },
  ];

  for (const c of cases) {
    describe(c.what, () => {
      const j = job(c.jobName);
      const step = evalStep(j, c.runContains);

      test("the step and job timeouts are the DERIVED numbers, not hand-picked ones", () => {
        expect(step["timeout-minutes"]).toBe(c.budget.stepTimeoutMinutes);
        expect(j["timeout-minutes"]).toBe(c.budget.jobTimeoutMinutes);
      });

      test("in-test timeout < step timeout — the harness diagnoses, CI only backstops", () => {
        // Strictly less: equality is the sweep's old 150-vs-150 race, where the
        // SIGKILL can land before afterAll finishes writing the scorecard.
        expect(toMinutes(c.inTestMs)).toBeLessThan(step["timeout-minutes"]!);
      });

      test("step timeout < job timeout — the step must be able to fail before the job dies", () => {
        expect(step["timeout-minutes"]!).toBeLessThan(j["timeout-minutes"]!);
      });
    });
  }

  // ── The one assumption the isolated job's budget rests on ─────────────────
  // READ THIS BEFORE "FIXING" THE 211-vs-191 GAP.
  //
  // The four per-layer in-test caps sum to 211 minutes while the step is killed
  // at 191. That looks like an inversion — the exact bug this whole file exists
  // to catch — and it is not one, because the sum double-counts the image build.
  // IMAGE_BUILD_BUDGET_MS is charged to EVERY isolated layer (bun does not
  // guarantee file order, so any layer may be the one that runs first and pays
  // for the cold build) but is really paid ONCE per job: builds 2-4 hit the
  // Docker layer cache.
  //
  // If a future change ever makes builds 2-4 cold — adding `--no-cache`/`--pull`
  // to the build, or pruning images in tearDown — these assertions are where you
  // land. THE CORRECT RESPONSE IS TO RESTORE THE BUILD CACHING, NOT to widen the
  // step to 221. Widening is possible only two ways, and both are worse:
  //   - a >211-min step budget bills 30 min/night of runner time for builds that
  //     never happen; or
  //   - per-layer bounds cut below one full retry cycle (50.75 min), which is
  //     literally the defect this PR fixed — a beforeAll that cannot contain its
  //     own retry, so a doubly-rate-limited layer dies mid-attempt and reports a
  //     `timed-out` that is really a budget bug.
  describe("the aggregate fits the step ONLY because builds 2-4 hit the layer cache", () => {
    const sumOfCaps = LAYER0_SETUP_TIMEOUT_MS + 3 * ISOLATED_SETUP_TIMEOUT_MS;
    const coldBuildsChargedFourTimes = 3 * IMAGE_BUILD_BUDGET_MS;

    test("the sum of the per-layer caps really does exceed the step — the gap is real", () => {
      // Pin the premise, so this group can never go vacuously green by the caps
      // quietly shrinking under the step and making the rest of it moot.
      expect(toMinutes(sumOfCaps)).toBeGreaterThan(ISOLATED_JOB_BUDGET.stepTimeoutMinutes);
    });

    test("and the entire gap is the image build, charged 4× but paid 1×", () => {
      // Equality, not `toBeLessThan`: the difference between the sum of the caps
      // and the job's worst case is EXACTLY three image builds and nothing else.
      // An inequality would tolerate some other unaccounted 30 minutes hiding in
      // the model; this cannot.
      expect(sumOfCaps - coldBuildsChargedFourTimes).toBe(ISOLATED_JOB_WORST_CASE_MS);
      expect(toMinutes(sumOfCaps - coldBuildsChargedFourTimes)).toBeLessThan(
        ISOLATED_JOB_BUDGET.stepTimeoutMinutes,
      );
    });

    test("the build is cache-eligible — no --no-cache and no --pull", () => {
      // buildMemberAgentImage -> stack.build(["member-agent"]) -> buildArgs().
      expect(buildArgs(["member-agent"])).toEqual(["build", "member-agent"]);
      expect(buildArgs(["member-agent"])).not.toContain("--no-cache");
      expect(buildArgs(["member-agent"])).not.toContain("--pull");
    });

    test("teardown removes containers and volumes but never IMAGES", () => {
      // `docker compose down --rmi` (any value) would delete the built image
      // between layers and make every later build cold. tearDown() asks for
      // removeVolumes + removeOrphans only, and downArgs cannot emit --rmi.
      const args = downArgs({ removeVolumes: true, removeOrphans: true });
      expect(args).toEqual(["down", "--volumes", "--remove-orphans"]);
      for (const a of args) expect(a).not.toStartWith("--rmi");
    });

    test("the eval's stack helper adds no image-destroying step of its own", () => {
      // buildArgs/downArgs are what the helper CALLS; this catches a raw
      // `docker` escape hatch added beside them in the eval support module.
      const src = readFileSync(join(repoRoot, "evals/onboarding/support/eval-stack.ts"), "utf8");
      expect(src.length).toBeGreaterThan(500); // not vacuous — the file was really read
      for (const forbidden of ["--no-cache", "--pull", "--rmi", "image prune", "system prune", "docker rmi"]) {
        expect(src).not.toContain(forbidden);
      }
    });
  });

  test("both jobs declare an explicit job-level timeout — an unbounded eval job is a runaway bill", () => {
    for (const name of Object.keys(workflow.jobs)) {
      expect(typeof workflow.jobs[name]!["timeout-minutes"]).toBe("number");
    }
  });

  test("the workflow is the two jobs the cost model describes and no others", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(["onboarding-eval-isolated", "onboarding-real-inference-sweep"]);
  });
});

describe("no layer file re-introduces a hand-written timeout literal", () => {
  const LAYER_FILES = [
    "evals/onboarding/isolated/layer0-runtime.eval.test.ts",
    "evals/onboarding/isolated/layer1-skill-install.eval.test.ts",
    "evals/onboarding/isolated/layer2-toolchain.eval.test.ts",
    "evals/onboarding/isolated/layer3-keygen-signing.eval.test.ts",
    "evals/onboarding/admission/layer4-admission.eval.test.ts",
  ];

  for (const rel of LAYER_FILES) {
    test(`${rel.split("/").pop()} takes its budget from support/budget.ts`, () => {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src).toContain('from "../support/budget.ts"');
      // A literal like `= 45 * 60_000` is exactly the drift this file exists to
      // stop: it puts a number in a layer that the workflow cannot see.
      const literals = src.split("\n").filter((l) => /TIMEOUT_MS\s*=\s*\d+\s*\*\s*60_000/.test(l));
      expect(literals).toEqual([]);
    });
  }

  test("the scan is not vacuous — every layer file was really read", () => {
    for (const rel of LAYER_FILES) expect(readFileSync(join(repoRoot, rel), "utf8").length).toBeGreaterThan(500);
  });
});
