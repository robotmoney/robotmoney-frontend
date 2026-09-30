// WHAT SOURCE THIS STACK IS BUILDING (AC-ID-03), resolved once, from the tree
// being built, and passed to `docker compose build` as build args.
//
// The identity has to be decided HERE, on the machine holding the repository,
// because the image it is baked into has no repository in it. The alternative —
// a container asking `git` at runtime — would answer with whatever tree it
// could reach, which on a staging host is precisely the unpinned checkout
// AC-ID-03 exists to catch.
//
// PURE PARSER + IMPURE RESOLVER, the split scripts/stack/config.ts's header
// requires: `buildIdentityFrom()` is a total function over three command
// outputs and is what the unit suite pins; `resolveBuildIdentityEnv()` is the
// thin shell that obtains them through the caller's own runner, so the stack's
// single spawn seam (StackRuntime) stays the only place a child process is
// created.

/** The compose interpolation variables docker-compose.yml's build args read. */
export const BUILD_COMMIT_COMPOSE_VAR = "RM_BUILD_COMMIT";
export const BUILD_TAG_COMPOSE_VAR = "RM_BUILD_TAG";

export interface GitIdentityInputs {
  /** `git rev-parse HEAD` stdout, or "" when the command failed. */
  head: string;
  /** `git describe --tags --exact-match HEAD` stdout, or "" when there is none. */
  exactTag: string;
  /** `git status --porcelain` stdout; non-empty means the tree is modified. */
  porcelain: string;
  /**
   * `git status --porcelain` COULD NOT BE RUN — a non-zero exit, or a runner
   * that threw. NOT the same as an empty `porcelain`, and that distinction is
   * the whole reason this field exists.
   *
   * For `head` and `exactTag` an empty string is the SAFE default: "no commit
   * available", "no tag on this commit". For `porcelain` the empty string is
   * the UNSAFE one — it reads as "clean" — so a probe that failed must not be
   * allowed to collapse into it. An unreadable index (`git status` exiting 128
   * while `rev-parse` and `describe` succeed, because those read refs and not
   * the index) would otherwise stamp the image with the pinned SHA and the
   * exact tag for a tree nobody checked, which is exactly the condition
   * AC-ID-03 exists to detect.
   */
  porcelainUnavailable?: boolean;
}

/**
 * The two values, from three command outputs.
 *
 * ONLY AN EXACT TAG COUNTS. `git describe` without `--exact-match` answers
 * `v0.5.0-rc.1-3-gabc1234` for a commit three past the tag — a string that
 * READS like a tag in a dashboard and is not one. An untagged tree reports no
 * tag at all, and an operator comparing against AC-ID-01's RC tag sees the
 * absence instead of a near-miss.
 *
 * A MODIFIED TREE CANNOT REPORT THE PINNED SHA. When `git status --porcelain`
 * is non-empty the commit is reported as `<sha>+dirty`, which by construction
 * fails a string comparison against the RC's SHA. A boolean flag beside an
 * unchanged SHA would be the weaker choice: the check AC-ID-03 is actually
 * subjected to is "does the deployed commit equal the tag's commit", and a flag
 * is a second field that check can forget to read. The tag is dropped for the
 * same reason — a dirty tree is not the tagged artifact.
 *
 * AND NEITHER CAN AN UNCHECKED ONE. `porcelainUnavailable` — the status probe
 * failed rather than answered — reports `<sha>+unknown` and drops the tag, the
 * same treatment a dirty tree gets. This module's rule everywhere else is
 * explicit-or-unavailable, and "the tree was not checked" must not be spelled
 * the same way as "the tree is clean": the guarantee in the paragraph above is
 * only worth having if it cannot be satisfied by a probe that never ran. The
 * suffix differs from `+dirty` so an operator reading `/version` can tell a
 * modified checkout from an unreadable one; both fail the comparison against
 * the RC's SHA, which is the property AC-ID-03 leans on.
 *
 * NO FALLBACKS. A repository that cannot be read yields "" for both, which the
 * backend reports as `unavailable` with the reason named. There is deliberately
 * no branch name, package version or timestamp substitute: each looks like
 * identity while being unable to identify a source.
 */
export function buildIdentityFrom(inputs: GitIdentityInputs): Record<string, string> {
  const head = inputs.head.trim();
  const unknown = inputs.porcelainUnavailable === true;
  const dirty = !unknown && inputs.porcelain.trim() !== "";
  const tag = inputs.exactTag.trim();
  const suffix = unknown ? "+unknown" : dirty ? "+dirty" : "";
  return {
    [BUILD_COMMIT_COMPOSE_VAR]: head === "" ? "" : `${head}${suffix}`,
    [BUILD_TAG_COMPOSE_VAR]: suffix === "" ? tag : "",
  };
}

/** A synchronous command runner — `StackRuntime.runSync`'s shape. */
export type IdentityRunner = (argv: string[]) => { exitCode: number; stdout: string; stderr: string };

/**
 * Resolve the build identity of the tree at `repoRoot`.
 *
 * NEVER THROWS, and that is deliberate rather than lax: a missing `git`, a
 * tarball checkout, or a repository this process cannot read are all real
 * situations in which the stack should still come up — reporting `unavailable`,
 * loudly, at /version. Failing the bring-up instead would make an honest
 * "I don't know" impossible to deploy.
 */
export function resolveBuildIdentityEnv(run: IdentityRunner): Record<string, string> {
  // THE EXIT CODE IS CARRIED, NOT DISCARDED. Collapsing a failed probe to ""
  // is right for `head` and `exactTag` and WRONG for `porcelain` (see
  // GitIdentityInputs.porcelainUnavailable), so the shell reports both what the
  // command printed and whether it answered at all, and lets the pure function
  // decide what each absence means.
  const read = (argv: string[]): { stdout: string; ok: boolean } => {
    try {
      const r = run(argv);
      return r.exitCode === 0 ? { stdout: r.stdout, ok: true } : { stdout: "", ok: false };
    } catch {
      return { stdout: "", ok: false };
    }
  };
  // Asked in this order on purpose — cheapest fact first, and the order the
  // unit suite pins so a reordering that changed which probe a failing runner
  // hit first would be visible.
  const head = read(["git", "rev-parse", "HEAD"]);
  const exactTag = read(["git", "describe", "--tags", "--exact-match", "HEAD"]);
  const porcelain = read(["git", "status", "--porcelain"]);
  return buildIdentityFrom({
    head: head.stdout,
    exactTag: exactTag.stdout,
    porcelain: porcelain.stdout,
    porcelainUnavailable: !porcelain.ok,
  });
}
