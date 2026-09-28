// prod:gate's pure decisions (scripts/prod-gate.ts). Each case is something
// production actually did on 2026-09-24/25 that no runbook step caught.
import { describe, expect, test } from "bun:test";
import { evaluateCapacity, evaluateJudgeConfig, evaluateProdDriver, evaluateProdSessions, parseProdGateArgs } from "../../prod-gate.ts";

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

describe("evaluateProdSessions (soak grading against what production records)", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-09-28T12:00:00Z");
  const subjects = ["a", "b"];
  const s = (id: string, subject: string, hoursAgo: number, takes: number, judged = true, receipt = true) =>
    ({ id, subject, publishedAtMs: now - hoursAgo * H, takes, judged, receipt });
  const opts = { minAttendance: 0.5, minSessions: 1, livenessHours: 12, nowMs: now };

  test("adopted or new, a session counts when it published in the window; real takes count", () => {
    const v = evaluateProdSessions([s("1", "a", 10, 5), s("2", "b", 4, 4)], subjects, 7, opts);
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  test("a weak session is a warning when the subject also published a good one", () => {
    const v = evaluateProdSessions([s("1", "a", 10, 3), s("2", "a", 4, 5), s("3", "b", 2, 4)], subjects, 7, opts);
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual(["session 1 (a) published with 3 take(s), under 4 of 7 active"]);
  });

  test("a published session without a model judgement or receipt is a failure", () => {
    const v = evaluateProdSessions([s("1", "a", 2, 5, false, true), s("2", "b", 2, 5, true, false)], subjects, 7, opts);
    expect(v.failures).toContain("session 1 (a) published without an applied model/enforce judgement");
    expect(v.failures).toContain("session 2 (b) published without a consensus receipt");
  });

  test("sessions that stopped publishing fail the liveness bar", () => {
    const v = evaluateProdSessions([s("1", "a", 17, 5), s("2", "b", 20, 5)], subjects, 7, opts);
    expect(v.failures.join("\n")).toContain("no session has published for 17.0 h (limit 12 h): sessions have stopped");
  });
});

describe("evaluateProdDriver", () => {
  test("every subject needs a published judge=enforce line; attendance is not graded from M", () => {
    const d = (subject: string, judge = "enforce") => ({ subject, state: "published", judge, takes: 3, active: 8 });
    expect(evaluateProdDriver([d("a"), d("b")], ["a", "b"])).toEqual([]);
    expect(evaluateProdDriver([d("a")], ["a", "b"])).toEqual(["driver log: subject b logged no published session with judge=enforce"]);
    expect(evaluateProdDriver([d("a"), d("b"), d("b", "none")], ["a", "b"])).toEqual(["driver log: a b session published with judge=none"]);
  });
});

describe("known issues after the release", () => {
  test("only a known issue THIS release fixes fails; issue 1035 is a warning", async () => {
    const { classify, inventory, inventoryVerdict } = await import("../../lib/gate/log-inventory.ts");
    const rules = [
      { id: "judge", match: "model_unconfigured", class: "known-issue" as const, issue: "v0.5.1-D1", reason: "judge had no model, fixed by 0063" },
      { id: "ledger", match: "upstream prematurely closed", class: "known-issue" as const, issue: "1035", reason: "ledger load, not this release" },
    ];
    const g = classify(inventory("x", [{ ts: null, text: "judge produced no judgement (model_unconfigured) error" }, { ts: null, text: "[error] upstream prematurely closed connection" }]), rules);
    const v = inventoryVerdict(g, "post-release", "v0.5.1");
    expect(v.failures.join("\n")).toContain("known issue judge (v0.5.1-D1) still present after the release that fixes it");
    expect(v.warnings.join("\n")).toContain("known issue ledger (1035), not fixed by v0.5.1");
  });
});
