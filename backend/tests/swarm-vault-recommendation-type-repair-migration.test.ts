// Migration 0051 (issue #780): a one-time repair of
// swarm_subjects.recommendation_type for robotmoney-vault and
// robotmoney-allocation, both clobbered to 'position_actions' by
// ensureSmokeSubjectFixtures's pre-fix upsert (ON CONFLICT ... SET
// recommendation_type = EXCLUDED.recommendation_type, with no protection like
// thesis_blurb already had). The upsert itself is fixed in the same PR
// (COALESCE); this migration self-heals the two subjects the swarm PRD
// declares bucket_weights so the vault's target weights render again without
// a manual prod SQL edit.
//
// The shared test template already carries 0051 applied, so a genuine
// "pre-migration" database is not reachable here — but the migration is a
// plain idempotent UPDATE with no schema change, so re-running its SQL text
// against a database that has DRIFTED SINCE (simulating the clobber
// ensureSmokeSubjectFixtures used to perform) exercises the same statement
// production applies.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Per-test database: every test below inserts the same fixed subject ids
// (robotmoney-vault, robotmoney-allocation, woon) the migration targets by
// name — a per-file database would collide the second test tries to insert
// the id a previous test already used.
useCleanDatabasePerTest(import.meta.file);

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0051_swarm_vault_recommendation_type_repair.sql";

async function applyMigration(): Promise<void> {
  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(ddl);
  });
}

async function recommendationType(id: string): Promise<string> {
  const [row] = await sql<{ recommendation_type: string }[]>`
    SELECT recommendation_type FROM swarm_subjects WHERE id = ${id}`;
  return row.recommendation_type;
}

test("0051 exists and is recorded as already applied on a freshly migrated database", async () => {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM schema_migrations WHERE name = ${MIGRATION}`;
  expect(n).toBe(1);
});

test("repair: re-running 0051 restores robotmoney-vault and robotmoney-allocation to bucket_weights", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name, recommendation_type)
            VALUES ('robotmoney-vault', 'active', 'RobotMoney Vault', 'position_actions'),
                   ('robotmoney-allocation', 'active', 'RobotMoney Allocation', 'position_actions')`;

  await applyMigration();

  expect(await recommendationType("robotmoney-vault")).toBe("bucket_weights");
  expect(await recommendationType("robotmoney-allocation")).toBe("bucket_weights");
});

test("repair: a subject genuinely running position_actions is left untouched", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name, recommendation_type)
            VALUES ('woon', 'active', 'Woon Treasury', 'position_actions')`;

  await applyMigration();

  expect(await recommendationType("woon")).toBe("position_actions");
});

test("0051 is idempotent: applying it a second time moves nothing further", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name, recommendation_type)
            VALUES ('robotmoney-vault', 'active', 'RobotMoney Vault', 'position_actions')`;

  await applyMigration();
  expect(await recommendationType("robotmoney-vault")).toBe("bucket_weights");

  await applyMigration();
  expect(await recommendationType("robotmoney-vault")).toBe("bucket_weights");
});
