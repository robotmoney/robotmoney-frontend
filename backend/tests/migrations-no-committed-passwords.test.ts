// backend/migrations/0016_worker_role.sql documents the boundary this test
// pins: a role a migration creates ships WITHOUT a password, and an operator
// provisions login credentials out-of-band (CI's restricted-role tests do
// exactly that against the ephemeral Postgres — see
// analytics-worker-role.test.ts / database-role-taxonomy.test.ts). Nothing
// generates or threads a real secret into a migration file anywhere in this
// repo (checked against scripts/ and docker-compose.yml): the migration
// runner (src/db/migrate.ts) reads each file's bytes and runs them verbatim,
// with no env-var interpolation step, so a literal in the file IS the secret
// that ships.
//
// WHY THIS EXISTS. 0060_set_worker_password.sql once did exactly that —
// `ALTER ROLE rm_worker PASSWORD 'robotmoney'`, a hardcoded, well-known value,
// committed straight onto the release manifest. Nothing caught it because no
// test looked at migration CONTENTS, only at the roles/grants a migration
// leaves behind. This test reads every migration file and fails on a literal
// password, so the next one is caught before it reaches a manifest.
//
// Filesystem-only: no database, no docker, no network.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(testDir, "..", "migrations");

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Matches `ALTER ROLE <name> ... PASSWORD '<literal>'` (any role, any of the
// clause orderings Postgres accepts) — the shape that bakes a real credential
// into a versioned, world-readable file. A `current_setting(...)`-driven value
// or no PASSWORD clause at all does not match.
const HARDCODED_ROLE_PASSWORD = /ALTER\s+ROLE\s+\S+[^;]*PASSWORD\s+'[^']*'/is;

describe("migrations never commit a literal role password", () => {
  test("at least one migration exists to check (sanity)", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  test("no migration file contains ALTER ROLE ... PASSWORD '<literal>'", () => {
    // Strip `-- ...` line comments first — 0016_worker_role.sql's own header
    // SPELLS OUT the forbidden shape (`ALTER ROLE rm_worker PASSWORD '...'`)
    // as documentation of the boundary, which is exactly what this test must
    // not flag; only executable SQL counts as an offense.
    const stripComments = (sql: string) =>
      sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
    const offenders = migrationFiles
      .map((file) => ({ file, sql: stripComments(readFileSync(join(migrationsDir, file), "utf8")) }))
      .filter(({ sql }) => HARDCODED_ROLE_PASSWORD.test(sql))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
