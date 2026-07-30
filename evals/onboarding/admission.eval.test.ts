// ADMISSION EVAL — sampled onboarding sweep (docs/architecture.md §11.3 E3
// row 4 + E4, docs/decisions.md D22 rule 4). Extracted, by path, from the R&D
// branch fix/269-eval-instrument-defects-classifier-harvest-budget's
// integrated-admission sweep test (issue #280) and renamed throughout to
// claim/behaviour vocabulary, matching the rename #279 already applied to the
// isolated claims — no old numbered-layer identifier survives anywhere in
// this file or in `support/scorecard.ts` (pinned by
// scripts/tests/unit/admission-eval-nightly-workflow.test.ts).
//
// Proves: a vanilla, keyless-capable agent can sequence the WHOLE R4→R8
// onboarding itself — install the skill, install rmpc, generate a key, sign
// the canonical application, submit it over REST, wait for approval, claim —
// and reach the active roster. The canonical `ONBOARDING_PROMPT` is used
// VERBATIM (identity placeholders filled, plus the existing clearly-delimited
// local-network note), and observation is SERVER-SIDE ONLY, preserving the
// black-box property where it matters most.
//
// ── Sampled, because the thing under test is stochastic (E4) ────────────────
// One sample is a coin flip reported as a verdict. K samples with a fresh
// identity and a fresh container each are classified into
// admitted/refused/rate-limited/timed-out/navigation-failure/harness-error,
// and the ADMISSION RATE is the metric. A refusal is data, not flake: on
// 2026-07-25 the identical prompt was refused in roughly 1 sample in 5, a demo
// admitted zero members because of it, and no instrument in this repo could
// see it.
//
// The sampler calls the BARE `runOnboardingEval`, never the retry wrapper
// (§11.3 E5): retrying refusals would erase the refusal rate, which is the
// number this file exists to produce.
//
// ── Stack ───────────────────────────────────────────────────────────────────
// `core` only — postgres + api. Apply/approve/claim is Postgres CRUD plus
// signature verification and never touches the job queue, so no worker lanes,
// no EDGAR seed, no frontend checks, no session drivers. Brought up ONCE for
// the whole sweep, reusing the shared `scripts/stack` module directly — the
// same primitives `scripts/onboarding-eval-local.ts` uses for the local
// single-admission case — rather than extending
// `evals/onboarding/support/eval-stack.ts`, which is trimmed to the
// image-only bring-up the four ISOLATED claims need (they boot no server at
// all). A `core` stack bring-up belongs to the integrated admission eval
// alone.
//
// ── E1/E2 ───────────────────────────────────────────────────────────────────
// No key, no paid model, no env read beyond model/credential resolution, no
// test double, no injection seam, no skip. A missing Docker daemon or missing
// egress throws out of the bring-up.
//
// COST: SAMPLE_COUNT sequential samples at up to DEFAULT_TIMEOUT_MS each.
// Nightly only (admission-eval-nightly.yml, CI_CLASS: heavy — no
// `pull_request` trigger).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { explainOutcome, formatOutcomeEvidence } from "../../scripts/agent/classify-outcome.ts";
import { DEFAULT_COMPOSE_FILES, DEFAULT_TIMEOUT_MS, generateIdentity, runOnboardingEval } from "../../scripts/lib/onboarding-eval.ts";
import {
  createStack,
  DEFAULT_STACK_DATABASE,
  dockerClientHostEnv,
  generateStackCredentials,
  resolveStackEnvironment,
  stackProjectName,
  type Stack,
} from "../../scripts/stack/index.ts";
import { SWEEP_TIMEOUT_MS } from "./support/budget.ts";
import {
  assertScorecard,
  formatRunLog,
  formatScorecard,
  MIN_ADMISSION_RATE,
  MIN_SCORED_SAMPLES,
  RUN_LOG_RELATIVE_DIR,
  SAMPLE_COUNT,
  SCORECARD_RELATIVE_PATH,
  scoreSamples,
  writeScorecard,
  type Sample,
  type Scorecard,
} from "./support/scorecard.ts";

const CLAIM = "admission";
const repoRoot = join(import.meta.dir, "..", "..");

// A CORE (postgres + api) bring-up for the sweep, using the shared
// scripts/stack module directly — the "eval" role, the same one
// scripts/onboarding-eval-local.ts's single-admission case occupies, kept
// distinct from the isolated claims' own "rmeval_<claim>_<random>" family so
// the two can never collide inside the same job.
async function startAdmissionCoreStack(): Promise<Stack> {
  const environment = resolveStackEnvironment(process.env);
  const project = stackProjectName("eval", environment);
  const stack = createStack(
    {
      repoRoot,
      project,
      profile: "core",
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials: generateStackCredentials(),
      environment,
    },
    { hostEnv: dockerClientHostEnv(), io: { stdout: "pipe", stderr: "pipe" } },
  );
  stack.assertDockerAvailable();
  await stack.up();
  await stack.waitForHttp(`${stack.backendUrl}/health`, 60_000);
  return stack;
}

function tearDown(stack: Stack | null): void {
  if (!stack) return;
  const r = stack.down({ removeVolumes: true, removeOrphans: true });
  if (r.exitCode !== 0) {
    console.error(`[${CLAIM}] teardown for project ${stack.config.project} failed (exit ${r.exitCode}): ${r.stderr}`);
  }
}

let stack: Stack | null = null;
let scorecard: Scorecard = scoreSamples([]);

// EVERY sample's run log is kept next to the scorecard the nightly uploads —
// admitted ones included. Keeping only the failures made a sweep's own healthy
// run unavailable as a reference exactly when four broken ones needed
// comparing against it.
//
// The file is NOT a bare transcript and does not pretend to be: formatRunLog
// stamps it with what the bytes actually are (one compose process's stdout +
// stderr, with the agent's NDJSON inside the stdout half) and with the counts
// that say whether the agent produced anything at all.
function saveRunLog(sample: Sample, body: string | undefined): string | null {
  if (body === undefined) return null;
  const dir = join(repoRoot, RUN_LOG_RELATIVE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sample.runId}.log`);
  writeFileSync(path, formatRunLog(sample, body));
  return path;
}

describe("onboarding eval — admission (sampled, core stack)", () => {
  beforeAll(async () => {
    stack = await startAdmissionCoreStack();

    const samples: Sample[] = [];
    // SEQUENTIAL on purpose: concurrent containers on one runner distort both
    // the provider's rate limiting and the per-sample wall clock, and the
    // observation is per-identity anyway.
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const identity = generateIdentity(`admission-${i}-${crypto.randomUUID().slice(0, 6)}`);
      const startedAt = Date.now();
      console.log(`[${CLAIM}] sample ${i}/${SAMPLE_COUNT} — ${identity.contact}`);
      const result = await runOnboardingEval({
        repoRoot,
        composeProject: stack.config.project,
        composeFiles: DEFAULT_COMPOSE_FILES,
        backendUrl: stack.backendUrl,
        adminToken: stack.config.credentials.adminToken,
        composeSpawnEnv: stack.spawnEnv,
        identity,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        onEvent: (msg) => console.log(`[${CLAIM}][${i}/${SAMPLE_COUNT}] ${msg}`),
      });
      const explained = explainOutcome(result);
      const sample: Sample = {
        runId: identity.runId,
        outcome: explained.outcome,
        memberId: result.memberId,
        steps: result.steps.filter((s) => s.status === "done").length,
        durationMs: Date.now() - startedAt,
        runLogPath: null,
        branch: explained.branch,
        eventLines: explained.liveness.eventLines,
        textParts: explained.liveness.textParts,
        toolEvents: explained.liveness.toolEvents,
        containerExitCode: result.containerExitCode,
        containerLaunched: result.containerLaunched,
        // ONLY when the fault actually decided the outcome. explainOutcome
        // computes harnessFaultOf() unconditionally, so an ADMITTED run whose
        // transcript merely quotes a trigger string carries a non-null fault —
        // and the gate below would then fail a perfect 5/5 sweep. That is a
        // false red, which is as much an instrument lie as a false green.
        // It is also the invariant Sample declares: non-null exactly when the
        // outcome is harness-error. A run that reached the roster DESPITE a
        // fault is still a real admission.
        harnessFault: explained.outcome === "harness-error" ? explained.harnessFault : null,
      };
      sample.runLogPath = saveRunLog(sample, result.transcript);
      samples.push(sample);
      console.log(
        `[${CLAIM}] sample ${i}/${SAMPLE_COUNT} → ${explained.outcome} — ${formatOutcomeEvidence(explained)}`,
      );
      scorecard = scoreSamples(samples);
    }
  }, SWEEP_TIMEOUT_MS);

  afterAll(() => {
    // UNCONDITIONAL, including after a failed sweep: the per-outcome counts are
    // the only thing that distinguishes a product regression from a provider
    // outage, so they must always be printed and always be written.
    console.log(`\n${formatScorecard(scorecard)}\n`);
    console.log(`[${CLAIM}] scorecard written to ${writeScorecard(scorecard, repoRoot)} (${SCORECARD_RELATIVE_PATH})`);
    tearDown(stack);
  }, SWEEP_TIMEOUT_MS);

  test(`all ${SAMPLE_COUNT} samples actually ran (a zero-sample sweep is red, never a vacuous green)`, () => {
    expect(scorecard.samples.length).toBe(SAMPLE_COUNT);
  });

  // FIRST among the assertions on purpose. When the harness broke, every other
  // number below is about the harness rather than the product, and reading them
  // as a product result is precisely how a stale container configuration once
  // reported a spurious admission rate.
  test("no sample failed inside the HARNESS (our breakage is never a product outcome)", () => {
    // Keyed on OUTCOME, the same quantity assertScorecard uses. Keying on
    // harnessFault !== null instead let the two gates disagree about the same
    // scorecard.
    const broken = scorecard.samples.filter((s) => s.outcome === "harness-error");
    if (broken.length > 0) {
      throw new Error(
        `${broken.length} of ${scorecard.samples.length} samples were stopped by the HARNESS, not by the product. ` +
          `Their outcome is 'harness-error': they are excluded from the admission-rate denominator (they measured ` +
          `nothing) AND they fail this sweep, so nothing is hidden by that exclusion.\n` +
          broken.map((s) => `  - ${s.runId} [${s.harnessFault?.kind}]: ${s.harnessFault?.detail}`).join("\n") +
          `\n\n${formatScorecard(scorecard)}`,
      );
    }
    expect(scorecard.counts["harness-error"]).toBe(0);
  });

  test(`at least ${MIN_SCORED_SAMPLES} samples were scorable (rate-limited and harness-broken samples measured nothing)`, () => {
    expect(scorecard.scored).toBeGreaterThanOrEqual(MIN_SCORED_SAMPLES);
  });

  test(`the admission rate meets the floor of ${MIN_ADMISSION_RATE}`, () => {
    // assertScorecard throws with the FULL formatted report — counts included —
    // so a red here is diagnosable from the failure message alone.
    assertScorecard(scorecard);
    expect(scorecard.admissionRate).toBeGreaterThanOrEqual(MIN_ADMISSION_RATE);
  });
});
