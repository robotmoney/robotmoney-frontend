// VACUUM ANALYZE for a plan test (issue 1690), and a check that it worked.
//
// An index-only scan is costed, and runs, as one only where the visibility map
// marks the heap pages all-visible. The test cluster commits asynchronously
// (tests/preload.ts), and VACUUM does not mark a page all-visible while its
// rows' commit records may still be unflushed, so a VACUUM straight after a
// seed leaves the map empty and the plan test proves nothing. This flushes
// the WAL with one synchronous commit, waits a moment, then runs VACUUM
// ANALYZE as rm_owner (the tables' owner) on the file's own database. It
// returns the share of each table's pages the map covers (1 = all), which the
// caller asserts.
import postgres from "postgres";

export async function vacuumAnalyzeAsOwner(...tables: readonly string[]): Promise<{ table: string; allVisible: number }[]> {
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await db.unsafe("SET ROLE rm_owner");
    // The test cluster commits asynchronously (tests/preload.ts), and VACUUM
    // does not mark a page all-visible while its rows' commit records may be
    // unflushed. A synchronous commit flushes the WAL up to here, and the pause
    // lets the inserts' commits age past the vacuum's cutoff.
    await db.unsafe("SET synchronous_commit = on");
    await db.unsafe("SELECT txid_current()");
    await db.unsafe("SELECT pg_sleep(1)");
    for (const table of tables) await db.unsafe(`VACUUM ANALYZE ${table}`);
    const rows = await db<{ table: string; allVisible: number }[]>`
      SELECT relname AS table, CASE WHEN relpages = 0 THEN 1 ELSE relallvisible::float8 / relpages END AS "allVisible"
        FROM pg_class WHERE relname = ANY(${[...tables]}) ORDER BY 1`;
    return [...rows];
  } finally {
    await db.end({ timeout: 5 });
  }
}
