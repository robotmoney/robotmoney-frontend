// The migrate RUN — the four-step sequence spec §8.3 defines, plus the gates
// spec §8.5 puts in front of it.
//
// STUB. Every function throws `NOT IMPLEMENTED`; nothing imports this module
// yet, and it has no `import.meta.url` entry point on purpose. Step 1 of issue
// #1026's W2 workstream.
//
// IT DOES NOT REPLACE ANYTHING YET. `backend/scripts/migrate.ts` is untouched
// and keeps being what `bun run migrate` invokes. This module documents the
// TARGET run and absorbs migrate.ts in step 3 of #1026's W2, at which point
// migrate.ts's argv/`$HOME/.env`/prompt handling moves here and the old file
// goes. Until then the two describe the same command at two different versions,
// and the shipped one is the old one.
//
// Governed by smoke-production-spec.md §8.3 (the run), §8.5 (`--migrate` and
// production upgrades), §2 (the fence), §3 (the credential), §4.3 (the policy
// matrix).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEQUENCE, AND WHY EACH STEP IS WHERE IT IS
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §8.3, quoted: "A migrate run is: fence (§2) → apply pending migrations,
// one transaction each → roles-and-grants reconciliation (always, even with
// nothing pending) → publish the manifest for the final state in the
// reconciliation's transaction."
//
//   FENCE FIRST. §2: "Every mutation (migration, grant reconciliation, seed,
//   key rebind, schedule write) runs in a transaction that first takes
//   `pg_advisory_xact_lock` on the same key, on the connection performing it. A
//   competitor that wins the session lock after the coordinator's connection
//   died still blocks on the xact lock until the in-flight mutation commits or
//   aborts." The session lock alone is not enough, because a dead connection
//   releases it while the statement it was coordinating is still executing on
//   the server. §2's invariant: "A cancellation request is not evidence the
//   mutation stopped."
//
//   ONE TRANSACTION EACH. Not one transaction for all of them. A single
//   transaction would make a failure at migration seven roll back one through
//   six, so an operator who fixed seven would re-run six migrations that had
//   already worked — and several of this repo's migrations are expensive
//   sweeps (0053 re-owns every relation and function in `public`). Per-migration
//   commits are also what make the in-progress state of §8.3 resumable at all.
//
//   RECONCILIATION ALWAYS. "even with nothing pending" is the clause that
//   catches production today. Production's ledger drifted because
//   `scripts/ops/provision-db-role-taxonomy.sh` applied 0053 and 0062 through
//   psql without recording them (backend/scripts/migrate.ts's own header says
//   so), and a grant fixed by hand and then lost is invisible to a run that
//   skips reconciliation when the migration list is empty. Reconciliation is
//   idempotent by construction (§8.1's grants part), so running it every time
//   costs one transaction.
//
//   MANIFEST IN THAT SAME TRANSACTION. So "manifest published" means "grants
//   reconciled". A manifest that could commit separately would let a boot pass
//   check 3a on a database whose grants are still the previous version's — and
//   check 2 would then fail on grants check 3a had just called correct.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHO RUNS IT, AND WHY IT ASKS
// ─────────────────────────────────────────────────────────────────────────────
//
// `rm_owner`, typed at the terminal. Spec §3: "**`rm_owner` is `LOGIN`.** Its
// password is typed at the terminal for the one run that needs it and never
// stored." There is no `rm_migrator` (§3, and D46/D47 record its removal), and
// the current `SET LOCAL ROLE rm_owner` bootstrap in
// `backend/src/db/migrate.ts:57` goes with it.
//
// `rm_owner` is NOLOGIN in this checkout, twice over: migration 0053 line 10
// creates it (`CREATE ROLE rm_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
// NOCREATEROLE NOREPLICATION NOBYPASSRLS`) and line 49 re-asserts it
// (`ALTER ROLE rm_owner NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE`) on every
// apply. W2.1 changes both lines for FRESH databases. Existing ones are not
// reached by that edit — the runner skips files it has already recorded — so
// spec §9.1 step 1 makes them a one-time `doadmin` step:
// "`ALTER ROLE rm_owner LOGIN PASSWORD …`, then a verification login."
//
// Until that step has run on a given database, this tool cannot connect at all,
// and the refusal has to say which of the two situations it is in. "Password
// authentication failed" against a NOLOGIN role is the least useful sentence
// available.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHEN IT REFUSES OUTRIGHT
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §8.5: "In production an upgrade is an operator intervention:
// `bun run migrate`, prompting for `rm_owner`, planned per release, receipted.
// It is never part of the boot." and "`--migrate` is a convenience for stage,
// test, and CI, where the database and the boot happen in one step. It refuses
// on `RM_ENV=prod` or `deployment_identity ≠ rehearsal`."
//
// Two callers, two rule sets, one run. `bun run migrate` is the operator
// intervention and may touch production. `--migrate` is the smoke convenience
// and may not — §4.3: "**Rehearsal-only preparation:** `--migrate`, `--seed`,
// `--spoof-keys` require `rehearsal` in addition to their own guards."
import type postgresTypes from "postgres";
import type { SchemaManifest } from "../src/db/schema-manifest.ts";

export type MigrateDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/** Which of the two callers of §8.5 is running. They differ only in what they
 *  refuse, never in what the run does. */
export type MigrateCaller =
  /** `bun run migrate` — the operator intervention. May run against
   *  `deployment_identity = production` under `RM_ENV=prod`. */
  | "operator"
  /** `bun smoke --migrate` — the stage/test/CI convenience. Refuses `prod` and
   *  refuses anything but `rehearsal`. */
  | "smoke_flag";

export interface MigrateRunOptions {
  readonly caller: MigrateCaller;
  /** Resolved policy; `null` when `RM_ENV` is unset (§4.3 gives unset its own
   *  row). */
  readonly env: "prod" | "stage" | null;
  /** Remote connection or a Postgres container smoke owns (§5). Drives the
   *  warning and the `y/n`, and drives where the owner password comes from. */
  readonly connection: "remote" | "local";
  /** The advisory-lock key of §2, derived from the DATABASE identity and "not
   *  the compose project" — two instances pointed at one database must collide,
   *  and one database reached under two project names must not look like two. */
  readonly lockKey: bigint;
  /** True when the caller already holds the session lock and this run only
   *  needs the per-transaction fence — smoke holds it "from acquisition through
   *  preflight, replacement, and readiness" (§2). */
  readonly sessionLockHeld: boolean;
  /** Skip every prompt and refuse rather than ask. CI passes this; an
   *  unattended run that would have blocked on a terminal must fail fast. */
  readonly nonInteractive: boolean;
}

/** What the run committed, for the receipt (§1.4) and the journal (§1.3). */
export interface MigrateRunResult {
  /** Migrations applied by THIS run, in apply order. Empty is an ordinary
   *  outcome; reconciliation still ran. */
  readonly applied: readonly string[];
  /** Migrations that were already committed but unmanifested when this run
   *  started, and were re-validated rather than re-applied (§8.3's resume). */
  readonly resumedAndVerified: readonly string[];
  /** Always true — reconciliation runs "always, even with nothing pending". */
  readonly grantsReconciled: true;
  /** The manifest published in the reconciliation transaction. */
  readonly manifest: SchemaManifest;
}

/**
 * Run the full sequence of §8.3 against an already-connected owner session.
 *
 * Inputs: a handle connected as `rm_owner`, and the options above. Output: a
 * `MigrateRunResult`.
 *
 * Steps, in order and not reorderable:
 *   1. Fence — `pg_advisory_xact_lock(lockKey)` as the first statement of every
 *      mutating transaction below (§2). When `sessionLockHeld` is false this
 *      also takes the session-level `pg_advisory_lock` and releases it
 *      explicitly on exit.
 *   2. Revalidate — re-read `deployment_identity`, the ledger and the manifest
 *      after acquiring, and re-run the plan against them. §2: "A mismatch
 *      refuses."
 *   3. Resume — `resumePlan()` (../src/db/schema-manifest.ts) classifies an
 *      in-progress database, verifies committed-but-unmanifested work against
 *      each migration's expected post-state, and names the first unapplied
 *      step. Nothing is replayed and no drift is accepted (§8.3).
 *   4. Apply — each pending migration in its own transaction, with
 *      `recordMigrationCompat()` writing `compat`/`metadata_version` inside
 *      that same transaction (../src/db/schema-compat.ts).
 *   5. Reconcile and publish — the snapshot's grants part, then
 *      `writeManifest()`, in one transaction.
 *
 * Refusals:
 *   - The effective role is not `rm_owner`. Spec §8.3: "Only `rm_owner` may
 *     write it or the ledger's `compat`/`metadata_version` columns; they are
 *     trusted inputs to boot decisions."
 *   - The fence cannot be taken within the timeout. §2: "A tool that finds the
 *     lock held waits with a timeout, then refuses naming the holder."
 *   - Revalidation finds `deployment_identity`, the ledger or the manifest
 *     changed since the plan was made.
 *   - `resumePlan` refused (inconsistent manifest, unknown format version, a
 *     ledger row naming a file this checkout does not have, or committed work
 *     that fails its post-state check).
 *   - A migration has no parseable compat header (§8.2).
 *   - The connection is lost at a phase boundary: journal the phase and exit
 *     non-zero. §2: "No phase proceeds on a lock the tool cannot prove it still
 *     holds."
 *
 * Serves spec §10 W2 "Migrate fails between commits and during grant
 * reconciliation; rerun reaches a verified final state" and, with W1.7, "Kill
 * the lock connection mid-migration, start a second mutation tool: no overlap."
 */
export function runMigrate(db: MigrateDb, options: MigrateRunOptions): Promise<MigrateRunResult> {
  void db;
  void options;
  throw new Error("NOT IMPLEMENTED: run the fenced migrate sequence — spec §8.3, issue #1026 W2.6");
}

/**
 * Obtain the `rm_owner` password for this one run.
 *
 * Input: the options. Output: the password.
 *
 * Two sources, by connection mode, per §8.5: "In local modes it uses the owner
 * password smoke generated. On a remote connection it prompts for `rm_owner`."
 * §5 makes the local half concrete — smoke "generates the four role passwords
 * and saves them in the instance's state directory beside the volume" and "No
 * terminal prompt exists in local modes."
 *
 * The prompt is masked and the value is never written anywhere, never logged,
 * and never placed in an environment variable that outlives the process. §3:
 * "typed at the terminal for the one run that needs it and never stored." A
 * stored owner password makes every §9.1 gate a formality.
 *
 * Refusals:
 *   - `nonInteractive` and a prompt would be needed. Failing fast beats a CI
 *     job hanging on an invisible prompt, which is the shape
 *     backend/scripts/migrate.ts already refuses today (`stdin is not a
 *     terminal`).
 *   - An empty password.
 *   - The resulting login fails AND `pg_roles` says `rm_owner` is `NOLOGIN` —
 *     reported as "this database has not had spec §9.1 step 1 applied", naming
 *     the `doadmin` `ALTER ROLE rm_owner LOGIN PASSWORD …` step, because 0053
 *     line 10 creates the role NOLOGIN and line 49 re-asserts it, and the
 *     runner will never re-apply 0053 to a database that has recorded it.
 *
 * Serves spec §10 W2 (plan row W2.1's "migrate as `rm_owner` on a fresh and on
 * a migrated database").
 */
export function promptOwnerPassword(options: MigrateRunOptions): Promise<string> {
  void options;
  throw new Error("NOT IMPLEMENTED: obtain the rm_owner password for one run — spec §3/§8.5, issue #1026 W2.1");
}

/**
 * Warn about a remote target and require an explicit `y`.
 *
 * Inputs: the options and the redacted target (host:port/dbname, password
 * stripped — the only form safe to print, as `redactedTarget` in
 * backend/scripts/db-preflight.ts already establishes). Output: nothing on
 * confirmation.
 *
 * Spec §8.5: "On a remote connection it prompts for `rm_owner`, warns, and asks
 * `y/n`." The warning exists because a remote target is the one case where the
 * operator's mental model and the connection string can disagree without
 * anything looking wrong, and `deployment_identity` is an "accidental-target
 * safeguard, not proof the data is disposable" (§4.2).
 *
 * Refusals:
 *   - Anything but an explicit `y`. Empty input is `n`; there is no default
 *     answer, because a default `y` is not a confirmation.
 *   - `nonInteractive` on a remote connection — an unattended run may not
 *     confirm on the operator's behalf.
 * Local connections skip it entirely (§5: "No terminal prompt exists in local
 * modes").
 *
 * Serves spec §10 W2 "`RM_ENV=stage` + typed owner password against
 * `deployment_identity = production` refuses" — the confirmation is the last
 * thing in front of that refusal, not a substitute for it.
 */
export function confirmRemoteTarget(options: MigrateRunOptions, redactedTarget: string): Promise<void> {
  void options;
  void redactedTarget;
  throw new Error("NOT IMPLEMENTED: warn and confirm a remote migrate target — spec §8.5, issue #1026 W2.1");
}

/** A refusal, as a reason and an operator-readable sentence. Data rather than a
 *  thrown error so a test can assert the exact wording, the way
 *  backend/scripts/db-preflight.ts's `reportLines` is asserted. */
export interface MigrateRefusal {
  readonly reason:
    | "prod_env"
    | "identity_not_rehearsal"
    | "identity_missing"
    | "env_unset_remote"
    | "env_invalid";
  readonly message: string;
}

/**
 * Apply §8.5's and §4.3's gates before anything connects as `rm_owner`.
 *
 * Inputs: a handle (to read the one-row `deployment_identity`) and the options.
 * Output: every refusal found, empty when the run may proceed.
 *
 * For `caller: "smoke_flag"`, spec §8.5: `--migrate` "refuses on `RM_ENV=prod`
 * or `deployment_identity ≠ rehearsal`", and §4.3 adds that rehearsal-only
 * preparation requires `rehearsal` "in addition to their own guards". A missing
 * identity row is a refusal, not a pass — absence of evidence is not evidence
 * of rehearsal.
 *
 * For `caller: "operator"`, production is allowed and `prod` is expected; the
 * refusals that remain are §4.3's own rows (unset `RM_ENV` against a remote;
 * any other `RM_ENV` value; `prod` combined with a `--local` mode).
 *
 * Runs BEFORE the owner password is requested, so a refused run never causes a
 * password to be typed — typing it into the wrong terminal is a disclosure
 * nothing later can undo.
 *
 * Serves spec §10 W2 "`RM_ENV=stage` + typed owner password against
 * `deployment_identity = production` refuses."
 */
export function checkMigrateGates(db: MigrateDb, options: MigrateRunOptions): Promise<readonly MigrateRefusal[]> {
  void db;
  void options;
  throw new Error("NOT IMPLEMENTED: apply the prod / rehearsal migrate gates — spec §8.5/§4.3, issue #1026 W2.1");
}
