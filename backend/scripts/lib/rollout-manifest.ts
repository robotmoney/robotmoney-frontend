// The half of a release's step manifest that is not about the release.
//
// Every `upgrades/<from>-to-<to>/steps.ts` declared the same three things
// itself: the step TYPE, the four glob groups, and stepById(). Measured across
// the two live copies they were 68% identical, and the drift that matters is
// not the wording — it is that a glob group is an ORDERED array compared
// element-by-element against the runbook's generated `yaml step` blocks, so
// "add the release's own entry" and "append the release's own entry" are
// different facts and only one of them is right.
//
// WHAT STAYS PER-RELEASE, and why this module deliberately does not own it:
// STEPS itself (the manifest data), the release constants in release.ts, and
// the gate LETTERS — v0.2.2 gates are B/C/D/E, v0.3.0's are A/B/C/F. The letters
// are names, not an order, and a release that reuses the previous one's letter
// set by accident is exactly the class of bug the manifest exists to prevent.
// So the step type takes the gate union as a parameter rather than widening to
// `string` and checking nothing.

export type HostRole = "stage" | "cutover" | "any";
export type Actor = "script" | "operator" | "agent";

/**
 * One step of a rollout.
 *
 * `G` is the release's gate-letter union. Default `string` for consumers that
 * are release-agnostic (the probe); each release narrows it.
 */
export interface RolloutStep<G extends string = string> {
  /** Stable id, also the receipt filename. Phase-prefixed so manifest order
   *  and display order are the same thing. */
  id: string;
  phase: string;
  /** Runbook section this step is written in. The test asserts the prose at
   *  that section carries a matching `yaml step` block. */
  section: string;
  title: string;
  /** Gate letter, for the runbook's gate section. The letters are stable NAMES,
   *  not an order — execution order is manifest order. */
  gate?: G;
  hostRole: HostRole;
  actor: Actor;
  /** Step ids that must be `ok` before this one can run. */
  requires: string[];
  /**
   * Code paths whose change invalidates a completed receipt. This is the axis
   * that makes "we cut a new rc" answerable without redoing everything: a
   * docs-only commit invalidates nothing, while a commit touching a step's own
   * inputs invalidates exactly that step. Repo-relative globs, matched against
   * `git diff --name-only <receipt sha>..HEAD`.
   *
   * Empty = the step is not code-bound (an operator observation, a git tag).
   */
  dependsOn: string[];
  /**
   * Artifacts, relative to the backup dir. `<STAMP>` expands to .last-stamp.
   * Their absence demotes the step to `missing` no matter what a receipt says.
   *
   * Patterns are ANDed: every one listed must match something. Two spellings of
   * the same file are therefore ONE pattern, not two entries.
   */
  artifacts?: string[];
  /** Wall-clock validity. Expiry is amber (re-run advised), not red — unlike
   *  code drift, which is red. */
  ttlHours?: number;
  /** The command that performs (and, for scripts, records) this step. */
  verify: string;
  /** Derived from git/filesystem at probe time; carries no receipt. */
  derived?: boolean;
  /**
   * What `pg_is_in_recovery()` MUST have said on the connection this step ran
   * against: true = a read replica, false = the primary. A receipt that
   * disagrees graded the wrong server and is rejected outright — the "connects
   * successfully, to the wrong database" failure mode made durable.
   */
  expectInRecovery?: boolean;
  /** One line on why this step can be blocked or stale, shown by the probe. */
  note?: string;
}

// ── Glob groups ──────────────────────────────────────────────────────────────
//
// `backend/scripts/**` is deliberately NOT one of these: a change to
// stage-rehearsal.ts must not invalidate a preflight run, and a change to
// preflight.ts must not invalidate a boot rehearsal. Steps declare the files
// they actually execute, plus what those files read.
//
// ORDER IS PART OF THE CONTRACT. rollout-steps*.test.ts compares each step's
// `dependsOn` to the runbook's `depends-on:` block with toEqual — an ordered,
// element-by-element comparison. These builders therefore return arrays in a
// fixed order, and a release's own entries go where they have always gone, not
// at the end.

/** `upgrades/<dir>/` — the release directory a group's own scripts live in. */
type ReleaseDir = string;

const upgradeDir = (dir: ReleaseDir, file: string) => `backend/scripts/upgrades/${dir}/${file}`;

/** What preflight.ts executes and reads. */
export function preflightCode(dir: ReleaseDir): string[] {
  return [
    upgradeDir(dir, "preflight.ts"),
    upgradeDir(dir, "release.ts"),
    "backend/scripts/lib/preflight-utils.ts",
    "backend/scripts/lib/checks.ts",
    "backend/migrations/**",
  ];
}

/**
 * What postflight.ts executes and reads.
 *
 * `certifies` is the release-specific middle: the source whose behaviour that
 * release's postflight checks assert. v0.2.2 named `backend/src/swarm/handle.ts`
 * (AC2 calls the real derivation rather than a paraphrase); v0.3.0 names
 * `backend/src/db/seed.ts` (checks 3 and 5 certify seed()'s output).
 *
 * It is a PARAMETER IN THE MIDDLE, not something the caller appends, because
 * these arrays are compared to the runbook element-by-element: appending would
 * put it after `backend/migrations/**` and silently disagree with every
 * committed `depends-on:` block.
 */
export function postflightCode(dir: ReleaseDir, certifies: string[]): string[] {
  return [
    upgradeDir(dir, "postflight.ts"),
    upgradeDir(dir, "release.ts"),
    "backend/scripts/lib/postflight-utils.ts",
    "backend/scripts/lib/checks.ts",
    ...certifies,
    "backend/migrations/**",
  ];
}

/** The twin restore path. Identical in every release, and release-independent
 *  by construction — it lives in the root tree, not an upgrade directory. */
export const RESTORE_CODE: readonly string[] = Object.freeze([
  "scripts/lib/restore-container.ts",
  "scripts/lib/postgres-image.ts",
]);

/** What a real boot actually executes. This is why the rc.6 rehearsal survived
 *  the commits that invalidated its gates: none of them landed here. */
export const APP_CODE: readonly string[] = Object.freeze([
  "backend/src/**",
  "backend/migrations/**",
  "backend/Dockerfile",
  "frontend/**",
  "scripts/**",
  "docker-compose.yml",
  "docker-compose.demo.yml",
  "package.json",
  "bun.lock",
]);

export function stepById<G extends string>(steps: RolloutStep<G>[], id: string): RolloutStep<G> | undefined {
  return steps.find((s) => s.id === id);
}
