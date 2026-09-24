// THE JUDGE CONTAINER'S CALLER — issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.1, §6.2 and §6.3, and
// docs/technical/system-scheduler-spec.md §1, §4.4 and §7.
//
//   smoke §6.2 (as amended by scheduler spec §12): "agents poll; judges
//    subscribe and are served pending `judging` requests on every connect."
//
//   scheduler §1: participants "do the work that needs a model: takes and
//    judgements." §7: the model key is "delivered to those containers only".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND WHAT IT REPLACES
// ─────────────────────────────────────────────────────────────────────────────
//
// The judge model used to run INLINE, in two processes that hold a database
// credential: the `swarm.judge` queue handler inside `worker-swarm`, and the
// admin route's `judge` verb inside the API. Both are gone, and the backend
// judge they called is deleted (D53 point 4). What remains is this: a standing
// container, holding a judge's own signing identity and its own model key and
// nothing else, that learns of work by subscribing and reports it by POSTing a
// SIGNED judgement.
//
// The server side: `judgeSubscribe` serves STATE — every session in `judging`
// this judge has not submitted and may, on every connect, each with the frozen
// input it is to read — and `judgement` verifies the signature, re-checks the
// digest and parses the answer before anything is written (domain.ts
// `submitJudgement`).
//
// ─────────────────────────────────────────────────────────────────────────────
// A JUDGE REFUSES RATHER THAN FAKES
// ─────────────────────────────────────────────────────────────────────────────
//
// There is no fallback branch in this file and there is not going to be one.
// When the model cannot be reached, or answers a status, or times out, this
// client SUBMITS NOTHING and logs why, by the D-A7 name (judge-reasons.ts). The
// session then reaches its deadline with no eligible consensus and the API
// publishes it `no_consensus`, with no certificate and nothing invented
// (scheduler spec §4.4).
//
// That is the correct outcome and it is strictly better than the alternative:
// a templated opinion submitted under a judge's signing key is indistinguishable
// downstream from one the judge actually formed. `no_consensus` says what
// happened; a placeholder lies about it. The absence of the branch is asserted
// by `scripts/tests/unit/no-inline-judge.test.ts`, which greps this file.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SUBSCRIPTION NEEDS NO CURSOR AND NO RECOVERY
// ─────────────────────────────────────────────────────────────────────────────
//
// It carries none of the scheduler's machinery, deliberately. The scheduler
// holds timers and must prove it missed nothing, so it has a cursor, a
// sequence, a gap rule and a rebuild. A judge holds nothing: the request is
// STATE, so every connect is the same query and a judge that was down while the
// request was created gets it by coming back. A dropped connection is answered
// by reconnecting, and there is nothing to replay.
import { canonicalizeJudgement, ROUTES } from "@robotmoney/contract";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// THE JUDGE'S PROMPT AND DIGEST ARE THE SERVER'S, imported rather than copied.
// `judge.ts` is the pure half of the judge — no database, no environment —
// and the API recomputes `inputsDigest` over the same function at submission,
// so a second spelling of it here would be a second chance to disagree.
import {
  inputsDigest,
  JUDGE_PROMPT_HASH,
  renderJudgePrompt,
  type JudgeInput,
} from "../../../backend/src/swarm/judge.ts";
import { assertJudgeModelAllowed } from "../../../backend/src/swarm/judge-model-policy.ts";
import type { PersonaIdentity } from "../../lib/swarm/persona-keys.ts";
import { runJudge, type JudgeAnswer } from "./judge-runner.ts";
import {
  failureCodeForAnswer,
  RUNNER_FAULT,
  type JudgeFailureCode,
  type JudgeRefusalReason,
} from "./judge-reasons.ts";

/** One outstanding judging request, as the subscription serves it. */
export interface PendingJudging {
  sessionId: string;
  subjectId: string;
  date: string;
  judgingDeadlineAt: string;
  judgingRequestedAt: string | null;
  /** The frozen take set, brief and rollup facts this judge is to read — and the digest's subject. */
  input: JudgeInput;
}

export interface JudgeClientConfig {
  apiUrl: string;
  /** The judge's own member bearer. Not the scheduler's automation token (§7). */
  token: string;
  memberId: string;
  name: string;
  /** This judge's own signing key, from its `credential.json` entry (§6.1). */
  identity: PersonaIdentity;
  /** The model this judge calls, as the vendor spells it on the wire. */
  model: string;
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
  /** Backoff after a dropped subscription, in milliseconds. */
  reconnectMs: number;
}

/**
 * A configuration this judge cannot run under. `reason` is the D-A7 name when
 * the gap is one the taxonomy names (no model, no key, a disallowed model), so
 * the crash-loop an operator sees says which of them it is.
 */
export class JudgeClientConfigError extends Error {
  readonly reason: JudgeRefusalReason | null;
  constructor(message: string, reason: JudgeRefusalReason | null = null) {
    super(reason ? `${reason}: ${message}` : message);
    this.name = "JudgeClientConfigError";
    this.reason = reason;
  }
}

/** Env names the compose `judge` participant profile injects. */
export const JUDGE_CLIENT_ENV = {
  apiUrl: "RM_API_URL",
  token: "RM_MEMBER_TOKEN",
  memberId: "RM_MEMBER_ID",
  name: "RM_MEMBER_NAME",
  identity: "RM_MEMBER_IDENTITY",
  model: "RM_JUDGE_MODEL",
  endpoint: "RM_JUDGE_BASE_URL",
  apiKey: "OPENCODE_API_KEY",
  timeoutMs: "RM_JUDGE_TIMEOUT_MS",
} as const;

export function readJudgeClientConfig(env: Record<string, string | undefined> = process.env): JudgeClientConfig {
  const need = (key: string, reason: JudgeRefusalReason | null = null): string => {
    const v = (env[key] ?? "").trim();
    if (!v) throw new JudgeClientConfigError(`${key} was not injected`, reason);
    return v;
  };
  // The model and the credential are REQUIRED, and each gap refuses by its
  // D-A7 name. A judge container without them would connect, receive work and
  // refuse every item — visibly, but only after a deadline had passed.
  // Refusing at startup puts the misconfiguration in front of the operator
  // immediately, and the container crash-loops under `restart: unless-stopped`,
  // which is the right outcome.
  const model = need(JUDGE_CLIENT_ENV.model, "model_unconfigured");
  const apiKey = need(JUDGE_CLIENT_ENV.apiKey, "credential_unconfigured");
  try {
    // WHICH model, not merely some model (AC-MODEL-01): the keyless free family
    // everywhere, and anything but the pinned model on an acceptance path.
    assertJudgeModelAllowed(model, env);
  } catch (err) {
    throw new JudgeClientConfigError(err instanceof Error ? err.message : String(err), "model_disallowed");
  }
  const timeout = Number.parseInt(env[JUDGE_CLIENT_ENV.timeoutMs] ?? "", 10);
  return {
    apiUrl: need(JUDGE_CLIENT_ENV.apiUrl).replace(/\/$/, ""),
    token: need(JUDGE_CLIENT_ENV.token),
    memberId: need(JUDGE_CLIENT_ENV.memberId),
    name: need(JUDGE_CLIENT_ENV.name),
    identity: readIdentity(need(JUDGE_CLIENT_ENV.identity)),
    model,
    endpoint: need(JUDGE_CLIENT_ENV.endpoint),
    apiKey,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 300_000,
    reconnectMs: 5_000,
  };
}

/** The judge's signing identity. A key it cannot sign with is not a key. */
function readIdentity(raw: string): PersonaIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JudgeClientConfigError(`${JUDGE_CLIENT_ENV.identity} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const identity = parsed as Partial<PersonaIdentity> | null;
  if (!identity || typeof identity.publicKeyB64 !== "string" || identity.publicKeyB64 === "") {
    throw new JudgeClientConfigError(`${JUDGE_CLIENT_ENV.identity} carries no publicKeyB64`);
  }
  if (!identity.privateJwk || typeof identity.privateJwk !== "object") {
    throw new JudgeClientConfigError(`${JUDGE_CLIENT_ENV.identity} carries no privateJwk`);
  }
  return { publicKeyB64: identity.publicKeyB64, privateJwk: identity.privateJwk };
}

// ─────────────────────────────────────────────────────────────────────────────
// One judging
// ─────────────────────────────────────────────────────────────────────────────

export type JudgeOutcome =
  | { kind: "submitted"; sessionId: string; judgementId: number; duplicate: boolean; lateEvidence: boolean }
  /**
   * Nothing was submitted. `reason` is the D-A7 code, or `runner` for this
   * container's own fault; `detail` is a bounded label for the log, never
   * parsed by anything.
   */
  | { kind: "refused"; sessionId: string; reason: JudgeFailureCode; detail: string }
  | { kind: "submit_failed"; sessionId: string; status: number; error: string };

/** A detail is a label, not a payload. */
const DETAIL_MAX = 400;

function detailOf(answer: JudgeAnswer): string {
  switch (answer.kind) {
    case "ok":
      return "";
    case "model_status":
      return `HTTP ${answer.status}: ${answer.body}`.slice(0, DETAIL_MAX);
    case "timeout":
      return `no answer within ${answer.timeoutMs} ms`;
    case "runner":
      return answer.message.slice(0, DETAIL_MAX);
  }
}

/**
 * Judge one session and submit, or refuse and submit nothing.
 *
 * THE INPUT IS THE ONE THE SUBSCRIPTION SERVED. The prompt is rendered from it
 * and the signed `inputsDigest` is computed over it, so the API's recomputation
 * at submission is over the same object and a judgement can never claim to
 * have read a take set it did not.
 *
 * The prompt goes to the model through a FILE, not argv or an environment
 * variable: a session's full record blows past `MAX_ARG_STRLEN`, and the
 * failure mode is an E2BIG at spawn rather than a legible error.
 */
export async function judgeOne(
  config: JudgeClientConfig,
  pending: PendingJudging,
  deps: {
    fetchImpl?: typeof globalThis.fetch;
    runJudgeImpl?: typeof runJudge;
  } = {},
): Promise<JudgeOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const run = deps.runJudgeImpl ?? runJudge;

  if (!pending.input || !Array.isArray(pending.input.takes)) {
    // A frame with no input is a protocol fault between this container and the
    // API — not a vendor verdict, and no model is asked.
    return { kind: "refused", sessionId: pending.sessionId, reason: RUNNER_FAULT, detail: "the subscription served no input for this session" };
  }

  const dir = await mkdtemp(join(tmpdir(), "rm-judge-"));
  const promptFile = join(dir, "prompt.txt");
  let answer: JudgeAnswer;
  try {
    await writeFile(promptFile, renderJudgePrompt(pending.input), "utf8");
    answer = await run({
      promptFile,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const failure = failureCodeForAnswer(answer);
  if (failure !== null || answer.kind !== "ok") {
    // THE ONLY BRANCH THERE IS. Each failure keeps its own D-A7 name, because
    // an operator topping up an account, fixing a key, fixing a model id and
    // debugging this container are looking for different things — but none of
    // them produces a judgement.
    return { kind: "refused", sessionId: pending.sessionId, reason: failure ?? RUNNER_FAULT, detail: detailOf(answer) };
  }

  return submitJudgement(config, pending, answer.body, doFetch);
}

/**
 * Sign the judgement with THIS judge's own key, or THROW.
 *
 * A key this container cannot import is a refusal, not an empty signature: a
 * judgement is signed by its judge or it does not exist (the same rule
 * take-runner.ts states for a take).
 */
async function signJudgement(canonical: string, config: JudgeClientConfig): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", config.identity.privateJwk as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  } catch (err) {
    throw new JudgeClientConfigError(
      `judge "${config.name}" cannot import its own signing key — a judgement is signed by its judge or it is not ` +
        `submitted at all: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(canonical));
  return Buffer.from(new Uint8Array(signature)).toString("base64");
}

/**
 * POST the model's raw answer, signed, under this judge's own bearer.
 *
 * WHAT IS SIGNED: `canonicalizeJudgement` (@robotmoney/contract) over this
 * member's id, the session, a fresh nonce, the model, the prompt hash, the
 * digest of the served input, and the answer text exactly as the model gave
 * it. The API verifies it against this member's ACTIVE key before anything is
 * written.
 *
 * A REDELIVERY IS A SUCCESS. The server answers the original row with
 * `duplicate: true` when this judge already submitted for this session, and a
 * client that treated that as a failure would retry for ever against a server
 * behaving exactly as designed. A submission after finalize comes back
 * `lateEvidence: true` and is likewise a success — it was recorded, it simply
 * decides nothing (§4.4).
 */
export async function submitJudgement(
  config: JudgeClientConfig,
  pending: PendingJudging,
  opinion: string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<JudgeOutcome> {
  const sessionId = pending.sessionId;
  const body = {
    sessionId,
    opinion,
    model: config.model,
    promptHash: JUDGE_PROMPT_HASH,
    inputsDigest: inputsDigest(pending.input),
    nonce: crypto.randomUUID(),
  };
  const signature = await signJudgement(canonicalizeJudgement({ ...body, memberId: config.memberId }), config);
  let res: Response;
  try {
    res = await fetchImpl(`${config.apiUrl}${ROUTES.swarm.participants.judgement}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, signature }),
    });
  } catch (err) {
    return { kind: "submit_failed", sessionId, status: 0, error: String((err as Error)?.message ?? err) };
  }
  let answer: Record<string, unknown> = {};
  try {
    answer = (await res.json()) as Record<string, unknown>;
  } catch {
    answer = {};
  }
  if (!res.ok) {
    return { kind: "submit_failed", sessionId, status: res.status, error: String(answer.error ?? `http_${res.status}`) };
  }
  return {
    kind: "submitted",
    sessionId,
    judgementId: Number(answer.judgementId ?? 0),
    duplicate: answer.duplicate === true,
    lateEvidence: answer.lateEvidence === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The subscription
// ─────────────────────────────────────────────────────────────────────────────

/** Parse the judge stream's `pending` frames out of an SSE body. */
export async function* readPendingFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<PendingJudging[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
      let event = "";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (event !== "pending") continue; // a keepalive carries no work
      try {
        const parsed = JSON.parse(data.join("\n") || "{}") as { pending?: PendingJudging[] };
        if (Array.isArray(parsed.pending)) yield parsed.pending;
      } catch {
        // A frame that will not parse is dropped. The set is STATE, so the
        // next frame — or the next connect — carries the whole thing again.
      }
    }
  }
}

/**
 * The container's whole life: connect, judge what arrives, reconnect.
 *
 * ONE AT A TIME. A judge that ran every pending session concurrently would hold
 * several model calls open under one credential and finish none of them if the
 * container were stopped. Sequential is also what makes the "already submitted"
 * answer meaningful: the second attempt at a session is always a redelivery,
 * never a race with this process's own first attempt.
 */
export async function runJudgeClient(
  config: JudgeClientConfig,
  signal?: AbortSignal,
  deps: {
    fetchImpl?: typeof globalThis.fetch;
    log?: (m: string) => void;
    /** Injected so the loop is testable without a model credential or a network. */
    runJudgeImpl?: typeof runJudge;
  } = {},
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((m: string) => console.log(`[judge:${config.name}] ${m}`));
  const done = new Set<string>();

  while (!signal?.aborted) {
    try {
      const res = await doFetch(`${config.apiUrl}${ROUTES.swarm.participants.judgeSubscribe}`, {
        headers: { Authorization: `Bearer ${config.token}`, Accept: "text/event-stream" },
        signal,
      });
      if (res.status === 401 || res.status === 403) {
        // Terminal. The token was revoked or this member is not a judge; a
        // container that keeps reconnecting on a 403 hides the fact.
        throw new JudgeClientConfigError(`judge subscription refused with HTTP ${res.status}`);
      }
      if (!res.ok || !res.body) throw new Error(`judge subscription failed: HTTP ${res.status}`);
      log("subscribed");

      for await (const pending of readPendingFrames(res.body)) {
        for (const item of pending) {
          if (signal?.aborted) return;
          if (done.has(item.sessionId)) continue;
          const outcome = await judgeOne(config, item, {
            fetchImpl: doFetch,
            runJudgeImpl: deps.runJudgeImpl,
          });
          log(JSON.stringify(outcome));
          // Remembered only on a SUBMITTED outcome. A refusal is not remembered,
          // so a model that recovers before the deadline still gets its chance
          // when the next frame or the next connect re-serves the session.
          if (outcome.kind === "submitted") done.add(item.sessionId);
        }
      }
      log("subscription closed");
    } catch (err) {
      if (err instanceof JudgeClientConfigError) throw err;
      if (signal?.aborted) return;
      log(`subscription error: ${String((err as Error)?.message ?? err)}`);
    }
    await sleep(config.reconnectMs, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => controller.abort());
  try {
    await runJudgeClient(readJudgeClientConfig(process.env), controller.signal);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
