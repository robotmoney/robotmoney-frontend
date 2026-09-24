// THE SCHEDULER'S ONE WAY OUT — issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §4.6, §6.3 and §7, and
// docs/technical/smoke-production-spec.md §3.
//
//   §7: `system-scheduler` "holds exactly one: an API credential, an automation
//    token with the rights to read subjects and sessions and to perform
//    lifecycle transitions."
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY CALL THE CONTAINER CAN MAKE IS IN THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// That is the point of it existing. §9's "never polls the API on an interval"
// and §7's one-credential rule are both properties of the SET of calls the
// process can make, and a set spread across four modules cannot be read. One
// file, one token, nine methods.
//
// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFYING A FAILURE, WHICH IS §4.6's WHOLE DISTINCTION
// ─────────────────────────────────────────────────────────────────────────────
//
// §4.6 splits failures into "a refusal with a reason … is final" and "a
// transient error or a lost response is retried". The split is made HERE, once,
// and the clock never re-derives it:
//
//   * a thrown fetch, a timeout, a 5xx, a 408 or a 429  → transient
//   * any other non-2xx carrying an `error` string      → a reasoned refusal
//   * a 2xx whose body will not parse                   → transient, because the
//     write may well have committed and the response is what was lost
//
// A 4xx is final even though it is cheap to retry, because §4.6 says so and
// because retrying a state-guard refusal is how a client turns one bug into a
// storm.
import { ROUTES } from "@robotmoney/contract";
import type {
  AggregateBody,
  FinalizeBody,
  OpenBody,
  RequestJudgingBody,
  SchedulerApiResult,
  FetchLike,
  SchedulerFullRead,
  TransitionApi,
  TurnoverBody,
} from "./types.ts";
import type { ConsumerApi, FullReadSnapshot, StreamFrame } from "./stream-consumer.ts";

export interface SchedulerApiOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  /** Per-request ceiling. A transition that never answers is a lost response (§4.6). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** §4.6: the statuses that mean "try again", as opposed to "no". */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export class SchedulerHttpApi implements TransitionApi, ConsumerApi {
  #base: string;
  #token: string;
  #fetch: FetchLike;
  #timeoutMs: number;
  /** The live subscription, so a rebuild can close the old one before opening a new one. */
  #stream: { abort: AbortController } | null = null;

  constructor(opts: SchedulerApiOptions) {
    this.#base = opts.apiUrl.replace(/\/$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  #headers(json: boolean): Record<string, string> {
    // ONE credential. Nothing else is presented, ever — not an admin token, not
    // a member bearer, not a database password (§7).
    const h: Record<string, string> = { "X-Automation-Token": this.#token, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  /** A POST transition, with §4.6's classification applied to the answer. */
  async #post<T>(path: string, body: Record<string, unknown>): Promise<SchedulerApiResult<T>> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method: "POST",
        headers: this.#headers(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      return { ok: false, status: null, error: String((err as Error)?.message ?? err), transient: true };
    }

    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const obj = (parsed ?? {}) as Record<string, unknown>;

    if (!res.ok) {
      const error = typeof obj.error === "string" ? obj.error : `http_${res.status}`;
      return { ok: false, status: res.status, error, transient: isTransientStatus(res.status) };
    }
    if (parsed === null) {
      // The transition may have committed and the body was lost. Retried,
      // which §5's guards make safe.
      return { ok: false, status: res.status, error: "unparseable_success_body", transient: true };
    }
    // The API's own envelope carries `ok` and `status`; strip them so the
    // client's discriminant is the one this module defines.
    const { ok: _ok, status: _status, ...rest } = obj;
    return { ok: true, ...(rest as T) };
  }

  // ── §4's transitions ───────────────────────────────────────────────────────

  openEpoch(subjectId: string): Promise<SchedulerApiResult<OpenBody>> {
    return this.#post<OpenBody>(ROUTES.swarm.admin.epochOpen, { subjectId });
  }

  turnover(subjectId: string, expectedSessionId: string): Promise<SchedulerApiResult<TurnoverBody>> {
    // §4.3: the epoch is NAMED. There is no overload of this that omits it.
    return this.#post<TurnoverBody>(ROUTES.swarm.admin.epochTurnover, { subjectId, expectedSessionId });
  }

  aggregate(sessionId: string): Promise<SchedulerApiResult<AggregateBody>> {
    return this.#post<AggregateBody>(ROUTES.swarm.admin.epochAggregate, { sessionId });
  }

  requestJudging(sessionId: string): Promise<SchedulerApiResult<RequestJudgingBody>> {
    return this.#post<RequestJudgingBody>(ROUTES.swarm.admin.epochRequestJudging, { sessionId });
  }

  finalize(sessionId: string): Promise<SchedulerApiResult<FinalizeBody>> {
    return this.#post<FinalizeBody>(ROUTES.swarm.admin.epochFinalize, { sessionId });
  }

  // ── §3 and §6.3's stream ───────────────────────────────────────────────────

  /**
   * §3's four parts and the cursor.
   *
   * THROWS rather than returning a result union, because the consumer contract
   * (`SchedulerStreamConsumer`) treats a failed rebuild as "still not current"
   * and retries it through its own backoff. Two retry mechanisms over one call
   * would each be bounded by the other's timing and neither would be legible.
   */
  async fullRead(): Promise<FullReadSnapshot & SchedulerFullRead> {
    const res = await this.#fetch(`${this.#base}${ROUTES.swarm.scheduler.fullRead}`, {
      headers: this.#headers(false),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new Error(`full read failed: HTTP ${res.status}`);
    const body = (await res.json()) as SchedulerFullRead;
    if (typeof body?.cursor !== "number") throw new Error("full read returned no cursor");
    return body as FullReadSnapshot & SchedulerFullRead;
  }

  /**
   * Open the subscription from `cursor` and pump frames at `onFrame`.
   *
   * Returns as soon as the connection is ESTABLISHED, because the consumer's
   * `start()` awaits it and must not block until the stream ends. The pump runs
   * until the body closes, then reports the drop; §6.3 says a dropped
   * connection is followed by a rebuild, and the caller owns that.
   *
   * There is no reconnect loop in here. That lives in the consumer, where the
   * backoff and the "rebuild, never replay" rule already are.
   */
  async subscribeStream(
    cursor: number,
    onFrame: (frame: StreamFrame) => void | Promise<void>,
    onClosed: (reason: string) => void,
  ): Promise<void> {
    this.closeStream();
    const abort = new AbortController();
    this.#stream = { abort };
    const res = await this.#fetch(
      `${this.#base}${ROUTES.swarm.scheduler.subscribe}?cursor=${encodeURIComponent(String(cursor))}`,
      { headers: this.#headers(false), signal: abort.signal },
    );
    if (!res.ok || !res.body) throw new Error(`subscribe failed: HTTP ${res.status}`);

    void (async () => {
      try {
        for await (const frame of readSse(res.body!)) {
          await onFrame(frame);
        }
        onClosed("stream ended");
      } catch (err) {
        onClosed(String((err as Error)?.message ?? err));
      }
    })();
  }

  /** Satisfies `ConsumerApi`. The consumer subscribes; the pump is wired by the container. */
  async subscribe(cursor: number): Promise<void> {
    void cursor;
  }

  closeStream(): void {
    this.#stream?.abort.abort();
    this.#stream = null;
  }

  async ackJob(idempotencyKey: string): Promise<void> {
    await this.#post(ROUTES.swarm.scheduler.jobAck, { idempotencyKey });
  }
}

/**
 * Turn the API's `text/event-stream` into the consumer's frames.
 *
 * THE TWO SHAPES DIFFER AND THE MAPPING IS HERE. The wire carries
 * `event: <name>` plus a JSON `data:` line; the consumer discriminates on a
 * `type` field inside one object. Doing the translation in the transport keeps
 * `stream-consumer.ts` free of the wire format, which is what let it be tested
 * against an injected transport in the first place.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamFrame> {
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
      const frame = parseSseFrame(chunk);
      if (frame) yield frame;
      split = buffer.indexOf("\n\n");
    }
  }
}

export function parseSseFrame(chunk: string): StreamFrame | null {
  let event = "";
  const dataLines: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!event) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLines.join("\n") || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (event) {
    case "event":
      return {
        type: "event",
        seq: Number(data.seq),
        kind: String(data.kind),
        subjectId: (data.subjectId as string | null) ?? null,
        sessionId: (data.sessionId as string | null) ?? null,
        payload: (data.payload as Record<string, unknown>) ?? {},
      };
    case "keepalive":
      return { type: "keepalive", head: Number(data.head ?? 0) };
    case "resync":
      return { type: "resync", reason: String(data.reason ?? "unspecified") };
    case "job":
      return {
        type: "job",
        kind: String(data.kind),
        target: String(data.target),
        idempotencyKey: String(data.idempotencyKey),
      };
    default:
      // An unknown frame is ignored, not a reason to rebuild: §3.1 makes a
      // rebuild the answer to a provable loss, and this is not one.
      return null;
  }
}
