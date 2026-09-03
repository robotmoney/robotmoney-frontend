// Issue #845 — `bun smoke` never granted the judge role or flipped judge
// mode, so the validator/judge flow had unit and DB-integration coverage
// only, never a booted live stack.
//
// THE TWO CALLERS. `--db smoke-twin` REQUIRES `--smoke` (smoke-db-mode.ts),
// so it runs a MATERIALLY DIFFERENT branch than plain `bun smoke` /
// `bun smoke -- --db external`: the `process.env.CI && smokeMode` block in
// scripts/lib/smoke-main.ts drives ONE session straight through `runSession`
// with the restored archive personas, never calling `scripts/lib/swarm/
// session.ts`'s `main()` at all — so the coverage has to be wired at BOTH
// call sites, not just inside `main()`. Both share the grant/flip/assert/
// restore sequence itself (`runJudgeRoleCoverage`, exported from session.ts)
// so there is exactly one implementation of that sequence to get right.
//
// runSession and runJudgeRoleCoverage's effects drive docker, the job queue
// and live inference, so they cannot be executed here (that's what the
// required CI job proves for the demo path — `--db smoke-twin` has no CI job
// at all, see the PR). What CAN be graded hermetically is the SHAPE: that
// each caller wires the grant BEFORE its session runs, targeting a member the
// session's own roster treats as absent. Each grader below is pinned by
// source-text order and red-controlled (same technique
// scripts/tests/unit/swarm-session-judge-step.test.ts uses to pin
// runJudgeStep's position in runSession) so it cannot go vacuously green.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const sessionSrc = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");
const smokeMainSrc = readFileSync(join(repoRoot, "scripts", "lib", "smoke-main.ts"), "utf8");

describe("runJudgeRoleCoverage (scripts/lib/swarm/session.ts) — the shared grant/flip/assert/restore sequence", () => {
  const FN_START = "export async function runJudgeRoleCoverage(";
  const GRANT = 'setMemberRole(memberId, "judge"';
  const FLIP_SHADOW = 'setJudgeMode("shadow"';
  const COUNT_JUDGEMENTS = "countJudgements(judged.sessionId";
  const RESTORE_MODE = "setJudgeMode(restoreJudgeMode";
  const REVOKE = 'setMemberRole(memberId, "member"';

  function order(src: string) {
    const start = src.indexOf(FN_START);
    return {
      fnStart: start,
      grant: src.indexOf(GRANT),
      flip: src.indexOf(FLIP_SHADOW),
      // The session under test is whatever `runJudgedSession()` returns — a
      // caller-supplied callback, not a literal call this function makes.
      count: src.indexOf(COUNT_JUDGEMENTS),
      restore: src.indexOf(RESTORE_MODE),
      revoke: src.indexOf(REVOKE),
    };
  }

  const o = order(sessionSrc);

  test("the function exists and every landmark is present", () => {
    expect(o.fnStart).toBeGreaterThan(-1);
    for (const [name, at] of Object.entries(o)) expect(`${name}:${at >= 0}`).toBe(`${name}:true`);
  });

  test("grant and flip happen BEFORE the judgement count is read", () => {
    expect(o.grant).toBeLessThan(o.count);
    expect(o.flip).toBeLessThan(o.count);
  });

  test("restore and revoke happen AFTER the judgement count is read, inside a finally", () => {
    expect(o.count).toBeLessThan(o.restore);
    expect(o.count).toBeLessThan(o.revoke);
    expect(sessionSrc.slice(o.count, o.restore)).toContain("} finally {");
  });

  test("control: the grader fails on a definition with the grant removed", () => {
    const broken = sessionSrc.replace(GRANT, GRANT.replace("judge", "member"));
    expect(order(broken).grant).toBe(-1);
    expect(sessionSrc.length).toBeGreaterThan(1000); // the scan is over real text
  });
});

describe("session.ts main() wires session 2 through runJudgeRoleCoverage (issue #845)", () => {
  const CALL = 'runJudgeRoleCoverage("draco"';
  const SESSION2 = "runSession(subjects[1], 2,";

  test("main() calls it, immediately wrapping the session-2 runSession call", () => {
    const callAt = sessionSrc.indexOf(CALL);
    const session2At = sessionSrc.indexOf(SESSION2);
    expect(callAt).toBeGreaterThan(-1);
    expect(session2At).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(session2At);
    // No other runSession call sits between the two — session 2 IS the call
    // runJudgeRoleCoverage's callback makes.
    const between = sessionSrc.slice(callAt, session2At);
    expect(between).not.toContain("runSession(");
  });

  test("control: fails if the call is renamed away", () => {
    const broken = sessionSrc.replace(CALL, CALL.replace("runJudgeRoleCoverage", "notRunJudgeRoleCoverage"));
    expect(broken.indexOf(CALL)).toBe(-1);
  });
});

describe("smoke-main.ts's `--smoke` (twin-capable) CI branch wires the SAME coverage (issue #845)", () => {
  // `--db smoke-twin` requires `--smoke`; `if (process.env.CI && smokeMode)`
  // is therefore the ONLY branch that path's `bun run scripts/smoke.ts`
  // invocation reaches — `main()`'s coverage (pinned above) never runs for
  // it. This block exists so removing the twin-side wiring alone still fails
  // a fast hermetic test, not just a live rehearsal nobody runs in CI.
  const smokeModeSrc = readFileSync(join(repoRoot, "scripts", "lib", "smoke-mode.ts"), "utf8");
  const CI_SMOKE_BRANCH = "if (process.env.CI && smokeMode) {";
  const CANDIDATE_CALL = "judgeCoverageCandidate(roster)";
  const ABSENT_CALL = "withMemberAbsent(members, judgeCandidate.id)";
  const COVERAGE_CALL = "session.runJudgeRoleCoverage(judgeCandidate.id";
  const RUN_SESSION = "session.runSession(scenario.subjects[0]!, 1,";

  function sliceOfBranch(src: string): string {
    const start = src.indexOf(CI_SMOKE_BRANCH);
    expect(start).toBeGreaterThan(-1);
    const nextBranch = src.indexOf("if (process.env.CI && !smokeMode)", start);
    expect(nextBranch).toBeGreaterThan(start);
    return src.slice(start, nextBranch);
  }

  const branch = sliceOfBranch(smokeMainSrc);

  test("smoke-mode.ts selects the judge candidate by a stable handle, not roster position", () => {
    expect(smokeModeSrc).toContain('export const JUDGE_COVERAGE_HANDLE = "noop-analyst"');
    expect(smokeModeSrc).toContain("export function judgeCoverageCandidate(");
    expect(smokeModeSrc).toContain("export function withMemberAbsent(");
  });

  test("the branch selects a candidate, marks it absent BEFORE running the session, through runJudgeRoleCoverage", () => {
    const candidateAt = branch.indexOf(CANDIDATE_CALL);
    const absentAt = branch.indexOf(ABSENT_CALL);
    const coverageAt = branch.indexOf(COVERAGE_CALL);
    const runAt = branch.indexOf(RUN_SESSION);
    for (const [name, at] of Object.entries({ candidateAt, absentAt, coverageAt, runAt })) {
      expect(`${name}:${at >= 0}`).toBe(`${name}:true`);
    }
    expect(candidateAt).toBeLessThan(coverageAt);
    expect(coverageAt).toBeLessThan(runAt);
    // The only runSession-family call in this branch is the one inside the
    // coverage callback — no bare, unwrapped call bypasses it.
    expect(branch.indexOf(RUN_SESSION)).toBe(branch.lastIndexOf(RUN_SESSION));
  });

  test("control: the grader fails on a smoke-main.ts with the twin-side wiring removed", () => {
    const broken = smokeMainSrc.replace(COVERAGE_CALL, COVERAGE_CALL.replace("runJudgeRoleCoverage", "runSession"));
    const brokenBranch = sliceOfBranch(broken);
    expect(brokenBranch.indexOf(COVERAGE_CALL)).toBe(-1);
    expect(smokeMainSrc.length).toBeGreaterThan(1000); // the scan is over real text
  });
});
