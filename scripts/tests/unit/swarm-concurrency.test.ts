// Concurrent swarm sessions share two resources that are not safe to use twice
// at once — a member's HOME volume and a regime run for one as-of date — and
// both are guarded by the primitives in scripts/lib/swarm/concurrency.ts. These
// tests EXECUTE the primitives and the regime wrapper built on them; the one
// source-text check at the bottom only proves every member container goes
// through the lock, and is graded against a broken fixture so it cannot go
// vacuously green.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InFlightMemo, KeyedMutex } from "../../lib/swarm/concurrency.ts";
import { classifyRegimeShared, type ProducerComposeRail } from "../../lib/swarm/session.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("KeyedMutex — a member runs in one session at a time", () => {
  test("two runs on the SAME key never overlap, and run in arrival order", async () => {
    const lock = new KeyedMutex();
    const log: string[] = [];
    const first = deferred();
    const a = lock.run("athena", async () => { log.push("a:start"); await first.promise; log.push("a:end"); });
    const b = lock.run("athena", async () => { log.push("b:start"); log.push("b:end"); });
    await tick();
    expect(log).toEqual(["a:start"]); // b is waiting for a
    expect(lock.isHeld("athena")).toBe(true);
    first.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(lock.isHeld("athena")).toBe(false);
  });

  test("different keys run concurrently", async () => {
    const lock = new KeyedMutex();
    const gate = deferred();
    let inFlight = 0;
    let peak = 0;
    const body = async () => { inFlight++; peak = Math.max(peak, inFlight); await gate.promise; inFlight--; };
    const runs = ["athena", "boreas", "cygnus"].map((m) => lock.run(m, body));
    await tick();
    expect(peak).toBe(3);
    gate.resolve();
    await Promise.all(runs);
  });

  test("at most one holder per key however many sessions ask — the driver-wide container bound", async () => {
    const lock = new KeyedMutex();
    const members = ["athena", "boreas"];
    const inFlight = new Map<string, number>();
    let peakPerMember = 0;
    let peakTotal = 0;
    const run = (m: string) => lock.run(m, async () => {
      inFlight.set(m, (inFlight.get(m) ?? 0) + 1);
      peakPerMember = Math.max(peakPerMember, inFlight.get(m)!);
      peakTotal = Math.max(peakTotal, [...inFlight.values()].reduce((a, b) => a + b, 0));
      await tick();
      await tick();
      inFlight.set(m, inFlight.get(m)! - 1);
    });
    // Four "sessions", each running the whole roster at once.
    await Promise.all(Array.from({ length: 4 }, () => Promise.all(members.map(run))));
    expect(peakPerMember).toBe(1);
    expect(peakTotal).toBeLessThanOrEqual(members.length);
  });

  test("a holder that THROWS still releases the key, and the error reaches only its caller", async () => {
    const lock = new KeyedMutex();
    const failed = lock.run("draco", async () => { throw new Error("container exited 1"); });
    const next = lock.run("draco", async () => "ran");
    await expect(failed).rejects.toThrow("container exited 1");
    expect(await next).toBe("ran");
    expect(lock.isHeld("draco")).toBe(false);
  });
});

describe("InFlightMemo — one regime run per date at a time", () => {
  test("concurrent calls for one key share ONE run and its result", async () => {
    const memo = new InFlightMemo<string>();
    const gate = deferred<string>();
    let runs = 0;
    const fn = () => { runs++; return gate.promise; };
    const a = memo.run("2026-09-25", fn);
    const b = memo.run("2026-09-25", fn);
    expect(memo.isInFlight("2026-09-25")).toBe(true);
    gate.resolve("landed");
    expect(await Promise.all([a, b])).toEqual(["landed", "landed"]);
    expect(runs).toBe(1);
  });

  test("it is NOT a cache: once settled, the next call runs again (the old one-at-a-time behaviour)", async () => {
    const memo = new InFlightMemo<number>();
    let runs = 0;
    await memo.run("d", async () => ++runs);
    await memo.run("d", async () => ++runs);
    expect(runs).toBe(2);
    expect(memo.isInFlight("d")).toBe(false);
  });

  test("different keys do not share", async () => {
    const memo = new InFlightMemo<string>();
    const [a, b] = await Promise.all([memo.run("d1", async () => "one"), memo.run("d2", async () => "two")]);
    expect([a, b]).toEqual(["one", "two"]);
  });

  test("a failure reaches every joined caller, then clears — the next call retries", async () => {
    const memo = new InFlightMemo<string>();
    const gate = deferred<string>();
    const a = memo.run("d", () => gate.promise);
    const b = memo.run("d", () => Promise.resolve("never runs"));
    gate.reject(new Error("producer exited 1"));
    await expect(a).rejects.toThrow("producer exited 1");
    await expect(b).rejects.toThrow("producer exited 1");
    expect(await memo.run("d", async () => "retried")).toBe("retried");
  });

  test("a synchronous throw still lands in the promise and clears the key", async () => {
    const memo = new InFlightMemo<string>();
    await expect(memo.run("d", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(memo.isInFlight("d")).toBe(false);
  });
});

describe("classifyRegimeShared — concurrent sessions on one date launch ONE producer", () => {
  const rail = (project: string): ProducerComposeRail => ({
    repoRoot: "/nonexistent",
    composeProject: project,
    composeFiles: [],
    composeSpawnEnv: {},
    backendUrl: "http://127.0.0.1:1",
  });

  test("four sessions convening on the same date share one run", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const run = async (asof: string) => { calls.push(asof); await gate.promise; return { latest: { date: asof } }; };
    const sessions = Array.from({ length: 4 }, () => classifyRegimeShared("2026-09-25", rail("p1"), run));
    gate.resolve();
    await Promise.all(sessions);
    expect(calls).toEqual(["2026-09-25"]);
  });

  test("different dates, or different stacks, never share", async () => {
    const calls: string[] = [];
    const run = async (asof: string, r: ProducerComposeRail) => { calls.push(`${r.composeProject}/${asof}`); await tick(); };
    await Promise.all([
      classifyRegimeShared("2026-09-25", rail("p2"), run),
      classifyRegimeShared("2026-09-26", rail("p2"), run),
      classifyRegimeShared("2026-09-25", rail("p3"), run),
    ]);
    expect(calls.sort()).toEqual(["p2/2026-09-25", "p2/2026-09-26", "p3/2026-09-25"]);
  });

  test("one session at a time (production) still runs the producer every session", async () => {
    let runs = 0;
    const run = async () => { runs++; };
    await classifyRegimeShared("2026-09-25", rail("p4"), run);
    await classifyRegimeShared("2026-09-25", rail("p4"), run);
    expect(runs).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SOURCE-TEXT CHECK. runMemberContainer spawns docker, so it cannot run here;
// what CAN be checked is that there is exactly one way to reach the unlocked
// body, and it is through the lock.
// ---------------------------------------------------------------------------
const agentSrc = readFileSync(join(import.meta.dir, "..", "..", "lib", "swarm", "agent.ts"), "utf8");

/** null when every member container goes through the HOME lock; a reason otherwise. */
export function memberContainersUnlocked(src: string): string | null {
  const unlockedCalls = src.match(/runMemberContainerUnlocked\(/g)?.length ?? 0;
  // One definition + one call, and that call is the lock's body.
  if (unlockedCalls !== 2) return `runMemberContainerUnlocked( appears ${unlockedCalls} times; expected its definition and one locked call`;
  if (!src.includes("memberHomeLock.run(o.homeVolume, () => runMemberContainerUnlocked(rail, o))")) {
    return "runMemberContainer does not take the HOME-volume lock around the container run";
  }
  return null;
}

describe("every member container (enroll and participate) takes the HOME lock", () => {
  test("agent.ts reaches the container only through memberHomeLock", () => {
    expect(memberContainersUnlocked(agentSrc)).toBeNull();
  });

  test("red control: a second, unlocked call site is reported", () => {
    const broken = agentSrc.replace(
      "const run = await runMemberContainer(rail, {\n    mode: \"participate\"",
      "const run = await runMemberContainerUnlocked(rail, {\n    mode: \"participate\"",
    );
    expect(broken).not.toBe(agentSrc);
    expect(memberContainersUnlocked(broken)).toContain("appears 3 times");
  });

  test("red control: a lock that is bypassed is reported", () => {
    const broken = agentSrc.replace(
      "memberHomeLock.run(o.homeVolume, () => runMemberContainerUnlocked(rail, o))",
      "runMemberContainerUnlocked(rail, o)",
    );
    expect(memberContainersUnlocked(broken)).toContain("does not take the HOME-volume lock");
  });
});
