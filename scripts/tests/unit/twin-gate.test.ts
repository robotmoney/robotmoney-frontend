// The twin gate's pure decisions (scripts/twin-gate.ts). The v0.5.0 rehearsal
// passed while production could not close a session; each case below is a way
// that happened or could have.
import { describe, expect, test } from "bun:test";
import { classifyLog, evaluateDriverSessions, evaluateSessions, normalizeLogLine, parseDriverSessions, parseGateArgs, renderReport, scanLog, type GateReport, type SessionRow } from "../../twin-gate.ts";

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
    expect(parseGateArgs(["--driver-log", "/tmp/t.log"])).toMatchObject({ driverLog: "/tmp/t.log" });
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

describe("the driver log (the service's own account of each session)", () => {
  const lines = [
    "[session 3: 2026-09-25/a] published: state=published, takes=8 of 8, judge=enforce",
    "[session 4: 2026-09-25/b] published: state=published, takes=0 of 8, judge=none",
    "[session 39: 2026-09-25/b] published: state=published, takes=0 of 8",
    "noise",
  ];

  test("parses one entry per published line; an old-format line is 'unlogged'", () => {
    expect(parseDriverSessions(lines).map((d) => [d.subject, d.takes, d.judge])).toEqual([
      ["a", 8, "enforce"], ["b", 0, "none"], ["b", 0, "unlogged"],
    ]);
  });

  test("a subject whose only sessions were unjudged or unattended fails, and each unjudged session is named", () => {
    const f = evaluateDriverSessions(parseDriverSessions(lines), ["a", "b"], { minSessions: 1, minAttendance: 0.5 });
    expect(f).toContain("driver log: subject b logged 0 published+judged+attended session(s); need 1");
    expect(f.filter((x) => x.includes("published with judge="))).toHaveLength(2);
  });

  test("passes when every subject logged a judged, attended session", () => {
    const ok = ["[session 1: 2026-09-25/a] published: state=published, takes=5 of 8, judge=enforce", "[session 2: 2026-09-25/b] published: state=published, takes=4 of 8, judge=enforce"];
    expect(evaluateDriverSessions(parseDriverSessions(ok), ["a", "b"], { minSessions: 1, minAttendance: 0.5 })).toEqual([]);
  });

  test("an empty inference account is fatal", () => {
    const v = classifyLog(["APIError: Upstream request failed: Insufficient account funds [server_error, HTTP 402]"], []);
    expect(v.fatal.get("Insufficient account funds")).toBe(1);
  });
});

describe("the report — the document the runbook files", () => {
  test("scanLog counts fatal, warn, error-like and warning-like lines per source, and groups repeats", () => {
    const scan = scanLog("rm_x-api-1", [
      "job 12 (swarm.judge) failed — DEAD: boom",
      "job 13 (swarm.judge) failed — DEAD: boom",
      "job 9 DEGRADED — kept last-persisted",
      "WARNING: something mild",
      "all good",
      "",
    ], []);
    expect(scan.lines).toBe(5);
    expect(scan.fatal).toEqual({ "— DEAD": 2 });
    expect(scan.warn).toEqual({ DEGRADED: 1 });
    expect(scan.errorLike).toBe(2);
    expect(scan.warningLike).toBe(1);
    expect(scan.topErrors).toEqual([{ line: "job <n> (swarm.judge) failed — DEAD: boom", count: 2 }]);
  });

  test("normalizeLogLine collapses ids, numbers and timestamps", () => {
    expect(normalizeLogLine("2026-09-25T14:05:34.855Z session 3bd2d2ae-43d7-4bb4-9f6a-c4477e135775 took 81 s"))
      .toBe("<ts> session <uuid> took <n> s");
  });

  test("renderReport lists every check, every container and every scanned log source", () => {
    const report: GateReport = {
      commit: "abc123", host: "stage-2", project: "rm_x", twinDb: "rm-restore-1", t0: "2026-09-25T00:00:00.000Z",
      finishedAt: "2026-09-25T01:00:00.000Z", args: { minSessions: 1, minAttendance: 0.5, stuckAfterMin: 30, waitMin: 75, waive: [] },
      verdict: "PASS",
      checks: [{ id: "jobs", title: "No job created after T0 is dead", status: "PASS", detail: ["12 job(s)"] }],
      sessions: [{ id: "s1", subject: "woon", state: "published", ageMin: 5, takes: 7, judged: true, receipt: true }],
      driverSessions: [{ subject: "woon", state: "published", takes: 7, active: 8, judge: "enforce" }],
      jobs: [{ kind: "swarm.judge", status: "succeeded", count: 4 }],
      containers: [{ name: "rm_x-api-1", running: true, health: "healthy", restarts: 0, oneShot: false }],
      logScans: [scanLog("rm_x-api-1", ["fine"], []), scanLog("driver: /tmp/t.log", ["[session 1: 2026-09-25/woon] published"], [])],
      inventory: [{ source: "rm_x-api-1", level: "ERROR", key: "brand new failure", count: 2, first: null, last: null, sample: "brand new failure", rule: null }],
    };
    const md = renderReport(report);
    expect(md).toContain("# Twin rehearsal gate report — PASS");
    expect(md).toContain("| 1 | No job created after T0 is dead | **PASS** | 12 job(s) |");
    expect(md).toContain("`rm_x-api-1` | service | yes | healthy | 0 |");
    expect(md).toContain("2 source(s) scanned");
    expect(md).toContain("`driver: /tmp/t.log`");
    expect(md).toContain("## Full inventory");
    expect(md).toContain("**UNCLASSIFIED**");
  });

  test("--report must be a .md path", () => {
    expect(parseGateArgs(["--report", "/tmp/r.txt"])).toHaveProperty("error");
    expect(parseGateArgs(["--report", "/tmp/r.md"])).toMatchObject({ report: "/tmp/r.md" });
  });
});
