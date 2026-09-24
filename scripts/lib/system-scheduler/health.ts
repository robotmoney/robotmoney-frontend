// THE STARTUP CHECK AND THE HEALTH SURFACE — issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §1, §4.6 and §7, and
// docs/technical/smoke-production-spec.md §3 and §6.3.
//
//   §7: `system-scheduler` "holds exactly one: an API credential, an automation
//    token … It never touches the database, so it has no role password."
//
//   smoke §6.3: readiness needs "the scheduler authenticated to the API; its
//    stream established and synchronized; its initial rebuild complete …; and
//    every active subject holding a `collecting` session."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE STARTUP CHECK IS A FULL READ AND NOT A /health PING
// ─────────────────────────────────────────────────────────────────────────────
//
// Two failures have to be told apart — "the API is not there" and "your token
// is not accepted" — and only a call that PRESENTS the credential can separate
// them. An unauthenticated liveness ping answers 200 with a bad token, which is
// the one answer that would let a scheduler come up healthy and then do nothing
// for the rest of its life.
//
// The full read is also the call the scheduler is about to make anyway, so the
// check exercises the exact right the container depends on rather than a
// neighbouring one that might be granted differently.
import type { FetchLike, SchedulerHealth } from "./types.ts";

/** The one route the startup check touches. Kept as a literal rather than
 *  imported from the contract package so this module has no import at all
 *  outside its own directory; the parity test pins it to `ROUTES`. */
export const SCHEDULER_FULL_READ_PATH = "/api/swarm/scheduler/full-read";

export interface StartupCheck {
  ok: boolean;
  apiReachable: boolean;
  tokenValid: boolean;
  /** Null only when both held. */
  error: string | null;
}

export interface StartupCheckOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Is the API there, and does it accept this token?
 *
 * Reachability and authentication are reported SEPARATELY because an operator
 * who cannot tell them apart fixes the wrong thing — and because §6.3 has smoke
 * surface the reason, not just the verdict.
 */
export async function runStartupCheck(opts: StartupCheckOptions): Promise<StartupCheck> {
  const doFetch: FetchLike = opts.fetchImpl ?? fetch;
  const url = `${opts.apiUrl.replace(/\/$/, "")}${SCHEDULER_FULL_READ_PATH}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { "X-Automation-Token": opts.token, Accept: "application/json" },
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      apiReachable: false,
      tokenValid: false,
      error: `API unreachable at ${url}: ${String((err as Error)?.message ?? err)}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      apiReachable: true,
      tokenValid: false,
      error: `API rejected the automation token (HTTP ${res.status})`,
    };
  }
  if (!res.ok) {
    // Reachable, and the token was not the objection. Not an authentication
    // failure, so it is not reported as one.
    return {
      ok: false,
      apiReachable: true,
      tokenValid: false,
      error: `API answered HTTP ${res.status} to the full read`,
    };
  }
  return { ok: true, apiReachable: true, tokenValid: true, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The health surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The JSON the endpoint serves, and the exact shape smoke's readiness consumes.
 *
 * It is a function rather than "just serialize the object" so there is ONE
 * producer of the wire shape. `scripts/tests/unit/smoke-readiness.test.ts`
 * builds its fixtures by calling it, which is how the criterion's "a fake typed
 * identically to the real handler" is met: a renamed field breaks the consumer
 * test instead of silently reading `undefined` on a live boot.
 */
export function healthPayload(h: SchedulerHealth): SchedulerHealth {
  return {
    authenticated: h.authenticated,
    streamSynchronized: h.streamSynchronized,
    initialRebuildComplete: h.initialRebuildComplete,
    exhausted: h.exhausted.map((e) => ({
      item: e.item,
      subjectId: e.subjectId,
      sessionId: e.sessionId,
      lastError: e.lastError,
      attempts: e.attempts,
      exhaustedAtMs: e.exhaustedAtMs,
    })),
    healthy: h.healthy,
    lastError: h.lastError,
    timers: { boundaries: h.timers.boundaries, deadlines: h.timers.deadlines },
  };
}

/**
 * 200 when healthy, 503 when not.
 *
 * The status code carries the verdict so a container healthcheck — which reads
 * an exit code, not a JSON field — sees the same answer smoke does. The body is
 * served either way, because an unhealthy scheduler's whole value is saying
 * WHY.
 */
export function healthStatusCode(h: SchedulerHealth): number {
  return h.healthy ? 200 : 503;
}

export interface HealthServer {
  port: number;
  stop(): void;
}

/**
 * Serve the health surface, and nothing else.
 *
 * One route. No admin surface, no transition trigger, no configuration write:
 * the scheduler's endpoint exists so smoke and an operator can READ its state,
 * and every additional verb would be a second way to drive a clock that §3 says
 * is driven by its timers and the stream.
 */
export function serveHealth(port: number, read: () => SchedulerHealth, path = "/health"): HealthServer {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      const h = read();
      return new Response(JSON.stringify(healthPayload(h)), {
        status: healthStatusCode(h),
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    },
  });
  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}
