// Issue 1550: the analyst SDK release runbook and runner (D77, release-runbooks.md §11).
//
// gh is an in-process stub that records argv. git is real, run against a bare
// repository made by mktemp under $HOME/tmp as `origin`: no network, and never
// the GitHub remote.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { releaseRunbookNames } from "../../release/runbook.ts";
import {
  checkBranch, checkReleaseStep, checkTagStep, loadSdkRunbook, matchingPlatformTag, NO_PLATFORM_MATCH, parseSdkRunbook,
  poll, POLL_MS, preflight, PROOFS_STEP, readGate, readTagGuard, renderNotes, runBranch, runReleaseStep, runSdkRelease,
  runTagStep, SDK_RUNBOOK_PATH, type Deps, type ExecResult, type Inputs, type Release,
} from "../../release/sdk-release-lib.ts";

const ROOT = join(import.meta.dir, "../../..");
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

// ── fixtures ─────────────────────────────────────────────────────────────────

const bases: string[] = [];
afterAll(() => { for (const b of bases) rmSync(b, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): ExecResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}
function sh(cwd: string, ...args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

interface Fixture { bare: string; work: string; c1: string; c2: string; commit(version: string, src: string, msg: string): string }

/** origin (bare) with main at c2 (SDK 0.6.0) and analyst-sdk-v0.5.0 at c1, and a work clone. */
function fixture(): Fixture {
  const tmp = join(homedir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  const base = mkdtempSync(join(tmp, "sdk-release-test-"));
  bases.push(base);
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  sh(base, "init", "-q", "--bare", "-b", "main", bare);
  sh(base, "init", "-q", "-b", "main", work);
  sh(work, "remote", "add", "origin", bare);
  const commit = (version: string, src: string, msg: string): string => {
    mkdirSync(join(work, "packages/analyst-sdk/src"), { recursive: true });
    writeFileSync(join(work, "packages/analyst-sdk/package.json"), JSON.stringify({ name: "analyst-sdk", version }));
    writeFileSync(join(work, "packages/analyst-sdk/src/a.ts"), `export const a = ${src};\n`);
    sh(work, "add", "packages");
    sh(work, "commit", "-qm", msg);
    return sh(work, "rev-parse", "HEAD");
  };
  const c1 = commit("0.5.0", "1", "feat(analyst-sdk): one");
  sh(work, "tag", "-a", "analyst-sdk-v0.5.0", "-m", "tag analyst SDK 0.5.0");
  const c2 = commit("0.6.0", "2", "feat(analyst-sdk): two");
  sh(work, "push", "-q", "origin", "main", "refs/tags/analyst-sdk-v0.5.0");
  return { bare, work, c1, c2, commit };
}

const remoteRef = (bare: string, ref: string): string | undefined => {
  const r = git(bare, ["rev-parse", "--verify", "--quiet", ref]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};

interface RunRow { databaseId: number; headSha: string; status: string; conclusion: string }
interface JobRow { name: string; status: string; conclusion: string; steps?: { name: string; status: string; conclusion: string }[] }
interface GhState {
  admin: string;
  runs: Record<string, RunRow[] | (() => RunRow[])>;
  jobs: Record<number, JobRow[]>;
  release: { body: string } | null;
}

/** A gh stub: answers the calls the runner makes from `state`, and records every argv. */
function ghStub(state: GhState, notes: { last?: string }) {
  const calls: string[][] = [];
  const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
  const gh = (args: string[]): ExecResult => {
    calls.push(args);
    if (args[0] === "api") return ok(`${state.admin}\n`);
    if (args[0] === "run" && args[1] === "list") {
      const r = state.runs[args[args.indexOf("--workflow") + 1]!];
      return ok(JSON.stringify(typeof r === "function" ? r() : r ?? []));
    }
    if (args[0] === "run" && args[1] === "view") return ok(JSON.stringify({ jobs: state.jobs[Number(args[2])] ?? [] }));
    if (args[0] === "release" && args[1] === "view") {
      return state.release ? ok(JSON.stringify(state.release)) : { status: 1, stdout: "", stderr: "release not found" };
    }
    if (args[0] === "release" && args[1] === "create") {
      state.release = { body: notes.last ?? "" };
      return ok("");
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const writes = () => calls.filter((c) => c[0] === "release" && (c[1] === "create" || c[1] === "edit"));
  return { gh, calls, writes };
}

const success = (id: number, sha: string): RunRow => ({ databaseId: id, headSha: sha, status: "completed", conclusion: "success" });
const okStep = (name: string) => ({ name, status: "completed", conclusion: "success" });

/** A gh state whose gate is green at `sha` and whose admin read is true. */
function greenGate(sha: string): GhState {
  return {
    admin: "true",
    runs: { "analyst-sdk.yml": [success(1, sha)], "backend.yml": [success(2, sha)] },
    jobs: {
      1: [{ name: "changes", status: "completed", conclusion: "success" }, { name: "analyst-sdk", status: "completed", conclusion: "success" }],
      2: [{ name: "backend", status: "completed", conclusion: "success", steps: [okStep("Run tests (ephemeral Postgres via Docker)"), okStep(PROOFS_STEP)] }],
    },
    release: null,
  };
}

interface Harness { deps: Deps; out: string[]; pushes: string[][]; gh: ReturnType<typeof ghStub>; notes: { last?: string }; sleeps: number[] }

function harness(cwd: string, state: GhState): Harness {
  const notes: { last?: string } = {};
  const g = ghStub(state, notes);
  const out: string[] = [];
  const pushes: string[][] = [];
  const sleeps: number[] = [];
  let now = 0;
  const deps: Deps = {
    git: (args) => {
      if (args[0] === "push") pushes.push(args);
      return git(cwd, args);
    },
    gh: g.gh,
    exec: () => ({ status: 0, stdout: "", stderr: "" }),
    clock: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    writeFile: (_p, text) => { notes.last = text; },
    log: (l) => out.push(l),
  };
  return { deps, out, pushes, gh: g, notes, sleeps };
}

const inputs = (o: Partial<Inputs> = {}): Inputs => ({ dryRun: false, workDir: "/nonexistent", ...o });
const rel = (commit: string, version = "0.6.0"): Release => ({ version, commit, branch: `analyst-sdk/releases-${version.split(".").slice(0, 2).join(".")}.x`, tag: `analyst-sdk-v${version}` });

// ── the runbook and its loader ───────────────────────────────────────────────

describe("the committed runbook", () => {
  test("holds S01-preflight to S06-release in order; S02, S04 and S06 are irreversible", () => {
    const rb = loadSdkRunbook();
    expect(rb.steps.map((s) => s.id)).toEqual(["S01-preflight", "S02-branch", "S03-gate", "S04-tag", "S05-tag-guard", "S06-release"]);
    expect(rb.steps.filter((s) => s.irreversible).map((s) => s.id)).toEqual(["S02-branch", "S04-tag", "S06-release"]);
  });

  test("the platform loader's releaseRunbookNames() does not list it", () => {
    expect(releaseRunbookNames()).not.toContain("analyst-sdk");
    expect(SDK_RUNBOOK_PATH).not.toMatch(/\/(templates|releases)\//);
  });
});

describe("parseSdkRunbook refuses", () => {
  const committed = () => Bun.YAML.parse(readFileSync(SDK_RUNBOOK_PATH, "utf8")) as { runbook: string; steps: Record<string, unknown>[] };
  const refusal = (edit: (doc: ReturnType<typeof committed>) => void): string => {
    const doc = committed();
    edit(doc);
    try {
      parseSdkRunbook(JSON.stringify(doc));
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("the loader accepted it");
  };

  test("an unknown key, naming the step", () => {
    expect(refusal((d) => { d.steps[2]!.onlyFor = "prod"; })).toContain("S03-gate: unknown key onlyFor");
  });
  test("an unknown kind, naming the step", () => {
    expect(refusal((d) => { d.steps[1]!.kind = "deploy"; })).toContain("S02-branch: unknown kind deploy");
  });
  test("a duplicate id, naming the step", () => {
    expect(refusal((d) => { d.steps.push({ ...d.steps[1]!, kind: "cmd", irreversible: false, cmds: [["true"]] }); })).toContain("S02-branch: duplicate id");
  });
  test("a missing built-in kind, naming it", () => {
    expect(refusal((d) => { d.steps.splice(4, 1); })).toContain("no tag-guard step");
  });
  test("tag placed before gate, naming the step", () => {
    expect(refusal((d) => { [d.steps[2], d.steps[3]] = [d.steps[3]!, d.steps[2]!]; })).toContain("S04-tag: the tag step sits before the gate step S03-gate");
  });
  test("release placed before tag-guard, naming the step", () => {
    expect(refusal((d) => { [d.steps[4], d.steps[5]] = [d.steps[5]!, d.steps[4]!]; })).toContain("S06-release: the release step sits before the tag-guard step S05-tag-guard");
  });
  test("a built-in step whose irreversible mark is wrong", () => {
    expect(refusal((d) => { d.steps[3]!.irreversible = false; })).toContain("S04-tag: a tag step is irreversible: true");
  });
  test("an unknown top-level key", () => {
    expect(refusal((d) => { (d as Record<string, unknown>).target = "prod"; })).toContain("unknown key target");
  });
});

// ── S01 preflight ────────────────────────────────────────────────────────────

describe("preflight refuses before any write", () => {
  const refuses = (f: Fixture, state: GhState, inp: Inputs, want: string) => {
    const h = harness(f.work, state);
    const r = preflight(inp, h.deps);
    expect("errors" in r && r.errors.join("\n")).toContain(want);
    expect(h.pushes).toEqual([]);
    expect(h.gh.writes()).toEqual([]);
  };

  test("resolves the version and commit from origin/main when it passes", () => {
    const f = fixture();
    const r = preflight(inputs(), harness(f.work, greenGate(f.c2)).deps);
    expect(r).toEqual({ release: { version: "0.6.0", commit: f.c2, branch: "analyst-sdk/releases-0.6.x", tag: "analyst-sdk-v0.6.0" } });
  });
  test("a version that is not A.B.C", () => {
    const f = fixture();
    refuses(f, greenGate(f.c2), inputs({ version: "0.6" }), "version 0.6 is not A.B.C");
  });
  test("a version not greater than the newest analyst-sdk-v* tag", () => {
    const f = fixture();
    sh(f.work, "push", "-q", "origin", `${f.c1}:refs/tags/analyst-sdk-v0.7.0`);
    refuses(f, greenGate(f.c2), inputs(), "version 0.6.0 is not greater than the tag analyst-sdk-v0.7.0");
  });
  test("package.json at the commit differs from the version", () => {
    const f = fixture();
    refuses(f, greenGate(f.c2), inputs({ version: "0.6.1" }), "says 0.6.0, not 0.6.1");
  });
  test("a commit not on origin/main", () => {
    const f = fixture();
    const off = f.commit("0.6.0", "3", "local only");
    refuses(f, greenGate(off), inputs({ commit: off }), "is not on origin/main");
  });
  test("an operator without the admin permission", () => {
    const f = fixture();
    refuses(f, { ...greenGate(f.c2), admin: "false" }, inputs(), "lacks the admin permission");
  });
});

// ── S02 branch, real git ─────────────────────────────────────────────────────

describe("the branch step against a local bare origin", () => {
  const BR = "refs/heads/analyst-sdk/releases-0.6.x";

  test("creates an absent branch at the commit", () => {
    const f = fixture();
    const h = harness(f.work, greenGate(f.c2));
    expect(checkBranch(rel(f.c2), h.deps).state).toBe("todo");
    expect(runBranch(rel(f.c2), h.deps).state).toBe("done");
    expect(remoteRef(f.bare, BR)).toBe(f.c2);
    expect(h.pushes.some((p) => p.includes("--force") || p.includes("-f") || p.some((a) => a.startsWith("+")))).toBe(false);
  });
  test("fast-forwards a branch whose tip is an ancestor", () => {
    const f = fixture();
    sh(f.work, "push", "-q", "origin", `${f.c1}:${BR}`);
    const h = harness(f.work, greenGate(f.c2));
    const c = checkBranch(rel(f.c2), h.deps);
    expect(c.state).toBe("todo");
    expect(c.detail).toContain("fast-forward");
    expect(runBranch(rel(f.c2), h.deps).state).toBe("done");
    expect(remoteRef(f.bare, BR)).toBe(f.c2);
  });
  test("makes no push when the tip equals the commit", async () => {
    const f = fixture();
    sh(f.work, "push", "-q", "origin", `${f.c2}:${BR}`);
    const state = greenGate(f.c2);
    state.runs["analyst-sdk.yml"] = [{ ...success(1, f.c2), conclusion: "failure" }];
    const h = harness(f.work, state);
    expect(await runSdkRelease(loadSdkRunbook(), inputs(), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain("[S02-branch] already done");
    expect(h.out.join("\n")).toContain("FAILED at S03-gate");
    expect(h.pushes).toEqual([]);
  });
  test("refuses a tip that is not an ancestor, leaving the remote ref unchanged", () => {
    const f = fixture();
    sh(f.work, "checkout", "-q", "-b", "side", f.c1);
    const side = f.commit("0.6.0", "9", "side");
    sh(f.work, "checkout", "-q", "main");
    sh(f.work, "push", "-q", "origin", `${side}:${BR}`);
    const h = harness(f.work, greenGate(f.c2));
    const c = checkBranch(rel(f.c2), h.deps);
    expect(c.state).toBe("failed");
    expect(c.detail).toContain("not an ancestor");
    expect(remoteRef(f.bare, BR)).toBe(side);
    expect(h.pushes).toEqual([]);
  });
});

// ── S03 gate and S05 tag guard ───────────────────────────────────────────────

describe("the gate", () => {
  const SHA = "a".repeat(40);
  const R = rel(SHA);
  const read = (state: GhState) => {
    const h = harness(ROOT, state);
    return { r: readGate(R, h.deps), h };
  };

  test("passes when both jobs and the proofs step concluded success on push runs of the branch at the commit", () => {
    const { r, h } = read(greenGate(SHA));
    expect(r.state).toBe("pass");
    const lists = h.gh.calls.filter((c) => c[0] === "run" && c[1] === "list");
    expect(lists.map((c) => c[c.indexOf("--workflow") + 1])).toEqual(["analyst-sdk.yml", "backend.yml"]);
    for (const c of lists) {
      expect(c[c.indexOf("--branch") + 1]).toBe("analyst-sdk/releases-0.6.x");
      expect(c[c.indexOf("--commit") + 1]).toBe(SHA);
      expect(c[c.indexOf("--event") + 1]).toBe("push");
    }
  });
  test("a skipped job fails it", () => {
    const s = greenGate(SHA);
    s.jobs[1] = [{ name: "analyst-sdk", status: "completed", conclusion: "skipped" }];
    expect(read(s).r).toMatchObject({ state: "fail", detail: expect.stringContaining("skipped") });
  });
  test("a missing proofs step fails it", () => {
    const s = greenGate(SHA);
    s.jobs[2] = [{ name: "backend", status: "completed", conclusion: "success", steps: [okStep("Run tests (ephemeral Postgres via Docker)")] }];
    expect(read(s).r).toMatchObject({ state: "fail", detail: expect.stringContaining(PROOFS_STEP) });
  });
  test("a failed run fails it at once, with no wait", async () => {
    const s = greenGate(SHA);
    s.runs["backend.yml"] = [{ ...success(2, SHA), conclusion: "failure" }];
    const h = harness(ROOT, s);
    const r = await poll(() => readGate(R, h.deps), 90, h.deps, "S03-gate", "rerun-cmd");
    expect(r.state).toBe("failed");
    expect(h.sleeps).toEqual([]);
  });
  test("a run on another commit fails it", () => {
    const s = greenGate(SHA);
    s.runs["analyst-sdk.yml"] = [success(1, "b".repeat(40))];
    expect(read(s).r).toMatchObject({ state: "fail", detail: expect.stringContaining("not " + SHA) });
  });
  test("an in-progress run waits, then passes once it concludes success", async () => {
    const s = greenGate(SHA);
    let n = 0;
    s.runs["analyst-sdk.yml"] = () => (n++ < 2 ? [{ ...success(1, SHA), status: "in_progress", conclusion: "" }] : [success(1, SHA)]);
    const h = harness(ROOT, s);
    const r = await poll(() => readGate(R, h.deps), 90, h.deps, "S03-gate", "rerun-cmd");
    expect(r.state).toBe("done");
    expect(h.sleeps).toEqual([POLL_MS, POLL_MS]);
  });
  test("maxMinutes elapsed on the stubbed clock fails with the rerun command", async () => {
    const s = greenGate(SHA);
    s.runs["backend.yml"] = [];
    const h = harness(ROOT, s);
    const r = await poll(() => readGate(R, h.deps), 2, h.deps, "S03-gate", "bun --no-env-file scripts/release/sdk-release.ts --version 0.6.0");
    expect(r.state).toBe("failed");
    expect(r.detail).toContain("still waiting after 2 minutes");
    expect(r.detail).toContain("rerun: bun --no-env-file scripts/release/sdk-release.ts --version 0.6.0");
    expect(h.sleeps.length).toBe((2 * 60_000) / POLL_MS);
  });
  test("the tag guard reads the analyst-sdk-tag-guard push run for the tag", () => {
    const s = greenGate(SHA);
    s.runs["analyst-sdk-tag-guard.yml"] = [success(3, SHA)];
    const h = harness(ROOT, s);
    expect(readTagGuard(R, h.deps).state).toBe("pass");
    const c = h.gh.calls.find((x) => x.includes("analyst-sdk-tag-guard.yml"))!;
    expect(c[c.indexOf("--branch") + 1]).toBe("analyst-sdk-v0.6.0");
  });
  test("backend.yml has a step named exactly the gate's proofs-step constant", () => {
    const wf = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/backend.yml"), "utf8")) as { jobs: Record<string, { steps: { name?: string }[] }> };
    expect(wf.jobs.backend!.steps.map((s) => s.name)).toContain(PROOFS_STEP);
    const sdk = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/analyst-sdk.yml"), "utf8")) as { jobs: Record<string, unknown> };
    expect(Object.keys(sdk.jobs)).toContain("analyst-sdk");
  });
});

// ── S04 tag, real git ────────────────────────────────────────────────────────

describe("the tag step against a local bare origin", () => {
  const BR = "refs/heads/analyst-sdk/releases-0.6.x";
  const TAG = "refs/tags/analyst-sdk-v0.6.0";

  test("pushes an annotated tag whose peeled commit is the commit", () => {
    const f = fixture();
    sh(f.work, "push", "-q", "origin", `${f.c2}:${BR}`);
    const h = harness(f.work, greenGate(f.c2));
    expect(checkTagStep(rel(f.c2), h.deps).state).toBe("todo");
    expect(runTagStep(rel(f.c2), h.deps)).toMatchObject({ state: "done" });
    expect(sh(f.bare, "cat-file", "-t", TAG)).toBe("tag");
    expect(sh(f.bare, "rev-parse", `${TAG}^{commit}`)).toBe(f.c2);
    expect(sh(f.bare, "for-each-ref", "--format=%(contents:subject)", TAG)).toBe("tag analyst SDK 0.6.0");
  });
  test("a tag already at the commit is done, with no push", () => {
    const f = fixture();
    sh(f.work, "tag", "-a", "analyst-sdk-v0.6.0", f.c2, "-m", "x");
    sh(f.work, "push", "-q", "origin", TAG);
    const h = harness(f.work, greenGate(f.c2));
    expect(checkTagStep(rel(f.c2), h.deps).state).toBe("done");
    expect(h.pushes).toEqual([]);
  });
  test("a tag at another commit refuses", () => {
    const f = fixture();
    sh(f.work, "push", "-q", "origin", `${f.c1}:${TAG}`);
    const r = checkTagStep(rel(f.c2), harness(f.work, greenGate(f.c2)).deps);
    expect(r.state).toBe("failed");
    expect(r.detail).toContain(`not ${f.c2}`);
  });
  test("a checkTag refusal (a version mismatch) blocks the push", () => {
    const f = fixture();
    sh(f.work, "push", "-q", "origin", `${f.c2}:refs/heads/analyst-sdk/releases-0.6.x`);
    const h = harness(f.work, greenGate(f.c2));
    const r = runTagStep(rel(f.c2, "0.6.1"), h.deps);
    expect(r.state).toBe("failed");
    expect(r.detail).toContain("differs");
    expect(h.pushes).toEqual([]);
    expect(remoteRef(f.bare, "refs/tags/analyst-sdk-v0.6.1")).toBeUndefined();
  });
});

// ── S06 release and its notes ────────────────────────────────────────────────

describe("the release notes", () => {
  const base = { version: "0.6.0", tag: "analyst-sdk-v0.6.0", previousTag: "analyst-sdk-v0.5.0", changes: ["feat(analyst-sdk): two"] };

  test("carry the three D77 (3) items, the change list and the install command", () => {
    const n = renderNotes({ ...base, platformTag: "v0.7.0", prose: "Operator prose." });
    for (const s of ["format 1", "byte for byte", "up to rounding", "platform tag v0.7.0", "## Changes since analyst-sdk-v0.5.0", "- feat(analyst-sdk): two", "git clone --branch analyst-sdk-v0.6.0 --depth 1"]) {
      expect(n).toContain(s);
    }
    expect(n.indexOf("Operator prose.")).toBeLessThan(n.indexOf("## Changes"));
    expect(n).not.toContain(NO_PLATFORM_MATCH);
  });
  test("say no platform tag matches when none does", () => {
    expect(renderNotes(base)).toContain(NO_PLATFORM_MATCH);
  });
  test("name the newest platform tag whose packages/analyst-sdk/src tree equals the commit's", () => {
    const f = fixture();
    const deps = harness(f.work, greenGate(f.c2)).deps;
    sh(f.work, "tag", "v0.8.0", f.c1);
    expect(matchingPlatformTag(deps, f.c2)).toBeUndefined();
    sh(f.work, "tag", "-a", "v0.7.0", f.c2, "-m", "v0.7.0");
    sh(f.work, "tag", "v0.6.9", f.c2);
    sh(f.work, "tag", "v0.9.0-rc.0", f.c2);
    expect(matchingPlatformTag(deps, f.c2)).toBe("v0.7.0");
  });
});

describe("the release step", () => {
  const releaseArgs = (h: Harness) => h.gh.writes()[0]!;

  test("creates the release with --latest when this is the highest SDK version, with the change list since the previous tag", () => {
    const f = fixture();
    const h = harness(f.work, greenGate(f.c2));
    expect(runReleaseStep(rel(f.c2), inputs({ workDir: "/w" }), h.deps).state).toBe("done");
    const a = releaseArgs(h);
    expect(a.slice(0, 6)).toEqual(["release", "create", "analyst-sdk-v0.6.0", "--verify-tag", "--title", "analyst SDK 0.6.0"]);
    expect(a[a.indexOf("--notes-file") + 1]).toBe("/w/analyst-sdk-v0.6.0-notes.md");
    expect(a).toContain("--latest");
    expect(h.notes.last).toContain("## Changes since analyst-sdk-v0.5.0");
    expect(h.notes.last).toContain("- feat(analyst-sdk): two");
    expect(h.notes.last).not.toContain("feat(analyst-sdk): one");
  });
  test("does not pass --latest when a higher SDK version exists", () => {
    const f = fixture();
    sh(f.work, "push", "-q", "origin", `${f.c1}:refs/tags/analyst-sdk-v0.7.0`);
    const h = harness(f.work, greenGate(f.c2));
    runReleaseStep(rel(f.c2), inputs(), h.deps);
    expect(releaseArgs(h)).not.toContain("--latest");
  });
  test("an existing release with all three items is done, with no gh write", () => {
    const s = greenGate("a".repeat(40));
    s.release = { body: renderNotes({ version: "0.6.0", tag: "analyst-sdk-v0.6.0", changes: [] }) };
    const h = harness(ROOT, s);
    expect(checkReleaseStep(rel("a".repeat(40)), h.deps).state).toBe("done");
    expect(h.gh.writes()).toEqual([]);
  });
  test("an existing release lacking an item fails, and nothing edits it", () => {
    const s = greenGate("a".repeat(40));
    s.release = { body: "Reads format 1. Replays byte for byte." };
    const h = harness(ROOT, s);
    const r = checkReleaseStep(rel("a".repeat(40)), h.deps);
    expect(r.state).toBe("failed");
    expect(r.detail).toContain("item 2");
    expect(r.detail).toContain("item 3");
    expect(h.gh.writes()).toEqual([]);
  });
});

// ── the runner: dry run and resume ───────────────────────────────────────────

describe("the runner", () => {
  test("--dry-run prints every step id with its IRREVERSIBLE marks, and pushes and creates nothing", async () => {
    const f = fixture();
    const state = greenGate(f.c2);
    state.runs = {};
    const h = harness(f.work, state);
    expect(await runSdkRelease(loadSdkRunbook(), inputs({ dryRun: true }), h.deps)).toBe(0);
    const out = h.out.join("\n");
    for (const id of ["S01-preflight", "S02-branch", "S03-gate", "S04-tag", "S05-tag-guard", "S06-release"]) expect(out).toContain(id);
    const marked = h.out.filter((l) => l.includes("IRREVERSIBLE") && /^\s+S\d{2}-/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
    expect(marked).toEqual(["S02-branch", "S04-tag", "S06-release"]);
    expect(h.pushes).toEqual([]);
    expect(h.gh.writes()).toEqual([]);
    expect(remoteRef(f.bare, "refs/heads/analyst-sdk/releases-0.6.x")).toBeUndefined();
  });

  test("resume: a run stopped at S05 on a failed guard run reruns only the S06 write", async () => {
    const f = fixture();
    const state = greenGate(f.c2);
    state.runs["analyst-sdk-tag-guard.yml"] = [{ ...success(3, f.c2), conclusion: "failure" }];
    const first = harness(f.work, state);
    expect(await runSdkRelease(loadSdkRunbook(), inputs(), first.deps)).toBe(1);
    const out1 = first.out.join("\n");
    expect(out1).toContain("FAILED at S05-tag-guard");
    expect(out1).toContain(`rerun: bun --no-env-file scripts/release/sdk-release.ts --version 0.6.0 --commit ${f.c2}`);
    expect(first.pushes.length).toBe(2);
    expect(first.gh.writes()).toEqual([]);

    state.runs["analyst-sdk-tag-guard.yml"] = [success(3, f.c2)];
    const second = harness(f.work, state);
    expect(await runSdkRelease(loadSdkRunbook(), inputs({ version: "0.6.0", commit: f.c2 }), second.deps)).toBe(0);
    const out2 = second.out.join("\n");
    for (const id of ["S02-branch", "S03-gate", "S04-tag"]) expect(out2).toContain(`[${id}] already done`);
    expect(second.pushes).toEqual([]);
    expect(second.gh.writes().length).toBe(1);
    expect(second.gh.writes()[0]!.slice(0, 3)).toEqual(["release", "create", "analyst-sdk-v0.6.0"]);
    expect(remoteRef(f.bare, "refs/heads/analyst-sdk/releases-0.6.x")).toBe(f.c2);
    expect(sh(f.bare, "rev-parse", "refs/tags/analyst-sdk-v0.6.0^{commit}")).toBe(f.c2);
  });
});
