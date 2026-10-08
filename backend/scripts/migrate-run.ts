// The migrate RUN — the four-step sequence spec §8.3 defines, the gates spec
// §8.5 puts in front of it, and the one command sequence both of its callers
// execute.
//
// It has no `import.meta.url` entry point on purpose. Two entry points drive
// `migrateCommand` below, and they differ only in where the target lock and the
// owner password come from:
//
//   `bun run migrate` (backend/scripts/migrate.ts) — the operator's command. It
//     reads the target from `~/.env`, acquires the §2 target lock ITSELF over a
//     direct connection (TARGET_LOCK_KEY, the constant every tool shares),
//     reads `rm_owner` from `~/.env`, holds the run to `--confirm-target`
//     (D61), runs, writes the receipt and releases the lock on exit.
//   `bun smoke --migrate` (backend/scripts/smoke-prepare.ts, a child of
//     scripts/lib/smoke-main.ts) — the stage/test/CI convenience. The smoke
//     process already holds the target lock for its whole run (§2: "from
//     acquisition through preflight, replacement, and readiness"), so the child
//     OBSERVES that lock (target-lock.ts observeTargetLock) and proves at every
//     boundary that its parent still holds it. In a local mode the owner
//     password is the one smoke generated for the instance (§8.5); on a remote
//     rehearsal it is `~/.env`'s `rm_owner` line, exactly as `bun run migrate`
//     reads it, with the same `--confirm-target` (D61).
//
// Neither ever connects as `doadmin`. Neither prompts: no step reads a
// terminal (D61 rule 1).
//
// Governed by smoke-production-spec.md §8.3 (the run), §8.5 (`--migrate` and
// production upgrades), §9.1 step 2 (the production baseline), §2 (the lock and
// the fence), §3 (the credential), §4.3 (the policy matrix, whose one
// implementation is backend/src/deploy-policy.ts).
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
//   LOCK, THEN FENCE. §2 has two layers and this run uses both. The SESSION
//   lock (`pg_advisory_lock` in the `(int4, int4)` form, objsubid 2) is the
//   caller's: `bun run migrate` and `bun smoke` both take it through
//   `acquireTargetLock`, which is why they contend. Every mutating transaction
//   below then takes the FENCE (`pg_advisory_xact_lock` in the `int8` form,
//   objsubid 1) as its first statement, on the connection performing it: "A
//   competitor that wins the session lock after the coordinator's connection
//   died still blocks on the xact lock until the in-flight mutation commits or
//   aborts." This run once took its own session lock in the `int8` form — the
//   FENCE's object — which never contended with smoke's session lock and
//   blocked every other tool's fence for the whole run instead.
//
//   PROOF AT EVERY BOUNDARY. §2: "Connection loss. Detected at every phase
//   boundary; the tool journals the phase and exits non-zero. No phase proceeds
//   on a lock the tool cannot prove it still holds." `assertStillHeld` asks the
//   server before the run starts, before each migration and before
//   reconciliation.
//
//   ONE TRANSACTION EACH. Not one transaction for all of them. A single
//   transaction would make a failure at migration seven roll back one through
//   six, so an operator who fixed seven would re-run six migrations that had
//   already worked. Per-migration commits are also what make the in-progress
//   state of §8.3 resumable at all.
//
//   RECONCILIATION ALWAYS. "even with nothing pending" is the clause that
//   catches production today: a grant fixed by hand and then lost is invisible
//   to a run that skips reconciliation when the migration list is empty.
//
//   MANIFEST IN THAT SAME TRANSACTION. So "manifest published" means "grants
//   reconciled".
//
//   BASELINE BEFORE THE FIRST MANIFEST. §9.1 step 2: "compare production's live
//   schema with the snapshot for its installed filename list. Any difference is
//   repaired by a migration first; the first `bun run migrate` publishes a
//   manifest only when the live schema matches." A manifest is a trusted input
//   to every later boot's check 3a, so the first one is never a claim nobody
//   compared: see `assertBaselineGap` and `assertBaselineMatches`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHO RUNS IT
// ─────────────────────────────────────────────────────────────────────────────
//
// `rm_owner`, and nothing that merely may become it. Spec §3 makes `rm_owner`
// `LOGIN`; D61 puts its password in the host's `~/.env`, read by the run and
// never written anywhere else. `assertOwnerIsSession` requires `current_user = rm_owner`:
// a superuser session or a mere member of the role is refused, because the
// manifest and the ledger's compat columns are "trusted inputs to boot
// decisions" (§8.3) and only the schema owner writes them. Migration 0053
// creates `rm_owner` LOGIN on a fresh cluster; an EXISTING database recorded
// 0053 when it said NOLOGIN, so there spec §9.1 step 1 is a one-time `doadmin`
// step (`bun scripts/prod-init.ts enable-owner-login`, D61), and the refusal
// says which of the two situations it is in.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE RUN WITHOUT AN IDENTITY ROW
// ─────────────────────────────────────────────────────────────────────────────
//
// The first of §4.3's three named exceptions, D55 (5): production runs v0.5.0 plus four more
// files (its observed 76-name ledger, ../src/db/supported-releases.ts), which predates
// the `deployment_identity` table (0081), so the first `bun run migrate` there
// meets no row and no table. It may run anyway exactly when RM_ENV=prod, the
// ledger's filename list equals one SUPPORTED_RELEASES baseline's list exactly,
// `~/.env` holds the `rm_owner` line, and `--confirm-target` names the target
// exactly (D61). `readPreIdentityState` decides the first two; the owner line
// and the flag are the remote path of `migrateCommand`, and the state the flag
// confirmed is handed to `runMigrate`, which re-reads it on the owner
// connection and refuses unless it is the same one. The receipt records it.
//
// THE REMOTE REHEARSAL PASS (D61 rule 2). Stage rehearses that run unmodified:
// a production dump restored into a REMOTE stage Postgres has the same state,
// and the same `bun run migrate --confirm-target …` under RM_ENV=stage takes
// the same pass, writing `rehearsal` instead of `production`
// (`identityFirstKind`). It never writes `production`; any other pre-identity
// ledger refuses; a second run, with the row present, takes the normal path.
//
// IDENTITY FIRST (D55 (9), §9.1). The pass applies `0081_deployment_identity`
// BEFORE any other pending file, out of filename order, and 0081's DDL, its
// ledger row and the `production` row commit in ONE fenced transaction
// (`applyIdentityFirst`, which re-reads the pre-identity state under the fence
// and refuses unless it is the confirmed one). Only then do the remaining
// pending files take the normal path, in filename order, one transaction
// each. So no committed state ever holds 0081 without the row: a run killed
// before that transaction commits leaves the baseline ledger and no table,
// and the rerun takes the pass again; a run killed after it leaves the row,
// and the rerun is an ordinary run. Either way the exception is never
// available again once 0081 has committed.
//
// THE NORMAL PATH ACCEPTS THE STATE A PASS LEAVES. Production's baseline lacks
// five files that sort below 0081 (0056_swarm_judge_requires_model.sql to
// 0062_rm_worker_analytics_ledger_read_grant.sql). A first-manifest run
// otherwise refuses a pending file below a recorded one as an out-of-band gap
// (`assertBaselineGap`). It accepts them in exactly one state
// (`readIdentityPassRemainder`): an identity row exists, 0081 is recorded, and
// the ledger rows applied before 0081 equal one supported baseline, with every
// other row applied after it. Every other out-of-order state still refuses,
// and out-of-order 0081 itself happens only in the passes (this one and the
// `--local dump` preparation, backend/scripts/smoke-prepare.ts), never in the
// apply loop.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE JOURNAL
// ─────────────────────────────────────────────────────────────────────────────
//
// §2: "Connection loss. Detected at every phase boundary; the tool journals the
// phase and exits non-zero." The spec names smoke's journal (§1.3) and no place
// for a standalone migrate's, so `bun run migrate` keeps its own beside its
// receipt (./migrate-journal.ts), one file per run, written before each phase
// and closed on EVERY exit — success, refusal, lock loss, a crash, a signal —
// so a losing migrate leaves the phase it lost in. `migrateCommand` journals
// its own phases and hands `runMigrate` the hook for the run's.
// `bun smoke --migrate` passes none: the smoke parent journals its `migrate`
// preparation itself.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type postgresTypes from "postgres";
import { requireConfirmTarget, requirePrivilegedPassword, type RemoteAuthority } from "../../scripts/lib/privileged-env.ts";
import {
  enrollAsProduction,
  enrollAsRehearsal,
  transactionIdentityStore,
  type DeploymentIdentityRow,
} from "../../scripts/lib/smoke-identity.ts";
import { requireRehearsalTarget, resolveDeploymentPolicy, resolveRmEnv } from "../src/deploy-policy.ts";
import { checkAppendOnlyGuard } from "../src/db/append-only-guard.ts";
import {
  COMPAT_COLUMNS,
  parsePendingHeader,
  recordMigrationCompat,
  requiresCompatHeader,
  type MigrationHeader,
} from "../src/db/schema-compat.ts";
import {
  MANIFEST_FORMAT_VERSION,
  compareCatalog,
  detectManifestState,
  hashManifest,
  resumePlan,
  writeManifest,
  type SchemaManifest,
} from "../src/db/schema-manifest.ts";
import { loadSnapshot, type Snapshot } from "../src/db/schema-snapshot.ts";
import { on, registerQuery } from "../src/db/registry.ts";
import { describeUnmatchedLedger, matchSupportedRelease } from "../src/db/supported-releases.ts";
import type { MigrateJournal } from "./migrate-journal.ts";
import {
  acquireTargetLock,
  assertStillHeld,
  describeHolderText,
  readTargetState,
  releaseTargetLockOnExit,
  withFenceOn,
  type HeldTargetLock,
  type LockHolder,
} from "../src/db/target-lock.ts";

const CALLERS = ["scripts/migrate-run"];

// The runner's fixed-shape statements on its own ledger, all as rm_owner, the migration login (spec §3, D47).
// What stays raw is named in tests/db-registry.test.ts: the migration files' own DDL, the grants file, and
// catalog reads of a database whose schema may be any historical shape.
const qRecordMigration = registerQuery({
  role: "rm_owner",
  object: "schema_migrations",
  privileges: ["INSERT"],
  site: "scripts/migrate-run:recordMigration",
  purpose: "Record one applied migration filename, in the same fenced transaction as its DDL.",
  callers: CALLERS,
  probe: {
    statement: `INSERT INTO schema_migrations (name) VALUES ($1)`,
    params: ["0000_probe.sql"],
  },
});

const qReadLedger = registerQuery({
  role: "rm_owner",
  object: "schema_migrations",
  privileges: ["SELECT"],
  site: "scripts/migrate-run:readLedger",
  purpose: "Read the ledger of applied migration filenames in filename order, to plan, reconcile and publish.",
  callers: CALLERS,
  probe: {
    statement: `SELECT name FROM schema_migrations ORDER BY name`,
  },
});

const qReadLedgerSides = registerQuery({
  role: "rm_owner",
  object: "schema_migrations",
  privileges: ["SELECT"],
  site: "scripts/migrate-run:readLedgerSides",
  purpose: "Read each ledger row's filename and whether it was applied before or after the identity migration.",
  callers: CALLERS,
  probe: {
    statement: `SELECT m.name,
            CASE WHEN m.applied_at < p.applied_at THEN 'before'
                 WHEN m.applied_at > p.applied_at THEN 'after'
                 ELSE 'same' END AS side
       FROM schema_migrations m, (SELECT applied_at FROM schema_migrations WHERE name = $1) p
      WHERE m.name <> $1
      ORDER BY m.name`,
    params: ["0081_deployment_identity.sql"],
  },
});

/** A pool: every mutating transaction is `pool.begin` under the fence. */
export type MigrateDb = postgresTypes.Sql<{}>;
/** Anything that reads — the gates accept a transaction too. */
type ReadDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** The migration that creates `deployment_identity` (§4.2). The only file any
 *  path applies out of filename order, and only in the identity-first passes
 *  of §4.3 (D55 (9)). */
export const IDENTITY_MIGRATION = "0081_deployment_identity.sql";

/** Which of the two callers of §8.5 is running. They differ only in what they
 *  refuse, never in what the run does. */
export type MigrateCaller =
  /** `bun run migrate` — the operator intervention. May run against
   *  `deployment_identity = production` under `RM_ENV=prod`. */
  | "operator"
  /** `bun smoke --migrate` — the stage/test/CI convenience. Refuses `prod` and
   *  refuses anything but `rehearsal`. */
  | "smoke_flag";

/** What the gates judge: who is asking, under which policy, over which connection. */
export interface MigrateGateOptions {
  readonly caller: MigrateCaller;
  /** Resolved policy; `null` when `RM_ENV` is unset (§4.3 gives unset its own
   *  row). */
  readonly env: "prod" | "stage" | null;
  /** Remote connection or a Postgres container smoke owns (§5). Drives the
   *  warning and `--confirm-target`, and where the owner password comes from. */
  readonly connection: "remote" | "local";
}

export interface MigrateRunOptions extends MigrateGateOptions {
  /**
   * The §2 session lock this run proceeds under: a {@link TargetLock} the
   * caller acquired, or an {@link observeTargetLock} view of the lock the
   * caller's parent process holds. Required, never defaulted: a run with no
   * lock is two migration runs waiting to happen.
   */
  readonly lock: HeldTargetLock;
  /**
   * The pre-identity state (§9.1, D55 (5)) the run confirmed with `~/.env`'s
   * `rm_owner` and a matching `--confirm-target` (D61), or absent. The run re-reads the state on the
   * owner connection: a database that qualifies for the exception runs only
   * when this is the very state it reads, and a database that no longer
   * qualifies refuses when this is set.
   */
  readonly confirmedPreIdentity?: PreIdentityState;
  /** Called as each phase begins, before the lock is proven for it: the
   *  journal's before-write. */
  readonly onPhase?: (phase: string) => void;
}

/**
 * What the first production migrate recorded about the database before it
 * existed as an enrolled target (§9.1: "Its receipt records the pre-identity
 * state: that no identity row existed, the supported release the ledger
 * matched, and that ledger's filename list").
 */
export interface PreIdentityState {
  /** Which absence. Only one qualifies: production's baseline predates 0081,
   *  so it has no `deployment_identity` table at all. A table with no row was
   *  created out of band or emptied, and refuses at the gates (D55 (5), (9);
   *  issue #1026 criterion 170). */
  readonly identity: "no table";
  /** The name of the SUPPORTED_RELEASES baseline whose filename list the ledger equals. */
  readonly release: string;
  /** The ledger's filename list, in filename order. */
  readonly ledger: readonly string[];
}

/**
 * Seams a test uses to drive the REAL run into a state it cannot otherwise
 * reach. No operator path sets them; `bun run migrate` passes none.
 */
export interface MigrateRunSeams {
  /** Where the migration files are read from. Defaults to backend/migrations/.
   *  A test points it at a directory holding the real files plus a planted
   *  one, so a refusal or an interruption happens inside the real apply loop
   *  rather than in a hand-built database state. */
  readonly migrationsDir?: string;
  /** Where the snapshot (schema/snapshot.sql, grants.sql, snapshot.json) is
   *  read from. Defaults to backend/schema/. Passed WITH `migrationsDir`: the
   *  snapshot's filename list is cross-checked against the migrations it is
   *  handed, so a fixture pair lets a test publish the manifest of a
   *  synthesized migration M through the real runner (#1026 criterion 54). */
  readonly snapshotDir?: string;
  /** Called after each migration's transaction has COMMITTED and before the
   *  next one begins. A throw here is a real interruption between two commits:
   *  the run stops exactly where a killed process would, with the ledger ahead
   *  of the manifest (§8.3's *in progress*). */
  readonly afterCommit?: (file: string) => void | Promise<void>;
}

/** What the run committed, for the receipt (§1.4) and the journal (§1.3). */
export interface MigrateRunResult {
  /** Migrations applied by THIS run, in apply order. Empty is an ordinary
   *  outcome; reconciliation still ran. */
  readonly applied: readonly string[];
  /** Migrations that were already committed but unmanifested when this run
   *  started, and were re-validated rather than re-applied (§8.3's resume). */
  readonly resumedAndVerified: readonly string[];
  /** Relations whose privileges reconciliation CHANGED, by name, in order.
   *  Empty means the grants already matched the snapshot. */
  readonly grantsRepaired: readonly string[];
  /** The manifest published in the reconciliation transaction. */
  readonly manifest: SchemaManifest;
  /** True when this run published the database's FIRST manifest, after the
   *  §9.1 step 2 baseline compared the live schema with the snapshot. */
  readonly baselined: boolean;
  /** The state this run started from when it was the first production migrate
   *  (§9.1, D55 (5)); `null` for every other run. */
  readonly preIdentity: PreIdentityState | null;
  /** The `production` row the identity-first pass committed in 0081's
   *  transaction (D55 (9)); `null` for every other run. */
  readonly identityWritten: DeploymentIdentityRow | null;
  /** When this run resumed after an identity-first pass (the normal path
   *  accepting the state a pass leaves, §9.1): the baseline the rows applied
   *  before 0081 equal. `null` otherwise. */
  readonly resumedAfterIdentityPass: string | null;
}

/**
 * Run the full sequence of §8.3 against an owner pool, under a held lock.
 *
 * Inputs: a pool logged in as `rm_owner` (every transaction runs on it under
 * the fence), the options above, and the test seams. Output: a
 * `MigrateRunResult`.
 *
 * Steps, in order and not reorderable:
 *   1. Prove the lock (§2) and the credential (`current_user = rm_owner`).
 *   2. Re-run the gates on the owner connection: the row can have changed
 *      since the caller's gate call. A mismatch refuses.
 *   3. Resume — `resumePlan()` (../src/db/schema-manifest.ts) classifies an
 *      in-progress database, verifies committed-but-unmanifested work against
 *      each migration's expected post-state, and names the first unapplied
 *      step. Nothing is replayed and no drift is accepted (§8.3).
 *   4. Baseline gap — on a database with no manifest, the ledger must be a
 *      prefix of the snapshot's filename list (§9.1 step 2), except in the two
 *      states an identity-first pass starts from and leaves (D55 (9)).
 *   5. Headers — every pending file's §8.2 header is parsed before the first
 *      commit, so a missing declaration refuses with nothing applied.
 *   6. Apply — on the first production migrate, `applyIdentityFirst` first:
 *      0081's DDL, its ledger row and `production` in one fenced transaction.
 *      Then each other pending migration in its own fenced transaction, in
 *      filename order, with `recordMigrationCompat()` writing
 *      `compat`/`metadata_version` inside it.
 *   7. Reconcile and publish — the snapshot's grants part, the baseline
 *      comparison when this is the first manifest, then `writeManifest()`, in
 *      one fenced transaction.
 *
 * Refusals: the lock cannot be proven held at a boundary; the session is not
 * `rm_owner`; a gate refuses; a database that qualifies for the first
 * production migrate (§9.1, D55 (5)) without `confirmedPreIdentity` naming the
 * state it reads, or a `confirmedPreIdentity` on a database that no longer
 * qualifies; the database is blank (no ledger — that is the
 * snapshot's bootstrap, §8.1, never a replay); `resumePlan` refused; a pending
 * migration above the pre-compat baseline (0081, D53) has no parseable compat
 * header; the first manifest's baseline found a gap or a difference (named,
 * nothing published); the identity-first pass found its state moved under its
 * fence (nothing applied).
 *
 * Serves spec §10 W2 "Identity first: the production pass applies 0081 and
 * commits its DDL, its ledger row and `production` in the same transaction,
 * before any other migration", "The normal path applies a pending file below a
 * recorded 0081 only when the identity row exists and the rest of the ledger
 * equals the baseline plus 0081, plus files applied after it; every other
 * out-of-order state refuses", "Migrate fails between commits and during grant
 * reconciliation; rerun reaches a verified final state", "Production baseline:
 * a live schema that differs from the snapshot blocks the first manifest
 * publication", and W1 "Kill the lock connection mid-migration, start a second
 * mutation tool: no overlap."
 */
export async function runMigrate(
  db: MigrateDb,
  options: MigrateRunOptions,
  seams: MigrateRunSeams = {},
): Promise<MigrateRunResult> {
  const migrationsDir = seams.migrationsDir ?? MIGRATIONS_DIR;

  // 1. THE LOCK AND THE CREDENTIAL, proven before anything is read for a
  //    decision.
  await boundary(options, "migrate: start");
  await assertOwnerIsSession(db);

  // 2. RE-RUN THE GATES on the owner connection. §2: "After acquiring, the tool
  //    re-reads `deployment_identity`, the ledger, and the schema manifest and
  //    re-runs the plan against them. A mismatch refuses." The caller's gates
  //    ran before the owner password existed; the row can have changed since.
  const refusals = await checkMigrateGates(db, options);
  if (refusals.length > 0) {
    throw new Error(`Refusing the migrate run: ${refusals.map((r) => r.message).join(" ")}`);
  }
  const preIdentity = await readPreIdentityState(db, options);
  assertPreIdentityConfirmed(preIdentity, options.confirmedPreIdentity);
  await assertNotBlank(db);

  // 3. RESUME. The append-only trigger inventory is checked first: it is the
  //    one post-state this repository declares machine-readably, and a
  //    database that lost a guard has not reached the post-state of the
  //    migration that installed it, whatever its ledger says.
  await assertCommittedPostState(db);
  const firstManifest = (await detectManifestState(db)).kind === "absent";
  const onDisk = await migrationFilenames(migrationsDir);
  const plan = await resumePlan(db, onDisk);
  // A fixture migrations directory is cross-checked against the snapshot only
  // when a fixture snapshot comes with it (the seam pair of criterion 54); a
  // planted file alone meets the repository's own snapshot, which embodies
  // backend/migrations/.
  const snapshot = await loadSnapshot(seams.snapshotDir, seams.snapshotDir ? migrationsDir : undefined);
  // The state an identity-first pass leaves (D55 (9)), read only when this run
  // is not the pass itself AND no manifest exists yet. The rows before 0081
  // equal the baseline forever, so once a manifest is published the state no
  // longer says anything about a resume, and the receipt must not claim one.
  const afterPass = preIdentity === null && firstManifest ? await readIdentityPassRemainder(db) : null;
  if (preIdentity !== null && !plan.pending.includes(IDENTITY_MIGRATION)) {
    throw new Error(
      `Refusing the migrate run: a remote identity-first pass applies ${IDENTITY_MIGRATION} first (spec §9.1, ` +
        "D55 (9), D61), and it is not pending on this database. Nothing was applied.",
    );
  }

  // 4. BASELINE GAP, before anything is applied: see assertBaselineGap. The
  //    FINAL filename list (ledger plus pending) is held to the snapshot's here
  //    too, so the one refusal left after the apply loop is the catalog's.
  if (firstManifest) {
    const accepted =
      preIdentity !== null
        ? { baseline: preIdentity.ledger, appliedAfter: [] }
        : afterPass !== null
          ? { baseline: afterPass.baseline, appliedAfter: afterPass.appliedAfter }
          : null;
    await assertBaselineGap(db, snapshot, plan.pending, accepted);
  }

  // 5. HEADERS, ALL OF THEM, BEFORE THE FIRST COMMIT. §8.2: every migration
  //    "declares itself `additive` or `breaking` in a header the runner
  //    parses". Files at or below the pre-compat baseline may carry none
  //    (`parsePendingHeader`, D53).
  const pending: { file: string; ddl: string; header: MigrationHeader | null }[] = [];
  for (const file of plan.pending) {
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    pending.push({ file, ddl, header: parsePendingHeader(file, ddl) });
  }

  // 6. APPLY. The first production migrate's identity-first pass comes first
  //    (D55 (9)): 0081, its ledger row and `production`, in ONE fenced
  //    transaction, before any other pending file. The pass re-reads the
  //    pre-identity state under its fence and refuses unless it is the one
  //    the operator confirmed.
  const applied: string[] = [];
  let identityWritten: DeploymentIdentityRow | null = null;
  if (preIdentity !== null) {
    await boundary(options, `migrate: identity-first ${IDENTITY_MIGRATION}`);
    // The kind is the policy's and nothing else's: `production` under prod,
    // `rehearsal` under stage (D61 rule 2). Each enrollment refuses the other
    // policy again inside the pass.
    const kind = identityFirstKind(options.env);
    const pass = await applyIdentityFirst(db, {
      kind,
      rmEnv: options.env,
      remote: options.connection === "remote",
      ...(kind === "rehearsal" ? { remoteRehearsalConfirmed: true } : {}),
      expected: preIdentity,
      note:
        kind === "production"
          ? `bun run migrate: the first production migrate from ${preIdentity.release} (spec §9.1, D55 (5), (9))`
          : `bun run migrate: the remote rehearsal pass from ${preIdentity.release} (D61 rule 2, D55 (9))`,
      migrationsDir,
    });
    identityWritten = pass.row;
    applied.push(IDENTITY_MIGRATION);
    if (seams.afterCommit) await seams.afterCommit(IDENTITY_MIGRATION);
  }

  //    Then every other pending file, one fenced transaction each, in filename
  //    order, each recording its own declaration so the row and the DDL
  //    commit together (§8.2).
  for (const { file, ddl, header } of pending) {
    if (preIdentity !== null && file === IDENTITY_MIGRATION) continue;
    await boundary(options, `migrate: apply ${file}`);
    await withFenceOn(db, `migrate ${file}`, async (tx) => {
      await tx.unsafe(ddl);
      await on(tx, qRecordMigration)`INSERT INTO schema_migrations (name) VALUES (${file})`;
      if (header !== null) await recordDeclaration(tx, header);
    });
    applied.push(file);
    if (seams.afterCommit) await seams.afterCommit(file);
  }

  // 7. RECONCILE AND PUBLISH, in ONE fenced transaction, so "manifest
  //    published" means "grants reconciled" (§8.3) — and, for a first
  //    manifest, "the live schema was compared with the snapshot" (§9.1).
  await boundary(options, "migrate: reconcile and publish");
  const { manifest, grantsRepaired } = await withFenceOn(db, "migrate reconcile", async (tx) => {
    const before = await relationAcls(tx);
    await tx.unsafe(snapshot.grantsSql);
    const after = await relationAcls(tx);
    const filenames = (
      (await on(tx, qReadLedger)<{ name: string }>`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]
    ).map((row) => row.name);
    if (firstManifest) await assertBaselineMatches(tx, snapshot, filenames);
    const published: SchemaManifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      declaration: snapshot.manifest.declaration,
      filenames,
      contentHash: hashManifest(snapshot.manifest.declaration, filenames),
    };
    await writeManifest(tx, published);
    return { manifest: published, grantsRepaired: changedAcls(before, after) };
  });

  return {
    applied,
    resumedAndVerified: plan.committedToVerify,
    grantsRepaired,
    manifest,
    baselined: firstManifest,
    preIdentity,
    identityWritten,
    resumedAfterIdentityPass: afterPass?.release ?? null,
  };
}

/** A phase boundary (§2): journal the phase as begun, then prove the lock for
 *  it. The before-write comes first so a phase the lock cannot be proven for is
 *  the phase the journal names. */
async function boundary(options: MigrateRunOptions, phase: string): Promise<void> {
  options.onPhase?.(phase);
  await assertStillHeld(options.lock, phase);
}

/**
 * A remote identity-first pass runs only on the state its run confirmed
 * (§9.1, D55 (5), D61). The caller's gates read the pre-identity state before
 * the owner logged in and `--confirm-target` was checked; this run reads it
 * again on the owner connection. Refused: a qualifying database with no
 * confirmation handed in (every caller but `migrateCommand`'s remote path), a
 * confirmation of a different state (the ledger moved meanwhile), and a
 * confirmation handed to a database that no longer qualifies.
 */
function assertPreIdentityConfirmed(observed: PreIdentityState | null, confirmed: PreIdentityState | undefined): void {
  if (observed === null && confirmed === undefined) return;
  if (observed !== null && confirmed !== undefined && samePreIdentity(observed, confirmed)) return;
  const seen = observed === null ? "does not qualify for it now" : `now reads ${describePreIdentity(observed)}`;
  const said = confirmed === undefined ? "no run confirmed it" : `the run confirmed ${describePreIdentity(confirmed)}`;
  throw new Error(
    "Refusing the migrate run: a remote identity-first pass (spec §9.1, D55 (5), D61) runs once, with no " +
      "deployment_identity row, only on the state its run confirmed with ~/.env's rm_owner and a matching " +
      `--confirm-target. This database ${seen}, and ${said}. Nothing was applied.`,
  );
}

function samePreIdentity(a: PreIdentityState, b: PreIdentityState): boolean {
  return a.identity === b.identity && a.release === b.release && a.ledger.join("\n") === b.ledger.join("\n");
}

function describePreIdentity(state: PreIdentityState): string {
  return `${state.identity} and a ledger equal to ${state.release}'s ${state.ledger.length} files`;
}

/**
 * §9.1 step 2, first half: the installed filename list must be one the snapshot
 * can speak for.
 *
 * The baseline compares the live schema "with the snapshot for its installed
 * filename list", and this checkout carries exactly one snapshot. So the only
 * ledger a first manifest can be baselined from is a PREFIX of the snapshot's
 * list in apply order: the pending files then bring it to the snapshot's list,
 * and the comparison runs there. Two gaps make that impossible and refuse with
 * nothing applied:
 *
 *   - the ledger records a file the snapshot does not embody — the database ran
 *     a migration this snapshot cannot describe;
 *   - the snapshot embodies a file the ledger does not record while a LATER
 *     file is recorded — for instance a file applied through psql
 *     (scripts/ops/provision-db-role-taxonomy.sh does that) without its
 *     ledger row: the runner would "apply" it again, as a pending file, onto
 *     a schema that already has it. That is repaired by the §9.1 operator
 *     steps first, never by this run;
 *   - the pending files would not bring the ledger to the snapshot's list: a
 *     pending file the snapshot does not embody, or an embodied file that is
 *     neither recorded nor pending. The list the comparison would run at is
 *     then not the snapshot's, so it refuses now rather than after applying.
 *
 * What cannot be checked before the apply is the CATALOG of the prefix: this
 * checkout has no snapshot for it. So a first manifest over pending files
 * compares after the apply loop, and a catalog difference found there leaves
 * the pending files committed with no manifest — the §8.3 "in progress" state
 * (ledger ahead of manifest), which check 3a refuses to boot and a rerun
 * re-compares once a migration repairs the difference (§9.1 step 2).
 * prod-baseline.test.ts pins that outcome.
 *
 * TWO STATES ARE NOT PREFIXES AND STILL NOT A GAP (`accepted`),
 * both an identity-first pass's (D55 (9)). Production's observed list (v0.5.0
 * plus 0061, 0062, 0063 and 0080) lacks five files that sort between files it
 * has (0056_swarm_judge_requires_model.sql and four more up to
 * 0062_rm_worker_analytics_ledger_read_grant.sql): the branch numbered them
 * after the tag was cut. Every other pending file is numbered above the last
 * name production records (0080_analytics_ledger_compaction.sql), so none of
 * them is a gap.
 *   - A ledger EQUAL to a baseline's list (`preIdentity`, D55 (5)) is that
 *     baseline, whole, so every embodied file it does not record is a file it
 *     never ran, and it is pending like any other.
 *   - The state a pass leaves (`readIdentityPassRemainder`): an identity row,
 *     0081 recorded, the rows applied before it equal to a baseline and every
 *     other row applied after it. The unrecorded lower files are the ones the
 *     baseline never ran, still pending.
 * The acceptance is per FILE, never for the whole ledger: an unrecorded file
 * that sorts below a recorded one is accepted only when it sorts below 0081,
 * the matched baseline does not record it, and it sorts above every row
 * applied after 0081. The runner applies pending files in filename order, so
 * a real resume never leaves a row applied after 0081 above a file it has not
 * yet applied. A gap among those later rows — 0058 recorded after 0081
 * without 0057, or 0084 without 0083 — is the psql case above and refuses.
 * Every other ledger with an embodied file missing below a recorded one
 * refuses.
 */
async function assertBaselineGap(
  db: ReadDb,
  snapshot: Snapshot,
  pending: readonly string[],
  accepted: { readonly baseline: readonly string[]; readonly appliedAfter: readonly string[] } | null,
): Promise<void> {
  const ledger = (
    (await on(db, qReadLedger)<{ name: string }>`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]
  ).map((row) => row.name);
  const embodied = new Set(snapshot.filenames);
  const recorded = new Set(ledger);
  const last = ledger.at(-1);
  const highestAfter = accepted?.appliedAfter.reduce<string | undefined>((max, name) => (max === undefined || name > max ? name : max), undefined);
  const baselineNeverRan = (name: string): boolean =>
    accepted !== null &&
    name < IDENTITY_MIGRATION &&
    !accepted.baseline.includes(name) &&
    (highestAfter === undefined || name > highestAfter);
  const outOfBand = (name: string): boolean => last !== undefined && name < last && !baselineNeverRan(name);
  const problems = [
    ...ledger
      .filter((name) => !embodied.has(name))
      .map((name) => `the ledger records ${name}, which the snapshot does not embody`),
    ...snapshot.filenames
      .filter((name) => !recorded.has(name) && outOfBand(name))
      .map((name) => `the snapshot embodies ${name}, which the ledger does not record although later files are recorded`),
    ...pending
      .filter((name) => !embodied.has(name))
      .map((name) => `the pending ${name} is not embodied by the snapshot`),
    ...snapshot.filenames
      .filter((name) => !recorded.has(name) && !pending.includes(name) && !outOfBand(name))
      .map((name) => `the snapshot embodies ${name}, which is neither recorded nor pending`),
  ];
  if (problems.length === 0) return;
  throw new Error(
    "Refusing the migrate run: this database has no schema manifest, and its first one is published only after " +
      "a baseline comparison with the snapshot for its installed filename list (spec §9.1 step 2). That list " +
      `cannot be baselined: ${problems.join("; ")}. Repair the ledger first. Nothing was applied or published.`,
  );
}

/**
 * §9.1 step 2, second half, inside the publish transaction: after the pending
 * migrations and the grants reconciliation, the live catalog must be exactly
 * the snapshot's (`compareCatalog`, check 3a's own comparison, honouring the
 * snapshot's provider exclusion list), for exactly the snapshot's filename
 * list. Any difference throws, which rolls the publish transaction back: no
 * manifest is written, and the refusal names every object that differs.
 */
async function assertBaselineMatches(tx: ReadDb, snapshot: Snapshot, filenames: readonly string[]): Promise<void> {
  const listed = new Set(snapshot.filenames);
  const listDiff = [
    ...filenames.filter((name) => !listed.has(name)).map((name) => `the ledger records ${name}, which the snapshot does not embody`),
    ...snapshot.filenames
      .filter((name) => !filenames.includes(name))
      .map((name) => `the snapshot embodies ${name}, which the ledger does not record`),
  ];
  const catalogDiff = listDiff.length > 0 ? [] : await compareCatalog(tx, snapshot);
  const problems = [...listDiff, ...catalogDiff];
  if (problems.length === 0) return;
  throw new Error(
    "Refusing to publish this database's first schema manifest: the live schema differs from the snapshot for its " +
      `installed filename list (spec §9.1 step 2) — ${problems.join("; ")}. Any difference is repaired by a ` +
      "migration first. No manifest was published.",
  );
}

/**
 * Record one migration's declaration, inside that migration's transaction.
 *
 * The ledger's `compat`/`metadata_version` columns arrive with migration 0082.
 * A file ABOVE the pre-compat baseline always runs after 0082, so a missing
 * column there is drift (someone dropped it) and refuses. A pre-compat file
 * that happens to declare itself (0053 does) may run on a database 0082 has
 * not reached yet; its row then stays NULL, which is what every other
 * pre-compat row holds and what §8.4 reads it as.
 */
async function recordDeclaration(tx: ReadDb, header: MigrationHeader): Promise<void> {
  const [row] = (await tx`
    SELECT COUNT(*)::int AS present FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
      AND column_name = ANY(${[...COMPAT_COLUMNS]})`) as unknown as { present: number }[];
  if ((row?.present ?? 0) === COMPAT_COLUMNS.length) {
    await recordMigrationCompat(tx, header);
    return;
  }
  if (requiresCompatHeader(header.filename)) {
    throw new Error(
      `Refusing the migrate run: ${header.filename} must record its compat declaration, and schema_migrations ` +
        "has no compat/metadata_version columns. Migration 0082 adds them; a database without them after 0082 " +
        "has drifted (spec §8.2).",
    );
  }
}

/** Every public relation's ACL, as text, by name. Read before and after the
 *  grants part so the result can say what reconciliation actually changed. */
async function relationAcls(tx: ReadDb): Promise<Map<string, string>> {
  const rows = (await tx.unsafe(`
    SELECT c.relname AS name, coalesce(c.relacl::text, '') AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')`)) as unknown as { name: string; acl: string }[];
  return new Map(rows.map((row) => [row.name, row.acl]));
}

function changedAcls(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.keys()].filter((name) => before.get(name) !== after.get(name)).sort();
}

/**
 * A database with no ledger is BLANK, and a blank database is the snapshot's
 * job, not the runner's. Spec §8.2: "Blank bootstrap writes ledger rows for the
 * snapshot's filename list, so `--migrate` never replays history." Replaying
 * 0001 onwards as `rm_owner` would also fail partway, because 0053 alters roles
 * and that needs the provisioning login.
 */
async function assertNotBlank(db: ReadDb): Promise<void> {
  const [row] = (await db.unsafe(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  )) as unknown as { present: boolean }[];
  if (row?.present === true) return;
  throw new Error(
    "Refusing the migrate run: this database has no schema_migrations ledger, so it is blank. A blank database " +
      "is bootstrapped from the snapshot (spec §8.1, `bun smoke --local blank`), never by replaying migrations (§8.2).",
  );
}

/**
 * The session IS `rm_owner`. Not "may become it": a superuser, or any member of
 * the role, is refused.
 *
 * Spec §3 makes `rm_owner` the migration login and §8.3 restricts the manifest
 * and the ledger's compat columns to it. The run used to accept any session
 * that could `SET ROLE rm_owner` and then set it per transaction, which let a
 * superuser or a provisioning login run the migrations of record — exactly the
 * credential §3 keeps out of the run. `current_user` is the effective role, so
 * a session that deliberately `SET ROLE rm_owner` for the whole run is the
 * role; one that did not is not.
 */
async function assertOwnerIsSession(db: ReadDb): Promise<void> {
  const [row] = (await db.unsafe(`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rm_owner') AS role_exists,
           current_user AS effective`)) as unknown as { role_exists: boolean; effective: string }[];
  if (row?.role_exists !== true) {
    throw new Error(
      "Refusing the migrate run: this database has no rm_owner role. Spec §9.1 provisions the four roles " +
        "through doadmin before any migrate run is possible.",
    );
  }
  if (row.effective === "rm_owner") return;
  throw new Error(
    `Refusing the migrate run: the session is ${row.effective}, not rm_owner. Only rm_owner may write the schema ` +
      "manifest or the ledger's compat columns — they are trusted inputs to boot decisions (spec §8.3) — and the " +
      "migration login is rm_owner itself (§3), never a superuser or a role that can merely become it.",
  );
}

/**
 * The committed work's expected post-state, checked before the resume plan is
 * built. §8.3: a resume "validates committed work against each migration's
 * expected post-state ... without replaying or accepting drift". The append-only
 * / ledger-immutable trigger inventory is the post-state this repository
 * already declares machine-readably, and it is exactly the state a partial
 * `pg_restore` destroys while leaving the ledger intact (issue #602).
 */
async function assertCommittedPostState(db: ReadDb): Promise<void> {
  const guard = await checkAppendOnlyGuard(db);
  if (guard.status !== "disarmed") return;
  throw new Error(
    `Refusing the migrate run: committed work fails its expected post-state — ${guard.problems.join("; ")}. ` +
      "A resume never accepts drift (spec §8.3).",
  );
}

async function migrationFilenames(dir: string): Promise<readonly string[]> {
  return (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
}

/** The target as a URL for `role`, from a URL for any role on it. */
export function urlAsRole(targetUrl: string, role: string, password: string): string {
  const url = new URL(targetUrl);
  url.username = role;
  url.password = encodeURIComponent(password);
  return url.toString();
}

/**
 * Obtain the `rm_owner` password for this one run and prove it logs in.
 *
 * Inputs: the options, a URL to the target under any credential (a runtime
 * role's — used to name a NOLOGIN owner, never to migrate), and the password
 * source for the connection mode. Output: the password.
 *
 * Two sources, by connection mode. In a local mode it is the owner password
 * smoke generated for the instance (§5, §8.5), handed in by the caller because
 * only the smoke knows the instance whose state directory holds it
 * (scripts/lib/smoke-state.ts generateRolePasswords). On a remote connection
 * it is the `rm_owner = …` line of `$HOME/.env` (D61), handed in by the caller
 * as a {@link RemoteAuthority}. Nothing is ever prompted for: no step of a
 * runbook reads a terminal (D61 rule 1).
 *
 * The value is never logged, never written, never placed in an environment
 * variable or an argument, and never part of a refusal.
 *
 * Refusals: a local run with no generated password handed in; a remote run
 * whose `~/.env` has no `rm_owner` line (naming the key and the file); a login
 * that fails — and when `pg_roles` says `rm_owner` is NOLOGIN, the refusal
 * names `bun scripts/prod-init.ts enable-owner-login`.
 */
export async function resolveOwnerPassword(
  options: MigrateGateOptions & { readonly localOwnerPassword?: string; readonly remote?: RemoteAuthority },
  targetUrl: string,
): Promise<string> {
  if (options.connection === "local") {
    const generated = options.localOwnerPassword;
    if (generated === undefined || generated === "") {
      throw new Error(
        "Refusing: a local migrate run uses the rm_owner password smoke generated for the instance (spec §5, " +
          "§8.5), and none was handed to this run.",
      );
    }
    await assertOwnerLoginWorks(targetUrl, generated);
    return generated;
  }
  if (options.remote === undefined) {
    throw new Error(
      "Refusing: a remote migrate run reads the rm_owner password from $HOME/.env (decision D61), and no " +
        "~/.env authority was handed to this run.",
    );
  }
  const password = requirePrivilegedPassword({ rm_owner: options.remote.ownerPassword }, "rm_owner", options.remote.envFile);
  await assertOwnerLoginWorks(targetUrl, password);
  return password;
}

/**
 * Verify the owner login, and tell the two failures apart. "Password
 * authentication failed" against a NOLOGIN role is the least useful sentence
 * available: on a database that recorded 0053 when it said NOLOGIN the role
 * cannot log in until `prod-init enable-owner-login` has run through `doadmin`.
 * The driver's error text is scrubbed of the password before it is reported.
 */
async function assertOwnerLoginWorks(targetUrl: string, password: string): Promise<void> {
  const attempt = postgres(urlAsRole(targetUrl, "rm_owner", password), { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    await attempt.unsafe("SELECT 1");
    return;
  } catch (error) {
    if (await ownerIsNologin(targetUrl)) {
      throw new Error(
        "Refusing: rm_owner cannot log in to this database (it is NOLOGIN). Run " +
          "`bun scripts/prod-init.ts enable-owner-login --confirm-target <host:port/database>`, which connects as " +
          "doadmin from $HOME/.env, runs `ALTER ROLE rm_owner LOGIN` and proves the login, then retry. This " +
          "database recorded migration 0053 when it created the role NOLOGIN, and the runner never re-applies a " +
          "recorded file, so no migration can perform this step (decision D61).",
      );
    }
    throw new Error(
      `Refusing: the rm_owner credential was not accepted by this database (${scrubSecret((error as Error).message, password)}).`,
    );
  } finally {
    await attempt.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** A driver message with every occurrence of `secret` removed. Postgres never
 *  echoes a password, but a message is printed and journaled, so this holds
 *  the rule whatever the driver does. */
export function scrubSecret(message: string, secret: string): string {
  if (secret === "") return message;
  return message.split(secret).join("***").split(encodeURIComponent(secret)).join("***");
}

/** Read `rolcanlogin` through the runtime credential the caller named. If even
 *  that is unavailable the caller reports the authentication failure it
 *  actually saw rather than a diagnosis it cannot support. */
async function ownerIsNologin(targetUrl: string): Promise<boolean> {
  const ambient = postgres(targetUrl, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    const [row] = (await ambient.unsafe(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'",
    )) as unknown as { rolcanlogin: boolean }[];
    return row?.rolcanlogin === false;
  } catch {
    return false;
  } finally {
    await ambient.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * Warn about a remote target and hold the run to `--confirm-target`.
 *
 * D61: "The literal `y` becomes `--confirm-target <host:port/database>`. A
 * command that writes refuses unless the flag names exactly the target it
 * resolved from `~/.env`." The warning is still printed: a remote target is the
 * one case where the operator's mental model and the connection string can
 * disagree without anything looking wrong, and `deployment_identity` is an
 * "accidental-target safeguard, not proof the data is disposable" (§4.2).
 *
 * Refusals: no flag; a flag that is not exactly `remote.resolvedTarget` (both
 * printed); a remote connection with no authority handed in. A local
 * connection skips it entirely: a Postgres smoke owns needs no flag.
 */
export function confirmRemoteTarget(
  options: Pick<MigrateGateOptions, "connection"> & { readonly remote?: RemoteAuthority },
  /** Extra warning lines printed before the check — the first production
   *  migrate names the pre-identity state the flag confirms. */
  notice: readonly string[] = [],
  write: (text: string) => void = (text) => void process.stdout.write(text),
): void {
  if (options.connection === "local") return;
  if (options.remote === undefined) {
    throw new Error("Refusing: a remote run needs --confirm-target, and no ~/.env authority was handed to this run (D61).");
  }
  write(
    `[migrate] WARNING: this writes the REMOTE target ${options.remote.resolvedTarget} as rm_owner.\n` +
      "[migrate] deployment_identity is an accidental-target safeguard, not proof the data is disposable.\n" +
      notice.map((line) => `[migrate] ${line}\n`).join(""),
  );
  requireConfirmTarget(options.remote.confirmTarget, options.remote.resolvedTarget, "this run");
}

/** A refusal, as a reason and an operator-readable sentence. */
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
 * Apply §4.3's matrix and §8.5's caller rules.
 *
 * Inputs: a handle (to read the one-row `deployment_identity`) and the gate
 * options. Output: every refusal found, empty when the run may proceed.
 *
 * THE MATRIX IS NOT RESTATED HERE: `resolveDeploymentPolicy`
 * (backend/src/deploy-policy.ts) decides, the same function `bun smoke` and
 * preflight check 5 call. A local connection reaches it as `local-volume`: a
 * migrate run always meets a database that already exists and has been
 * enrolled by its bootstrap or restore, so its row must read `rehearsal`.
 *
 * For `caller: "smoke_flag"`, spec §8.5 adds that `--migrate` "refuses on
 * `RM_ENV=prod` or `deployment_identity ≠ rehearsal`", and §4.3 that
 * rehearsal-only preparation requires `rehearsal` "in addition to their own
 * guards" — `requireRehearsalTarget`, the same gate `--seed` and `--spoof-keys`
 * share. For `caller: "operator"`, production is allowed under the policy that
 * names it and nothing else: a stage policy "never touches production data",
 * owner password or not.
 *
 * §4.3's FIRST NAMED EXCEPTION: an operator run under RM_ENV=prod against a remote
 * database with no deployment_identity table, whose ledger equals one
 * SUPPORTED_RELEASES entry exactly, is not refused here
 * (`readPreIdentityState`). Nor is the same run under RM_ENV=stage, the remote
 * rehearsal pass (D61 rule 2). A missing row that fails any of those guards
 * refuses as `identity_missing`, and the refusal names the guard it failed.
 *
 * Serves spec §10 W2 "`RM_ENV=stage` + owner password against
 * `deployment_identity = production` refuses."
 */
export async function checkMigrateGates(db: ReadDb, options: MigrateGateOptions): Promise<readonly MigrateRefusal[]> {
  const refusals: MigrateRefusal[] = [];
  const push = (refusal: MigrateRefusal): void => {
    if (!refusals.some((r) => r.reason === refusal.reason)) refusals.push(refusal);
  };
  const rmEnv = options.env === null ? undefined : options.env;
  const valid = resolveRmEnv({ RM_ENV: rmEnv });

  const identity = await readDeploymentIdentity(db);
  if (identity.kind === "ambiguous") {
    push({
      reason: "identity_missing",
      message:
        `Refusing: deployment_identity holds ${identity.count} rows. It is a one-row table, and no choice ` +
        "between two enrolments is defensible (spec §4.2).",
    });
    return refusals;
  }
  // The matrix reads an absent table as it always has, as unreadable: no
  // evidence of either kind.
  const kind = identity.value === "no table" ? "unreadable" : identity.value;

  // §4.3's first named exception (§9.1, D55 (5)): the first production migrate. When
  // it applies, the identity half of the matrix has nothing to judge — there
  // is no row — and every other guard of the exception is either checked here
  // (RM_ENV=prod, the exact ledger) or is the remote path of `migrateCommand`
  // (`~/.env`'s owner, `--confirm-target`), which `runMigrate` holds it to.
  // The remote rehearsal pass (D61 rule 2) is the same state under
  // RM_ENV=stage, and writes `rehearsal` instead.
  if (await readPreIdentityState(db, options)) return refusals;

  // §8.5: `--migrate` is a stage/test/CI convenience.
  if (options.caller === "smoke_flag" && rmEnv === "prod") {
    push({
      reason: "prod_env",
      message:
        "Refusing: `--migrate` is a convenience for stage, test and CI, and refuses on RM_ENV=prod. In " +
        "production an upgrade is an operator intervention — `bun run migrate`, planned per release and " +
        "receipted — and is never part of a boot (spec §8.5).",
    });
  }

  // §4.3, the one matrix.
  const verdict = resolveDeploymentPolicy({
    rmEnv,
    connection: options.connection === "remote" ? "remote" : "local-volume",
    identity: kind,
  });
  if (!verdict.allow) {
    const reason: MigrateRefusal["reason"] = !valid.ok
      ? "env_invalid"
      : valid.source === "unset" && options.connection === "remote"
        ? "env_unset_remote"
        : valid.env === "prod" && options.connection === "local"
          ? "env_invalid"
          : kind === null || kind === "unreadable"
            ? "identity_missing"
            : "identity_not_rehearsal";
    // `prod` + a smoke-owned Postgres under `--migrate` is already the
    // `prod_env` refusal above; reporting the same fact twice helps nobody.
    if (!(options.caller === "smoke_flag" && reason === "env_invalid" && rmEnv === "prod")) {
      const lead =
        reason === "identity_missing"
          ? "this database has no deployment_identity row, so it is not enrolled as anything, and absence of " +
            "evidence is not evidence of rehearsal (spec §4.2). "
          : "";
      const exception =
        reason === "identity_missing" && identity.value !== "unreadable" && options.caller === "operator"
          ? ` ${await describeWhyNoPreIdentityException(db, options, identity.value)}`
          : "";
      push({ reason, message: `Refusing: ${lead}${verdict.reason}${exception}` });
    }
  }

  // §4.3: rehearsal-only preparation requires `rehearsal` in addition to its
  // own guards. Judged on the identity alone here (the policy half is above),
  // so a `prod` + `production` run learns both of its refusals in one pass.
  if (options.caller === "smoke_flag" && kind !== "rehearsal") {
    const gate = requireRehearsalTarget({ preparation: "migrate", rmEnv: "stage", identity: kind, explicitlyRequested: true, connection: options.connection === "remote" ? "remote" : "local-volume" });
    if (!gate.allow) {
      push({
        reason: kind === "production" ? "identity_not_rehearsal" : "identity_missing",
        message: `Refusing: ${gate.reason}`,
      });
    }
  }

  return refusals;
}

/**
 * The pre-identity state of a remote identity-first pass, when this run
 * qualifies for one, else `null`.
 *
 * Two passes share this state, told apart by the policy alone:
 *   - RM_ENV=prod: the first production migrate (§9.1, D55 (5)). It writes
 *     `production`.
 *   - RM_ENV=stage: the remote rehearsal pass (D61 rule 2). A production dump
 *     restored into a remote stage Postgres has the same pre-identity state,
 *     and stage rehearses the production cutover on it unmodified. It writes
 *     `rehearsal`, never `production` (`identityFirstKind`).
 *
 * Qualifies: the operator caller (`bun run migrate`), RM_ENV=prod or stage, a
 * remote connection, no `deployment_identity` table at all, and a ledger whose
 * filename list equals one SUPPORTED_RELEASES entry's exactly. `~/.env`'s
 * owner and `--confirm-target` are not decided here: they are what
 * `migrateCommand` checks next, and `runMigrate` refuses a qualifying database
 * without the confirmed state.
 */
export async function readPreIdentityState(db: ReadDb, options: MigrateGateOptions): Promise<PreIdentityState | null> {
  if (options.caller !== "operator" || options.connection !== "remote") return null;
  if (options.env !== "prod" && options.env !== "stage") return null;
  return readPreIdentityLedger(db);
}

/** What a remote identity-first pass writes: `production` under prod, `rehearsal`
 *  under stage. Nothing else ever decides it (D61 rule 2). */
export function identityFirstKind(env: MigrateGateOptions["env"]): "production" | "rehearsal" {
  return env === "prod" ? "production" : "rehearsal";
}

/**
 * The database half of every identity-first pass's precondition (§4.3's three
 * named exceptions, D55 (9)): no `deployment_identity` table, and a ledger
 * whose filename list equals one SUPPORTED_RELEASES entry's exactly. `null`
 * when either does not hold. A table with no row does not qualify: every
 * supported baseline predates 0081, so that table was created out of band
 * (or emptied), and the pass would refuse it under its fence anyway — the
 * gates refuse it first, before a password is asked for. Who may take a pass on that state — the
 * policy, the connection, the credential, the confirmation — is each pass's
 * own guard, never this function's.
 */
export async function readPreIdentityLedger(db: ReadDb): Promise<PreIdentityState | null> {
  const identity = await readDeploymentIdentity(db);
  if (identity.kind !== "read" || identity.value !== "no table") return null;
  const ledger = await ledgerOf(db);
  const release = matchSupportedRelease(ledger);
  if (release === null) return null;
  return { identity: "no table", release: release.name, ledger };
}

/** Whether `deployment_identity` exists at all — the question that sends a
 *  restored dump down the identity-first pass (D55 (10)). */
export async function identityTableExists(db: ReadDb): Promise<boolean> {
  const identity = await readDeploymentIdentity(db);
  return identity.kind !== "read" || identity.value !== "no table";
}

/** Why a database with no identity row does not qualify for an identity-first
 *  pass: its ledger against every supported baseline, or its row. */
export async function describeUnmatchedPreIdentity(db: ReadDb): Promise<string> {
  const identity = await readDeploymentIdentity(db);
  if (identity.kind === "read" && identity.value !== null && identity.value !== "no table") {
    return `deployment_identity reads ${identity.value}`;
  }
  if (identity.kind === "read" && identity.value === null) return TABLE_WITHOUT_ROW;
  return (
    "its ledger matches no supported baseline exactly (D55 (8)) — " +
    `${describeUnmatchedLedger(await ledgerOf(db))}. A dump with any other pre-identity ledger refuses`
  );
}

/** One identity-first pass (§4.3, D55 (9)): who is taking it and what it writes. */
export interface IdentityFirstPass {
  /** `production` for the first production migrate; `rehearsal` for the
   *  `--local dump` preparation. */
  readonly kind: "production" | "rehearsal";
  /** The policy the pass runs under. The production write refuses anything
   *  but `prod` (enrollAsProduction); the rehearsal write refuses `prod`
   *  (enrollAsRehearsal). */
  readonly rmEnv: "prod" | "stage" | null;
  /** Whether the pass's connection is a remote one. The rehearsal write
   *  refuses a remote connection unless `remoteRehearsalConfirmed` is set. */
  readonly remote: boolean;
  /** The remote rehearsal pass only (D61 rule 2): `bun run migrate` under
   *  RM_ENV=stage held the run to `--confirm-target` before it got here. The
   *  `--local dump` pass never sets it, so its rule (D55 (9): never remote)
   *  holds unchanged. */
  readonly remoteRehearsalConfirmed?: boolean;
  /** The state the pass was admitted on. The pass re-reads it under its fence
   *  and refuses unless it is the same one. */
  readonly expected: PreIdentityState;
  /** What the identity row's note records. */
  readonly note: string;
  /** Where 0081 is read from. Defaults to backend/migrations/. */
  readonly migrationsDir?: string;
}

/** What an identity-first pass committed. */
export interface IdentityFirstResult {
  /** The pre-identity state the pass read under its fence. */
  readonly preIdentity: PreIdentityState;
  /** The row it wrote in 0081's transaction. */
  readonly row: DeploymentIdentityRow;
}

/**
 * The identity-first pass: 0081's DDL, its `schema_migrations` row and the
 * identity row, in ONE fenced transaction (§2, §4.3, D55 (9)).
 *
 * Inputs: an `rm_owner` pool and the pass. Output: what it committed.
 *
 * Every step runs inside the fence's transaction, in this order: the
 * pre-identity state is re-read (no table, a ledger exactly equal to
 * a supported baseline, and equal to `expected`); 0081's DDL; its ledger row
 * with its declaration when it carries one; the identity row, written through
 * `transactionIdentityStore` with the pass's remote flag by
 * `enrollAsProduction` or `enrollAsRehearsal`, whose own guards then hold on
 * this path too. Any refusal or failure rolls the whole transaction back, so
 * the database is left exactly as it was: a baseline ledger, no table, no row.
 * A commit leaves 0081 recorded WITH its row. No committed state holds one
 * without the other.
 *
 * Refusals: the state under the fence is not a pre-identity baseline (no
 * table and a baseline ledger), or not the expected one; the identity write's
 * own guards (production: RM_ENV=prod; rehearsal:
 * not prod, and never a remote connection).
 *
 * Callers: `runMigrate`'s first production migrate (`production`, RM_ENV=prod),
 * `runMigrate`'s remote rehearsal pass (`rehearsal`, RM_ENV=stage, D61 rule 2)
 * and backend/scripts/smoke-prepare.ts's `--local dump` enroll step
 * (`rehearsal`). Each proves its own pass's guards before calling it.
 */
export async function applyIdentityFirst(db: MigrateDb, pass: IdentityFirstPass): Promise<IdentityFirstResult> {
  const migrationsDir = pass.migrationsDir ?? MIGRATIONS_DIR;
  const ddl = await readFile(join(migrationsDir, IDENTITY_MIGRATION), "utf8");
  const header = parsePendingHeader(IDENTITY_MIGRATION, ddl);
  return withFenceOn(db, `migrate ${IDENTITY_MIGRATION} identity-first`, async (tx) => {
    const state = await readPreIdentityLedger(tx);
    if (state === null || !samePreIdentity(state, pass.expected)) {
      throw new Error(
        `Refusing the identity-first pass (spec §4.3, D55 (9)): it was admitted on ${describePreIdentity(pass.expected)}, ` +
          `and under the fence this database ${state === null ? "no longer qualifies" : `reads ${describePreIdentity(state)}`}. ` +
          "Nothing was applied.",
      );
    }
    await tx.unsafe(ddl);
    await on(tx, qRecordMigration)`INSERT INTO schema_migrations (name) VALUES (${IDENTITY_MIGRATION})`;
    if (header !== null) await recordDeclaration(tx, header);
    const store = transactionIdentityStore(tx, { remote: pass.remote });
    const row =
      pass.kind === "production"
        ? await enrollAsProduction(store, { rmEnv: pass.rmEnv ?? undefined, confirmed: true, note: pass.note })
        : await enrollAsRehearsal(store, {
            note: pass.note,
            remoteAcknowledged: pass.remote && pass.remoteRehearsalConfirmed === true,
          });
    if (row.kind !== pass.kind) {
      throw new Error(`Refusing the identity-first pass: the row reads ${row.kind} after writing ${pass.kind}. Nothing was applied.`);
    }
    return { preIdentity: state, row };
  });
}

/** The state an identity-first pass left, as the normal path reads it. */
export interface IdentityPassRemainder {
  /** The SUPPORTED_RELEASES baseline the rows applied before 0081 equal. */
  readonly release: string;
  /** The rows applied before 0081: that baseline's filename list. */
  readonly baseline: readonly string[];
  /** The rows applied after 0081, in filename order. */
  readonly appliedAfter: readonly string[];
}

/**
 * Whether this database is in the state an identity-first pass leaves (§9.1:
 * "The normal path may apply a pending file that sorts below a recorded 0081
 * only when the identity row exists and the rest of the ledger equals the
 * baseline plus 0081, plus any files applied after it"), else `null`.
 *
 * Holds exactly when: the identity row exists (`production` or `rehearsal`);
 * 0081 is recorded; every other ledger row was applied strictly before or
 * strictly after it (the pass commits 0081 in a transaction of its own, so a
 * row sharing its `applied_at` came from somewhere else — a snapshot bootstrap
 * writes every row in one transaction); and the rows applied before it equal
 * one supported baseline exactly. The comparison runs in SQL, on the
 * microsecond timestamps the ledger stores.
 */
export async function readIdentityPassRemainder(db: ReadDb): Promise<IdentityPassRemainder | null> {
  const identity = await readDeploymentIdentity(db);
  if (identity.kind !== "read" || (identity.value !== "production" && identity.value !== "rehearsal")) return null;
  const rows = (await on(db, qReadLedgerSides)`SELECT m.name,
            CASE WHEN m.applied_at < p.applied_at THEN 'before'
                 WHEN m.applied_at > p.applied_at THEN 'after'
                 ELSE 'same' END AS side
       FROM schema_migrations m, (SELECT applied_at FROM schema_migrations WHERE name = ${IDENTITY_MIGRATION}) p
      WHERE m.name <> ${IDENTITY_MIGRATION}
      ORDER BY m.name`) as unknown as { name: string; side: "before" | "after" | "same" }[];
  if (rows.length === 0 || rows.some((row) => row.side === "same")) return null;
  const baseline = rows.filter((row) => row.side === "before").map((row) => row.name);
  const release = matchSupportedRelease(baseline);
  if (release === null) return null;
  return { release: release.name, baseline, appliedAfter: rows.filter((row) => row.side === "after").map((row) => row.name) };
}

/** For an operator run refused for a missing row: which guard of the one
 *  exception it failed, so the refusal says what would have to be true. */
async function describeWhyNoPreIdentityException(
  db: ReadDb,
  options: MigrateGateOptions,
  identity: "production" | "rehearsal" | null | "unreadable" | "no table",
): Promise<string> {
  const lead =
    "The runs allowed without the row, the first production migrate (spec §9.1, D55 (5)) and the remote " +
    "rehearsal pass (D61), need";
  if (options.env !== "prod" && options.env !== "stage") {
    return `${lead} RM_ENV=prod or RM_ENV=stage, and this run is RM_ENV=${options.env ?? "(unset)"}.`;
  }
  if (options.connection !== "remote") return `${lead} a remote target.`;
  const ledger = await ledgerOf(db);
  if (identity === null) {
    const also = matchSupportedRelease(ledger) === null ? ` Its ledger also matches none — ${describeUnmatchedLedger(ledger)}.` : "";
    return `${lead} no deployment_identity table at all: ${TABLE_WITHOUT_ROW}.${also}`;
  }
  return (
    `${lead} a ledger exactly equal to one supported baseline's filename list, and this one matches none — ` +
    `${describeUnmatchedLedger(ledger)}. A partly migrated or hand-edited ledger is repaired first.`
  );
}

/** Why a table with no row never qualifies for an identity-first pass. */
const TABLE_WITHOUT_ROW =
  "deployment_identity exists with no row. Every supported baseline predates 0081, which creates the table, so it " +
  "was created out of band or emptied, and the identity-first pass runs only where the table does not exist (D55 (9)). " +
  "Repair it by the §9.1 operator steps first";

/** The ledger's filenames in filename order; `[]` when there is no ledger. */
async function ledgerOf(db: ReadDb): Promise<string[]> {
  const [exists] = (await db.unsafe(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  )) as unknown as { present: boolean }[];
  if (exists?.present !== true) return [];
  return ((await on(db, qReadLedger)<{ name: string }>`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]).map(
    (row) => row.name,
  );
}

type IdentityRead =
  | { readonly kind: "read"; readonly value: "production" | "rehearsal" | null | "unreadable" | "no table" }
  | { readonly kind: "ambiguous"; readonly count: number };

/**
 * Read the one-row table. An absent table is `no table`, which the matrix reads
 * as unreadable (never evidence of either kind) and only §9.1's first
 * production migrate reads as its own case; a table with no row is `null`. The
 * value is read from whichever column carries it: §4.2 names it `kind`
 * (migration 0081); a database enrolled
 * before that migration carries it in `identity`. Refusing to read the row
 * because of the column's name would turn an enrolled production database into
 * an un-enrolled one, which is the one misreading with a catastrophic direction.
 */
async function readDeploymentIdentity(db: ReadDb): Promise<IdentityRead> {
  const [exists] = (await db.unsafe(
    "SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present",
  )) as unknown as { present: boolean }[];
  if (exists?.present !== true) return { kind: "read", value: "no table" };

  const columns = (await db.unsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'deployment_identity'
      AND column_name IN ('kind', 'identity')`)) as unknown as { column_name: string }[];
  const names = new Set(columns.map((row) => row.column_name));
  const column = names.has("kind") ? "kind" : names.has("identity") ? "identity" : null;
  if (column === null) return { kind: "read", value: "unreadable" };

  let rows: { value: string }[];
  try {
    rows = (await db.unsafe(`SELECT ${column} AS value FROM deployment_identity`)) as unknown as { value: string }[];
  } catch {
    return { kind: "read", value: "unreadable" };
  }
  if (rows.length > 1) return { kind: "ambiguous", count: rows.length };
  const value = rows[0]?.value;
  if (value === undefined) return { kind: "read", value: null };
  return { kind: "read", value: value === "production" || value === "rehearsal" ? value : "unreadable" };
}

/** Who ran what against which target, for the receipt. Never a credential. */
export interface MigrateReceiptContext {
  readonly caller: MigrateCaller;
  readonly env: MigrateGateOptions["env"];
  /** host:port/dbname, the password-free form. */
  readonly target: string;
  readonly startedAt: Date;
  /** The session target lock the run proceeded under, as `describeHolderText` names it. */
  readonly lock?: string;
}

/** The receipt's filename inside an instance's state directory. One file per
 *  run, stamped with its start time, so a later run never overwrites the record
 *  of an earlier one. */
export function migrateReceiptPath(stateDir: string, startedAt: Date): string {
  return join(stateDir, `migrate-receipt-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
}

/**
 * Write the durable record of a completed run. Spec §8.5: a production upgrade
 * is "planned per release, receipted". It holds no credential — the owner
 * password never reaches this function and `target` is the redacted form — and
 * is owner-readable only. An existing file refuses (`wx`): a receipt is a
 * record, and a record is never silently replaced. Output: the path written.
 */
export async function writeMigrateReceipt(
  path: string,
  result: MigrateRunResult,
  context: MigrateReceiptContext,
): Promise<string> {
  const receipt = {
    kind: "migrate-receipt",
    startedAt: context.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    caller: context.caller,
    env: context.env,
    target: context.target,
    ...(context.lock ? { targetLock: context.lock } : {}),
    applied: result.applied,
    resumedAndVerified: result.resumedAndVerified,
    grantsRepaired: result.grantsRepaired,
    baselined: result.baselined,
    // §9.1: the first production migrate's receipt "records the pre-identity
    // state"; every other run's says there was none.
    preIdentity: result.preIdentity,
    // D55 (9): the row the pass committed in 0081's transaction, and — on the
    // run that resumed after a pass — the baseline it resumed from.
    identityWritten: result.identityWritten,
    resumedAfterIdentityPass: result.resumedAfterIdentityPass,
    manifest: {
      formatVersion: result.manifest.formatVersion,
      contentHash: result.manifest.contentHash,
      filenames: result.manifest.filenames,
    },
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

/** Password-free `host:port/dbname`, the only form of a target this module prints. */
export function redactedTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}

/** A refusal the command reports and exits non-zero on, as distinct from a crash. */
export class MigrateRefused extends Error {}

/**
 * THE command sequence, shared by `bun run migrate` and `bun smoke --migrate`
 * (see the header), in this order and no other:
 *
 *   1. Read the target's identity, ledger and manifest — the PLAN, not a
 *      decision.
 *   2. Hold the target lock: acquire it over the reader's direct connection
 *      (`bun run migrate`), revalidating the plan against the locked target
 *      and waiting at most `lockTimeoutMs` behind another holder; or prove the
 *      parent's lock (`bun smoke`). §2: after create/restore, "before the first
 *      read used for a decision".
 *   3. The gates, read under the lock, BEFORE the owner password is used, so a
 *      refused run never logs in as the owner. A remote identity-first pass's
 *      pre-identity state is read here too.
 *   4. The owner password: `~/.env`'s `rm_owner` line (remote, D61) or smoke's
 *      generated one (local), proven by a login.
 *   5. `confirmRemoteTarget`: warn — naming the pre-identity state when there
 *      is one — then hold the run to `--confirm-target` (remote only).
 *   6. `runMigrate` as `rm_owner`, under the lock, holding it to the state the
 *      flag confirmed.
 *   7. The receipt. The lock is released on every exit path.
 *
 * With a `journal`, every step is a journaled phase (§2), begun before the lock
 * is proven for it, and the run closes the journal on its way out: `succeeded`
 * with the receipt, or `refused` / `failed` naming the phase it stopped in. The
 * lock is proven at every boundary after it is held, so a lock connection that
 * died between phases is found at the next phase, and that phase does
 * not start.
 *
 * Refusals throw {@link MigrateRefused}: a held lock past the timeout (naming
 * the holder and its plan id), a revalidation mismatch, a gate, a missing
 * `rm_owner` line, a missing or mismatched `--confirm-target`.
 */
export async function migrateCommand(input: {
  readonly caller: MigrateCaller;
  readonly env: MigrateGateOptions["env"];
  readonly connection: MigrateGateOptions["connection"];
  /** The target under a runtime credential that cannot migrate (`rm_readonly` from `~/.env`, or smoke's). */
  readonly readerUrl: string;
  /** A remote connection's `~/.env` authority: the owner password, the file,
   *  `--confirm-target` and the target the file resolves to (D61). */
  readonly remote?: RemoteAuthority;
  readonly localOwnerPassword?: string;
  /** Acquire the lock here, or prove the one the parent process holds. */
  readonly lock:
    | { readonly acquire: { readonly holder: Omit<LockHolder, "acquiredAt">; readonly timeoutMs: number } }
    | { readonly heldByParent: (reader: postgresTypes.Sql<{}>) => HeldTargetLock };
  readonly receiptPath: string;
  /** The run's journal (`bun run migrate`); absent under `bun smoke --migrate`,
   *  whose parent journals the preparation. */
  readonly journal?: MigrateJournal;
  readonly seams?: MigrateRunSeams;
  readonly log: (message: string) => void;
}): Promise<{ readonly result: MigrateRunResult; readonly receipt: string }> {
  const startedAt = new Date();
  const target = redactedTarget(input.readerUrl);
  const journal = input.journal;
  journal?.setTarget(target);
  const reader = postgres(input.readerUrl, { max: 1, onnotice: () => {} });
  let owner: postgresTypes.Sql<{}> | null = null;
  let release: (() => Promise<void>) | null = null;
  let lock: HeldTargetLock | null = null;
  /** Begin a phase: journal it, then — once there is a lock — prove it. */
  const phase = async (name: string): Promise<void> => {
    journal?.begin(name);
    if (lock !== null) await assertStillHeld(lock, name);
  };
  try {
    if ("acquire" in input.lock) {
      // 1–2. The plan, then the lock over a DIRECT connection (refusePoolerUrl
      // runs inside acquireTargetLock) and revalidation against the plan.
      await phase("plan");
      const expected = await readTargetState(reader);
      await phase("lock");
      const acquired = await acquireTargetLock({
        databaseUrl: input.readerUrl,
        holder: input.lock.acquire.holder,
        timeoutMs: input.lock.acquire.timeoutMs,
        expected,
      });
      if (!acquired.acquired) throw new MigrateRefused(`Refusing: ${acquired.reason}`);
      const held = acquired.lock;
      const dispose = releaseTargetLockOnExit(held);
      release = async () => {
        dispose();
        await held.release();
      };
      lock = held;
    } else {
      await phase("lock");
      lock = input.lock.heldByParent(reader);
    }
    const heldLock = lock;
    await phase("gates");
    input.log(`target ${target} under ${describeHolderText(heldLock.holder)}`);

    // 3. The gates, under the lock, before any password exists.
    const gateOptions: MigrateGateOptions = { caller: input.caller, env: input.env, connection: input.connection };
    const refusals = await checkMigrateGates(reader, gateOptions);
    if (refusals.length > 0) throw new MigrateRefused(refusals.map((r) => r.message).join("\n"));
    const preIdentity = await readPreIdentityState(reader, gateOptions);
    const passName =
      identityFirstKind(input.env) === "production"
        ? "first production migrate (spec §9.1, D55 (5))"
        : "remote rehearsal pass (D61 rule 2, D55 (9))";
    if (preIdentity) {
      input.log(
        `${passName}: deployment_identity has ${preIdentity.identity}, and the ` +
          `ledger equals ${preIdentity.release}'s ${preIdentity.ledger.length} files`,
      );
    }

    // 4–5. The owner credential for this one run, then --confirm-target.
    await phase("owner");
    input.log(`RM_ENV=${input.env ?? "(unset)"}, ${input.connection} target ${target}`);
    const password = await resolveOwnerPassword(
      { ...gateOptions, localOwnerPassword: input.localOwnerPassword, remote: input.remote },
      input.readerUrl,
    ).catch((error: unknown) => {
      throw new MigrateRefused((error as Error).message);
    });
    await phase("confirm");
    const notice = preIdentity
      ? [
          `this is the ${passName.toUpperCase()}: deployment_identity has ${preIdentity.identity}, and the ledger ` +
            `equals ${preIdentity.release}'s ${preIdentity.ledger.length} files. It writes ` +
            `\`${identityFirstKind(input.env)}\` in 0081's transaction.`,
          "It runs once. Every later run of every tool requires the identity row.",
        ]
      : [];
    try {
      confirmRemoteTarget({ connection: input.connection, remote: input.remote }, notice);
    } catch (error) {
      throw new MigrateRefused((error as Error).message);
    }
    owner = postgres(urlAsRole(input.readerUrl, "rm_owner", password), { max: 1, onnotice: () => {} });

    // 6. The run, as rm_owner, under the lock, on the state the flag confirmed.
    const result = await runMigrate(
      owner,
      {
        ...gateOptions,
        lock: heldLock,
        ...(preIdentity ? { confirmedPreIdentity: preIdentity } : {}),
        onPhase: (name) => journal?.begin(name),
      },
      input.seams,
    );

    // 7. The receipt.
    await phase("receipt");
    const receipt = await writeMigrateReceipt(input.receiptPath, result, {
      caller: input.caller,
      env: input.env,
      target,
      startedAt,
      lock: describeHolderText(heldLock.holder),
    });
    journal?.close("succeeded", null, receipt);
    return { result, receipt };
  } catch (error) {
    // §2: the losing run journals the phase it stopped in, then the caller
    // exits non-zero.
    const message = error instanceof Error ? error.message : String(error);
    const refused = error instanceof MigrateRefused || message.startsWith("Refusing");
    journal?.close(refused ? "refused" : "failed", message);
    throw error;
  } finally {
    await owner?.end({ timeout: 5 }).catch(() => undefined);
    await release?.().catch(() => undefined);
    await reader.end({ timeout: 5 }).catch(() => undefined);
  }
}
