// The twin gate's pure decisions (scripts/twin-gate.ts). The v0.5.0 rehearsal
// passed while production could not close a session; each case below is a way
// that happened or could have.
import { describe, expect, test } from "bun:test";
import { classifyLog, normalizeLogLine, parseGateArgs, renderReport, scanLog, sessionsQuery, toSessionRow, type GateReport } from "../../twin-gate.ts";

describe("classifyLog", () => {
  test("fatal patterns fail, warnings are only counted", () => {
    const v = classifyLog(["[api] REFUSING the boot: x", "job 7 (analytics.parity_sweep) failed — DEAD: y", "job 8 DEGRADED — kept", "fine"], []);
    expect([...v.fatal.keys()].sort()).toEqual(["REFUSING the boot", "— DEAD"]);
    expect(v.warn.get("DEGRADED")).toBe(1);
  });

  test("a waiver must name the line; it moves the match out of fatal", () => {
    const v = classifyLog(["PostgresError: unsupported Unicode escape sequence"], ["unsupported Unicode escape sequence"]);
    expect(v.fatal.size).toBe(0);
    expect(v.waived.get("unsupported Unicode escape sequence")).toBe(1);
  });

  test("an empty inference account is fatal", () => {
    const v = classifyLog(["APIError: Upstream request failed: Insufficient account funds [server_error, HTTP 402]"], []);
    expect(v.fatal.get("Insufficient account funds")).toBe(1);
  });

  test("a participant that cannot poll or subscribe is fatal", () => {
    expect([...classifyLog(["participant agent a refuses to poll: apiReachable=false"], []).fatal.keys()]).toEqual(["refuses to poll"]);
    expect([...classifyLog(["participant judge j refuses to subscribe: tokenValid=false"], []).fatal.keys()]).toEqual(["refuses to subscribe"]);
  });
});

describe("parseGateArgs", () => {
  test("defaults grade release v0.6.0 with the scheduler-era stuck bar", () => {
    expect(parseGateArgs([])).toEqual({ minSessions: 1, minAttendance: 0.5, stuckAfterMin: 780, waitMin: 0, waive: [], release: "v0.6.0" });
  });

  test("--instance is accepted (resolveGateStack reads it); the host driver's --driver-log is gone", () => {
    expect(parseGateArgs(["--instance", "rm_twin"])).toMatchObject({ minSessions: 1 });
    expect(parseGateArgs(["--driver-log", "/tmp/t.log"])).toEqual({ error: 'unknown argument "--driver-log".' });
  });

  test("rejects an unknown flag and a bad fraction", () => {
    expect(parseGateArgs(["--fast"])).toEqual({ error: 'unknown argument "--fast".' });
    expect(parseGateArgs(["--min-attendance", "2"])).toHaveProperty("error");
  });

  test("collects repeated waivers", () => {
    const a = parseGateArgs(["--waive", "x", "--waive", "y", "--wait", "40"]);
    expect("error" in a ? a : { waive: a.waive, wait: a.waitMin }).toEqual({ waive: ["x", "y"], wait: 40 });
  });

  test("--sessions N and --report", () => {
    expect((parseGateArgs(["--sessions", "2"]) as { totalSessions?: number }).totalSessions).toBe(2);
    expect(parseGateArgs(["--report", "/tmp/r.txt"])).toHaveProperty("error");
    expect(parseGateArgs(["--report", "/tmp/r.md"])).toMatchObject({ report: "/tmp/r.md" });
  });
});

describe("the sessions query", () => {
  test("admits a session by what THIS boot did to it, never by whether it was judged", () => {
    const q = sessionsQuery("2026-10-03T00:00:00.000Z");
    expect(q).toContain("WHERE s.convened_at >= '2026-10-03T00:00:00.000Z'::timestamptz");
    expect(q).toContain("OR s.published_at >= '2026-10-03T00:00:00.000Z'::timestamptz");
    expect(q).toContain("OR EXISTS (SELECT 1 FROM swarm_session_judgements j WHERE j.session_id = s.id AND j.created_at >= '2026-10-03T00:00:00.000Z'::timestamptz)");
  });

  test("takes are real takes (swarm_recommendations), outside members included, and the outcome is read", () => {
    const q = sessionsQuery("2026-10-03T00:00:00.000Z");
    expect(q).toContain("FROM swarm_recommendations r WHERE r.session_id = s.id");
    expect(q).not.toContain("swarm_memos");
    expect(q).toContain("s.judging_outcome AS outcome");
  });

  test("judged means an applied model judgement in enforce mode, not any judgement row", () => {
    const q = sessionsQuery("2026-10-03T00:00:00.000Z");
    expect(q).toContain("AND j.source = 'model' AND j.mode = 'enforce' AND j.applied) AS judged");
  });

  test("a database row becomes a SessionRow", () => {
    expect(toSessionRow({ id: "s", subject: "a", state: "published", outcome: "judged", age: "12.5", pub: "1759500000000", takes: "4", judged: true, receipt: false })).toEqual({
      id: "s", subject: "a", state: "published", outcome: "judged", ageMin: 12.5, publishedAtMs: 1759500000000, takes: 4, judged: true, receipt: false,
    });
    expect(toSessionRow({ id: "s", subject: "a", state: "collecting", outcome: null, age: "1", pub: null, takes: "0", judged: false, receipt: false }).publishedAtMs).toBeNull();
  });
});

describe("the report — the document the runbook files", () => {
  test("scanLog counts fatal, warn, error-like and warning-like lines per source, and groups repeats", () => {
    const scan = scanLog("rm_x-api-1", [
      "job 12 (analytics.parity_sweep) failed — DEAD: boom",
      "job 13 (analytics.parity_sweep) failed — DEAD: boom",
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
    expect(scan.topErrors).toEqual([{ line: "job <n> (analytics.parity_sweep) failed — DEAD: boom", count: 2 }]);
  });

  test("normalizeLogLine collapses ids, numbers and timestamps", () => {
    expect(normalizeLogLine("2026-09-25T14:05:34.855Z session 3bd2d2ae-43d7-4bb4-9f6a-c4477e135775 took 81 s"))
      .toBe("<ts> session <uuid> took <n> s");
  });

  test("renderReport lists every check, every container (participants named) and every scanned log source", () => {
    const report: GateReport = {
      commit: "abc123", host: "stage-2", instance: "rm_twin", project: "rm_x", t0: "2026-10-03T00:00:00.000Z",
      finishedAt: "2026-10-03T01:00:00.000Z", args: { minSessions: 1, minAttendance: 0.5, stuckAfterMin: 780, waitMin: 75, waive: [], release: "v0.6.0" },
      verdict: "PASS",
      checks: [{ id: "jobs", title: "No job created after T0 is dead", status: "PASS", detail: ["12 job(s)"] }],
      sessions: [{ id: "s1", subject: "woon", state: "published", outcome: "judged", ageMin: 5, publishedAtMs: 1, takes: 7, judged: true, receipt: true }],
      jobs: [{ kind: "analytics.refresh", status: "succeeded", count: 4 }],
      containers: [
        { name: "rm_x-api-1", running: true, health: "healthy", restarts: 0, startedAt: "", oneShot: false, participantKind: null },
        { name: "rm_x-participant-judge-rm-1", running: true, health: "none", restarts: 0, startedAt: "", oneShot: false, participantKind: "judge" },
      ],
      logScans: [scanLog("rm_x-api-1", ["fine"], []), scanLog("rm_x-participant-judge-rm-1", ["[judge:rm] subscribed"], [])],
      inventory: [{ source: "rm_x-api-1", level: "ERROR", key: "brand new failure", count: 2, first: null, last: null, sample: "brand new failure", rule: null }],
    };
    const md = renderReport(report);
    expect(md).toContain("# Twin rehearsal gate report — PASS");
    expect(md).toContain("| Instance | `rm_twin` |");
    expect(md).toContain("| 1 | No job created after T0 is dead | **PASS** | 12 job(s) |");
    expect(md).toContain("`rm_x-api-1` | service | yes | healthy | 0 |");
    expect(md).toContain("`rm_x-participant-judge-rm-1` | participant (judge) | yes");
    expect(md).toContain("2 source(s) scanned");
    expect(md).toContain("## Full inventory");
    expect(md).toContain("**UNCLASSIFIED**");
  });
});
