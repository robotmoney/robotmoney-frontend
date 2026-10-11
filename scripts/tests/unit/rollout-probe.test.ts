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
    expect(await probeOnce("http://x", (async () => new Response("", { status: 200 })) as unknown as typeof fetch, () => 7)).toEqual({ at: 7, status: 200 });
    expect(await probeOnce("http://x", (async () => { throw new Error("down"); }) as unknown as typeof fetch, () => 8)).toEqual({ at: 8, status: 0 });
  });
});
