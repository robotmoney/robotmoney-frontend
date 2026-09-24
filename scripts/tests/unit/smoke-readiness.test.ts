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
// WHAT THIS FILE DOES NOT PROVE. It does not prove a real scheduler container
// serves this over HTTP and a real `bun smoke` consumes it; that is
// scripts/tests/integration/smoke-readiness-scheduler.test.ts and the e2e gate.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { healthPayload } from "../../lib/system-scheduler/health.ts";
import type { SchedulerHealth } from "../../lib/system-scheduler/types.ts";
import {
  evaluateSchedulerReadiness,
  fetchSchedulerHealth,
  schedulerReadinessPassed,
  SCHEDULER_READINESS_CHECKS,
} from "../../lib/smoke-readiness-scheduler.ts";

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
