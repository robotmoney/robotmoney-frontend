// LAYER 4 — sampled admission (docs/architecture.md §11.3 E3 row 4 + E4,
// docs/decisions.md D22 rule 4).
//
// Proves: a vanilla, keyless agent can sequence the WHOLE R4→R8 onboarding
// itself — install the skill, install rmpc, generate a key, sign the canonical
// application, submit it over REST, wait for approval, claim — and reach the
// active roster. The canonical `ONBOARDING_PROMPT` is used VERBATIM (identity
// placeholders filled, plus the existing clearly-delimited local-network note),
// and observation is SERVER-SIDE ONLY, preserving the black-box property where
// it matters most.
//
// ── Sampled, because the thing under test is stochastic (E4) ────────────────
// One sample is a coin flip reported as a verdict. K samples with a fresh
// identity and a fresh container each are classified into
// admitted/refused/rate-limited/timed-out/navigation-failure, and the ADMISSION
// RATE is the metric. A refusal is data, not flake: on 2026-07-25 the identical
// prompt was refused in roughly 1 sample in 5, a demo admitted zero members
// because of it, and no instrument in this repo could see it.
//
// The sampler calls the BARE `runOnboardingEval`, never the retry wrapper
// (§11.3 E5): retrying refusals would erase the refusal rate, which is the
// number this file exists to produce.
//
// ── Stack ───────────────────────────────────────────────────────────────────
// `core` only — postgres + api. Apply/approve/claim is Postgres CRUD plus
// signature verification and never touches the job queue, so no worker lanes,
// no EDGAR seed, no frontend checks, no session drivers.
//
// ── E1/E2 ───────────────────────────────────────────────────────────────────
// No key, no paid model, no env read, no test double, no injection seam, no
// skip. A missing Docker daemon or missing egress throws out of the bring-up.
//
// COST: SAMPLE_COUNT sequential samples at up to 20 minutes each. Nightly only
// (committee-opencode-nightly.yml, CI_CLASS: heavy — no `pull_request` trigger).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyOutcome } from "../../../scripts/agent/classify-outcome.ts";
import {
  DEFAULT_TIMEOUT_MS,
  generateIdentity,
  runOnboardingEval,
} from "../../../scripts/lib/onboarding-eval.ts";
import type { Stack } from "../../../scripts/stack/index.ts";
import { evalProject, repoRoot, startCoreStack, tearDown } from "../support/eval-stack.ts";
import {
  assertScorecard,
  formatScorecard,
  MIN_ADMISSION_RATE,
  MIN_SCORED_SAMPLES,
  SAMPLE_COUNT,
  SCORECARD_RELATIVE_PATH,
  scoreSamples,
  writeScorecard,
  type Sample,
  type Scorecard,
} from "../support/scorecard.ts";

const LAYER = "layer4";
// SAMPLE_COUNT × the per-sample budget, plus stack bring-up and image build.
const SWEEP_TIMEOUT_MS = 150 * 60_000;
const TRANSCRIPT_DIR = ".agents/onboarding-eval-transcripts";

let stack: Stack | null = null;
let scorecard: Scorecard = scoreSamples([]);

// A failed sample's transcript is the only artifact that explains WHY, so it is
// kept next to the scorecard the nightly uploads. An admitted sample carries no
// transcript by design (runOnboardingEval only returns one when it did not
// admit).
function saveTranscript(runId: string, transcript: string | undefined): string | null {
  if (!transcript) return null;
  const dir = join(repoRoot, TRANSCRIPT_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.txt`);
  writeFileSync(path, transcript);
  return path;
}

describe("onboarding eval — layer 4: sampled admission (core stack)", () => {
  beforeAll(async () => {
    stack = await startCoreStack(evalProject(LAYER));

    const samples: Sample[] = [];
    // SEQUENTIAL on purpose: concurrent containers on one runner distort both
    // the provider's rate limiting and the per-sample wall clock, and the
    // observation is per-identity anyway.
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const identity = generateIdentity(`l4-${i}-${crypto.randomUUID().slice(0, 6)}`);
      const startedAt = Date.now();
      console.log(`[${LAYER}] sample ${i}/${SAMPLE_COUNT} — ${identity.contact}`);
      const result = await runOnboardingEval({
        repoRoot,
        composeProject: stack.config.project,
        backendUrl: stack.backendUrl,
        adminToken: stack.config.credentials.adminToken,
        identity,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        onEvent: (msg) => console.log(`[${LAYER}][${i}/${SAMPLE_COUNT}] ${msg}`),
      });
      const outcome = classifyOutcome(result);
      samples.push({
        runId: identity.runId,
        outcome,
        memberId: result.memberId,
        steps: result.steps.filter((s) => s.status === "done").length,
        durationMs: Date.now() - startedAt,
        transcriptPath: saveTranscript(identity.runId, result.transcript),
      });
      console.log(`[${LAYER}] sample ${i}/${SAMPLE_COUNT} → ${outcome}`);
      scorecard = scoreSamples(samples);
    }
  }, SWEEP_TIMEOUT_MS);

  afterAll(() => {
    // UNCONDITIONAL, including after a failed sweep: the per-outcome counts are
    // the only thing that distinguishes a product regression from a provider
    // outage, so they must always be printed and always be written.
    console.log(`\n${formatScorecard(scorecard)}\n`);
    console.log(`[${LAYER}] scorecard written to ${writeScorecard(scorecard, repoRoot)} (${SCORECARD_RELATIVE_PATH})`);
    tearDown(stack, LAYER);
  }, SWEEP_TIMEOUT_MS);

  test(`all ${SAMPLE_COUNT} samples actually ran (a zero-sample sweep is red, never a vacuous green)`, () => {
    expect(scorecard.samples.length).toBe(SAMPLE_COUNT);
  });

  test(`at least ${MIN_SCORED_SAMPLES} samples were scorable (rate-limited samples measured nothing)`, () => {
    expect(scorecard.scored).toBeGreaterThanOrEqual(MIN_SCORED_SAMPLES);
  });

  test(`the admission rate meets the floor of ${MIN_ADMISSION_RATE}`, () => {
    // assertScorecard throws with the FULL formatted report — counts included —
    // so a red here is diagnosable from the failure message alone.
    assertScorecard(scorecard);
    expect(scorecard.admissionRate).toBeGreaterThanOrEqual(MIN_ADMISSION_RATE);
  });
});
