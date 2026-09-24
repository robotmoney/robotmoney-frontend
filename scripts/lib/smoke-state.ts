// Deployment instance identity and the per-instance state directory.
//
// "Every run acts on one named deployment instance" (spec §1.1). This module
// decides WHICH instance a run is acting on, and owns the on-disk layout that
// everything else in W1 persists into: the instance name itself, the role
// passwords smoke generated for a local Postgres, the service tokens, the
// journal and its archive, the receipt, the deployment lock, and the
// spoofed-key generation.
//
// STATUS. Implemented, unit-tested (scripts/tests/unit/smoke-state.test.ts)
// and wired: `bun smoke` resolves its instance here and keeps every state file
// it writes under {@link instancePaths}; `smoke:status`, `smoke:down`,
// `smoke:reap` and `smoke:tui` select by the same name.
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
//   §3    each service token is "a file the boot places in the instance's
//         state directory, named per instance and per holder".
//
// Acceptance gates served (spec §10, W1): "Concurrent CI jobs plus a standing
// stage select distinct instances with prior state present", "`volume` reuse
// after restart", "Second `bun smoke` against a locked instance refuses",
// "Receipt read by `smoke:status`".

import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { resolveStackEnvironment, stackProjectName, type StackEnvironment } from "../stack/naming.ts";
import { WEB_DIR_NAME } from "./smoke-site.ts";

/** A legal compose project name, which is also the instance's directory name. */
const INSTANCE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** The pointer file, at the state root, that carries precedence rule 4's name. */
const LOCAL_POINTER = "local-instance";

/** The override that lets one process point at more than one simulated host. */
const STATE_ROOT_ENV = "RM_SMOKE_STATE_ROOT";

function assertInstanceName(name: string): void {
  if (!INSTANCE_NAME.test(name)) {
    throw new Error(`Refusing: \`${name}\` is not a legal instance name (${INSTANCE_NAME.source}).`);
  }
}

function assertUsableStateRoot(root: string): void {
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new Error(`Refusing: state root ${root} exists but is not a directory.`);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    accessSync(root, fsConstants.W_OK);
  } catch {
    throw new Error(`Refusing: state root ${root} is not writable, so the instance name cannot be persisted.`);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
  if (input.flag !== undefined) {
    assertInstanceName(input.flag);
    if (input.rmEnv === "prod" && input.flag !== PRODUCTION_INSTANCE) {
      throw new Error(`Refusing: RM_ENV=prod acts on ${PRODUCTION_INSTANCE}, not \`${input.flag}\`.`);
    }
    if (input.rmEnv !== "prod" && input.flag === PRODUCTION_INSTANCE) {
      throw new Error(
        `Refusing: naming ${PRODUCTION_INSTANCE} under a stage policy would contend for production's lock and journal.`,
      );
    }
  }
  assertUsableStateRoot(input.stateRoot);

  const settle = (name: string, source: InstanceSource, persistedDuringResolution: boolean): ResolvedInstance => ({
    name,
    source,
    stateDir: instancePaths(input.stateRoot, name, { create: true }).dir,
    persistedDuringResolution,
  });

  if (input.flag !== undefined) return settle(input.flag, "flag", false);
  if (input.rmEnv === "prod") return settle(PRODUCTION_INSTANCE, "production", false);

  if (input.environment.class === "ci") {
    const hash = input.environment.hash.trim().toLowerCase();
    if (hash === "") {
      throw new Error("Refusing: CI class with an empty identity hash — the run's identity vars were absent.");
    }
    return settle(`rm_ci_${hash}`, "ci-identity", false);
  }

  const pointer = join(input.stateRoot, LOCAL_POINTER);
  if (existsSync(pointer)) {
    const persisted = readFileSync(pointer, "utf8").trim();
    assertInstanceName(persisted);
    return settle(persisted, "persisted", false);
  }

  const minted = `rm_local_${randomBytes(5).toString("hex")}`;
  const paths = instancePaths(input.stateRoot, minted, { create: true });
  writeFileSync(paths.nameFile, `${minted}\n`, { mode: 0o600 });
  writeFileSync(pointer, `${minted}\n`, { mode: 0o600 });
  return { name: minted, source: "fresh", stateDir: paths.dir, persistedDuringResolution: true };
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
  const override = env[STATE_ROOT_ENV];
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(`Refusing: ${STATE_ROOT_ENV}=${override} is relative; an absolute path is required.`);
    }
    return override;
  }
  const home = env.HOME;
  if (home === undefined || home === "") {
    throw new Error(`Refusing: HOME is unset and no ${STATE_ROOT_ENV} override was given.`);
  }
  if (!isAbsolute(home)) {
    throw new Error(`Refusing: HOME=${home} is relative; an absolute path is required.`);
  }
  return join(home, ".local", "state", "robotmoney-smoke");
}

/**
 * The three holders of a service token (spec §3): `system-scheduler`,
 * `analytics-producer`, and the operator (the admin routes).
 */
export const SERVICE_TOKEN_HOLDERS = ["system-scheduler", "analytics-producer", "operator"] as const;
export type ServiceTokenHolder = (typeof SERVICE_TOKEN_HOLDERS)[number];

/** The one file name inside each holder's token directory. */
export const TOKEN_FILE_NAME = "token";

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
  /**
   * The service-token root (§3). It holds one directory per holder and nothing
   * else, and it is NEVER mounted into a container itself: it contains every
   * holder's token.
   */
  readonly tokensDir: string;
  /**
   * Each holder's OWN token directory, `tokens/<holder>/`, holding that
   * holder's token file and nothing else. This is the path compose mounts into
   * the holder (read-only), so the mount exposes exactly one credential.
   *
   * Why a directory per holder and not one shared `tokens/` directory: §3 and
   * §5 say `system-scheduler` and `analytics-producer` "each receive only their
   * API credential". A mount of a shared directory would hand the scheduler the
   * operator's admin-route token and the producer's token too. A directory per
   * holder (rather than a single-file bind mount) keeps rotation an atomic
   * rename inside the mounted directory, which a single-file bind mount does
   * not see.
   *
   * docker-compose.yml mounts `${RM_INSTANCE_STATE_DIR}/tokens/system-scheduler`
   * at `/run/rm-token` and points `SCHEDULER_TOKEN_FILE` at
   * `/run/rm-token/${TOKEN_FILE_NAME}`: the scheduler sees its own token and
   * never the instance directory, which holds role-passwords.json (criterion
   * 113, asserted over the rendered compose config).
   */
  readonly tokenDirs: Readonly<Record<ServiceTokenHolder, string>>;
  /** Each holder's token file: `tokens/<holder>/token`, the only file in {@link tokenDirs}[holder]. */
  readonly tokenFiles: Readonly<Record<ServiceTokenHolder, string>>;
  /** The phase journal (§1.3). */
  readonly journalFile: string;
  /**
   * Where a superseded journal goes (§1.3, rule 2: "closes the old journal,
   * reports what it reached"). One file per closed journal, never overwritten.
   */
  readonly journalArchiveDir: string;
  /** The readiness receipt (§1.4), written "beside the journal". */
  readonly receiptFile: string;
  /** The deployment lock (§1.2): a second `bun smoke` here refuses. */
  readonly lockFile: string;
  /** The persisted spoofed-key generation (§6.4), instance-scoped by construction. */
  readonly spoofGenerationFile: string;
  /**
   * What `bun smoke` recorded about the compose stack it brought up for this
   * instance: the compose project, the compose files, the data path and the
   * ports Docker assigned. `smoke:status`, `smoke:down`, `smoke:reap` and a
   * `--local volume` reattach read it. It used to be `.agents/smoke-state.json`
   * in the checkout, one file for every boot from that checkout, so a second
   * instance overwrote the first one's pointer (§1.1).
   */
  readonly stackStateFile: string;
  /** The boot's append-only narration log, for post-mortem. */
  readonly logFile: string;
  /**
   * Generated compose overlays (the data-path and reattach overlays). They
   * encode one invocation's choice, so they live with the instance, never in
   * the checkout.
   */
  readonly overlaysDir: string;
  /**
   * The website versions this instance serves (W7): one immutable directory per
   * site id, `web/<siteId>/`, and a relative `current` symlink naming the one
   * website-server serves. Mounted read-only at `/srv/web`
   * (scripts/lib/smoke-site.ts).
   */
  readonly webDir: string;
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
  assertInstanceName(instance);
  const dir = join(root, instance);
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    throw new Error(`Refusing: ${dir} exists but is not a directory.`);
  }
  const tokensDir = join(dir, "tokens");
  const journalArchiveDir = join(dir, "journals");
  if (options?.create === true) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const tokenDirs = Object.fromEntries(
    SERVICE_TOKEN_HOLDERS.map((holder) => [holder, join(tokensDir, holder)]),
  ) as Record<ServiceTokenHolder, string>;
  const tokenFiles = Object.fromEntries(
    SERVICE_TOKEN_HOLDERS.map((holder) => [holder, join(tokenDirs[holder], TOKEN_FILE_NAME)]),
  ) as Record<ServiceTokenHolder, string>;
  const overlaysDir = join(dir, "overlays");
  const webDir = join(dir, WEB_DIR_NAME);
  if (options?.create === true) {
    for (const inner of [tokensDir, ...Object.values(tokenDirs), journalArchiveDir, overlaysDir]) {
      mkdirSync(inner, { recursive: true, mode: 0o700 });
      chmodSync(inner, 0o700);
    }
    // World-traversable, not world-writable: website-server's nginx workers run
    // as an unprivileged user and must read the site through the read-only
    // mount. It holds only the public website, never a credential.
    mkdirSync(webDir, { recursive: true, mode: 0o755 });
  }
  return {
    dir,
    nameFile: join(dir, "instance-name"),
    rolePasswordsFile: join(dir, "role-passwords.json"),
    tokensDir,
    tokenDirs,
    tokenFiles,
    journalFile: join(dir, "journal.jsonl"),
    journalArchiveDir,
    receiptFile: join(dir, "receipt.json"),
    lockFile: join(dir, "deployment.lock"),
    spoofGenerationFile: join(dir, "spoof-generation"),
    stackStateFile: join(dir, "stack-state.json"),
    logFile: join(dir, "smoke.log"),
    overlaysDir,
    webDir,
  };
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
  if (existsSync(paths.rolePasswordsFile)) {
    throw new Error(
      `Refusing: ${paths.rolePasswordsFile} already exists; regenerating would orphan the credentials the volume's roles hold.`,
    );
  }
  const secret = (): string => randomBytes(24).toString("base64url");
  const generated: GeneratedRolePasswords = {
    rm_owner: secret(),
    rm_app: secret(),
    rm_worker: secret(),
    rm_readonly: secret(),
  };
  writeFileSync(paths.rolePasswordsFile, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600 });
  chmodSync(paths.rolePasswordsFile, 0o600);
  return generated;
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
  if (!existsSync(paths.rolePasswordsFile)) {
    throw new Error(
      `Refusing: no saved role passwords at ${paths.rolePasswordsFile}. Use the volume from a fresh instance with \`--local dump\`.`,
    );
  }
  if ((statSync(paths.rolePasswordsFile).mode & 0o077) !== 0) {
    throw new Error(`Refusing: ${paths.rolePasswordsFile} is readable beyond its owner; its mode must be 0600.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.rolePasswordsFile, "utf8"));
  } catch {
    throw new Error(`Refusing: ${paths.rolePasswordsFile} is malformed and cannot be parsed.`);
  }
  const roles = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const;
  const record = parsed as Record<string, unknown>;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Refusing: ${paths.rolePasswordsFile} is malformed.`);
  }
  for (const role of roles) {
    if (typeof record[role] !== "string" || record[role] === "") {
      throw new Error(`Refusing: ${paths.rolePasswordsFile} is missing the ${role} password.`);
    }
  }
  return {
    rm_owner: record.rm_owner as string,
    rm_app: record.rm_app as string,
    rm_worker: record.rm_worker as string,
    rm_readonly: record.rm_readonly as string,
  };
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
  /** The plan id (§1.2) the holder is executing, for the refusal message. */
  readonly planId: string;
  /** When it was taken, UTC ISO-8601. */
  readonly acquiredAt: string;
  /** Release. Must be idempotent and safe to call from a signal handler. */
  release(): void;
}

/**
 * Take the deployment lock for the run executing `planId`, or refuse naming
 * the holder.
 *
 * The plan id is recorded because "which run holds this" is only half the
 * operator's question; the other half is "running WHAT". Two runs of one
 * instance under two plans are exactly the case the journal's supersede rule
 * (§1.3) exists for, and the refusal is where the operator first learns of it.
 *
 * Refusal cases:
 *  - the lock is held by a LIVE process: refuse, naming its PID, its plan id
 *    and how long it has held the lock, and point at `smoke:status`.
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
export function acquireDeploymentLock(paths: InstancePaths, planId: string): DeploymentLock {
  const instance = basename(paths.dir);
  const acquiredAt = new Date().toISOString();
  if (planId.trim() === "") {
    throw new Error(`Refusing: a deployment lock on ${instance} needs the plan id of the run taking it.`);
  }

  if (existsSync(paths.lockFile)) {
    let holderPid = 0;
    let heldSince = "";
    let heldPlan = "";
    try {
      const held = JSON.parse(readFileSync(paths.lockFile, "utf8")) as {
        holderPid?: number;
        acquiredAt?: string;
        planId?: string;
      };
      holderPid = typeof held.holderPid === "number" ? held.holderPid : 0;
      heldSince = typeof held.acquiredAt === "string" ? held.acquiredAt : "";
      heldPlan = typeof held.planId === "string" ? held.planId : "";
    } catch {
      /* an unreadable lock is treated as stale below */
    }
    const plan = heldPlan === "" ? "an unrecorded plan" : `plan ${heldPlan}`;
    if (holderPid > 0 && processIsAlive(holderPid)) {
      const heldFor = heldSince === "" ? "unknown" : `${Math.round((Date.now() - Date.parse(heldSince)) / 1000)}s`;
      throw new Error(
        `Refusing: instance ${instance} is locked by pid ${holderPid} running ${plan}, held for ${heldFor}. ` +
          "Run `bun smoke:status` to see what it is doing.",
      );
    }
    console.warn(
      `Taking over the stale deployment lock on ${instance}: its holder (pid ${holderPid}, ${plan}) is gone since ${heldSince || "unknown"}.`,
    );
    rmSync(paths.lockFile, { force: true });
  }

  writeFileSync(paths.lockFile, `${JSON.stringify({ instance, holderPid: process.pid, planId, acquiredAt })}\n`, {
    mode: 0o600,
    flag: "wx",
  });

  let released = false;
  return {
    instance,
    holderPid: process.pid,
    planId,
    acquiredAt,
    release(): void {
      if (released) return;
      released = true;
      try {
        rmSync(paths.lockFile, { force: true });
      } catch {
        /* release must be safe from a signal handler */
      }
    },
  };
}

/**
 * Who holds an instance's deployment lock, read without taking it: for
 * `smoke:status` (report the run in progress) and `smoke:down` (refuse to stop
 * a stack a live run is still deploying). `null` when no lock file exists.
 *
 * `alive` is whether the recorded pid is a running process right now. A lock
 * whose holder is gone is stale: the next `bun smoke` takes it over, and it
 * must not block an operator's stop.
 */
export function deploymentLockHolder(paths: InstancePaths): {
  readonly pid: number | null;
  readonly planId: string | null;
  readonly alive: boolean;
} | null {
  if (!existsSync(paths.lockFile)) return null;
  try {
    const held = JSON.parse(readFileSync(paths.lockFile, "utf8")) as { holderPid?: unknown; planId?: unknown };
    const pid = typeof held.holderPid === "number" && held.holderPid > 0 ? held.holderPid : null;
    return { pid, planId: typeof held.planId === "string" ? held.planId : null, alive: pid !== null && processIsAlive(pid) };
  } catch {
    return { pid: null, planId: null, alive: false };
  }
}

/**
 * The compose project a `bun smoke` of `instance` uses in this environment:
 * the same derivation the boot makes (scripts/lib/smoke-main.ts, a stack
 * environment seeded by the instance name). For `smoke:status` and
 * `smoke:down` when the instance has no stack record, so "no record" is never
 * read as "no stack": the containers of a boot killed before it recorded
 * anything are still attributable to their instance.
 */
export function instanceStackProject(instance: string, env: Record<string, string | undefined>): string {
  return stackProjectName("stack", resolveStackEnvironment(env, { seed: instance }));
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
  let entries: string[];
  try {
    if (!statSync(root).isDirectory()) {
      throw new Error(`Refusing: state root ${root} is not a directory.`);
    }
    entries = readdirSync(root);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing:")) throw error;
    throw new Error(`Refusing: state root ${root} could not be read.`);
  }

  return entries
    .filter((name) => INSTANCE_NAME.test(name) && statSync(join(root, name)).isDirectory())
    .map((name) => {
      const paths = instancePaths(root, name);
      return {
        name,
        paths,
        locked: existsSync(paths.lockFile),
        hasJournal: existsSync(paths.journalFile),
        hasReceipt: existsSync(paths.receiptFile),
        mtime: statSync(paths.dir).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ mtime: _mtime, ...entry }) => entry);
}

/**
 * What `bun smoke` records about the compose stack it brought up for an
 * instance ({@link InstancePaths.stackStateFile}). One shape for the writer
 * (smoke-main.ts) and every reader (`smoke:status`, `smoke:down`, `smoke:reap`,
 * `verify-live`, the twin rehearsals), so none of them can drift into its own
 * copy of the field list.
 *
 * Ports are HISTORY: what Docker assigned to the boot that wrote the file.
 * Readers that need the live value ask `docker compose port`.
 */
export interface StackStateRecord {
  readonly instance: string;
  readonly project: string;
  readonly apiPort: number;
  /** The static/SPA origin (issue #892): website-server, not api. */
  readonly webPort: number;
  readonly pgPort: number | null;
  /** Whether this boot applied docker-compose.stage.yml (`--static-port`). */
  readonly stage: boolean;
  readonly envClass: string;
  readonly envHash: string;
  /** Base compose files, `:`-joined, without the generated overlays. */
  readonly composeFiles: string;
  /** `ephemeral`, `external` or `smoke-twin`. */
  readonly db: string;
  readonly externalPg: boolean;
  readonly smokeTwinContainer?: string;
  readonly smokeTwinVolume?: string;
  readonly smokeTwinBackupStamp?: string;
  /** REDACTED for every non-ephemeral boot; the throwaway local credentials otherwise. */
  readonly databaseUrl: string;
  readonly dbUser: string;
  readonly dbPassword: string;
  readonly dbName: string;
  /** Path only, never the value. */
  readonly analyticsTokenFile?: string;
  readonly logFile: string;
  /** The named volume the data lives in, for a compose-owned Postgres. */
  readonly pgVolume?: string;
  readonly createdAt: string;
}

/**
 * Read an instance's stack record, or `null` when this instance has never
 * brought a stack up. A malformed record refuses rather than reading as
 * absent: "no stack" sends `smoke:down` home with nothing done while the
 * containers it could not identify keep running.
 */
export function readStackState(paths: InstancePaths): StackStateRecord | null {
  if (!existsSync(paths.stackStateFile)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.stackStateFile, "utf8"));
  } catch {
    throw new Error(`Refusing: ${paths.stackStateFile} is malformed and cannot be parsed.`);
  }
  const record = parsed as Partial<StackStateRecord> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    typeof record.project !== "string" ||
    typeof record.composeFiles !== "string"
  ) {
    throw new Error(`Refusing: ${paths.stackStateFile} carries no compose project, so it cannot say which stack is this instance's.`);
  }
  return record as StackStateRecord;
}

/** Write an instance's stack record, owner-only: it names the throwaway local database credentials. */
export function writeStackState(paths: InstancePaths, record: StackStateRecord): void {
  writeFileSync(paths.stackStateFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The instance a lifecycle command (`smoke:status`, `smoke:down`, `smoke:reap
 * --instance`) acts on: the named one, or the only one with state here.
 *
 * Deliberately never mints or persists a name, unlike {@link resolveInstance}:
 * a command that stops or reports on a deployment must not create one. Refuses
 * an unknown name (listing the known ones), an empty host, and an omitted name
 * when several instances have state — guessing is how an operator stops the
 * wrong stack.
 */
export function selectExistingInstance(root: string, requested: string | undefined): InstancePaths {
  if (requested !== undefined) assertInstanceName(requested);
  const available = existsSync(root) ? listInstances(root) : [];
  const names = available.map((entry) => entry.name);
  if (requested !== undefined) {
    const found = available.find((entry) => entry.name === requested);
    if (found === undefined) {
      throw new Error(
        `Refusing: instance \`${requested}\` has no state under ${root}.${names.length > 0 ? ` Known: ${names.join(", ")}.` : ""}`,
      );
    }
    return found.paths;
  }
  if (available.length === 0) {
    throw new Error(`Refusing: no instance has state under ${root}, so nothing has been deployed from this host.`);
  }
  if (available.length > 1) {
    throw new Error(`Refusing: several instances have state here; name one with \`--instance\`. Known: ${names.join(", ")}.`);
  }
  return available[0]!.paths;
}

/**
 * A state directory for a compose stack that is NOT a deployment instance: an
 * eval or a rails test brings up the same compose model, and the compose file
 * requires `RM_INSTANCE_STATE_DIR` (no checkout fallback), so it needs one too.
 *
 * Under a private temporary root rather than {@link stateRoot}: it is thrown
 * away with its stack, and it must not appear among the host's deployment
 * instances (`smoke:tui` and `smoke:status` refuse to guess between several).
 * `dispose()` removes it.
 */
export function throwawayInstance(name: string): {
  readonly name: string;
  readonly stateDir: string;
  readonly paths: InstancePaths;
  dispose(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "rm-stack-state-"));
  const paths = instancePaths(root, name, { create: true });
  return {
    name,
    stateDir: paths.dir,
    paths,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The value of `--instance <name>` or `--instance=<name>` in `argv`, or `undefined`. */
export function instanceFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--instance=")) return token.slice("--instance=".length);
    if (token === "--instance") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("Refusing: `--instance` needs a name.");
      return value;
    }
  }
  return undefined;
}
