// Per-prospect transcript retention for the standing live smoke (issue #317).
//
// The member-agent runner (scripts/agent/member-agent.ts) already redacts and
// returns a transcript for every prospective swarm-member run, but the
// smoke's onboarding driver (scripts/lib/smoke-main.ts) only ever wrote it to
// the shared smoke log, and only when the prospect FAILED (`if (result.transcript)
// log(...)`, gated behind `!result.admitted`). A successful or still-running
// prospect left no discoverable, tailable record, and the container's own
// filesystem is removed at teardown (`--rm` — scripts/agent/member-agent.ts),
// so `docker logs` cannot recover it after the fact either.
//
// This module does NOT invent a second persistence mechanism. It wires the
// ALREADY-EXISTING, tested eval artifact primitive
// (scripts/lib/onboarding-telemetry.ts's createOnboardingArtifactWriter — the
// same one scripts/onboarding-eval-local.ts and the native eval suite use)
// into the smoke's standing driver, so both converge on ONE artifact
// directory, format, and redaction guarantee:
//
//   .agents/onboarding-evals/<composeProject>/<runId>/
//     manifest.json        — candidate identity, smoke run, model, limits
//     events.ndjson         — the consolidated lifecycle timeline (launch,
//                             container-observed/"ready", every redacted
//                             agent/API/Postgres line, exit, cleanup)
//     agent.stdout.ndjson  — the agent's own redacted NDJSON, live-appended
//     agent.stderr.log     — the agent's redacted stderr, live-appended
//     services.log         — followed API/Postgres Compose lines
//     result.json          — the final classified outcome, written once
//
// Every file is appended to SYNCHRONOUSLY as events arrive (drainRedactedStream
// → the sink below → appendFileSync), so `tail -f` against any of them shows
// live activity while the prospect's container is still running, and every
// file survives the container's own removal because it lives on the host, not
// inside the container.
//
// ONE DIRECTORY PER NAMED PROSPECT, STABLE ACROSS A RETRY. `runOnboardingEvalWithRetry`
// derives a fresh, attempt-suffixed identity per attempt (scripts/lib/onboarding-eval.ts's
// retryIdentity: "helios" → "helios-r2"), so callers wanting one retryable
// admission attempt to read as ONE record must key the artifact directory by
// the BASE identity, not the per-attempt one — otherwise a refused-then-retried
// prospect would fragment across two directories with no shared anchor. This
// module keys the writer by the caller's base identity and hands
// `runOnboardingEvalWithRetry` only a SINK (never a shared `telemetry`
// context): each attempt still builds its own telemetry inside
// `runOnboardingEval` (with the correct per-attempt runId and attempt number —
// see its `opts.telemetry ?? createOnboardingTelemetry(...)` fallback) and
// funnels every event through this one sink, so attempt tagging stays correct
// while every attempt's evidence lands in the same discoverable place.
import { join } from "node:path";
import { explainOutcome, formatOutcomeEvidence } from "../agent/classify-outcome.ts";
import {
  buildAgentPrompt,
  DEFAULT_API_URL_INTERNAL,
  DEFAULT_AUTO_APPROVE_DELAY_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  LOCAL_SWARM_ONBOARDING_SKILL_PATH,
  type OnboardingEvalResult,
  type OnboardingIdentity,
} from "./onboarding-eval.ts";
import { createOnboardingArtifactWriter, type OnboardingEventSink } from "./onboarding-telemetry.ts";

export interface ProspectTranscript {
  /** Host directory an operator tails/inspects; stable across every attempt of this one prospect. */
  readonly directory: string;
  /**
   * Pass this as `runOnboardingEvalWithRetry`'s `onStructuredEvent` — never as
   * its `telemetry` (see module doc comment: a shared telemetry object would
   * freeze every later attempt's `attempt` tag at the first attempt's value).
   */
  readonly sink: OnboardingEventSink;
  /** The admission attempt(s) finished (admitted or not) — write the durable outcome record. */
  finish(result: OnboardingEvalResult, durationMs: number): void;
  /** The harness itself threw (never reached a classifiable result) — still close out the record rather than leaving it looking "in progress" forever. */
  finishThrew(error: unknown, durationMs: number): void;
}

/**
 * Start retaining a discoverable, tailable, secret-redacted transcript for one
 * prospective member's admission attempt(s). `identity` is the BASE identity
 * (attempt 1's) — the one the smoke's roster/pane already tracks — and
 * `model` is the resolved model id (`resolveModelConfig(...).model`), known to
 * the caller before it invokes `runOnboardingEvalWithRetry`.
 */
export function startProspectTranscript(opts: {
  repoRoot: string;
  composeProject: string;
  identity: OnboardingIdentity;
  model: string;
}): ProspectTranscript {
  const skillPath = join(opts.repoRoot, "frontend", "public", LOCAL_SWARM_ONBOARDING_SKILL_PATH);
  // The exact prompt attempt 1 runs with — mirrors what runOnboardingEval
  // builds internally (buildAgentPrompt(identity, DEFAULT_API_URL_INTERNAL)),
  // since the smoke never overrides apiUrlInternal. Only used for the
  // manifest's integrity hash; a later retry attempt's slightly different
  // (contact-suffixed) prompt is not re-hashed here — its own evidence lives
  // in events.ndjson, tagged with its own attempt number.
  const prompt = buildAgentPrompt(opts.identity, DEFAULT_API_URL_INTERNAL);
  const writer = createOnboardingArtifactWriter({
    repoRoot: opts.repoRoot,
    composeProject: opts.composeProject,
    runId: opts.identity.runId,
    model: opts.model,
    contact: opts.identity.contact,
    prompt,
    skillPath,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    autoApproveDelayMs: DEFAULT_AUTO_APPROVE_DELAY_MS,
    // Safe candidate identity (issue #317 AC): the prospect's PUBLIC display
    // name — the same one the smoke's onboarding pane and, once admitted, the
    // swarm roster already show. Never the contact (redacted above via
    // contactHash) and never a secret.
    candidateName: opts.identity.name,
  });
  return {
    directory: writer.directory,
    sink: writer.sink,
    finish(result, durationMs) {
      writer.finish(buildOutcomeRecord(opts.composeProject, result, durationMs));
    },
    finishThrew(error, durationMs) {
      writer.finish({
        version: 1,
        finishedAt: new Date().toISOString(),
        smokeRun: opts.composeProject,
        admitted: false,
        outcome: "harness-error",
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

/**
 * The durable `result.json` record for a finished (admitted or not) attempt —
 * the classified outcome (§11.3 E4), the branch/reason that decided it, and
 * the actionable liveness/error evidence, alongside the raw result fields.
 * Exported standalone and pure so its shape is unit-testable without Docker or
 * a real container run — the whole point of this file.
 */
export function buildOutcomeRecord(
  composeProject: string,
  result: OnboardingEvalResult,
  durationMs: number,
): Record<string, unknown> {
  const explanation = explainOutcome(result);
  return {
    version: 1,
    finishedAt: new Date().toISOString(),
    smokeRun: composeProject,
    durationMs,
    admitted: result.admitted,
    outcome: explanation.outcome,
    branch: explanation.branch,
    reason: explanation.reason,
    evidence: formatOutcomeEvidence(explanation),
    harnessFault: explanation.harnessFault,
    memberId: result.memberId,
    applyState: result.applyState,
    claimedAt: result.claimedAt,
    onActiveRoster: result.onActiveRoster,
    steps: result.steps,
    timedOut: result.timedOut,
    containerExitCode: result.containerExitCode,
    containerLaunched: result.containerLaunched,
    finalAttemptRunId: result.identity.runId,
  };
}
