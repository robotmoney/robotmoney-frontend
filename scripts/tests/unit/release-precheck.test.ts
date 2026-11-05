// scripts/tests/unit/release-precheck.test.ts — `bun run release:precheck`
// (issue 1563): a release's added version checks, run against the live stage
// stack from a throwaway worktree of the commit, before the full run.
//
// What is pinned, with fake deps (no ssh, no git, no HTTP):
//   - selection: of a runbook with two template steps and three added ones,
//     exactly the three added steps, in runbook order;
//   - exit codes: one added step exiting 1 still runs all three, writes three
//     rows to precheck.json and exits 1; all three exiting 0 exits 0;
//   - refusal: a run in flight, or a commit on no QA branch, exits 2 before
//     any step runs or any worktree is made;
//   - worktree lifecycle: the worktree adds come before the first step and the
//     removes after the last, also when a step fails;
//   - no journal: no run.json is written under the journal root.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReleaseRunbook } from "../../release/runbook.ts";
import { parsePrecheckArgs, runPrecheck, selectPrecheckSteps, type PrecheckDeps, type PrecheckReport } from "../../release/precheck.ts";

const RELEASE = "v0.0.1";
const COMMIT = "a".repeat(40);
const STAGE_HOST = "rm-frontend-stage-2";

const step = (id: string, host: "target" | "control", extra = "") => `
  - id: "${id}"
    standing: ["SV.7"]
    host: "${host}"
    phase: "qa"
    description: "${id}"
    cmds:
      - ["bun", "scripts/release/version-check.ts", "--release", "{release}", "--check", "${id}", "--run", "{runTs}"]
    expectExit: 0
    receipts: []
    irreversible: false
    onlyFor: "stage"
    stageOnly: true${extra}`;

const TEMPLATE = `template: kitchen-sink
steps:${step("Q01-tmpl-one", "control")}${step("Q03-tmpl-two", "target")}
`;

const RUNBOOK = `release: ${RELEASE}
template: kitchen-sink
recovery: "fixture"
scope:
  - {pr: 1, what: "a", check: "Q02-check-a"}
steps:${step("Q01-tmpl-one", "control")}${step("Q02-check-a", "target", `\n    added: "${RELEASE}"`)}${step("Q03-tmpl-two", "target")}${step("Q04-check-b", "control", `\n    added: "${RELEASE}"`)}${step("Q05-check-c", "target", `\n    added: "${RELEASE}"`)}
`;

/** The fixture runbooks, as a worktree of the commit holds them. */
function writeFixture(worktree: string): string {
  const dir = join(worktree, "scripts", "release", "runbooks");
  mkdirSync(join(dir, "templates"), { recursive: true });
  mkdirSync(join(dir, "releases"), { recursive: true });
  writeFileSync(join(dir, "templates", "kitchen-sink.yaml"), TEMPLATE);
  writeFileSync(join(dir, "releases", `${RELEASE}.yaml`), RUNBOOK);
  return dir;
}

function filesNamed(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => p.split("/").pop() === name);
}

interface Fake {
  deps: PrecheckDeps;
  events: string[];
  remotes: string[];
  home: string;
}

/** Fake deps: `failing` names the step ids whose command exits 1; `inFlight` the runs runsInFlight reports. */
function fake(opts: { failing?: string[]; inFlight?: { runTs: string; updatedAt: string }[]; branches?: string } = {}): Fake {
  const home = mkdtempSync(join(tmpdir(), "release-precheck-"));
  const events: string[] = [];
  const remotes: string[] = [];
  const where = (host: string) => (host === STAGE_HOST ? "target" : "control");
  const deps: PrecheckDeps = {
    async exec(host, remote) {
      const id = /--check (\S+)/.exec(remote)?.[1] ?? "?";
      events.push(`step ${id} on ${where(host)}`);
      remotes.push(remote);
      return (opts.failing ?? []).includes(id) ? 1 : 0;
    },
    async collect(host, remote) {
      if (remote.includes("git branch -r --contains")) return { code: 0, stdout: opts.branches ?? "  origin/qa/0.0.x-2026-11-04\n" };
      if (remote.includes("worktree add")) {
        events.push(`worktree add on ${where(host)}`);
        if (where(host) === "control") writeFixture(/worktree add --detach (\S+)/.exec(remote)![1]!.replace(/^'|'$/g, ""));
        return { code: 0, stdout: "" };
      }
      if (remote.includes("worktree remove")) {
        events.push(`worktree remove on ${where(host)}`);
        return { code: 0, stdout: "" };
      }
      if (remote.includes("bun install")) return { code: 0, stdout: "" };
      if (remote.startsWith("cat -- ")) return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    },
    readText(path) {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
    now: () => new Date("2026-11-04T12:00:00Z"),
    log: () => {},
    error: () => {},
    home,
    runsInFlight: () => opts.inFlight ?? [],
  };
  return { deps, events, remotes, home };
}

const ARGV = ["--target", "stage", "--release", RELEASE, "--commit", COMMIT];
const journal = (home: string) => join(home, ".local", "state", "robotmoney-release");

function report(home: string): PrecheckReport {
  const root = journal(home);
  const found = filesNamed(root, "precheck.json");
  expect(found).toHaveLength(1);
  expect(found[0]!).toMatch(/^stage\/precheck-20261104T120000Z\/precheck\.json$/);
  return JSON.parse(readFileSync(join(root, found[0]!), "utf8")) as PrecheckReport;
}

describe("release:precheck selection", () => {
  test("of two template steps and three added steps, it selects exactly the three added, in runbook order", () => {
    const dir = writeFixture(mkdtempSync(join(tmpdir(), "release-precheck-fixture-")));
    const runbook = loadReleaseRunbook(RELEASE, dir);
    expect(runbook.steps.map((s) => s.id)).toEqual(["Q01-tmpl-one", "Q02-check-a", "Q03-tmpl-two", "Q04-check-b", "Q05-check-c"]);
    expect(selectPrecheckSteps(runbook.steps, RELEASE).map((s) => s.id)).toEqual(["Q02-check-a", "Q04-check-b", "Q05-check-c"]);
    expect(selectPrecheckSteps(runbook.steps, "v0.0.2")).toEqual([]);
  });

  test("the run selects the same three, in order, each on its own host", async () => {
    const f = fake();
    expect(await runPrecheck(ARGV, f.deps)).toBe(0);
    expect(f.events.filter((e) => e.startsWith("step "))).toEqual(["step Q02-check-a on target", "step Q04-check-b on control", "step Q05-check-c on target"]);
    // A target step runs from the host's worktree of the commit, a control step from the local one; {runTs} is precheck-<ts>.
    expect(f.remotes[0]).toContain("cd /home/stage-server/stage-target/.local/state/robotmoney-release/stage/precheck-20261104T120000Z/checkout &&");
    expect(f.remotes[1]).toStartWith(`cd ${join(journal(f.home), "stage", "precheck-20261104T120000Z", "checkout")} &&`);
    for (const r of f.remotes) expect(r).toContain("--release v0.0.1 --check");
    for (const r of f.remotes) expect(r).toContain("--run precheck-20261104T120000Z");
  });
});

describe("release:precheck exit codes and precheck.json", () => {
  test("one added step exiting 1: all three run, precheck.json holds three rows, and it exits 1", async () => {
    const f = fake({ failing: ["Q04-check-b"] });
    expect(await runPrecheck(ARGV, f.deps)).toBe(1);
    expect(f.events.filter((e) => e.startsWith("step "))).toHaveLength(3);
    const r = report(f.home);
    expect(r.passed).toBe(false);
    expect(r.steps.map((s) => [s.id, s.ok, s.exit])).toEqual([["Q02-check-a", true, 0], ["Q04-check-b", false, 1], ["Q05-check-c", true, 0]]);
    expect(r.steps[1]!.problems).toEqual(["exit 1, expected 0"]);
    expect(r.steps.every((s) => typeof s.durationMs === "number")).toBe(true);
  });

  test("all three exiting 0: it exits 0 and precheck.json passes", async () => {
    const f = fake();
    expect(await runPrecheck(ARGV, f.deps)).toBe(0);
    const r = report(f.home);
    expect(r.passed).toBe(true);
    expect(r.steps).toHaveLength(3);
    expect(r.runTs).toBe("precheck-20261104T120000Z");
  });
});

describe("release:precheck refusals", () => {
  test("a run in flight exits 2 before any step runs or any worktree is made", async () => {
    const f = fake({ inFlight: [{ runTs: "20261104T100000Z", updatedAt: "2026-11-04T11:59:00Z" }] });
    expect(await runPrecheck(ARGV, f.deps)).toBe(2);
    expect(f.events).toEqual([]);
  });

  test("a commit on no QA branch of the release line exits 2 before any step runs", async () => {
    const f = fake({ branches: "  origin/main\n" });
    expect(await runPrecheck(ARGV, f.deps)).toBe(2);
    expect(f.events).toEqual([]);
  });

  test("production is refused, and the arguments are checked", async () => {
    const f = fake();
    expect(await runPrecheck(["--target", "prod", "--release", RELEASE, "--commit", COMMIT], f.deps)).toBe(2);
    expect(f.events).toEqual([]);
    expect(parsePrecheckArgs(["--target", "stage", "--release", "0.0.1", "--commit", COMMIT])).toHaveProperty("error");
    expect(parsePrecheckArgs(["--target", "stage", "--release", RELEASE, "--commit", "abc"])).toHaveProperty("error");
    expect(parsePrecheckArgs(ARGV)).toEqual({ target: "stage", release: RELEASE, commit: COMMIT });
  });
});

describe("release:precheck worktree lifecycle", () => {
  for (const failing of [[], ["Q05-check-c"]]) {
    test(`the worktree adds come before the first step and the removes after the last${failing.length > 0 ? ", also when a step fails" : ""}`, async () => {
      const f = fake({ failing });
      expect(await runPrecheck(ARGV, f.deps)).toBe(failing.length > 0 ? 1 : 0);
      const firstStep = f.events.findIndex((e) => e.startsWith("step "));
      const lastStep = f.events.findLastIndex((e) => e.startsWith("step "));
      for (const host of ["control", "target"]) {
        expect(f.events.indexOf(`worktree add on ${host}`)).toBeGreaterThanOrEqual(0);
        expect(f.events.indexOf(`worktree add on ${host}`)).toBeLessThan(firstStep);
        expect(f.events.indexOf(`worktree remove on ${host}`)).toBeGreaterThan(lastStep);
      }
    });
  }
});

describe("release:precheck writes no run journal", () => {
  test("no run.json under the journal root, pass or fail", async () => {
    for (const failing of [[], ["Q02-check-a"]]) {
      const f = fake({ failing });
      await runPrecheck(ARGV, f.deps);
      expect(filesNamed(journal(f.home), "precheck.json")).toHaveLength(1);
      expect(filesNamed(journal(f.home), "run.json")).toEqual([]);
    }
  });
});
