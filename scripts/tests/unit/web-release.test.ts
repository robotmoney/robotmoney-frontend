// Issue 1561: the web content release runbook and runner (D81, release-runbooks.md §12).
//
// git is real, run against a bare repository made by mktemp under $HOME/tmp as
// `origin`: no network, and never the GitHub remote. gh, ssh and http are
// in-process stubs that record every call. The ssh stub is a fake production
// host: it keeps a checkout HEAD, the served site and the web receipt, and
// answers the commands W06 to W08 send the way the real host would.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { releaseRunbookNames, TEMPLATE_NAMES } from "../../release/runbook.ts";
import { loadTarget } from "../../release/target.ts";
import { parseArgs } from "../../release/web-release.ts";
import {
  classifyContentDiff, GATE_RUNS, isCommentOnlyChange, isDocPath, isTestPath, loadWebRunbook, parseWebRunbook, preflight, rerunCommand, runWebRelease, siteIdIs,
  WEB_RUNBOOK_PATH, webTargetOf,
  type Deps, type ExecResult, type Inputs, type WebTarget,
} from "../../release/web-release-lib.ts";

// Each case drives real git (clones, cherry-picks, worktrees); a loaded runner needs more than 5 s.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "../../..");
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const PROD: WebTarget = webTargetOf(loadTarget(join(ROOT, "scripts/release/targets/prod.json")));
const ORIGIN = PROD.publicOrigin;

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

const pkg = (version: string): string => `${JSON.stringify({ name: "@robotmoney/web-client", version, apiRange: "^0.5.0" })}\n`;

interface Fixture {
  base: string; bare: string; work: string; workDir: string;
  /** r0 the root; c0 production's API commit, tagged v0.7.0. */
  r0: string; c0: string;
  /** Main after c0: mx and mconf edit the same line; m1 copy; m2 the 0.2.0 bump; mb a backend change. */
  mx: string; m1: string; m2: string; mb: string; mconf: string;
  commit(msg: string, files: Record<string, string>): string;
  refs(): string;
}

function fixture(): Fixture {
  const tmp = join(homedir(), "tmp");
  mkdirSync(tmp, { recursive: true });
  const base = mkdtempSync(join(tmp, "web-release-test-"));
  bases.push(base);
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  const workDir = join(base, "run");
  mkdirSync(workDir);
  sh(base, "init", "-q", "--bare", "-b", "main", bare);
  sh(base, "init", "-q", "-b", "main", work);
  sh(work, "remote", "add", "origin", bare);
  const commit = (msg: string, files: Record<string, string>): string => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, p)), { recursive: true });
      writeFileSync(join(work, p), text);
      sh(work, "add", p);
    }
    sh(work, "commit", "-qm", msg);
    return sh(work, "rev-parse", "HEAD");
  };
  const r0 = commit("chore: root", {
    "frontend/package.json": pkg("0.1.0"), "frontend/public/index.html": "home\n", "frontend/public/a.txt": "orig\n", "backend/src/a.ts": "export const a = 1;\n",
    "backend/src/b.ts": "// b: the member page reads it\nexport const b = 1;\n", "scripts/tests/unit/b.test.js": "v1\n", "docs/b.md": "v1\n",
  });
  const c0 = commit("feat(api): platform", { "backend/src/a.ts": "export const a = 2;\n" });
  sh(work, "tag", "-a", "v0.7.0", "-m", "v0.7.0");
  const mx = commit("feat(web): x", { "frontend/public/a.txt": "x\n" });
  const m1 = commit("feat(web): copy", { "frontend/public/index.html": "home v2\n" });
  const m2 = commit("chore(web): 0.2.0", { "frontend/package.json": pkg("0.2.0") });
  const mb = commit("feat(api): backend", { "backend/src/a.ts": "export const a = 3;\n" });
  const mconf = commit("feat(web): y", { "frontend/public/a.txt": "y\n" });
  sh(work, "push", "-q", "origin", "main", "refs/tags/v0.7.0");
  const refs = () => sh(bare, "for-each-ref", "--format=%(refname) %(objectname)");
  return { base, bare, work, workDir, r0, c0, mx, m1, m2, mb, mconf, commit, refs };
}

/** Push a commit made off main as `branch` (and optionally an annotated tag), then put the work clone back on main. */
function sideBranch(f: Fixture, from: string, branch: string, files: Record<string, string>, tag?: string): string {
  sh(f.work, "checkout", "-q", "-b", `side-${branch.replace(/\//g, "-")}`, from);
  const c = f.commit(`side ${branch}`, files);
  const refs = [`${c}:refs/heads/${branch}`];
  if (tag) { sh(f.work, "tag", "-a", tag, c, "-m", tag); refs.push(`refs/tags/${tag}`); }
  sh(f.work, "push", "-q", "origin", ...refs);
  sh(f.work, "checkout", "-q", "main");
  return c;
}

type Ci = "success" | "failure" | "none" | "running";
/** The fake run id gh reports for each workflow's push run. */
const RUN_IDS: Record<string, number> = { "web-client.yml": 7, "e2e-web.yml": 8, "web-tag-guard.yml": 9 };
interface State {
  apiCommit: string;
  ci: Record<string, Ci>;
  admin: string;
  release: boolean;
  /** The fake host. */
  head?: string; installed: boolean;
  live: { version: string; commit: string };
  prevLive?: { version: string; commit: string };
  receipt: string;
  failRoute?: string;
  apiId: string;
}

interface Harness {
  deps: Deps; out: string[]; pushes: string[][]; ghCalls: string[][]; ssh: string[]; http: string[]; files: Map<string, string>; state: State;
}

const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>https://robotmoney.network/</loc></url><url><loc>https://robotmoney.network/swarm</loc></url></urlset>`;

function harness(f: Fixture, state: Partial<State> = {}): Harness {
  const s: State = { apiCommit: f.c0, ci: {}, admin: "true", release: false, installed: false, live: { version: "0.1.0", commit: f.c0.slice(0, 9) }, receipt: "", apiId: "api-1", ...state };
  const out: string[] = [];
  const pushes: string[][] = [];
  const ghCalls: string[][] = [];
  const sshCalls: string[] = [];
  const httpCalls: string[] = [];
  const files = new Map<string, string>();
  let now = 0;
  const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
  const gh = (args: string[]): ExecResult => {
    ghCalls.push(args);
    if (args[0] === "api") return ok(`${s.admin}\n`);
    if (args[0] === "run" && args[1] === "list") {
      const wf = args[args.indexOf("--workflow") + 1]!;
      const sha = args[args.indexOf("--commit") + 1]!;
      const c = s.ci[wf] ?? "success";
      const id = RUN_IDS[wf] ?? 7;
      if (c === "running") return ok(JSON.stringify([{ databaseId: id, headSha: sha, status: "in_progress", conclusion: "" }]));
      return ok(JSON.stringify(c === "none" ? [] : [{ databaseId: id, headSha: sha, status: "completed", conclusion: c }]));
    }
    if (args[0] === "run" && args[1] === "view") {
      const wf = Object.entries(RUN_IDS).find(([, id]) => String(id) === args[2])?.[0] ?? "";
      const job = GATE_RUNS.find((g) => g.workflow === wf)?.job ?? "guard";
      return ok(JSON.stringify({ jobs: [{ name: job, status: "completed", conclusion: "success" }] }));
    }
    if (args[0] === "release" && args[1] === "view") return s.release ? ok("{}") : { status: 1, stdout: "", stderr: "release not found" };
    if (args[0] === "release" && args[1] === "create") { s.release = true; return ok(); }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const ssh = async (_host: string, remote: string): Promise<ExecResult> => {
    sshCalls.push(remote);
    if (remote.includes("web/receipt.json")) return ok(s.receipt);
    if (remote.includes("stack-state.json")) return ok(JSON.stringify({ project: "rm_prod_stack" }));
    if (remote.includes("docker ps")) return ok(`api\t${s.apiId}\nworker-analytics\tw-1\nwebsite-server\tweb-1\n`);
    if (remote.includes("--rollback")) {
      const from = `${s.live.version}-${s.live.commit}`;
      s.live = s.prevLive!;
      s.receipt = JSON.stringify({ action: "rollback", siteId: `${s.live.version}-${s.live.commit}`, previous: from });
      return ok();
    }
    if (remote.includes("smoke:web")) {
      s.prevLive = s.live;
      const version = (JSON.parse(sh(f.work, "show", `${s.head}:frontend/package.json`)) as { version: string }).version;
      s.live = { version, commit: s.head!.slice(0, 9) };
      s.receipt = JSON.stringify({ action: "deploy", siteId: `${version}-${s.head!.slice(0, 9)}`, previous: null });
      return ok();
    }
    if (remote.includes("bun install --frozen-lockfile")) {
      const tag = /refs\/tags\/(web-v[0-9.]+)/.exec(remote)![1]!;
      s.head = sh(f.bare, "rev-parse", `refs/tags/${tag}^{commit}`);
      s.installed = true;
      return ok();
    }
    if (remote.includes("rev-parse HEAD")) return ok(s.head ? `${s.head}\n${s.installed ? "installed\n" : ""}` : "");
    return { status: 1, stdout: "", stderr: `unexpected ssh ${remote}` };
  };
  const http = async (url: string) => {
    httpCalls.push(url);
    const path = url.slice(ORIGIN.length);
    if (path === "/api/version") return { status: 200, body: JSON.stringify({ api: "0.5.0", commit: s.apiCommit }) };
    if (path === "/version.json") return { status: 200, body: JSON.stringify({ ...s.live, apiRange: "^0.5.0" }) };
    if (path === "/sitemap.xml") return { status: 200, body: SITEMAP };
    return { status: path === s.failRoute ? 500 : 200, body: "<html>" };
  };
  const deps: Deps = {
    git: (args) => {
      if (args[0] === "push") pushes.push(args);
      return git(f.work, args);
    },
    gh,
    exec: () => ({ status: 1, stdout: "", stderr: "no exec" }),
    ssh,
    http,
    readFile: (p) => files.get(p),
    writeFile: (p, text) => { files.set(p, text); },
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    log: (l) => out.push(l),
  };
  return { deps, out, pushes, ghCalls, ssh: sshCalls, http: httpCalls, files, state: s };
}

const inputs = (f: Fixture, commits: string[], o: Partial<Inputs> = {}): Inputs => ({ commits, target: PROD, dryRun: false, workDir: f.workDir, ...o });
const errorsOf = (r: Awaited<ReturnType<typeof preflight>>): string => ("errors" in r ? r.errors.join("\n") : "");
const runbook = loadWebRunbook();
const remoteRef = (f: Fixture, ref: string): string | undefined => {
  const r = git(f.bare, ["rev-parse", "--verify", "--quiet", ref]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
/** ssh commands that change the host: a clone, a checkout, an install, a deploy or a rollback. */
const hostWrites = (h: Harness): string[] => h.ssh.filter((c) => /smoke:web|git clone|checkout --quiet --detach|bun install/.test(c));
const ghWrites = (h: Harness): string[][] => h.ghCalls.filter((c) => c[0] === "release" && c[1] !== "view");

// ── the runbook and its loader ───────────────────────────────────────────────

describe("the committed runbook", () => {
  test("holds W01-preflight to W09-release in order; W02, W04, W07 and W09 are irreversible", () => {
    expect(runbook.steps.map((s) => s.id)).toEqual([
      "W01-preflight", "W02-branch", "W03-gate", "W04-tag", "W05-tag-guard", "W06-checkout", "W07-deploy", "W08-live-check", "W09-release",
    ]);
    expect(runbook.steps.filter((s) => s.irreversible).map((s) => s.id)).toEqual(["W02-branch", "W04-tag", "W07-deploy", "W09-release"]);
  });

  test("sits outside templates/ and releases/, so the platform loader never reads it", () => {
    expect(WEB_RUNBOOK_PATH).not.toMatch(/\/(templates|releases)\//);
    expect(releaseRunbookNames()).not.toContain("web-content");
    expect([...TEMPLATE_NAMES]).toEqual(["kitchen-sink"]);
  });
});

describe("parseWebRunbook refuses", () => {
  const committed = () => Bun.YAML.parse(readFileSync(WEB_RUNBOOK_PATH, "utf8")) as { runbook: string; steps: Record<string, unknown>[] };
  const refusal = (edit: (doc: ReturnType<typeof committed>) => void): string => {
    const doc = committed();
    edit(doc);
    try {
      parseWebRunbook(JSON.stringify(doc));
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("the loader accepted it");
  };
  test("an unknown key, naming the step", () => {
    expect(refusal((d) => { d.steps[2]!.cmds = [["true"]]; })).toContain("W03-gate: unknown key cmds");
  });
  test("an unknown kind", () => {
    expect(refusal((d) => { d.steps[5]!.kind = "migrate"; })).toContain("W06-checkout: unknown kind migrate");
  });
  test("an id outside the W<nn>-<name> shape, and a duplicate id", () => {
    expect(refusal((d) => { d.steps[1]!.id = "S02-branch"; })).toContain("S02-branch: id is W<two digits>-<name>");
    expect(refusal((d) => { d.steps[2]!.id = "W02-branch"; })).toContain("W02-branch: duplicate id");
  });
  test("a wrong irreversible mark", () => {
    expect(refusal((d) => { d.steps[6]!.irreversible = false; })).toContain("W07-deploy: a deploy step is irreversible: true");
  });
  test("a polling step without maxMinutes, and maxMinutes on another kind", () => {
    expect(refusal((d) => { delete d.steps[2]!.maxMinutes; })).toContain("W03-gate: a gate step names maxMinutes");
    expect(refusal((d) => { d.steps[6]!.maxMinutes = 5; })).toContain("W07-deploy: only a gate or tag-guard step carries maxMinutes");
  });
  test("the deploy before the tag", () => {
    expect(refusal((d) => { [d.steps[3], d.steps[6]] = [d.steps[6]!, d.steps[3]!]; })).toContain("each once, in that order");
  });
  test("another runbook name", () => {
    expect(refusal((d) => { d.runbook = "kitchen-sink"; })).toContain("runbook is web-content");
  });
});

// ── the classifier ───────────────────────────────────────────────────────────

describe("classifyContentDiff", () => {
  test("a diff limited to frontend/public/** and frontend/package.json is eligible", () => {
    expect(classifyContentDiff(["frontend/public/index.html", "frontend/public/assets/js/app/seo.js", "frontend/package.json"])).toEqual({ eligible: true, offending: [] });
  });
  test("the site build scripts are content (owner, 2026-11-04)", () => {
    expect(classifyContentDiff(["scripts/static-assembly.sh", "scripts/prerender.ts", "scripts/lib/stamp-assets.ts", "scripts/web-client/version.ts"]).eligible).toBe(true);
  });
  test("every offending path is returned, sorted, once", () => {
    const r = classifyContentDiff([
      "frontend/public/index.html", "frontend/package.json", "website-server/nginx.conf", "backend/src/api/index.ts", "contract/src/routes.js",
      "bun.lock", "docker-compose.yml", "backend/src/api/index.ts",
    ]);
    expect(r).toEqual({ eligible: false, offending: ["backend/src/api/index.ts", "bun.lock", "contract/src/routes.js", "docker-compose.yml", "website-server/nginx.conf"] });
  });
  test("a path that only shares a prefix with a content path is not content", () => {
    expect(classifyContentDiff(["frontend-old/x.html", "scripts/prerender.ts.bak"]).offending).toEqual(["frontend-old/x.html", "scripts/prerender.ts.bak"]);
  });
});

describe("the CLI and the target", () => {
  test("--commit repeats in order; --target is prod or stage; a commit is required", () => {
    expect(parseArgs(["--commit", "a", "--commit", "b", "--target", "stage", "--dry-run"])).toEqual({ commits: ["a", "b"], target: "stage", dryRun: true });
    expect(parseArgs(["--target", "prod"])).toEqual({ error: "name at least one --commit" });
    expect(parseArgs(["--commit", "a", "--target", "dev"])).toEqual({ error: "--target is prod or stage" });
    expect(parseArgs(["--commit", "--dry-run"])).toEqual({ error: "--commit needs a sha" });
  });
  test("the web target reads the platform target file with no new key: {home}/rm-web on the same host", () => {
    expect(PROD).toMatchObject({ host: "rm-frontend-prod-1", home: "/root", instance: "rm_prod", checkout: "/root/rm-web", stateRoot: "/root/.local/state/robotmoney-smoke", env: {} });
  });
  test("the rerun command repeats every --commit", () => {
    expect(rerunCommand({ commits: ["a", "b"], target: PROD, dryRun: false, workDir: "/x" })).toBe("bun run release:web --commit a --commit b");
  });
  test("a site id names a version at a commit by its short sha", () => {
    expect(siteIdIs("0.2.0-abc1234", "0.2.0", "abc1234ffff")).toBe(true);
    expect(siteIdIs("0.2.0-abc1234", "0.2.1", "abc1234ffff")).toBe(false);
    expect(siteIdIs("0.2.0-abc1234", "0.2.0", "def")).toBe(false);
  });
  test("a site id with smoke-site.ts's digest suffix names the same version at the same commit", () => {
    expect(siteIdIs("0.2.0-abc1234-0123456789ab", "0.2.0", "abc1234ffff")).toBe(true);
    expect(siteIdIs("0.2.0-abc1234-0123456789ab", "0.2.0", "def")).toBe(false);
    expect(siteIdIs("0.2.0-abc1234-xyz", "0.2.0", "abc1234ffff")).toBe(false);
  });
});

// ── W01: the preflight ───────────────────────────────────────────────────────

describe("W01-preflight refuses before any push", () => {
  test("a version not above every web-v* tag", async () => {
    const f = fixture();
    sideBranch(f, f.c0, "web/releases-0.3.x", { "frontend/public/z.txt": "z\n" }, "web-v0.3.0");
    const before = f.refs();
    const h = harness(f);
    const r = await preflight(inputs(f, [f.m1, f.m2]), h.deps);
    expect(errorsOf(r)).toContain("version 0.2.0 is not above the tag web-v0.3.0");
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
  });

  test("a release commit that does not descend from the base", async () => {
    const f = fixture();
    sideBranch(f, f.r0, "web/releases-0.2.x", { "frontend/public/z.txt": "z\n" });
    const before = f.refs();
    const h = harness(f);
    const r = await preflight(inputs(f, [f.m1, f.m2]), h.deps);
    expect(errorsOf(r)).toContain(`does not descend from the base ${f.c0.slice(0, 12)} (production's API commit)`);
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
  });

  test("a release tree that differs from the API commit's tree outside WEB_CONTENT_PATHS, listing every path", async () => {
    const f = fixture();
    sideBranch(f, f.c0, "web/releases-0.2.x", { "backend/src/a.ts": "export const a = 99;\n", "docker-compose.yml": "services: {}\n" });
    const before = f.refs();
    const h = harness(f);
    const r = await preflight(inputs(f, [f.m1, f.m2]), h.deps);
    expect(errorsOf(r)).toContain("outside the web content and test paths: backend/src/a.ts, docker-compose.yml. Ship it with bun run release:run");
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
  });

  test("the runner exits non-zero at W01 with the reason and the rerun command, and writes nothing", async () => {
    const f = fixture();
    sideBranch(f, f.c0, "web/releases-0.3.x", { "frontend/public/z.txt": "z\n" }, "web-v0.3.0");
    const before = f.refs();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain("FAILED at W01-preflight: version 0.2.0 is not above the tag web-v0.3.0");
    expect(h.out.join("\n")).toContain(`rerun: bun run release:web --commit ${f.m1} --commit ${f.m2}`);
    expect(f.refs()).toBe(before);
    expect(hostWrites(h)).toEqual([]);
    expect(ghWrites(h)).toEqual([]);
  });
});

describe("the eligibility base", () => {
  test("is the last web-v* tag when it descends from the API commit, and the new branch starts there", async () => {
    const f = fixture();
    const t = sideBranch(f, f.c0, "web/releases-0.1.x", { "frontend/public/b.txt": "shipped in 0.1.5\n" }, "web-v0.1.5");
    const h = harness(f);
    const r = await preflight(inputs(f, [f.m1, f.m2]), h.deps);
    if (!("release" in r)) throw new Error(errorsOf(r));
    expect(r.release.base).toBe(t);
    expect(git(f.work, ["merge-base", "--is-ancestor", t, r.release.commit]).status).toBe(0);
    expect(r.release.changed).toEqual(["frontend/package.json", "frontend/public/index.html"]);
  });

  test("is the API commit when the last web-v* tag does not descend from it", async () => {
    const f = fixture();
    sideBranch(f, f.c0, "web/releases-0.1.x", { "frontend/public/b.txt": "shipped in 0.1.5\n" }, "web-v0.1.5");
    const h = harness(f, { apiCommit: f.mb });
    const r = await preflight(inputs(f, [f.m1, f.m2]), h.deps);
    if (!("release" in r)) throw new Error(errorsOf(r));
    expect(r.release.base).toBe(f.mb);
    // Both commits are already in the API commit, so the release commit is the API commit itself.
    expect(r.release.commit).toBe(f.mb);
  });
});

// ── W02: the branch ──────────────────────────────────────────────────────────

describe("W02-branch", () => {
  test("creates web/releases-0.2.x at the platform tag production runs and cherry-picks the named commits in order", async () => {
    const f = fixture();
    const h = harness(f, { ci: { "web-client.yml": "failure" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    expect(sh(f.bare, "rev-parse", `${tip}~2`)).toBe(sh(f.bare, "rev-parse", "v0.7.0^{commit}"));
    expect(sh(f.bare, "log", "--format=%s", "v0.7.0..web/releases-0.2.x").split("\n")).toEqual(["chore(web): 0.2.0", "feat(web): copy"]);
    const bodies = sh(f.bare, "log", "--format=%B", "v0.7.0..web/releases-0.2.x");
    expect(bodies).toContain(`(cherry picked from commit ${f.m1})`);
    expect(bodies).toContain(`(cherry picked from commit ${f.m2})`);
    expect(h.out.join("\n")).toContain("FAILED at W03-gate");
  });

  test("refuses a named main commit that touches only backend/src/** before any push", async () => {
    const f = fixture();
    const before = f.refs();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.mb]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain(`commit ${f.mb.slice(0, 12)} touches no web content path (backend/src/a.ts): there is nothing to ship`);
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
  });

  test("a cherry-pick conflict exits non-zero with origin's refs unchanged and no worktree left", async () => {
    const f = fixture();
    const before = f.refs();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.mconf], { version: "0.1.0" }), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain(`cherry-picking ${f.mconf.slice(0, 12)} onto ${f.c0.slice(0, 12)} conflicts`);
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
    expect(sh(f.work, "worktree", "list").split("\n")).toHaveLength(1);
  });
});

// ── W01: only the web content part of each commit ships (issue 1603) ─────────

/** Commit on main and push it, as a merged PR would land. */
function onMain(f: Fixture, msg: string, files: Record<string, string>): string {
  const c = f.commit(msg, files);
  sh(f.work, "push", "-q", "origin", "main");
  return c;
}

describe("the left-out rule", () => {
  test("test paths and doc paths are told apart from runtime paths", () => {
    for (const p of ["scripts/tests/unit/x.test.js", "backend/tests/a.test.js", "contract/tests/x.ts", "packages/csvb/tests/a.ts", "backend/src/x.spec.ts"]) {
      expect(isTestPath(p)).toBe(true);
    }
    expect(isDocPath("docs/decisions.md")).toBe(true);
    for (const p of ["backend/src/swarm/dormancy.ts", "docker-compose.yml", "bun.lock", "README.md", "test-fixtures/a.json", "goldens/x.json", "scripts/testsuite.ts"]) {
      expect(isTestPath(p) || isDocPath(p)).toBe(false);
    }
  });
  test("a comment-only edit compiles to the same code; any token change does not", () => {
    const before = "// the count is shown on the member page\nexport const a = 1;\n/** doc */\nexport function f(x: number): number { return x + a; }\n";
    expect(isCommentOnlyChange("x.ts", before, "// the count is shown as a callout\nexport const a = 1;\n/** other doc */\nexport function f(x: number): number {\n  return x + a;\n}\n")).toBe(true);
    expect(isCommentOnlyChange("x.ts", before, before.replace("= 1", "= 2"))).toBe(false);
    expect(isCommentOnlyChange("x.ts", before, before.replace("async ", "").replace("export function", "export async function"))).toBe(false);
    expect(isCommentOnlyChange("x.json", "{}", "{ }")).toBe(false);
    expect(isCommentOnlyChange("x.ts", before, "export const = ;")).toBe(false);
  });
  test("PR 1590's dormancy.ts edit is comment-only, and a real change to that file is not", () => {
    const show = (rev: string): string => sh(ROOT, "show", rev);
    const has = git(ROOT, ["cat-file", "-e", "b54d4b36a6bb664280b5eb9d92056ce0327243b8^{commit}"]).status === 0;
    if (!has) return; // a shallow clone without the commit: the fixture cases below still cover the rule
    expect(isCommentOnlyChange("dormancy.ts", show("b54d4b36^:backend/src/swarm/dormancy.ts"), show("b54d4b36:backend/src/swarm/dormancy.ts"))).toBe(true);
    expect(isCommentOnlyChange("dormancy.ts", show("fe89c5ac:backend/src/swarm/dormancy.ts"), show("2285064e:backend/src/swarm/dormancy.ts"))).toBe(false);
  });
});

describe("W01 ships only the web content part of each named commit", () => {
  test("a commit with a test, a doc and a comment-only backend edit ships its frontend part and its test; the backend and docs equal the API commit's", async () => {
    const f = fixture();
    const mix = onMain(f, "feat(web): callout", {
      "frontend/public/mix.txt": "callout\n", "scripts/tests/unit/mix.test.js": "test\n", "docs/mix.md": "doc\n",
      "backend/src/b.ts": "// b: the member page shows it as a callout\nexport const b = 1;\n",
    });
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [mix, f.m2]), h.deps)).toBe(0);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    expect(sh(f.bare, "diff", "--name-only", f.c0, tip).split("\n")).toEqual(["frontend/package.json", "frontend/public/mix.txt", "scripts/tests/unit/mix.test.js"]);
    const log = h.out.join("\n");
    expect(log).toContain(`  ${mix.slice(0, 12)} backend/src/b.ts (comment-only: left out)`);
    expect(log).toContain(`  ${mix.slice(0, 12)} docs/mix.md (doc: left out)`);
    expect(log).toContain(`  ${mix.slice(0, 12)} scripts/tests/unit/mix.test.js (test: carried)`);
    const body = sh(f.bare, "log", "--format=%B", `${f.c0}..${tip}`);
    expect(body).toContain(`(cherry picked from commit ${mix})\nWeb content release: left out backend/src/b.ts, docs/mix.md.`);
    expect(sh(f.bare, "log", "-1", "--format=%an", `${tip}~1`)).toBe("t");
    const notes = [...h.files.entries()].find(([p]) => p.endsWith("web-v0.2.0-notes.md"))![1];
    expect(notes).toContain(`- ${mix.slice(0, 12)} \`backend/src/b.ts\` (comment-only: left out)`);
    expect(notes).toContain(`- ${mix.slice(0, 12)} \`scripts/tests/unit/mix.test.js\` (test: carried)`);
  });

  test("a rerun of the same commits finds them already picked and keeps the pushed tip", async () => {
    const f = fixture();
    const mix = onMain(f, "feat(web): callout", { "frontend/public/mix.txt": "callout\n", "scripts/tests/unit/mix.test.js": "test\n" });
    const first = harness(f, { ci: { "e2e-web.yml": "failure" } });
    expect(await runWebRelease(runbook, inputs(f, [mix, f.m2]), first.deps)).toBe(1);
    expect(first.out.join("\n")).toContain("FAILED at W03-gate: e2e-web.yml run 8 concluded failure");
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    const again = harness(f, { ci: { "e2e-web.yml": "running" } });
    expect(await runWebRelease(runbook, inputs(f, [mix, f.m2], { dryRun: true }), again.deps)).toBe(0);
    expect(again.out.join("\n")).toContain(`[W02-branch] already done: origin/web/releases-0.2.x is at ${tip}`);
    expect(again.out.join("\n")).toContain("[W03-gate] not done: e2e-web.yml run 8 is in_progress");
  });

  test("refuses a left-out change to runtime code, and an added runtime file, before any push", async () => {
    const f = fixture();
    const real = onMain(f, "feat(web): b", { "frontend/public/b.txt": "b\n", "backend/src/b.ts": "// b: the member page reads it\nexport const b = 2;\n" });
    const added = onMain(f, "feat(web): c", { "frontend/public/c.txt": "c\n", "backend/src/c.ts": "// c\n" });
    const before = f.refs();
    const h = harness(f);
    const r = await preflight(inputs(f, [real, added, f.m2]), h.deps);
    const errors = errorsOf(r);
    expect(errors).toContain(`commit ${real.slice(0, 12)} changes backend/src/b.ts outside the web content paths, and that change is not a test, a doc or a comment-only edit`);
    expect(errors).toContain(`commit ${added.slice(0, 12)} changes backend/src/c.ts outside the web content paths`);
    expect(errors).toContain("ship it with bun run release:run");
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
  });

  test("a conflict in a left-out path does not stop the run; the path keeps the API commit's content", async () => {
    const f = fixture();
    onMain(f, "docs: b v2", { "docs/b.md": "v2\n" });
    const dc = onMain(f, "feat(web): dc", { "frontend/public/dc.txt": "dc\n", "docs/b.md": "v3\n" });
    const h = harness(f);
    const r = await preflight(inputs(f, [dc], { version: "0.1.0" }), h.deps);
    if (!("release" in r)) throw new Error(errorsOf(r));
    expect(sh(f.work, "diff", "--name-only", f.c0, r.release.commit)).toBe("frontend/public/dc.txt");
    expect(sh(f.work, "show", `${r.release.commit}:docs/b.md`)).toBe("v1");
    expect(sh(f.work, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a conflict in a carried test path stops the run before any push, naming the path", async () => {
    const f = fixture();
    onMain(f, "test: b v2", { "scripts/tests/unit/b.test.js": "v2\n" });
    const tc = onMain(f, "feat(web): tc", { "frontend/public/tc.txt": "tc\n", "scripts/tests/unit/b.test.js": "v3\n" });
    const before = f.refs();
    const h = harness(f);
    const r = await preflight(inputs(f, [tc], { version: "0.1.0" }), h.deps);
    expect(errorsOf(r)).toContain(`cherry-picking ${tc.slice(0, 12)} onto ${f.c0.slice(0, 12)} conflicts in scripts/tests/unit/b.test.js`);
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
    expect(sh(f.work, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("an existing branch whose tree carries a test path beside content is still eligible", async () => {
    const f = fixture();
    sideBranch(f, f.c0, "web/releases-0.2.x", { "frontend/public/z.txt": "z\n", "scripts/tests/unit/z.test.js": "z\n" });
    const h = harness(f);
    const r = await preflight(inputs(f, [f.m1, f.m2]), h.deps);
    if (!("release" in r)) throw new Error(errorsOf(r));
    expect(r.release.changed).toContain("scripts/tests/unit/z.test.js");
  });
});

describe("W03-gate", () => {
  test("requires web-client and e2e-web, and e2e-web.yml runs on a push to web/releases-*", () => {
    expect(GATE_RUNS).toEqual([{ workflow: "web-client.yml", job: "web-client" }, { workflow: "e2e-web.yml", job: "e2e-web" }]);
    for (const wf of ["web-client.yml", "e2e-web.yml"]) {
      const doc = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", wf), "utf8")) as { on: { push: { branches: string[] } } };
      expect(doc.on.push.branches).toContain("web/releases-*");
    }
  });
  test("fails at W03 when e2e-web fails at the release commit, and cuts no tag", async () => {
    const f = fixture();
    const h = harness(f, { ci: { "e2e-web.yml": "failure" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain("FAILED at W03-gate: e2e-web.yml run 8 concluded failure");
    expect(remoteRef(f, "refs/tags/web-v0.2.0")).toBeUndefined();
  });
});

describe("W08 rollback of a digest-suffixed site", () => {
  test("a rerun is refused when the rolled-back site id carries smoke-site.ts's digest suffix", async () => {
    const f = fixture();
    const h = harness(f, { failRoute: "/swarm" });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    const receipt = JSON.parse(h.state.receipt) as { previous: string };
    receipt.previous = `${receipt.previous}-0123456789ab`;
    const again = harness(f, { receipt: JSON.stringify(receipt), head: h.state.head, installed: true, live: h.state.live });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), again.deps)).toBe(1);
    expect(again.out.join("\n")).toContain("FAILED at W01-preflight: web-v0.2.0 was rolled back at W08");
  });
});

// ── the whole run ────────────────────────────────────────────────────────────

describe("runWebRelease", () => {
  test("--dry-run leaves origin's refs unchanged and makes no ssh or gh write call", async () => {
    const f = fixture();
    const before = f.refs();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2], { dryRun: true }), h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("[W02-branch] not done (IRREVERSIBLE, would write)");
    expect(h.out.at(-1)).toBe("[web-release] dry run complete: nothing was written");
    expect(f.refs()).toBe(before);
    expect(h.pushes).toEqual([]);
    expect(hostWrites(h)).toEqual([]);
    expect(ghWrites(h)).toEqual([]);
  });

  test("runs W01 to W09: branch, tag, checkout, deploy, live check and a release never marked latest", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(0);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    expect(remoteRef(f, "refs/tags/web-v0.2.0^{commit}")).toBe(tip);
    expect(sh(f.bare, "cat-file", "-t", "refs/tags/web-v0.2.0")).toBe("tag");
    expect(h.pushes.map((p) => p[2])).toEqual([`${tip}:refs/heads/web/releases-0.2.x`, "refs/tags/web-v0.2.0"]);
    expect(hostWrites(h).map((c) => (c.includes("--rollback") ? "rollback" : c.includes("smoke:web") ? "deploy" : "checkout"))).toEqual(["checkout", "deploy"]);
    expect(hostWrites(h)[0]).toContain("git clone --quiet git@github.com:robotmoney/robotmoney-frontend.git /root/rm-web");
    expect(hostWrites(h)[1]).toBe("cd /root/rm-web && env -i HOME=/root PATH=/root/.bun/bin:/home/stage-server/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 RM_ENV=prod bun run smoke:web --instance rm_prod");
    expect(h.state.live).toEqual({ version: "0.2.0", commit: tip.slice(0, 9) });
    expect(h.http).toContain(`${ORIGIN}/swarm`);
    const create = ghWrites(h)[0]!;
    expect(create.slice(0, 3)).toEqual(["release", "create", "web-v0.2.0"]);
    expect(create).toContain("--latest=false");
    const notes = [...h.files.entries()].find(([p]) => p.endsWith("web-v0.2.0-notes.md"))![1];
    expect(notes).toContain("- `frontend/package.json`");
    expect(notes).toContain("- `frontend/public/index.html`");
    expect(h.out.at(-1)).toBe(`[web-release] web-v0.2.0 is live on ${ORIGIN}`);
  });

  test("a rerun after a failure at W03 reports W01 and W02 done and resumes at W03", async () => {
    const f = fixture();
    const first = harness(f, { ci: { "web-client.yml": "failure" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), first.deps)).toBe(1);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    const again = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), again.deps)).toBe(0);
    const log = again.out.join("\n");
    expect(log).toContain("[W01-preflight] passed");
    expect(log).toContain(`[W02-branch] already done: origin/web/releases-0.2.x is at ${tip}`);
    expect(log).toContain("[W03-gate] already done: web-client.yml job web-client concluded success in run 7; e2e-web.yml job e2e-web concluded success in run 8");
    expect(again.pushes.map((p) => p[2])).toEqual(["refs/tags/web-v0.2.0"]);
    expect(remoteRef(f, "refs/heads/web/releases-0.2.x")).toBe(tip);
  });

  test("a failed live check rolls back; a rerun refuses to tag web-v0.2.0 again, which still points at its commit", async () => {
    const f = fixture();
    const h = harness(f, { failRoute: "/swarm" });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    const tagged = remoteRef(f, "refs/tags/web-v0.2.0^{commit}")!;
    const log = h.out.join("\n");
    expect(log).toContain("FAILED at W08-live-check: the live check failed: GET /swarm answered 500");
    expect(log).toContain(`rolled back to the previous site (bun run smoke:web --rollback); ${ORIGIN} now serves 0.1.0-${f.c0.slice(0, 9)}`);
    expect(log).toContain("ship the fix as web-v0.2.1");
    expect(h.ssh.some((c) => c.includes("bun run smoke:web --instance rm_prod --rollback"))).toBe(true);
    expect(h.state.live.version).toBe("0.1.0");

    const again = harness(f, { receipt: h.state.receipt, head: h.state.head, installed: true, live: h.state.live });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), again.deps)).toBe(1);
    expect(again.out.join("\n")).toContain("FAILED at W01-preflight: web-v0.2.0 was rolled back at W08 on rm-frontend-prod-1; the tag is never moved or cut again: ship the fix as web-v0.2.1");
    expect(again.pushes).toEqual([]);
    expect(hostWrites(again)).toEqual([]);
    expect(remoteRef(f, "refs/tags/web-v0.2.0^{commit}")).toBe(tagged);
  });

  test("a live check that sees the api container change fails and rolls back", async () => {
    const f = fixture();
    const h = harness(f);
    const ssh = h.deps.ssh;
    h.deps.ssh = async (host, remote) => {
      const r = await ssh(host, remote);
      if (remote.includes("smoke:web") && !remote.includes("--rollback")) h.state.apiId = "api-2";
      return r;
    };
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain('the api and worker containers changed: {"api":"api-1","worker-analytics":"w-1"} -> {"api":"api-2","worker-analytics":"w-1"}');
    expect(h.state.live.version).toBe("0.1.0");
  });
});
