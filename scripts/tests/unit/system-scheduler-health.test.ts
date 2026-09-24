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
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  healthPayload,
  healthStatusCode,
  runStartupCheck,
} from "../../lib/system-scheduler/health.ts";
import { SchedulerClock } from "../../lib/system-scheduler/clock.ts";
import { SchedulerRuntime } from "../../lib/system-scheduler/runtime.ts";
import { drain, FakeSchedulerApi, FakeTimers } from "./support/scheduler-harness.ts";

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
    expect(check.tokenRejected).toBe(true);
  });

  test("a 5xx is reachable and unproven, but NOT a rejected token", async () => {
    // `main()` exits only on a rejection; a 5xx at boot is the ordinary
    // "the API is still coming up" case and must stay up.
    const check = await runStartupCheck({
      apiUrl: "http://api",
      token: "rmat_good",
      fetchImpl: async () => new Response("{}", { status: 503 }),
    });
    expect(check.apiReachable).toBe(true);
    expect(check.tokenValid).toBe(false);
    expect(check.tokenRejected).toBe(false);
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

  test("a token re-provisioned away makes the RUNNING scheduler unhealthy until it is restarted", async () => {
    // automation-token criterion: "after re-provisioning the old token is
    // rejected and the running scheduler is unhealthy until restarted." Nothing
    // here calls markAuthenticated by hand: the fake API starts refusing the
    // token, and the scheduler has to find that out from its own calls.
    const timers = new FakeTimers(T0);
    const api = new FakeSchedulerApi({ now: () => timers.now() });
    api.addSubject("sub-a", 600, true, { epochAnchorMs: T0 });
    api.addSession({ sessionId: "sa", subjectId: "sub-a", windowClosesAt: T0 + 600_000, judgeMode: "off" });
    const boot = async (): Promise<SchedulerRuntime> => {
      const rt = new SchedulerRuntime(api, { timers, probe: () => api.probe(), keepaliveBudgetMs: 30_000, watchdogMs: 5_000 });
      await rt.start();
      await rt.clock.idle();
      return rt;
    };
    const a = await boot();
    expect(a.clock.health.healthy).toBe(true);
    // A live stream up to just before the boundary.
    while (timers.now() < T0 + 590_000) {
      await timers.advanceBy(10_000);
      await api.keepalive();
    }
    expect(a.clock.health.healthy).toBe(true);

    // The operator re-provisions this instance's token. The open subscription
    // keeps delivering keepalives — the API-side close is a separate change —
    // so the stream alone would never notice.
    api.rotateToken();
    await timers.advanceTo(T0 + 600_000);
    await api.keepalive();
    await a.clock.idle();

    expect(api.resultsOf("turnover")).toEqual([]);
    expect(api.callsOf("turnover")[0].result).toMatchObject({ status: 403, transient: false });
    // Refused once, not retried: a rejected credential is not a transient.
    expect(api.countCalls("turnover")).toBe(1);
    expect(a.clock.health.authenticated).toBe(false);
    expect(a.clock.health.healthy).toBe(false);
    expect(a.clock.health.lastError).toContain("403");
    expect(healthStatusCode(a.clock.health)).toBe(503);

    // It STAYS unhealthy. Time passes, keepalives keep flowing, and even a
    // successful read (a rebuild's markAuthenticated(true)) does not clear it.
    for (let i = 0; i < 6; i += 1) {
      await timers.advanceBy(10_000);
      await api.keepalive();
    }
    a.clock.markAuthenticated(true);
    expect(a.clock.health.healthy).toBe(false);

    // A forced rebuild against the rotated token fails too, and the reconnect
    // loop's probe names the rejection rather than an outage.
    api.commitEvent();
    await api.keepalive();
    await timers.advanceBy(1_000);
    await drain();
    expect(a.clock.health.healthy).toBe(false);
    expect(a.clock.health.lastError).toContain("rejected");
    a.stop();

    // THE RESTART: a new process that has read the re-provisioned token file.
    api.adoptNewToken();
    const b = await boot();
    expect(b.clock.health.authenticated).toBe(true);
    expect(b.clock.health.healthy).toBe(true);
    b.stop();
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
  "scripts/lib/system-scheduler/runtime.ts",
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

  test("every module the entrypoint reaches is on the credential-boundary list above", () => {
    // SCHEDULER_SOURCES is only as good as its coverage: a new module the
    // entrypoint imports, absent from the list, would be exempt from both
    // checks above. Walk the relative imports from the entrypoint and demand
    // every file reached is listed.
    const seen = new Set<string>();
    const walk = (rel: string): void => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const text = readFileSync(join(REPO, rel), "utf8");
      const dir = rel.slice(0, rel.lastIndexOf("/"));
      for (const spec of importsOf(text).filter((x) => x.startsWith("."))) {
        walk(join(dir, spec));
      }
    };
    walk("scripts/system-scheduler.ts");
    expect([...seen].sort()).toEqual([...SCHEDULER_SOURCES].sort());
  });

  test("the entrypoint reads its token from a file path, not from the environment directly", () => {
    // smoke §3: "a file the boot places in the instance's state directory, named
    // per instance, never in `~/.env` and never in the image."
    const text = readFileSync(join(REPO, "scripts/system-scheduler.ts"), "utf8");
    expect(text).toContain("SCHEDULER_TOKEN_FILE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// main(), executed (§1, §7)
// ─────────────────────────────────────────────────────────────────────────────
//
// The startup decision — exit on a rejected token, stay up unhealthy on an
// unreachable API — lives in `main()`, and until now it was only ever read as
// text. These run the real entrypoint as a process, exactly as the container's
// `command` does, against a stub API served on a loopback port. The stub is
// the API's scheduler surface in miniature: evidence about `main()`, not about
// the real API.

const ENTRYPOINT = join(REPO, "scripts/system-scheduler.ts");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tokenFile(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-scheduler-main-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "automation-token");
  writeFileSync(path, `${token}\n`);
  return path;
}

function spawnScheduler(env: Record<string, string>) {
  const child = Bun.spawn(["bun", "run", ENTRYPOINT], {
    cwd: REPO,
    // A clean environment: nothing inherited, so no DATABASE_URL or model key
    // could be what makes this pass.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  return child;
}

/**
 * Read a child's stdout ONCE, into one buffer, for the whole test.
 *
 * Not a read-until-match per call. Two lines the child writes back to back can
 * arrive in a single chunk, and a per-call reader that stops at its match
 * throws away the rest of that chunk — so a second wait for the second line
 * would time out on a loaded host even though the line was printed. Here one
 * pump owns the stream, every wait searches everything read so far, and a
 * line can be waited for in any order, any number of times.
 */
function watchStdout(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let seen = "";
  let ended = false;
  const wakers = new Set<() => void>();
  const wake = (): void => {
    for (const w of [...wakers]) w();
  };
  void (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
        wake();
      }
    } catch {
      /* the child was killed mid-read */
    } finally {
      ended = true;
      wake();
    }
  })();

  return {
    /** Resolve with the first match of `pattern` in everything read so far, or fail after `ms`. */
    async waitFor(pattern: RegExp, ms = 15_000): Promise<RegExpMatchArray> {
      const deadline = Date.now() + ms;
      for (;;) {
        const m = seen.match(pattern);
        if (m) return m;
        const left = deadline - Date.now();
        if (ended || left <= 0) throw new Error(`no line matching ${pattern} in: ${seen}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, left);
          function done(): void {
            clearTimeout(timer);
            wakers.delete(done);
            resolve();
          }
          wakers.add(done);
        });
      }
    },
  };
}

describe("main() executed against a stub API", () => {
  test("the stdout watcher finds two lines that arrived in ONE chunk, in either order", async () => {
    // The flake this pins: a late reader got both startup lines in a single
    // chunk, the first wait consumed both, and the second timed out.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("health on :4321/health\nstartup check: API unreachable: refused\n"));
      },
    });
    const stdout = watchStdout(stream);
    const [, port] = await stdout.waitFor(/health on :(\d+)\/health/, 2_000);
    expect(port).toBe("4321");
    await stdout.waitFor(/startup check: API unreachable/, 2_000);
    await stdout.waitFor(/health on :/, 2_000);
  });

  test("a REJECTED token exits 1, naming the rejection", async () => {
    let fullReads = 0;
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/api/swarm/scheduler/full-read") fullReads += 1;
        return Response.json({ error: "automation_token_rejected" }, { status: 403 });
      },
    });
    cleanups.push(() => stub.stop(true));

    const child = spawnScheduler({
      SCHEDULER_API_URL: `http://127.0.0.1:${stub.port}`,
      SCHEDULER_TOKEN_FILE: tokenFile("rmat_revoked"),
      SCHEDULER_HEALTH_PORT: "0",
    });
    const code = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(code).toBe(1);
    expect(stderr).toContain("the API rejected this automation token");
    expect(stderr).toContain("403");
    // It asked with the token, once, and did not go on to subscribe.
    expect(fullReads).toBe(1);
  }, 30_000);

  test("an UNREACHABLE API stays up and answers 503 on health, with the reason", async () => {
    // Port 1 refuses. The process must not exit: this is the ordinary boot
    // race between `api` and the scheduler.
    const child = spawnScheduler({
      SCHEDULER_API_URL: "http://127.0.0.1:1",
      SCHEDULER_TOKEN_FILE: tokenFile("rmat_fine"),
      SCHEDULER_HEALTH_PORT: "0",
    });
    const stdout = watchStdout(child.stdout);
    const [, port] = await stdout.waitFor(/health on :(\d+)\/health/);
    await stdout.waitFor(/startup check: API unreachable/);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { authenticated: boolean; streamSynchronized: boolean; healthy: boolean; lastError: string | null };
    expect(body.healthy).toBe(false);
    expect(body.authenticated).toBe(false);
    expect(body.streamSynchronized).toBe(false);
    expect(body.lastError).toContain("unreachable");

    // Still running after the startup check has come and gone.
    await Bun.sleep(300);
    expect(child.exitCode).toBeNull();

    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  }, 30_000);

  test("a missing token file exits 2 before serving anything, naming the file", async () => {
    const child = spawnScheduler({
      SCHEDULER_API_URL: "http://127.0.0.1:1",
      SCHEDULER_TOKEN_FILE: "/nonexistent/automation-token",
      SCHEDULER_HEALTH_PORT: "0",
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain(
      "automation token file not found: /nonexistent/automation-token",
    );
  }, 30_000);
});
