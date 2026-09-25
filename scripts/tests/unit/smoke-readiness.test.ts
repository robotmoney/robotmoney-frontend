// W4 part 3 — SMOKE'S READINESS GATE ON THE SCHEDULER (issue #1026).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.3.
//
//   "Scheduler readiness requires all of: the scheduler authenticated to the
//    API; its stream established and synchronized (scheduler spec §3.1); its
//    initial rebuild complete, meaning timers reconstructed and recoverable
//    work resumed, not that any settlement has finished; and every active
//    subject holding a `collecting` session. A scheduler reporting exhausted
//    work (scheduler spec §4.6) is not ready. `collecting` rows alone establish
//    nothing, since an exhausted turnover leaves such a row in place. …
//    Recovery from exhausted work is a restart of that instance's scheduler
//    container … after the failing dependency is back; smoke never restarts it
//    on its own."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FAKE HERE IS TYPED IDENTICALLY TO THE REAL HANDLER
// ─────────────────────────────────────────────────────────────────────────────
//
// The issue's own criterion asks for it: "This gates smoke's consumption
// against a fake typed identically to the real handler." So the fake below is
// built by calling the REAL `healthPayload()` over a real `SchedulerHealth`,
// not by hand-writing a JSON object that happens to have the right keys. A
// renamed field on the producing side breaks this file, which is the point — a
// hand-written fixture would keep passing while smoke read `undefined` and
// treated it as false, or worse, as absent-and-therefore-fine.
//
// THE WHOLE GATE (§6.3 "Other services' readiness", D52, criterion 41) is
// graded here too: api /health, the pipeline worker's startup checks, the
// producer's authentication and seed command, each a named result, and the
// wait that ends at once on a failure no wait can fix. `bun smoke` consumes it
// through scripts/lib/smoke-readiness-probes.ts (the reads) and this module
// (the verdict); the wiring and the no-restart property of the REAL readiness
// path are asserted at the bottom, over the probes' command runner. The runtime
// proof — the real scheduler container over real sockets, and a real boot's
// receipt — is scripts/tests/integration/smoke-readiness-scheduler.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { healthPayload } from "../../lib/system-scheduler/health.ts";
import type { SchedulerHealth } from "../../lib/system-scheduler/types.ts";
import {
  awaitReadiness,
  evaluateReadiness,
  evaluateSchedulerReadiness,
  fetchSchedulerHealth,
  lastStartupPreflightLine,
  parseStartupPreflightLine,
  READINESS_CHECKS,
  schedulerReadinessPassed,
  SCHEDULER_READINESS_CHECKS,
  SERVICE_READINESS_CHECKS,
  terminalReadinessFailure,
  type ReadinessObservation,
} from "../../lib/smoke-readiness-scheduler.ts";
import { makeReadinessObserver, READ_ONLY_DOCKER_SUBCOMMANDS, readOnlyRunner, type ProbeRunner } from "../../lib/smoke-readiness-probes.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

/** A healthy `SchedulerHealth`, then serialized by the REAL producer. */
function health(over: Partial<SchedulerHealth> = {}): ReturnType<typeof healthPayload> {
  const base: SchedulerHealth = {
    authenticated: true,
    streamSynchronized: true,
    initialRebuildComplete: true,
    exhausted: [],
    healthy: true,
    lastError: null,
    timers: { boundaries: 1, deadlines: 0 },
    ...over,
  };
  // `healthy` is derived, so recompute it rather than trusting the override.
  base.healthy =
    base.authenticated && base.streamSynchronized && base.initialRebuildComplete && base.exhausted.length === 0;
  return healthPayload(base);
}

const pass = (checks: { check: string; pass: boolean }[], name: string): boolean =>
  checks.find((c) => c.check === name)?.pass ?? false;

describe("readiness passes only on all of §6.3", () => {
  test("everything holding passes", () => {
    const checks = evaluateSchedulerReadiness({
      health: health(),
      activeSubjectIds: ["sub-a", "sub-b"],
      collectingSubjectIds: ["sub-a", "sub-b"],
    });
    expect(schedulerReadinessPassed(checks)).toBe(true);
    for (const name of SCHEDULER_READINESS_CHECKS) expect(pass(checks, name)).toBe(true);
  });

  test("every check named in §6.3 is present, and there are no others", () => {
    const checks = evaluateSchedulerReadiness({
      health: health(),
      activeSubjectIds: [],
      collectingSubjectIds: [],
    });
    expect(checks.map((c) => c.check).sort()).toEqual([...SCHEDULER_READINESS_CHECKS].sort());
  });

  test("not authenticated fails, naming the reason", () => {
    const checks = evaluateSchedulerReadiness({
      health: health({ authenticated: false, lastError: "403 forbidden" }),
      activeSubjectIds: ["sub-a"],
      collectingSubjectIds: ["sub-a"],
    });
    expect(schedulerReadinessPassed(checks)).toBe(false);
    expect(pass(checks, "scheduler-authenticated")).toBe(false);
    expect(checks.find((c) => c.check === "scheduler-authenticated")!.detail).toContain("403");
  });

  test("an unsynchronized stream fails", () => {
    const checks = evaluateSchedulerReadiness({
      health: health({ streamSynchronized: false }),
      activeSubjectIds: ["sub-a"],
      collectingSubjectIds: ["sub-a"],
    });
    expect(schedulerReadinessPassed(checks)).toBe(false);
    expect(pass(checks, "scheduler-stream-synchronized")).toBe(false);
  });

  test("an incomplete initial rebuild fails", () => {
    const checks = evaluateSchedulerReadiness({
      health: health({ initialRebuildComplete: false }),
      activeSubjectIds: ["sub-a"],
      collectingSubjectIds: ["sub-a"],
    });
    expect(schedulerReadinessPassed(checks)).toBe(false);
    expect(pass(checks, "scheduler-initial-rebuild")).toBe(false);
  });

  test("an unreachable health endpoint fails every scheduler check rather than passing by omission", () => {
    const checks = evaluateSchedulerReadiness({
      health: null,
      activeSubjectIds: ["sub-a"],
      collectingSubjectIds: ["sub-a"],
    });
    expect(schedulerReadinessPassed(checks)).toBe(false);
    expect(pass(checks, "scheduler-authenticated")).toBe(false);
    expect(pass(checks, "scheduler-stream-synchronized")).toBe(false);
    expect(pass(checks, "scheduler-initial-rebuild")).toBe(false);
    expect(pass(checks, "scheduler-no-exhausted-work")).toBe(false);
  });
});

describe("collecting rows alone do not pass (§6.3)", () => {
  test("a collecting row per active subject, with an exhausted turnover, FAILS", () => {
    // This is §6.3's stated reason the epoch check cannot stand alone: an
    // exhausted turnover leaves the collecting row exactly where it was.
    const checks = evaluateSchedulerReadiness({
      health: health({
        exhausted: [
          {
            item: "turnover:sub-a",
            subjectId: "sub-a",
            lastError: "503 upstream unavailable",
            attempts: 5,
            exhaustedAtMs: 1_800_000_000_000,
          },
        ],
      }),
      activeSubjectIds: ["sub-a"],
      collectingSubjectIds: ["sub-a"],
    });

    expect(pass(checks, "epoch-per-active-subject")).toBe(true);
    expect(pass(checks, "scheduler-no-exhausted-work")).toBe(false);
    expect(schedulerReadinessPassed(checks)).toBe(false);
  });

  test("the exhausted detail names the item, its subject or session, and the last error", () => {
    const checks = evaluateSchedulerReadiness({
      health: health({
        exhausted: [
          {
            item: "aggregate:s77",
            sessionId: "s77",
            subjectId: "sub-b",
            lastError: "connection reset",
            attempts: 5,
            exhaustedAtMs: 1_800_000_000_000,
          },
        ],
      }),
      activeSubjectIds: ["sub-b"],
      collectingSubjectIds: ["sub-b"],
    });
    const detail = checks.find((c) => c.check === "scheduler-no-exhausted-work")!.detail;
    expect(detail).toContain("aggregate:s77");
    expect(detail).toContain("s77");
    expect(detail).toContain("sub-b");
    expect(detail).toContain("connection reset");
  });

  test("a healthy scheduler with an active subject holding NO collecting session fails", () => {
    const checks = evaluateSchedulerReadiness({
      health: health(),
      activeSubjectIds: ["sub-a", "sub-b"],
      collectingSubjectIds: ["sub-a"],
    });
    expect(pass(checks, "epoch-per-active-subject")).toBe(false);
    expect(checks.find((c) => c.check === "epoch-per-active-subject")!.detail).toContain("sub-b");
    expect(schedulerReadinessPassed(checks)).toBe(false);
  });

  test("no active subjects is a pass, not a vacuous failure", () => {
    const checks = evaluateSchedulerReadiness({
      health: health(),
      activeSubjectIds: [],
      collectingSubjectIds: [],
    });
    expect(pass(checks, "epoch-per-active-subject")).toBe(true);
    expect(schedulerReadinessPassed(checks)).toBe(true);
  });
});

describe("a waiting or no-consensus session is not a health failure (§6.3)", () => {
  test("deadline timers held are reported but do not fail readiness", () => {
    const checks = evaluateSchedulerReadiness({
      health: health({ timers: { boundaries: 2, deadlines: 3 } }),
      activeSubjectIds: ["sub-a"],
      collectingSubjectIds: ["sub-a"],
    });
    expect(schedulerReadinessPassed(checks)).toBe(true);
  });
});

describe("the fake is typed identically to the real handler", () => {
  test("the readiness input accepts exactly what healthPayload produces", async () => {
    const payload = health();
    const served = await fetchSchedulerHealth("http://scheduler:8080/health", async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    expect(served).toEqual(payload);
    const checks = evaluateSchedulerReadiness({
      health: served,
      activeSubjectIds: [],
      collectingSubjectIds: [],
    });
    expect(schedulerReadinessPassed(checks)).toBe(true);
  });

  test("a 503 body is still parsed, because an unhealthy scheduler still reports WHY", async () => {
    const payload = health({ authenticated: false, lastError: "token rejected" });
    const served = await fetchSchedulerHealth("http://scheduler:8080/health", async () =>
      new Response(JSON.stringify(payload), { status: 503 }),
    );
    expect(served).not.toBeNull();
    expect(served!.authenticated).toBe(false);
    expect(served!.lastError).toBe("token rejected");
  });

  test("an unparseable body is null, not a half-read object treated as healthy", async () => {
    const served = await fetchSchedulerHealth("http://scheduler:8080/health", async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );
    expect(served).toBeNull();
  });

  test("a transport failure is null", async () => {
    const served = await fetchSchedulerHealth("http://scheduler:8080/health", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(served).toBeNull();
  });
});

describe("smoke never restarts the scheduler container (§6.3)", () => {
  test("the readiness module runs no command at all, so it cannot restart anything", () => {
    // The assertion is on EXECUTION, not on the word: the module's detail
    // string tells the operator to restart the container, which is §6.3's
    // intent — the recovery is theirs. What it must not do is act.
    const text = readFileSync(join(REPO, "scripts/lib/smoke-readiness-scheduler.ts"), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "");
    for (const runner of ["docker", "Bun.spawn", "Bun.$", "child_process", "execFile", "spawnSync"]) {
      expect({ runner, found: code.includes(runner) }).toEqual({ runner, found: false });
    }
  });

  test("the exhausted detail tells the operator the restart is theirs", () => {
    const checks = evaluateSchedulerReadiness({
      health: health({
        exhausted: [
          { item: "turnover:sub-a", subjectId: "sub-a", lastError: "503", attempts: 5, exhaustedAtMs: 0 },
        ],
      }),
      activeSubjectIds: ["sub-a"],
      collectingSubjectIds: ["sub-a"],
    });
    expect(checks.find((c) => c.check === "scheduler-no-exhausted-work")!.detail).toContain("restart");
  });

  test("the module states the recovery path is the operator's, so the omission is deliberate", () => {
    const text = readFileSync(join(REPO, "scripts/lib/smoke-readiness-scheduler.ts"), "utf8");
    expect(text).toContain("operator");
    expect(text).toContain("§6.3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole gate: §6.3 "Other services' readiness" (criterion 41)
// ─────────────────────────────────────────────────────────────────────────────

/** An observation where everything holds; each case breaks one thing. */
function allGood(over: Partial<ReadinessObservation> = {}): ReadinessObservation {
  return {
    apiHealth: { ok: true, detail: "http://127.0.0.1:1/health answered 200" },
    scheduler: health(),
    subjects: { active: ["woon"], collecting: ["woon"] },
    workers: [
      { service: "worker-analytics", health: "healthy", line: { kind: "passed" } },
      { service: "worker-research", health: "healthy", line: { kind: "passed" } },
    ],
    producer: { health: "healthy", detail: "authenticated gate answered" },
    seed: { completed: true, detail: "exited 0" },
    ...over,
  };
}

const passOf = (checks: { check: string; pass: boolean }[], name: string) => checks.find((c) => c.check === name)?.pass;

describe("readiness is every §6.3 condition, each a named result for the receipt", () => {
  test("the named checks are exactly the four service checks and the five scheduler checks", () => {
    expect([...READINESS_CHECKS]).toEqual([...SERVICE_READINESS_CHECKS, ...SCHEDULER_READINESS_CHECKS]);
    expect([...SERVICE_READINESS_CHECKS]).toEqual(["api-health", "pipeline-worker-startup", "analytics-producer-authenticated", "analytics-producer-seed"]);
    const checks = evaluateReadiness(allGood());
    expect(checks.map((c) => c.check)).toEqual([...READINESS_CHECKS]);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  test("each condition failing alone fails readiness under its own name", () => {
    const cases: [Partial<ReadinessObservation>, string][] = [
      [{ apiHealth: { ok: false, detail: "answered 503" } }, "api-health"],
      [{ workers: [{ service: "worker-analytics", health: "starting", line: null }] }, "pipeline-worker-startup"],
      [{ workers: [{ service: "worker-analytics", health: "unhealthy", line: { kind: "refused", detail: "check 2: rm_worker holds DELETE" } }] }, "pipeline-worker-startup"],
      [{ workers: [] }, "pipeline-worker-startup"],
      [{ producer: { health: "unhealthy", detail: "401" } }, "analytics-producer-authenticated"],
      [{ seed: { completed: false, detail: "exit 1" } }, "analytics-producer-seed"],
      [{ scheduler: null }, "scheduler-authenticated"],
      [{ subjects: null }, "epoch-per-active-subject"],
    ];
    for (const [over, name] of cases) {
      const checks = evaluateReadiness(allGood(over));
      expect({ name, pass: passOf(checks, name) }).toEqual({ name, pass: false });
      expect(checks.filter((c) => !c.pass).length).toBeGreaterThan(0);
    }
  });

  test("a worker's startup checks pass only on its `startup_preflight: passed` line AND a healthy container", () => {
    // §7.2 as agreed with the worker: no heartbeat until checks 1-3 pass, so a
    // healthy container with no line yet, or a line with no health, is not yet.
    expect(passOf(evaluateReadiness(allGood({ workers: [{ service: "w", health: "healthy", line: null }] })), "pipeline-worker-startup")).toBe(false);
    expect(passOf(evaluateReadiness(allGood({ workers: [{ service: "w", health: "starting", line: { kind: "passed" } }] })), "pipeline-worker-startup")).toBe(false);
  });

  test("the worker's two lines parse exactly; anything else is not a startup verdict", () => {
    expect(parseStartupPreflightLine("startup_preflight: passed")).toEqual({ kind: "passed" });
    expect(parseStartupPreflightLine("2026-09-25 worker-1 | startup_preflight: refused check 2: rm_worker holds DELETE on runs")).toEqual({
      kind: "refused",
      detail: "check 2: rm_worker holds DELETE on runs",
    });
    expect(parseStartupPreflightLine("startup_preflight passed")).toBeNull();
    expect(lastStartupPreflightLine("boot\nstartup_preflight: refused check 1: bad password\nretry\nstartup_preflight: passed\n")).toEqual({ kind: "passed" });
    expect(lastStartupPreflightLine("nothing yet\n")).toBeNull();
  });
});

describe("the wait: every check or a failure no wait can fix, and nothing in between", () => {
  const clock = () => {
    let now = 0;
    return { now: () => now, sleep: async (ms: number) => void (now += ms) };
  };

  test("it waits for a slow condition and passes when everything holds", async () => {
    const c = clock();
    let polls = 0;
    const verdict = await awaitReadiness(async () => (++polls < 3 ? allGood({ subjects: { active: ["woon"], collecting: [] } }) : allGood()), {
      timeoutMs: 60_000, pollMs: 5_000, now: c.now, sleep: c.sleep,
    });
    expect(verdict.passed).toBe(true);
    expect(polls).toBe(3);
  });

  test("exhausted work ends the wait AT ONCE and fails, naming the operator's restart — no retry, no restart", async () => {
    const c = clock();
    let polls = 0;
    const exhausted = health({ exhausted: [{ item: "turnover:woon", subjectId: "woon", lastError: "503", attempts: 5, exhaustedAtMs: 0 }] });
    const verdict = await awaitReadiness(async () => {
      polls++;
      return allGood({ scheduler: exhausted });
    }, { timeoutMs: 60_000, pollMs: 5_000, now: c.now, sleep: c.sleep });
    expect(verdict.passed).toBe(false);
    expect(polls).toBe(1);
    expect(verdict.reason).toContain("restart the instance's system-scheduler");
    // `collecting` rows alone establish nothing: the epoch check itself passed.
    expect(passOf(verdict.checks, "epoch-per-active-subject")).toBe(true);
  });

  test("a rejected scheduler token, a refused worker and a failed seed are terminal too", () => {
    expect(terminalReadinessFailure(allGood({ scheduler: health({ authenticated: false, lastError: "API rejected the automation token (HTTP 401)" }) }))).toContain("re-provision");
    expect(terminalReadinessFailure(allGood({ workers: [{ service: "worker-analytics", health: "unhealthy", line: { kind: "refused", detail: "check 3: in_progress" } }] }))).toContain("worker-analytics refused its startup checks");
    expect(terminalReadinessFailure(allGood({ seed: { completed: false, detail: "exit 1" } }))).toContain("seed command did not complete");
    // An unreachable API is NOT terminal: the scheduler's connect loop brings it in.
    expect(terminalReadinessFailure(allGood({ scheduler: health({ authenticated: false, lastError: "API unreachable" }) }))).toBeNull();
  });

  test("the deadline fails with every check still failing named", async () => {
    const c = clock();
    const verdict = await awaitReadiness(async () => allGood({ apiHealth: { ok: false, detail: "answered 502" } }), {
      timeoutMs: 20_000, pollMs: 5_000, now: c.now, sleep: c.sleep,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("api-health (answered 502)");
  });
});

describe("the REAL readiness path issues read-only docker commands only — smoke never restarts a container (§6.3)", () => {
  /** A runner that answers like a daemon with every service healthy, and records every argv. */
  function recordingRunner(seen: string[][], over: { restartTried?: boolean } = {}): ProbeRunner {
    return (args) => {
      seen.push([...args]);
      if (args.includes("port")) return { exitCode: 0, stdout: "127.0.0.1:41999\n", stderr: "" };
      if (args[0] === "ps") return { exitCode: 0, stdout: `${args.find((a) => a.startsWith("label=com.docker.compose.service="))!.split("=").at(-1)}-id\n`, stderr: "" };
      if (args[0] === "inspect") return { exitCode: 0, stdout: "healthy\n", stderr: "" };
      if (args[0] === "logs") return { exitCode: 0, stdout: "startup_preflight: passed\n", stderr: "" };
      if (over.restartTried !== undefined) over.restartTried = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  }
  const exhausted = healthPayload({
    authenticated: true, streamSynchronized: true, initialRebuildComplete: true, healthy: false, lastError: "turnover exhausted",
    exhausted: [{ item: "turnover:woon", subjectId: "woon", lastError: "503", attempts: 5, exhaustedAtMs: 0 }],
    timers: { boundaries: 1, deadlines: 0 },
  });
  const fakeFetch = (schedulerBody: unknown) => (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/health") && u.includes(":41999")) return new Response(JSON.stringify(schedulerBody), { status: 503 });
    if (u.includes("/api/swarm/admin/subjects")) return new Response(JSON.stringify({ subjects: [{ id: "woon", status: "active" }] }));
    if (u.includes("/api/swarm/sessions")) return new Response(JSON.stringify({ sessions: [{ subjectId: "woon", state: "collecting" }] }));
    return new Response("ok");
  }) as typeof fetch;

  test("with exhausted work, readiness fails through the real observer and every docker argv was a read", async () => {
    const seen: string[][] = [];
    const observe = makeReadinessObserver({
      project: "rm_smoke_stack_x",
      composePrefix: ["compose", "--env-file", "/dev/null", "-p", "rm_smoke_stack_x", "-f", "docker-compose.yml"],
      apiUrl: "http://127.0.0.1:41998",
      operatorToken: "rmat_operator",
      workerServices: ["worker-analytics"],
      producerService: "analytics-producer",
      schedulerService: "system-scheduler",
      seed: () => ({ completed: true, detail: "exited 0" }),
      run: recordingRunner(seen),
      fetchImpl: fakeFetch(exhausted),
    });
    const verdict = await awaitReadiness(observe, { timeoutMs: 60_000, pollMs: 1, sleep: async () => {} });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("exhausted work");
    expect(seen.length).toBeGreaterThan(0);
    for (const argv of seen) {
      const sub = argv[0] === "compose" ? `compose ${argv.find((a, i) => i > 0 && !a.startsWith("-") && !["-p", "-f", "--env-file"].includes(argv[i - 1]!))}` : argv[0];
      expect({ argv: argv.join(" "), read: (READ_ONLY_DOCKER_SUBCOMMANDS as readonly string[]).includes(sub!) }).toEqual({ argv: argv.join(" "), read: true });
      expect(argv).not.toContain("restart");
    }
  });

  test("red control: the guard refuses a restart, stop or up before it reaches the daemon, and passes a read", () => {
    const reached: string[] = [];
    const run = readOnlyRunner((args) => {
      reached.push(args.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    for (const argv of [["restart", "rm_x-system-scheduler-1"], ["compose", "-p", "p", "restart", "system-scheduler"], ["compose", "-p", "p", "up", "-d"], ["stop", "c"]]) {
      expect(() => run(argv)).toThrow("read-only docker commands only");
    }
    expect(reached).toEqual([]);
    run(["compose", "--env-file", "/dev/null", "-p", "p", "port", "system-scheduler", "8090"]);
    run(["inspect", "c"]);
    expect(reached.length).toBe(2);
    // …and the probes module spells no mutating subcommand at all.
    const src = readFileSync(join(REPO, "scripts/lib/smoke-readiness-probes.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "");
    expect(code).not.toMatch(/["'](restart|stop|kill|rm|up|start)["']/);
  });

  test("smoke-main's readiness path is this observer and this gate, and names no restart", () => {
    const smokeMain = readFileSync(join(REPO, "scripts/lib/smoke-main.ts"), "utf8");
    const at = smokeMain.indexOf("const observeReadiness = makeReadinessObserver(");
    expect(at).toBeGreaterThan(-1);
    expect(smokeMain.indexOf("await awaitReadiness(observeReadiness", at)).toBeGreaterThan(at);
    // The receipt's readiness is the gate's checks, not a fixed list.
    expect(smokeMain).toContain("const readiness = verdict.checks;");
    expect(smokeMain).toContain("if (!verdict.passed) throw new Error(`readiness failed: ${verdict.reason}`);");
    const code = smokeMain.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "");
    expect(code).not.toMatch(/["']restart["']/);
    // The green-on-container-up list is gone.
    expect(code).not.toContain('check: "website-server-health", pass: true');
  });
});
