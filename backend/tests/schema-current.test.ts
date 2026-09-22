// Unit tests for scripts/schema-current.ts — the read-only check that lets an
// `--db external` boot without `--migrate` refuse a stale schema instead of
// warning and serving it anyway (scripts/lib/smoke-external-migrate.ts's
// refuseIfSchemaBehind()).
//
// The disk-side comparison is exercised against a temp fixture directory, not
// backend/migrations/ itself: writing extra .sql files into the real,
// repo-shared migrations directory while the suite runs concurrent migrate()
// calls elsewhere would be exactly the shared-mutable-state hazard
// tests/support/clean-db.ts exists to avoid. checkSchemaCurrent()'s `dir`
// parameter exists for this reason.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCleanDatabase } from "./support/clean-db.ts";
import { checkSchemaCurrent } from "../scripts/schema-current.ts";
import { sql } from "../src/db/client.ts";

useCleanDatabase(import.meta.file);

function fixtureDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-schema-current-"));
  for (const name of names) writeFileSync(join(dir, name), "-- fixture, never executed\n");
  return dir;
}

describe("checkSchemaCurrent", () => {
  test("every real migration file, read from disk, is reported current", async () => {
    // The real backend/migrations/ list, exercised read-only — the one case
    // this test does NOT need a fixture directory for, since it never writes
    // into it.
    const result = await checkSchemaCurrent();
    expect(result.exists).toBe(true);
    expect(result.pending).toEqual([]);
  });

  test("a file on disk that schema_migrations already recorded is not pending", async () => {
    const [{ name }] = (await sql<{ name: string }[]>`
      SELECT name FROM schema_migrations ORDER BY name LIMIT 1
    `);
    const dir = fixtureDir([name]);
    try {
      const result = await checkSchemaCurrent(dir);
      expect(result.exists).toBe(true);
      expect(result.pending).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file on disk that schema_migrations never recorded is pending, named", async () => {
    const [{ name }] = (await sql<{ name: string }[]>`
      SELECT name FROM schema_migrations ORDER BY name LIMIT 1
    `);
    const dir = fixtureDir([name, "9999_never_applied.sql"]);
    try {
      const result = await checkSchemaCurrent(dir);
      expect(result.exists).toBe(true);
      expect(result.pending).toEqual(["9999_never_applied.sql"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a database with no schema_migrations table at all is reported as never migrated", async () => {
    // DDL, not the DML the append-only guard's triggers intercept (0032's own
    // header: the guard makes UPDATE/DDL DETECTABLE elsewhere, not blocked
    // here) — and this file's clone is dropped after it finishes regardless.
    await sql`DROP TABLE schema_migrations`;
    const result = await checkSchemaCurrent();
    expect(result.exists).toBe(false);
    expect(result.pending).toEqual([]);
  });
});
