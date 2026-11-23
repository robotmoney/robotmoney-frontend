import { describe, expect, test } from "bun:test";
import { assertRolloutPlan, defaultRolloutPlan, gradeProbeReceipts, parseProbeReceipts, probeOnce, validateRolloutPlan, type ProbeReceipt } from "../../lib/rollout-probe.ts";

describe("rollout plan", () => {
  test("the default plan is ordered website, api and workers, migrate, participants", () => {
    expect(defaultRolloutPlan().map((s) => s.unit)).toEqual(["website", "api-workers", "migrate", "participants"]);
    expect(validateRolloutPlan(defaultRolloutPlan())).toEqual([]);
  });

  test("a step out of order is refused", () => {
    const plan = [{ unit: "migrate" as const, action: "run" as const }, { unit: "website" as const, action: "replace" as const }];
    expect(validateRolloutPlan(plan).join()).toContain("comes after a later unit");
  });

  test("stopping website-server needs an owner decision", () => {
    expect(() => assertRolloutPlan([{ unit: "website", action: "stop" }])).toThrow("owner decision");
    expect(() => assertRolloutPlan([{ unit: "api-workers", action: "replace", stopsWebsite: true }])).toThrow("owner decision");
    expect(() => assertRolloutPlan([{ unit: "website", action: "stop", ownerDecision: "D61 (Lucas, 2026-10-11)" }])).not.toThrow();
  });
});

const T0 = 1_000_000;
const clean = (): ProbeReceipt[] => Array.from({ length: 5 }, (_, i) => ({ at: T0 + 10_000 + i * 15_000, status: 200 }));
const window = { start: T0, end: T0 + 10_000 + 4 * 15_000 + 10_000 };

describe("probe grading", () => {
  test("a clean receipt set passes", () => {
    const g = gradeProbeReceipts(clean(), window);
    expect(g.ok).toBe(true);
    expect(g.receipts).toBe(5);
  });

  test("any non-200 receipt fails", () => {
    const r = clean();
    r[2] = { at: r[2]!.at, status: 502 };
    const g = gradeProbeReceipts(r, window);
    expect(g.ok).toBe(false);
    expect(g.nonOk).toHaveLength(1);
  });

  test("a gap over 15 s fails", () => {
    const r = clean();
    r.splice(2, 1);
    const g = gradeProbeReceipts(r, window);
    expect(g.ok).toBe(false);
    expect(g.gaps).toHaveLength(1);
  });

  test("no receipts fails, and a probe that died before the window end fails", () => {
    expect(gradeProbeReceipts([], window).ok).toBe(false);
    expect(gradeProbeReceipts(clean().slice(0, 2), window).ok).toBe(false);
  });

  test("receipt lines parse, and a bad line is refused", () => {
    expect(parseProbeReceipts('{"at":1,"status":200}\n{"at":2,"status":0}\n')).toEqual([{ at: 1, status: 200 }, { at: 2, status: 0 }]);
    expect(() => parseProbeReceipts('{"at":"x"}')).toThrow();
  });

  test("probeOnce records the status, and 0 when the fetch fails", async () => {
    expect(await probeOnce("http://x", (async () => new Response("", { status: 200 })) as unknown as typeof fetch, () => 7)).toEqual({ at: 7, status: 200, endedAt: 7, latencyMs: 0 });
    expect(await probeOnce("http://x", (async () => { throw new Error("down"); }) as unknown as typeof fetch, () => 8)).toEqual({ at: 8, status: 0, endedAt: 8, latencyMs: 0 });
  });
});

// Issue 1703: the grade tells a slow site from a down one. Ticks every 2 s, slack 3 s.
describe("slow answers, timeouts and the latency report (issue 1703)", () => {
  const W = { start: T0, end: T0 + 20_000 };
  const tick = (i: number, path: string, latencyMs = 200, status = 200): ProbeReceipt => ({ at: T0 + 500 + i * 2_000, status, endedAt: T0 + 500 + i * 2_000 + latencyMs, latencyMs, path });
  const site = (slow: (i: number) => number = () => 200) => Array.from({ length: 10 }, (_, i) => [tick(i, "/", slow(i)), tick(i, "/version.json")]).flat();

  test("every answer 200 but one tick's answers take 5 s: ok, and the latency report shows 5000 ms on that path", () => {
    const g = gradeProbeReceipts(site((i) => (i === 4 ? 5_000 : 200)), W, 2_000, 3_000);
    expect(g.ok).toBe(true);
    expect(g.gaps).toEqual([]);
    expect(g.latency).toEqual([{ path: "/", latencyMs: 5_000, at: T0 + 8_500 }, { path: "/version.json", latencyMs: 200, at: T0 + 500 }]);
  });

  test("red control: no successful site answer started for longer than interval plus slack fails with a gap", () => {
    const r = site().filter((x) => x.at < T0 + 6_000 || x.at > T0 + 12_000);
    const g = gradeProbeReceipts(r, W, 2_000, 3_000);
    expect(g.ok).toBe(false);
    expect(g.gaps).toEqual([[T0 + 4_500, T0 + 12_500]]);
    expect(g.problems.join()).toContain("no successful site answer");
  });

  test("red control: failed answers do not fill a gap, even when they were asked on time", () => {
    const r = site().map((x) => (x.at > T0 + 6_000 && x.at < T0 + 12_000 ? { ...x, status: 502 } : x));
    expect(gradeProbeReceipts(r, W, 2_000, 3_000).gaps).toEqual([[T0 + 4_500, T0 + 12_500]]);
  });

  test("a timed-out request is a receipt with status 0 and fails the grade", async () => {
    let clock = 100;
    const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const p = probeOnce("http://x/", never, () => clock, 50);
    clock = 150;
    const timedOut = await p;
    expect(timedOut).toEqual({ at: 100, status: 0, endedAt: 150, latencyMs: 50 });
    const r = site();
    r[6] = { ...timedOut, at: r[6]!.at, path: "/" };
    const g = gradeProbeReceipts(r, W, 2_000, 3_000);
    expect(g.ok).toBe(false);
    expect(g.nonOk).toHaveLength(1);
  });

  test("old receipt lines without endedAt or latencyMs still parse and grade as before, with an empty latency report", () => {
    const lines = clean().map((r) => JSON.stringify(r)).join("\n");
    const parsed = parseProbeReceipts(lines);
    expect(parsed).toEqual(clean());
    const g = gradeProbeReceipts(parsed, window);
    expect(g).toMatchObject({ ok: true, receipts: 5, latency: [], maintenanceFailures: [] });
    expect(parseProbeReceipts('{"at":1,"status":200,"endedAt":9,"latencyMs":8,"path":"/"}')).toEqual([{ at: 1, status: 200, endedAt: 9, latencyMs: 8, path: "/" }]);
  });
});
