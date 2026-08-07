// The analytics producer's Docker liveness signal (src/producer/index.ts;
// docker-compose.yml gives analytics-producer the same healthcheck as the
// lanes).
//
// WHY THIS SERVICE IS TESTED DIFFERENTLY FROM THE LANES
// A worker lane has a drain loop, so "completed a cycle" is a signal that falls
// out of the work. This process has no loop — it arms two crons that fire once a
// day. A heartbeat driven by its WORK would tick twice in twenty-four hours,
// which is not a liveness signal at any threshold, so what it reports instead is
// that both crons are still armed and that the REST gate it must submit through
// is answering. These cases pin every way that can go wrong, none of which can
// be provoked by waiting for a real 22:30 cron.
//
// Runs in the required backend-integration job.
import { afterEach, expect, test } from "bun:test";
import type { AnalyticsApiConfig } from "../src/analytics/api-client.ts";
import {
  armedScheduleSnapshot,
  checkArmedSchedules,
  resetProducerSchedules,
  runProducerLiveness,
  startProducerSchedules,
  type ProducerKind,
  type ScheduleState,
} from "../src/producer/index.ts";

afterEach(() => { resetProducerSchedules(); });

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const cfg: AnalyticsApiConfig = { baseUrl: "http://api:8787", token: "t" };

function schedules(entries: Partial<Record<ProducerKind, Partial<ScheduleState>>>): Map<ProducerKind, ScheduleState> {
  const map = new Map<ProducerKind, ScheduleState>();
  for (const [kind, state] of Object.entries(entries)) {
    map.set(kind as ProducerKind, { nextFireAt: NOW + HOUR, running: false, runningSince: 0, ...state });
  }
  return map;
}

test("both crons armed and waiting is progress, and the reason says when each is due", () => {
  const verdict = checkArmedSchedules(NOW, HOUR, schedules({
    regime: { nextFireAt: NOW + 600_000 },
    research: { nextFireAt: NOW + 1_200_000 },
  }));

  expect(verdict.ok).toBe(true);
  expect(verdict.reason).toContain("regime due in 600s");
  expect(verdict.reason).toContain("research due in 1200s");
});

test("a cron that was never armed — or that only half-armed — is not progress", () => {
  expect(checkArmedSchedules(NOW, HOUR, schedules({})).ok).toBe(false);
  // The half-armed case is the one a naive "is the process up?" probe misses
  // entirely: research would silently never run again.
  const half = checkArmedSchedules(NOW, HOUR, schedules({ regime: {} }));
  expect(half.ok).toBe(false);
  expect(half.reason).toContain("research cron is not armed");
});

test("a fire time that passed without the cron re-arming is a lost timer, not a wait", () => {
  const verdict = checkArmedSchedules(NOW, HOUR, schedules({
    regime: { nextFireAt: NOW - 600_000 }, // due 10 minutes ago, still not running
    research: {},
  }));

  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toContain("regime");
  expect(verdict.reason).toContain("never re-armed");
});

test("a fire time that has only just passed is timer dispatch latency, not a fault", () => {
  // The callback is not entered the instant the deadline passes. Reporting red
  // in that window would flap every night at 22:30.
  const verdict = checkArmedSchedules(NOW, HOUR, schedules({
    regime: { nextFireAt: NOW - 30_000 },
    research: {},
  }));

  expect(verdict.ok).toBe(true);
});

test("a run in flight is progress until it overruns its budget, then it is a stall", () => {
  const running = (elapsedMs: number) => checkArmedSchedules(NOW, HOUR, schedules({
    regime: { running: true, runningSince: NOW - elapsedMs },
    research: {},
  }));

  // A nightly research sweep is genuinely long (~200 EDGAR requests under rate
  // limiting); 50 minutes into a 1h budget is slow, not stuck.
  expect(running(50 * 60_000).ok).toBe(true);
  expect(running(50 * 60_000).reason).toContain("regime running 3000s");
  const stalled = running(2 * HOUR);
  expect(stalled.ok).toBe(false);
  expect(stalled.reason).toContain("stalled");
});

test("the loop records a heartbeat while the crons are armed and the API answers", async () => {
  const beats: Array<{ staleAfterMs: number; detail: string }> = [];

  await runProducerLiveness(cfg, {
    env: { PRODUCER_LIVENESS_TICK_MS: "30000" },
    schedules: schedules({ regime: {}, research: {} }),
    now: () => NOW,
    reachable: async () => true,
    sleep: async () => {},
    beat: async (rec) => { beats.push(rec); },
    ticks: 3,
  });

  expect(beats.length).toBe(3);
  // Four ticks of slack: a late tick must not flip the container red.
  expect(beats[0]!.staleAfterMs).toBe(120_000);
  expect(beats[0]!.detail).toContain("regime due in");
});

test("a stalled cron withholds the heartbeat — the container goes red even though the process is fine", async () => {
  const beats: unknown[] = [];

  await runProducerLiveness(cfg, {
    env: {},
    schedules: schedules({ regime: { running: true, runningSince: NOW - 6 * HOUR }, research: {} }),
    now: () => NOW,
    reachable: async () => true,
    sleep: async () => {},
    beat: async (rec) => { beats.push(rec); },
    ticks: 3,
  });

  // Nothing written: the heartbeat ages out and the healthcheck reports it.
  expect(beats.length).toBe(0);
});

test("a brief API outage is tolerated; a sustained one withholds the heartbeat", async () => {
  const beats: unknown[] = [];
  let tick = 0;
  // Down from the 2nd check onward. Tolerance is 3 consecutive failures, so
  // ticks 1-4 still beat (1 up, then 3 of grace) and ticks 5+ do not.
  const reachable = async () => ++tick <= 1;

  await runProducerLiveness(cfg, {
    env: { PRODUCER_LIVENESS_UNREACHABLE_TICKS: "3" },
    schedules: schedules({ regime: {}, research: {} }),
    now: () => NOW,
    reachable,
    sleep: async () => {},
    beat: async (rec) => { beats.push(rec); },
    ticks: 6,
  });

  // A rolling `api` restart must not paint this container red...
  expect(beats.length).toBe(3);
  // ...but a producer that has been unable to reach its ONLY submission channel
  // for several checks is not making progress, and says so.
});

// The two tests below exercise the REAL (un-stubbed) `reachable` default —
// every other case in this file injects `deps.reachable` directly, which
// means none of them would have caught apiReachable() probing the wrong
// endpoint. A real Bun.serve fixture (same style as
// producer-boundary.test.ts's "serve validates the credential" case) proves
// the ongoing liveness loop actually hits the authenticated
// /api/analytics/readiness gate — not the unauthenticated /health route,
// which would answer 200 the whole time regardless of the credential.
function readinessFixture(expectedToken: string): { server: ReturnType<typeof Bun.serve>; requests: string[] } {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname === "/api/analytics/readiness") {
        return req.headers.get("authorization") === `Bearer ${expectedToken}`
          ? Response.json({ ok: true, role: "analytics-provider" })
          : Response.json({ error: "analytics-provider role required" }, { status: 403 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, requests };
}

test("the real reachability probe hits the authenticated readiness gate and beats when the credential is accepted", async () => {
  const { server, requests } = readinessFixture("good-token");
  const beats: unknown[] = [];
  try {
    await runProducerLiveness(
      { baseUrl: `http://127.0.0.1:${server.port}`, token: "good-token" },
      {
        env: {},
        schedules: schedules({ regime: {}, research: {} }),
        now: () => NOW,
        sleep: async () => {},
        beat: async (rec) => { beats.push(rec); },
        ticks: 2,
      },
    );
  } finally {
    server.stop(true);
  }

  expect(requests).toContain("/api/analytics/readiness");
  expect(beats.length).toBe(2);
});

test("a credential rejected at the readiness gate withholds the heartbeat — even though the unauthenticated /health route is up the whole time", async () => {
  const { server, requests } = readinessFixture("good-token");
  const beats: unknown[] = [];
  try {
    await runProducerLiveness(
      { baseUrl: `http://127.0.0.1:${server.port}`, token: "wrong-token" },
      {
        // Tolerance 1: the very first rejected check already withholds the
        // beat, so this test doesn't need to wait out the default grace window.
        env: { PRODUCER_LIVENESS_UNREACHABLE_TICKS: "1" },
        schedules: schedules({ regime: {}, research: {} }),
        now: () => NOW,
        sleep: async () => {},
        beat: async (rec) => { beats.push(rec); },
        ticks: 2,
      },
    );
  } finally {
    server.stop(true);
  }

  // If apiReachable() were still probing /health, this would beat every tick:
  // /health answers 200 regardless of the (wrong) producer credential. Only a
  // readiness-gate probe reflects the rejection.
  expect(requests).toContain("/api/analytics/readiness");
  expect(requests).not.toContain("/health");
  expect(beats.length).toBe(0);
});

test("the real schedule() registers what the liveness check reads — the two cannot drift apart", async () => {
  // Goes through production startProducerSchedules with the REAL scheduler (only
  // the readiness wait is stubbed, so no network is touched), then judges the
  // crons it actually armed. afterEach disarms the timers.
  await startProducerSchedules({
    env: { PRODUCER_REGIME_CRON: "30 22 * * *", PRODUCER_RESEARCH_CRON: "0 23 * * *", ANALYTICS_TOKEN: "t" },
    waitUntilReady: async () => {},
  });

  const armed = armedScheduleSnapshot();
  expect([...armed.keys()].sort()).toEqual(["regime", "research"]);
  const verdict = checkArmedSchedules(Date.now(), HOUR, armed);
  expect(verdict.ok).toBe(true);
  for (const [kind, state] of armed) {
    expect(`${kind}:${state.nextFireAt > Date.now()}`).toBe(`${kind}:true`);
  }
});

test("disarming really does cancel the timers a test armed", () => {
  expect(armedScheduleSnapshot().size).toBe(0); // afterEach from the case above
});
