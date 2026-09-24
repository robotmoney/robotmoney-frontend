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
export async function loadSnapshot(dir?: string): Promise<Snapshot> {
  const base = dir ?? BACKEND_ROOT;

  const [declarationSql, bootstrapDataSql, grantsSql, metadataText] = await Promise.all([
    readPart(base, "declaration"),
    readPart(base, "bootstrapData"),
    readPart(base, "grants"),
    readPart(base, "metadata"),
  ]);

  const metadata = parseMetadata(metadataText);
  const declaration = { text: declarationSql };

  // The hash first, because it is the claim that the other three parts and the
  // list belong together. A list that fails the disk cross-check below is a
  // half-committed change (§8.2); a list whose hash does not verify is a file
  // somebody edited, and the two want different sentences.
  const expected = hashManifest(declaration, metadata.filenames);
  if (metadata.contentHash !== expected) {
    throw new Error(
      `${SNAPSHOT_FILES.metadata}: content hash ${metadata.contentHash} does not verify against the declaration ` +
        `and the filename list (expected ${expected})`,
    );
  }

  await assertFilenamesMatchMigrations(metadata.filenames);

  return {
    declarationSql,
    bootstrapDataSql,
    grantsSql,
    filenames: metadata.filenames,
    manifest: {
      formatVersion: metadata.formatVersion,
      declaration,
      filenames: metadata.filenames,
      contentHash: metadata.contentHash,
    },
  };
}

/** `backend/`, the root `SNAPSHOT_FILES` paths are relative to. */
const BACKEND_ROOT = join(import.meta.dir, "..", "..");

/** `backend/migrations/` — the snapshot's identity is cross-checked against it
 *  whatever directory the snapshot itself was loaded from, because a fixture
 *  snapshot still embodies THIS repo's migrations. */
const MIGRATIONS_DIR = join(BACKEND_ROOT, "migrations");

/**
 * Read one part, trailing whitespace stripped.
 *
 * The trim is not cosmetic: the hash is over the declaration's bytes, and an
 * editor that adds or removes a final newline would otherwise turn a correct
 * snapshot into a refusal. Normalising at the one place that reads the files
 * means the stored digest describes content rather than file endings.
 */
async function readPart(base: string, key: keyof typeof SNAPSHOT_FILES): Promise<string> {
  const path = join(base, SNAPSHOT_FILES[key]);
  try {
    return (await readFile(path, "utf8")).replace(/\s+$/, "");
  } catch (error) {
    throw new Error(
      `snapshot is missing or unreadable: ${SNAPSHOT_FILES[key]} (${path}) — ${(error as Error).message}`,
    );
  }
}

interface SnapshotMetadata {
  readonly formatVersion: number;
  readonly filenames: readonly string[];
  readonly contentHash: string;
}

function parseMetadata(text: string): SnapshotMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${SNAPSHOT_FILES.metadata} is not valid JSON — ${(error as Error).message}`);
  }
  const record = parsed as Partial<SnapshotMetadata>;
  if (
    typeof record?.formatVersion !== "number" ||
    !Array.isArray(record.filenames) ||
    typeof record.contentHash !== "string"
  ) {
    throw new Error(
      `${SNAPSHOT_FILES.metadata} must carry formatVersion, filenames and contentHash — spec §8.1`,
    );
  }
  return { formatVersion: record.formatVersion, filenames: record.filenames, contentHash: record.contentHash };
}

/**
 * The snapshot and the migrations land together (§8.2), so a disagreement in
 * either direction means one half of a change was committed. Both directions
 * are reported, because "you added a migration and forgot the snapshot" and
 * "your snapshot names a migration that is not here" send the reader to
 * different files.
 */
async function assertFilenamesMatchMigrations(filenames: readonly string[]): Promise<void> {
  const onDisk = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const named = new Set(filenames);
  const present = new Set(onDisk);

  const missingFromDisk = filenames.filter((name) => !present.has(name));
  if (missingFromDisk.length > 0) {
    throw new Error(
      `${SNAPSHOT_FILES.metadata} names ${missingFromDisk.length} migration(s) that are not in backend/migrations/: ` +
        missingFromDisk.join(", "),
    );
  }

  const missingFromList = onDisk.filter((name) => !named.has(name));
  if (missingFromList.length > 0) {
    throw new Error(
      `backend/migrations/ holds ${missingFromList.length} migration(s) the snapshot does not name — ` +
        `every migration lands with the matching snapshot change (§8.2): ${missingFromList.join(", ")}`,
    );
  }
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
export async function bootstrapBlankDatabase(db: SnapshotDb, snapshot: Snapshot): Promise<BootstrapResult> {
  // ORDER MATTERS, and it is the order of how wrong each answer is.
  //
  // A `production` row means the target is not the one the operator thinks it
  // is, and that is worth saying before anything else — including before "this
  // database is not blank", which it also is. Emptiness comes next, because the
  // declaration must never meet a populated database. The role check is last:
  // it is the one that is merely a misconfiguration of THIS run rather than a
  // statement about which database was reached.
  const identity = await readDeploymentIdentity(db);
  if (identity === "production") {
    throw new Error(
      "refusing to bootstrap: deployment_identity already says production — a blank bootstrap writes " +
        "rehearsal (§4.2) and §4.3 refuses every prod + --local combination anyway",
    );
  }

  if (!(await isBlank(db))) {
    throw new Error(
      "refusing to bootstrap: the database is not blank (it holds BASE TABLEs in public) — the schema " +
        "declaration is never applied to a populated database (§8.1)",
    );
  }

  const role = await effectiveRole(db);
  if (role !== "rm_owner") {
    throw new Error(
      `refusing to bootstrap: the effective role is ${role}, not rm_owner — the declaration creates the ` +
        "objects rm_owner must own and §8.3 restricts the manifest write to it",
    );
  }

  // ONE transaction. A half-bootstrapped database looks exactly like §8.3's
  // in-progress state while being unrecoverable by the resume path, which
  // reasons about committed migrations — and a bootstrap has none.
  const baselined = await inTransaction(db, async (tx) => {
    await tx.unsafe(snapshot.declarationSql);
    await tx.unsafe(snapshot.bootstrapDataSql);
    // Both parts are pg_dump output and open with
    // `set_config('search_path', '', false)`, a SESSION setting. Every statement
    // after them in this function names its tables unqualified, so the empty
    // path would fail the first one ("no schema has been selected to create
    // in") and would outlive the bootstrap on the caller's connection.
    await tx.unsafe("RESET search_path");
    await tx.unsafe(snapshot.grantsSql);

    // AFTER the grants sweep, never before: the manifest is a trusted input to
    // boot decisions and only rm_owner may write it (§8.3), so it must not be
    // in the set of relations reconciliation hands the runtime roles.
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (
        format_version integer NOT NULL,
        declaration    text    NOT NULL,
        filenames      text[]  NOT NULL,
        content_hash   text    NOT NULL,
        singleton      boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton)
      )`);

    // The ledger first, then the manifest: writeManifest refuses a filename
    // list that does not equal the ledger recorded in this same transaction.
    const written = await baselineLedger(tx, snapshot.filenames);
    await writeDeploymentIdentity(tx, "rehearsal");
    await writeManifest(tx, snapshot.manifest);
    return written;
  });

  return { baselined, manifest: snapshot.manifest };
}

/** Run `body` in one transaction, or inline when the handle already is one —
 *  `bootstrapBlankDatabase` may be called from inside the migrate run's fence
 *  (§2), and a nested `begin` would be a savepoint, not the atomicity this
 *  needs. */
async function inTransaction<T>(db: SnapshotDb, body: (tx: SnapshotDb) => Promise<T>): Promise<T> {
  const pool = db as postgresTypes.Sql<{}>;
  if (typeof pool.begin !== "function") return body(db);
  return (await pool.begin(async (tx) => body(tx as unknown as SnapshotDb))) as T;
}

/**
 * Emptiness: any BASE TABLE in `public`, the same question
 * backend/scripts/db-preflight.ts asks — but asked of `pg_class`, not of
 * `information_schema.tables`.
 *
 * THE VIEW WOULD FAIL OPEN HERE. `information_schema` is privilege-filtered by
 * definition: it shows a role only the objects it has some privilege on. The
 * role running this holds no grants on a database it did not build, so a
 * populated database reads back as EMPTY and the declaration — "never applied
 * to a populated database" (§8.1) — gets applied to one. `pg_class` is the
 * catalog itself and answers the question that was asked.
 *
 * `relkind IN ('r', 'p')` is `information_schema`'s own definition of
 * BASE TABLE (ordinary and partitioned), so the two still agree on the answer
 * whenever the view can see it.
 */
async function isBlank(db: SnapshotDb): Promise<boolean> {
  const [row] = (await db`
    SELECT COUNT(*)::int AS count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`) as unknown as { count: number }[];
  return (row?.count ?? 0) === 0;
}

async function effectiveRole(db: SnapshotDb): Promise<string> {
  const [row] = (await db`SELECT current_user AS role`) as unknown as { role: string }[];
  return row?.role ?? "";
}

/**
 * The one-row enrollment's value, or `null` when the table or the row is absent.
 *
 * The column is resolved from the catalog rather than assumed: migration 0063
 * spells it `kind` and the snapshot fixtures spell it `identity`, and a
 * bootstrap that hard-coded either would refuse to read the other — which for
 * the `production` check means failing open on the shape it did not expect.
 */
async function identityColumn(db: SnapshotDb): Promise<string | null> {
  const [present] = (await db`
    SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present`) as unknown as { present: boolean }[];
  if (present?.present !== true) return null;

  // `pg_attribute`, not `information_schema.columns`, for the reason isBlank()
  // gives: the view is privilege-filtered and this role may hold no grant on
  // the table at all, which would read back as "no such column" and skip the
  // `production` refusal entirely — failing open on the one check that says
  // the operator reached the wrong database.
  const columns = (await db`
    SELECT a.attname AS column_name
    FROM pg_attribute a
    WHERE a.attrelid = 'public.deployment_identity'::regclass AND a.attnum > 0 AND NOT a.attisdropped`) as unknown as {
    column_name: string;
  }[];
  const names = new Set(columns.map((c) => c.column_name));
  if (names.has("kind")) return "kind";
  if (names.has("identity")) return "identity";
  return null;
}

async function readDeploymentIdentity(db: SnapshotDb): Promise<string | null> {
  const column = await identityColumn(db);
  if (!column) return null;
  try {
    const [row] = (await db.unsafe(
      `SELECT ${column} AS value FROM deployment_identity LIMIT 1`,
    )) as unknown as { value: string }[];
    return row?.value ?? null;
  } catch (error) {
    // The enrollment table EXISTS and this role cannot read it. That is not the
    // same as "no enrollment", and it must not be treated as one: absence of
    // evidence is not evidence of rehearsal (§4.3 refuses a missing row for the
    // same reason). Refuse rather than proceed unable to rule out `production`.
    throw new Error(
      `refusing to bootstrap: deployment_identity exists but could not be read, so a production enrollment ` +
        `cannot be ruled out — ${(error as Error).message}`,
    );
  }
}

async function writeDeploymentIdentity(db: SnapshotDb, value: "rehearsal"): Promise<void> {
  const column = await identityColumn(db);
  if (!column) {
    throw new Error(
      "the snapshot declaration created no deployment_identity table — §4.2 requires the enrollment row a " +
        "blank bootstrap writes as rehearsal",
    );
  }
  await db.unsafe(`INSERT INTO deployment_identity (${column}) VALUES ('${value}')`);
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
export async function baselineLedger(db: SnapshotDb, filenames: readonly string[]): Promise<readonly string[]> {
  const [existing] = (await db`
    SELECT COUNT(*)::int AS count FROM schema_migrations`) as unknown as { count: number }[];
  if ((existing?.count ?? 0) > 0) {
    throw new Error(
      `refusing to baseline: schema_migrations already holds ${existing?.count} rows — baselining a database ` +
        "that has history is the one way to make the ledger claim a migration ran when it did not",
    );
  }

  const onDisk = new Set((await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")));
  const unknown = filenames.filter((name) => !onDisk.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `refusing to baseline: ${unknown.length} name(s) are not files in backend/migrations/: ${unknown.join(", ")}`,
    );
  }

  for (const name of filenames) {
    await db`INSERT INTO schema_migrations (name) VALUES (${name})`;
  }
  return filenames;
}
