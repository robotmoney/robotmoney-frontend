// Why a funded inference call produced nothing — as a stable, machine-readable
// KIND rather than a sentence a human has to interpret (issue #527).
//
// The incident this exists for: on 2026-08-05 the opencode Zen workspace
// exhausted its pay-as-you-go balance. The credential was valid; the account
// was empty. Zen answers that with an ordinary HTTP 401 whose typed body says
// `CreditsError`, and the swarm driver reported it as "the model was
// unreachable, rate-limited, unfunded, or returned nothing" — a guess, printed
// over a stated fact, on six consecutive e2e failures across main and PR #513.
// Three reruns were spent on a fault whose own payload said
// `isRetryable: false`. Nobody topped the workspace up, because nothing ever
// said to.
//
// TWO RULES GOVERN THIS FILE.
//
//  1. THE TYPED DISCRIMINATOR DECIDES. `exhausted-credits` fires on the
//     provider's own `CreditsError` type and on nothing else. It does NOT fire
//     on an "Insufficient balance" substring, because prose is reworded
//     upstream without warning and an unrelated 401 may quote it; and it does
//     NOT fire on a bare 401, because that is what an invalid key returns too.
//     A wrong "top up the balance" sends a maintainer to a billing page while
//     the real fault (a revoked key, a monthly cap) goes unread.
//  2. NOTHING IS EVER SOFTENED. Every kind here is a LOUD failure with no
//     template fallback, no skip, and no deterministic take. The kind changes
//     only WHAT THE MESSAGE SAYS and what a caller may branch on — never
//     whether the run failed.
import { describeTranscriptError, type TranscriptError } from "./transcript.ts";

/**
 * Why the call produced no assistant text. Stable strings: CI logs, member
 * failure lines and tests all key on them.
 */
export type InferenceFailureKind =
  /** The provider's typed CreditsError: the workspace balance is spent. */
  | "exhausted-credits"
  /** The credential itself was rejected (revoked, malformed, wrong account). */
  | "auth-rejected"
  /** A monthly/user allowance was reached — funded, but capped. */
  | "quota-limited"
  /** Throttled (429/529, or the provider's own retryable verdict). */
  | "throttled"
  /** The provider failed on its own side (5xx). */
  | "provider-failure"
  /** An error event that matches no rule above — named, but unclassified. */
  | "unclassified-error"
  /** No error event, but the CLI wrote to stderr: it died locally. */
  | "local-cli-failure"
  /** Nothing at all: no assistant text, no error event, no stderr. */
  | "empty-response"
  /** The call was still running when the time bound elapsed. */
  | "timed-out";

/** Zen's typed discriminators, as they appear in the raw response body. */
export const CREDITS_ERROR_TYPE = "CreditsError";
export const AUTH_ERROR_TYPE = "AuthError";
export const LIMIT_ERROR_TYPES = ["MonthlyLimitError", "UserLimitError"] as const;

export interface InferenceFailureClassification {
  kind: InferenceFailureKind;
  /** The error event the kind was read off, when there was one. */
  error: TranscriptError | null;
  /** False only for `throttled` — everything else needs a human, not a rerun. */
  retryable: boolean;
}

// First match wins, most specific first. Only the FIRST error event that
// classifies to something other than `unclassified-error` decides the kind:
// `opencode run` also issues a small session-title call, so a stream can carry
// two error events for one root cause, and both name the same fault.
export function classifyInferenceFailure(
  errors: readonly TranscriptError[],
  stderr = "",
): InferenceFailureClassification {
  if (errors.length === 0) {
    return stderr.trim()
      ? { kind: "local-cli-failure", error: null, retryable: false }
      : { kind: "empty-response", error: null, retryable: false };
  }
  const ranked = errors.map((error) => ({ error, kind: kindOf(error) }));
  const decided = ranked.find((r) => r.kind !== "unclassified-error") ?? ranked[0]!;
  return {
    kind: decided.kind,
    error: decided.error,
    retryable: decided.kind === "throttled",
  };
}

function kindOf(e: TranscriptError): InferenceFailureKind {
  // (1) The provider's own typed discriminator — authoritative, and the ONLY
  // thing that may produce `exhausted-credits`.
  if (e.providerType === CREDITS_ERROR_TYPE) return "exhausted-credits";
  if ((LIMIT_ERROR_TYPES as readonly string[]).includes(e.providerType)) return "quota-limited";
  if (e.providerType === AUTH_ERROR_TYPE) return "auth-rejected";
  // (2) Status classes, for providers that send no typed body. A 401/403 here
  // is an AUTH fault, never a credits one: an empty account and a revoked key
  // are indistinguishable at this level, and guessing "credits" would send a
  // maintainer to the billing page for a key problem.
  if (e.statusCode === 429 || e.statusCode === 529) return "throttled";
  if (e.statusCode === 402) return "quota-limited";
  if (e.statusCode === 401 || e.statusCode === 403) return "auth-rejected";
  if (e.statusCode !== null && e.statusCode >= 500) return "provider-failure";
  // (3) Named, but nothing said what class it is. Reported as itself rather
  // than folded into a neighbouring kind.
  return "unclassified-error";
}

/** What a maintainer should actually DO about each kind. */
export function inferenceFailureAction(kind: InferenceFailureKind): string {
  switch (kind) {
    case "exhausted-credits":
      return "the provider workspace has no balance left: top it up in the provider's billing settings, " +
        "then re-run. No rerun can pass until it is funded, and this is NOT an application regression.";
    case "auth-rejected":
      return "the model credential was rejected: check that the configured key is valid, unrevoked and " +
        "scoped to this workspace. Re-running cannot clear it.";
    case "quota-limited":
      return "a plan allowance was reached: raise or wait out the cap. Re-running before it resets cannot clear it.";
    case "throttled":
      return "the provider throttled the call; this one IS worth retrying after a back-off.";
    case "provider-failure":
      return "the provider failed on its own side; check its status page before suspecting this repo.";
    case "local-cli-failure":
      return "the opencode CLI died locally (crash, state/config error) BEFORE or INSTEAD OF a model exchange — " +
        "read its stderr before blaming the provider or the network.";
    case "empty-response":
      return "nothing named a cause: no assistant text, no error event, no stderr. Re-run with --print-logs to capture one.";
    case "timed-out":
      return "the call exceeded its time bound; raise OPENCODE_TIMEOUT_MS or check provider latency.";
    case "unclassified-error":
      return "the provider named an error this repo does not classify; read it verbatim above before acting.";
  }
}

/**
 * The human-readable diagnosis: what the provider said (redacted at parse time)
 * plus what to do about it. Deliberately quotes EVERY error event, not just the
 * deciding one, so a two-call stream is never half-reported.
 */
export function renderInferenceDiagnostic(
  c: InferenceFailureClassification,
  errors: readonly TranscriptError[],
  stderr = "",
): string {
  const head = `cause=${c.kind}`;
  if (errors.length > 0) {
    const named = errors.map(describeTranscriptError).join(" | ");
    return `${head} — the provider's/CLI's OWN account of the failure, not an inference: ${named}. ` +
      `${inferenceFailureAction(c.kind)}`;
  }
  if (c.kind === "local-cli-failure") {
    return `${head} — no error event on stdout, but the CLI wrote to stderr. ` +
      `${inferenceFailureAction(c.kind)} stderr: ${stderr.slice(0, 400)}`;
  }
  return `${head} — the stream carried NO error event and stderr was empty. ${inferenceFailureAction(c.kind)}`;
}

/**
 * The error every funded-inference boundary throws. Carries the machine-readable
 * kind alongside the provider and the resolved model id, so a caller (the swarm
 * session driver, a member container's failure line, a test) can branch on the
 * cause without parsing prose.
 */
export class InferenceFailure extends Error {
  readonly kind: InferenceFailureKind;
  readonly provider: string;
  readonly model: string;
  readonly providerType: string;
  readonly statusCode: number | null;
  readonly retryable: boolean;

  constructor(message: string, init: {
    kind: InferenceFailureKind;
    provider: string;
    model: string;
    providerType?: string;
    statusCode?: number | null;
    retryable?: boolean;
  }) {
    super(message);
    this.name = "InferenceFailure";
    this.kind = init.kind;
    this.provider = init.provider;
    this.model = init.model;
    this.providerType = init.providerType ?? "";
    this.statusCode = init.statusCode ?? null;
    this.retryable = init.retryable ?? false;
  }
}

/** The provider half of a `provider/model` id, for the failure's own report. */
export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "opencode";
}
