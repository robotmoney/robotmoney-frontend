// W4 part 3 — THE STARTUP CHECK, THE HEALTH SURFACE AND THE CREDENTIAL BOUNDARY
// (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §1, §4.6 and §7, and
// docs/technical/smoke-production-spec.md §3 and §6.3.
//
//   §7: `system-scheduler` "holds exactly one: an API credential … It signs
//    nothing … It never touches the database, so it has no role password. It
//    calls no model, so it has no model key. It holds no Docker socket."
//
//   smoke §6.3: "Scheduler readiness requires all of: the scheduler
//    authenticated to the API; its stream established and synchronized; its
//    initial rebuild complete …; and every active subject holding a
//    `collecting` session."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CREDENTIAL BOUNDARY IS A SOURCE-TEXT TEST
// ─────────────────────────────────────────────────────────────────────────────
//
// It has to be. A runtime test of "this process holds no database credential"
// can only observe what the process happens to read on the path the test takes.
// The failure mode that matters is an IMPORT: `backend/src/config.ts` requires
// `DATABASE_URL` at module scope, so a single import of it — direct or two hops
// away — turns a database credential into a startup requirement of a process
// that §7 says must never hold one, and no amount of exercising the happy path
// would show it.
//
// So the boundary is asserted over the module graph, statically, and the test
// plants a violation to prove the check can fail.
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  healthPayload,
  healthStatusCode,
  runStartupCheck,
} from "../../lib/system-scheduler/health.ts";
import { SchedulerClock } from "../../lib/system-scheduler/clock.ts";
import { FakeSchedulerApi, FakeTimers } from "./support/scheduler-harness.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const T0 = 1_800_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// The startup check (§1, §7)
// ─────────────────────────────────────────────────────────────────────────────

describe("the startup check is HTTP and nothing else", () => {
  test("an unreachable API reports not reachable, not authenticated, and a reason", async () => {
    const check = await runStartupCheck({
      apiUrl: "http://127.0.0.1:1",
      token: "rmat_whatever",
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(check.ok).toBe(false);
    expect(check.apiReachable).toBe(false);
    expect(check.tokenValid).toBe(false);
    expect(check.error).toContain("ECONNREFUSED");
  });

  test("a rejected token reports REACHABLE but not authenticated", async () => {
    // The two are reported separately on purpose: an operator who cannot tell
    // "the API is down" from "your token is wrong" fixes the wrong thing.
    const check = await runStartupCheck({
      apiUrl: "http://api",
      token: "rmat_stale",
      fetchImpl: async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    expect(check.ok).toBe(false);
    expect(check.apiReachable).toBe(true);
    expect(check.tokenValid).toBe(false);
    expect(check.error).toContain("403");
  });

  test("a 401 is treated the same as a 403", async () => {
    const check = await runStartupCheck({
      apiUrl: "http://api",
      token: "rmat_stale",
      fetchImpl: async () => new Response("{}", { status: 401 }),
    });
    expect(check.apiReachable).toBe(true);
    expect(check.tokenValid).toBe(false);
  });

  test("a 200 full read reports reachable and authenticated", async () => {
    const check = await runStartupCheck({
      apiUrl: "http://api",
      token: "rmat_good",
      fetchImpl: async (input) => {
        expect(String(input)).toContain("/api/swarm/scheduler/full-read");
        return new Response(JSON.stringify({ subjects: [], collecting: [], settling: [], cursor: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    expect(check.ok).toBe(true);
    expect(check.apiReachable).toBe(true);
    expect(check.tokenValid).toBe(true);
    expect(check.error).toBeNull();
  });

  test("the check presents the token, and presents no other credential", async () => {
    let seen: Headers | undefined;
    await runStartupCheck({
      apiUrl: "http://api",
      token: "rmat_good",
      fetchImpl: async (_input, init) => {
        seen = new Headers(init?.headers as HeadersInit);
        return new Response(JSON.stringify({ subjects: [], collecting: [], settling: [], cursor: 0 }), {
          status: 200,
        });
      },
    });
    expect(seen?.get("X-Automation-Token")).toBe("rmat_good");
    expect(seen?.get("X-Admin-Token")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The health surface (§4.6, smoke §6.3)
// ─────────────────────────────────────────────────────────────────────────────

function clockWith(): { api: FakeSchedulerApi; timers: FakeTimers; clock: SchedulerClock } {
  const timers = new FakeTimers(T0);
  const api = new FakeSchedulerApi({ now: () => timers.now() });
  const clock = new SchedulerClock(api, { timers, sleep: async () => {} });
  return { api, timers, clock };
}

describe("the health surface reports each of §6.3's requirements separately", () => {
  test("before any rebuild, nothing is claimed", () => {
    const { clock } = clockWith();
    const h = clock.health;
    expect(h.initialRebuildComplete).toBe(false);
    expect(h.streamSynchronized).toBe(false);
    expect(h.authenticated).toBe(false);
    expect(h.healthy).toBe(false);
  });

  test("after authentication, a synchronized stream and the first rebuild, it is healthy", async () => {
    const { api, clock } = clockWith();
    api.addSubject("sub-a", 600);
    clock.markAuthenticated(true);
    clock.markStreamSynchronized(true);
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    const h = clock.health;
    expect(h.authenticated).toBe(true);
    expect(h.streamSynchronized).toBe(true);
    expect(h.initialRebuildComplete).toBe(true);
    expect(h.exhausted).toHaveLength(0);
    expect(h.healthy).toBe(true);
  });

  test("a de-synchronized stream makes it unhealthy without losing the rebuild flag", async () => {
    const { api, clock } = clockWith();
    clock.markAuthenticated(true);
    clock.markStreamSynchronized(true);
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    clock.markStreamSynchronized(false);

    expect(clock.health.initialRebuildComplete).toBe(true);
    expect(clock.health.streamSynchronized).toBe(false);
    expect(clock.health.healthy).toBe(false);
  });

  test("a rejected token after re-provisioning makes the running scheduler unhealthy", async () => {
    const { api, clock } = clockWith();
    clock.markAuthenticated(true);
    clock.markStreamSynchronized(true);
    await clock.rebuild(await api.fullRead());
    await clock.idle();
    expect(clock.health.healthy).toBe(true);

    clock.markAuthenticated(false, "403 forbidden after re-provisioning");
    expect(clock.health.healthy).toBe(false);
    expect(clock.health.lastError).toContain("403");
  });

  test("exhausted work names its session, its subject and its last error", async () => {
    const { api, timers, clock } = clockWith();
    api.addSubject("sub-a", 600);
    api.addSession({ sessionId: "old", subjectId: "sub-a", state: "window_closed", judgeMode: "off" });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000 });
    api.failAlways("aggregate");
    const strict = new SchedulerClock(api, { timers, maxAttempts: 2, sleep: async () => {} });
    strict.markAuthenticated(true);
    strict.markStreamSynchronized(true);
    await strict.rebuild(await api.fullRead());
    await strict.idle();

    const h = strict.health;
    expect(h.healthy).toBe(false);
    expect(h.exhausted).toHaveLength(1);
    expect(h.exhausted[0]).toMatchObject({
      sessionId: "old",
      subjectId: "sub-a",
      lastError: "injected_dependency_down",
    });
    expect(h.exhausted[0].item).toContain("aggregate");
  });

  test("the payload is JSON-serializable and carries every field an operator needs", async () => {
    const { api, clock } = clockWith();
    api.addSubject("sub-a", 600);
    clock.markAuthenticated(true);
    clock.markStreamSynchronized(true);
    await clock.rebuild(await api.fullRead());
    await clock.idle();

    const body = JSON.parse(JSON.stringify(healthPayload(clock.health)));
    expect(Object.keys(body).sort()).toEqual(
      ["authenticated", "exhausted", "healthy", "initialRebuildComplete", "lastError", "streamSynchronized", "timers"].sort(),
    );
    expect(healthStatusCode(clock.health)).toBe(200);
  });

  test("an unhealthy scheduler answers 503, so a container healthcheck sees it", async () => {
    const { clock } = clockWith();
    expect(healthStatusCode(clock.health)).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The credential boundary (§7)
// ─────────────────────────────────────────────────────────────────────────────

const SCHEDULER_SOURCES = [
  "scripts/lib/system-scheduler/clock.ts",
  "scripts/lib/system-scheduler/health.ts",
  "scripts/lib/system-scheduler/api-client.ts",
  "scripts/lib/system-scheduler/stream-consumer.ts",
  "scripts/lib/system-scheduler/types.ts",
  "scripts/system-scheduler.ts",
];

/** Every import specifier in a source file, in order. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/(?:^|\n)\s*import[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("the scheduler holds exactly one kind of credential (§7)", () => {
  test("every module of the container exists", () => {
    for (const rel of SCHEDULER_SOURCES) {
      expect(existsSync(join(REPO, rel))).toBe(true);
    }
  });

  test("no module of the container imports anything under backend/", () => {
    // `backend/src/config.ts` requires DATABASE_URL at module scope, so ANY
    // path into backend/ risks making a database credential a startup
    // requirement. The rule is the whole directory, not that one file, because
    // a two-hop import is exactly how this would come back.
    for (const rel of SCHEDULER_SOURCES) {
      const text = readFileSync(join(REPO, rel), "utf8");
      const offenders = importsOf(text).filter((s) => s.includes("backend/"));
      expect({ rel, offenders }).toEqual({ rel, offenders: [] });
    }
  });

  test("the planted violation would be caught", () => {
    const planted = `import { config } from "../../backend/src/config.ts";\nexport const x = 1;\n`;
    expect(importsOf(planted).filter((s) => s.includes("backend/"))).toHaveLength(1);
  });

  test("no module names a database, signing, model or socket credential", () => {
    const forbidden = [
      "DATABASE_URL",
      "PGPASSWORD",
      "rm_app",
      "rm_owner",
      "OPENCODE_API_KEY",
      "RM_CREDENTIALS",
      "credential.json",
      "docker.sock",
    ];
    for (const rel of SCHEDULER_SOURCES) {
      const text = readFileSync(join(REPO, rel), "utf8");
      // Strip comments: §7 is quoted in several headers, and quoting the rule
      // is not breaking it.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "");
      for (const needle of forbidden) {
        expect({ rel, needle, found: code.includes(needle) }).toEqual({ rel, needle, found: false });
      }
    }
  });

  test("the image actually carries the entrypoint and its library", () => {
    // Caught during the removal: `backend/Dockerfile` copies only `backend/`,
    // so `command: ["bun","run","scripts/system-scheduler.ts"]` would have
    // exited immediately on a real `up`. Every compose test RENDERS config
    // rather than booting, so nothing else in the suite can see this.
    const dockerfile = readFileSync(join(REPO, "backend/Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY scripts/system-scheduler.ts /app/scripts/");
    expect(dockerfile).toContain("COPY scripts/lib/system-scheduler/ /app/scripts/lib/system-scheduler/");
  });

  test("it copies those two paths and NOT scripts/ wholesale", () => {
    // The rest of `scripts/` is operator tooling: it reaches Docker, reads
    // `~/.env`, and holds the smoke driver. A blanket copy would put the
    // deployment tooling inside the image it deploys.
    const dockerfile = readFileSync(join(REPO, "backend/Dockerfile"), "utf8");
    const code = dockerfile.replace(/(^|\n)\s*#.*/g, "$1");
    expect(code).not.toMatch(/COPY\s+scripts\/?\s+\/app/);
  });

  test("every path the entrypoint imports relatively is inside what the image copies", () => {
    // A new module under `scripts/lib/` that is NOT under `system-scheduler/`
    // would typecheck, pass every unit test, and be absent from the image.
    const text = readFileSync(join(REPO, "scripts/system-scheduler.ts"), "utf8");
    const relative = importsOf(text).filter((spec) => spec.startsWith("."));
    const outside = relative.filter((spec) => !spec.startsWith("./lib/system-scheduler/"));
    expect({ relative, outside }).toEqual({ relative, outside: [] });
  });

  test("the entrypoint reads its token from a file path, not from the environment directly", () => {
    // smoke §3: "a file the boot places in the instance's state directory, named
    // per instance, never in `~/.env` and never in the image."
    const text = readFileSync(join(REPO, "scripts/system-scheduler.ts"), "utf8");
    expect(text).toContain("SCHEDULER_TOKEN_FILE");
  });
});
