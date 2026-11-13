#!/usr/bin/env bun
// scripts/release/web-release.ts — runs the web content release runbook
// (./runbooks/web-content.yaml; D81, release-runbooks.md §12) from the
// operator's checkout, with origin the GitHub repository.
//
//   bun run release:web --commit <main sha> [--commit <main sha>]... [--target prod|stage] [--version A.B.C] [--dry-run]
//
// Each --commit names a main commit to cherry-pick onto web/releases-A.B.x, in
// the given order. --target names the platform target file
// (./targets/<name>.json, default prod) for where the site is served. It prints
// the plan, then runs W01-preflight to W12-release in order and stops at the
// first failure with the step id, the reason and the rerun command. A rerun
// reports the steps already done and continues at the first that is not.
// --dry-run runs the preflight and every step's read-only done check, and
// writes nothing to origin, GitHub or the host.
//
// Host reads go over ssh the way ./run.ts runs a step (its realDeps, typed by
// ./step-exec.ts RunnerDeps), from the control machine (D61 (4)). W03 packs and
// signs the bundle here with the key at WEB_SIGNING_KEY (~/.ssh/robotmoney-web-bundle,
// the control machine's ed25519 bundle key, web-serving-architecture.md §3.1), and
// `bun smoke:web` deploys it from here, writing its receipts under this
// machine's smoke state root.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateRoot } from "../lib/smoke-state.ts";
import { realDeps } from "./run.ts";
import type { RunnerDeps } from "./step-exec.ts";
import { loadTarget } from "./target.ts";
import { loadWebRunbook, runWebRelease, webTargetOf, type Deps, type ExecResult } from "./web-release-lib.ts";

const USAGE = "usage: bun run release:web --commit <main sha> [--commit <main sha>]... [--target prod|stage] [--version A.B.C] [--dry-run]";
const TARGETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "targets");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** The control machine's web bundle signing key (§3.1: held there and nowhere else, it signs bundles and nothing else). */
export const WEB_SIGNING_KEY = join(homedir(), ".ssh", "robotmoney-web-bundle");

function run(cmd: string, args: string[], cwd?: string): ExecResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
}

export function parseArgs(argv: readonly string[]): { commits: string[]; target: "prod" | "stage"; version?: string; dryRun: boolean } | { error: string } {
  const out: { commits: string[]; target: "prod" | "stage"; version?: string; dryRun: boolean } = { commits: [], target: "prod", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | undefined => {
      const v = argv[++i];
      return v === undefined || v.startsWith("--") ? undefined : v;
    };
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--commit") {
      const v = value();
      if (v === undefined) return { error: "--commit needs a sha" };
      out.commits.push(v);
    } else if (a === "--version") {
      const v = value();
      if (v === undefined) return { error: "--version needs A.B.C" };
      out.version = v;
    } else if (a === "--target") {
      const v = value();
      if (v !== "prod" && v !== "stage") return { error: "--target is prod or stage" };
      out.target = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (out.commits.length === 0) return { error: "name at least one --commit" };
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`${args.error}\n${USAGE}`);
    return 2;
  }
  const target = webTargetOf(loadTarget(join(TARGETS_DIR, `${args.target}.json`)));
  // W04 to W06 QA the release on the kitchen-sink stage target before any production step writes (owner, 2026-11-11).
  const stage = webTargetOf(loadTarget(join(TARGETS_DIR, "stage.json")));
  // Stable across reruns: W10's record of the api and workers is read back by W11.
  const workDir = join(homedir(), "tmp", "web-release");
  mkdirSync(workDir, { recursive: true });
  const runner: RunnerDeps = realDeps();
  const deps: Deps = {
    git: (a) => run("git", a),
    gh: (a) => run("gh", a),
    // From the repository root: W03 packs and signs the bundle, W04 and W06 run stage-target.ts as the kitchen sink's Q02 and Q03 do, and W04, W05, W10 and W11 run `bun run smoke:web`.
    exec: ([cmd, ...a]) => run(cmd!, a, REPO_ROOT),
    async ssh(host, remote) {
      let stdout = "";
      let stderr = "";
      const status = await runner.exec(host, remote, (s) => { stdout += s; }, (s) => { stderr += s; process.stderr.write(s); });
      return { status, stdout, stderr };
    },
    async http(url) {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      return { status: r.status, body: await r.text(), headers: Object.fromEntries(r.headers.entries()) };
    },
    async httpBytes(url) {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
    },
    readFile(path) {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
    readBytes(path) {
      try { return new Uint8Array(readFileSync(path)); } catch { return undefined; }
    },
    clock: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    writeFile: (path, text) => writeFileSync(path, text),
    log: (line) => console.log(line),
  };
  const inputs = { commits: args.commits, version: args.version, target, stage, dryRun: args.dryRun, workDir, signingKey: WEB_SIGNING_KEY, controlStateRoot: stateRoot(process.env) };
  return runWebRelease(loadWebRunbook(), inputs, deps);
}

if (import.meta.main) process.exitCode = await main();
