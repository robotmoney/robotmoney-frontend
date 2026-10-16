#!/usr/bin/env bun
// scripts/release/scope.ts — QA step Q05-scope, on the control machine.
//
//   bun scripts/release/scope.ts --release vA.B.C --commit <sha> --origin <url>
//
// Proves the release runbook's `scope:` lists every PR the release ships, each
// with the step that checks it landed or the reason none does (owner,
// 2026-10-15: a release checks every change it carries; general checks live in
// the template's soak, the change-specific ones are the release's version
// steps). The release ships what lies between the version the target runs
// (`<origin>/api/version`: on stage, production's own tag, which Q03-stage-up
// booted) and the QA commit. A PR is a commit subject ending `(#<n>)`, as a
// squash merge writes it.
//
// It refuses (exit 1) a PR in that range the scope does not list, and a scope
// entry no commit in the range carries. Production runs this commit's tree
// (SP.8), so stage's pass covers it.
import { spawnSync } from "node:child_process";
import { readRunningVersion, runningPinRef } from "./ledger.ts";
import { loadReleaseRunbook, type ScopeEntry } from "./runbook.ts";

/** PURE. The PR numbers commit subjects name, `(#<n>)` anywhere in a subject, sorted and unique. */
export function prsOf(subjects: readonly string[]): number[] {
  const out = new Set<number>();
  for (const s of subjects) for (const m of s.matchAll(/\(#(\d+)\)/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/** PURE. Why the scope does not match the PRs the range ships; empty when it does. */
export function scopeCoverage(shipped: readonly number[], scope: readonly ScopeEntry[]): string[] {
  const listed = new Set(scope.map((e) => e.pr));
  const range = new Set(shipped);
  const out: string[] = [];
  for (const pr of shipped) if (!listed.has(pr)) out.push(`PR ${pr} ships in this release but the runbook's scope does not list it: add it with check: <step> or none: <reason>`);
  for (const e of scope) if (!range.has(e.pr)) out.push(`scope lists PR ${e.pr} (${e.what}), which no commit in the range carries`);
  return out;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const release = flag("--release");
  const commit = flag("--commit");
  const origin = flag("--origin");
  if (!release || !commit || !/^[0-9a-f]{40}$/.test(commit) || !origin) {
    console.error("usage: bun scripts/release/scope.ts --release vA.B.C --commit <40-hex sha> --origin <url>");
    return 2;
  }
  const running = await readRunningVersion(origin);
  if ("error" in running) {
    console.error(`[scope] REFUSE: ${origin} reports no running version: ${running.error}`);
    return 1;
  }
  const from = runningPinRef(running);
  const log = spawnSync("git", ["log", "--format=%s", `${from}..${commit}`], { encoding: "utf8" });
  if (log.status !== 0) {
    console.error(`[scope] REFUSE: git log ${from}..${commit} failed: ${log.stderr.trim()}`);
    return 1;
  }
  const shipped = prsOf(log.stdout.split("\n"));
  const runbook = loadReleaseRunbook(release);
  const problems = scopeCoverage(shipped, runbook.scope);
  const checked = runbook.scope.filter((e) => e.check !== undefined).length;
  console.log(`[scope] ${release}: ${shipped.length} PR(s) from ${from} to ${commit.slice(0, 8)}; ${checked} checked by a step, ${runbook.scope.length - checked} with a reason`);
  for (const p of problems) console.error(`[scope] REFUSE: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
