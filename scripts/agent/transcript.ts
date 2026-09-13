// Shared parser for the `opencode run --format json` NDJSON transcript
// (docs/architecture.md §11.3 E5, docs/decisions.md D22 "shared components").
//
// Moved out of scripts/lib/swarm/inference.ts so BOTH consumers read the
// stream with one definition: the swarm take author (which wants all the
// authored prose) and the member-agent outcome classifier
// (scripts/agent/classify-outcome.ts, which wants only the agent's FINAL
// message — its verdict — never its running commentary).
//
// opencode 1.16.x emits one JSON object per line; a finalized assistant text
// part is `{"type":"text","part":{"type":"text","text":"…"}}` (the CLI only
// prints a `text` event once the part's `time.end` is set). Non-text events
// (step_start / step_finish / tool_use / reasoning) and unparseable lines are
// ignored — which is also why a transcript wrapped in the member-agent
// primitive's `--- stdout ---`/`--- stderr ---` banners parses fine.

// Every finalized assistant text part, in stream order. Returns [] when the
// transcript carries no assistant text at all (empty/failed/dead run).
export function assistantTextParts(transcript: string): string[] {
  const parts: string[] = [];
  for (const line of transcript.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev?.type === "text") {
      const text = ev?.part?.text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts;
}

// The model's authored prose for the whole run. Returns "" when the transcript
// carries no assistant text (empty/failed run) so the caller can throw loudly.
export function extractAssistantText(transcript: string): string {
  return assistantTextParts(transcript).join("\n").trim();
}

// ── Structured provider/runtime errors (issue #501 follow-up) ───────────────
// `opencode run --format json` reports a failed model exchange as a FIRST-CLASS
// NDJSON event on STDOUT and writes nothing to stderr:
//
//   {"type":"error","timestamp":…,"sessionID":"ses_…","error":{"name":"APIError",
//     "data":{"message":"Insufficient balance. …","statusCode":401,
//             "isRetryable":false,"responseHeaders":{…},
//             "metadata":{"url":"https://opencode.ai/zen/v1/chat/completions"}}}}
//
// Every consumer in this repo used to drop that line on the floor — the
// parsers above keep `type:"text"` and `continue` past everything else — and
// then GUESSED at the cause from an empty stderr. On 2026-08-05 that turned a
// flat, non-retryable billing failure (the Zen workspace ran out of balance at
// ~15:09Z) into six "intermittent provider outage" e2e failures across main and
// PR #513, each retried in vain, while the machine-readable cause sat unread in
// stdout. The cause is never a guess when the provider names it: parse it.
//
// Deliberately schema-light, like the rest of this file: every field is
// optional, unknown shapes degrade to what could be read, and a transcript with
// no error event returns []. Verified against the pinned opencode build the
// member-agent image installs (1.18.1, scripts/lib/member-agent/Dockerfile).
export interface TranscriptError {
  /** Error class opencode reported, e.g. "APIError". "" when unnamed. */
  name: string;
  /**
   * The PROVIDER's own typed discriminator, lifted out of the upstream
   * `responseBody` envelope (`{"error":{"type":"CreditsError",…}}`). This is the
   * only trustworthy way to tell an exhausted balance from any other 401 —
   * Zen answers both with the same status, and the human-readable message is
   * prose that may be reworded upstream at any time. "" when absent.
   */
  providerType: string;
  /**
   * Provider-authored message, REDACTED (see redactProviderText). Never the raw
   * upstream string: these errors are printed into CI logs and PR comments.
   */
  message: string;
  /** HTTP status the provider returned (401/402/403/429/…), or null. */
  statusCode: number | null;
  /**
   * The provider's OWN retryability verdict. `false` means retrying can only
   * waste time — a credential, funding, or quota fault that a human must clear.
   */
  isRetryable: boolean | null;
  /** Endpoint that failed, e.g. "https://opencode.ai/zen/v1/chat/completions". */
  url: string | null;
}

// Everything a provider error may carry that must not reach a log, a CI
// annotation or a PR comment: the model credential itself, and the
// account-scoped identifiers a billing URL embeds. The upstream text is
// otherwise preserved verbatim — the point is an honest diagnosis, so only the
// identifying substrings go, and each is replaced by a NAMED placeholder rather
// than deleted, so a reader can see that something was removed.
//
// The generic action ("top up …") is added by the caller from the classified
// KIND, never scraped out of the redacted URL: a workspace-specific billing
// link is exactly what may not be reproduced here.
const KEY_LIKE = /\b(?:sk|zk|pk)-[A-Za-z0-9_-]{8,}\b/g;
const ACCOUNT_ID = /\b(?:wrk|acc|org|usr)_[A-Za-z0-9]{6,}\b/g;
const WORKSPACE_URL = /https?:\/\/[^\s"']*\/workspace\/[^\s"']*/g;

export function redactProviderText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  // Live credential values first: a key pasted into an upstream message would
  // otherwise survive every pattern below.
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted credential]");
  }
  return out
    .replace(WORKSPACE_URL, "[redacted workspace url]")
    .replace(KEY_LIKE, "[redacted credential]")
    .replace(ACCOUNT_ID, "[redacted account id]");
}

// Zen wraps its typed error in the raw HTTP body: `{"type":"error","error":
// {"type":"CreditsError","message":"…"}}`. Reads it defensively — an
// unparseable or reshaped body yields "" and the caller falls back to status.
function providerTypeOf(data: any): string {
  const body = data?.responseBody;
  if (typeof data?.type === "string") return data.type;
  if (typeof body !== "string") return "";
  try {
    const parsed = JSON.parse(body);
    const t = parsed?.error?.type ?? parsed?.type;
    return typeof t === "string" && t !== "error" ? t : "";
  } catch {
    return "";
  }
}

// Every `type:"error"` event in the stream, in order. Reads both the 1.18.x
// nested `error.data.*` shape and a bare `error.message`, so a future flattening
// of the payload degrades to a named error rather than to silence.
export function transcriptErrors(transcript: string, secrets: readonly string[] = []): TranscriptError[] {
  const errors: TranscriptError[] = [];
  for (const line of transcript.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev?.type !== "error") continue;
    const err = ev?.error ?? {};
    const data = err?.data ?? {};
    const message = typeof data.message === "string"
      ? data.message
      : typeof err.message === "string"
      ? err.message
      : "";
    errors.push({
      name: typeof err.name === "string" ? err.name : "",
      providerType: providerTypeOf(data),
      message: redactProviderText(message, secrets),
      statusCode: typeof data.statusCode === "number" ? data.statusCode : null,
      isRetryable: typeof data.isRetryable === "boolean" ? data.isRetryable : null,
      url: typeof data?.metadata?.url === "string" ? redactProviderText(data.metadata.url, secrets) : null,
    });
  }
  return errors;
}

// One dense human line per error, for a log or a thrown message. Names the
// provider's own verdict (status + retryability) so a reader never has to infer
// whether a retry could have helped.
/**
 * THE FATAL PROVIDER ERROR THE STDOUT SCAN CANNOT SEE.
 *
 * `transcriptErrors()` above reads the `--format json` NDJSON stream on STDOUT.
 * That is where a well-behaved failure lands — but it is not where the opencode
 * CLI puts a stream error it did not recover from. On 2026-09-13 every swarm
 * member on `rm-frontend-stage-1` failed like this, and the ONLY record of the
 * cause was one logfmt line on STDERR:
 *
 *   timestamp=… level=ERROR run=2ed64d00 message="stream error"
 *     providerID=opencode modelID=nemotron-3-ultra-free session.id=…
 *     small=false agent=build mode=primary
 *     error.error="AI_APICallError: Rate limit exceeded. Please try again later."
 *
 * Nothing parsed it. The CLI then sat there with the session open, our runner
 * waited out its whole 120 s bound, and the failure was reported as
 * `cause=timed-out` — "raise OPENCODE_TIMEOUT_MS or check provider latency" —
 * for a provider that had already said, in its own words, that it would not
 * answer. 186 of 400 sampled member runs burned two minutes each on that, and
 * the swarm recorded ZERO analyst takes while every diagnosis pointed at
 * latency.
 *
 * So: read it. Deliberately narrow, because a false positive kills a run that
 * might still have answered — the line must be ERROR level, must be the CLI's
 * `stream error` message, must be the PRIMARY model stream (`mode=primary`, not
 * the auxiliary session-title agent that errors harmlessly), and must carry an
 * `error.error` payload. Anything less returns null and the old behaviour
 * stands.
 *
 * The returned shape is an ordinary TranscriptError, so it classifies through
 * the same `classifyInferenceFailure()` rules as a structured stdout event —
 * including rule 1: a status code is used when the CLI printed one, and prose is
 * never mined for a typed discriminator.
 */
export function cliStreamErrorFromStderr(
  line: string,
  secrets: readonly string[] = [],
): TranscriptError | null {
  if (!/\blevel=ERROR\b/.test(line)) return null;
  if (!/\bmessage="stream error"/.test(line)) return null;
  if (!/\bmode=primary\b/.test(line)) return null;
  const payload = line.match(/\berror\.error="((?:[^"\\]|\\.)*)"/);
  if (!payload) return null;
  const message = payload[1]!.replace(/\\(["\\nrt])/g, (_m, c: string) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c);
  // `AI_APICallError: …` — the error CLASS the CLI named, kept apart from the
  // prose after it. A name is not a provider discriminator and never decides a
  // kind on its own; it is what an operator recognises in a log.
  const named = message.match(/^([A-Za-z_][\w.]*Error)\s*:\s*/);
  const status = line.match(/\berror\.(?:data\.)?statusCode=(\d{3})\b/);
  return {
    name: named ? named[1]! : "",
    providerType: "",
    message: redactProviderText(message, secrets),
    statusCode: status ? Number(status[1]) : null,
    isRetryable: null,
    url: null,
  };
}

export function describeTranscriptError(e: TranscriptError): string {
  const bits = [
    e.providerType || null,
    e.statusCode === null ? null : `HTTP ${e.statusCode}`,
    e.isRetryable === null ? null : e.isRetryable ? "retryable" : "NOT retryable",
    e.url,
  ].filter(Boolean);
  const head = e.name || "error";
  const detail = bits.length ? ` [${bits.join(", ")}]` : "";
  return `${head}: ${e.message || "(no message)"}${detail}`;
}

// The LAST authored text part — the agent's closing verdict, which is what
// refusal detection keys on: an agent that mentions declining mid-run and then
// goes on to complete the task has not refused. Returns "" for an
// empty/unparseable transcript, so a DEAD run can never be mistaken for a
// REFUSED one (§11.3 E3 layer 0's "distinguishes dead from refused").
export function finalAssistantText(transcript: string): string {
  return assistantTextParts(transcript).at(-1)?.trim() ?? "";
}
