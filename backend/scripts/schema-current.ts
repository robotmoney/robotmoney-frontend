// Read-only comparison of backend/migrations/*.sql against schema_migrations.
//
// WHY THIS EXISTS. An operator's standalone question — "is every migration in
// this checkout recorded?" — answered read-only. `bun smoke` no longer runs it:
// every boot's full preflight asks the stronger form of the same question of
// any database (check 3a: does the schema match its manifest; 3b: does this code
// support the installed version), and a pending migration refuses there.
//
// READ-ONLY BY CONSTRUCTION — one registered query against
// schema_migrations, nothing else — so it runs as the ordinary runtime role
// (rm_app), the same credential every other `--db external` step already
// uses. No elevated privilege is needed to ASK whether the schema is current,
// only to fix it (that is what `bun run migrate` / `--migrate`, as rm_owner,
// are for).
//
// Exit 0: every migration file is recorded. Exit 1: one or more are not,
// named on stderr. Exit 2: schema_migrations does not exist at all — a
// database that has never been migrated once.
//
// Usage: DATABASE_URL=... bun run scripts/schema-current.ts
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, closeDb, type DbHandle } from "../src/db/client.ts";
import { on, registerQuery } from "../src/db/registry.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const readAppliedNames = registerQuery({
  role: "rm_app",
  object: "schema_migrations",
  privileges: ["SELECT"],
  site: "scripts/schema-current:readAppliedMigrations",
  purpose: "Read the ledger of applied migration filenames, so an operator can tell whether every file on disk is recorded.",
  callers: ["scripts/schema-current", "scripts/prod-bootstrap"],
  probe: { statement: "SELECT name FROM schema_migrations" },
});

/**
 * The applied migration filenames, or null when `schema_migrations` does not
 * exist. Absence is read from SQLSTATE 42P01 (undefined_table) alone: any other
 * error, permission and connection failures included, is thrown, never reported
 * as "never migrated" (which would send an operator to migrate a current database).
 */
export async function readAppliedMigrations(db: DbHandle = sql): Promise<Set<string> | null> {
  try {
    const rows = await on(db, readAppliedNames)<{ name: string }>`SELECT name FROM schema_migrations`;
    return new Set(rows.map((r) => r.name));
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
}

export interface SchemaCurrentResult {
  /** False when schema_migrations itself does not exist yet. */
  exists: boolean;
  /** Migration filenames present on disk but not recorded as applied. */
  pending: string[];
}

/** `dir` is overridable so a test can point this at a small fixture directory
 *  instead of the real backend/migrations/ — the schema_migrations comparison
 *  is what's under test, not the repo's actual migration list. */
export async function checkSchemaCurrent(dir: string = migrationsDir): Promise<SchemaCurrentResult> {
  const applied = await readAppliedMigrations();
  if (applied === null) return { exists: false, pending: [] };

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return { exists: true, pending: files.filter((f) => !applied.has(f)) };
}

export async function main(): Promise<void> {
  const result = await checkSchemaCurrent();
  if (!result.exists) {
    console.error("[schema-current] schema_migrations does not exist — this database has never been migrated.");
    process.exitCode = 2;
    return;
  }
  if (result.pending.length > 0) {
    console.error(`[schema-current] ${result.pending.length} migration(s) pending, not yet applied:`);
    for (const f of result.pending) console.error(`[schema-current]   ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("[schema-current] up to date — every migration file is recorded as applied.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(closeDb)
    .catch((err) => {
      console.error(`[schema-current] check failed: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return closeDb();
    });
}
