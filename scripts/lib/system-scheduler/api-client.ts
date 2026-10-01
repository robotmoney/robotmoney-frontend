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
// file, one token, seven calls: five transitions, the full read and the
// subscription. There is no job ack, because §6.3 (amended 2026-09-24, D52) has
// no jobs: the stream carries change events only.
//
// The subscription is a WebSocket (D55 (11)): the token rides in the upgrade's
// `Authorization` header, never in the URL. The HTTP calls present the same
// token as `X-Automation-Token`.
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
import { SCHEDULER_STREAM_CLOSE } from "./types.ts";

/** Close code → its name, for the log line a close leaves (D55 (11): "an explicit close code"). */
const CLOSE_NAMES = new Map<number, string>(Object.entries(SCHEDULER_STREAM_CLOSE).map(([name, code]) => [code, name]));

/**
 * The WebSocket as this client uses it: the four events and `close`. The
 * default is the runtime's own `WebSocket`, which takes the upgrade's headers
 * as a constructor option (Bun); a test injects its own.
 */
export interface StreamSocket {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

/** Open a socket to `url`, presenting `headers` on the upgrade request. */
export type OpenStreamSocket = (url: string, headers: Record<string, string>) => StreamSocket;

const openWebSocket: OpenStreamSocket = (url, headers) =>
  new WebSocket(url, { headers } as unknown as string[]) as unknown as StreamSocket;

/** Where the subscription's frames and its end are delivered. */
export interface StreamHandlers {
  onFrame(frame: StreamFrame): void | Promise<void>;
  /** The CURRENT socket ended on its own. Never called for one this client replaced or closed. */
  onClosed(reason: string): void;
}

export interface SchedulerApiOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  /** Per-request ceiling. A transition that never answers is a lost response (§4.6). */
  timeoutMs?: number;
  /** How the subscription's socket is opened. Tests inject one; the container uses `WebSocket`. */
  openSocket?: OpenStreamSocket;
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
  #openSocket: OpenStreamSocket;
  /** The live subscription, so a rebuild can close the old one before opening a new one. */
  #stream: { socket: StreamSocket } | null = null;
  #handlers: StreamHandlers | null = null;

  constructor(opts: SchedulerApiOptions) {
    this.#base = opts.apiUrl.replace(/\/$/, "");
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#openSocket = opts.openSocket ?? openWebSocket;
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
   * Say where frames go. Set once, before the first `subscribe`; every socket
   * this client ever opens pumps into the same handlers, so a rebuild's new
   * socket needs no re-wiring by the caller.
   */
  attachStream(handlers: StreamHandlers): void {
    this.#handlers = handlers;
  }

  /**
   * Open the subscription from `cursor`, REPLACING any socket already open.
   *
   * THE SUBSCRIPTION IS A WEBSOCKET (D55 (11), §6.3). The token rides in the
   * upgrade request's `Authorization: Bearer` header and never in the URL,
   * which carries the cursor and nothing else. The API re-authorizes the token
   * at every keepalive and closes the socket with its own code when the token
   * was revoked or rotated; transport pings are answered by the WebSocket
   * client itself.
   *
   * This is `ConsumerApi.subscribe`, and it is a real reconnect, not a
   * notification: the consumer calls it at the end of every full read, and the
   * socket it leaves open is the one the rebuilt copy is current against. A
   * stalled socket (§10 "Silent stall") delivers nothing ever again, so a
   * subscribe that kept it would leave the keepalive watchdog re-reading once
   * per budget for ever — a read on a timer, which §3.1 and §9 forbid.
   *
   * Returns as soon as the socket is OPEN, because the consumer awaits it
   * inside its rebuild and must not block until the stream ends. Frames are
   * handed on in arrival order, one at a time. ANY close of the current
   * socket — the API's resync close, a revoked token, a dropped connection —
   * is reported through `onClosed` with its code and reason, and the runtime
   * answers every one the same way: full read, rebuild (§3.1). A socket this
   * method or `closeStream` replaced was ended on purpose, and reporting it
   * would turn every rebuild into a reconnect.
   *
   * There is no reconnect loop in here. That lives in the runtime, where the
   * backoff and the "rebuild, never replay" rule already are.
   *
   * THE WAIT FOR THE OPEN IS BOUNDED by the same per-request ceiling as every
   * other call. The consumer awaits this inside its rebuild, and a rebuild
   * that never settles is a stall §6.3's keepalive rule cannot see: the copy
   * is not current, so the watchdog has nothing to compare, and the runtime's
   * recovery paths are all waiting on the rebuild. An API that accepts the
   * connection and never answers the upgrade would wedge the scheduler until a
   * restart. On the timeout this throws, and the runtime's dropped-connection
   * path takes over. The bound covers ONLY the open: once the socket is open
   * the timer is cleared, and a stall on it is the keepalive watchdog's.
   */
  async subscribe(cursor: number): Promise<void> {
    const handlers = this.#handlers;
    if (!handlers) throw new Error("subscribe before attachStream: nowhere to deliver frames");
    this.closeStream();
    const url = `${this.#base.replace(/^http/, "ws")}${ROUTES.swarm.scheduler.subscribe}?cursor=${encodeURIComponent(String(cursor))}`;
    let socket: StreamSocket;
    try {
      // ONE credential, in the one place the API reads it for this route.
      socket = this.#openSocket(url, { Authorization: `Bearer ${this.#token}` });
    } catch (err) {
      throw new Error(`subscribe failed: ${String((err as Error)?.message ?? err)}`);
    }
    const current = { socket };
    this.#stream = current;

    // Frames are applied strictly in order: the consumer's gap rule is about
    // sequence numbers, and two frames applied concurrently could be seen out
    // of order by it.
    let chain = Promise.resolve();
    let opened = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (opened) return;
        if (this.#stream === current) this.#stream = null;
        try {
          socket.close();
        } catch {
          /* never opened */
        }
        reject(new Error(`subscribe failed: the socket did not open within ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      socket.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
      socket.onmessage = (ev) => {
        if (this.#stream !== current) return;
        const frame = parseStreamMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
        if (!frame) return;
        chain = chain.then(async () => {
          if (this.#stream !== current) return;
          try {
            await handlers.onFrame(frame);
          } catch (err) {
            // A handler that throws must not leave the chain rejected: every
            // later frame and the close report would be skipped, and the
            // scheduler would sit connected but deaf. The socket is ended and
            // the failure reported like any other close, so the runtime's
            // full read and rebuild (§3.1) take over. `#stream` is cleared
            // first, so the socket's own close reports nothing a second time.
            if (this.#stream !== current) return;
            this.#stream = null;
            try {
              socket.close(1000, "frame handler failed");
            } catch {
              /* already closed */
            }
            handlers.onClosed(`frame handler failed: ${String((err as Error)?.message ?? err)}`);
          }
        });
      };
      socket.onerror = () => {
        // A refused upgrade (401, 403, 400) or a connection that failed
        // arrives here, then as a close; the close is what ends it.
      };
      socket.onclose = (ev) => {
        clearTimeout(timer);
        if (!opened) {
          if (this.#stream === current) this.#stream = null;
          reject(new Error(`subscribe failed: the socket closed before it opened (code ${ev.code})`));
          return;
        }
        const named = CLOSE_NAMES.get(ev.code);
        const reason = `closed ${ev.code}${ev.reason ? `: ${ev.reason}` : named ? ` (${named})` : ""}`;
        // Every frame that arrived before the close is applied first: a
        // resync frame is followed by its close, and the frame names the
        // reason the close only repeats.
        void chain.then(() => {
          if (this.#stream !== current) return;
          this.#stream = null;
          handlers.onClosed(reason);
        });
      };
    });
  }

  /** Close the live socket, if any. Its close reports nothing: this was deliberate. */
  closeStream(): void {
    const current = this.#stream;
    this.#stream = null;
    try {
      current?.socket.close(1000, "replaced");
    } catch {
      /* already closed */
    }
  }

  /** True while a socket this client opened is still the current one. */
  get streamOpen(): boolean {
    return this.#stream !== null;
  }
}

/**
 * Turn one WebSocket text message into the consumer's frame.
 *
 * The wire and the consumer share the `type` discriminant, so the mapping is a
 * shape check: a frame that does not parse, or whose type is not one of the
 * three §6.3 names, is dropped here, before it reaches the consumer. That
 * includes `job`: §6.3 has no job pushes, so a server still sending one is
 * sending work this client neither runs nor acknowledges. An unknown frame is
 * not a reason to rebuild — §3.1 makes a rebuild the answer to a provable loss,
 * and this is not one.
 */
export function parseStreamMessage(text: string): StreamFrame | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  switch (data.type) {
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
    default:
      return null;
  }
}
