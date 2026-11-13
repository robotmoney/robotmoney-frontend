// Issues 1561 and 1630: the web content release runbook and runner (D81, release-runbooks.md §12,
// web-serving-architecture.md §5).
//
// git is real, run against a bare repository made by mktemp under $HOME/tmp as
// `origin`: no network, and never the GitHub remote. gh, ssh, http and the
// control machine's commands are in-process stubs that record every call. The
// exec stub is the control machine: it packs a real bundle tarball (with its
// manifest) from the release tree for W03, and its `bun smoke:web` swaps a fake
// host's website-server the way image mode does. The ssh stub answers the
// read-only host commands (the website-server's labels, the server image, the
// api and workers) the way the real host would.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { releaseRunbookNames, TEMPLATE_NAMES } from "../../release/runbook.ts";
import { loadTarget } from "../../release/target.ts";
import { parseArgs } from "../../release/web-release.ts";
import { gunzipSync, gzipSync } from "node:zlib";
import { readTar, writeTar } from "../../lib/web-bundle.ts";
import { BUNDLE_MANIFEST_FILENAME, serialiseBundleManifest } from "../../lib/web-bundle-manifest.ts";
import { WEBSITE_SECURITY_HEADERS } from "../../lib/website-image.ts";
import { IMAGE_JOURNAL_FILE, type ImageReceipt } from "../../lib/website-release.ts";
import {
  classifyContentDiff, GATE_RUNS, gateTriggerProblems, isCommentOnlyChange, isDocPath, isTestPath, loadWebRunbook, parseWebRunbook, preflight, rerunCommand, runWebRelease,
  WEB_RUNBOOK_PATH, webTargetOf,
  bundleCommands, bundleDigest, bundlePathOf, checkReleaseStep, deployArgv, deployDigestProblem, headerProblems, healthProblem, hostReadyCommand, labelProblems, manifestUrlPath,
  parseHostWeb, releaseAssets, rollbackArgv, rollbackTargetProblem, runReleaseStep, stageGateProblem, stagePassed, stagePriorArgv, wasRolledBack,
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
const STAGE: WebTarget = webTargetOf(loadTarget(join(ROOT, "scripts/release/targets/stage.json")));
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

/** The trigger lines of the three workflows W03 and W08 need, as production's copies (since 1561) carry them. */
const WORKFLOWS: Record<string, string> = {
  ".github/workflows/web-client.yml": "on:\n  push:\n    branches: [main, \"releases-*\", \"qa/**\", \"web/releases-*\"]\n",
  ".github/workflows/e2e-web.yml": "on:\n  push:\n    branches: [main, \"releases-*\", \"qa/**\"]\n  workflow_dispatch:\n",
  ".github/workflows/web-tag-guard.yml": "on:\n  push:\n    tags: [\"web-v*\"]\n",
};

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
    ...WORKFLOWS,
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

/** One packed bundle the fake control machine holds: its identity, digest and files (the manifest's paths, with their bytes). */
interface FakeBundle { tag: string; version: string; commit: string; digest: string; files: Record<string, string> }

/** One fake host's website-server: what serves now (a bundle, or nginx when `bundle` is absent), and the one previous image. */
interface HostState {
  bundle?: FakeBundle;
  /** The image id serving; nginx on a host's first rollout. */
  image: string;
  previous?: { bundle?: FakeBundle; image: string };
  /** Whether the host holds the server image, and the allowed-signers lines inside it. */
  serverImage: boolean;
  signers: string;
  /** Whether a website-server container runs at all. */
  running: boolean;
  /** Its healthcheck's state as `docker ps` prints it, read once per ask (a list plays out over successive reads). */
  health?: string[];
  apiId: string;
}

/** The site nginx serves before the first bundle: version 0.1.0 at production's API commit. */
const NGINX_SITE = (f: Fixture) => ({ version: "0.1.0", commit: f.c0.slice(0, 9) });

interface State extends HostState {
  apiCommit: string;
  ci: Record<string, Ci>;
  admin: string;
  /** The GitHub release, once W12 created it, and the assets it carries. */
  release?: { assets: string[] };
  /** Workflows the runner dispatched; a dispatched workflow with ci "none" then reports success. */
  dispatched: string[];
  failRoute?: string;
  /** A header the fake production origin answers with another value on every page. */
  headerOverride?: Record<string, string>;
  /** A URL path the fake production origin serves with other bytes than the bundle holds. */
  servedOverride?: Record<string, string>;
  /** A URL path the fake stage origin serves with other bytes than the bundle holds. */
  stageServedOverride?: Record<string, string>;
  /** The fake stage target: whether stage-target.ts up built it, and its website-server. */
  stageUp: boolean;
  stage: HostState;
  /** Every control-machine command the runner ran (W03's bundle, W04 and W06's stage-target.ts, every smoke:web). */
  execCalls: string[][];
  /** stage-target.ts down exits non-zero. */
  stageDownFails?: boolean;
  /** The control machine's image journal for production (what `bun smoke:web` journals). */
  journal: ImageReceipt[];
  /** Bundles published as GitHub releases, by tag: what `--bundle web-vX.Y.Z` downloads. */
  released: Record<string, FakeBundle>;
}

interface Harness {
  deps: Deps; out: string[]; pushes: string[][]; ghCalls: string[][]; ssh: string[]; stageSsh: string[]; http: string[]; httpBytes: string[]; files: Map<string, string>; bytes: Map<string, Uint8Array>; state: State;
}

const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>https://robotmoney.network/</loc></url><url><loc>https://robotmoney.network/swarm</loc></url></urlset>`;
const SIGNERS = 'web-bundle@robotmoney namespaces="robotmoney-web-bundle@v1" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPNcM9dzbTx';
const sha = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

/** PURE. The file a URL path names in a bundle, as the server's fallback serves it. */
const fileAt = (path: string): string => (path === "/" ? "index.html" : /\.[a-z0-9]+$/i.test(path) ? path.slice(1) : `${path.slice(1)}/index.html`);

/** A fake host whose website-server is nginx (a host's first rollout): no bundle, no previous image. */
const nginxHost = (apiId: string): HostState => ({ image: "sha256:nginx", serverImage: true, signers: SIGNERS, running: true, apiId });

function harness(f: Fixture, state: Partial<State> = {}): Harness {
  const s: State = {
    apiCommit: f.c0, ci: {}, admin: "true", dispatched: [], ...nginxHost("api-1"),
    stageUp: false, stage: nginxHost("stage-api-1"), execCalls: [], journal: [], released: {}, ...state,
  };
  const onStage = (host: string): boolean => host === STAGE.host;
  const hostOf = (host: string): HostState => (onStage(host) ? s.stage : s);
  const out: string[] = [];
  const pushes: string[][] = [];
  const ghCalls: string[][] = [];
  const sshCalls: string[] = [];
  const stageSshCalls: string[] = [];
  const httpCalls: string[] = [];
  const httpBytesCalls: string[] = [];
  const files = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  let now = 0;
  let packing: string | undefined;
  /** A bundle W03 packed, read back from its tarball as `bun smoke:web` would verify it. */
  const bundleAt = (path: string): FakeBundle | undefined => {
    const tar = bytes.get(path);
    if (tar === undefined) return undefined;
    const site = Object.fromEntries(readTar(gunzipSync(tar)).filter((e) => e.path !== BUNDLE_MANIFEST_FILENAME).map((e) => [e.path, new TextDecoder().decode(e.data)]));
    const { version, commit } = JSON.parse(site["version.json"]!) as { version: string; commit: string };
    return { tag: `web-v${version}`, version, commit, digest: sha(tar), files: site };
  };
  const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
  const gh = (args: string[]): ExecResult => {
    ghCalls.push(args);
    if (args[0] === "api") return ok(`${s.admin}\n`);
    if (args[0] === "run" && args[1] === "list") {
      const wf = args[args.indexOf("--workflow") + 1]!;
      const sha = args[args.indexOf("--commit") + 1]!;
      const c = s.ci[wf] === "none" && s.dispatched.includes(wf) ? "success" : (s.ci[wf] ?? "success");
      const id = RUN_IDS[wf] ?? 7;
      if (c === "running") return ok(JSON.stringify([{ databaseId: id, headSha: sha, status: "in_progress", conclusion: "" }]));
      return ok(JSON.stringify(c === "none" ? [] : [{ databaseId: id, headSha: sha, status: "completed", conclusion: c }]));
    }
    if (args[0] === "run" && args[1] === "view") {
      const wf = Object.entries(RUN_IDS).find(([, id]) => String(id) === args[2])?.[0] ?? "";
      const job = GATE_RUNS.find((g) => g.workflow === wf)?.job ?? "guard";
      return ok(JSON.stringify({ jobs: [{ name: job, status: "completed", conclusion: "success" }] }));
    }
    if (args[0] === "workflow" && args[1] === "run") { s.dispatched.push(args[2]!); return ok(); }
    /** The files a `gh release create|upload <tag> <file>...` names: the words after the tag, up to the first flag. */
    const assetsOf = (a: string[]) => {
      const rest = a.slice(3);
      const end = rest.findIndex((x) => x.startsWith("--"));
      return (end < 0 ? rest : rest.slice(0, end)).map((x) => x.slice(x.lastIndexOf("/") + 1));
    };
    if (args[0] === "release" && args[1] === "view") return s.release ? ok(JSON.stringify({ tagName: args[2], assets: s.release.assets.map((name) => ({ name })) })) : { status: 1, stdout: "", stderr: "release not found" };
    if (args[0] === "release" && args[1] === "create") { s.release = { assets: assetsOf(args) }; return ok(); }
    if (args[0] === "release" && args[1] === "upload") { s.release = { assets: [...new Set([...(s.release?.assets ?? []), ...assetsOf(args)])] }; return ok(); }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  /** What a hostWebCommand prints for a fake host. */
  const webLines = (h: HostState): string => {
    const b = h.bundle;
    const health = (h.health && h.health.length > 1 ? h.health.shift() : h.health?.[0]) ?? "Up 2 minutes (healthy)";
    const serving = h.running ? `serving\tc-${h.image.slice(-6)}\t${h.image}\t${b?.tag ?? ""}\t${b?.commit ?? ""}\t${b?.digest ?? ""}\t${health}\n` : "";
    return `${serving}${h.previous ? `previous\t${h.previous.image}\n` : ""}`;
  };
  const ssh = async (host: string, remote: string): Promise<ExecResult> => {
    (onStage(host) ? stageSshCalls : sshCalls).push(remote);
    const h = hostOf(host);
    if (remote.includes("docker run --rm --network none --entrypoint cat")) {
      return ok(`${h.serverImage ? "server\tsha256:server\n" : ""}${h.serverImage ? h.signers.split("\n").map((l) => `signers\t${l}\n`).join("") : ""}${webLines(h)}`);
    }
    if (remote.includes("label=robotmoney.instance=")) return ok(webLines(h));
    if (remote.includes("stack-state.json")) return ok(JSON.stringify({ project: onStage(host) ? "stage_target_stack" : "rm_prod_stack" }));
    if (remote.includes("label=com.docker.compose.project=")) return ok(`api\t${h.apiId}\nworker-analytics\tw-1\nwebsite-server\tweb-1\n`);
    return { status: 1, stdout: "", stderr: `unexpected ssh ${remote}` };
  };
  /** What a fake host serves at a URL path: its bundle's file, or nginx's site. */
  const served = (h: HostState, path: string): string | undefined => {
    if (h.bundle) return h.bundle.files[fileAt(path)];
    return path === "/version.json" ? JSON.stringify({ ...NGINX_SITE(f), apiRange: "^0.5.0" }) : undefined;
  };
  const PAGE_HEADERS = { ...WEBSITE_SECURITY_HEADERS, "cache-control": "no-cache" };
  const http = async (url: string) => {
    httpCalls.push(url);
    const stage = url.startsWith(STAGE.publicOrigin);
    if (stage && !s.stageUp) throw new Error("Unable to connect");
    const path = url.slice((stage ? STAGE : PROD).publicOrigin.length);
    const h = stage ? s.stage : s;
    if (path === "/api/version") return { status: 200, body: JSON.stringify({ api: "0.5.0", commit: s.apiCommit }) };
    if (path === "/version.json") return { status: 200, body: served(h, path)!, headers: { "cache-control": "public, max-age=300" } };
    if (path === "/sitemap.xml") return { status: 200, body: SITEMAP, headers: { "cache-control": "public, max-age=300" } };
    const headers = { ...PAGE_HEADERS, ...(stage ? {} : s.headerOverride) };
    return { status: !stage && path === s.failRoute ? 500 : 200, body: "<html>", headers };
  };
  const httpBytes = async (url: string) => {
    httpBytesCalls.push(url);
    const stage = url.startsWith(STAGE.publicOrigin);
    const path = decodeURIComponent(new URL(url).pathname);
    const text = (stage ? s.stageServedOverride?.[path] : s.servedOverride?.[path]) ?? served(stage ? s.stage : s, path);
    return text === undefined ? { status: 404, bytes: new Uint8Array() } : { status: 200, bytes: new TextEncoder().encode(text) };
  };
  /** W03's pack, faked: the release tree's frontend/public plus version.json, as one real tarball with its manifest. */
  const pack = (dir: string): void => {
    const commit = packing!;
    const version = (JSON.parse(sh(f.work, "show", `${commit}:frontend/package.json`)) as { version: string }).version;
    const site: Record<string, string> = { "version.json": `${JSON.stringify({ version, commit, apiRange: "^0.5.0" })}\n` };
    for (const p of sh(f.work, "ls-tree", "-r", "--name-only", commit, "frontend/public").split("\n").filter(Boolean)) {
      site[p.slice("frontend/public/".length)] = sh(f.work, "show", `${commit}:${p}`) + "\n";
    }
    const entries = Object.entries(site).map(([path, text]) => ({ path, data: new TextEncoder().encode(text) }));
    const manifest = serialiseBundleManifest(entries.map((e) => ({ path: e.path, sha256: sha(e.data), size: e.data.length })));
    const tar = gzipSync(writeTar([...entries, { path: BUNDLE_MANIFEST_FILENAME, data: new TextEncoder().encode(manifest) }]));
    const name = `robotmoney-web-${version}-${commit}.tar.gz`;
    bytes.set(join(dir, name), tar);
    files.set(join(dir, name), "(bytes)");
    files.set(`${join(dir, name)}.sha256`, `${sha(tar)}  ${name}\n`);
  };
  const exec = (argv: string[]): ExecResult => {
    s.execCalls.push(argv);
    const cmd = argv.slice(0, 2).join(" ");
    if (cmd === "bun scripts/release/stage-target.ts") {
      if (argv[2] === "dump") return ok("dump ok");
      if (argv[2] === "up") { s.stageUp = true; s.stage = nginxHost("stage-api-1"); return ok("up ok"); }
      if (argv[2] === "down") { if (s.stageDownFails) return { status: 1, stdout: "", stderr: "down failed" }; s.stageUp = false; return ok("down ok"); }
    }
    if (argv[0] === "rm" || argv[0] === "bash" || cmd === "bun install") return ok();
    if (cmd === "git worktree") { if (argv[2] === "add") packing = argv.at(-1); return ok(); }
    if (argv[0] === "bun" && argv[1]!.endsWith("scripts/lib/web-bundle.ts")) {
      if (argv[2] === "pack") { pack(argv[4]!); return ok(); }
      if (argv[2] === "sign") { files.set(`${argv[3]}.sha256.sig`, "-----BEGIN SSH SIGNATURE-----"); return ok(); }
    }
    if (argv.slice(0, 3).join(" ") === "bun run smoke:web") {
      const at = (flag: string) => argv[argv.indexOf(flag) + 1]!;
      const h = hostOf(at("--host"));
      if (argv.includes("--rollback")) {
        if (!h.previous) return { status: 1, stdout: "", stderr: "no previous image" };
        const from = h.image;
        const back = h.previous;
        h.previous = { bundle: h.bundle, image: h.image };
        h.bundle = back.bundle;
        h.image = back.image;
        if (h === s) s.journal.push(imageReceipt("rollback", from, h.image, back.bundle));
        return ok();
      }
      const ref = at("--bundle");
      const bundle = ref.startsWith("web-v") ? s.released[ref] : bundleAt(ref);
      if (bundle === undefined) return { status: 1, stdout: "", stderr: `no bundle ${ref}` };
      const from = h.image;
      h.previous = { bundle: h.bundle, image: h.image };
      h.bundle = bundle;
      h.image = `sha256:site-${bundle.digest.slice(0, 8)}`;
      if (h === s) s.journal.push(imageReceipt("deploy", from, h.image, bundle));
      return ok();
    }
    return { status: 1, stdout: "", stderr: `unexpected exec ${argv.join(" ")}` };
  };
  const deps: Deps = {
    git: (args) => {
      if (args[0] === "push") pushes.push(args);
      return git(f.work, args);
    },
    gh,
    exec,
    ssh,
    http,
    httpBytes,
    readFile: (p) => (p.endsWith(IMAGE_JOURNAL_FILE) && p.includes(join("web-image", PROD.instance)) ? s.journal.map((r) => JSON.stringify(r)).join("\n") : files.get(p)),
    readBytes: (p) => bytes.get(p),
    writeFile: (p, text) => { files.set(p, text); },
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    log: (l) => out.push(l),
  };
  return { deps, out, pushes, ghCalls, ssh: sshCalls, stageSsh: stageSshCalls, http: httpCalls, httpBytes: httpBytesCalls, files, bytes, state: s };
}

/** An image receipt as `bun smoke:web` journals one: an action that swapped `from` for `to`. */
function imageReceipt(action: "deploy" | "rollback", from: string, to: string, bundle?: FakeBundle): ImageReceipt {
  return {
    schema: 2, mode: "image", instance: PROD.instance, host: PROD.host, action, outcome: "swapped",
    release: bundle ? { tag: bundle.tag, version: bundle.version, commit: bundle.commit, sha256: bundle.digest, apiRange: "^0.5.0" } : null,
    apiVersion: "0.5.0", oldContainer: { id: "old", image: from }, newContainer: { id: "new", image: to }, publicPort: 8080, copyPort: null, checks: [],
    gap: { startedAt: "2026-11-13T00:00:00.000Z", endedAt: "2026-11-13T00:00:00.500Z", ms: 500 }, revertGap: null,
    currentImage: to, previousImage: from, error: null, startedAt: "2026-11-13T00:00:00.000Z", finishedAt: "2026-11-13T00:00:01.000Z",
  };
}

const inputs = (f: Fixture, commits: string[], o: Partial<Inputs> = {}): Inputs => ({
  commits, target: PROD, stage: STAGE, dryRun: false, workDir: f.workDir, signingKey: "/home/op/.ssh/robotmoney-web-bundle", controlStateRoot: join(f.base, "state"), ...o,
});
const errorsOf = (r: Awaited<ReturnType<typeof preflight>>): string => ("errors" in r ? r.errors.join("\n") : "");
const runbook = loadWebRunbook();
const remoteRef = (f: Fixture, ref: string): string | undefined => {
  const r = git(f.bare, ["rev-parse", "--verify", "--quiet", ref]);
  return r.status === 0 ? r.stdout.trim() : undefined;
};
/** smoke:web runs that change a host's website-server, as `<host> <deploy|rollback> <bundle>`. */
const swaps = (h: Harness): string[] => h.state.execCalls.filter((c) => c.slice(0, 3).join(" ") === "bun run smoke:web")
  .map((c) => `${c[c.indexOf("--host") + 1]} ${c.includes("--rollback") ? "rollback" : `deploy ${c[c.indexOf("--bundle") + 1]!.replace(/^.*\//, "")}`}`);
/** Any control-machine command that changes production: a swap on its host. */
const hostWrites = (h: Harness): string[] => swaps(h).filter((w) => w.startsWith(`${PROD.host} `));
/** Every ssh command production saw: each is a read. */
const prodSsh = (h: Harness): string[] => h.ssh;
const ghWrites = (h: Harness): string[][] => h.ghCalls.filter((c) => (c[0] === "release" && c[1] !== "view") || (c[0] === "workflow" && c[1] === "run"));

// ── the runbook and its loader ───────────────────────────────────────────────

describe("the committed runbook", () => {
  test("holds W01-preflight to W12-release in order; W02, W07, W10 and W12 are irreversible", () => {
    expect(runbook.steps.map((s) => s.id)).toEqual([
      "W01-preflight", "W02-branch", "W03-gate", "W04-stage-up", "W05-stage-deploy", "W06-stage-check",
      "W07-tag", "W08-tag-guard", "W09-host-ready", "W10-deploy", "W11-live-check", "W12-release",
    ]);
    expect(runbook.steps.filter((s) => s.irreversible).map((s) => s.id)).toEqual(["W02-branch", "W07-tag", "W10-deploy", "W12-release"]);
  });

  test("sits outside templates/ and releases/, so the platform loader never reads it", () => {
    expect(WEB_RUNBOOK_PATH).not.toMatch(/\/(templates|releases)\//);
    expect(releaseRunbookNames()).not.toContain("web-content");
    // The platform loader's templates: kitchen-sink and its web-only subset `web` (owner 2026-11-11), never web-content.
    expect([...TEMPLATE_NAMES]).toEqual(["kitchen-sink", "web"]);
    expect([...TEMPLATE_NAMES]).not.toContain("web-content");
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
    expect(refusal((d) => { d.steps[8]!.kind = "migrate"; })).toContain("W09-host-ready: unknown kind migrate");
  });
  test("an id outside the W<nn>-<name> shape, and a duplicate id", () => {
    expect(refusal((d) => { d.steps[1]!.id = "S02-branch"; })).toContain("S02-branch: id is W<two digits>-<name>");
    expect(refusal((d) => { d.steps[2]!.id = "W02-branch"; })).toContain("W02-branch: duplicate id");
  });
  test("a wrong irreversible mark", () => {
    expect(refusal((d) => { d.steps[9]!.irreversible = false; })).toContain("W10-deploy: a deploy step is irreversible: true");
  });
  test("a polling step without maxMinutes, and maxMinutes on another kind", () => {
    expect(refusal((d) => { delete d.steps[2]!.maxMinutes; })).toContain("W03-gate: a gate step names maxMinutes");
    expect(refusal((d) => { d.steps[9]!.maxMinutes = 5; })).toContain("W10-deploy: only a gate or tag-guard step carries maxMinutes");
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
  test("the web target reads the platform target file with no new key: the same host, and the instance's server image", () => {
    expect(PROD).toEqual({
      name: "prod", rmEnv: "prod", host: "rm-frontend-prod-1", home: "/root", instance: "rm_prod", publicOrigin: "https://robotmoney.network",
      stateRoot: "/root/.local/state/robotmoney-smoke", serverImage: "robotmoney-website-server:rm_prod", env: {},
    });
  });
  test("the rerun command repeats every --commit", () => {
    expect(rerunCommand({ commits: ["a", "b"], target: PROD, stage: STAGE, dryRun: false, workDir: "/x", signingKey: "/k", controlStateRoot: "/s" })).toBe("bun run release:web --commit a --commit b");
  });
  test("W05, W10 and W11 run smoke:web's image mode from the control machine, always with --origin", () => {
    expect(deployArgv(PROD, "/b.tar.gz")).toEqual(["bun", "run", "smoke:web", "--host", "rm-frontend-prod-1", "--instance", "rm_prod", "--bundle", "/b.tar.gz",
      "--server-image", "robotmoney-website-server:rm_prod", "--origin", "https://robotmoney.network"]);
    expect(rollbackArgv(STAGE)).toEqual(["bun", "run", "smoke:web", "--host", "rm-frontend-stage-2", "--instance", "stage_target", "--rollback", "--origin", "https://stage.robotmoney-labs.dev"]);
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
    expect(errorsOf(r)).toContain("Ship on a new line: bump A.B in frontend/package.json on main and name that commit too");
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
  test("only scripts/tests/** is a carried test path; other test directories count as runtime", () => {
    for (const p of ["scripts/tests/unit/x.test.js", "scripts/tests/fixtures/a.json"]) expect(isTestPath(p)).toBe(true);
    expect(isDocPath("docs/decisions.md")).toBe(true);
    for (const p of [
      "backend/tests/fixtures/regime/raw-indicator-history.csv.gz", "backend/tests/a.test.js", "contract/tests/x.ts", "packages/csvb/tests/a.ts", "backend/src/x.spec.ts",
      "backend/src/swarm/dormancy.ts", "docker-compose.yml", "bun.lock", "README.md", "test-fixtures/a.json", "goldens/x.json", "scripts/testsuite.ts",
    ]) {
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
  test("a macro import is never run and counts as not comment-only", () => {
    const marker = join(homedir(), "tmp", `web-release-macro-${process.pid}`);
    rmSync(marker, { force: true });
    const macroDir = mkdtempSync(join(homedir(), "tmp", "web-release-macro-"));
    bases.push(macroDir);
    writeFileSync(join(macroDir, "m.ts"), `import { writeFileSync } from "node:fs";\nexport function boom() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1; }\n`);
    const src = (c: string) => `// ${c}\nimport { boom } from ${JSON.stringify(join(macroDir, "m.ts"))} with { type: "macro" };\nexport const x = boom();\n`;
    expect(isCommentOnlyChange("x.ts", src("one"), src("two"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
  test("PR 1590's dormancy.ts edit is comment-only, and a real change to that file is not", () => {
    // The file at b54d4b36^, b54d4b36 and 2285064e, copied in as fixtures so the
    // check runs on CI's depth-1 clone (git show b54d4b36:backend/src/swarm/dormancy.ts).
    const fx = (name: string): string => readFileSync(join(ROOT, "scripts/tests/fixtures/web-release", name), "utf8");
    const before = fx("dormancy-before-1590.ts.txt");
    const after = fx("dormancy-after-1590.ts.txt");
    expect(before).not.toBe(after);
    expect(isCommentOnlyChange("dormancy.ts", before, after)).toBe(true);
    // 2285064e exports readSeatSilence (issue 1579): a real change.
    expect(isCommentOnlyChange("dormancy.ts", after, fx("dormancy-main-2285064e.ts.txt"))).toBe(false);
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

  test("refuses a backend test fixture beside content: backend/tests/fixtures/regime is runtime seed data", async () => {
    const f = fixture();
    const seed = onMain(f, "feat(web): regime + seed", { "frontend/public/r.txt": "r\n", "backend/tests/fixtures/regime/raw-indicator-history.csv.gz": "gz\n" });
    const before = f.refs();
    const h = harness(f);
    const r = await preflight(inputs(f, [seed, f.m2]), h.deps);
    expect(errorsOf(r)).toContain(`commit ${seed.slice(0, 12)} changes backend/tests/fixtures/regime/raw-indicator-history.csv.gz outside the web content paths`);
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
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
  test("requires web-client by push and e2e-web by workflow_dispatch; this checkout and production's v0.7.3 tree can run both", () => {
    expect(GATE_RUNS).toEqual([
      { workflow: "web-client.yml", job: "web-client", event: "push" },
      { workflow: "e2e-web.yml", job: "e2e-web", event: "workflow_dispatch" },
    ]);
    // The real workflow files: HEAD's own (copied into a one-commit repo, since CI clones at depth 1).
    const f = fixture();
    const files: Record<string, string> = {};
    for (const wf of ["web-client.yml", "e2e-web.yml", "web-tag-guard.yml"]) {
      files[`.github/workflows/${wf}`] = readFileSync(join(ROOT, ".github/workflows", wf), "utf8");
    }
    const real = onMain(f, "ci: the real workflows", files);
    expect(gateTriggerProblems(harness(f).deps, real)).toEqual([]);
  });

  test("W01 refuses when the release tree's e2e-web.yml cannot be dispatched, or web-client.yml lacks the web/releases-* push", async () => {
    const f = fixture();
    sideBranch(f, f.c0, "ci-old", {
      ".github/workflows/e2e-web.yml": "on:\n  push:\n    branches: [main]\n",
      ".github/workflows/web-client.yml": "on:\n  push:\n    branches: [main]\n",
    });
    const old = sh(f.bare, "rev-parse", "refs/heads/ci-old");
    const h = harness(f, { apiCommit: old });
    const before = f.refs();
    const r = await preflight(inputs(f, [f.m1, f.m2]), h.deps);
    const errors = errorsOf(r);
    expect(errors).toContain("e2e-web.yml at the release commit");
    expect(errors).toContain("lacks a workflow_dispatch trigger (W03 dispatches it)");
    expect(errors).toContain("web-client.yml at the release commit");
    expect(errors).toContain("lacks a push trigger on web/releases-* (W03)");
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
  });

  test("dispatches e2e-web once on the release branch, then passes when the dispatched run succeeds", async () => {
    const f = fixture();
    const h = harness(f, { ci: { "e2e-web.yml": "none" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(0);
    const dispatches = h.ghCalls.filter((c) => c[0] === "workflow" && c[1] === "run");
    expect(dispatches).toEqual([["workflow", "run", "e2e-web.yml", "--ref", "web/releases-0.2.x"]]);
    expect(h.out.join("\n")).toContain("[W03-gate] dispatched e2e-web.yml on web/releases-0.2.x");
    const lists = h.ghCalls.filter((c) => c[0] === "run" && c[1] === "list" && c.includes("e2e-web.yml"));
    expect(lists.every((c) => c[c.indexOf("--event") + 1] === "workflow_dispatch")).toBe(true);
  });

  test("a dry run never dispatches", async () => {
    const f = fixture();
    const h = harness(f, { ci: { "e2e-web.yml": "none" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2], { dryRun: true }), h.deps)).toBe(0);
    expect(ghWrites(h)).toEqual([]);
    expect(h.out.join("\n")).toContain("no workflow_dispatch run of e2e-web.yml on web/releases-0.2.x");
  });
  test("fails at W03 when e2e-web fails at the release commit, and cuts no tag", async () => {
    const f = fixture();
    const h = harness(f, { ci: { "e2e-web.yml": "failure" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain("FAILED at W03-gate: e2e-web.yml run 8 concluded failure");
    expect(remoteRef(f, "refs/tags/web-v0.2.0")).toBeUndefined();
  });
});

// ── the whole run ────────────────────────────────────────────────────────────

describe("runWebRelease", () => {
  test("--dry-run leaves origin's refs unchanged and makes no write: no push, no bundle, no swap, no gh write", async () => {
    const f = fixture();
    const before = f.refs();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2], { dryRun: true }), h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("[W02-branch] not done (IRREVERSIBLE, would write)");
    expect(h.out.at(-1)).toBe("[web-release] dry run complete: nothing was written");
    expect(f.refs()).toBe(before);
    expect(h.pushes).toEqual([]);
    expect(h.state.execCalls).toEqual([]);
    expect(ghWrites(h)).toEqual([]);
  });

  test("runs W01 to W12: branch, gate and bundle, stage, tag, host check, swap, live check and a release with the bundle, never marked latest", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps), h.out.join("\n")).toBe(0);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    const name = `robotmoney-web-0.2.0-${tip}.tar.gz`;
    expect(remoteRef(f, "refs/tags/web-v0.2.0^{commit}")).toBe(tip);
    expect(sh(f.bare, "cat-file", "-t", "refs/tags/web-v0.2.0")).toBe("tag");
    expect(h.pushes.map((p) => p[2])).toEqual([`${tip}:refs/heads/web/releases-0.2.x`, "refs/tags/web-v0.2.0"]);
    // Stage, then production, got the same file; production's swap ran from the control machine with --origin.
    expect(swaps(h)).toEqual([`${STAGE.host} deploy ${name}`, `${PROD.host} deploy ${name}`]);
    const deploy = h.state.execCalls.find((c) => c.includes("--host") && c.includes(PROD.host))!;
    expect(deploy).toEqual(["bun", "run", "smoke:web", "--host", PROD.host, "--instance", "rm_prod", "--bundle", join(f.workDir, "web-v0.2.0-bundle", name),
      "--server-image", "robotmoney-website-server:rm_prod", "--origin", ORIGIN]);
    expect(h.state.bundle?.tag).toBe("web-v0.2.0");
    expect(h.http).toContain(`${ORIGIN}/swarm`);
    const create = ghWrites(h)[0]!;
    expect(create.slice(0, 3)).toEqual(["release", "create", "web-v0.2.0"]);
    expect(create).toContain("--latest=false");
    expect(h.out.at(-1)).toBe(`[web-release] web-v0.2.0 is live on ${ORIGIN}`);
  });

  test("a rerun after a failure at W03 reports W01 and W02 done and resumes at W03", async () => {
    const f = fixture();
    const first = harness(f, { ci: { "web-client.yml": "failure" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), first.deps)).toBe(1);
    expect(first.state.execCalls).toEqual([]);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    const again = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), again.deps)).toBe(0);
    const log = again.out.join("\n");
    expect(log).toContain("[W01-preflight] passed");
    expect(log).toContain(`[W02-branch] already done: origin/web/releases-0.2.x is at ${tip}`);
    expect(log).toContain("[W03-gate] done:");
    expect(log).toContain("; packed and signed");
    expect(again.pushes.map((p) => p[2])).toEqual(["refs/tags/web-v0.2.0"]);
    expect(remoteRef(f, "refs/heads/web/releases-0.2.x")).toBe(tip);
  });

  test("a failed live check rolls back; a rerun refuses to tag web-v0.2.0 again, which still points at its commit", async () => {
    const f = fixture();
    const h = harness(f, { failRoute: "/swarm" });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    const tagged = remoteRef(f, "refs/tags/web-v0.2.0^{commit}")!;
    const log = h.out.join("\n");
    expect(log).toContain("FAILED at W11-live-check: the live check failed: GET /swarm answered 500");
    expect(log).toContain(`rolled back (bun smoke:web --rollback: the previous image, or the first-rollout nginx container); ${ORIGIN} now serves 0.1.0-${f.c0.slice(0, 9)}`);
    expect(log).toContain("ship the fix as web-v0.2.1");
    expect(h.state.execCalls).toContainEqual(["bun", "run", "smoke:web", "--host", PROD.host, "--instance", "rm_prod", "--rollback", "--origin", ORIGIN]);
    expect(h.state.bundle).toBeUndefined();

    const again = harness(f, { journal: h.state.journal });
    for (const [p, t] of h.files) again.files.set(p, t);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), again.deps)).toBe(1);
    expect(again.out.join("\n")).toContain("FAILED at W01-preflight: web-v0.2.0 was rolled back at W11 on rm-frontend-prod-1");
    expect(again.out.join("\n")).toContain("the tag is never moved or cut again: ship the fix as web-v0.2.1");
    expect(again.pushes).toEqual([]);
    expect(again.state.execCalls).toEqual([]);
    expect(remoteRef(f, "refs/tags/web-v0.2.0^{commit}")).toBe(tagged);
  });

  test("wasRolledBack: a deploy of the tag swapped on, then a rollback swapped that image off", () => {
    const b: FakeBundle = { tag: "web-v0.2.0", version: "0.2.0", commit: "c", digest: "d", files: {} };
    expect(wasRolledBack([imageReceipt("deploy", "nginx", "site-2", b), imageReceipt("rollback", "site-2", "nginx")], "web-v0.2.0")).toBe(true);
    expect(wasRolledBack([imageReceipt("deploy", "nginx", "site-2", b)], "web-v0.2.0")).toBe(false);
    expect(wasRolledBack([imageReceipt("deploy", "nginx", "site-2", b), imageReceipt("rollback", "site-9", "nginx")], "web-v0.2.0")).toBe(false);
    expect(wasRolledBack([imageReceipt("deploy", "nginx", "site-2", b), imageReceipt("rollback", "site-2", "nginx")], "web-v0.2.1")).toBe(false);
  });

  test("a live check that sees the api container change fails and rolls back", async () => {
    const f = fixture();
    const h = harness(f);
    const exec = h.deps.exec;
    h.deps.exec = (argv) => {
      const r = exec(argv);
      if (argv.includes(PROD.host) && argv.includes("--bundle")) h.state.apiId = "api-2";
      return r;
    };
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain('the api and worker containers changed: {"api":"api-1","worker-analytics":"w-1"} -> {"api":"api-2","worker-analytics":"w-1"}');
    expect(h.state.bundle).toBeUndefined();
  });
});

// ── W01: the rollback target ─────────────────────────────────────────────────

describe("W01 refuses when production would have no rollback target", () => {
  test("no website-server runs: refused before any push", async () => {
    const f = fixture();
    const before = f.refs();
    const h = harness(f, { running: false });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    const log = h.out.join("\n");
    expect(log).toContain("FAILED at W01-preflight: no website-server runs for rm_prod on rm-frontend-prod-1");
    expect(log).toContain("a failed W11 could not roll back");
    expect(h.pushes).toEqual([]);
    expect(f.refs()).toBe(before);
  });

  test("nginx serving (a host's first rollout, issue 1632) is a rollback target; two website-servers are refused", () => {
    expect(rollbackTargetProblem(PROD, { container: "c1", image: "sha256:nginx" })).toBeUndefined();
    expect(rollbackTargetProblem(PROD, {})).toContain("no website-server runs");
    expect(parseHostWeb("serving\ta\tx\t\t\t\nserving\tb\ty\t\t\t\n")).toEqual({ error: "2 website-server containers run for the instance, not one" });
    expect(parseHostWeb("serving\tc1\tsha256:site\tweb-v0.1.0\tabc\tdd\nprevious\tsha256:nginx\n")).toEqual({
      web: { container: "c1", image: "sha256:site", tag: "web-v0.1.0", commit: "abc", digest: "dd", previous: "sha256:nginx" },
    });
  });

  test("the plan reports what serves and the previous image", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2], { dryRun: true }), h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("[web-release] prod serves sha256:nginx, no signed bundle (first rollout: the swap keeps its container, stopped, as the rollback target, issue 1632); previous image (none)");
  });
});

// ── W03: the signed bundle (issue 1630) ──────────────────────────────────────

describe("W03 packs and signs the bundle on the control machine after the gate passes", () => {
  test("bundleCommands: a scratch worktree at the release commit, a frozen install, the assembly, pack and sign with the control key", () => {
    const rel = { tag: "web-v0.2.0", version: "0.2.0", commit: "a".repeat(40) };
    const dir = "/w/web-v0.2.0-bundle";
    expect(bundleCommands({ workDir: "/w", signingKey: "/k" }, rel)).toEqual([
      ["rm", "-rf", `${dir}/tree`, `${dir}/site`],
      ["git", "worktree", "add", "--force", "--detach", `${dir}/tree`, rel.commit],
      ["bun", "install", "--frozen-lockfile", "--cwd", `${dir}/tree`],
      ["bash", `${dir}/tree/scripts/static-assembly.sh`, `${dir}/site`],
      ["bun", `${dir}/tree/scripts/lib/web-bundle.ts`, "pack", `${dir}/site`, dir],
      ["bun", `${dir}/tree/scripts/lib/web-bundle.ts`, "sign", `${dir}/robotmoney-web-0.2.0-${rel.commit}.tar.gz`, "/k"],
      ["git", "worktree", "remove", "--force", `${dir}/tree`],
    ]);
  });

  test("the bundle commands run only after the gate passed, and before anything reaches stage", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps), h.out.join("\n")).toBe(0);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    const at = (pred: (c: string[]) => boolean) => h.state.execCalls.findIndex(pred);
    const sign = at((c) => c[2] === "sign");
    expect(sign).toBeGreaterThan(at((c) => c[2] === "pack"));
    expect(sign).toBeLessThan(at((c) => c[1] === "scripts/release/stage-target.ts"));
    expect(h.state.execCalls[at((c) => c[2] === "sign")]!.at(-1)).toBe("/home/op/.ssh/robotmoney-web-bundle");
    expect(h.state.execCalls[at((c) => c[1] === "worktree" && c[2] === "add")]!.at(-1)).toBe(tip);
    // The bundle commands never reach a host.
    expect([...h.ssh, ...h.stageSsh].some((c) => /web-bundle\.ts|static-assembly|bun install/.test(c))).toBe(false);
  });

  test("a gate that fails packs nothing", async () => {
    const f = fixture();
    const h = harness(f, { ci: { "e2e-web.yml": "failure" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.state.execCalls.filter((c) => c.join(" ").includes("web-bundle.ts"))).toEqual([]);
  });

  test("bundleDigest needs the signature and a digest that names the bundle", () => {
    const rel = { tag: "web-v0.2.0", version: "0.2.0", commit: "a".repeat(40) };
    const path = `/w/web-v0.2.0-bundle/robotmoney-web-0.2.0-${rel.commit}.tar.gz`;
    const files = new Map<string, string>([[`${path}.sha256`, `${"d".repeat(64)}  robotmoney-web-0.2.0-${rel.commit}.tar.gz\n`]]);
    const deps = { readFile: (p: string) => files.get(p) };
    expect(bundleDigest({ workDir: "/w" }, rel, deps)).toBeUndefined();
    files.set(`${path}.sha256.sig`, "sig");
    expect(bundleDigest({ workDir: "/w" }, rel, deps)).toBe("d".repeat(64));
    files.set(`${path}.sha256`, `${"d".repeat(64)}  robotmoney-web-0.2.1-${rel.commit}.tar.gz\n`);
    expect(bundleDigest({ workDir: "/w" }, rel, deps)).toBeUndefined();
  });
});

// ── W09: the host is ready, and installs nothing (issue 1630) ────────────────

describe("W09-host-ready", () => {
  test("its one host command is read only: no bun, no install, no build, no git, no clone", () => {
    const cmd = hostReadyCommand(PROD);
    expect(cmd).toContain("docker image inspect --format '{{.Id}}' robotmoney-website-server:rm_prod");
    expect(cmd).toContain("docker run --rm --network none --entrypoint cat robotmoney-website-server:rm_prod /etc/robotmoney/allowed-signers");
    // PATH names ~/.bun/bin; no command word is bun, git or a package manager.
    for (const word of [/(^|[\s;&|{(])(bun|git|npm|npx|bunx)\s/, /\binstall\b/, /\bbuild\b/, /\bclone\b/, /smoke:web/, /static-assembly/]) expect(cmd).not.toMatch(word);
  });

  test("a host without the server image, without a web-bundle signer, or with nothing serving fails W09 before any swap", async () => {
    for (const [over, want] of [
      [{ serverImage: false }, "holds no server image robotmoney-website-server:rm_prod"],
      [{ signers: "someone ssh-ed25519 AAAA" }, "carries no allowed-signers line for the robotmoney-web-bundle@v1 namespace"],
    ] as const) {
      const f = fixture();
      const h = harness(f, over);
      expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
      const log = h.out.join("\n");
      expect(log).toContain("FAILED at W09-host-ready: rm-frontend-prod-1 is not ready for the swap");
      expect(log).toContain(want);
      expect(hostWrites(h)).toEqual([]);
    }
  });

  test("a ready host passes W09 and the run reaches the swap", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("[W09-host-ready] already done: rm-frontend-prod-1 holds robotmoney-website-server:rm_prod, its allowed-signers file, and a rollback target (sha256:nginx serves now)");
  });
});

// ── W06 and W11: the live check (web-serving-architecture.md §5.2) ───────────

describe("the live check: labels, served bytes against the manifest, the header table", () => {
  test("manifestUrlPath: index files at their directory, any other file at its path", () => {
    expect(manifestUrlPath("index.html")).toBe("/");
    expect(manifestUrlPath("swarm/index.html")).toBe("/swarm");
    expect(manifestUrlPath("views/regime.html")).toBe("/views/regime.html");
    expect(manifestUrlPath("version.json")).toBe("/version.json");
  });

  test("labelProblems names each label that differs from the bundle", () => {
    const rel = { tag: "web-v0.2.0", commit: "c".repeat(40) };
    expect(labelProblems(PROD, { container: "x", tag: "web-v0.2.0", commit: "c".repeat(40), digest: "d" }, rel, "d")).toEqual([]);
    const off = labelProblems(PROD, { container: "x", tag: "web-v0.1.0", commit: "c".repeat(40), digest: "e" }, rel, "d");
    expect(off).toEqual([
      "the website-server's label robotmoney.web.tag is web-v0.1.0, not web-v0.2.0",
      "the website-server's label robotmoney.web.bundle-sha256 is e, not the bundle's d",
    ]);
    expect(labelProblems(PROD, { container: "x" }, rel, "d").length).toBe(3);
  });

  test("headerProblems: a page needs every security header and no-cache, an asset the asset Cache-Control", () => {
    const page = { ...WEBSITE_SECURITY_HEADERS, "cache-control": "no-cache" };
    expect(headerProblems("/", page)).toEqual([]);
    expect(headerProblems("/swarm", { ...page, "content-security-policy": "default-src *" })[0]).toContain("/swarm: header content-security-policy is \"default-src *\", not the platform's");
    expect(headerProblems("/", { "cache-control": "no-cache" }).length).toBe(4);
    expect(headerProblems("/app.js", { "cache-control": "public, max-age=300" })).toEqual([]);
    expect(headerProblems("/app.js", { "cache-control": "no-cache" }).length).toBe(1);
  });

  test("a served file that differs from the manifest fails W11 and rolls back", async () => {
    const f = fixture();
    const h = harness(f, { servedOverride: { "/": "home v1 (a stale cache)\n" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    const log = h.out.join("\n");
    expect(log).toMatch(/FAILED at W11-live-check: the live check failed: GET \/ serves sha256 [0-9a-f]{16}, not the manifest's index\.html \([0-9a-f]{16}\)/);
    expect(log).toContain("rolled back (bun smoke:web --rollback: the previous image, or the first-rollout nginx container)");
    expect(h.state.bundle).toBeUndefined();
    // Every comparison read the served copy past any cache.
    expect(h.httpBytes.every((u) => /\?rm-live-check=[0-9a-f]{12}-\d+$/.test(u))).toBe(true);
  });

  test("a header that differs from the platform's table fails W11 and rolls back", async () => {
    const f = fixture();
    const h = harness(f, { headerOverride: { "content-security-policy": "default-src * 'unsafe-inline'" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain("FAILED at W11-live-check: the live check failed: /: header content-security-policy is \"default-src * 'unsafe-inline'\", not the platform's");
    expect(h.state.bundle).toBeUndefined();
  });

  test("labels that differ from the bundle fail W11 and roll back", async () => {
    const f = fixture();
    const h = harness(f);
    const exec = h.deps.exec;
    h.deps.exec = (argv) => {
      const r = exec(argv);
      // The swap left a container whose labels name another digest (a wrong image on the port).
      if (argv.includes(PROD.host) && argv.includes("--bundle") && h.state.bundle) h.state.bundle = { ...h.state.bundle, digest: "f".repeat(64) };
      return r;
    };
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain(`FAILED at W11-live-check: the live check failed: the website-server's label robotmoney.web.bundle-sha256 is ${"f".repeat(64)}, not the bundle's`);
    expect(h.state.bundle).toBeUndefined();
  });

  test("healthProblem: the swapped container's inherited healthcheck must report healthy", () => {
    expect(healthProblem("Up 3 minutes (healthy)")).toBeUndefined();
    expect(healthProblem("Up 2 seconds (health: starting)")).toBe("starting");
    expect(healthProblem("Up 1 minute (unhealthy)")).toContain("inherited healthcheck reports unhealthy");
    expect(healthProblem("Up 1 minute")).toContain("runs with no healthcheck");
  });

  test("W11 waits while the healthcheck is starting, and an unhealthy one fails W11 and rolls back", async () => {
    const f = fixture();
    const waits = harness(f, { health: ["Up 1 second (health: starting)", "Up 1 second (health: starting)", "Up 8 seconds (healthy)"] });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), waits.deps), waits.out.join("\n")).toBe(0);
    const g = fixture();
    const sick = harness(g);
    const exec = sick.deps.exec;
    sick.deps.exec = (argv) => {
      const r = exec(argv);
      if (argv.includes(PROD.host) && argv.includes("--bundle")) sick.state.health = ["Up 1 minute (unhealthy)"];
      return r;
    };
    expect(await runWebRelease(runbook, inputs(g, [g.m1, g.m2]), sick.deps)).toBe(1);
    expect(sick.out.join("\n")).toContain("FAILED at W11-live-check: the live check failed: the website-server's inherited healthcheck reports unhealthy");
    expect(sick.state.bundle).toBeUndefined();
  });

  test("a passing W11 compares every manifest file and the header table on every sitemap route", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(0);
    const log = h.out.join("\n");
    // version.json, a.txt and index.html: the fixture's frontend/public plus the identity file.
    expect(log).toContain("[web-release] served files compared with the bundle's manifest: 3");
    expect(log).toContain("3 file(s) served as the manifest lists, the header table holds on / and every sitemap route (each 200), the api and workers are unchanged");
    expect(h.httpBytes.filter((u) => u.startsWith(ORIGIN)).map((u) => new URL(u).pathname).sort()).toEqual(["/", "/a.txt", "/version.json"]);
  });
});

// ── W04 to W06: stage QA, and the digest that unlocks production ─────────────

describe("W04 to W06: stage QA before any production step writes", () => {
  const at = (h: Harness, line: string): number => h.out.findIndex((l) => l.startsWith(line));

  test("a full run brings stage up from a fresh dump, sends the bundle there with smoke:web, checks it, records the pass for its digest and tears stage down, all before the tag", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps), h.out.join("\n")).toBe(0);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    const stageCmds = h.state.execCalls.filter((c) => c[1] === "scripts/release/stage-target.ts" || c.includes(STAGE.host));
    expect(stageCmds.map((c) => (c[1] === "scripts/release/stage-target.ts" ? c[2] : "smoke:web"))).toEqual(["dump", "up", "smoke:web", "down"]);
    expect(stageCmds[2]).toEqual(["bun", "run", "smoke:web", "--host", STAGE.host, "--instance", "stage_target", "--bundle", bundlePathOf(inputs(f, []), { tag: "web-v0.2.0", version: "0.2.0", commit: tip }),
      "--server-image", "robotmoney-website-server:stage_target", "--origin", STAGE.publicOrigin]);
    const digest = createHash("sha256").update(h.bytes.get(bundlePathOf(inputs(f, []), { tag: "web-v0.2.0", version: "0.2.0", commit: tip }))!).digest("hex");
    const pass = JSON.parse(h.files.get(join(f.workDir, "web-v0.2.0-stage-pass.json"))!) as { commit: string; digest: string; origin: string };
    expect(pass).toMatchObject({ commit: tip, digest, origin: STAGE.publicOrigin });
    expect(at(h, "[W06-stage-check] done: stage QA passed on https://stage.robotmoney-labs.dev")).toBeLessThan(at(h, "[W07-tag] done"));
    // Nothing is cloned, installed or built on the stage host.
    expect(h.stageSsh.some((c) => /git clone|bun install|smoke:web/.test(c))).toBe(false);
    const firstStage = h.httpBytes.findIndex((u) => u.startsWith(STAGE.publicOrigin));
    expect(firstStage).toBeGreaterThanOrEqual(0);
    expect(firstStage).toBeLessThan(h.httpBytes.findIndex((u) => u.startsWith(ORIGIN)));
    expect(h.state.stageUp).toBe(false);
  });

  test("W04 deploys production's serving bundle to stage by name before W05, so stage holds a previous image", async () => {
    const f = fixture();
    const prior: FakeBundle = { tag: "web-v0.1.0", version: "0.1.0", commit: f.c0, digest: "b".repeat(64), files: { "index.html": "home\n", "version.json": "{}" } };
    const h = harness(f, { bundle: prior, image: "sha256:site-prior", released: { "web-v0.1.0": prior } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps), h.out.join("\n")).toBe(0);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    const onStage = h.state.execCalls.filter((c) => c.includes(STAGE.host));
    expect(onStage.map((c) => c[c.indexOf("--bundle") + 1]!.replace(/^.*\//, ""))).toEqual(["web-v0.1.0", `robotmoney-web-0.2.0-${tip}.tar.gz`]);
    expect(onStage[0]).toEqual(["bun", "run", "smoke:web", "--host", STAGE.host, "--instance", "stage_target", "--bundle", "web-v0.1.0", "--server-image", "robotmoney-website-server:stage_target", "--origin", STAGE.publicOrigin]);
    // When W05's swap ran, stage's previous image was production's bundle.
    expect(h.state.stage.previous?.bundle?.tag).toBe("web-v0.1.0");
    expect(stagePriorArgv(inputs(f, []), { serving: { container: "c", tag: "web-v0.1.0" } })?.slice(7, 9)).toEqual(["--bundle", "web-v0.1.0"]);
    // On production's first rollout (nginx serves) W05's swap keeps stage's nginx container: nothing is deployed by name.
    expect(stagePriorArgv(inputs(f, []), { serving: { container: "c", image: "sha256:nginx" } })).toBeUndefined();
  });

  test("a stage failure stops the run at W06: no tag, nothing on production, stage left up for inspection", async () => {
    const f = fixture();
    const h = harness(f, { stageServedOverride: { "/": "home v1 (stale)\n" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    const log = h.out.join("\n");
    expect(log).toMatch(/FAILED at W06-stage-check: stage QA failed on https:\/\/stage\.robotmoney-labs\.dev: GET \/ serves sha256 [0-9a-f]{16}, not the manifest's index\.html .*Nothing reached production/);
    expect(remoteRef(f, "refs/tags/web-v0.2.0")).toBeUndefined();
    expect(hostWrites(h)).toEqual([]);
    expect(h.state.stageUp).toBe(true);
  });

  test("no production step writes without a recorded stage pass", async () => {
    const f = fixture();
    const h = harness(f);
    const write = h.deps.writeFile;
    h.deps.writeFile = (p, text) => { if (!p.endsWith("-stage-pass.json")) write(p, text); };
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toMatch(/FAILED at W07-tag: stage QA \(W04 to W06\) has not passed for web-v0\.2\.0's bundle/);
    expect(remoteRef(f, "refs/tags/web-v0.2.0")).toBeUndefined();
    expect(hostWrites(h)).toEqual([]);
  });

  test("a stage pass for another digest does not unlock W07 onward", async () => {
    const f = fixture();
    // The stage pass is recorded for other bytes than the bundle W03 packed.
    const tagFirst = harness(f);
    const write = tagFirst.deps.writeFile;
    tagFirst.deps.writeFile = (p, text) => write(p, p.endsWith("-stage-pass.json") ? text.replace(/"digest": "[0-9a-f]{64}"/, `"digest": "${"e".repeat(64)}"`) : text);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), tagFirst.deps)).toBe(1);
    const log = tagFirst.out.join("\n");
    expect(log).toContain("FAILED at W07-tag: stage QA (W04 to W06) has not passed for web-v0.2.0's bundle");
    expect(log).toContain("names another commit or another digest");
    expect(remoteRef(f, "refs/tags/web-v0.2.0")).toBeUndefined();
    expect(hostWrites(tagFirst)).toEqual([]);
  });

  test("W10 refuses a bundle whose digest is not the stage-passed one, before any swap", async () => {
    const f = fixture();
    const h = harness(f);
    // The bundle is repacked with other bytes after stage passed (between W06 and W10).
    const exec = h.deps.exec;
    let tampered = false;
    h.deps.exec = (argv) => {
      if (!tampered && argv.includes(PROD.host) && argv.includes("--bundle")) throw new Error("W10 must refuse before it sends");
      return exec(argv);
    };
    const ssh = h.deps.ssh;
    h.deps.ssh = async (host, remote) => {
      // W09's read is the last step before W10: repack the bundle then.
      if (!tampered && remote.includes("docker run --rm --network none")) {
        for (const [p, t] of h.files) if (p.endsWith(".tar.gz.sha256")) { h.files.set(p, t.replace(/^[0-9a-f]{64}/, "9".repeat(64))); tampered = true; }
      }
      return ssh(host, remote);
    };
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(tampered).toBe(true);
    const log = h.out.join("\n");
    expect(log).toMatch(/FAILED at W10-deploy: refusing .*: its sha256 9{64} is not the stage-passed sha256 [0-9a-f]{64}/);
    expect(hostWrites(h)).toEqual([]);
  });

  test("deployDigestProblem names both digests when the bundle changed after the stage pass", () => {
    const f = fixture();
    const h = harness(f);
    const rel = { version: "0.2.0", commit: "a".repeat(40), branch: "web/releases-0.2.x", tag: "web-v0.2.0", apiCommit: f.c0, base: f.c0, changed: [], outside: [] };
    const path = bundlePathOf(inputs(f, []), rel);
    h.files.set(`${path}.sha256`, `${"1".repeat(64)}  robotmoney-web-0.2.0-${rel.commit}.tar.gz\n`);
    h.files.set(`${path}.sha256.sig`, "sig");
    h.files.set(join(f.workDir, "web-v0.2.0-stage-pass.json"), JSON.stringify({ commit: rel.commit, digest: "2".repeat(64), origin: STAGE.publicOrigin, at: "x", summary: "" }));
    expect(stagePassed(rel, inputs(f, []), h.deps)).toBeUndefined();
    expect(deployDigestProblem(rel, inputs(f, []), h.deps)).toContain(`its sha256 ${"1".repeat(64)} is not the stage-passed sha256 ${"2".repeat(64)}`);
    h.files.set(join(f.workDir, "web-v0.2.0-stage-pass.json"), JSON.stringify({ commit: rel.commit, digest: "1".repeat(64), origin: STAGE.publicOrigin, at: "x", summary: "" }));
    expect(stagePassed(rel, inputs(f, []), h.deps)?.digest).toBe("1".repeat(64));
    expect(deployDigestProblem(rel, inputs(f, []), h.deps)).toBeUndefined();
    // A pass for another commit does not count either.
    h.files.set(join(f.workDir, "web-v0.2.0-stage-pass.json"), JSON.stringify({ commit: "b".repeat(40), digest: "1".repeat(64), origin: STAGE.publicOrigin, at: "x", summary: "" }));
    expect(stagePassed(rel, inputs(f, []), h.deps)).toBeUndefined();
    expect(stageGateProblem(rel, inputs(f, []))).toContain("stage QA (W04 to W06) has not passed for web-v0.2.0's bundle");
  });

  test("a rerun after the stage pass reports W04 to W06 done and builds no stage again", async () => {
    const f = fixture();
    const first = harness(f, { ci: { "web-tag-guard.yml": "failure" } });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), first.deps)).toBe(1);
    expect(first.out.join("\n")).toContain("FAILED at W08-tag-guard");
    const again = harness(f);
    for (const [p, t] of first.files) again.files.set(p, t);
    for (const [p, b] of first.bytes) again.bytes.set(p, b);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), again.deps), again.out.join("\n")).toBe(0);
    const log = again.out.join("\n");
    expect(log).toContain("[W03-gate] already done");
    expect(log).toContain("[W04-stage-up] already done: stage QA already passed");
    expect(log).toContain("[W06-stage-check] already done: stage QA passed");
    expect(again.state.execCalls.filter((c) => c.includes(STAGE.host) || c[1] === "scripts/release/stage-target.ts")).toEqual([]);
  });

  test("a teardown that fails after a pass keeps the pass; the rerun continues at W07", async () => {
    const f = fixture();
    const h = harness(f, { stageDownFails: true });
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain("FAILED at W06-stage-check: stage QA passed and is recorded");
    expect(h.files.has(join(f.workDir, "web-v0.2.0-stage-pass.json"))).toBe(true);
  });

  test("the dry run plans the bundle and the stage steps and writes nothing: no bundle, no stage build, no swap, no file hash", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2], { dryRun: true }), h.deps)).toBe(0);
    const log = h.out.join("\n");
    expect(log).toContain("[W03-gate] plan: bun install --frozen-lockfile --cwd");
    expect(log).toContain("[W04-stage-up] not done: the stage target is not up");
    expect(log).toContain("[W06-stage-check] plan: version.json, the labels, the served files, the header table, every sitemap route and an unchanged api on https://stage.robotmoney-labs.dev");
    expect(log).toContain("[W07-tag] not done (IRREVERSIBLE, would write): web-v0.2.0 is absent");
    expect(log).toContain("it refuses until stage QA passes for this bundle's digest");
    expect(h.state.execCalls).toEqual([]);
    expect(h.stageSsh).toEqual([]);
    expect(h.httpBytes).toEqual([]);
  });
});

// ── W12: the release carries the bundle (issue 1630) ─────────────────────────

describe("W12-release", () => {
  test("the GitHub release carries the bundle, its digest and its signature, and the notes name the digest", async () => {
    const f = fixture();
    const h = harness(f);
    expect(await runWebRelease(runbook, inputs(f, [f.m1, f.m2]), h.deps)).toBe(0);
    const tip = remoteRef(f, "refs/heads/web/releases-0.2.x")!;
    const name = `robotmoney-web-0.2.0-${tip}.tar.gz`;
    const create = ghWrites(h).find((c) => c[1] === "create")!;
    const dir = join(f.workDir, "web-v0.2.0-bundle");
    expect(create.slice(3, 6)).toEqual([join(dir, name), join(dir, `${name}.sha256`), join(dir, `${name}.sha256.sig`)]);
    expect(h.state.release?.assets).toEqual([name, `${name}.sha256`, `${name}.sha256.sig`]);
    const digest = createHash("sha256").update(h.bytes.get(join(dir, name))!).digest("hex");
    const notes = [...h.files.entries()].find(([p]) => p.endsWith("web-v0.2.0-notes.md"))![1];
    expect(notes).toContain(`\`${name}\`, sha256 \`${digest}\``);
    expect(notes).toContain("- `frontend/public/index.html`");
  });

  test("a release that exists without the files is not done; the step attaches them", () => {
    const f = fixture();
    const h = harness(f, { release: { assets: [] } });
    const rel = { version: "0.2.0", commit: "a".repeat(40), branch: "web/releases-0.2.x", tag: "web-v0.2.0", apiCommit: f.c0, base: f.c0, changed: [], outside: [] };
    expect(checkReleaseStep(rel, inputs(f, []), h.deps).state).toBe("todo");
    expect(runReleaseStep(rel, inputs(f, []), h.deps).state).toBe("done");
    expect(h.ghCalls.at(-1)!.slice(0, 3)).toEqual(["release", "upload", "web-v0.2.0"]);
    expect(checkReleaseStep(rel, inputs(f, []), h.deps)).toMatchObject({ state: "done" });
    expect(releaseAssets(inputs(f, []), rel).map((p) => p.slice(p.lastIndexOf("/") + 1))).toEqual([
      `robotmoney-web-0.2.0-${rel.commit}.tar.gz`, `robotmoney-web-0.2.0-${rel.commit}.tar.gz.sha256`, `robotmoney-web-0.2.0-${rel.commit}.tar.gz.sha256.sig`,
    ]);
  });
});
