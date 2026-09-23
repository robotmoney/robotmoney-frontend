// Deployment instance identity and the per-instance state directory.
//
// "Every run acts on one named deployment instance" (spec §1.1). This module
// decides WHICH instance a run is acting on, and owns the on-disk layout that
// everything else in W1 persists into: the instance name itself, the role
// passwords smoke generated for a local Postgres, the journal, the receipt, the
// deployment lock, and the spoofed-key generation.
//
// STUB (issue #1026, W1 step 1). Signatures and types are real; every body
// throws. Nothing imports this module yet, and nothing may import it until the
// implementation lands — it is additive and behaviour-neutral by construction.
//
// ── Why instance identity is a separate concern from naming.ts ──────────────
//
// `scripts/stack/naming.ts` already answers "which ENVIRONMENT started this
// container" — a CI job identity hashed from the Actions quadruple, or a
// per-boot random seed locally — and that answer is deliberately FRESH on every
// local boot, because its job is collision-freedom for container names.
//
// An instance is the opposite: it must be STABLE across boots, because
// `smoke:status`, `smoke:down`, `volume` reuse (§5) and journal resume (§1.3)
// all select by it. A second `bun smoke` on the same host is supposed to find
// yesterday's volume and yesterday's journal; a second CI job is supposed to
// find neither. Those two requirements cannot live in one function, which is
// why §1.1 specifies a precedence ORDER rather than a single source.
//
// ── The failure this prevents ───────────────────────────────────────────────
//
// Today the compose project comes from `SMOKE_PROJECT` or a fresh random hash,
// and state (pgdata volumes, the admission record) is found by label or by a
// path that does not distinguish one boot from another. The concrete breakages
// that follow, both recorded as W1 acceptance gates:
//
//  1. A CI job on a host that also runs a standing stage picks up the stage's
//     persisted state and tears down or migrates the operator's stage database.
//     §1.1 closes this by deriving the CI name from the RUN'S IDENTITY VARS and
//     "never from persisted state" — a CI job cannot inherit a standing stage's
//     instance even though the persisted name is sitting right there on disk.
//  2. Two concurrent CI jobs share an instance and therefore share a journal,
//     a lock file and a volume. §1.1 closes this the same way, because the
//     Actions quadruple differs per job.
//
// ── Precedence, verbatim from spec §1.1 ─────────────────────────────────────
//
//   "Production is `rm_prod`. On stage, precedence is: `--instance <name>`;
//    then CI job identity (`naming.ts` `class: \"ci\"`, hashed from the run's
//    identity vars, never from persisted state); then the name persisted by a
//    previous local run; then a fresh local name, persisted."
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §1.1  instance resolution and per-instance state scoping.
//   §1.2  the deployment lock is held ON THE INSTANCE.
//   §1.3  journal resume selects by instance.
//   §1.4  the receipt is written "beside the journal".
//   §5    the four generated role passwords are "saved in the instance's state
//         directory beside the volume"; `volume` mode reuses them.
//   §6.4  the spoofed-key generation goes to "an instance-scoped file in the
//         state directory, never the `RM_CREDENTIALS` path (equal paths
//         refuse)".
//
// Acceptance gates served (spec §10, W1): "Concurrent CI jobs plus a standing
// stage select distinct instances with prior state present", "`volume` reuse
// after restart", "Second `bun smoke` against a locked instance refuses",
// "Receipt read by `smoke:status`".

import type { StackEnvironment } from "../stack/naming.ts";

/**
 * The fixed production instance name (spec §1.1). A constant rather than a
 * default parameter because production must not be reachable by "whatever the
 * resolver happened to return": the §9.2 boot names it, the §9.1 initialization
 * commands name it, and `smoke:down` on production names it.
 */
export const PRODUCTION_INSTANCE = "rm_prod";

/**
 * Which rule in §1.1's precedence produced the name. Carried into the plan
 * (§1.2) and into the refusal text of a locked instance, because "why did this
 * run pick THIS instance" is the first question when a CI job and a stage
 * collide, and a bare name cannot answer it.
 */
export type InstanceSource =
  /** `--instance <name>` on the command line. Highest precedence. */
  | "flag"
  /** `RM_ENV=prod`: the fixed {@link PRODUCTION_INSTANCE}. */
  | "production"
  /** Hashed from the CI run's identity vars. Never from persisted state. */
  | "ci-identity"
  /** The name a previous local run persisted in the state root. */
  | "persisted"
  /** A newly minted local name, persisted as a side effect of resolution. */
  | "fresh";

export interface ResolvedInstance {
  /** The instance name. Must be a legal compose project name: `[a-z0-9][a-z0-9_-]*`. */
  readonly name: string;
  readonly source: InstanceSource;
  /** Absolute path to this instance's state directory. */
  readonly stateDir: string;
  /**
   * True when resolution itself wrote something (the `fresh` case persists the
   * new name). Surfaced so the plan can say so: §1.2 requires the plan to list
   * "every mutation it intends", and minting a persistent name on disk is one.
   */
  readonly persistedDuringResolution: boolean;
}

/**
 * Everything instance resolution may look at. Passed in rather than read from
 * the ambient process for the same reason `scripts/stack/` does it: a resolver
 * that reads `process.env` itself cannot be tested for the exact case the gates
 * care about — a CI environment AND a persisted local name present at the same
 * time on the same host.
 */
export interface InstanceResolutionInput {
  /** `--instance <name>`, or `undefined` when not passed. */
  readonly flag: string | undefined;
  /** Resolved `RM_ENV` policy; `prod` forces {@link PRODUCTION_INSTANCE}. */
  readonly rmEnv: "prod" | "stage";
  /** From `resolveStackEnvironment()`; its `class` distinguishes CI from local. */
  readonly environment: StackEnvironment;
  /** Root under which per-instance state directories live; see {@link stateRoot}. */
  readonly stateRoot: string;
}

/**
 * Resolve the instance for this run, applying §1.1's precedence exactly.
 *
 * Order, and why each step is where it is:
 *  1. `--instance <name>` — an explicit operator statement outranks every
 *     inference. It is also the only way to act on an instance whose persisted
 *     name was lost.
 *  2. `RM_ENV=prod` → {@link PRODUCTION_INSTANCE}. Production is not resolved,
 *     it is named.
 *  3. CI job identity, when `environment.class === "ci"`. Spec §1.1's
 *     parenthesis is a prohibition, not a description: "hashed from the run's
 *     identity vars, NEVER from persisted state". An implementation that falls
 *     back to the persisted name when the Actions vars look empty reintroduces
 *     exactly the bug this rule exists to kill — do not add that fallback.
 *  4. The name persisted by a previous local run, read from {@link stateRoot}.
 *  5. A fresh local name, persisted before it is returned.
 *
 * Inputs: {@link InstanceResolutionInput}. Output: {@link ResolvedInstance}.
 *
 * Refusal cases:
 *  - `--instance` with a name that is not a legal compose project name, or that
 *    is `rm_prod` while `RM_ENV` is not `prod` (naming the production instance
 *    from a stage policy is never a legitimate request, and the resulting run
 *    would contend for production's lock and journal).
 *  - `RM_ENV=prod` together with an `--instance` that is not `rm_prod`.
 *  - a state root that exists but is not a directory, or is not writable — a
 *    run that cannot persist its instance name cannot honour rule 4 on the next
 *    boot, and silently degrading to `fresh` every time would give the operator
 *    a new volume per boot with no explanation.
 *  - CI class with an environment hash that is empty: the identity vars were
 *    absent, and guessing is the one thing rule 3 forbids.
 *
 * Serves spec §10 W1: "Concurrent CI jobs plus a standing stage select distinct
 * instances with prior state present."
 */
export function resolveInstance(input: InstanceResolutionInput): ResolvedInstance {
  void input;
  throw new Error("NOT IMPLEMENTED: deployment instance precedence — spec §1.1, issue #1026 W1.4");
}

/**
 * The root directory under which every instance's state directory lives.
 *
 * Inputs: the process environment (for an explicit override and for `HOME`).
 * Output: an absolute path.
 *
 * It is a function, not a constant, because the answer differs between an
 * operator's host and a CI runner, and because the W1 gates need to point two
 * simulated hosts at two roots inside one test process. It must NOT default to
 * anything inside the repository working tree: state that lives in the checkout
 * is state that `git clean` deletes and that a worktree switch loses, and the
 * thing being lost here is the record of what was done to a database.
 *
 * Refusal cases: an override that is a relative path (an instance root resolved
 * against an unknown cwd is a different directory per invocation); an
 * unresolvable `HOME` with no override.
 */
export function stateRoot(env: Record<string, string | undefined>): string {
  void env;
  throw new Error("NOT IMPLEMENTED: instance state root — spec §1.1, issue #1026 W1.4");
}

/**
 * The per-instance layout. One interface so every W1 module agrees on where its
 * file lives, and so the set of files an instance owns can be read in one place
 * — which is what `smoke:down`, `smoke:clean` and the incident case need.
 *
 * Every path is absolute and inside the instance's own directory. Nothing here
 * ever points at the `RM_CREDENTIALS` path: §6.4 requires the spoofed-key
 * generation to be written "never [to] the `RM_CREDENTIALS` path (equal paths
 * refuse)", and the cheapest way to honour that is for this module to be
 * structurally incapable of naming it.
 */
export interface InstancePaths {
  /** The instance directory itself. */
  readonly dir: string;
  /** The persisted instance name, read by precedence rule 4. */
  readonly nameFile: string;
  /**
   * The four generated role passwords for a smoke-owned Postgres (§5). Written
   * by `blank` and `dump`, read by `volume`. "No terminal prompt exists in local
   * modes" — so if this file is lost, a `volume` reattach cannot authenticate
   * and must refuse rather than prompt.
   */
  readonly rolePasswordsFile: string;
  /** The phase journal (§1.3). */
  readonly journalFile: string;
  /** The readiness receipt (§1.4), written "beside the journal". */
  readonly receiptFile: string;
  /** The deployment lock (§1.2): a second `bun smoke` here refuses. */
  readonly lockFile: string;
  /** The persisted spoofed-key generation (§6.4), instance-scoped by construction. */
  readonly spoofGenerationFile: string;
}

/**
 * Compute (and create, when `create` is set) the instance's state directory and
 * the paths inside it.
 *
 * Inputs: the state root and the instance name. Output: {@link InstancePaths}.
 *
 * Refusal cases:
 *  - an instance name that is not a legal compose project name, or that
 *    contains a path separator or `..` — the name becomes a directory name, and
 *    a name that can escape the root can overwrite another instance's journal.
 *  - the directory exists but is not a directory.
 *  - creation is requested and fails.
 *
 * Directory permissions must be owner-only: this directory holds the four
 * generated role passwords in the clear (§5 says smoke "generates the four role
 * passwords and saves them"), so a world-readable state root hands every local
 * account the database.
 */
export function instancePaths(root: string, instance: string, options?: { readonly create?: boolean }): InstancePaths {
  void root;
  void instance;
  void options;
  throw new Error("NOT IMPLEMENTED: per-instance state directory layout — spec §1.1, issue #1026 W1.4");
}

/**
 * The four roles of spec §3, as the shape persisted by `blank`/`dump` and
 * reused by `volume`.
 *
 * `rm_owner` is present here ONLY in the local-Postgres case, where smoke
 * generated it and `--migrate` uses it without prompting (§8.5). It must never
 * be written for a remote connection: §3 requires `~/.env` to hold the runtime
 * tokens only, and a state file that caches a typed `rm_owner` password would
 * recreate the stored-owner-credential problem preflight check 4 exists to
 * detect.
 */
export interface GeneratedRolePasswords {
  readonly rm_owner: string;
  readonly rm_app: string;
  readonly rm_worker: string;
  readonly rm_readonly: string;
}

/**
 * Generate and persist the four role passwords for a smoke-owned Postgres.
 *
 * Called by `--local blank` and `--local dump` (§5). Output: the generated set,
 * already written to {@link InstancePaths.rolePasswordsFile}.
 *
 * Refusal cases:
 *  - the file already exists: regenerating would orphan the credentials the
 *    existing volume's roles actually have, and the resulting authentication
 *    failure would look like corruption. `volume` mode reads; it does not
 *    regenerate.
 *  - the target is not a smoke-owned local Postgres — there is no path on which
 *    this repository generates a password for a database it does not own.
 *  - the file cannot be written with owner-only permissions.
 *
 * Serves spec §10 W1: "`volume` reuse after restart."
 */
export function generateRolePasswords(paths: InstancePaths): GeneratedRolePasswords {
  void paths;
  throw new Error("NOT IMPLEMENTED: generate + persist the four role passwords — spec §5, issue #1026 W1.4");
}

/**
 * Read back the persisted role passwords for a `--local volume` reattach (§5:
 * "reattaches a Docker volume from a previous run of this instance with its
 * saved credentials").
 *
 * Refusal cases:
 *  - the file is missing. This is the one that matters: §5 states "No terminal
 *    prompt exists in local modes", so there is no recovery by asking. The
 *    refusal must say that the volume can still be used by starting a fresh
 *    instance with `--local dump`, and must NOT offer to reset the roles —
 *    resetting them needs a credential that, by construction, is in the file
 *    that is missing.
 *  - the file is malformed or is missing one of the four roles.
 *  - the file is readable by anyone but its owner.
 */
export function readRolePasswords(paths: InstancePaths): GeneratedRolePasswords {
  void paths;
  throw new Error("NOT IMPLEMENTED: read persisted role passwords for volume reuse — spec §5, issue #1026 W1.4");
}

/**
 * The deployment lock of spec §1.2: "a deployment lock on the instance (a
 * second `bun smoke` against a locked instance refuses)".
 *
 * Distinct from the target lock of §2, and both are held for the whole run. The
 * deployment lock is about THIS HOST's instance — two `bun smoke` processes
 * writing one journal — and is a file. The target lock is about THE DATABASE —
 * two tools mutating one database from anywhere — and is a Postgres advisory
 * lock (see `backend/src/db/target-lock.ts`). Neither substitutes for the
 * other: two different instances can legitimately target one remote database,
 * and one instance can legitimately be reconfigured between databases.
 */
export interface DeploymentLock {
  readonly instance: string;
  /** PID of the holder, for the refusal message. */
  readonly holderPid: number;
  /** When it was taken, UTC ISO-8601. */
  readonly acquiredAt: string;
  /** Release. Must be idempotent and safe to call from a signal handler. */
  release(): void;
}

/**
 * Take the deployment lock, or refuse naming the holder.
 *
 * Refusal cases:
 *  - the lock is held by a LIVE process: refuse, naming its PID and how long it
 *    has held the lock, and point at `smoke:status`.
 *  - the lock file exists but its holder is gone (the classic stale lock after
 *    a kill -9): this is recoverable and must be, since §1.4 requires a rerun to
 *    resume an interrupted journal — but the takeover must be REPORTED, not
 *    silent. A silently stolen lock is indistinguishable from no lock at all,
 *    and the journal's expectation checks (§1.3) are what then have to catch a
 *    live overlap they were not designed to catch.
 *  - the lock file cannot be created.
 *
 * Serves spec §10 W1: "Second `bun smoke` against a locked instance refuses."
 */
export function acquireDeploymentLock(paths: InstancePaths): DeploymentLock {
  void paths;
  throw new Error("NOT IMPLEMENTED: instance deployment lock — spec §1.2, issue #1026 W1.6");
}

/**
 * List the instances that have state on this host, newest first.
 *
 * Output: one entry per instance directory, with whatever is cheaply knowable
 * without opening a database — the name, whether a lock is held, whether a
 * journal or receipt is present.
 *
 * Exists for `smoke:status` and `smoke:tui` with no `--instance` argument, and
 * for the operator question "what did this host do": after §1.1, a leftover
 * container can be attributed to an instance, and this is how the instance is
 * then attributed to a journal and a receipt.
 *
 * Refusal cases: an unreadable state root refuses rather than returning an
 * empty list — "there are no instances" and "I could not look" must not read
 * the same on a status screen.
 */
export function listInstances(root: string): readonly {
  readonly name: string;
  readonly paths: InstancePaths;
  readonly locked: boolean;
  readonly hasJournal: boolean;
  readonly hasReceipt: boolean;
}[] {
  void root;
  throw new Error("NOT IMPLEMENTED: enumerate instances on this host — spec §1.1, issue #1026 W1.4");
}
