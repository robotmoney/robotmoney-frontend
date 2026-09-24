// W4 part 3 — THE SCHEDULER AND SMOKE'S READINESS, OVER REAL SOCKETS
// (issue #1026).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.3 and
// docs/technical/system-scheduler-spec.md §3, §6.3 and §7.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PROVES, AND — READ THIS FIRST — WHAT IT DOES NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// IT PROVES the three hops between the scheduler process and smoke actually fit
// together over HTTP, which no unit test can show because each of them fakes
// the hop:
//
//   1. `SchedulerHttpApi` presents the automation token, reads a real JSON full
//      read off a real socket, and parses a real `text/event-stream` into the
//      consumer's frames. The SSE wire shape (`event:` line plus a JSON `data:`
//      line) and the consumer's shape (one object with a `type`) are DIFFERENT,
//      and the translation between them is the kind of thing that is correct in
//      every unit test and wrong on the wire.
//   2. `serveHealth` answers the real payload with the real status code.
//   3. `fetchSchedulerHealth` + `evaluateSchedulerReadiness` — the code
//      `bun smoke` calls — consume that answer and reach §6.3's verdict.
//
// IT DOES NOT PROVE that a real `bun smoke` boots a real `system-scheduler`
// container against a real API and a real Postgres. There is no container here,
// no database, and the API is a Bun server implementing the epoch routes in
// memory. That is the `[e2e]` gate on the issue and it is NOT satisfied by this
// file. The API's own behaviour is owned by `backend/tests/api-event-stream.test.ts`
// and `backend/tests/epoch-*.test.ts`, which run against real Postgres.
//
// The in-memory API is deliberately thin — it serves what the real handlers
// serve and guards nothing — because its job here is to be a SOCKET, not a
// second implementation of the lifecycle whose disagreement with the first
// would be a bug nobody could locate.
import { afterEach, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { SchedulerClock } from "../../lib/system-scheduler/clock.ts";
import { SchedulerHttpApi } from "../../lib/system-scheduler/api-client.ts";
import { runStartupCheck, serveHealth, type HealthServer } from "../../lib/system-scheduler/health.ts";
import { SchedulerStreamConsumer } from "../../lib/system-scheduler/stream-consumer.ts";
import { realTimers, type SchedulerFullRead } from "../../lib/system-scheduler/types.ts";
import {
  evaluateSchedulerReadiness,
  fetchSchedulerHealth,
  schedulerReadinessPassed,
} from "../../lib/smoke-readiness-scheduler.ts";

const TOKEN = "rmat_integration_token";

interface FakeApi {
  url: string;
  stop(): void;
  /** Turnovers the scheduler actually issued, in order. */
  readonly turnovers: string[];
  /** Push one event onto the stream every live subscriber will receive. */
  emit(kind: string, subjectId: string | null, sessionId: string | null, payload: Record<string, unknown>): void;
  snapshot: SchedulerFullRead;
}

/**
 * A Bun server speaking the API's scheduler surface.
 *
 * It checks the token the way the real routes do — `X-Automation-Token` or a
 * bearer — because the credential hop is one of the three this file exists to
 * exercise. Everything else it answers from a plain object the test controls.
 */
function startFakeApi(initial: SchedulerFullRead): FakeApi {
  let snapshot: SchedulerFullRead = structuredClone(initial);
  const turnovers: string[] = [];
  const events: { seq: number; kind: string; subjectId: string | null; sessionId: string | null; payload: Record<string, unknown> }[] = [];
  let seq = initial.cursor;

  const authorized = (req: Request): boolean => {
    const presented = req.headers.get("X-Automation-Token") ?? (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    return presented === TOKEN;
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!authorized(req)) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });

      if (url.pathname === ROUTES.swarm.scheduler.fullRead) {
        return Response.json({ ...snapshot, cursor: seq });
      }

      if (url.pathname === ROUTES.swarm.scheduler.subscribe) {
        const from = Number(url.searchParams.get("cursor"));
        if (!Number.isInteger(from)) return Response.json({ error: "cursor required" }, { status: 400 });
        let sent = from;
        let live = true;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            const send = (event: string, data: unknown): void => {
              if (!live) return;
              try {
                controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              } catch {
                live = false;
              }
            };
            void (async () => {
              while (live) {
                for (const e of events.filter((x) => x.seq > sent)) {
                  send("event", { ...e, committedAt: new Date().toISOString() });
                  sent = e.seq;
                }
                send("keepalive", { head: seq });
                await Bun.sleep(25);
              }
            })();
          },
          cancel() {
            live = false;
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }

      if (url.pathname === ROUTES.swarm.admin.epochTurnover && req.method === "POST") {
        const b = (await req.json()) as { subjectId: string; expectedSessionId: string };
        turnovers.push(b.expectedSessionId);
        return Response.json({
          ok: true,
          status: 200,
          subjectId: b.subjectId,
          closedSessionId: b.expectedSessionId,
          openedSessionId: `${b.expectedSessionId}-next`,
          windowClosesAt: new Date(Date.now() + 3_600_000).toISOString(),
          judgeMode: "off",
          replayed: false,
        });
      }

      if (url.pathname === ROUTES.swarm.admin.epochAggregate && req.method === "POST") {
        const b = (await req.json()) as { sessionId: string };
        return Response.json({ ok: true, status: 200, sessionId: b.sessionId, state: "aggregated", transitioned: true });
      }
      if (url.pathname === ROUTES.swarm.admin.epochRequestJudging && req.method === "POST") {
        return Response.json({ ok: false, status: 409, error: "judge_mode_off" }, { status: 409 });
      }
      if (url.pathname === ROUTES.swarm.admin.epochFinalize && req.method === "POST") {
        const b = (await req.json()) as { sessionId: string };
        return Response.json({ ok: true, status: 200, sessionId: b.sessionId, state: "published", outcome: "not_judged", replayed: false });
      }
      if (url.pathname === ROUTES.swarm.admin.epochOpen && req.method === "POST") {
        const b = (await req.json()) as { subjectId: string };
        return Response.json({
          ok: true,
          status: 201,
          subjectId: b.subjectId,
          sessionId: `${b.subjectId}-s1`,
          state: "collecting",
          windowClosesAt: new Date(Date.now() + 3_600_000).toISOString(),
          created: true,
        });
      }
      if (url.pathname === ROUTES.swarm.scheduler.jobAck) return Response.json({ known: true, acked: true });

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    turnovers,
    emit(kind, subjectId, sessionId, payload) {
      seq += 1;
      events.push({ seq, kind, subjectId, sessionId, payload });
    },
    get snapshot() {
      return snapshot;
    },
    set snapshot(next: SchedulerFullRead) {
      snapshot = next;
    },
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

const running: { stop(): void }[] = [];
afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/** Bring up a real scheduler over a real socket, the way the container does. */
async function bootScheduler(api: FakeApi): Promise<{ clock: SchedulerClock; health: HealthServer; healthUrl: string }> {
  const http = new SchedulerHttpApi({ apiUrl: api.url, token: TOKEN });
  const clock = new SchedulerClock(http, { timers: realTimers(), sleep: (ms) => Bun.sleep(ms) });
  const health = serveHealth(0, () => clock.health);
  running.push(health, { stop: () => { http.closeStream(); clock.stop(); } });

  const startup = await runStartupCheck({ apiUrl: api.url, token: TOKEN });
  clock.markAuthenticated(startup.tokenValid, startup.error ?? undefined);

  const consumer = new SchedulerStreamConsumer(http, {
    applyEvent: (e) => clock.applyEvent(e),
    onRebuild: (snap) => clock.rebuild(snap as unknown as SchedulerFullRead),
  });
  await consumer.start();
  await http.subscribeStream(consumer.cursor, (f) => consumer.receive(f), () => clock.markStreamSynchronized(false));
  clock.markStreamSynchronized(consumer.current);
  await clock.idle();

  return { clock, health, healthUrl: `http://127.0.0.1:${health.port}/health` };
}

describe("the scheduler's health endpoint, read the way smoke reads it", () => {
  test("a booted scheduler reports authenticated, synchronized and rebuilt, and readiness passes", async () => {
    const api = startFakeApi({
      subjects: [{ subjectId: "sub-a", name: "A", epochDurationSeconds: 3600 }],
      collecting: [{ sessionId: "s1", subjectId: "sub-a", windowClosesAt: iso(Date.now() + 3_600_000) }],
      settling: [],
      cursor: 0,
    });
    running.push(api);

    const { healthUrl } = await bootScheduler(api);

    const health = await fetchSchedulerHealth(healthUrl);
    expect(health).not.toBeNull();
    expect(health!.authenticated).toBe(true);
    expect(health!.streamSynchronized).toBe(true);
    expect(health!.initialRebuildComplete).toBe(true);
    expect(health!.exhausted).toEqual([]);
    expect(health!.timers.boundaries).toBe(1);

    const checks = evaluateSchedulerReadiness({
      health,
      activeSubjectIds: ["sub-a"],
      collectingSubjectIds: ["sub-a"],
    });
    expect(schedulerReadinessPassed(checks)).toBe(true);
  });

  test("a rejected token fails the startup check and readiness, over a real socket", async () => {
    const api = startFakeApi({ subjects: [], collecting: [], settling: [], cursor: 0 });
    running.push(api);

    const startup = await runStartupCheck({ apiUrl: api.url, token: "rmat_wrong" });
    expect(startup.apiReachable).toBe(true);
    expect(startup.tokenValid).toBe(false);
    expect(startup.error).toContain("403");
  });

  test("an unreachable API is reported as unreachable, not as a bad token", async () => {
    // Port 1 is reserved and refuses; a refused connect is the "API is down"
    // arm and must never be reported as an authentication failure.
    const startup = await runStartupCheck({ apiUrl: "http://127.0.0.1:1", token: TOKEN });
    expect(startup.apiReachable).toBe(false);
    expect(startup.tokenValid).toBe(false);
  });

  test("the health endpoint answers 503 while unhealthy, so a container healthcheck sees it", async () => {
    const api = startFakeApi({ subjects: [], collecting: [], settling: [], cursor: 0 });
    running.push(api);
    const http = new SchedulerHttpApi({ apiUrl: api.url, token: TOKEN });
    const clock = new SchedulerClock(http, { timers: realTimers() });
    const health = serveHealth(0, () => clock.health);
    running.push(health, { stop: () => clock.stop() });

    const res = await fetch(`http://127.0.0.1:${health.port}/health`);
    expect(res.status).toBe(503);
    // And the body is still served, because an unhealthy scheduler's whole
    // value is saying why.
    const body = (await res.json()) as { initialRebuildComplete: boolean };
    expect(body.initialRebuildComplete).toBe(false);
  });

  test("readiness fails when the health endpoint is not there at all", async () => {
    const health = await fetchSchedulerHealth("http://127.0.0.1:1/health");
    expect(health).toBeNull();
    const checks = evaluateSchedulerReadiness({ health, activeSubjectIds: [], collectingSubjectIds: [] });
    expect(schedulerReadinessPassed(checks)).toBe(false);
  });
});

describe("the SSE hop, which only a real socket exercises", () => {
  test("a real `text/event-stream` frame reaches the clock and moves its timer", async () => {
    const closesAt = Date.now() + 3_600_000;
    const api = startFakeApi({
      subjects: [{ subjectId: "sub-a", name: "A", epochDurationSeconds: 3600 }],
      collecting: [{ sessionId: "s1", subjectId: "sub-a", windowClosesAt: iso(closesAt) }],
      settling: [],
      cursor: 0,
    });
    running.push(api);
    const { clock } = await bootScheduler(api);
    expect(clock.boundaryAt("sub-a")).toBe(Date.parse(iso(closesAt)));

    // An OPERATOR turns the epoch over. The scheduler learns of it only by the
    // event, exactly as §4.3's last paragraph describes.
    const newCloses = Date.now() + 600_000;
    api.emit("epoch.turned_over", "sub-a", "s1", {
      closedSessionId: "s1",
      openedSessionId: "s2",
      windowClosesAt: iso(newCloses),
    });

    for (let i = 0; i < 60 && clock.boundaryAt("sub-a") !== Date.parse(iso(newCloses)); i += 1) {
      await Bun.sleep(25);
    }
    await clock.idle();

    expect(clock.boundaryAt("sub-a")).toBe(Date.parse(iso(newCloses)));
    // And it settled the closed epoch through to published, without ever
    // issuing a turnover of its own on top of the operator's.
    expect(api.turnovers).toEqual([]);
  });

  test("real keepalive frames keep the copy current and move nothing", async () => {
    const api = startFakeApi({
      subjects: [{ subjectId: "sub-a", name: "A", epochDurationSeconds: 3600 }],
      collecting: [{ sessionId: "s1", subjectId: "sub-a", windowClosesAt: iso(Date.now() + 3_600_000) }],
      settling: [],
      cursor: 0,
    });
    running.push(api);
    const http = new SchedulerHttpApi({ apiUrl: api.url, token: TOKEN });
    const clock = new SchedulerClock(http, { timers: realTimers() });
    running.push({ stop: () => { http.closeStream(); clock.stop(); } });
    const consumer = new SchedulerStreamConsumer(http, {
      applyEvent: (e) => clock.applyEvent(e),
      onRebuild: (s) => clock.rebuild(s as unknown as SchedulerFullRead),
    });
    await consumer.start();
    await http.subscribeStream(consumer.cursor, (f) => consumer.receive(f), () => {});

    // The fake sends a keepalive every 25ms and nothing else. Twenty of them
    // later the copy is still current and nothing has been applied — §10's
    // "transport keepalive frames are not API calls" on the real wire.
    const rebuildsBefore = consumer.rebuilds.length;
    await Bun.sleep(600);
    expect(consumer.current).toBe(true);
    expect(consumer.lastApplied).toBe(0);
    expect(consumer.rebuilds.length).toBe(rebuildsBefore);
  });

  test("an event emitted over the real wire is applied in order and moves lastApplied", async () => {
    const api = startFakeApi({
      subjects: [{ subjectId: "sub-a", name: "A", epochDurationSeconds: 3600 }],
      collecting: [{ sessionId: "s1", subjectId: "sub-a", windowClosesAt: iso(Date.now() + 3_600_000) }],
      settling: [],
      cursor: 0,
    });
    running.push(api);
    const http = new SchedulerHttpApi({ apiUrl: api.url, token: TOKEN });
    const clock = new SchedulerClock(http, { timers: realTimers() });
    running.push({ stop: () => { http.closeStream(); clock.stop(); } });
    const applied: number[] = [];
    const consumer = new SchedulerStreamConsumer(http, {
      applyEvent: async (e) => {
        applied.push(e.seq);
        await clock.applyEvent(e);
      },
      onRebuild: (s) => clock.rebuild(s as unknown as SchedulerFullRead),
    });
    await consumer.start();
    await http.subscribeStream(consumer.cursor, (f) => consumer.receive(f), () => {});

    api.emit("subject.changed", "sub-a", null, { reason: "updated", epochDurationSeconds: 60 });
    api.emit("subject.changed", "sub-a", null, { reason: "updated", epochDurationSeconds: 30 });

    for (let i = 0; i < 80 && applied.length < 2; i += 1) await Bun.sleep(25);
    await clock.idle();

    // In order, contiguous, and no rebuild was needed to get them — which is
    // what proves the SSE translation preserved the sequence numbers.
    expect(applied).toEqual([1, 2]);
    expect(consumer.lastApplied).toBe(2);
    expect(consumer.current).toBe(true);
    // §6.2: a duration change leaves the current window's instant alone.
    expect(clock.boundaryAt("sub-a")).toBe(Date.parse(iso(Date.parse(api.snapshot.collecting[0].windowClosesAt))));
  });
});
