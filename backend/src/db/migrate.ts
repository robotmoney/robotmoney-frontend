// Minimal forward-only migration runner. Applies every backend/migrations/*.sql
// in filename order exactly once, tracked in schema_migrations. Idempotent.
// It takes no target lock, fence, manifest or receipt, so it is for local dev,
// tests and ephemeral CI only. Production migrates through `bun run migrate`
// (scripts/migrate.ts, smoke-production-spec.md §8.5); prod-bootstrap no
// longer calls this runner.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type postgresTypes from "postgres";
import { sql, closeDb, setDatabase, jsonValue, type DbHandle } from "./client.ts";
import { buildVintageManifest } from "../analytics/run-ledger.ts";
import { resolveVintageMembers } from "../analytics/store/run-ledger-store.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

// Wait for a REAL accepting connection. `pg_isready` (and Docker healthchecks)
// report ready during the postgres image's init/temp-server phase, before the
// TCP server accepts client connections — so the first query can hit
// 57P03 ("the database system is starting up") or a connection refusal. Retry
// an actual `SELECT 1` until it succeeds (or we give up).
async function waitForDb(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, Math.min(1000, 100 * attempt)));
    }
  }
}

export async function migrate(): Promise<void> {
  // Deploy-time migrations have their own credential.  It is deliberately not
  // inherited from a long-lived API process.  Local/ephemeral environments
  // retain DATABASE_URL for bootstrap compatibility.
  if (process.env.MIGRATE_DATABASE_URL) await setDatabase(process.env.MIGRATE_DATABASE_URL, { purpose: "migration" });
  await waitForDb();
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
  );

  const appliedNow: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    await applyMigrationFile(sql, file);
    console.log(`migrated: ${file}`);
    appliedNow.push(file);
  }
  console.log(`migrations up to date (${files.length} total)`);
  await reclaimAfterMigrations(sql, appliedNow);
}

// migrate() MIGRATES, and nothing else. Seeding is a separate concern with its
// own tool (backend/src/db/seed.ts, run as `bun run src/db/seed.ts`) and its own
// callers — the test template (backend/tests/preload.ts) and the boot's seed
// step both invoke it explicitly. Keeping seed out of here is what makes
// `bun run migrate` a schema-only operation safe to run against production.

// Apply one migration file: its SQL, then any TypeScript step it needs, then
// its schema_migrations row — all in ONE transaction, so a failure anywhere
// leaves no trace of the file at all. Exported so a migration-replay test
// applies a file exactly as a deploy does, rather than a copy of this loop.
export async function applyMigrationFile(db: postgresTypes.Sql<{}>, file: string): Promise<void> {
  const ddl = await readFile(join(migrationsDir, file), "utf8");
  await db.begin(async (tx) => {
    // 0053 creates rm_owner and transfers existing objects.  Every later
    // migration runs as that non-login owner through a short-lived bootstrap
    // connection that has been granted SET ROLE capability.
    if (file >= "0054_rm_worker_allowlist.sql") await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe(ddl);
    await IN_TRANSACTION_AFTER_MIGRATION[file]?.(tx);
    await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
  });
}

// Issue #1050: recompute every stored vintage's manifest, series fingerprints,
// member_count and manifest_digest from the members it resolves to NOW.
//
// WHY. The ledger repair re-points every vintage to the source_value_versions rows
// the fixed ledger writer would have written (decision D56, amendment for
// #1050), so the digests frozen over the old writer's rows no longer describe
// their members. The owner's rule is that the database ends as if the old
// writer had never run — so each vintage gets exactly the manifest freezeVintage
// would have stored for these members, and the old digest is overwritten, not
// kept anywhere.
//
// Runs ONLY from the one-time ledger repair
// (scripts/upgrades/0.5.1-to-0.5.2/ledger-repair.ts), inside its transaction, as
// rm_owner. A
// canonical-JSON SHA-256 in plpgsql would have to reproduce JavaScript's number
// formatting byte for byte; this reuses buildVintageManifest instead, the one
// function every freeze and every replay already uses. analytics_data_vintages
// is immutable, so its guard is disarmed for these UPDATEs and re-armed (ENABLE
// ALWAYS) before returning; an error rolls the whole migration back with it.
//
// IT LIVES HERE, NOT IN THE STORE (#1026 W6). analytics_data_vintages is
// immutable: a statement trigger refuses even a zero-row UPDATE, so no
// registered call site could carry a probe for this UPDATE, and the registry
// forbids raw SQL outside the db layer's infrastructure files. This is a
// migration step, run by the migration runner alone as rm_owner. Membership is
// resolved through the store's registered read (resolveVintageMembers), the one
// function every replay uses; only the vintage list, the guard toggling and the
// UPDATE are issued here.
export async function rebuildVintageManifests(db: DbHandle): Promise<{ vintages: number; rewritten: number }> {
  const vintages = (await db`
    SELECT id::text AS id, knowledge_time_cutoff::text AS knowledge_time_cutoff,
           market_time_cutoff::text AS market_time_cutoff, methodology_version_id::text AS methodology_version_id,
           build_identity, manifest_digest, member_count
    FROM analytics_data_vintages ORDER BY id`) as unknown as {
    id: string;
    knowledge_time_cutoff: string;
    market_time_cutoff: string;
    methodology_version_id: string;
    build_identity: string;
    manifest_digest: string;
    member_count: number;
  }[];
  if (vintages.length === 0) return { vintages: 0, rewritten: 0 };
  await db.unsafe("ALTER TABLE analytics_data_vintages DISABLE TRIGGER analytics_data_vintages_immutable");
  await db.unsafe("ALTER TABLE analytics_data_vintages DISABLE TRIGGER analytics_data_vintages_immutable_row");
  let rewritten = 0;
  for (const v of vintages) {
    const members = await resolveVintageMembers(v.id, db);
    const { manifest } = buildVintageManifest(
      members, v.methodology_version_id, v.build_identity, v.knowledge_time_cutoff, v.market_time_cutoff,
    );
    if (manifest.manifestDigest === v.manifest_digest && members.length === Number(v.member_count)) continue;
    await db`
      UPDATE analytics_data_vintages
      SET manifest = ${db.json(jsonValue(manifest))}, manifest_digest = ${manifest.manifestDigest},
          member_count = ${members.length}
      WHERE id = ${v.id}::bigint`;
    rewritten++;
  }
  await db.unsafe("ALTER TABLE analytics_data_vintages ENABLE ALWAYS TRIGGER analytics_data_vintages_immutable");
  await db.unsafe("ALTER TABLE analytics_data_vintages ENABLE ALWAYS TRIGGER analytics_data_vintages_immutable_row");
  return { vintages: vintages.length, rewritten };
}

// Work a migration needs that SQL cannot do well, run by the runner right
// after that file's SQL, INSIDE the same transaction and as the same role
// (rm_owner). It runs once, only in the run that applies the file, and a throw
// rolls the file back with it. Keep this list short: each entry is a step a
// reader of the .sql file cannot see there, so the file must say it exists.
// Empty today: 0080's ledger repair, the one step that used it, is a one-time
// script (scripts/upgrades/0.5.1-to-0.5.2/ledger-repair.ts), not a migration.
export const IN_TRANSACTION_AFTER_MIGRATION: Readonly<Record<string, (tx: postgresTypes.TransactionSql<{}>) => Promise<unknown>>> = {};

// Tables a migration rewrote heavily enough that its DELETEs left most of the
// table as dead tuples. A DELETE frees nothing on disk: the space is only
// reused by later inserts, so a compaction migration alone leaves the database
// exactly as large as before. VACUUM FULL rewrites each table and its indexes
// compactly and returns the space to the operating system.
//
// It cannot run inside the migration (VACUUM refuses a transaction block, and
// every migration is one), so the runner does it, right after the migration
// commits — once, ONLY in the run that applied that migration, never on an
// ordinary boot. It runs as rm_owner on the migration connection, because only
// a table's owner may VACUUM FULL it; no grant changes.
//
// Each table is held under ACCESS EXCLUSIVE for the length of its own rewrite,
// which is proportional to its LIVE rows.
//
// Empty today: the ledger repair (issue #1035) rebuilds its tables with
// TRUNCATE and re-insert, which returns the space at commit with no VACUUM.
export const RECLAIM_AFTER_MIGRATION: Readonly<Record<string, readonly string[]>> = {};

export async function reclaimAfterMigrations(db: postgresTypes.Sql<{}>, appliedNow: readonly string[]): Promise<void> {
  const tables = appliedNow.flatMap((file) => RECLAIM_AFTER_MIGRATION[file] ?? []);
  if (tables.length === 0) return;
  const conn = await db.reserve();
  try {
    await conn.unsafe("SET ROLE rm_owner");
    for (const table of tables) {
      const started = Date.now();
      await conn.unsafe(`VACUUM (FULL, ANALYZE) public.${table}`);
      console.log(`reclaimed: ${table} (VACUUM FULL, ${Date.now() - started}ms)`);
    }
  } finally {
    await conn.unsafe("RESET ROLE").catch(() => {});
    conn.release();
  }
}

// Run directly: `bun run src/db/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(closeDb)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
