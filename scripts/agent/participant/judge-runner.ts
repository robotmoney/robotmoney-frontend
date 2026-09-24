#!/usr/bin/env bun
// The JUDGE's one-shot runner (smoke-production-spec.md §6.2, issue #1026
// W3.4). The answer union and the contract in these comments are the design;
// the bodies below are #1014's proven one-shot shim, salvaged.
//
// ── THIS FILE IS SALVAGED, ALREADY-PROVEN CODE ──────────────────────────────
// #1014's transport (a short-lived judge container started by an
// `agent-launcher` service mounting `/var/run/docker.sock`) is REVERTED by
// Phase 0 of the deployment-refactor plan, because the spec forbids the socket
// anywhere (§6.2). But its RUNNER was good and is kept here: the one-shot shim
// that reads a prompt file, makes one POST, writes one tagged line and always
// exits 0. The answer union's third arm is renamed from `launcher` to `runner`
// — there is no launcher any more — and everything launcher-specific is gone.
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
// ── THE ANSWER UNION, AND WHY TWO OF ITS ARMS MUST NEVER MERGE ──────────────
// `model_status` means the VENDOR refused: the request reached the model
// provider and the provider returned a non-success status. That is a product
// fact. It feeds the D-A7 taxonomy (`credit_exhausted`, `credential_rejected`,
// `model_not_supported` — judge-reasons.ts), it tells an operator to add credit
// or fix a key, and under "the judge refuses instead of faking" it is a
// legitimate, honest no-judgement outcome.
//
// `timeout` means the vendor was ASKED and did not answer inside the judge's
// wall-clock ceiling: D-A7's `model_timeout`. It is neither of the other two —
// no status came back, and nothing in this shim failed — so it is its own arm
// rather than a `runner` message a caller would have to pattern-match.
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

import { readFileSync } from "node:fs";

/** The single stdout tag the caller parses. Everything else is free-form log. */
export const JUDGE_ANSWER_TAG = "RM_JUDGE_ANSWER";

/**
 * The answer union. Exactly one is printed, exactly once.
 *
 * - `ok`           — the model answered; `body` is its raw answer text for the
 *                    caller to parse. The runner does not interpret it: a shim
 *                    that reshapes a judgement is a shim that can invent one.
 * - `model_status` — the vendor refused. `status` is the HTTP status and `body`
 *                    is a BOUNDED excerpt of the response, because a provider
 *                    error body can be large and can echo request content.
 * - `timeout`      — the vendor was asked and did not answer within
 *                    `timeoutMs`. D-A7's `model_timeout`.
 * - `runner`       — this shim, its network, or its launch failed. Never used
 *                    for a vendor response of any status, nor for a timeout.
 */
export type JudgeAnswer =
  | { kind: "ok"; body: string }
  | { kind: "model_status"; status: number; body: string }
  | { kind: "timeout"; timeoutMs: number }
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
  let text: string;
  try {
    text = readFileSync(promptFile, "utf8");
  } catch (err) {
    throw new Error(`prompt file ${promptFile} is unreadable: ${message(err)}`);
  }
  if (text.trim() === "") throw new Error(`prompt file ${promptFile} was empty`);
  return text;
}

/** A body is a label, not a payload: the same bound #1014 used host-side. */
const BODY_LABEL_MAX = 400;

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, BODY_LABEL_MAX);
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
  // JSON encoding is what keeps a multi-line body — or a body that quotes the
  // tag itself — on ONE line and unable to forge a second answer.
  return `${JUDGE_ANSWER_TAG} ${JSON.stringify(answer)}`;
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
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${JUDGE_ANSWER_TAG} `)) return null; // ordinary log output
  const payload = trimmed.slice(JUDGE_ANSWER_TAG.length + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // The runner did speak, and it spoke wrongly — a torn or malformed line is
    // a fault of THIS SHIM, never a verdict about the model.
    return { kind: "runner", message: `judge answer line was not JSON: ${payload.slice(0, BODY_LABEL_MAX)}` };
  }
  const answer = parsed as Partial<JudgeAnswer> | null;
  if (answer && typeof answer === "object") {
    if (answer.kind === "ok" && typeof (answer as { body?: unknown }).body === "string") {
      return { kind: "ok", body: (answer as { body: string }).body };
    }
    if (
      answer.kind === "model_status"
      && typeof (answer as { status?: unknown }).status === "number"
      && typeof (answer as { body?: unknown }).body === "string"
    ) {
      const m = answer as { status: number; body: string };
      return { kind: "model_status", status: m.status, body: m.body };
    }
    if (answer.kind === "timeout" && typeof (answer as { timeoutMs?: unknown }).timeoutMs === "number") {
      return { kind: "timeout", timeoutMs: (answer as { timeoutMs: number }).timeoutMs };
    }
    if (answer.kind === "runner" && typeof (answer as { message?: unknown }).message === "string") {
      return { kind: "runner", message: (answer as { message: string }).message };
    }
  }
  return { kind: "runner", message: "judge answer line carried no recognizable answer" };
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
 * vendor status becomes `model_status`, the wall-clock ceiling becomes
 * `timeout`, and anything else (DNS, a malformed response) becomes `runner`.
 */
export async function runJudge(options: JudgeRunnerOptions): Promise<JudgeAnswer> {
  let prompt: string;
  try {
    prompt = readPromptFile(options.promptFile);
  } catch (err) {
    // No request was made, so this can never be a vendor verdict.
    return { kind: "runner", message: message(err) };
  }
  let res: Response;
  try {
    res = await fetch(`${options.endpoint.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    // THE CEILING, told apart from the rail. `AbortSignal.timeout` rejects the
    // fetch with a `TimeoutError`: the request went out and nothing came back
    // in time, which is D-A7's `model_timeout`, not a fault of this shim.
    if (isTimeout(err)) return { kind: "timeout", timeoutMs: options.timeoutMs };
    // The vendor was never reached: the RAIL, not a verdict about the model.
    return { kind: "runner", message: `model endpoint unreachable: ${message(err)}` };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, BODY_LABEL_MAX);
    } catch {
      // Deliberately NOT `timeout`, even when the body read hit the ceiling:
      // the vendor has already given its verdict as a status, and the status
      // alone still classifies (402 is credit_exhausted whatever the body
      // says). Only the body-dependent distinctions fall back to their
      // status-only class.
      body = "";
    }
    return { kind: "model_status", status: res.status, body };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    // THE SAME CEILING, READING THE BODY. `AbortSignal.timeout` covers the
    // whole exchange, so a vendor that sends its headers and then stalls
    // rejects HERE with the same `TimeoutError`. That is still D-A7's
    // `model_timeout` — the model did not answer in time — and reporting it as
    // a `runner` fault would blame the shim for the vendor's silence, the
    // arm-merge judge-reasons.ts forbids.
    if (isTimeout(err)) return { kind: "timeout", timeoutMs: options.timeoutMs };
    return { kind: "runner", message: `model answer was not JSON: ${message(err)}` };
  }
  const content = (parsed as { choices?: { message?: { content?: unknown } }[] } | null)
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    // The shim must never invent a judgement.
    return { kind: "runner", message: "model answer carried no assistant text" };
  }
  // Raw and uninterpreted: a shim that reshapes a judgement is a shim that
  // could manufacture one.
  return { kind: "ok", body: content };
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError";
}

/** Env names this shim reads. The credential's name is the registry's, not ours. */
export const JUDGE_RUNNER_ENV = {
  model: "RM_JUDGE_MODEL",
  endpoint: "RM_JUDGE_BASE_URL",
  promptFile: "RM_JUDGE_PROMPT_FILE",
  apiKey: "OPENCODE_API_KEY",
  timeoutMs: "RM_JUDGE_TIMEOUT_MS",
} as const;

const DEFAULT_JUDGE_TIMEOUT_MS = 300_000;

/**
 * The whole run, from the container environment to exactly one answer.
 *
 * Every missing injection is the caller having built the run wrong, which is
 * the rail failing before the vendor was ever involved — never a model verdict.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<JudgeAnswer> {
  const model = (env[JUDGE_RUNNER_ENV.model] ?? "").trim();
  const apiKey = (env[JUDGE_RUNNER_ENV.apiKey] ?? "").trim();
  const promptFile = (env[JUDGE_RUNNER_ENV.promptFile] ?? "").trim();
  const endpoint = (env[JUDGE_RUNNER_ENV.endpoint] ?? "").trim();
  const timeoutMs = Number.parseInt(env[JUDGE_RUNNER_ENV.timeoutMs] ?? "", 10);
  if (!model) return { kind: "runner", message: `${JUDGE_RUNNER_ENV.model} was not injected` };
  if (!apiKey) return { kind: "runner", message: `${JUDGE_RUNNER_ENV.apiKey} was not injected` };
  if (!promptFile) return { kind: "runner", message: `${JUDGE_RUNNER_ENV.promptFile} was not injected` };
  if (!endpoint) return { kind: "runner", message: `${JUDGE_RUNNER_ENV.endpoint} was not injected` };
  return runJudge({
    promptFile,
    endpoint,
    model,
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_JUDGE_TIMEOUT_MS,
  });
}

// `import.meta.main` is false when a test imports this file, so everything
// above is unit-testable without a container and without a network.
if (import.meta.main) {
  // ALWAYS exit 0 with exactly one tagged line, including on this shim's own
  // internal failure: a non-zero exit cannot distinguish "the vendor refused"
  // from "the container died", which is what the two failure arms exist for.
  let answer: JudgeAnswer;
  try {
    answer = await main();
  } catch (err) {
    answer = { kind: "runner", message: `judge runner failed: ${message(err)}` };
  }
  console.log(formatAnswerLine(answer));
}
