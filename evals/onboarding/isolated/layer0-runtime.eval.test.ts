// LAYER 0 — runtime (docs/architecture.md §11.3 E3, row 0).
//
// Proves: the member-agent image, its mounted `opencode.json`, and the keyless
// provider are all alive, by giving the agent a trivial, ROBOT-MONEY-FREE task
// and observing the file it left behind in the stopped container.
//
// WHY THIS LAYER EXISTS AT ALL. On 2026-07-25 a demo run recorded zero
// admissions; the container exited cleanly in 15 seconds with every step
// pending. Nothing in the harness could say whether the runtime was dead or the
// model had REFUSED. Layer 0 is that instrument: it contains no mention of
// Robot Money, so if it passes, the runtime is fine and any refusal in layers
// 1-4 is a refusal of OUR prompt — and if layer 0 itself is classified
// `refused`, the failure names that explicitly rather than looking like a dead
// container.
//
// Real inference, always (§11.3 E2): no test double, no seam, no skip. A missing
// Docker daemon or missing egress throws out of the bring-up below.
//
// COST: ~2-5 minutes, one trivial model call. This is the only eval file cheap
// enough to run by hand as a smoke check of the probe machinery before the
// expensive layers are trusted:
//   bun run eval:onboarding:isolated -- layer0
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stack } from "../../../scripts/stack/index.ts";
import { buildMemberAgentImage, evalProject, imageOnlyStack, repoRoot, tearDown } from "../support/eval-stack.ts";
import { explainLayerFailure, runIsolatedLayer, type IsolatedLayerResult } from "../support/layer-run.ts";
import { LAYER0_RUN_TIMEOUT_MS as RUN_TIMEOUT_MS, LAYER0_SETUP_TIMEOUT_MS as SETUP_TIMEOUT_MS } from "../support/budget.ts";
import { EVAL_PROBE_CONTENT, EVAL_PROBE_PATH, LAYER0_TASK } from "../support/layer-tasks.ts";
import { tryCopyOut } from "../support/probe.ts";

const LAYER = "layer0";

let stack: Stack | null = null;
let hostDir = "";
let result: IsolatedLayerResult<string | null>;

describe("onboarding eval — layer 0: runtime", () => {
  beforeAll(async () => {
    // Run identity, printed BEFORE anything that can throw, so a bring-up
    // failure or a timeout still leaves the reader something to correlate the
    // log with. This layer is deliberately Robot-Money-free and therefore
    // generates NO onboarding identity — the equivalent context here is what
    // the probe asks for.
    console.log(`[${LAYER}] probe ${EVAL_PROBE_PATH} — expected contents ${JSON.stringify(EVAL_PROBE_CONTENT)} (no onboarding identity at this layer)`);
    hostDir = mkdtempSync(join(tmpdir(), "rmeval-layer0-"));
    stack = await imageOnlyStack(evalProject(LAYER));
    await buildMemberAgentImage(stack);

    result = await runIsolatedLayer<string | null>({
      layer: LAYER,
      repoRoot,
      composeProject: stack.config.project,
      prompt: LAYER0_TASK,
      timeoutMs: RUN_TIMEOUT_MS,
      // Observation, never instruction (§11.3 E3): the task said to create the
      // file; it never said anything about how the harness would look at it.
      observe: (containerName) => {
        const copied = tryCopyOut(containerName, EVAL_PROBE_PATH, hostDir);
        return copied === null ? null : readFileSync(copied, "utf8");
      },
      ok: (contents) => contents !== null && contents.trim() === EVAL_PROBE_CONTENT,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    tearDown(stack, LAYER);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  test("the vanilla runtime did not REFUSE a Robot-Money-free trivial task", () => {
    if (result.outcome === "refused") {
      throw new Error(
        "REFUSAL AT LAYER 0: the vanilla keyless model declined a task that mentions nothing about Robot Money.\n" +
          "That is a runtime/provider-level refusal, NOT a signal about our onboarding instructions — treat every " +
          "layer above as uninterpretable until this is green.\n\n" +
          explainLayerFailure(result, `a file at ${EVAL_PROBE_PATH} containing ${EVAL_PROBE_CONTENT}`),
      );
    }
    expect(result.outcome).not.toBe("refused");
  });

  test("the agent is alive: the probe file exists in the stopped container with the exact contents asked for", () => {
    if (result.outcome !== "admitted") {
      throw new Error(explainLayerFailure(result, `a file at ${EVAL_PROBE_PATH} containing ${EVAL_PROBE_CONTENT}`));
    }
    expect(result.observation?.trim()).toBe(EVAL_PROBE_CONTENT);
  });
});
