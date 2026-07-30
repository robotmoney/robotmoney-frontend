// skill-install (docs/architecture.md §11.3 E3, row 1).
//
// Proves: given only the canonical prompt's framing, its two bounds, and its
// "install the committee-onboarding skill" ask — no URL recipe beyond the
// skill URL the canonical prompt itself names, no install path — the agent
// finds the skill and installs it into its own harness.
//
// No server: the isolated claims need none. Real inference, always (§11.3 E2).
// RUNTIME GATES THE RUN (evals/onboarding/support/gating.ts): if `runtime` did
// not admit, this claim's report is `not-measured`, never `failed` — it never
// even had a fair runtime to run against.
//
// ── Why the assertion is deliberately LOOSE ─────────────────────────────────
// It asserts a `SKILL.md` exists ANYWHERE in the stopped container's
// filesystem and that its CONTENT carries the committee-onboarding markers —
// not that it sits at a particular path. opencode's on-disk skill directory is
// not a published, stable contract; pinning it would turn an upstream layout
// change into what looks like a product regression, which is the most
// expensive kind of false red. The known cost of the looseness, stated so
// nobody "tightens" it by accident: an agent that DOWNLOADS the skill without
// installing it would pass this claim and fail the integrated admission eval.
// Claims localise, they do not prove.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stack } from "../../../scripts/stack/index.ts";
import { evalSuiteRunId } from "../../support/artifacts.ts";
import { buildMemberAgentImage, evalProject, imageOnlyStack, repoRoot, tearDown } from "../support/eval-stack.ts";
import { readRuntimeOutcome } from "../support/gating.ts";
import { findByName, listContainerFiles, toContainerPath, tryCopyOut } from "../support/probe.ts";
import { explainClaimFailure, ISOLATED_LAYER_TIMEOUT_MS, resolveIsolatedEvalModelConfig, runIsolatedClaim, type IsolatedClaimResult } from "../support/run.ts";
import { ISOLATED_SETUP_TIMEOUT_MS as SETUP_TIMEOUT_MS } from "../support/budget.ts";
import { buildSkillInstallTask } from "../support/tasks.ts";

const CLAIM = "skill-install";
const suiteRunId = evalSuiteRunId();

// The content markers that make a SKILL.md THE committee-onboarding skill
// rather than some other skill the agent happened to have.
const SKILL_MARKERS = [/committee-onboarding/i, /rmpc/i];

interface SkillObservation {
  skillPaths: string[];
  matchingPath: string | null;
}

let stack: Stack | null = null;
let hostDir = "";
let runtimeOutcome: string | null = null;
let result: IsolatedClaimResult<SkillObservation> | null = null;

describe("onboarding eval — skill-install", () => {
  beforeAll(async () => {
    runtimeOutcome = readRuntimeOutcome(repoRoot, suiteRunId);
    if (runtimeOutcome !== "admitted") return; // gated — see gating.ts and the tests below

    const modelConfig = resolveIsolatedEvalModelConfig(process.env);
    hostDir = mkdtempSync(join(tmpdir(), "rmeval-skill-install-"));
    stack = imageOnlyStack(evalProject(CLAIM));
    await buildMemberAgentImage(stack);

    result = await runIsolatedClaim<SkillObservation>({
      claim: CLAIM,
      repoRoot,
      composeProject: stack.config.project,
      prompt: buildSkillInstallTask(),
      modelConfig,
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
    tearDown(stack, CLAIM);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  test("not-measured, never failed, when runtime did not admit", () => {
    if (runtimeOutcome === "admitted") return;
    expect(result).toBeNull();
  });

  test("the agent installed a skill at all (some SKILL.md exists in the stopped container)", () => {
    if (runtimeOutcome !== "admitted") return; // gated
    if (result!.outcome !== "admitted" && (result!.observation?.skillPaths.length ?? 0) === 0) {
      throw new Error(
        explainClaimFailure(result!, "at least one SKILL.md anywhere in the container filesystem") +
          "\nNo SKILL.md at all: the agent never installed a skill — this is a discovery failure (R5), not a content mismatch.",
      );
    }
    expect(result!.observation?.skillPaths.length ?? 0).toBeGreaterThan(0);
  });

  test("the installed skill IS committee-onboarding (its content names the skill and rmpc)", () => {
    if (runtimeOutcome !== "admitted") return; // gated
    if (result!.outcome !== "admitted") {
      throw new Error(
        explainClaimFailure(result!, "a SKILL.md whose content matches the committee-onboarding markers") +
          `\nSKILL.md paths found: ${JSON.stringify(result!.observation?.skillPaths ?? [])}`,
      );
    }
    expect(result!.observation?.matchingPath).not.toBeNull();
  });
});
