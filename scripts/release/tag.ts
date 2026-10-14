#!/usr/bin/env bun
// scripts/release/tag.ts — the rc tag after a passed stage run, and release
// step C1, run ON THE CONTROL MACHINE. Standing check SW.3 (C1). Policy §3 and
// D70: stage runs a QA commit; once it passes, the QA branch is squashed onto
// the release branch and the rc is cut at the squash commit, whose tree must
// be the tree stage passed; production runs only by that rc tag; the version
// tag goes on the rc's commit as soon as the cutover starts.
//
//   bun scripts/release/tag.ts rc    --release v0.6.2 --commit <squash sha> --stage-journal <passed stage run dir>
//   bun scripts/release/tag.ts final --release v0.6.2 --commit <sha>
//
// rc: after `git fetch --tags origin`, refuses a commit that is not on
// origin/releases-A.B.x, and a stage journal that did not pass or whose tree
// is not the commit's tree. If a `<release>-rc.N` tag already points at the
// commit, it records that tag and changes nothing. Otherwise it tags the next
// free N (0 when none exists) and pushes it. It is no step of the run.
// final: if `<release>` exists it must point at the commit (anything else
// refuses); otherwise it tags the commit and pushes it. C1 is a prod-only step
// (`onlyFor: "prod"`): a stage run records it skipped and tags nothing.
import { spawnSync } from "node:child_process";
import { originProblems } from "./go.ts";
import { readJournal, runStatus, type RunJournal } from "./journal.ts";

const SHA_RE = /^[0-9a-f]{40}$/;

/** PURE. The next rc tag of a release from the tags that exist. */
export function nextRcTag(release: string, tags: readonly string[]): string {
  const prefix = `${release}-rc.`;
  const ns = tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)).filter((n) => /^\d+$/.test(n)).map(Number);
  return `${prefix}${ns.length === 0 ? 0 : Math.max(...ns) + 1}`;
}

/** PURE. The rc tags of a release among the tags pointing at a commit. */
export function rcTagsAt(release: string, tagsAtCommit: readonly string[]): string[] {
  return tagsAtCommit.filter((t) => new RegExp(`^${release.replace(/\./g, "\\.")}-rc\\.\\d+$`).test(t));
}

/** PURE. Why a stage journal does not authorize an rc at a commit with this tree; empty when it does (D70). */
export function rcStageProblems(journal: RunJournal | undefined, release: string, tree: string): string[] {
  if (journal === undefined) return ["no stage run journal at --stage-journal"];
  const out: string[] = [];
  if (journal.rmEnv !== "stage") out.push(`the journal is a ${journal.rmEnv} run, not a stage run`);
  if (journal.release !== release) out.push(`the stage run was of ${journal.release}, not ${release}`);
  if (runStatus(journal, journal.stepIds) !== "passed") out.push(`the stage run ${journal.runTs} did not pass`);
  if (journal.tree === undefined) out.push(`the stage run ${journal.runTs} records no tree`);
  else if (journal.tree !== tree) out.push(`the stage run's tree ${journal.tree.slice(0, 12)} is not this commit's tree ${tree.slice(0, 12)}: squash the stage-passed QA branch onto an unmoved release branch, or rerun stage`);
  return out;
}

const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" });
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function createAndPush(tag: string, commit: string): number {
  const t = git(["tag", "-a", tag, commit, "-m", tag]);
  if (t.status !== 0) { console.error(`[tag] git tag ${tag} failed: ${t.stderr.trim()}`); return 1; }
  const p = git(["push", "origin", tag]);
  if (p.status !== 0) { console.error(`[tag] git push origin ${tag} failed: ${p.stderr.trim()}`); return 1; }
  console.log(`[tag] ${tag} → ${commit}, pushed`);
  return 0;
}

function main(): number {
  const mode = process.argv[2];
  const release = flag("--release");
  const commit = flag("--commit");
  if ((mode !== "rc" && mode !== "final") || !release || !/^v\d+\.\d+\.\d+$/.test(release) || !commit || !SHA_RE.test(commit)) {
    console.error("usage: bun scripts/release/tag.ts rc --release vX.Y.Z --commit <40-hex sha> --stage-journal <dir> | final --release vX.Y.Z --commit <40-hex sha>");
    return 2;
  }
  const f = git(["fetch", "--tags", "origin"]);
  if (f.status !== 0) { console.error(`[tag] git fetch --tags origin failed: ${f.stderr.trim()}`); return 1; }
  if (git(["cat-file", "-e", `${commit}^{commit}`]).status !== 0) { console.error(`[tag] ${commit} is not a commit here`); return 1; }

  if (mode === "rc") {
    const branches = git(["branch", "-r", "--contains", commit]);
    const origin = branches.status === 0 ? originProblems(release, commit, branches.stdout) : [`git branch -r --contains ${commit} failed: ${branches.stderr.trim()}`];
    if (origin.length > 0) { console.error(`[tag] refusing: ${origin.join("; ")}`); return 1; }
    const stageDir = flag("--stage-journal");
    if (!stageDir) { console.error("[tag] refusing: rc needs --stage-journal <the passed stage run's journal dir> (D70)"); return 2; }
    const tree = git(["rev-parse", `${commit}^{tree}`]).stdout.trim();
    const stage = rcStageProblems(readJournal(stageDir), release, tree);
    if (stage.length > 0) { console.error(`[tag] refusing: ${stage.join("; ")}`); return 1; }
    const at = rcTagsAt(release, lines(git(["tag", "--points-at", commit]).stdout));
    if (at.length > 0) { console.log(`[tag] ${at.join(", ")} already points at ${commit}; nothing to do`); return 0; }
    return createAndPush(nextRcTag(release, lines(git(["tag", "--list", `${release}-rc.*`]).stdout)), commit);
  }
  const existing = git(["rev-parse", "--verify", "--quiet", `${release}^{commit}`]);
  if (existing.status === 0) {
    const at = existing.stdout.trim();
    if (at !== commit) { console.error(`[tag] ${release} exists at ${at}, not ${commit}: refusing`); return 1; }
    console.log(`[tag] ${release} already points at ${commit}; nothing to do`);
    return 0;
  }
  return createAndPush(release, commit);
}

if (import.meta.main) process.exitCode = main();
