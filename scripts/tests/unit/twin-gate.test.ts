// The twin gate's pure decisions (scripts/twin-gate.ts). The v0.5.0 rehearsal
// passed while production could not close a session; each case below is a way
// that happened or could have.
import { describe, expect, test } from "bun:test";
import { classifyLog, evaluateSessions, parseGateArgs, type SessionRow } from "../../twin-gate.ts";

const subjects = ["a", "b"];
const args = { minSessions: 1, minAttendance: 0.5, stuckAfterMin: 30 };
const ok = (id: string, subject: string, over: Partial<SessionRow> = {}): SessionRow => ({
  id, subject, state: "published", ageMin: 10, takes: 8, judged: true, receipt: true, ...over,
});

describe("evaluateSessions", () => {
  test("passes when every subject published a complete session this boot", () => {
    expect(evaluateSessions([ok("1", "a"), ok("2", "b")], subjects, 8, args).failures).toEqual([]);
  });

  test("a subject with no session this boot fails — restored production sessions do not count", () => {
    const v = evaluateSessions([ok("1", "a")], subjects, 8, args);
    expect(v.failures).toEqual(["subject b: 0 session(s) convened and published this boot; need 1"]);
  });

  test("a session that published with no takes fails (the 2026-09-24 twin had two)", () => {
    const f = evaluateSessions([ok("1", "a"), ok("2", "b", { takes: 0 })], subjects, 8, args).failures;
    expect(f.join("\n")).toContain("published with 0 take(s); need 4 of 8 active");
  });

  test("attendance below --min-attendance fails; at the threshold passes", () => {
    expect(evaluateSessions([ok("1", "a", { takes: 3 }), ok("2", "b")], subjects, 8, args).failures).toHaveLength(1);
    expect(evaluateSessions([ok("1", "a", { takes: 4 }), ok("2", "b")], subjects, 8, args).failures).toEqual([]);
  });

  test("published without a model judgement or without a receipt fails", () => {
    const f = evaluateSessions([ok("1", "a", { judged: false }), ok("2", "b", { receipt: false })], subjects, 8, args).failures;
    expect(f.join("\n")).toContain("without an applied model/enforce judgement");
    expect(f.join("\n")).toContain("without a consensus receipt");
  });

  test("a session stuck past --stuck-after fails; a young one is still in flight", () => {
    const rows = [ok("1", "a"), ok("2", "b"), ok("3", "a", { state: "collecting", ageMin: 45 }), ok("4", "b", { state: "collecting", ageMin: 3 })];
    expect(evaluateSessions(rows, subjects, 8, args).failures).toEqual(["session 3 (a) stuck in 'collecting' for 45 min"]);
  });
});

describe("classifyLog", () => {
  test("fatal patterns fail, warnings are only counted", () => {
    const v = classifyLog(["[api] REFUSING the boot: x", "job 7 (swarm.judge) failed — DEAD: y", "job 8 DEGRADED — kept", "fine"], []);
    expect([...v.fatal.keys()].sort()).toEqual(["REFUSING the boot", "— DEAD"]);
    expect(v.warn.get("DEGRADED")).toBe(1);
  });

  test("a waiver must name the line; it moves the match out of fatal", () => {
    const v = classifyLog(["PostgresError: unsupported Unicode escape sequence"], ["unsupported Unicode escape sequence"]);
    expect(v.fatal.size).toBe(0);
    expect(v.waived.get("unsupported Unicode escape sequence")).toBe(1);
  });
});

describe("parseGateArgs", () => {
  test("defaults", () => {
    expect(parseGateArgs([])).toEqual({ minSessions: 1, minAttendance: 0.5, stuckAfterMin: 30, waitMin: 0, waive: [] });
  });

  test("rejects an unknown flag and a bad fraction", () => {
    expect(parseGateArgs(["--fast"])).toEqual({ error: 'unknown argument "--fast".' });
    expect(parseGateArgs(["--min-attendance", "2"])).toHaveProperty("error");
  });

  test("collects repeated waivers", () => {
    const a = parseGateArgs(["--waive", "x", "--waive", "y", "--wait", "40"]);
    expect("error" in a ? a : { waive: a.waive, wait: a.waitMin }).toEqual({ waive: ["x", "y"], wait: 40 });
  });
});
