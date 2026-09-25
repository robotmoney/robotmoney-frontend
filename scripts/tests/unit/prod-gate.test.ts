// prod:gate's pure decisions (scripts/prod-gate.ts). Each case is something
// production actually did on 2026-09-24/25 that no runbook step caught.
import { describe, expect, test } from "bun:test";
import { evaluateCapacity, evaluateJudgeConfig, parseProdGateArgs } from "../../prod-gate.ts";

const GB = 1024 ** 3;

describe("evaluateCapacity (report-only)", () => {
  test("no stated capacity still reports the size, as a warning", () => {
    const v = evaluateCapacity(8 * GB, undefined, null, "2026-09-25T17:00:00Z");
    expect(v.status).toBe("WARN");
    expect(v.detail.join("\n")).toContain("8.00 GB");
  });

  test("a tight disk warns and never fails", () => {
    expect(evaluateCapacity(8.5 * GB, 10, null, "2026-09-25T17:00:00Z").status).toBe("WARN");
    expect(evaluateCapacity(5 * GB, 30, null, "2026-09-25T17:00:00Z").status).toBe("PASS");
  });

  test("steep growth is reported with its projection, as a warning", () => {
    const v = evaluateCapacity(8.2 * GB, 30, { sizeBytes: 6.5 * GB, at: "2026-09-25T09:00:00Z" }, "2026-09-25T17:00:00Z");
    expect(v.status).toBe("WARN");
    expect(v.detail.join("\n")).toContain("GB/day");
  });

  test("slow growth on a roomy disk passes", () => {
    expect(evaluateCapacity(2 * GB, 30, { sizeBytes: 1.99 * GB, at: "2026-09-24T17:00:00Z" }, "2026-09-25T17:00:00Z").status).toBe("PASS");
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

  test("--defer-sessions is a flag (R7 runs before the first session can publish)", () => {
    expect(parseProdGateArgs(["--mode", "post-release", "--defer-sessions", "--db-capacity-gb", "25"])).toMatchObject({ mode: "post-release", deferSessions: true, capacityGb: 25 });
  });

  test("takes a state file for a run from a scratch checkout", () => {
    expect(parseProdGateArgs(["--state-file", "/root/robotmoney-frontend/.agents/smoke-state.json"])).toMatchObject({ stateFile: "/root/robotmoney-frontend/.agents/smoke-state.json" });
  });
});
