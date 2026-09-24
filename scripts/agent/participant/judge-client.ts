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
// Until now the judge model ran INLINE, in two processes that hold a database
// credential: the `swarm.judge` queue handler inside `worker-swarm`, and the
// admin route's `judge` verb inside the API. Both are gone. What remains is
// this: a standing container, holding a judge's own signing identity and its
// own model key and nothing else, that learns of work by subscribing and
// reports it by POSTing.
//
// The server side was built by W4's second part: `judgeSubscribe` serves STATE
// — every session in `judging` this judge has not submitted, on every connect —
// and `judgement` wires into the same `recordJudgingConsensus` transition the
// admin path uses, so the two cannot give different answers.
//
// ─────────────────────────────────────────────────────────────────────────────
// A JUDGE REFUSES RATHER THAN FAKES
// ─────────────────────────────────────────────────────────────────────────────
//
// There is no fallback branch in this file and there is not going to be one.
// When the model cannot be reached, or answers a status, or answers nothing a
// judgement can be read out of, this client SUBMITS NOTHING and logs why. The
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
import { ROUTES } from "@robotmoney/contract";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJudge, type JudgeAnswer } from "./judge-runner.ts";

/** One outstanding judging request, as the subscription serves it. */
export interface PendingJudging {
  sessionId: string;
  subjectId: string;
  date: string;
  judgingDeadlineAt: string;
  judgingRequestedAt: string | null;
}

export interface JudgeClientConfig {
  apiUrl: string;
  /** The judge's own member bearer. Not the scheduler's automation token (§7). */
  token: string;
  memberId: string;
  name: string;
  /** The model this judge calls, as the vendor spells it on the wire. */
  model: string;
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
  /** Backoff after a dropped subscription, in milliseconds. */
  reconnectMs: number;
}

export class JudgeClientConfigError extends Error {}

/** Env names the compose `judge` participant profile injects. */
export const JUDGE_CLIENT_ENV = {
  apiUrl: "RM_API_URL",
  token: "RM_MEMBER_TOKEN",
  memberId: "RM_MEMBER_ID",
  name: "RM_MEMBER_NAME",
  model: "RM_JUDGE_MODEL",
  endpoint: "RM_JUDGE_BASE_URL",
  apiKey: "OPENCODE_API_KEY",
  timeoutMs: "RM_JUDGE_TIMEOUT_MS",
} as const;

export function readJudgeClientConfig(env: Record<string, string | undefined> = process.env): JudgeClientConfig {
  const need = (key: string): string => {
    const v = (env[key] ?? "").trim();
    if (!v) throw new JudgeClientConfigError(`${key} was not injected`);
    return v;
  };
  const timeout = Number.parseInt(env[JUDGE_CLIENT_ENV.timeoutMs] ?? "", 10);
  return {
    apiUrl: need(JUDGE_CLIENT_ENV.apiUrl).replace(/\/$/, ""),
    token: need(JUDGE_CLIENT_ENV.token),
    memberId: need(JUDGE_CLIENT_ENV.memberId),
    name: need(JUDGE_CLIENT_ENV.name),
    // The model and the credential are REQUIRED. A judge container without them
    // would connect, receive work and refuse every item — visibly, but only
    // after a deadline has passed. Refusing at startup instead puts the
    // misconfiguration in front of the operator immediately, and the container
    // crash-loops under `restart: unless-stopped`, which is the right outcome.
    model: need(JUDGE_CLIENT_ENV.model),
    endpoint: need(JUDGE_CLIENT_ENV.endpoint),
    apiKey: need(JUDGE_CLIENT_ENV.apiKey),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 300_000,
    reconnectMs: 5_000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the judge's prompt from the session's PUBLIC record.
 *
 * The judge reads what an outside reviewer could read — the session and its
 * takes over the ordinary API — rather than being handed a curated context by
 * the thing it is judging. A judge given its input by the process under review
 * is not an independent one.
 */
export async function fetchSessionContext(
  config: JudgeClientConfig,
  sessionId: string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<unknown> {
  const url = `${config.apiUrl}${ROUTES.swarm.sessionById.replace(":id", encodeURIComponent(sessionId))}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.token}` } });
  if (!res.ok) throw new Error(`session ${sessionId} unreadable: HTTP ${res.status}`);
  return res.json();
}

/**
 * The instruction the model is given, verbatim and unparameterised.
 *
 * It says, in its own words, that refusing is an allowed answer. A prompt that
 * only describes how to approve is a prompt that produces approvals.
 */
export const JUDGE_INSTRUCTION = [
  "You are an independent judge of one investment-committee session.",
  "Below is the session's public record: its brief, its signed member takes and its aggregate recommendation.",
  "Return a judgement of the session's reasoning quality and internal consistency.",
  "If the record is insufficient to judge, say so explicitly and judge nothing.",
  "Do not invent facts that are not in the record.",
].join("\n");

export function buildPrompt(session: unknown): string {
  return `${JUDGE_INSTRUCTION}\n\n--- SESSION RECORD ---\n${JSON.stringify(session, null, 2)}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// One judging
// ─────────────────────────────────────────────────────────────────────────────

export type JudgeOutcome =
  | { kind: "submitted"; sessionId: string; judgementId: number; duplicate: boolean; lateEvidence: boolean }
  | { kind: "refused"; sessionId: string; reason: string }
  | { kind: "submit_failed"; sessionId: string; status: number; error: string };

/**
 * Judge one session and submit, or refuse and submit nothing.
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

  let session: unknown;
  try {
    session = await fetchSessionContext(config, pending.sessionId, doFetch);
  } catch (err) {
    return { kind: "refused", sessionId: pending.sessionId, reason: String((err as Error)?.message ?? err) };
  }

  const dir = await mkdtemp(join(tmpdir(), "rm-judge-"));
  const promptFile = join(dir, "prompt.txt");
  let answer: JudgeAnswer;
  try {
    await writeFile(promptFile, buildPrompt(session), "utf8");
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

  if (answer.kind !== "ok") {
    // THE ONLY BRANCH THERE IS. A vendor status and a rail fault are reported
    // apart, because an operator debugging a container that worked perfectly
    // and an operator topping up an account that was never charged are looking
    // for different things — but neither produces a judgement.
    const reason =
      answer.kind === "model_status"
        ? `model refused with HTTP ${answer.status}: ${answer.body}`
        : `judge runner fault: ${answer.message}`;
    return { kind: "refused", sessionId: pending.sessionId, reason };
  }

  return submitJudgement(config, pending.sessionId, answer.body, doFetch);
}

/**
 * POST the opinion under this judge's own bearer.
 *
 * A REDELIVERY IS A SUCCESS. The server answers the original row with
 * `duplicate: true` when this judge already submitted for this session, and a
 * client that treated that as a failure would retry for ever against a server
 * that is behaving exactly as designed. A submission after finalize comes back
 * `lateEvidence: true` and is likewise a success — it was recorded, it simply
 * decides nothing (§4.4).
 */
export async function submitJudgement(
  config: JudgeClientConfig,
  sessionId: string,
  opinion: string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<JudgeOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.apiUrl}${ROUTES.swarm.participants.judgement}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, opinion, model: config.model }),
    });
  } catch (err) {
    return { kind: "submit_failed", sessionId, status: 0, error: String((err as Error)?.message ?? err) };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    return { kind: "submit_failed", sessionId, status: res.status, error: String(body.error ?? `http_${res.status}`) };
  }
  return {
    kind: "submitted",
    sessionId,
    judgementId: Number(body.judgementId ?? 0),
    duplicate: body.duplicate === true,
    lateEvidence: body.lateEvidence === true,
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
