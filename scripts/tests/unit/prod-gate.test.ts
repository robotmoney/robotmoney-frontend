// prod:gate's pure decisions (scripts/prod-gate.ts). Each case is something
// production actually did on 2026-09-24/25 that no runbook step caught.
import { describe, expect, test } from "bun:test";
import { evaluateCapacity, evaluateJudgeConfig, parseProdGateArgs } from "../../prod-gate.ts";

const GB = 1024 ** 3;

describe("evaluateCapacity", () => {
  test("no stated capacity is a failure, not a pass", () => {
    expect(evaluateCapacity(8 * GB, undefined, null, "2026-09-25T17:00:00Z").status).toBe("FAIL");
  });

  test("over 80% of the disk fails; over 70% warns", () => {
    expect(evaluateCapacity(8.5 * GB, 10, null, "2026-09-25T17:00:00Z").status).toBe("FAIL");
    expect(evaluateCapacity(7.5 * GB, 10, null, "2026-09-25T17:00:00Z").status).toBe("WARN");
    expect(evaluateCapacity(5 * GB, 10, null, "2026-09-25T17:00:00Z").status).toBe("PASS");
  });

  test("production's 2026-09-25 growth (6.5 → 8.2 GB in ~8 h) fails on the projection alone, well below 70%", () => {
    const v = evaluateCapacity(8.2 * GB, 25, { sizeBytes: 6.5 * GB, at: "2026-09-25T09:00:00Z" }, "2026-09-25T17:00:00Z");
    expect(v.status).toBe("FAIL");
    expect(v.detail.join("\n")).toContain("GB/day");
  });

  test("slow growth on a roomy disk passes", () => {
    expect(evaluateCapacity(2 * GB, 25, { sizeBytes: 1.99 * GB, at: "2026-09-24T17:00:00Z" }, "2026-09-25T17:00:00Z").status).toBe("PASS");
  });
});

describe("evaluateJudgeConfig", () => {
  test("enforce with no model fails (production ran this for days)", () => {
    expect(evaluateJudgeConfig({ mode: "enforce", model: null }).status).toBe("FAIL");
    expect(evaluateJudgeConfig({ mode: "shadow", model: " " }).status).toBe("FAIL");
  });

  test("a switched-off judge needs no model; a configured one passes", () => {
    expect(evaluateJudgeConfig({ mode: "off", model: null }).status).toBe("PASS");
    expect(evaluateJudgeConfig({ mode: "enforce", model: "opencode/deepseek-v4-flash" }).status).toBe("PASS");
  });
});

describe("parseProdGateArgs", () => {
  test("defaults to a 24 h baseline", () => {
    expect(parseProdGateArgs([])).toMatchObject({ mode: "baseline", windowHours: 24, stuckAfterMin: 780 });
  });

  test("rejects an unknown mode, a bad capacity and a non-markdown report", () => {
    expect(parseProdGateArgs(["--mode", "later"])).toHaveProperty("error");
    expect(parseProdGateArgs(["--db-capacity-gb", "-1"])).toHaveProperty("error");
    expect(parseProdGateArgs(["--report", "/tmp/x.txt"])).toHaveProperty("error");
  });

  test("takes a state file for a run from a scratch checkout", () => {
    expect(parseProdGateArgs(["--state-file", "/root/robotmoney-frontend/.agents/smoke-state.json"])).toMatchObject({ stateFile: "/root/robotmoney-frontend/.agents/smoke-state.json" });
  });
});
