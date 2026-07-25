// One way to run an ISOLATED layer (0-3) — docs/architecture.md §11.3 E2/E3/E5.
//
// Every isolated layer is the same shape: launch ONE vanilla member-agent
// container on the shared primitive, let the agent work, then observe the
// STOPPED container's filesystem before the primitive removes it. The
// container-phase observation runs inside `runMemberAgent`'s `inspect` bracket,
// which is the only window in which the container exists AND is stopped.
//
// TWO PHASES, because the two evidence sources become available at different
// times: the stopped container's FILESYSTEM can only be read inside `inspect`,
// while the drained TRANSCRIPT only exists once the run has returned (the
// primitive awaits its pipe drains after removing the container). `observe`
// captures the first; the optional `derive` combines it with the second.
//
// NOT AN INJECTION SEAM (§11.3 E2). Both hooks read a run that already
// happened; neither can supply, fake, or short-circuit one. There is no
// parameter through which a caller could skip the model call, and no path here
// that returns success without a container having really run.
//
// Retry policy, deliberately narrower than the demo's: ONLY `rate-limited` is
// retried, and at most once. A 429 never let the agent reason, so it measured
// nothing. A REFUSAL, by contrast, is the diagnostic an isolated layer exists
// to produce — retrying it here would erase the very signal that made D22
// necessary.
import { classifyOutcome, shouldRetry, type OnboardingOutcome } from "../../../scripts/agent/classify-outcome.ts";
import { runMemberAgent, type MemberAgentResult } from "../../../scripts/agent/member-agent.ts";
import { finalAssistantText } from "../../../scripts/agent/transcript.ts";
import { DEFAULT_COMPOSE_FILES } from "../../../scripts/stack/config.ts";

export const MAX_ATTEMPTS = 2;
export const RATE_LIMIT_BACKOFF_MS = 45_000;
// Layers 1-3 ask for real work — installing a skill, fetching a release for the
// container's own architecture, generating a key and signing. The keyless tier
// is slow; the required per-PR gate already budgets 20 minutes for the full
// sequence, so 25 gives a single step honest room without being unbounded.
export const ISOLATED_LAYER_TIMEOUT_MS = 25 * 60_000;

export interface IsolatedLayerOptions<C, O = C> {
  layer: string;
  repoRoot: string;
  composeProject: string;
  composeFiles?: string[];
  prompt: string;
  timeoutMs?: number;
  // CONTAINER PHASE — reads the STOPPED container. Throwing is fine and is
  // reported as an observation failure; it never becomes a skip.
  observe: (containerName: string) => C | Promise<C>;
  // POST-RUN PHASE — combines the captured filesystem evidence with the drained
  // transcript. Called even when `observe` threw (`captured === null`), because
  // the transcript alone can still carry the evidence.
  derive?: (captured: C | null, run: MemberAgentResult) => O | Promise<O>;
  // Did the layer's observation show what the layer claims to prove?
  ok: (observation: O) => boolean;
}

export interface IsolatedLayerResult<O> {
  layer: string;
  outcome: OnboardingOutcome;
  observation: O | null;
  observationError: string | null;
  run: MemberAgentResult;
  finalMessage: string;
  attempts: number;
}

export async function runIsolatedLayer<C, O = C>(opts: IsolatedLayerOptions<C, O>): Promise<IsolatedLayerResult<O>> {
  const timeoutMs = opts.timeoutMs ?? ISOLATED_LAYER_TIMEOUT_MS;
  let last: IsolatedLayerResult<O> | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const runId = `${opts.layer}-a${attempt}-${crypto.randomUUID().slice(0, 6)}`;
    let captured: C | null = null;
    let observationError: string | null = null;

    const run = await runMemberAgent({
      repoRoot: opts.repoRoot,
      composeProject: opts.composeProject,
      composeFiles: opts.composeFiles ?? DEFAULT_COMPOSE_FILES,
      prompt: opts.prompt,
      runId,
      title: `onboarding-eval-${opts.layer}-${runId}`,
      timeoutMs,
      keepUntilInspected: true,
      onEvent: (msg) => console.log(`[${opts.layer}] ${msg}`),
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

    // The layer's own definition of success is what `admitted` means here, so
    // the SHARED classifier can tell a dead run, a 429, a timeout and a refusal
    // apart for an isolated layer exactly as it does for layer 4 (§11.3 E5).
    const outcome = classifyOutcome({
      admitted: observation !== null && opts.ok(observation),
      timedOut: run.timedOut,
      memberId: null,
      containerExitCode: run.exitCode,
      transcript: run.transcript,
    });

    last = {
      layer: opts.layer,
      outcome,
      observation,
      observationError,
      run,
      finalMessage: finalAssistantText(run.transcript),
      attempts: attempt,
    };
    console.log(
      `[${opts.layer}] attempt ${attempt}/${MAX_ATTEMPTS}: ${outcome} ` +
        `(exit ${run.exitCode}, ${(run.durationMs / 60_000).toFixed(1)} min)` +
        `${observationError ? ` — observation error: ${observationError}` : ""}`,
    );

    // shouldRetry() is the shared predicate; an isolated layer takes only its
    // `rate-limited` case (see the header).
    const retryable = outcome === "rate-limited" && shouldRetry(outcome);
    if (!retryable || attempt === MAX_ATTEMPTS) return last;
    console.log(`[${opts.layer}] rate-limited — retrying once in ${RATE_LIMIT_BACKOFF_MS}ms`);
    await Bun.sleep(RATE_LIMIT_BACKOFF_MS);
  }
  return last!;
}

// The failure message an isolated layer prints. Names the outcome FIRST — a
// `refused` and a `navigation-failure` are different products of the same red,
// and layer 0 exists precisely so nobody has to guess which one they are
// looking at.
export function explainLayerFailure<O>(r: IsolatedLayerResult<O>, whatWasExpected: string): string {
  return [
    `layer ${r.layer} did not pass: classified ${r.outcome} after ${r.attempts} attempt(s).`,
    `expected: ${whatWasExpected}`,
    r.observationError ? `harness observation error: ${r.observationError}` : `observation: ${JSON.stringify(r.observation)}`,
    `container exit ${r.run.exitCode}, timedOut=${r.run.timedOut}, ${(r.run.durationMs / 60_000).toFixed(1)} min`,
    `agent's final message: ${JSON.stringify(r.finalMessage.slice(0, 600))}`,
  ].join("\n");
}
