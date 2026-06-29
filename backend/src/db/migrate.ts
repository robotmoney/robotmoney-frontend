// Minimal forward-only migration runner. Applies every backend/migrations/*.sql
// in filename order exactly once, tracked in schema_migrations. Idempotent:
// safe to run on every boot (ephemeral CI, demo, or prod).
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, closeDb } from "./client.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export async function migrate(): Promise<void> {
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
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`migrated: ${file}`);
  }
  console.log(`migrations up to date (${files.length} total)`);
}

// Run directly: `node src/db/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(closeDb)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
