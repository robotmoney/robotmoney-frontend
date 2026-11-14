// Issue 1182, folded-in issue 1049: a post-migration reclaim (VACUUM FULL,
// RECLAIM_AFTER_MIGRATION in src/db/migrate.ts) that fails must not stop the
// run. The migration has committed; migrate() reports the exact command that
// finishes the reclaim by hand, carries on with the next table, and returns,
// so the boot's next step, seed(), still runs.
import { expect, spyOn, test } from "bun:test";
import { setDatabase, sql } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { seed } from "../src/db/seed.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { harnessUrl } from "./support/cluster.ts";

useCleanDatabase(import.meta.file, { migrationBuilt: true });

// Idempotent (IF NOT EXISTS / OR REPLACE on every object), so it can be applied a second time.
const FILE = "0130_jobs_live_index_brief_allocation_stats.sql";
const MISSING = "no_such_table_issue_1049";

test("a reclaim that fails is reported with its manual command, the next table is still reclaimed, and seed() runs after migrate()", async () => {
  // schema_migrations refuses DELETE: the record is renamed, so the file is pending again.
  await fixtureDb`UPDATE schema_migrations SET name = ${`${FILE} (issue 1049 test)`} WHERE name = ${FILE}`;
  const errors: string[] = [];
  const logs: string[] = [];
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
  const runtimeUrl = process.env.DATABASE_URL!;
  process.env.MIGRATE_DATABASE_URL = harnessUrl(new URL(runtimeUrl).pathname.replace(/^\//, ""));
  try {
    // The reclaim list a migration would carry: a table whose VACUUM FULL fails, then a real one.
    await migrate({ reclaim: { [FILE]: [MISSING, "job_schedules"] } });
    // The boot's next step, on the same migration connection.
    await seed();
  } finally {
    delete process.env.MIGRATE_DATABASE_URL;
    errorSpy.mockRestore();
    logSpy.mockRestore();
    await setDatabase(runtimeUrl);
  }

  expect(logs).toContain(`migrated: ${FILE}`);
  const failure = errors.filter((e) => e.startsWith(`reclaim FAILED: ${MISSING}`));
  expect(failure).toHaveLength(1);
  expect(failure[0]).toContain(`SET ROLE rm_owner; VACUUM (FULL, ANALYZE) public.${MISSING};`);
  expect(logs.some((l) => l.startsWith("reclaimed: job_schedules (VACUUM FULL"))).toBe(true);
  expect(logs.some((l) => l.startsWith("seeded job_schedules"))).toBe(true);

  const [recorded] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM schema_migrations WHERE name = ${FILE}`;
  expect(recorded!.n).toBe(1);
  const [schedules] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM job_schedules`;
  expect(schedules!.n).toBeGreaterThan(0);
});
