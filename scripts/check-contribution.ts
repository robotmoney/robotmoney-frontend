// Contribution governance gate — an author-aware, per-operation file guard.
//
// What it enforces:
//   1. create/edit/delete gate: every mutation in this PR's diff is classified
//      as a create, edit, or delete of a path, and checked against an explicit
//      per-GitHub-user authorization dictionary (.github/file-permissions.json).
//      The dictionary is DENY BY DEFAULT: an author with no matching glob for
//      the operation on the path is BLOCKED and redirected to CONTRIBUTING.md
//      "Where changes go" (or asked to have an admin grant it).
//   2. pm-state: for ALL authors, roadmap/checklist markdown task-list items must
//      not be committed into docs (they belong in the GitHub Plan issue).
//
// The permission model is the single source of truth in
// .github/file-permissions.json — a deny-by-default dictionary mapping each
// GitHub login to permitted path globs per operation (create/edit/delete, with
// an `all` shorthand and a `*` baseline unioned into every author). This gate
// is DIFF-SCOPED (only files changed in this PR's range are examined) and
// AUTHOR-AWARE (behavior depends on PR_AUTHOR's grants). It is a deterministic,
// non-network CI check.
//
// The human-judgment contribution rules (tone, scope, where prose belongs) live
// in CONTRIBUTING.md and are enforced by human reviewers — NOT by this script.
// This script only encodes the mechanical file-placement rule.

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export type Op = "create" | "edit" | "delete";

/** A single user's grants — permitted globs per operation, plus the 'all' shorthand. */
export interface UserGrant {
  create?: string[];
  edit?: string[];
  delete?: string[];
  all?: string[];
}

/** The parsed permission dictionary. Keys are lowercased GitHub logins (and '*'). */
export interface Policy {
  users: Record<string, UserGrant>;
}

/**
 * Parse the .github/file-permissions.json text into a Policy.
 *
 * Tolerates missing/empty/invalid text -> an empty users map. Any key starting
 * with "//" (documentation/comment keys) is ignored at both the top level and
 * inside the users map. User logins are lowercased.
 */
export function parsePolicy(text: string): Policy {
  const users: Record<string, UserGrant> = {};
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return { users };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { users };
  }
  if (raw === null || typeof raw !== "object") return { users };

  const rawUsers = (raw as Record<string, unknown>).users;
  if (rawUsers === null || typeof rawUsers !== "object") return { users };

  for (const [login, grantRaw] of Object.entries(rawUsers as Record<string, unknown>)) {
    if (login.startsWith("//")) continue; // documentation key
    if (grantRaw === null || typeof grantRaw !== "object") continue;
    const g = grantRaw as Record<string, unknown>;
    const grant: UserGrant = {};
    for (const op of ["create", "edit", "delete", "all"] as const) {
      const v = g[op];
      if (Array.isArray(v)) grant[op] = v.filter((x): x is string => typeof x === "string");
    }
    users[login.toLowerCase()] = grant;
  }
  return { users };
}

/**
 * The union of globs that apply to `user` for operation `op`:
 *   users[user][op] ∪ users[user].all ∪ users['*'][op] ∪ users['*'].all
 * (any missing entry contributes []). User keys are matched case-insensitively.
 */
export function effectiveGlobs(policy: Policy, user: string, op: Op): string[] {
  const key = user.toLowerCase();
  const specific = policy.users[key];
  const baseline = policy.users["*"];
  const out: string[] = [];
  const push = (arr?: string[]) => {
    if (arr) for (const g of arr) out.push(g);
  };
  push(specific?.[op]);
  push(specific?.all);
  push(baseline?.[op]);
  push(baseline?.all);
  return out;
}

/**
 * True iff `path` (normalized to forward slashes) matches any glob in
 * effectiveGlobs(policy, user, op) via Bun.Glob.
 */
export function isPermitted(policy: Policy, user: string, op: Op, path: string): boolean {
  const p = path.replace(/\\/g, "/");
  for (const glob of effectiveGlobs(policy, user, op)) {
    if (new Bun.Glob(glob).match(p)) return true;
  }
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
  // handled by callers (missing policy file, unfetched base ref, etc.).
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

  // Permission dictionary — the single source of truth. Read it as it exists at
  // HEAD (the PR tip, where the file is committed in CI); if absent there, fall
  // back to the merge base, then to an empty policy. Using git (not node:fs)
  // keeps this to a single non-JSON import and makes the read diff-scoped.
  const policyAtHead = tryGit(["show", "HEAD:.github/file-permissions.json"], repoRoot);
  const policyAtBase = tryGit(["show", `${mergeBase}:.github/file-permissions.json`], repoRoot);
  const policyText = policyAtHead.ok
    ? policyAtHead.out
    : policyAtBase.ok
      ? policyAtBase.out
      : "{}";
  const policy = parsePolicy(policyText);

  const violations: string[] = [];

  // --- Check 1: create/edit/delete gate --------------------------------------
  // Classify every mutation in the diff and check it against the dictionary.
  const nameStatus = git(
    ["diff", "--name-status", "--diff-filter=ADMRC", mergeBase, "HEAD"],
    repoRoot,
  );
  const ops: Array<{ op: Op; path: string }> = [];
  for (const line of nameStatus.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const status = parts[0].trim();
    const code = status[0];
    if (code === "A") {
      if (parts[1]) ops.push({ op: "create", path: parts[1].trim() });
    } else if (code === "M") {
      if (parts[1]) ops.push({ op: "edit", path: parts[1].trim() });
    } else if (code === "D") {
      if (parts[1]) ops.push({ op: "delete", path: parts[1].trim() });
    } else if (code === "R") {
      // R<score>\told\tnew — a rename is a delete of old + a create of new.
      if (parts[1]) ops.push({ op: "delete", path: parts[1].trim() });
      if (parts[2]) ops.push({ op: "create", path: parts[2].trim() });
    } else if (code === "C") {
      // C<score>\told\tnew — a copy is a create of new (old is untouched).
      if (parts[2]) ops.push({ op: "create", path: parts[2].trim() });
    }
  }

  for (const { op, path } of ops) {
    if (isPermitted(policy, prAuthor, op, path)) continue;

    let message =
      `@${prAuthor} is not allowed to ${op} this file ` +
      `(deny-by-default; grant it in .github/file-permissions.json or ask an admin). ` +
      `See CONTRIBUTING.md "Where changes go".`;

    // Redirect hint for new committed docs.
    const norm = path.replace(/\\/g, "/");
    if (op === "create" && norm.startsWith("docs/") && norm.endsWith(".md")) {
      message +=
        " docs decisions belong upstream in robotmoney-context; roadmap/checklist state belongs in the GitHub Plan issue.";
    }

    violations.push(`${path}: [permission] ${message}`);
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
