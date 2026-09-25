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
//     prompts for `rm_owner`, confirms a remote target with an explicit `y`,
//     runs, writes the receipt and releases the lock on exit.
//   `bun smoke --migrate` (backend/scripts/smoke-prepare.ts, a child of
//     scripts/lib/smoke-main.ts) — the stage/test/CI convenience. The smoke
//     process already holds the target lock for its whole run (§2: "from
//     acquisition through preflight, replacement, and readiness"), so the child
//     OBSERVES that lock (target-lock.ts observeTargetLock) and proves at every
//     boundary that its parent still holds it. In a local mode the owner
//     password is the one smoke generated for the instance (§8.5); on a remote
//     rehearsal it is typed, exactly as `bun run migrate` types it.
//
// Neither ever connects as `doadmin` or reads an owner password from a file.
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
// `rm_owner`, and nothing that merely may become it. Spec §3: "**`rm_owner` is
// `LOGIN`.** Its password is typed at the terminal for the one run that needs it
// and never stored." `assertOwnerIsSession` requires `current_user = rm_owner`:
// a superuser session or a mere member of the role is refused, because the
// manifest and the ledger's compat columns are "trusted inputs to boot
// decisions" (§8.3) and only the schema owner writes them. Migration 0053
// creates `rm_owner` LOGIN on a fresh cluster; an EXISTING database recorded
// 0053 when it said NOLOGIN, so there spec §9.1 step 1 is a one-time `doadmin`
// step, and the refusal says which of the two situations it is in.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type postgresTypes from "postgres";
import { hiddenPrompt } from "../../scripts/lib/smoke-external-migrate.ts";
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

/** A pool: every mutating transaction is `pool.begin` under the fence. */
export type MigrateDb = postgresTypes.Sql<{}>;
/** Anything that reads — the gates accept a transaction too. */
type ReadDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
   *  warning and the `y/n`, and where the owner password comes from. */
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
  /** Skip every prompt and refuse rather than ask. An unattended run that
   *  would have blocked on a terminal must fail fast. */
  readonly nonInteractive: boolean;
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
 *      prefix of the snapshot's filename list (§9.1 step 2).
 *   5. Headers — every pending file's §8.2 header is parsed before the first
 *      commit, so a missing declaration refuses with nothing applied.
 *   6. Apply — each pending migration in its own fenced transaction, with
 *      `recordMigrationCompat()` writing `compat`/`metadata_version` inside it.
 *   7. Reconcile and publish — the snapshot's grants part, the baseline
 *      comparison when this is the first manifest, then `writeManifest()`, in
 *      one fenced transaction.
 *
 * Refusals: the lock cannot be proven held at a boundary; the session is not
 * `rm_owner`; a gate refuses; the database is blank (no ledger — that is the
 * snapshot's bootstrap, §8.1, never a replay); `resumePlan` refused; a pending
 * migration above the pre-compat baseline (0063, D53) has no parseable compat
 * header; the first manifest's baseline found a gap or a difference (named,
 * nothing published).
 *
 * Serves spec §10 W2 "Migrate fails between commits and during grant
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
  await assertStillHeld(options.lock, "migrate: start");
  await assertOwnerIsSession(db);

  // 2. RE-RUN THE GATES on the owner connection. §2: "After acquiring, the tool
  //    re-reads `deployment_identity`, the ledger, and the schema manifest and
  //    re-runs the plan against them. A mismatch refuses." The caller's gates
  //    ran before the owner password existed; the row can have changed since.
  const refusals = await checkMigrateGates(db, options);
  if (refusals.length > 0) {
    throw new Error(`Refusing the migrate run: ${refusals.map((r) => r.message).join(" ")}`);
  }
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

  // 4. BASELINE GAP, before anything is applied: see assertBaselineGap. The
  //    FINAL filename list (ledger plus pending) is held to the snapshot's here
  //    too, so the one refusal left after the apply loop is the catalog's.
  if (firstManifest) await assertBaselineGap(db, snapshot, plan.pending);

  // 5. HEADERS, ALL OF THEM, BEFORE THE FIRST COMMIT. §8.2: every migration
  //    "declares itself `additive` or `breaking` in a header the runner
  //    parses". Files at or below the pre-compat baseline may carry none
  //    (`parsePendingHeader`, D53).
  const pending: { file: string; ddl: string; header: MigrationHeader | null }[] = [];
  for (const file of plan.pending) {
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    pending.push({ file, ddl, header: parsePendingHeader(file, ddl) });
  }

  // 6. APPLY, one fenced transaction each, each recording its own declaration
  //    so the row and the DDL commit together (§8.2).
  const applied: string[] = [];
  for (const { file, ddl, header } of pending) {
    await assertStillHeld(options.lock, `migrate: apply ${file}`);
    await withFenceOn(db, `migrate ${file}`, async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      if (header !== null) await recordDeclaration(tx, header);
    });
    applied.push(file);
    if (seams.afterCommit) await seams.afterCommit(file);
  }

  // 7. RECONCILE AND PUBLISH, in ONE fenced transaction, so "manifest
  //    published" means "grants reconciled" (§8.3) — and, for a first
  //    manifest, "the live schema was compared with the snapshot" (§9.1).
  await assertStillHeld(options.lock, "migrate: reconcile and publish");
  const { manifest, grantsRepaired } = await withFenceOn(db, "migrate reconcile", async (tx) => {
    const before = await relationAcls(tx);
    await tx.unsafe(snapshot.grantsSql);
    const after = await relationAcls(tx);
    const filenames = (
      (await tx.unsafe("SELECT name FROM schema_migrations ORDER BY name")) as unknown as { name: string }[]
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
  };
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
 *     file is recorded. Production's ledger never recorded 0053 and 0062
 *     because scripts/ops/provision-db-role-taxonomy.sh applied them through
 *     psql: the runner would "apply" 0053 again, as a pending file, onto a
 *     schema that already has it. That is repaired by the §9.1 operator steps
 *     first, never by this run;
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
 */
async function assertBaselineGap(db: ReadDb, snapshot: Snapshot, pending: readonly string[]): Promise<void> {
  const ledger = (
    (await db.unsafe("SELECT name FROM schema_migrations ORDER BY name")) as unknown as { name: string }[]
  ).map((row) => row.name);
  const embodied = new Set(snapshot.filenames);
  const recorded = new Set(ledger);
  const last = ledger.at(-1);
  const problems = [
    ...ledger
      .filter((name) => !embodied.has(name))
      .map((name) => `the ledger records ${name}, which the snapshot does not embody`),
    ...snapshot.filenames
      .filter((name) => !recorded.has(name) && last !== undefined && name < last)
      .map((name) => `the snapshot embodies ${name}, which the ledger does not record although later files are recorded`),
    ...pending
      .filter((name) => !embodied.has(name))
      .map((name) => `the pending ${name} is not embodied by the snapshot`),
    ...snapshot.filenames
      .filter((name) => !recorded.has(name) && !pending.includes(name) && !(last !== undefined && name < last))
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
 * The ledger's `compat`/`metadata_version` columns arrive with migration 0064.
 * A file ABOVE the pre-compat baseline always runs after 0064, so a missing
 * column there is drift (someone dropped it) and refuses. A pre-compat file
 * that happens to declare itself (0053 does) may run on a database 0064 has
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
        "has no compat/metadata_version columns. Migration 0064 adds them; a database without them after 0064 " +
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
 * role's — used to name a NOLOGIN owner, never to migrate), and, in a local
 * mode, the owner password smoke generated for the instance. Output: the
 * password.
 *
 * Two sources, by connection mode, per §8.5: "In local modes it uses the owner
 * password smoke generated. On a remote connection it prompts for `rm_owner`."
 * The local password comes from the caller because only the smoke knows the
 * instance whose state directory holds it (scripts/lib/smoke-state.ts
 * generateRolePasswords); this module never invents one.
 *
 * The prompt is masked and the value is never written anywhere, never logged,
 * and never placed in an environment variable. §3: "typed at the terminal for
 * the one run that needs it and never stored."
 *
 * Refusals: a remote run that is `nonInteractive`; a local run with no
 * generated password handed in; an empty password; a login that fails — and
 * when `pg_roles` says `rm_owner` is NOLOGIN, the refusal names spec §9.1 step 1
 * (`ALTER ROLE rm_owner LOGIN PASSWORD …` through `doadmin`).
 */
export async function promptOwnerPassword(
  options: MigrateGateOptions & { readonly nonInteractive: boolean; readonly localOwnerPassword?: string },
  targetUrl: string,
): Promise<string> {
  if (options.connection === "local") {
    // §5: "No terminal prompt exists in local modes."
    const generated = options.localOwnerPassword;
    if (generated === undefined || generated === "") {
      throw new Error(
        "Refusing: a local migrate run uses the rm_owner password smoke generated for the instance (spec §5, " +
          "§8.5), and none was handed to this run. There is no prompt in a local mode.",
      );
    }
    await assertOwnerLoginWorks(targetUrl, generated);
    return generated;
  }
  if (options.nonInteractive) {
    throw new Error(
      "Refusing: a remote migrate run needs the rm_owner password typed at the terminal, and this run is " +
        "non-interactive (stdin is not a terminal). Spec §3 keeps that password out of files and " +
        "environment variables, so there is nothing for an unattended run to read.",
    );
  }
  const typed = await hiddenPrompt("rm_owner password (not echoed, not stored)");
  if (typed === "") throw new Error("Refusing: no rm_owner password entered.");
  await assertOwnerLoginWorks(targetUrl, typed);
  return typed;
}

/**
 * Verify the owner login, and tell the two failures apart. "Password
 * authentication failed" against a NOLOGIN role is the least useful sentence
 * available: on a database that recorded 0053 when it said NOLOGIN the role
 * cannot log in until spec §9.1 step 1 has been performed through `doadmin`.
 */
async function assertOwnerLoginWorks(targetUrl: string, password: string): Promise<void> {
  const attempt = postgres(urlAsRole(targetUrl, "rm_owner", password), { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    await attempt.unsafe("SELECT 1");
    return;
  } catch (error) {
    if (await ownerIsNologin(targetUrl)) {
      throw new Error(
        "Refusing: rm_owner cannot log in to this database — spec §9.1 step 1 has not been applied here. " +
          "Through doadmin, run `ALTER ROLE rm_owner LOGIN PASSWORD '<password>'` and verify the login, then " +
          "retry. This database recorded migration 0053 when it created the role NOLOGIN, and the runner " +
          "never re-applies a recorded file, so no migration can perform this step.",
      );
    }
    throw new Error(
      `Refusing: the rm_owner credential was not accepted by this database (${(error as Error).message}).`,
    );
  } finally {
    await attempt.end({ timeout: 5 }).catch(() => undefined);
  }
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
 * Warn about a remote target and require an explicit `y`.
 *
 * Spec §8.5: "On a remote connection it prompts for `rm_owner`, warns, and asks
 * `y/n`." The warning exists because a remote target is the one case where the
 * operator's mental model and the connection string can disagree without
 * anything looking wrong, and `deployment_identity` is an "accidental-target
 * safeguard, not proof the data is disposable" (§4.2).
 *
 * Refusals: anything but an explicit `y` (empty input is `n`; `yes` is not `y`
 * — there is no default and no synonym, because a confirmation that can be
 * reached by accident is not one); `nonInteractive` on a remote connection.
 * Local connections skip it entirely (§5: "No terminal prompt exists in local
 * modes").
 */
export async function confirmRemoteTarget(
  options: Pick<MigrateGateOptions, "connection"> & { readonly nonInteractive: boolean },
  redactedTarget: string,
): Promise<void> {
  if (options.connection === "local") return;

  if (options.nonInteractive) {
    throw new Error(
      `Refusing: this run would migrate the remote target ${redactedTarget}, and a non-interactive run may ` +
        "not confirm that on the operator's behalf. deployment_identity is an accidental-target safeguard, " +
        "not proof the data is disposable (spec §4.2).",
    );
  }

  process.stdout.write(
    `[migrate] WARNING: this will apply pending migrations to the REMOTE target ${redactedTarget} as rm_owner.\n` +
      "[migrate] deployment_identity is an accidental-target safeguard, not proof the data is disposable.\n" +
      "[migrate] type y to continue, anything else to stop: ",
  );
  const answer = (await readLine()).replace(/[\r\n]+$/, "");
  if (answer !== "y") {
    throw new Error(`Refusing: the migrate run against ${redactedTarget} was not confirmed (an explicit y is required).`);
  }
}

/** One line from stdin. Unmasked on purpose — the answer is `y`, not a secret. */
async function readLine(): Promise<string> {
  for await (const chunk of process.stdin) return Buffer.from(chunk as Uint8Array).toString("utf8");
  return "";
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
 * typed owner password or not.
 *
 * Serves spec §10 W2 "`RM_ENV=stage` + typed owner password against
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
  const kind = identity.value;

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
      push({ reason, message: `Refusing: ${lead}${verdict.reason}` });
    }
  }

  // §4.3: rehearsal-only preparation requires `rehearsal` in addition to its
  // own guards. Judged on the identity alone here (the policy half is above),
  // so a `prod` + `production` run learns both of its refusals in one pass.
  if (options.caller === "smoke_flag" && kind !== "rehearsal") {
    const gate = requireRehearsalTarget({ preparation: "migrate", rmEnv: "stage", identity: kind, explicitlyRequested: true });
    if (!gate.allow) {
      push({
        reason: kind === "production" ? "identity_not_rehearsal" : "identity_missing",
        message: `Refusing: ${gate.reason}`,
      });
    }
  }

  return refusals;
}

type IdentityRead =
  | { readonly kind: "read"; readonly value: "production" | "rehearsal" | null | "unreadable" }
  | { readonly kind: "ambiguous"; readonly count: number };

/**
 * Read the one-row table. An absent table is "unreadable" (never evidence of
 * either kind); a table with no row is `null`. The value is read from whichever
 * column carries it: §4.2 names it `kind` (migration 0063); a database enrolled
 * before that migration carries it in `identity`. Refusing to read the row
 * because of the column's name would turn an enrolled production database into
 * an un-enrolled one, which is the one misreading with a catastrophic direction.
 */
async function readDeploymentIdentity(db: ReadDb): Promise<IdentityRead> {
  const [exists] = (await db.unsafe(
    "SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present",
  )) as unknown as { present: boolean }[];
  if (exists?.present !== true) return { kind: "read", value: "unreadable" };

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
 *   3. The gates, read under the lock, BEFORE the owner password is requested,
 *      so a refused run never has a password typed into it.
 *   4. The owner password: typed (remote) or smoke's generated one (local).
 *   5. `confirmRemoteTarget`: warn, then an explicit `y`.
 *   6. `runMigrate` as `rm_owner`, under the lock.
 *   7. The receipt. The lock is released on every exit path.
 *
 * Refusals throw {@link MigrateRefused}: a held lock past the timeout (naming
 * the holder and its plan id), a revalidation mismatch, a gate, a prompt.
 */
export async function migrateCommand(input: {
  readonly caller: MigrateCaller;
  readonly env: MigrateGateOptions["env"];
  readonly connection: MigrateGateOptions["connection"];
  /** The target under a runtime credential that cannot migrate (`rm_readonly` from `~/.env`, or smoke's). */
  readonly readerUrl: string;
  readonly nonInteractive: boolean;
  readonly localOwnerPassword?: string;
  /** Acquire the lock here, or prove the one the parent process holds. */
  readonly lock:
    | { readonly acquire: { readonly holder: Omit<LockHolder, "acquiredAt">; readonly timeoutMs: number } }
    | { readonly heldByParent: (reader: postgresTypes.Sql<{}>) => HeldTargetLock };
  readonly receiptPath: string;
  readonly seams?: MigrateRunSeams;
  readonly log: (message: string) => void;
}): Promise<{ readonly result: MigrateRunResult; readonly receipt: string }> {
  const startedAt = new Date();
  const target = redactedTarget(input.readerUrl);
  const reader = postgres(input.readerUrl, { max: 1, onnotice: () => {} });
  let owner: postgresTypes.Sql<{}> | null = null;
  let release: (() => Promise<void>) | null = null;
  try {
    let lock: HeldTargetLock;
    if ("acquire" in input.lock) {
      // 1–2. The plan, then the lock over a DIRECT connection (refusePoolerUrl
      // runs inside acquireTargetLock) and revalidation against the plan.
      const expected = await readTargetState(reader);
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
      lock = input.lock.heldByParent(reader);
    }
    await assertStillHeld(lock, "migrate: gates");
    input.log(`target ${target} under ${describeHolderText(lock.holder)}`);

    // 3. The gates, under the lock, before any password exists.
    const gateOptions: MigrateGateOptions = { caller: input.caller, env: input.env, connection: input.connection };
    const refusals = await checkMigrateGates(reader, gateOptions);
    if (refusals.length > 0) throw new MigrateRefused(refusals.map((r) => r.message).join("\n"));

    // 4–5. The owner credential for this one run, then the explicit y.
    input.log(`RM_ENV=${input.env ?? "(unset)"}, ${input.connection} target ${target}`);
    const password = await promptOwnerPassword(
      { ...gateOptions, nonInteractive: input.nonInteractive, localOwnerPassword: input.localOwnerPassword },
      input.readerUrl,
    ).catch((error: unknown) => {
      throw new MigrateRefused((error as Error).message);
    });
    await confirmRemoteTarget({ connection: input.connection, nonInteractive: input.nonInteractive }, target).catch(
      (error: unknown) => {
        throw new MigrateRefused((error as Error).message);
      },
    );
    owner = postgres(urlAsRole(input.readerUrl, "rm_owner", password), { max: 1, onnotice: () => {} });

    // 6. The run, as rm_owner, under the lock.
    const result = await runMigrate(owner, { ...gateOptions, lock, nonInteractive: input.nonInteractive }, input.seams);

    // 7. The receipt.
    const receipt = await writeMigrateReceipt(input.receiptPath, result, {
      caller: input.caller,
      env: input.env,
      target,
      startedAt,
      lock: describeHolderText(lock.holder),
    });
    return { result, receipt };
  } finally {
    await owner?.end({ timeout: 5 }).catch(() => undefined);
    await release?.().catch(() => undefined);
    await reader.end({ timeout: 5 }).catch(() => undefined);
  }
}
