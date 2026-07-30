// One way to run an ISOLATED onboarding claim (runtime, skill-install,
// toolchain, keygen-signing) — docs/architecture.md §11.3 E2/E3/E5.
//
// Every isolated claim is the same shape: launch ONE vanilla member-agent
// container on the shared primitive, let the agent work, then observe the
// STOPPED container's filesystem before the primitive removes it. The
// container-phase observation runs inside `runMemberAgent`'s `inspect`
// bracket, which is the only window in which the container exists AND is
// stopped.
//
// TWO PHASES, because the two evidence sources become available at different
// times: the stopped container's FILESYSTEM can only be read inside `inspect`,
// while the drained TRANSCRIPT only exists once the run has returned (the
// primitive awaits its pipe drains after removing the container). `observe`
// captures the first; the optional `derive` combines it with the second.
//
// NOT AN INJECTION SEAM (§11.3 E2). Both hooks read a run that already
// happened; neither can supply, fake, or short-circuit one. There is no
// parameter through which a caller could skip the model call, and no path
// here that returns success without a container having really run.
//
// MODEL RESOLUTION (D22 rule 1 as amended 2026-07-28). Every claim runs a
// funded, registry-selected model exactly the way the admission eval does —
// resolved ONCE by the caller (resolveIsolatedEvalModelConfig, below) and
// threaded through to `runMemberAgent`, never re-derived per claim.
//
// Retry policy, deliberately narrower than the demo's: ONLY `rate-limited` is
// retried, and at most once. A 429 never let the agent reason, so it measured
// nothing. A REFUSAL, by contrast, is the diagnostic an isolated claim exists
// to produce — retrying it here would erase the very signal that made D22
// necessary.
import {
  explainOutcome,
  formatOutcomeEvidence,
  shouldRetry,
  type HarnessFault,
  type OnboardingOutcome,
  type OutcomeBranch,
  type TranscriptLiveness,
} from "../../../scripts/agent/classify-outcome.ts";
import { runMemberAgent, type MemberAgentModel, type MemberAgentResult } from "../../../scripts/agent/member-agent.ts";
import { finalAssistantText } from "../../../scripts/agent/transcript.ts";
import { DEFAULT_COMPOSE_FILES } from "../../../scripts/stack/config.ts";
import { isKeylessModel, resolveAgentModel } from "../../../scripts/lib/model-registry.ts";
import { ZEN_KEY_ENV, zenApiKey } from "../../../scripts/lib/opencode-key.ts";

export const MAX_ATTEMPTS = 2;
export const RATE_LIMIT_BACKOFF_MS = 45_000;
// The non-runtime claims ask for real work — installing a skill, fetching a
// release for the container's own architecture, generating a key and signing.
export const ISOLATED_LAYER_TIMEOUT_MS = 25 * 60_000;

/**
 * Real-inference claims never probe or silently substitute a no-credential
 * model (D22 rule 1 as amended, §11.3 E1: "every layer runs a vanilla OpenCode
 * install ... billed to the environment's own OPENCODE_API_KEY"). Identical
 * requirement to the admission eval's resolveAdmissionEvalModelConfig; kept as
 * its own function here (rather than imported across the eval/scripts
 * boundary) because scripts/onboarding-eval-local.ts is the admission-eval
 * entrypoint and this suite must not depend on it.
 */
export function resolveIsolatedEvalModelConfig(env: Record<string, string | undefined>): MemberAgentModel {
  const model = resolveAgentModel(env);
  if (isKeylessModel(model)) {
    throw new Error(
      "Real-inference evals require OPENCODE_API_KEY and a funded AGENT_MODEL selection; no-credential models are not an eval fallback.",
    );
  }
  const apiKey = zenApiKey(env);
  if (!apiKey) {
    throw new Error(
      "Real-inference evals require OPENCODE_API_KEY before Docker; configure the keyed eval environment. No free-model probe or fallback will be attempted.",
    );
  }
  return { model, apiKeyEnv: ZEN_KEY_ENV, apiKey };
}

export interface IsolatedClaimOptions<C, O = C> {
  claim: string;
  repoRoot: string;
  composeProject: string;
  composeFiles?: string[];
  prompt: string;
  modelConfig: MemberAgentModel;
  timeoutMs?: number;
  // CONTAINER PHASE — reads the STOPPED container. Throwing is fine and is
  // reported as an observation failure; it never becomes a skip.
  observe: (containerName: string) => C | Promise<C>;
  // POST-RUN PHASE — combines the captured filesystem evidence with the
  // drained transcript. Called even when `observe` threw (`captured ===
  // null`), because the transcript alone can still carry the evidence.
  derive?: (captured: C | null, run: MemberAgentResult) => O | Promise<O>;
  // Did the claim's observation show what the claim asserts?
  ok: (observation: O) => boolean;
}

export interface IsolatedClaimResult<O> {
  claim: string;
  outcome: OnboardingOutcome;
  // WHICH rung of the classifier's ladder produced `outcome`, and the cheap
  // agent-liveness counts around it.
  branch: OutcomeBranch;
  reason: string;
  liveness: TranscriptLiveness;
  // Non-null when the HARNESS stopped this run. Reported ahead of everything
  // else, because none of the other fields mean anything about the product
  // when it is set.
  harnessFault: HarnessFault | null;
  observation: O | null;
  observationError: string | null;
  run: MemberAgentResult;
  finalMessage: string;
  attempts: number;
}

export async function runIsolatedClaim<C, O = C>(opts: IsolatedClaimOptions<C, O>): Promise<IsolatedClaimResult<O>> {
  const timeoutMs = opts.timeoutMs ?? ISOLATED_LAYER_TIMEOUT_MS;
  let last: IsolatedClaimResult<O> | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const runId = `${opts.claim}-a${attempt}-${crypto.randomUUID().slice(0, 6)}`;
    let captured: C | null = null;
    let observationError: string | null = null;

    const run = await runMemberAgent({
      repoRoot: opts.repoRoot,
      composeProject: opts.composeProject,
      composeFiles: opts.composeFiles ?? DEFAULT_COMPOSE_FILES,
      prompt: opts.prompt,
      runId,
      modelConfig: opts.modelConfig,
      title: `onboarding-eval-${opts.claim}-${runId}`,
      timeoutMs,
      keepUntilInspected: true,
      onEvent: (msg) => console.log(`[${opts.claim}] ${msg}`),
      inspect: async ({ containerName }) => {
        try {
          captured = await opts.observe(containerName);
        } catch (e) {
          observationError = e instanceof Error ? e.message : String(e);
        }
      },
    });

    let observation: O | null = null;
    if (opts.derive) {
      try {
        observation = await opts.derive(captured, run);
      } catch (e) {
        observationError = [observationError, e instanceof Error ? e.message : String(e)].filter(Boolean).join("; ");
      }
    } else {
      observation = captured as unknown as O | null;
    }

    // The claim's own definition of success is what `admitted` means here, so
    // the SHARED classifier can tell a dead run, a 429, a timeout and a
    // refusal apart for an isolated claim exactly as it does for the
    // integrated admission run (§11.3 E5).
    const explained = explainOutcome({
      admitted: observation !== null && opts.ok(observation),
      timedOut: run.timedOut,
      memberId: null,
      containerExitCode: run.exitCode,
      transcript: run.transcript,
      containerLaunched: run.containerLaunched,
    });
    const outcome = explained.outcome;

    last = {
      claim: opts.claim,
      outcome,
      branch: explained.branch,
      reason: explained.reason,
      liveness: explained.liveness,
      harnessFault: explained.harnessFault,
      observation,
      observationError,
      run,
      finalMessage: finalAssistantText(run.transcript),
      attempts: attempt,
    };
    console.log(
      `[${opts.claim}] attempt ${attempt}/${MAX_ATTEMPTS}: ${outcome} ` +
        `(exit ${run.exitCode}, timedOut=${run.timedOut}, ${(run.durationMs / 60_000).toFixed(1)} min) — ` +
        formatOutcomeEvidence(explained) +
        `${observationError ? ` — observation error: ${observationError}` : ""}`,
    );

    // shouldRetry() is the shared predicate; an isolated claim takes only its
    // `rate-limited` case (see the header).
    const retryable = outcome === "rate-limited" && shouldRetry(outcome);
    if (!retryable || attempt === MAX_ATTEMPTS) return last;
    console.log(`[${opts.claim}] rate-limited (${explained.branch}) — retrying once in ${RATE_LIMIT_BACKOFF_MS}ms`);
    await Bun.sleep(RATE_LIMIT_BACKOFF_MS);
  }
  return last!;
}

// The failure message an isolated claim prints. Names the outcome FIRST — a
// `refused` and a `navigation-failure` are different products of the same red.
export function explainClaimFailure<O>(r: IsolatedClaimResult<O>, whatWasExpected: string): string {
  return [
    `claim ${r.claim} did not pass: classified ${r.outcome} after ${r.attempts} attempt(s).`,
    ...(r.harnessFault
      ? [
          `HARNESS FAULT [${r.harnessFault.kind}]: ${r.harnessFault.detail}. ` +
            `This claim measured NOTHING about the product — fix the harness before reading anything else below.`,
        ]
      : []),
    `deciding branch: ${r.branch} — ${r.reason}`,
    `agent liveness: ${r.liveness.eventLines} agent event line(s), ${r.liveness.textParts} text part(s), ` +
      `${r.liveness.toolEvents} tool event(s), ` +
      `final text ${r.liveness.finalTextEmpty ? "EMPTY" : `${r.liveness.finalTextChars} chars`}, ` +
      `transcript ${r.liveness.transcriptChars} chars`,
    `expected: ${whatWasExpected}`,
    r.observationError ? `harness observation error: ${r.observationError}` : `observation: ${JSON.stringify(r.observation)}`,
    `container exit ${r.run.exitCode}, launched=${r.run.containerLaunched === null ? "unknown" : r.run.containerLaunched}, ` +
      `timedOut=${r.run.timedOut}, ${(r.run.durationMs / 60_000).toFixed(1)} min`,
    `agent's final message: ${JSON.stringify(r.finalMessage.slice(0, 600))}`,
  ].join("\n");
}
