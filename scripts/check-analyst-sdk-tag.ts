// Guard for an `analyst-sdk-vA.B.C` tag push (D77 item 4, runbook section 11).
//
// A tag is refused when either holds:
//   1. its version differs from `version` in packages/analyst-sdk/package.json;
//   2. the tagged commit is not reachable from an `origin/analyst-sdk/releases-*` branch.
//
// Usage: bun scripts/check-analyst-sdk-tag.ts <tag> [<sha>]   (sha defaults to HEAD)
// Exit 0 pass, 1 refused (reasons on stderr as ::error::), 2 the check could not read its inputs
// (never a pass: a check that cannot read its input has checked nothing).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const TAG_PREFIX = "analyst-sdk-v";
export const MANIFEST = "packages/analyst-sdk/package.json";
export const RELEASE_BRANCH_GLOB = "origin/analyst-sdk/releases-*";

export const SEMVER = /^\d+\.\d+\.\d+$/;

/** PURE. Orders two A.B.C versions: negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export interface GuardInput {
  tag: string;
  packageVersion: string;
  /** Remote-tracking branches (`origin/...`) that contain the tagged commit. */
  branchesContainingCommit: string[];
}

/** Returns the refusal reasons; an empty list means the tag passes. */
export function checkTag(input: GuardInput): string[] {
  const reasons: string[] = [];
  if (!input.tag.startsWith(TAG_PREFIX)) {
    reasons.push(`tag ${input.tag} does not start with ${TAG_PREFIX}`);
    return reasons;
  }
  const tagVersion = input.tag.slice(TAG_PREFIX.length);
  if (!SEMVER.test(tagVersion)) reasons.push(`tag ${input.tag} does not name an A.B.C version`);
  if (tagVersion !== input.packageVersion) {
    reasons.push(`tag version ${tagVersion} differs from ${MANIFEST} version ${input.packageVersion}`);
  }
  const onRelease = input.branchesContainingCommit.some((b) => b.startsWith("origin/analyst-sdk/releases-"));
  if (!onRelease) {
    reasons.push(`the tagged commit is not on any ${RELEASE_BRANCH_GLOB} branch`);
  }
  return reasons;
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

if (import.meta.main) {
  const [tag, shaArg] = process.argv.slice(2);
  if (!tag) {
    console.error("usage: check-analyst-sdk-tag.ts <tag> [<sha>]");
    process.exit(2);
  }
  let input: GuardInput;
  try {
    const sha = shaArg ?? "HEAD";
    const packageVersion = JSON.parse(readFileSync(MANIFEST, "utf8")).version as string;
    const branches = git(["branch", "-r", "--list", RELEASE_BRANCH_GLOB, "--contains", sha])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    input = { tag, packageVersion, branchesContainingCommit: branches };
  } catch (e) {
    console.error(`::error::analyst-sdk tag guard could not read its inputs: ${(e as Error).message}`);
    process.exit(2);
  }
  const reasons = checkTag(input);
  for (const r of reasons) console.error(`::error::${r}`);
  process.exit(reasons.length ? 1 : 0);
}
