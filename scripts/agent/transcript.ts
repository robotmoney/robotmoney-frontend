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
