// Guard for a `web-vA.B.C` tag push: the web content release line (D81,
// docs/technical/release-runbooks.md section 12). Modeled on
// scripts/check-analyst-sdk-tag.ts, whose compareSemver it reuses.
//
// A tag is refused when any holds:
//   1. its version differs from `version` in frontend/package.json at the tagged commit;
//   2. its version is not above every other `web-v*` tag;
//   3. the tagged commit is not reachable from an `origin/web/releases-*` branch.
//
// Usage: bun scripts/check-web-tag.ts <tag> [<sha>]   (sha defaults to HEAD)
// Exit 0 pass, 1 refused (reasons on stderr as ::error::), 2 the check could not read its inputs
// (never a pass: a check that cannot read its input has checked nothing).
import { spawnSync } from "node:child_process";
import { compareSemver, SEMVER } from "./check-analyst-sdk-tag.ts";

export const WEB_TAG_PREFIX = "web-v";
export const WEB_MANIFEST = "frontend/package.json";
export const WEB_RELEASE_BRANCH_GLOB = "origin/web/releases-*";

export interface WebGuardInput {
  readonly tag: string;
  /** `version` in frontend/package.json at the tagged commit. */
  readonly packageVersion: string;
  /** Every `web-v*` tag name in the repository; the tag itself is ignored. */
  readonly webTags: readonly string[];
  /** Remote-tracking branches (`origin/...`) that contain the tagged commit. */
  readonly branchesContainingCommit: readonly string[];
}

/** PURE. The refusal reasons; an empty list means the tag passes. */
export function checkWebTag(input: WebGuardInput): string[] {
  if (!input.tag.startsWith(WEB_TAG_PREFIX)) return [`tag ${input.tag} does not start with ${WEB_TAG_PREFIX}`];
  const reasons: string[] = [];
  const version = input.tag.slice(WEB_TAG_PREFIX.length);
  const semver = SEMVER.test(version);
  if (!semver) reasons.push(`tag ${input.tag} does not name an A.B.C version`);
  if (version !== input.packageVersion) {
    reasons.push(`tag version ${version} differs from ${WEB_MANIFEST} version ${input.packageVersion}`);
  }
  if (semver) {
    for (const other of input.webTags) {
      if (other === input.tag) continue;
      const v = other.slice(WEB_TAG_PREFIX.length);
      if (other.startsWith(WEB_TAG_PREFIX) && SEMVER.test(v) && compareSemver(version, v) <= 0) {
        reasons.push(`tag version ${version} is not above the previous tag ${other}`);
      }
    }
  }
  if (!input.branchesContainingCommit.some((b) => b.startsWith("origin/web/releases-"))) {
    reasons.push(`the tagged commit is not on any ${WEB_RELEASE_BRANCH_GLOB} branch`);
  }
  return reasons;
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);

if (import.meta.main) {
  const [tag, shaArg] = process.argv.slice(2);
  if (!tag) {
    console.error("usage: check-web-tag.ts <tag> [<sha>]");
    process.exit(2);
  }
  let input: WebGuardInput;
  try {
    const sha = shaArg ?? "HEAD";
    const packageVersion = JSON.parse(git(["show", `${sha}:${WEB_MANIFEST}`])).version as string;
    input = {
      tag,
      packageVersion,
      webTags: lines(git(["tag", "--list", `${WEB_TAG_PREFIX}*`])),
      branchesContainingCommit: lines(git(["branch", "-r", "--list", WEB_RELEASE_BRANCH_GLOB, "--contains", sha])),
    };
  } catch (e) {
    console.error(`::error::web tag guard could not read its inputs: ${(e as Error).message}`);
    process.exit(2);
  }
  const reasons = checkWebTag(input);
  for (const r of reasons) console.error(`::error::${r}`);
  process.exit(reasons.length ? 1 : 0);
}
