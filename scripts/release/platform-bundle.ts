#!/usr/bin/env bun
// scripts/release/platform-bundle.ts — a platform release that names a signed bundle to deploy
// (web-serving-architecture.md §5.3: "A platform release keeps the bundle the host serves, unless its
// runbook names a signed bundle to deploy. A bundle a platform release names passes that release's own
// stage run, by digest, before production gets it"). Runs on the CONTROL MACHINE, the one machine that
// holds the bundle key (§3.1, R2). v0.9.0's first rollout of the immutable container is its first user
// (owner decision 2026-11-15, tracking issue 1647).
//
//   bun scripts/release/platform-bundle.ts build  --release vA.B.C --target <stage|prod> --commit <sha> --run <run-ts>
//   bun scripts/release/platform-bundle.ts deploy --release vA.B.C --target <stage|prod> --commit <sha> --run <run-ts>
//                                                 --host <ssh-dest> --instance <name> --origin <url>
//
// The store is <journal root>/bundles/<release>/ on the control machine: the bundle, its .sha256 digest and
// its .sha256.sig signature, `bundle.json` (what was built, at which commit and tree) and `stage-deploy.json`
// (what stage deployed, in which stage run).
//
// build. STAGE: packs and signs the bundle for the release commit exactly as a web release's W03 does
//   (web-release-lib.ts bundleCommands: a scratch worktree at the commit, a frozen install,
//   scripts/static-assembly.sh, scripts/lib/web-bundle.ts pack and sign with ~/.ssh/robotmoney-web-bundle),
//   verifies it against the commit's own website-server/allowed-signers and records its digest. A bundle
//   already built for the same commit that still verifies is kept (a rerun). PRODUCTION: builds nothing. It
//   refuses unless the store holds the bundle stage deployed, in a stage run that PASSED, whose tree equals
//   the production commit's tree, and whose bytes still hash to the recorded digest and verify. So production
//   deploys the stage-passed bytes or nothing (R13).
// deploy. Resolves the same bundle (re-reading its sha256 just before the send), then runs
//   `bun run smoke:web --host <h> --instance <i> --bundle <file> --server-image robotmoney-website-server:<i> --origin <o>`,
//   the command a web release's W05 and W10 run. On a host's first rollout smoke:web keeps the nginx
//   container, stopped, as `<name>-first-rollout`, the rollback target (§4). The same bundle already serving
//   on the same server image is `unchanged`. On stage a success records stage-deploy.json.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packBundle, signBundle, verifyBundle } from "../lib/web-bundle.ts";
import { journalRoot, type RunJournal } from "./journal.ts";
import { loadTarget } from "./target.ts";
import { WEB_SIGNING_KEY } from "./web-release.ts";
import { serverImageOf } from "./web-release-lib.ts";

/** What `build` recorded: the bundle a release built on stage. */
export interface BuiltBundle {
  readonly release: string;
  readonly commit: string;
  readonly tree: string;
  readonly file: string;
  readonly sha256: string;
  readonly version: string;
  readonly at: string;
}

/** What stage deployed: the bundle's digest and the stage run that deployed it. */
export interface StageDeploy {
  readonly release: string;
  readonly runTs: string;
  readonly commit: string;
  readonly sha256: string;
  readonly file: string;
  readonly at: string;
}

/** The store of one release's bundle on the control machine. */
export const storeDir = (release: string, root: string = journalRoot()): string => join(root, "bundles", release);

/**
 * PURE. Why production must not deploy the stage bundle; empty when it may. `run` is the stage run the
 * record names (undefined when its run.json could not be read); `prodTree` is the production commit's tree;
 * `actualSha` the bundle file's sha256 now (null when the file is missing).
 */
export function productionBundleProblems(deployed: StageDeploy | undefined, run: Pick<RunJournal, "status" | "tree" | "commit" | "commits"> | undefined, prodTree: string, actualSha: string | null): string[] {
  if (deployed === undefined) return ["no stage-deploy.json: stage has not deployed a bundle for this release, so production has nothing it may deploy"];
  const out: string[] = [];
  if (run === undefined) out.push(`the stage run ${deployed.runTs} that deployed the bundle has no readable run.json`);
  else {
    if (run.status !== "passed") out.push(`the stage run ${deployed.runTs} that deployed the bundle is ${run.status}, not passed`);
    if (run.tree !== prodTree) out.push(`the stage run ${deployed.runTs} passed tree ${run.tree ?? "(none)"}, not the production commit's tree ${prodTree}`);
    const commits = new Set([run.commit, ...(run.commits ?? []).map((c) => c.commit)]);
    if (!commits.has(deployed.commit)) out.push(`the bundle was built at ${deployed.commit}, a commit the stage run ${deployed.runTs} never ran at`);
  }
  if (actualSha === null) out.push(`the stage-deployed bundle ${deployed.file} is gone from the store`);
  else if (actualSha !== deployed.sha256) out.push(`the bundle's sha256 is ${actualSha}, not the stage-passed digest ${deployed.sha256}`);
  return out;
}

/** PURE. The smoke:web argv that deploys a bundle file (web-release-lib.ts deployArgv's command, by path). */
export function deployArgv(host: string, instance: string, bundle: string, origin: string): string[] {
  return ["bun", "run", "smoke:web", "--host", host, "--instance", instance, "--bundle", bundle, "--server-image", serverImageOf(instance), "--origin", origin];
}

const sha256Of = (path: string): string | null => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
const readJson = <T>(path: string): T | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
};
const git = (args: string[]): string => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
  return r.stdout.trim();
};
const run = (argv: string[], cwd?: string): void => {
  const r = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit", cwd });
  if (r.status !== 0) throw new Error(`${argv.join(" ")} exited ${r.status}`);
};

/** The commit's own website-server/allowed-signers, written to a scratch file; the caller removes `dir`. */
function signersAt(commit: string, dir: string): string {
  const path = join(dir, "allowed-signers");
  writeFileSync(path, git(["show", `${commit}:website-server/allowed-signers`]) + "\n");
  return path;
}

/** Verify a bundle file against the commit's allowed-signers; the reason when it fails. */
function verifyAt(file: string, commit: string): { ok: true; sha256: string; version: string; commit: string } | { ok: false; reason: string } {
  const scratch = mkdtempSync(join(tmpdir(), "rm-platform-bundle-"));
  try {
    const v = verifyBundle(file, join(scratch, "out"), { allowedSigners: signersAt(commit, scratch) });
    return v.ok ? { ok: true, sha256: v.sha256, version: v.version, commit: v.commit } : { ok: false, reason: v.reason };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** STAGE: pack and sign the bundle for `commit` (W03's commands), or keep the one already built for it. */
function buildOnStage(release: string, commit: string): BuiltBundle {
  const dir = storeDir(release);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tree = git(["rev-parse", `${commit}^{tree}`]);
  const recorded = readJson<BuiltBundle>(join(dir, "bundle.json"));
  if (recorded !== undefined && recorded.commit === commit && sha256Of(recorded.file) === recorded.sha256 && verifyAt(recorded.file, commit).ok) {
    console.log(`[platform-bundle] kept ${recorded.file}, built for ${commit.slice(0, 12)} (sha256 ${recorded.sha256})`);
    return recorded;
  }
  if (!existsSync(WEB_SIGNING_KEY)) throw new Error(`the control machine holds no bundle key at ${WEB_SIGNING_KEY}`);
  for (const f of readdirSync(dir)) if (f.startsWith("robotmoney-web-") || f === "bundle.json" || f === "stage-deploy.json") rmSync(join(dir, f), { force: true });
  const work = join(dir, "work");
  const tree_ = join(work, "tree");
  const site = join(work, "site");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    run(["git", "worktree", "add", "--force", "--detach", tree_, commit]);
    run(["bun", "install", "--frozen-lockfile", "--cwd", tree_]);
    run(["bash", join(tree_, "scripts", "static-assembly.sh"), site], tree_);
    const packed = packBundle(site, dir);
    signBundle(packed.path, WEB_SIGNING_KEY);
    const v = verifyAt(packed.path, commit);
    if (!v.ok) throw new Error(`the bundle just signed fails verification against ${commit.slice(0, 12)}'s allowed-signers: ${v.reason} (is ${WEB_SIGNING_KEY}.pub the key that file lists?)`);
    const built: BuiltBundle = { release, commit, tree, file: packed.path, sha256: packed.sha256, version: packed.version, at: new Date().toISOString() };
    writeFileSync(join(dir, "bundle.json"), `${JSON.stringify(built, null, 2)}\n`, { mode: 0o600 });
    console.log(`[platform-bundle] built ${packed.path}: version ${packed.version}, commit ${packed.commit}, sha256 ${packed.sha256}`);
    return built;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree_], { stdio: "ignore" });
    rmSync(work, { recursive: true, force: true });
  }
}

/** PRODUCTION: the stage-passed bundle, or every reason there is none. */
function stagePassed(release: string, commit: string): { file: string; sha256: string } | { problems: string[] } {
  const dir = storeDir(release);
  const deployed = readJson<StageDeploy>(join(dir, "stage-deploy.json"));
  const journal = deployed ? readJson<RunJournal>(join(journalRoot(), "stage", deployed.runTs, "run.json")) : undefined;
  const prodTree = git(["rev-parse", `${commit}^{tree}`]);
  const problems = productionBundleProblems(deployed, journal, prodTree, deployed ? sha256Of(deployed.file) : null);
  if (problems.length > 0 || deployed === undefined) return { problems };
  const v = verifyAt(deployed.file, commit);
  if (!v.ok) return { problems: [`the stage-passed bundle fails verification against the production commit's allowed-signers: ${v.reason}`] };
  return { file: deployed.file, sha256: deployed.sha256 };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  const release = flag("--release");
  const targetName = flag("--target");
  const commit = flag("--commit");
  const runTs = flag("--run");
  if ((mode !== "build" && mode !== "deploy") || !release || !/^v\d+\.\d+\.\d+$/.test(release) || !targetName || !commit || !/^[0-9a-f]{40}$/.test(commit) || !runTs) {
    console.error("usage: bun scripts/release/platform-bundle.ts <build|deploy> --release vA.B.C --target <stage|prod> --commit <40-hex> --run <run-ts> [--host <h> --instance <i> --origin <url>]");
    return 2;
  }
  const target = loadTarget(join(import.meta.dir, "targets", `${targetName}.json`));
  try {
    let bundle: { file: string; sha256: string };
    if (target.rmEnv === "stage") {
      const built = buildOnStage(release, commit);
      bundle = { file: built.file, sha256: built.sha256 };
    } else {
      const passed = stagePassed(release, commit);
      if ("problems" in passed) {
        for (const p of passed.problems) console.error(`[platform-bundle] REFUSE: ${p}`);
        return 1;
      }
      bundle = passed;
      console.log(`[platform-bundle] production deploys the stage-passed bundle ${bundle.file} (sha256 ${bundle.sha256})`);
    }
    if (mode === "build") return 0;
    const host = flag("--host");
    const instance = flag("--instance");
    const origin = flag("--origin");
    if (!host || !instance || !origin) {
      console.error("[platform-bundle] deploy needs --host, --instance and --origin");
      return 2;
    }
    // The digest is read again just before the send: the bytes smoke:web sends are the bytes stage passed.
    if (sha256Of(bundle.file) !== bundle.sha256) {
      console.error(`[platform-bundle] REFUSE: ${bundle.file} no longer hashes to ${bundle.sha256}`);
      return 1;
    }
    const r = spawnSync(deployArgv(host, instance, bundle.file, origin)[0]!, deployArgv(host, instance, bundle.file, origin).slice(1), { stdio: "inherit" });
    if (r.status !== 0) return r.status ?? 1;
    if (target.rmEnv === "stage") {
      const record: StageDeploy = { release, runTs, commit, sha256: bundle.sha256, file: bundle.file, at: new Date().toISOString() };
      writeFileSync(join(storeDir(release), "stage-deploy.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      console.log(`[platform-bundle] recorded the stage deploy of sha256 ${bundle.sha256} in run ${runTs}; production deploys only these bytes, once that run passes`);
    }
    return 0;
  } catch (error) {
    console.error(`[platform-bundle] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
