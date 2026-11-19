// scripts/tests/unit/release-stage-teardown.test.ts — `bun run release:run`
// tears the stage target down once a stage run's pass is final (issue 1684;
// owner rule: stage stacks come down as soon as the runbook passes, because
// they spend inference credits).
//
// What is pinned, each with a red control, driving runRelease with injected
// deps (no ssh, no docker):
//   - a stage run that ends passed runs `stage-target.ts down` on the control
//     machine once and records stageDown {at, exit} in run.json;
//   - a failed run, a run under --keep-stage and a production run never run it;
//     --keep-stage records stageDown {kept: true};
//   - --accept that turns a stage run passed runs it; a later check-only resume
//     of that passed run (a doc fix after the pass) does not run it again;
//   - a teardown that exits non-zero leaves the run passed, and the stop reason
//     carries the command to run by hand.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qaBranchPrefix, releaseBranch } from "../../release/go.ts";
import type { RunJournal } from "../../release/journal.ts";
import { runRelease, STAGE_DOWN_COMMAND, type RunnerDeps } from "../../release/run.ts";
import { REQUIRED_CI } from "../../release/preflight.ts";
import { runStamp } from "../../release/journal.ts";
import type { StepTemplate } from "../../release/steps.ts";
import { loadTarget } from "../../release/target.ts";

const targetsDir = join(import.meta.dir, "..", "..", "release", "targets");
const RELEASE = loadTarget(join(targetsDir, "prod.json")).release;
const SHA = "a502de30068e0c1cc2e232a76098364e0b709033";
const C2 = "c".repeat(40);
const TREE = "7".repeat(40);
const C2_TREE = "9".repeat(40);
const TAG = `${RELEASE}-rc.0`;
const RUN_TS = "20261008T120000Z";

/** A stage QA step, its production preflight twin's stand-in and a cutover step: the smallest list with every phase. */
const LIST: StepTemplate[] = [
  { id: "Q28-log-verdict", standing: [], description: "stage check", host: "target", phase: "qa", onlyFor: "stage", cmds: [["echo", "Q28-log-verdict"]], expectExit: 0, receipts: [], irreversible: false },
  { id: "P01-checkout", standing: [], description: "preflight", host: "target", phase: "preflight", onlyFor: "prod", cmds: [["echo", "P01-checkout"]], expectExit: 0, receipts: [], irreversible: false },
  { id: "C16-log-verdict", standing: [], description: "production check", host: "target", phase: "cutover", onlyFor: "prod", cmds: [["echo", "C16-log-verdict"]], expectExit: 0, receipts: [], irreversible: false },
];

function fixture(rmEnv: "stage" | "prod" = "stage") {
  const dir = mkdtempSync(join(tmpdir(), "release-teardown-"));
  const raw = JSON.parse(readFileSync(join(targetsDir, `${rmEnv}.json`), "utf8")) as Record<string, unknown>;
  raw.confirmTarget = "db.example.com:25060/rm";
  const targetFile = join(dir, `${rmEnv}.json`);
  writeFileSync(targetFile, JSON.stringify(raw));
  const goFile = join(dir, "go.txt");
  writeFileSync(goFile, `${rmEnv === "prod" ? `tag: ${TAG}` : `commit: ${SHA}`}\noperator: lucas\ndate: 2026-10-14\n`);
  return { dir, targetFile, goFile, journalRoot: join(dir, "journal") };
}

const ANSWERS: Record<string, { code: number; stdout: string }> = {
  "git rev-parse HEAD": { code: 0, stdout: `${SHA}\n` },
  "git status --porcelain": { code: 0, stdout: "" },
  "git branch -r --contains": { code: 0, stdout: `  origin/${releaseBranch(RELEASE)}\n  origin/${qaBranchPrefix(RELEASE)}2026-10-14\n` },
  "^{tree}": { code: 0, stdout: `${TREE}\n` },
  [`git rev-parse --verify --quiet '${TAG}^{commit}'`]: { code: 0, stdout: `${SHA}\n` },
  "gh api": { code: 0, stdout: `${REQUIRED_CI.map((n) => `${n}\tcompleted\tsuccess`).join("\n")}\n` },
  "docker ps -q": { code: 0, stdout: "0\n" },
  "gh issue list --label": { code: 0, stdout: '[{"number":4242}]\n' },
  "stage-target.ts down": { code: 0, stdout: "[stage-target] down\n" },
};

/** Injected deps: every step exits 0 unless named in `fail`; `downs` lists every stage teardown the runner asked for. */
function fakeDeps(opts: { fail?: Set<string>; answers?: Record<string, { code: number; stdout: string }>; at?: string } = {}) {
  const ran: string[] = [];
  const downs: string[] = [];
  const logs: string[] = [];
  const deps: RunnerDeps = {
    async exec(_host, remote) {
      const id = /\.step-([A-Za-z0-9.-]+)/.exec(remote)![1]!;
      ran.push(id);
      return opts.fail?.has(id) ? 1 : 0;
    },
    async collect(_host, remote) {
      if (remote.startsWith("find ")) return { code: 0, stdout: "" };
      if (remote.includes(STAGE_DOWN_COMMAND)) downs.push(remote);
      const hit = Object.keys(opts.answers ?? {}).find((k) => remote.includes(k));
      if (hit !== undefined) return opts.answers![hit]!;
      const base = Object.keys(ANSWERS).find((k) => remote.includes(k));
      return base === undefined ? { code: 1, stdout: "" } : ANSWERS[base]!;
    },
    readText: (p) => {
      if (p.endsWith(`/runbooks/releases/${RELEASE}.yaml`)) return `release: ${RELEASE}\nrecovery: fix forward\n`;
      try { return readFileSync(p, "utf8"); } catch { return undefined; }
    },
    now: () => new Date(opts.at ?? "2026-10-08T12:00:00Z"),
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
    home: "/nonexistent",
    async notify() { return { notified: true, issue: 4242 }; },
  };
  return { deps, ran, downs, logs };
}

const stageRun = (f: ReturnType<typeof fixture>, extra: string[] = []) => ["--target", f.targetFile, "--go", f.goFile, "--journal-root", f.journalRoot, ...extra];
const journalOf = (f: ReturnType<typeof fixture>, target = "stage", ts = RUN_TS) => JSON.parse(readFileSync(join(f.journalRoot, target, ts, "run.json"), "utf8")) as RunJournal;

describe("release:run tears stage down after a final pass (issue 1684)", () => {
  test("a stage run that ends passed runs stage-target.ts down once on the control machine and records stageDown.exit", async () => {
    const f = fixture();
    const d = fakeDeps();
    expect(await runRelease(stageRun(f), d.deps, LIST)).toBe(0);
    expect(d.ran).toEqual(["Q28-log-verdict"]);
    expect(d.downs).toHaveLength(1);
    expect(d.downs[0]).toContain(`&& ${STAGE_DOWN_COMMAND}`);
    const j = journalOf(f);
    expect(j.status).toBe("passed");
    expect(j.stageDown).toEqual({ at: "2026-10-08T12:00:00.000Z", exit: 0 });
    expect(j.stopReason).toMatchObject({ kind: "passed", detail: "the run passed every step" });
  });

  test("red: a stage run that ends failed never runs it", async () => {
    const f = fixture();
    const d = fakeDeps({ fail: new Set(["Q28-log-verdict"]) });
    expect(await runRelease(stageRun(f), d.deps, LIST)).toBe(1);
    expect(d.downs).toEqual([]);
    expect(journalOf(f).stageDown).toBeUndefined();
  });

  test("--keep-stage skips it and records stageDown {kept: true}; a later resume of that run does not tear stage down either", async () => {
    const f = fixture();
    const d = fakeDeps();
    expect(await runRelease(stageRun(f, ["--keep-stage"]), d.deps, LIST)).toBe(0);
    expect(d.downs).toEqual([]);
    expect(journalOf(f).stageDown).toEqual({ kept: true });
    const again = fakeDeps();
    expect(await runRelease(stageRun(f, ["--run", RUN_TS]), again.deps, LIST)).toBe(0);
    expect(again.downs).toEqual([]);
  });

  test("a teardown that exits non-zero leaves the run passed, prints the hand command and notes it in the stop reason", async () => {
    const f = fixture();
    const d = fakeDeps({ answers: { "stage-target.ts down": { code: 1, stdout: "" } } });
    expect(await runRelease(stageRun(f), d.deps, LIST)).toBe(0);
    expect(d.downs).toHaveLength(1);
    const j = journalOf(f);
    expect(j.status).toBe("passed");
    expect(j.stageDown).toEqual({ at: "2026-10-08T12:00:00.000Z", exit: 1 });
    expect(d.logs.join("\n")).toContain(`the run stays passed. Tear stage down by hand:`);
    expect(d.logs.join("\n")).toContain(STAGE_DOWN_COMMAND);
    expect(j.stopReason!.kind).toBe("passed");
    expect(j.stopReason!.detail).toContain(`tear stage down by hand with`);
    expect(j.stopReason!.detail).toContain(STAGE_DOWN_COMMAND);
  });

  test("--accept that turns a stage run passed runs it once; a later check-only resume of the passed run runs no step and does not run it again", async () => {
    const f = fixture();
    expect(await runRelease(stageRun(f), fakeDeps({ fail: new Set(["Q28-log-verdict"]) }).deps, LIST)).toBe(1);
    const acc = fakeDeps();
    expect(await runRelease(["--target", f.targetFile, "--journal-root", f.journalRoot, "--run", RUN_TS, "--accept", "Q28-log-verdict", "--reason", "owner accepts it", "--issue", "1555"], acc.deps, LIST)).toBe(0);
    expect(acc.downs).toHaveLength(1);
    expect(journalOf(f)).toMatchObject({ status: "passed", stageDown: { exit: 0 } });
    // A doc fix after the pass: a new QA commit whose diff is check-only resumes the run in place.
    const go2 = join(f.dir, "go2.txt");
    writeFileSync(go2, `commit: ${C2}\noperator: lucas\ndate: 2026-10-15\n`);
    const later = fakeDeps({
      at: "2026-10-08T15:00:00Z",
      answers: { [`git diff --no-renames --name-only ${SHA} ${C2}`]: { code: 0, stdout: "docs/technical/release-runbooks.md\n" }, [`${C2}^{tree}`]: { code: 0, stdout: `${C2_TREE}\n` } },
    });
    expect(await runRelease(["--target", f.targetFile, "--go", go2, "--journal-root", f.journalRoot, "--run", RUN_TS], later.deps, LIST)).toBe(0);
    expect(later.ran).toEqual([]);
    expect(later.downs).toEqual([]);
    expect(journalOf(f)).toMatchObject({ status: "passed", commit: C2, tree: C2_TREE, stageDown: { exit: 0 } });
  });

  test("red: a production run never runs it, from the preflight through the cutover", async () => {
    const s = fixture();
    expect(await runRelease(stageRun(s), fakeDeps().deps, LIST)).toBe(0);
    const stageDir = join(s.journalRoot, "stage", RUN_TS);
    const p = fixture("prod");
    const pre = fakeDeps();
    expect(await runRelease(["--target", p.targetFile, "--preflight", "--go", p.goFile, "--journal-root", p.journalRoot, "--stage-journal", stageDir], pre.deps, LIST)).toBe(0);
    const cut = fakeDeps();
    const preDir = join(p.journalRoot, "prod", `preflight-${runStamp(new Date("2026-10-08T12:00:00Z"))}`);
    expect(await runRelease(["--target", p.targetFile, "--go", p.goFile, "--journal-root", p.journalRoot, "--stage-journal", stageDir, "--after-preflight", preDir], cut.deps, LIST)).toBe(0);
    expect(cut.ran).toEqual(["C16-log-verdict"]);
    expect([...pre.downs, ...cut.downs]).toEqual([]);
    expect(journalOf(p, "prod").stageDown).toBeUndefined();
  });

  test("--keep-stage parses alone and beside --accept", async () => {
    const { parseArgs } = await import("../../release/run.ts");
    expect(parseArgs(["--target", "stage", "--go", "g", "--keep-stage"])).toMatchObject({ keepStage: true });
    expect(parseArgs(["--target", "stage", "--run", RUN_TS, "--accept", "Q28-log-verdict", "--reason", "x", "--issue", "1", "--keep-stage"])).toMatchObject({ keepStage: true, accept: "Q28-log-verdict" });
    expect(parseArgs(["--target", "stage", "--go", "g"])).not.toHaveProperty("keepStage");
  });
});
