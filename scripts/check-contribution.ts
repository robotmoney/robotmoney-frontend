// Contribution governance gate — an author-aware file-CREATION guard.
//
// What it enforces:
//   1. create-gate: casual contributors (PR authors who are NOT codeowners) may
//      edit existing files freely, but may only ADD brand-new files inside a
//      small allowlist (test files). Everything else is a violation and they are
//      redirected to CONTRIBUTING.md "Where changes go" or asked to have a
//      codeowner add the file. Owners bypass the create-gate entirely — they may
//      create files anywhere.
//   2. pm-state: for ALL authors, roadmap/checklist markdown task-list items must
//      not be committed into docs (they belong in the GitHub Plan issue).
//
// The owner set is read from .github/CODEOWNERS — the single source of truth for
// who may create files. This gate is DIFF-SCOPED (only files added in this PR's
// range are examined) and AUTHOR-AWARE (behavior depends on PR_AUTHOR's owner
// membership). It is a deterministic, non-network CI check.
//
// The human-judgment contribution rules (tone, scope, where prose belongs) live
// in CONTRIBUTING.md and are enforced by human reviewers — NOT by this script.
// This script only encodes the mechanical file-placement rule.

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Collect every distinct @login token from a CODEOWNERS file.
 *
 * Comment lines (starting with #) are ignored for @login harvesting — owners
 * appear only as path-rule targets on non-comment lines. Logins are returned
 * lowercased and with the leading @ stripped.
 */
export function parseOwners(text: string): Set<string> {
  const owners = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue; // comment: no owner context
    for (const match of line.matchAll(/@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/g)) {
      owners.add(match[1].toLowerCase());
    }
  }
  return owners;
}

/**
 * True when a NON-owner is allowed to add this new file. Rule: test files only.
 * The path is repo-relative with forward slashes.
 */
export function isAllowedCreation(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (p.endsWith(".test.ts")) return true;
  if (p.endsWith(".spec.ts")) return true;
  const segments = p.split("/");
  if (segments.includes("tests") || segments.includes("test")) return true;
  return false;
}

// Match a markdown task-list item, e.g. "- [ ] do a thing" or "* [x] done".
const TASK_LIST_RE = /^\s*[-*]\s+\[[ xX]\]\s/;

/** True when a docs path is a governed markdown doc (docs markdown, not code-review). */
// NOTE: uses // line comments only — the governed globs are docs slash-star-star
// slash-star.md but NOT docs/code-review/** and a block comment containing the
// literal star-slash from a glob would terminate early.
export function isGovernedDoc(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (!p.startsWith("docs/")) return false;
  if (!p.endsWith(".md")) return false;
  if (p.startsWith("docs/code-review/")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Runnable gate
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function tryGit(args: string[], cwd: string): { ok: true; out: string } | { ok: false } {
  // Suppress git's own diagnostic stderr — failures here are expected and
  // handled by callers (missing CODEOWNERS, unfetched base ref, etc.).
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { ok: true, out };
  } catch {
    return { ok: false };
  }
}

function main(): void {
  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();

  const prAuthor = (process.env.PR_AUTHOR ?? "").trim();
  if (prAuthor === "") {
    process.stderr.write(
      "[contribution] PR_AUTHOR unset — this gate is a PR-time concern; skipping (local dev / push).\n",
    );
    process.exit(0);
  }

  const baseRefRaw = process.env.BASE_REF;
  const baseRefExplicit = baseRefRaw !== undefined && baseRefRaw.trim() !== "";
  const baseRef = baseRefExplicit ? baseRefRaw!.trim() : "origin/main";

  const mergeBaseResult = tryGit(["merge-base", baseRef, "HEAD"], repoRoot);
  if (!mergeBaseResult.ok) {
    if (baseRefExplicit) {
      process.stderr.write(
        `[contribution] FATAL: could not compute merge-base of ${baseRef} and HEAD; the base ref must be fetched in CI. Refusing to silently pass.\n`,
      );
      process.exit(1);
    }
    process.stderr.write(
      `[contribution] WARNING: could not compute merge-base of ${baseRef} and HEAD (default base, local run); skipping.\n`,
    );
    process.exit(0);
  }
  const mergeBase = mergeBaseResult.out.trim();

  // Owner set — single source of truth. Read CODEOWNERS as it exists at HEAD
  // (the PR tip, where the file is committed in CI); if absent there, fall back
  // to the merge base. Using git (not node:fs) keeps this to a single import.
  // If it does not exist in either, the owner set is empty.
  const codeownersAtHead = tryGit(["show", "HEAD:.github/CODEOWNERS"], repoRoot);
  const codeownersAtBase = tryGit(["show", `${mergeBase}:.github/CODEOWNERS`], repoRoot);
  const codeownersText = codeownersAtHead.ok
    ? codeownersAtHead.out
    : codeownersAtBase.ok
      ? codeownersAtBase.out
      : "";
  const owners = parseOwners(codeownersText);
  const ownerList = [...owners].map((o) => `@${o}`);
  const ownerListStr = ownerList.length > 0 ? ownerList.join(" ") : "(no codeowners configured)";
  const authorIsOwner = owners.has(prAuthor.toLowerCase());

  // Existing top-level entries at the merge base (to detect new top-level paths).
  const topLevel = new Set<string>();
  const lsTree = tryGit(["ls-tree", mergeBase, "--name-only"], repoRoot);
  if (lsTree.ok) {
    for (const name of lsTree.out.split("\n")) {
      const n = name.trim();
      if (n.length > 0) topLevel.add(n);
    }
  }

  const violations: string[] = [];

  // --- Check 1: create-gate (non-owners only) --------------------------------
  const addedRaw = git(["diff", "--name-status", "--diff-filter=A", mergeBase, "HEAD"], repoRoot);
  const addedFiles: string[] = [];
  for (const line of addedRaw.split("\n")) {
    if (line.trim() === "") continue;
    // Format: "A\t<path>"
    const parts = line.split("\t");
    if (parts[0].trim() === "A" && parts[1]) addedFiles.push(parts[1].trim());
  }

  if (!authorIsOwner) {
    for (const p of addedFiles) {
      if (isAllowedCreation(p)) continue;

      const firstSegment = p.replace(/\\/g, "/").split("/")[0];
      const introducesNewTopLevel = !topLevel.has(firstSegment);

      let message: string;
      if (introducesNewTopLevel) {
        message =
          `casual contributors may not introduce a new top-level path (${firstSegment}/); ` +
          `edit existing files freely, add tests, or ask a codeowner (${ownerListStr}) to add it. ` +
          `See CONTRIBUTING.md "Where changes go".`;
      } else {
        message =
          `casual contributors may not create new files here; edit existing files freely, add tests, ` +
          `or ask a codeowner (${ownerListStr}) to add it. See CONTRIBUTING.md "Where changes go".`;
      }

      // Redirect hint for new committed docs.
      const norm = p.replace(/\\/g, "/");
      if (norm.startsWith("docs/") && norm.endsWith(".md")) {
        message +=
          " docs decisions belong upstream in robotmoney-context; roadmap/checklist state belongs in the GitHub Plan issue.";
      }

      violations.push(`${p}: [create-gate] ${message}`);
    }
  }

  // --- Check 2: pm-state (all authors) ---------------------------------------
  const docsDiff = tryGit(["diff", "--unified=0", mergeBase, "HEAD", "--", "docs"], repoRoot);
  if (docsDiff.ok) {
    let currentFile: string | null = null;
    let lineNo = 0;
    for (const line of docsDiff.out.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice("+++ b/".length).trim();
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("@@")) {
        // Parse new-file start line from the hunk header: @@ -a,b +c,d @@
        const m = line.match(/\+(\d+)/);
        lineNo = m ? parseInt(m[1], 10) : 0;
        continue;
      }
      if (line.startsWith("+")) {
        const added = line.slice(1);
        if (currentFile && isGovernedDoc(currentFile) && TASK_LIST_RE.test(added)) {
          if (!added.includes("contribution-check-ignore")) {
            violations.push(
              `${currentFile}:${lineNo}: [pm-state] roadmap/checklist state belongs in the GitHub Plan issue, not a committed doc`,
            );
          }
        }
        lineNo++;
        continue;
      }
      // context lines don't occur with --unified=0; deletions start with '-'
    }
  }

  // --- Output ----------------------------------------------------------------
  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`${v}\n`);
    process.stderr.write(`${violations.length} contribution violation(s)\n`);
    process.exit(1);
  }

  process.stdout.write("contribution check OK\n");
  process.exit(0);
}

if (import.meta.main) {
  main();
}
