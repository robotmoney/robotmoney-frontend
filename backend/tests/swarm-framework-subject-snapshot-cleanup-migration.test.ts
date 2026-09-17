// Migration 0059 (issue #960): forward-only migration that deletes
// swarm_subject_snapshots rows joined to swarm_subjects where source->>'type' = 'framework'.
// ensureSmokeSubjectFixtures previously wrote synthetic snapshots for any
// subject not named woon/mav, including framework subjects like
// robotmoney-allocation, which have no holdings and represent an allocation
// recipe rather than a book of positions.
//
// Following tests/swarm-vault-recommendation-type-repair-migration.test.ts pattern.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0059_swarm_framework_subject_snapshot_cleanup.sql";

async function applyMigration(): Promise<void> {
  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe(ddl);
  });
}

test("0059 exists and is recorded as already applied on a freshly migrated database", async () => {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM schema_migrations WHERE name = ${MIGRATION}`;
  expect(n).toBe(1);
});

test("cleanup: re-running 0059 deletes snapshots for subjects where source.type is framework", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name, source)
            VALUES ('robotmoney-allocation', 'active', 'RobotMoney Allocation', ${sql.json({ type: "framework" })}),
                   ('woon', 'active', 'Woon Treasury', ${sql.json({ type: "wallets" })})`;

  await sql`INSERT INTO swarm_subject_snapshots (subject_id, date, total_value_usd, positions, wallets, notable)
            VALUES ('robotmoney-allocation', '2026-01-01', 42688.0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb),
                   ('woon', '2026-01-01', 50000.0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;

  await applyMigration();

  const [{ allocCount }] = await sql<{ allocCount: number }[]>`
    SELECT count(*)::int AS "allocCount" FROM swarm_subject_snapshots WHERE subject_id = 'robotmoney-allocation'`;
  expect(allocCount).toBe(0);

  const [{ woonCount }] = await sql<{ woonCount: number }[]>`
    SELECT count(*)::int AS "woonCount" FROM swarm_subject_snapshots WHERE subject_id = 'woon'`;
  expect(woonCount).toBe(1);
});

test("cleanup: a subject with null or non-framework source is left untouched", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name)
            VALUES ('robotmoney-vault', 'active', 'RobotMoney Vault')`;

  await sql`INSERT INTO swarm_subject_snapshots (subject_id, date, total_value_usd, positions, wallets, notable)
            VALUES ('robotmoney-vault', '2026-01-01', 100000.0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;

  await applyMigration();

  const [{ count }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM swarm_subject_snapshots WHERE subject_id = 'robotmoney-vault'`;
  expect(count).toBe(1);
});

test("0059 is idempotent: applying it a second time moves nothing further", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name, source)
            VALUES ('robotmoney-allocation', 'active', 'RobotMoney Allocation', ${sql.json({ type: "framework" })}),
                   ('woon', 'active', 'Woon Treasury', ${sql.json({ type: "wallets" })})`;

  await sql`INSERT INTO swarm_subject_snapshots (subject_id, date, total_value_usd, positions, wallets, notable)
            VALUES ('robotmoney-allocation', '2026-01-01', 42688.0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb),
                   ('woon', '2026-01-01', 50000.0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;

  await applyMigration();

  const [{ allocCount1 }] = await sql<{ allocCount1: number }[]>`
    SELECT count(*)::int AS "allocCount1" FROM swarm_subject_snapshots WHERE subject_id = 'robotmoney-allocation'`;
  expect(allocCount1).toBe(0);

  // Second run: no-op, non-framework snapshot still intact
  await applyMigration();

  const [{ allocCount2 }] = await sql<{ allocCount2: number }[]>`
    SELECT count(*)::int AS "allocCount2" FROM swarm_subject_snapshots WHERE subject_id = 'robotmoney-allocation'`;
  expect(allocCount2).toBe(0);

  const [{ woonCount2 }] = await sql<{ woonCount2: number }[]>`
    SELECT count(*)::int AS "woonCount2" FROM swarm_subject_snapshots WHERE subject_id = 'woon'`;
  expect(woonCount2).toBe(1);
});
