// Refuse to bootstrap seed data into a database that already has content.
//
// WHY THIS EXISTS. A `--external-pg` boot points the demo at a real managed
// server, and its migrate one-shot does not only migrate: it seeds job
// schedules, enqueues cold-start sampler jobs, backfills wallet samples and
// writes the allocation framework. Those run BEFORE anything validates that the
// target is a database this boot should be initializing at all. A boot aimed at
// a populated server therefore wrote ~77 rows into it before failing for an
// unrelated reason, and no teardown could take them back: demo:down and
// demo:clean only ever touch containers and volumes, of which an external boot
// has none.
//
// THE RULE. A populated remote is assumed to be production or production-alike
// (staging). We do not seed it, we do not migrate it, we abort. Emptiness is
// judged by the presence of BASE TABLEs in `public`, checked BEFORE the migrate
// step that would create them — so "empty" means a genuinely fresh database,
// not one this boot just built.
//
// Read-only by construction: it issues SELECTs against the catalog and nothing
// else. Exit 0 = safe to initialize, exit 1 = refuse.
//
// Usage: DATABASE_URL=... bun run scripts/db-preflight.ts
import { sql, closeDb } from "../src/db/client.ts";

/** Password-redacted target, the only form safe to print. */
function redactedTarget(raw: string | undefined): string {
  if (!raw) return "(DATABASE_URL unset)";
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

export interface TableCensus {
  table: string;
  rows: number;
}

/** The biggest tables by live-row estimate — enough to recognise WHAT this is. */
async function censusSample(limit = 8): Promise<TableCensus[]> {
  const rows = (await sql`
    SELECT relname AS table, n_live_tup AS rows
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY n_live_tup DESC, relname ASC
    LIMIT ${limit}
  `) as unknown as { table: string; rows: number }[];
  return rows.map((r) => ({ table: r.table, rows: Number(r.rows) }));
}

export async function main(): Promise<void> {
  const target = redactedTarget(process.env.DATABASE_URL);
  const [{ count }] = (await sql`
    SELECT count(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `) as unknown as { count: number }[];

  if (count === 0) {
    console.log(`[db-preflight] ${target}: empty (no tables in public) — safe to initialize`);
    return;
  }

  const sample = await censusSample();
  const populated = sample.filter((s) => s.rows > 0);

  console.error(
    `[db-preflight] REFUSING to bootstrap: ${target} already has ${count} table(s) in public.\n` +
      `[db-preflight] A populated remote database is assumed to be production or production-alike;\n` +
      `[db-preflight] this boot would have run migrations and seeded it. Nothing has been written.`,
  );
  if (populated.length > 0) {
    console.error(`[db-preflight] largest tables by row estimate:`);
    for (const s of populated) console.error(`[db-preflight]   ${s.table} ~${s.rows} rows`);
  } else {
    console.error(`[db-preflight] all ${count} table(s) are empty — schema present, no rows.`);
  }
  console.error(
    `[db-preflight] To initialize a fresh database, point --external-pg at an empty one.\n` +
      `[db-preflight] To run against this data, boot WITHOUT the seeding path.`,
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(closeDb)
    .catch((err) => {
      console.error(`[db-preflight] check failed: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return closeDb();
    });
}
