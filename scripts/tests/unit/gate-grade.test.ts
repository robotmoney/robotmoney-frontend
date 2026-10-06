// The pure decisions both gates share (scripts/lib/gate/grade.ts), including the
// model-outcome rule: a model timeout or rejected take is reported, a dead judge
// or an unjudged publish fails; a no_consensus publish is a warning (owner, 2026-10-06).
import { describe, expect, test } from "bun:test";
import { evaluateContainers, evaluateJudgeConfig, evaluateParticipants, evaluateSessions, type SessionRow } from "../../lib/gate/grade.ts";
import type { ContainerState } from "../../lib/gate/io.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-10-03T12:00:00Z");
const subjects = ["a", "b"];
const opts = { minSessions: 1, minAttendance: 0.5, stuckAfterMin: 780, nowMs: NOW };
const good = (id: string, subject: string, over: Partial<SessionRow> = {}): SessionRow => ({
  id, subject, state: "published", outcome: "judged", ageMin: 60, publishedAtMs: NOW - H, takes: 5, judged: true, receipt: true, ...over,
});

describe("evaluateSessions", () => {
  test("every subject with a judged, receipted, attended session passes", () => {
    const v = evaluateSessions([good("1", "a"), good("2", "b")], subjects, 8, opts);
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  test("a session that published no_consensus is a warning, not a failure, and never counts as good", () => {
    const v = evaluateSessions(
      [good("1", "a"), good("2", "b"), good("3", "b", { outcome: "no_consensus", judged: false, receipt: false })],
      subjects, 8, opts,
    );
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual(["session 3 (b) published no_consensus: an acceptable outcome, not counted as a good session"]);
    expect(v.goodBySubject.get("b")).toBe(1);
  });

  test("a subject whose only session is no_consensus still fails the per-subject minimum", () => {
    const v = evaluateSessions([good("1", "a"), good("2", "b", { outcome: "no_consensus", judged: false, receipt: false })], subjects, 8, opts);
    expect(v.failures).toEqual(["subject b: 0 published, judged, attended session(s) in the window; need 1"]);
  });

  test("judged without a receipt still fails even beside a no_consensus session", () => {
    const v = evaluateSessions([good("1", "a", { receipt: false }), good("2", "b", { outcome: "no_consensus", judged: false, receipt: false })], subjects, 8, opts);
    expect(v.failures).toContain("session 1 (a) published without a consensus receipt");
  });

  test("a judge switched off (not_judged) fails the same way", () => {
    const v = evaluateSessions([good("1", "a", { outcome: "not_judged", judged: false, receipt: false }), good("2", "b")], subjects, 8, opts);
    expect(v.failures.join("\n")).toContain("judging outcome 'not_judged'");
  });

  test("a judged outcome with no receipt fails", () => {
    const v = evaluateSessions([good("1", "a", { receipt: false }), good("2", "b")], subjects, 8, opts);
    expect(v.failures).toContain("session 1 (a) published without a consensus receipt");
  });

  test("a thin session (members timed out or were rejected) is a warning when the subject has a good one", () => {
    const v = evaluateSessions([good("1", "a", { takes: 2 }), good("2", "a"), good("3", "b")], subjects, 8, opts);
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual(["session 1 (a) published with 2 take(s), under 4 of 8 active"]);
  });

  test("a subject whose only session is thin has no good session and fails", () => {
    const v = evaluateSessions([good("1", "a", { takes: 2 }), good("2", "b")], subjects, 8, opts);
    expect(v.failures).toEqual(["subject a: 0 published, judged, attended session(s) in the window; need 1"]);
  });

  test("a session open past --stuck-after fails; a young one is still in flight", () => {
    const rows = [good("1", "a"), good("2", "b"), good("3", "a", { state: "collecting", outcome: null, ageMin: 800 }), good("4", "b", { state: "collecting", outcome: null, ageMin: 5 })];
    expect(evaluateSessions(rows, subjects, 8, opts).failures).toEqual(["session 3 (a) stuck in 'collecting' for 800 min"]);
  });

  test("--sessions N counts good sessions across subjects", () => {
    const o = { ...opts, totalSessions: 2 };
    expect(evaluateSessions([good("1", "a"), good("2", "b")], subjects, 8, o).failures).toEqual([]);
    expect(evaluateSessions([good("1", "a")], subjects, 8, o).failures).toEqual(["1 published, judged, attended session(s) in the window; need 2"]);
  });

  test("liveness: nothing published for longer than the limit fails", () => {
    const rows = [good("1", "a", { publishedAtMs: NOW - 17 * H }), good("2", "b", { publishedAtMs: NOW - 20 * H })];
    expect(evaluateSessions(rows, subjects, 8, { ...opts, livenessHours: 12 }).failures.join("\n")).toContain("no session has published for 17.0 h (limit 12 h)");
    expect(evaluateSessions(rows, subjects, 8, opts).failures).toEqual([]);
  });
});

describe("evaluateParticipants", () => {
  const c = (name: string, kind: string | null, over: Partial<ContainerState> = {}): ContainerState => ({
    name, running: true, health: "none", restarts: 0, startedAt: "", oneShot: false, participantKind: kind, ...over,
  });

  test("a running judge and a running agent pass", () => {
    expect(evaluateParticipants([c("j", "judge"), c("a", "agent"), c("api", null)]).failures).toEqual([]);
  });

  test("no judge container is a dead judge", () => {
    expect(evaluateParticipants([c("a", "agent")]).failures).toEqual(["no judge participant container in the project: no session can be judged"]);
  });

  test("a stopped or crash-looping judge fails (restarts only count after a release)", () => {
    expect(evaluateParticipants([c("j", "judge", { running: false }), c("a", "agent")]).failures).toEqual(["j: judge participant not running"]);
    expect(evaluateParticipants([c("j", "judge", { restarts: 3 }), c("a", "agent")]).failures).toEqual(["j: judge participant restarted 3 time(s)"]);
    expect(evaluateParticipants([c("j", "judge", { restarts: 3 }), c("a", "agent")], false).failures).toEqual([]);
  });
});

describe("evaluateJudgeConfig and evaluateContainers", () => {
  test("only enforce judges sessions", () => {
    expect(evaluateJudgeConfig({ mode: "enforce" }).status).toBe("PASS");
    expect(evaluateJudgeConfig({ mode: "off" }).status).toBe("FAIL");
    expect(evaluateJudgeConfig(undefined).status).toBe("FAIL");
  });

  test("a restart fails after a release and warns in a baseline; one-shots are not graded", () => {
    const svc: ContainerState = { name: "s", running: true, health: "healthy", restarts: 1, startedAt: "", oneShot: false, participantKind: null };
    const once: ContainerState = { name: "m-run-1", running: false, health: "none", restarts: 0, startedAt: "", oneShot: true, participantKind: null };
    expect(evaluateContainers([svc, once], "p", true).failures).toEqual(["s: restarted 1 time(s)"]);
    const base = evaluateContainers([svc, once], "p", false);
    expect(base.failures).toEqual([]);
    expect(base.warnings).toEqual(["s: restarted 1 time(s)"]);
    expect(evaluateContainers([], "p", true).failures).toEqual(["no service containers found for project p"]);
  });

  test("a stopped service and an unhealthy service fail; a service with no healthcheck is fine", () => {
    const base: ContainerState = { name: "s", running: true, health: "healthy", restarts: 0, startedAt: "", oneShot: false, participantKind: null };
    expect(evaluateContainers([{ ...base, running: false }], "p", true).failures).toEqual(["s: not running"]);
    expect(evaluateContainers([{ ...base, health: "unhealthy" }], "p", true).failures).toEqual(["s: health 'unhealthy'"]);
    expect(evaluateContainers([{ ...base, health: "none" }], "p", true).failures).toEqual([]);
  });
});
