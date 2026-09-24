// Minimal forward-only migration runner. Applies every backend/migrations/*.sql
// in filename order exactly once, tracked in schema_migrations. Idempotent:
// safe to run on every boot (ephemeral CI, smoke, or prod).
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, closeDb, setDatabase } from "./client.ts";

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

  for (const file of files) {
    if (applied.has(file)) continue;
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      // 0053 creates rm_owner and transfers existing objects.  Every later
      // migration runs as that non-login owner through a short-lived bootstrap
      // connection that has been granted SET ROLE capability.
      if (file >= "0054_rm_worker_allowlist.sql") await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`migrated: ${file}`);
  }
  console.log(`migrations up to date (${files.length} total)`);
}

// migrate() MIGRATES, and nothing else. Seeding is a separate concern with its
// own tool (backend/src/db/seed.ts, run as `bun run src/db/seed.ts`) and its own
// callers — the test template (backend/tests/preload.ts) and the boot's seed
// step both invoke it explicitly. Keeping seed out of here is what makes
// `bun run migrate` a schema-only operation safe to run against production.

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
