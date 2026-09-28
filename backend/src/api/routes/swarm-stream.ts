// The scheduler stream's HTTP and WebSocket surface — issue #1026 W4.4, moved
// to a WebSocket by D55 (11).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §6.3 and §7,
// docs/technical/smoke-production-spec.md §3, and docs/decisions.md D55 (11).
//
// Thin transport, like every other router in this directory: it checks the
// caller's RIGHTS, parses what little there is to parse, and hands off to
// backend/src/swarm/domain.ts's stream-serving section. No decision about what
// to serve is made here.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SUBSCRIPTION IS A WEBSOCKET (D55 (11))
// ─────────────────────────────────────────────────────────────────────────────
//
// `GET /api/swarm/scheduler/subscribe?cursor=N` is a WebSocket upgrade, served
// by Bun.serve's `websocket` handler in backend/src/api/index.ts through the two
// exports below (`upgradeSchedulerStream`, `schedulerStreamWebSocket`). The
// frames are JSON text: `{type:"event",seq,kind,subjectId,sessionId,payload,
// committedAt}`, `{type:"keepalive",head}` and `{type:"resync",reason,head}`.
// The socket ends with an explicit close code (domain.ts
// SCHEDULER_STREAM_CLOSE): 4000 after a resync, 4001 when the token was
// revoked or rotated. The four rules D55 (11) keeps:
//
//   * THE TOKEN RIDES ONLY IN THE UPGRADE'S `Authorization` HEADER. A token in
//     a URL lands in access logs; a header does not. So the upgrade reads
//     `Authorization: Bearer …` and nothing else — not `X-Automation-Token`,
//     not a cookie — and a URL carrying ANY query parameter but `cursor` is
//     refused with 400 before anything is looked up, whatever else it carries.
//   * EVERY KEEPALIVE RE-AUTHORIZES the token against the store, and a token
//     revoked or rotated since the upgrade closes the socket.
//   * OVERFLOW IS RESYNC-AND-CLOSE. The socket reports its outbound backlog;
//     past its bound the API sends one `resync` frame and closes. It never
//     drops an event to make room.
//   * THE SCOPE IS THE SCHEDULER STREAM ONLY. The judge subscription
//     (swarm-judge-participant.ts) stays an event stream until its own
//     decision moves it.
//
// A plain GET of the subscribe path — no upgrade — answers 426. The scheduler
// reaches `api:8787` directly (docker-compose.yml's SCHEDULER_API_URL), so no
// proxy sits between it and this upgrade.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT IN swarm-admin.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// These are not admin routes. Every route in swarm-admin.ts is reachable by an
// operator's admin credential; §7 says `system-scheduler` holds "an API
// credential, an automation token with the rights to read subjects and
// sessions and to perform lifecycle transitions", and nothing more. The stream
// is that token's surface, so it asks for those named rights and nothing else
// opens it — not `isPrivileged`, and no env credential (there is none left to
// consult: D52 (1), backend/src/api/auth.ts).
//
// THE READ ROUTES ASK FOR BOTH READ RIGHTS. §3's full read returns subjects AND
// sessions in one answer; a token holding only one of the two would otherwise
// receive the other half anyway, which would make the split meaningless. The
// subscription asks for them too, and further that the token is the
// scheduler's own (holder `system-scheduler`): §6.3 "This stream is the
// scheduler's alone".
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { ROUTES } from "@robotmoney/contract";
import { bearer, hasAutomationRight } from "../auth.ts";
import { lookupAutomationToken } from "../../db/automation-tokens.ts";
import * as stream from "../../swarm/domain.ts";
import type { SwarmRouteResult } from "./swarm/types.ts";

type StreamTiming = Pick<stream.StreamOptions, "keepaliveMs" | "pollMs" | "bufferBytes" | "onEnd">;

type StreamConfig = {
  /** The connection's timing and its end hook, for a test that cannot wait
   *  out the defaults or must see the connection stop. Never read from the
   *  environment; the api's own server passes nothing. */
  streamTiming?: StreamTiming;
};

/** What the upgrade hands the socket: the cursor, the token to re-authorize, and any test timing. */
export interface SchedulerStreamSocketData {
  cursor: number;
  /** The bearer the upgrade presented, held only in this process's memory for the per-keepalive re-check. */
  token: string;
  timing?: StreamTiming;
  handle?: stream.SchedulerStreamHandle;
}

const FORBIDDEN: SwarmRouteResult = { status: 403, body: { error: "forbidden" } };

/** The one thing the upgrade needs from the server: Bun.serve's `upgrade`. */
export interface SocketUpgrader {
  upgrade(req: Request, opts: { data: SchedulerStreamSocketData }): boolean;
}

const S = ROUTES.swarm.scheduler;

/**
 * Parse the subscription's cursor.
 *
 * A MISSING cursor is refused rather than defaulted to 0 or to the head. Both
 * defaults are silently wrong in opposite directions — 0 replays the whole log,
 * the head skips everything committed since the caller's snapshot — and §6.3's
 * handoff only works when the cursor is the one the full read returned. So the
 * caller says which, or gets a 400.
 */
function parseCursor(url: URL): number | null {
  const raw = url.searchParams.get("cursor");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Every query parameter the subscribe URL may carry. Anything else — a token above all — is refused. */
const SUBSCRIBE_QUERY = new Set(["cursor"]);

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** The rights the subscription asks of a grant: the scheduler's own token, with both read rights. */
function grantMaySubscribe(grant: Awaited<ReturnType<typeof lookupAutomationToken>>): boolean {
  return (
    grant !== null &&
    grant.holder === "system-scheduler" &&
    grant.rights.includes("read_subjects") &&
    grant.rights.includes("read_sessions")
  );
}

/**
 * Validate a subscribe request and, if it passes, upgrade it to the socket.
 *
 * Returns a Response for every refusal and `undefined` once the upgrade is
 * under way (Bun then owns the connection). Called by backend/src/api/index.ts
 * for the subscribe path before any other routing, with the server handle only
 * `fetch` has.
 *
 * The order of the checks is the order of what they protect: the URL first
 * (a token in it is refused before it is even looked at, let alone looked up),
 * then the header credential, then the cursor, then the upgrade itself.
 */
export async function upgradeSchedulerStream(
  req: Request,
  url: URL,
  server: SocketUpgrader,
  cfg: StreamConfig = {},
): Promise<Response | undefined> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const stray = [...url.searchParams.keys()].filter((k) => !SUBSCRIBE_QUERY.has(k));
  if (stray.length > 0) {
    return json(
      {
        error: "only `cursor` may ride in the subscribe URL: the token travels in the upgrade's Authorization header, " +
          `never the URL (D55 (11)); refused parameter(s): ${[...new Set(stray)].sort().join(", ")}`,
      },
      400,
    );
  }
  const token = bearer(req);
  if (!token) {
    return json({ error: "Authorization: Bearer <scheduler token> required on the upgrade (D55 (11))" }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }
  if (!grantMaySubscribe(await lookupAutomationToken(token))) return json({ error: "forbidden" }, 403);
  const cursor = parseCursor(url);
  if (cursor === null) return json({ error: "cursor required" }, 400);
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return json({ error: "the scheduler stream is a WebSocket: send the upgrade (D55 (11))" }, 426, { Upgrade: "websocket" });
  }
  const data: SchedulerStreamSocketData = { cursor, token, timing: cfg.streamTiming };
  if (!server.upgrade(req, { data })) {
    return json({ error: "websocket upgrade failed" }, 400);
  }
  return undefined;
}

/** Bun's ServerWebSocket, seen as the three things the serving loop needs. */
function sinkOf(ws: ServerWebSocket<SchedulerStreamSocketData>): stream.StreamSink {
  return {
    send(text) {
      const r = ws.send(text);
      // Bun: -1 queued behind backpressure, 0 dropped (connection gone), >0 bytes written.
      return r === -1 ? "backpressure" : r === 0 ? "closed" : "sent";
    },
    bufferedAmount: () => ws.getBufferedAmount(),
    close: (code, reason) => ws.close(code, reason),
  };
}

/**
 * The server's WebSocket handler for the scheduler stream.
 *
 * `sendPings` is Bun's transport keepalive (§6.3 "Silent failure detection"):
 * a peer that stops answering pings is closed after `idleTimeout`. The
 * application keepalive — the frame that carries the head — is the serving
 * loop's, every `keepaliveMs`. `closeOnBackpressureLimit` stays off on
 * purpose: the loop, not the server, decides to close, so the subscriber is
 * sent `resync` first rather than being cut with nothing.
 */
export const schedulerStreamWebSocket: WebSocketHandler<SchedulerStreamSocketData> = {
  sendPings: true,
  idleTimeout: 30,
  closeOnBackpressureLimit: false,
  open(ws) {
    const { cursor, token, timing } = ws.data;
    ws.data.handle = stream.serveSchedulerStream(cursor, sinkOf(ws), {
      ...timing,
      // Re-checked every keepalive interval, busy or quiet, against the token
      // store as it is THEN. Provisioning replaces the row's hash (smoke spec
      // §3), so a rotated or revoked token stops authorizing at once.
      stillAuthorized: async () => grantMaySubscribe(await lookupAutomationToken(token)),
    });
  },
  message() {
    // The scheduler sends nothing on this socket but transport pongs, which
    // never reach here. Anything else is ignored: the stream is one-way.
  },
  close(ws) {
    ws.data.handle?.stop();
  },
};

/**
 * The stream's plain-HTTP routes: the full read, and a subscribe that did not
 * upgrade (426). Returns null for any path it does not own.
 */
export async function handleSchedulerStream(req: Request, url: URL): Promise<SwarmRouteResult | Response | null> {
  const p = url.pathname;
  const m = req.method;

  if (p === S.fullRead && m === "GET") {
    if (!(await hasAutomationRight(req, "read_subjects")) || !(await hasAutomationRight(req, "read_sessions"))) {
      return FORBIDDEN;
    }
    return { status: 200, body: await stream.fullRead() };
  }

  if (p === S.subscribe && m === "GET") {
    // backend/src/api/index.ts takes every subscribe request before routing,
    // so reaching here means a caller that is not the api's own server (the
    // swarm dispatcher called directly). The same refusals apply, and without
    // a server to upgrade on, a valid request still gets 426.
    const refused = await upgradeSchedulerStream(req, url, { upgrade: () => false });
    return refused ?? json({ error: "websocket upgrade failed" }, 400);
  }

  // There is no job-ack route. §6.3 (amended 2026-09-24, D52): "there is no
  // ad-hoc job kind for the API to push, ack or redeliver." A POST to the old
  // path falls through to the router's 404 like any other unknown path.
  return null;
}
