#!/usr/bin/env bun
// scripts/release/sdk-release.ts — runs the analyst SDK
// release runbook (./runbooks/analyst-sdk.yaml; D77, release-runbooks.md §11)
// from the operator's checkout, with origin the GitHub repository.
//
//   bun scripts/release/sdk-release.ts [--version A.B.C] [--commit <sha>] [--dry-run] [--notes-file <f>]
//
// It prints the plan, then runs S01-preflight to S06-release in order and stops
// at the first failure with the step id, the reason and the rerun command. A
// rerun reports the steps already done and continues at the first that is not.
// --dry-run runs the preflight and every step's read-only done check, and
// writes nothing: no push and no release create.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSdkRunbook, runSdkRelease, type Deps, type ExecResult } from "./sdk-release-lib.ts";

const USAGE = "usage: bun --no-env-file scripts/release/sdk-release.ts [--version A.B.C] [--commit <sha>] [--dry-run] [--notes-file <f>]";

function run(cmd: string, args: string[]): ExecResult {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const opts: { version?: string; commit?: string; notesFile?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | undefined => argv[++i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--version") opts.version = value();
    else if (a === "--commit") opts.commit = value();
    else if (a === "--notes-file") opts.notesFile = value();
    else { console.error(USAGE); return 2; }
  }
  if ((argv.includes("--version") && !opts.version) || (argv.includes("--commit") && !opts.commit) || (argv.includes("--notes-file") && !opts.notesFile)) {
    console.error(USAGE);
    return 2;
  }
  const notesProse = opts.notesFile ? readFileSync(opts.notesFile, "utf8") : undefined;
  const base = join(homedir(), "tmp");
  mkdirSync(base, { recursive: true });
  const deps: Deps = {
    git: (args) => run("git", args),
    gh: (args) => run("gh", args),
    exec: ([cmd, ...args]) => run(cmd!, args),
    clock: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    writeFile: (path, text) => writeFileSync(path, text),
    log: (line) => console.log(line),
  };
  return runSdkRelease(loadSdkRunbook(), { ...opts, notesProse, workDir: mkdtempSync(join(base, "sdk-release-")) }, deps);
}

if (import.meta.main) process.exitCode = await main();
