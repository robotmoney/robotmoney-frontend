// runtime — the isolated onboarding claim that GATES the other three
// (docs/architecture.md §11.3 E3, row 0; docs/decisions.md D22).
//
// Proves: the member-agent image, its mounted `opencode.json`, and the
// registry-selected provider are all alive, by giving the agent a trivial,
// ROBOT-MONEY-FREE task and observing the file it left behind in the stopped
// container.
//
// WHY THIS CLAIM EXISTS AT ALL. On 2026-07-25 a demo run recorded zero
// admissions; the container exited cleanly in 15 seconds with every step
// pending. Nothing in the harness could say whether the runtime was dead or
// the model had REFUSED. `runtime` is that instrument: it contains no mention
// of Robot Money, so if it passes, the runtime is fine and any refusal in the
// other three claims is a refusal of OUR prompt — and if `runtime` itself is
// classified `refused`, the failure names that explicitly rather than looking
// like a dead container.
//
// Real inference, always (§11.3 E2): no test double, no seam, no skip. A
// missing Docker daemon or missing egress throws out of the bring-up below.
// `writeRuntimeOutcome` is the runtime-gates-the-run handoff
// (evals/onboarding/support/gating.ts): skill-install, toolchain, and
// keygen-signing each read it in their own `beforeAll` and report
// `not-measured` — never `failed` — whenever this claim is not `admitted`.
//
// COST: ~2-5 minutes, one trivial model call. This is the only eval file cheap
// enough to run by hand as a smoke check of the probe machinery:
//   bun run eval:onboarding:isolated -- --test-name-pattern runtime
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stack } from "../../../scripts/stack/index.ts";
import { evalSuiteRunId } from "../../support/artifacts.ts";
import { buildMemberAgentImage, evalProject, imageOnlyStack, repoRoot, tearDown } from "../support/eval-stack.ts";
import { writeRuntimeOutcome } from "../support/gating.ts";
import { tryCopyOut } from "../support/probe.ts";
import { explainClaimFailure, resolveIsolatedEvalModelConfig, runIsolatedClaim, type IsolatedClaimResult } from "../support/run.ts";
import { RUNTIME_RUN_TIMEOUT_MS, RUNTIME_SETUP_TIMEOUT_MS } from "../support/budget.ts";
import { EVAL_PROBE_CONTENT, EVAL_PROBE_PATH, RUNTIME_TASK } from "../support/tasks.ts";

const CLAIM = "runtime";
const suiteRunId = evalSuiteRunId();

let stack: Stack | null = null;
let hostDir = "";
let result: IsolatedClaimResult<string | null>;

describe("onboarding eval — runtime", () => {
  beforeAll(async () => {
    // Run identity, printed BEFORE anything that can throw, so a bring-up
    // failure or a timeout still leaves the reader something to correlate the
    // log with. This claim is deliberately Robot-Money-free and therefore
    // generates NO onboarding identity — the equivalent context here is what
    // the probe asks for.
    console.log(`[${CLAIM}] probe ${EVAL_PROBE_PATH} — expected contents ${JSON.stringify(EVAL_PROBE_CONTENT)} (no onboarding identity at this claim)`);
    // Every other claim POLLS for this claim's outcome (evals/onboarding/support/
    // gating.ts) rather than assuming a Bun cross-file execution order, so this
    // handoff must be written even when the run throws unexpectedly — otherwise
    // the other three would burn their whole wait budget on a claim that failed
    // fast. `harness-error` is the one outcome that always means "measured
    // nothing", so an unclassified exception here is reported as exactly that
    // before the error is rethrown for THIS file's own test to fail on.
    let modelConfig;
    try {
      modelConfig = resolveIsolatedEvalModelConfig(process.env);
      hostDir = mkdtempSync(join(tmpdir(), "rmeval-runtime-"));
      stack = imageOnlyStack(evalProject(CLAIM));
      await buildMemberAgentImage(stack);

      result = await runIsolatedClaim<string | null>({
        claim: CLAIM,
        repoRoot,
        composeProject: stack.config.project,
        prompt: RUNTIME_TASK,
        modelConfig,
        timeoutMs: RUNTIME_RUN_TIMEOUT_MS,
        // Observation, never instruction (§11.3 E3): the task said to create
        // the file; it never said anything about how the harness would look at
        // it.
        observe: (containerName) => {
          const copied = tryCopyOut(containerName, EVAL_PROBE_PATH, hostDir);
          return copied === null ? null : readFileSync(copied, "utf8");
        },
        ok: (contents) => contents !== null && contents.trim() === EVAL_PROBE_CONTENT,
      });

      writeRuntimeOutcome(repoRoot, suiteRunId, result.outcome);
    } catch (e) {
      writeRuntimeOutcome(repoRoot, suiteRunId, "harness-error");
      throw e;
    }
  }, RUNTIME_SETUP_TIMEOUT_MS);

  afterAll(() => {
    tearDown(stack, CLAIM);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, RUNTIME_SETUP_TIMEOUT_MS);

  test("the vanilla runtime did not REFUSE a Robot-Money-free trivial task", () => {
    if (result.outcome === "refused") {
      throw new Error(
        "REFUSAL AT runtime: the registry-selected model declined a task that mentions nothing about Robot Money.\n" +
          "That is a runtime/provider-level refusal, NOT a signal about our onboarding instructions — treat every " +
          "other claim as not-measured until this is green.\n\n" +
          explainClaimFailure(result, `a file at ${EVAL_PROBE_PATH} containing ${EVAL_PROBE_CONTENT}`),
      );
    }
    expect(result.outcome).not.toBe("refused");
  });

  test("the agent is alive: the probe file exists in the stopped container with the exact contents asked for", () => {
    if (result.outcome !== "admitted") {
      throw new Error(explainClaimFailure(result, `a file at ${EVAL_PROBE_PATH} containing ${EVAL_PROBE_CONTENT}`));
    }
    expect(result.observation?.trim()).toBe(EVAL_PROBE_CONTENT);
  });
});
