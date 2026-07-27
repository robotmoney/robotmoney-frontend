// LAYER 1 — skill install (docs/architecture.md §11.3 E3, row 1).
//
// Proves: given only the canonical prompt's framing and its "install the
// committee-onboarding skill" sentence — no URL recipe, no install path — the
// agent finds the skill and installs it into its own harness.
//
// No server: layers 0-3 need none. Real inference, always (§11.3 E2).
//
// ── Why the assertion is deliberately LOOSE ─────────────────────────────────
// It asserts a `SKILL.md` exists ANYWHERE in the stopped container's filesystem
// and that its CONTENT carries the committee-onboarding markers — not that it
// sits at a particular path. opencode's on-disk skill directory is not a
// published, stable contract; pinning it would turn an upstream layout change
// into what looks like a product regression, which is the most expensive kind
// of false red. The known cost of the looseness, stated so nobody "tightens"
// it by accident: an agent that DOWNLOADS the skill without installing it would
// pass layer 1 and fail layer 4. Layers localise, they do not prove.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stack } from "../../../scripts/stack/index.ts";
import { buildMemberAgentImage, evalProject, imageOnlyStack, repoRoot, tearDown } from "../support/eval-stack.ts";
import { explainLayerFailure, ISOLATED_LAYER_TIMEOUT_MS, runIsolatedLayer, type IsolatedLayerResult } from "../support/layer-run.ts";
import { ISOLATED_SETUP_TIMEOUT_MS as SETUP_TIMEOUT_MS } from "../support/budget.ts";
import { buildLayer1Task } from "../support/layer-tasks.ts";
import { generateIdentity } from "../../../scripts/lib/onboarding-eval.ts";
import { findByName, listContainerFiles, toContainerPath, tryCopyOut } from "../support/probe.ts";

const LAYER = "layer1";

// The content markers that make a SKILL.md THE committee-onboarding skill
// rather than some other skill the agent happened to have.
const SKILL_MARKERS = [/committee-onboarding/i, /rmpc/i];

interface SkillObservation {
  skillPaths: string[];
  matchingPath: string | null;
}

let stack: Stack | null = null;
let hostDir = "";
let result: IsolatedLayerResult<SkillObservation>;

describe("onboarding eval — layer 1: skill install", () => {
  beforeAll(async () => {
    // Printed BEFORE anything that can throw (bring-up, the run itself, an
    // assertion), so a red run's generated identity is always recoverable from
    // the log — including when the failure produces no observation at all.
    // Never a private key: name, contact and run id only.
    const identity = generateIdentity();
    console.log(`[${LAYER}] run ${identity.runId} — ${identity.name} <${identity.contact}>`);

    hostDir = mkdtempSync(join(tmpdir(), "rmeval-layer1-"));
    stack = await imageOnlyStack(evalProject(LAYER));
    await buildMemberAgentImage(stack);

    result = await runIsolatedLayer<SkillObservation>({
      layer: LAYER,
      repoRoot,
      composeProject: stack.config.project,
      prompt: buildLayer1Task(identity),
      timeoutMs: ISOLATED_LAYER_TIMEOUT_MS,
      observe: (containerName) => {
        const listing = listContainerFiles(containerName);
        const skillPaths = findByName(containerName, "SKILL.md", listing);
        let matchingPath: string | null = null;
        for (const p of skillPaths) {
          const copied = tryCopyOut(containerName, toContainerPath(p), join(hostDir, encodeURIComponent(p)));
          if (copied === null) continue;
          const text = readFileSync(copied, "utf8");
          if (SKILL_MARKERS.every((re) => re.test(text))) {
            matchingPath = p;
            break;
          }
        }
        return { skillPaths, matchingPath };
      },
      ok: (obs) => obs.matchingPath !== null,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    tearDown(stack, LAYER);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  test("the agent installed a skill at all (some SKILL.md exists in the stopped container)", () => {
    if (result.outcome !== "admitted" && (result.observation?.skillPaths.length ?? 0) === 0) {
      throw new Error(
        explainLayerFailure(result, "at least one SKILL.md anywhere in the container filesystem") +
          "\nNo SKILL.md at all: the agent never installed a skill — this is a discovery failure (R5), not a content mismatch.",
      );
    }
    expect(result.observation?.skillPaths.length ?? 0).toBeGreaterThan(0);
  });

  test("the installed skill IS committee-onboarding (its content names the skill and rmpc)", () => {
    if (result.outcome !== "admitted") {
      throw new Error(
        explainLayerFailure(result, "a SKILL.md whose content matches the committee-onboarding markers") +
          `\nSKILL.md paths found: ${JSON.stringify(result.observation?.skillPaths ?? [])}`,
      );
    }
    expect(result.observation?.matchingPath).not.toBeNull();
  });
});
