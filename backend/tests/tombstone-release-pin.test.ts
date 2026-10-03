// D55 (6), issue #1086: tombstone-writing code ships in the same release as the
// breaking revoke migration (0107).
//
// D55 (6): "No release may ship code that writes a revocation or consumption
// tombstone unless the same release carries the `compat: breaking` migration
// that revokes runtime `DELETE`." Until now only 0107's own comment said so.
// This file reads the tree the release is built from, so the two cannot part:
//
//   - the CODE side: every non-test source file under backend/src that sets one
//     of the tombstone columns (`revoked_at`, `consumed_at`, `superseded_at`,
//     added by the additive migrations 0102, 0103 and 0104) on one of their
//     tables;
//   - the MIGRATION side: a migration labelled `-- compat: breaking` that
//     revokes DELETE and TRUNCATE from every runtime role, numbered after the
//     migrations that add the columns.
//
// `tombstoneReleaseViolations` is the one rule, driven over planted trees below
// so the red direction is asserted, not assumed.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BACKEND = join(import.meta.dir, "..");
const COLUMN = /\b(revoked_at|consumed_at|superseded_at)\b/;
const TOMBSTONE_TABLES = ["admin_session", "admin_passkey", "admin_webauthn_challenge", "wallet_balance_samples", "wallet_sleeve_samples"];
const WRITES_A_TOMBSTONE = /\b(revoked_at|consumed_at|superseded_at)\s*=\s*now\(\)/i;

interface Migration {
  readonly file: string;
  readonly sql: string;
}

interface SourceFile {
  readonly file: string;
  readonly text: string;
}

const numberOf = (file: string): number => Number.parseInt(file.slice(0, 4), 10);

/** Source files that write a tombstone on one of the tombstone tables. */
function tombstoneWriters(sources: readonly SourceFile[]): string[] {
  return sources
    .filter((s) => WRITES_A_TOMBSTONE.test(s.text) && TOMBSTONE_TABLES.some((table) => s.text.includes(table)))
    .map((s) => s.file);
}

/** Migrations that add a tombstone column to one of the tombstone tables. */
function columnMigrations(migrations: readonly Migration[]): Migration[] {
  return migrations.filter((m) => new RegExp(`ALTER TABLE (${TOMBSTONE_TABLES.join("|")}) ADD COLUMN (IF NOT EXISTS )?${COLUMN.source}`, "i").test(m.sql));
}

/** Migrations labelled breaking that revoke DELETE and TRUNCATE from the runtime roles. */
function revokeMigrations(migrations: readonly Migration[]): Migration[] {
  return migrations.filter(
    (m) => /^-- compat: breaking\s*$/m.test(m.sql) && /^REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM rm_app, rm_worker, rm_readonly;/m.test(m.sql),
  );
}

/** Every way the tree ships tombstone writes without the revoke that goes with them. */
function tombstoneReleaseViolations(sources: readonly SourceFile[], migrations: readonly Migration[]): string[] {
  const writers = tombstoneWriters(sources);
  const revokes = revokeMigrations(migrations);
  const columns = columnMigrations(migrations);
  const violations: string[] = [];
  if (writers.length > 0 && revokes.length === 0) {
    violations.push(`${writers.join(", ")} write a tombstone, and no \`compat: breaking\` migration revokes runtime DELETE and TRUNCATE`);
  }
  if (revokes.length > 0 && columns.length === 0) {
    violations.push("a breaking revoke ships and no migration adds the tombstone columns the code writes");
  }
  const lastColumn = Math.max(0, ...columns.map((m) => numberOf(m.file)));
  for (const revoke of revokes) {
    if (numberOf(revoke.file) <= lastColumn) violations.push(`${revoke.file} is numbered at or before the tombstone column migration ${lastColumn}`);
  }
  return violations;
}

function backendSources(dir: string, into: SourceFile[] = []): SourceFile[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) backendSources(path, into);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) into.push({ file: path.slice(BACKEND.length + 1), text: readFileSync(path, "utf8") });
  }
  return into;
}

function realMigrations(): Migration[] {
  const dir = join(BACKEND, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(dir, file), "utf8") }));
}

describe("D55 (6): tombstone writes and the breaking revoke ship in one release", () => {
  const sources = backendSources(join(BACKEND, "src"));
  const migrations = realMigrations();

  test("the tree writes tombstones (so the pin has something to hold)", () => {
    const writers = tombstoneWriters(sources);
    expect(writers).toContain("src/api/routes/admin.ts");
    expect(writers).toContain("src/api/routes/admin-webauthn.ts");
    expect(writers).toContain("src/ops/wallet-backfill.ts");
  });

  test("0107 is the breaking revoke, numbered after the migrations that add the tombstone columns", () => {
    expect(revokeMigrations(migrations).map((m) => m.file)).toEqual(["0107_revoke_runtime_delete.sql"]);
    expect(columnMigrations(migrations).map((m) => m.file)).toEqual([
      "0102_admin_revocation_tombstones.sql",
      "0103_webauthn_challenge_consumed_at.sql",
      "0104_wallet_sample_superseded_at.sql",
    ]);
  });

  test("the tree as built has no tombstone writer without the revoke", () => {
    expect(tombstoneReleaseViolations(sources, migrations)).toEqual([]);
  });

  test("tombstone code with the revoke migration removed is a violation", () => {
    const withoutRevoke = migrations.filter((m) => m.file !== "0107_revoke_runtime_delete.sql");
    expect(tombstoneReleaseViolations(sources, withoutRevoke).join(" ")).toContain("no `compat: breaking` migration revokes");
  });

  test("the revoke relabelled additive is a violation", () => {
    const relabelled = migrations.map((m) => (m.file.startsWith("0107_") ? { ...m, sql: m.sql.replace("-- compat: breaking", "-- compat: additive") } : m));
    expect(tombstoneReleaseViolations(sources, relabelled)).not.toEqual([]);
  });

  test("a revoke numbered before the column migrations is a violation", () => {
    const early = migrations.map((m) => (m.file.startsWith("0107_") ? { ...m, file: "0050_revoke_runtime_delete.sql" } : m));
    expect(tombstoneReleaseViolations(sources, early).join(" ")).toContain("numbered at or before");
  });

  test("a new tombstone writer is found without being listed", () => {
    const planted = [...sources, { file: "src/planted.ts", text: "sql`UPDATE admin_session SET revoked_at = now()`" }];
    expect(tombstoneWriters(planted)).toContain("src/planted.ts");
  });
});
