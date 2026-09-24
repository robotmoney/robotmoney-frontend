// Issue #845 once wired "judge role coverage" into both smoke paths: session.ts
// `main()` granted `themis` the judge role and flipped `swarm_judge_config.mode`
// to `enforce` around session 2, and smoke-main.ts's CI twin branch did the
// same around its one session, each asserting that a MODEL-authored judgement
// landed.
//
// Issue #1026 removes it (D48 as waived by D53, criterion 6). Nothing on a
// booted stack judges inline any more — the judge is a participant (smoke spec
// §6.2) — so no booted stack can produce the row those assertions waited for,
// and the mode flip was the one place a driver manufactured a judge-mode write.
// Judge coverage returns with the participant judge, on the participant's own
// path; until then this file pins the ABSENCE, at both former call sites, so the
// flip cannot quietly come back.
//
// Graded on source text (the sessions drive docker and live inference, so they
// cannot run here), with every grader red-controlled against a planted copy of
// the retired shape so a green result is never vacuous.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const sessionSrc = readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8");
const smokeMainSrc = readFileSync(join(repoRoot, "scripts", "lib", "smoke-main.ts"), "utf8");
const smokeModeSrc = readFileSync(join(repoRoot, "scripts", "lib", "smoke-mode.ts"), "utf8");

/** Code only: comment lines dropped, so prose naming a retired call is not a call. */
function codeOnly(src: string): string {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
}

/** The retired coverage calls a source still makes or declares. */
const RETIRED = [
  "runJudgeRoleCoverage",
  "setJudgeMode",
  "setJudgeModel",
  "enableTwinJudge",
  "setMemberRole",
  "setMemberOperator",
  "judgeCoverageCandidate",
  "withMemberAbsent",
];
function retiredCalls(src: string): string[] {
  const code = codeOnly(src);
  return RETIRED.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(code));
}

describe("session.ts main() runs session 2 plainly — no judge-role grant, no mode flip", () => {
  const SESSION_2 = 'await runSession(subjects[1], 2, { rail, members, initializer: "simulation", cadence });';

  test("session 2 is a bare runSession call, not wrapped in a coverage callback", () => {
    expect(sessionSrc).toContain(SESSION_2);
  });

  test("session.ts declares and calls none of the retired coverage functions", () => {
    expect(retiredCalls(sessionSrc)).toEqual([]);
  });

  test("red control: the retired wrapper shape is caught", () => {
    const planted = sessionSrc.replace(
      SESSION_2,
      'await runJudgeRoleCoverage("themis", rail.automationToken, () =>\n    runSession(subjects[1], 2, { rail, members, initializer: "simulation", cadence }));',
    );
    expect(planted).not.toBe(sessionSrc);
    expect(retiredCalls(planted)).toEqual(["runJudgeRoleCoverage"]);
  });
});

describe("smoke-main.ts's CI dump branch runs one plain session — no judge coverage", () => {
  const CI_DUMP_BRANCH = 'if (process.env.CI && dataPath.kind === "smoke-twin") {';
  const RUN_SESSION = 'await session.runSession(scenario.subjects[0]!, 1, { rail, members, initializer: "adopt", cadence });';

  function sliceOfBranch(src: string): string {
    const start = src.indexOf(CI_DUMP_BRANCH);
    expect(start).toBeGreaterThan(-1);
    const nextBranch = src.indexOf('if (process.env.CI && dataPath.kind !== "smoke-twin")', start);
    expect(nextBranch).toBeGreaterThan(start);
    return src.slice(start, nextBranch);
  }

  test("the branch runs the restored personas through one bare runSession", () => {
    const branch = codeOnly(sliceOfBranch(smokeMainSrc));
    expect(branch).toContain(RUN_SESSION);
    expect(branch.indexOf("runSession(")).toBe(branch.lastIndexOf("runSession("));
  });

  test("smoke-main.ts calls none of the retired coverage functions anywhere", () => {
    expect(retiredCalls(smokeMainSrc)).toEqual([]);
  });

  test("smoke-mode.ts no longer exports the coverage candidate helpers", () => {
    expect(smokeModeSrc).not.toContain("JUDGE_COVERAGE_HANDLE");
    expect(retiredCalls(smokeModeSrc)).toEqual([]);
  });

  test("red control: the retired branch shape is caught", () => {
    const planted = smokeMainSrc.replace(
      RUN_SESSION,
      "const judgeCandidate = judgeCoverageCandidate(roster);\n" +
        "    await session.runJudgeRoleCoverage(judgeCandidate.id, automationToken, () =>\n" +
        '      session.runSession(scenario.subjects[0]!, 1, { rail, members: withMemberAbsent(members, judgeCandidate.id), initializer: "adopt", cadence }));',
    );
    expect(planted).not.toBe(smokeMainSrc);
    expect(retiredCalls(sliceOfBranch(planted))).toEqual(["runJudgeRoleCoverage", "judgeCoverageCandidate", "withMemberAbsent"]);
  });
});
