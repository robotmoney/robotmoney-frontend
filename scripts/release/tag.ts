#!/usr/bin/env bun
// scripts/release/tag.ts — release steps R5.rc and W3, run ON THE CONTROL MACHINE.
// Standing check SW.3 (W3). Policy §3: rc tags, then the final tag on the
// commit production runs.
//
//   bun scripts/release/tag.ts rc    --release v0.6.0 --commit <sha>
//   bun scripts/release/tag.ts final --release v0.6.0 --commit <sha>
//
// rc: after `git fetch --tags origin`, if a `<release>-rc.N` tag already points
// at the commit, it records that tag and changes nothing. Otherwise it tags
// the next free N (0 when none exists) and pushes it.
// final: if `<release>` exists it must point at the commit (anything else
// refuses); otherwise it tags the commit and pushes it.
//
// Both are prod-only steps (`onlyFor: "prod"`): a stage run records them
// skipped and tags nothing.
import { spawnSync } from "node:child_process";

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
    console.error("usage: bun scripts/release/tag.ts <rc|final> --release vX.Y.Z --commit <40-hex sha>");
    return 2;
  }
  const f = git(["fetch", "--tags", "origin"]);
  if (f.status !== 0) { console.error(`[tag] git fetch --tags origin failed: ${f.stderr.trim()}`); return 1; }
  if (git(["cat-file", "-e", `${commit}^{commit}`]).status !== 0) { console.error(`[tag] ${commit} is not a commit here`); return 1; }

  if (mode === "rc") {
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
