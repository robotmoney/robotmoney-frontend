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
// the plan, then runs W01-preflight to W09-release in order and stops at the
// first failure with the step id, the reason and the rerun command. A rerun
// reports the steps already done and continues at the first that is not.
// --dry-run runs the preflight and every step's read-only done check, and
// writes nothing to origin, GitHub or the host.
//
// Host commands go over ssh the way ./run.ts runs a step (its realDeps, typed
// by ./step-exec.ts RunnerDeps), from the control machine (D61 (4)).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realDeps } from "./run.ts";
import type { RunnerDeps } from "./step-exec.ts";
import { loadTarget } from "./target.ts";
import { loadWebRunbook, runWebRelease, webTargetOf, type Deps, type ExecResult } from "./web-release-lib.ts";

const USAGE = "usage: bun run release:web --commit <main sha> [--commit <main sha>]... [--target prod|stage] [--version A.B.C] [--dry-run]";
const TARGETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "targets");

function run(cmd: string, args: string[]): ExecResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
  // Stable across reruns: W07's record of the api and workers is read back by W08.
  const workDir = join(homedir(), "tmp", "web-release");
  mkdirSync(workDir, { recursive: true });
  const runner: RunnerDeps = realDeps();
  const deps: Deps = {
    git: (a) => run("git", a),
    gh: (a) => run("gh", a),
    exec: ([cmd, ...a]) => run(cmd!, a),
    async ssh(host, remote) {
      let stdout = "";
      let stderr = "";
      const status = await runner.exec(host, remote, (s) => { stdout += s; }, (s) => { stderr += s; process.stderr.write(s); });
      return { status, stdout, stderr };
    },
    async http(url) {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      return { status: r.status, body: await r.text() };
    },
    readFile(path) {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
    clock: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    writeFile: (path, text) => writeFileSync(path, text),
    log: (line) => console.log(line),
  };
  return runWebRelease(loadWebRunbook(), { commits: args.commits, version: args.version, target, dryRun: args.dryRun, workDir }, deps);
}

if (import.meta.main) process.exitCode = await main();
