#!/usr/bin/env bun
// The JUDGE's one-shot runner (smoke-production-spec.md §6.2, issue #1026
// W3.4). STEP 1 STUB: the functions throw NOT IMPLEMENTED; the answer union
// and the contract in these comments are the deliverable of this step.
//
// ── THIS STUB IS A PLACEHOLDER FOR SALVAGED, ALREADY-PROVEN CODE ────────────
// Read this before writing a body here. This branch does NOT yet contain issue
// #1014 — `main` has not been merged into it, so `scripts/agent/judge-runner.ts`
// does not exist in this tree. #1014's transport (a short-lived judge container
// started by an `agent-launcher` service mounting `/var/run/docker.sock`) is
// REVERTED by Phase 0 of the deployment-refactor plan, because the spec forbids
// the socket anywhere (§6.2). But its RUNNER is good and is being kept: the
// one-shot shim that reads a prompt file, makes one POST, writes one tagged
// line and always exits 0, together with its unit tests that run without a
// container or a network.
//
// STEP 3 REPLACES THIS FILE with that salvaged implementation, moved here from
// `scripts/agent/judge-runner.ts` and with the answer union's third arm renamed
// from `launcher` to `runner` (there is no launcher any more). Do not write a
// fresh implementation over this stub: the salvaged one is already proven, and
// re-deriving it would lose the ordering rules below that were learned from
// real failures.
//
// ── THE JUDGE IS A KEYED PERSONA AND SIGNS ITS JUDGEMENT ────────────────────
// #1014's premise was that the judge is not a persona, holds no key, and signs
// nothing. The spec EXPLICITLY REJECTS that premise. §6.1 gives judges their
// own namespace in `credential.json`, with distinct keys, alongside agents.
// §6.2 states the judge is a participant exactly like an agent. So `themis` is
// a keyed persona: it has an entry under `judges`, it runs in a standing
// participant container, and it signs the judgement it submits, on the same
// signing-payload-then-sign path a take uses. An unsigned judgement would make
// the judge the one component of a consensus receipt whose authorship cannot be
// verified after the fact, which is precisely backwards.
//
// ── WHY A PROMPT FILE, NEVER ARGV OR ENV ────────────────────────────────────
// A judge prompt carries every take in the session plus the brief, and grows
// with the roster. Linux caps a single argv or environment string at
// MAX_ARG_STRLEN — 32 pages, 128 KiB — and the failure is not a truncation
// warning: `execve` returns E2BIG and the process never starts. A judge that
// silently stops working once a session has enough members is the exact defect
// this rule prevents. The prompt is written to a FILE and the runner is handed
// the path.
//
// ── WHY ALWAYS EXIT 0, AND ONE TAGGED LINE ─────────────────────────────────
// The runner's exit code carries no information the caller can use: a non-zero
// exit is indistinguishable between "the vendor refused" and "this shim
// crashed", and those two demand opposite responses. So the runner reports
// through its ANSWER LINE and always exits 0; the absence of an answer line is
// itself the third signal ("never launched"). Reading order at the caller is
// fixed and must not be reshuffled: (1) timeout, (2) answer line, (3) never
// launched. Timeout first, because a timed-out run may still have printed a
// partial line; answer before "never launched", because a run that answered
// and then died still answered.
//
// ── THE THREE-CASE UNION, AND WHY TWO OF ITS ARMS MUST NEVER MERGE ──────────
// `model_status` means the VENDOR refused: the request reached the model
// provider and the provider returned a non-success status. That is a product
// fact. It feeds the D-A7 taxonomy (`credit_exhausted`, `credential_rejected`,
// `model_not_supported`), it tells an operator to add credit or fix a key, and
// under "the judge refuses instead of faking" it is a legitimate, honest
// no-judgement outcome.
//
// `runner` means THIS SHIM, its network, or its launch failed: a malformed
// prompt file, a DNS failure, a crash, a process that never started. That is an
// infrastructure fact about our own deployment. It tells an operator to look at
// the participant container.
//
// Collapse them and both readings break: a `runner` fault reported as a vendor
// refusal sends an operator to top up an account that was never charged, while
// a vendor refusal reported as a rail fault sends them to debug a container
// that worked perfectly. Worse, the judgement-absence reason recorded on the
// session would claim a cause the evidence does not support. Keep them apart.
//
// ── GOVERNING SPEC SECTIONS ─────────────────────────────────────────────────
// §6.1 (judges namespace, distinct keys), §6.2 (the judge is a participant;
// one-shot per take; no socket), §10 W3 ("Judge runs as a participant; nothing
// judges inline").

/** The single stdout tag the caller parses. Everything else is free-form log. */
export const JUDGE_ANSWER_TAG = "RM_JUDGE_ANSWER";

/**
 * The three-case answer union. Exactly one is printed, exactly once.
 *
 * - `ok`           — the model answered; `body` is its raw answer text for the
 *                    caller to parse. The runner does not interpret it: a shim
 *                    that reshapes a judgement is a shim that can invent one.
 * - `model_status` — the vendor refused. `status` is the HTTP status and `body`
 *                    is a BOUNDED excerpt of the response, because a provider
 *                    error body can be large and can echo request content.
 * - `runner`       — this shim, its network, or its launch failed. Never used
 *                    for a vendor response of any status.
 */
export type JudgeAnswer =
  | { kind: "ok"; body: string }
  | { kind: "model_status"; status: number; body: string }
  | { kind: "runner"; message: string };

/** Everything one judge run needs. A judge run reads nothing ambient. */
export interface JudgeRunnerOptions {
  /** Path to the prompt FILE. Never the prompt itself — see MAX_ARG_STRLEN. */
  promptFile: string;
  /** The model endpoint to POST to. */
  endpoint: string;
  /** The wire model id, as the vendor spells it. */
  model: string;
  /** The model credential, injected explicitly. */
  apiKey: string;
  /** Wall-clock ceiling for the single POST. */
  timeoutMs: number;
}

/**
 * Read the prompt from its file.
 *
 * Input: the path. Output: the prompt text.
 *
 * Refusals: a missing, unreadable, or empty file is a `runner` fault — never a
 * `model_status`, since no request was made. The caller turns it into a
 * `runner` answer line and still exits 0.
 *
 * Gate (spec §10 W3): "Judge runs as a participant" — the prompt-file path is
 * what lets a full session's takes reach the judge at all.
 */
export function readPromptFile(promptFile: string): string {
  throw new Error(
    "NOT IMPLEMENTED: read the judge prompt from its file — spec §6.2, issue #1026 W3.4",
  );
}

/**
 * Render an answer as the single tagged stdout line.
 *
 * Input: an answer. Output: one line, `RM_JUDGE_ANSWER {json}`, with no
 * embedded newlines — a multi-line answer would break the caller's line
 * parser, so the body is escaped through JSON encoding.
 *
 * Refusals: none.
 */
export function formatAnswerLine(answer: JudgeAnswer): string {
  throw new Error(
    "NOT IMPLEMENTED: render the tagged judge answer line — spec §6.2, issue #1026 W3.4",
  );
}

/**
 * Parse a tagged answer line back into the union, for the caller.
 *
 * Input: one line of the runner's stdout. Output: the answer, or `null` when
 * this line is not an answer line (ordinary log output).
 *
 * Refusals: a line carrying the tag but malformed JSON parses to a `runner`
 * answer rather than `null` — the runner did speak, and it spoke wrongly,
 * which is a fault of this shim and must be reported as one.
 */
export function parseAnswerLine(line: string): JudgeAnswer | null {
  throw new Error(
    "NOT IMPLEMENTED: parse the tagged judge answer line — spec §6.2, issue #1026 W3.4",
  );
}

/**
 * Make the ONE POST and produce the answer.
 *
 * Input: the options. Output: exactly one `JudgeAnswer`.
 *
 * NO RETRY. A judge call is expensive and a retried refusal is still a
 * refusal; more importantly, a retry inside the shim hides from the caller how
 * many times the vendor was actually asked, which is the number an operator
 * needs when reading a credit-exhaustion incident. Retry policy, if any,
 * belongs to the caller that owns the session window.
 *
 * Refusals: none thrown. Every failure becomes an answer — a non-success
 * vendor status becomes `model_status`, and anything else (DNS, timeout,
 * malformed response) becomes `runner`.
 */
export async function runJudge(options: JudgeRunnerOptions): Promise<JudgeAnswer> {
  throw new Error(
    "NOT IMPLEMENTED: make the single judge POST and produce the answer — spec §6.2, issue #1026 W3.4",
  );
}

if (import.meta.main) {
  // The real entrypoint prints exactly one tagged line and exits 0 on EVERY
  // path, including its own internal failure. Step 3 replaces this with #1014's
  // salvaged implementation.
  throw new Error(
    "NOT IMPLEMENTED: judge one-shot runner entrypoint — spec §6.2, issue #1026 W3.4",
  );
}
