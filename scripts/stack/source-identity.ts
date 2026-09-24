// WHAT SOURCE EACH IMAGE IS BUILT FROM — the plan id's image input (spec §1.2
// as amended by D52, decisions.md D52).
//
// §1.2: the plan id hashes "each image's source identity, the Git tree hash of
// its build context, not its built digest, which changes on every rebuild and
// is recorded in the receipt instead". A digest is the wrong input for an
// INTENT hash: `docker build` stamps timestamps and layer metadata into the
// image, so two builds of one tree give two digests, and a rerun after a
// rebuild would supersede its own journal (§1.3 rule 2) although nothing the
// operator asked for changed. A Git tree hash names the bytes that went IN,
// so it is stable across rebuilds and moves the moment a source file does.
//
// Sibling of scripts/stack/build-identity.ts, and deliberately different on
// one point. build-identity NEVER throws, because an image with an honest
// "unavailable" commit is still deployable. This module THROWS: a plan id
// computed without its source identity would resume or supersede a journal on
// a guess, and §1.3's rules are only as good as the id they compare.
//
// ── A dirty tree has a tree hash too ────────────────────────────────────────
//
// `git rev-parse HEAD:<context>` answers for the last COMMIT, which is wrong
// for the case that matters most on a stage host: an operator editing a file
// and rerunning. So the tree is computed from the WORKING TREE, through a
// temporary index: copy the real index (for its stat cache), `git add -A` the
// context into the copy, `git write-tree`, and read the context's subtree. The
// real index is never written, so the operator's staged state is untouched.
// On a clean tree the answer equals `git rev-parse HEAD:<context>`; after any
// modification, addition or deletion under the context it differs.
//
// What counts as source is what Git would commit: tracked files plus untracked
// files that `.gitignore` does not exclude. An ignored file is not source even
// when it sits in the build context; if a Dockerfile ever COPYs one, that file
// has to become tracked for the plan id to see it.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

/** A synchronous command runner, with extra environment for one call. Runs in the repository root. */
export type SourceRunner = (
  argv: string[],
  env?: Readonly<Record<string, string>>,
) => { exitCode: number; stdout: string; stderr: string };

/** A Git object id: SHA-1 (40 hex) or SHA-256 (64 hex) repositories. */
export const SOURCE_IDENTITY_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The runner `bun smoke` uses: `git` in `repoRoot`, with the process environment plus `env`. */
export function gitRunner(repoRoot: string): SourceRunner {
  return (argv, env) => {
    const result = Bun.spawnSync(argv, {
      cwd: repoRoot,
      env: { ...process.env, ...(env ?? {}) },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
}

/**
 * A build context as Git names it: relative to the repository root, `.` for
 * the root itself. Refuses an absolute path or one that climbs out of the
 * repository, since neither is a tree this repository can hash.
 */
export function normalizeContext(context: string): string {
  if (isAbsolute(context)) {
    throw new Error(`Refusing: build context ${context} is absolute; a source identity is relative to the repository.`);
  }
  const normal = normalize(context).replace(/\/+$/, "");
  if (normal === ".." || normal.startsWith("../")) {
    throw new Error(`Refusing: build context ${context} leaves the repository, so it has no Git tree.`);
  }
  return normal === "" ? "." : normal;
}

function must(run: SourceRunner, argv: string[], env?: Readonly<Record<string, string>>): string {
  let result: ReturnType<SourceRunner>;
  try {
    result = run(argv, env);
  } catch (error) {
    throw new Error(`Refusing: \`${argv.join(" ")}\` could not run (${(error as Error).message}); no source identity.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Refusing: \`${argv.join(" ")}\` failed (exit ${result.exitCode}): ${result.stderr.trim() || "no output"}; no source identity.`,
    );
  }
  return result.stdout.trim();
}

/**
 * The Git tree hash of every named build context, computed from the working
 * tree in one pass. Output: context → tree id, for each distinct context.
 *
 * Refusal cases (throws): a context that is absolute or outside the
 * repository; a context with no source files in it; any `git` step failing —
 * including a directory that is not a repository at all.
 */
export function resolveSourceTrees(run: SourceRunner, contexts: readonly string[]): Readonly<Record<string, string>> {
  const unique = [...new Set(contexts.map(normalizeContext))].sort();
  if (unique.length === 0) return {};

  const realIndex = must(run, ["git", "rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const scratch = mkdtempSync(join(tmpdir(), "rm-source-identity-"));
  try {
    const index = join(scratch, "index");
    // Starting from the real index keeps Git's stat cache, so unchanged files
    // are not re-hashed; a repository with no index yet starts empty.
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index };
    must(run, ["git", "add", "--all", "--", ...unique], env);
    const root = must(run, ["git", "write-tree"], env);
    const trees: Record<string, string> = {};
    for (const context of unique) {
      const tree = context === "." ? root : must(run, ["git", "rev-parse", "--verify", `${root}:${context}`]);
      if (!SOURCE_IDENTITY_PATTERN.test(tree)) {
        throw new Error(`Refusing: build context ${context} resolved to ${tree}, which is not a Git tree id.`);
      }
      trees[context] = tree;
    }
    return trees;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Each service's source identity, from a map of service → build context.
 * What `bun smoke` puts in `DeploymentPlan.images[service].source`.
 */
export function resolveSourceIdentities(
  run: SourceRunner,
  contexts: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const trees = resolveSourceTrees(run, Object.values(contexts));
  return Object.fromEntries(
    Object.entries(contexts).map(([service, context]) => [service, trees[normalizeContext(context)] as string]),
  );
}
