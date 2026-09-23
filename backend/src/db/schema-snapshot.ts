// The snapshot — the hand-maintained canonical description of the schema, and
// the only way a blank database becomes a working one without replaying five
// years of migrations.
//
// STUB. Every function throws `NOT IMPLEMENTED`; nothing imports this module
// yet. Step 1 of issue #1026's W2 workstream. Governed by
// smoke-production-spec.md §8.1, with §5's `--local blank` as its caller and
// §8.3's manifest as its output.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THREE PARTS AND NOT ONE FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §8.1 splits the snapshot because the three parts have three different
// application rules, and a single file would have to obey the strictest of them
// everywhere:
//
//   * SCHEMA DECLARATION — "Canonical description and blank-database bootstrap.
//     Never applied to a populated database." It creates objects. Running it
//     against a database that already has them is either an error or, worse,
//     a partial success.
//   * BOOTSTRAP DATA — "the operational rows the application needs to run
//     (singletons, seed schedules). Distinct from `--seed` demo data." This is
//     the distinction backend/scripts/db-preflight.ts already documents from
//     the other side: demo fixtures overwrite by design (`ON CONFLICT DO
//     UPDATE`), so they may only touch an empty database. Bootstrap rows are
//     not demo data and must not travel with it.
//   * ROLES AND GRANTS — "idempotent grant reconciliation for objects
//     `rm_owner` owns. Applied only inside the migrate step, against the
//     snapshot's own version. Role creation is not part of it." This one runs
//     on EVERY migrate run (§8.3: "always, even with nothing pending"),
//     populated or not, which is the opposite of the declaration's rule.
//
// Role CREATION is excluded on purpose: creating a role needs `CREATEROLE`,
// spec §3 says "`rm_owner` never holds `CREATEROLE`", and §3 reserves role
// creation for `doadmin` as cluster provisioning. A grants file that also
// created roles could never be applied by the role that runs the migrate step.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS AN EXCLUSION LIST
// ─────────────────────────────────────────────────────────────────────────────
//
// The snapshot is the comparison target for preflight check 3a, and a managed
// Postgres is not an empty canvas. DigitalOcean's cluster carries objects
// nobody in this repo created and nobody here may drop: the `doadmin` role's
// artefacts, provider monitoring schemas, extensions installed by the platform.
// 0053 already had to learn this the hard way in both of its loops — it skips
// anything with a `pg_depend` extension dependency, because "re-owning an
// extension's function fails with 'must be owner of function digest' for a
// non-superuser -- and is wrong even when a superuser is permitted to do it".
//
// Check 3a compares "live definitions of every object class in §8.1 ... to the
// manifest for M ... excluding the provider list". Without that exclusion every
// production boot fails check 3a on objects that are correct.
//
// The exclusion list is therefore load-bearing in the dangerous direction: an
// entry too many is a blind spot in the drift check. It is a list of specific
// names and extension memberships, never a pattern that could swallow an
// application object by accident.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type postgresTypes from "postgres";
import { MANIFEST_TABLE, hashManifest, writeManifest, type SchemaManifest } from "./schema-manifest.ts";

export type SnapshotDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/**
 * The snapshot's files, relative to `backend/`. Exactly the three parts of
 * spec §8.1 plus the metadata that makes them an identity.
 *
 * These names are real, not placeholders: they are the paths W2.5 creates.
 */
export const SNAPSHOT_FILES = {
  /** §8.1 schema declaration — tables, constraints, indexes, functions,
   *  triggers, policies, ownership, default privileges. */
  declaration: "schema/snapshot.sql",
  /** §8.1 bootstrap data — operational singletons and the seed `job_schedules`
   *  rows. Never demo data. */
  bootstrapData: "schema/bootstrap-data.sql",
  /** §8.1 roles and grants — idempotent reconciliation only, no role creation
   *  (spec §3: `rm_owner` never holds `CREATEROLE`). */
  grants: "schema/grants.sql",
  /** The filename list, format version and hash that turn the three files above
   *  into a version. Written into `schema_manifest` verbatim at bootstrap. */
  metadata: "schema/snapshot.json",
} as const;

/**
 * Objects preflight check 3a must not compare, because this repo does not own
 * them and cannot make them match.
 *
 * Two shapes, both narrow on purpose (see the module header):
 *   - `roles`: cluster roles that exist outside the §3 taxonomy.
 *   - `extensions`: anything owned by these extensions, resolved through
 *     `pg_depend` with `deptype = 'e'` — the identical test 0053's two
 *     ownership loops already use, and for the identical reason.
 *
 * NOT a schema or table pattern. A pattern here would silently exempt an
 * application table the day someone names one badly.
 */
export const PROVIDER_MANAGED_EXCLUSIONS = {
  roles: ["doadmin", "postgres"],
  extensions: ["pgcrypto", "plpgsql"],
} as const;

/** The snapshot as loaded from disk. */
export interface Snapshot {
  /** Contents of `SNAPSHOT_FILES.declaration`. */
  readonly declarationSql: string;
  /** Contents of `SNAPSHOT_FILES.bootstrapData`. */
  readonly bootstrapDataSql: string;
  /** Contents of `SNAPSHOT_FILES.grants`. */
  readonly grantsSql: string;
  /**
   * The exact migration filenames this snapshot embodies — the snapshot's
   * identity, and the ledger rows `bootstrapBlankDatabase` baselines.
   *
   * Filenames, never a high-water number. `backend/migrations/` holds TWO files
   * numbered 0059 — `0059_analytics_output_and_report_snapshots.sql` and
   * `0059_swarm_framework_subject_snapshot_cleanup.sql` — so "up to 0059" names
   * two different schemas and cannot baseline anything. Spec §8.1: "a number
   * alone is not an identity".
   */
  readonly filenames: readonly string[];
  /** The manifest this snapshot publishes at bootstrap, already hashed. */
  readonly manifest: SchemaManifest;
}

/**
 * Load and validate the three parts plus their metadata.
 *
 * Input: the directory holding them (defaulting to `backend/schema/`), so a
 * test can point at a fixture instead of the repo's real snapshot — the same
 * affordance `checkSchemaCurrent(dir)` in backend/scripts/schema-current.ts
 * already provides for the migrations directory.
 *
 * Output: a `Snapshot`.
 *
 * Refusals:
 *   - Any of the four files missing or unreadable.
 *   - `manifest.contentHash` does not verify against the declaration and the
 *     filename list.
 *   - A filename in the list is absent from `backend/migrations/`, or a
 *     migration file is present that the list does not name. The snapshot and
 *     the migrations land together — spec §8.2: "Every migration lands with the
 *     matching snapshot change" — so a disagreement means one half of a change
 *     was committed.
 *
 * Serves spec §10 W2 "Snapshot bootstrap then `--migrate`".
 */
export function loadSnapshot(dir?: string): Promise<Snapshot> {
  void dir;
  throw new Error("NOT IMPLEMENTED: load and validate the three snapshot parts — spec §8.1, issue #1026 W2.5");
}

/** What `bootstrapBlankDatabase` committed, for the journal and the receipt. */
export interface BootstrapResult {
  /** Ledger rows written by `baselineLedger` — the snapshot's filename list. */
  readonly baselined: readonly string[];
  /** The manifest published, hash included. */
  readonly manifest: SchemaManifest;
}

/**
 * Bring an empty database to the snapshot's version: declaration, bootstrap
 * data, grants, baselined ledger, published manifest, and
 * `deployment_identity = rehearsal`.
 *
 * Input: a handle connected as `rm_owner` (it creates objects and writes the
 * manifest, and §8.3 restricts both). Output: a `BootstrapResult`.
 *
 * Runs as ONE transaction. A half-bootstrapped database is indistinguishable
 * from the in-progress state of §8.3 while being unrecoverable by the resume
 * path, since resume reasons about committed migrations and a bootstrap has
 * none.
 *
 * Refusals:
 *   - The database is not blank — any BASE TABLE in `public`. Spec §8.1: the
 *     declaration is "Never applied to a populated database." The emptiness
 *     test is the one backend/scripts/db-preflight.ts already uses
 *     (`information_schema.tables`, `table_type = 'BASE TABLE'`), so the two
 *     agree on what "empty" means.
 *   - The effective role is not `rm_owner`.
 *   - `deployment_identity` already says `production`. Spec §4.2 writes
 *     `rehearsal` on "every `--local blank` bootstrap"; meeting a production
 *     row here means the target is not the one the operator thinks it is, and
 *     §4.3 refuses every `prod` + `--local` combination anyway.
 *
 * Note it does NOT seed. Spec §5: `--seed` "is explicit, refuses a populated
 * database, requires `rehearsal`, and is never implied by any mode" — and spec
 * §10 W2 requires that a snapshot-bootstrapped database boot and pass preflight
 * WITHOUT `--seed`, which is only meaningful if bootstrap never calls it.
 *
 * Serves spec §10 W2 "Snapshot bootstrap then `--migrate`; snapshot bootstrap
 * boots without `--seed`" and "Unattended CI boot `--local blank --migrate
 * --seed`."
 */
export function bootstrapBlankDatabase(db: SnapshotDb, snapshot: Snapshot): Promise<BootstrapResult> {
  void db;
  void snapshot;
  throw new Error("NOT IMPLEMENTED: bootstrap a blank database from the snapshot — spec §8.1, issue #1026 W2.5");
}

/**
 * Write one `schema_migrations` row per filename in the snapshot's list, so the
 * migrate runner treats them as already applied.
 *
 * Input: the handle (the bootstrap transaction) and the filename list. Output:
 * the names written.
 *
 * WHY THIS IS NOT OPTIONAL. Spec §8.2: "Blank bootstrap writes ledger rows for
 * the snapshot's filename list, so `--migrate` never replays history." Replay
 * is not merely slow here, it is destructive: the declaration already created
 * every object those migrations create, so re-applying them would fail — and
 * 0053 in particular re-runs ownership sweeps and `REVOKE ALL` statements
 * against a database that has already been reconciled.
 *
 * It must run inside the same transaction as the declaration. `schema_migrations`
 * is itself an append-only table (it is in `APPEND_ONLY_TABLES` in
 * ./append-only-guard.ts), so rows written here cannot be deleted afterwards —
 * a baseline committed beside a declaration that then rolled back would be
 * permanent and wrong.
 *
 * Refusals:
 *   - `schema_migrations` already holds rows. Baselining a database that has
 *     history is the one way to make the ledger claim a migration ran when it
 *     did not.
 *   - A name is not a file in `backend/migrations/`.
 *
 * Serves spec §10 W2 "blank + all migrations = snapshot" (§8.4's CI proof) and
 * "Snapshot bootstrap then `--migrate`".
 */
export function baselineLedger(db: SnapshotDb, filenames: readonly string[]): Promise<readonly string[]> {
  void db;
  void filenames;
  throw new Error("NOT IMPLEMENTED: baseline the ledger to the snapshot's filename list — spec §8.2, issue #1026 W2.5");
}
