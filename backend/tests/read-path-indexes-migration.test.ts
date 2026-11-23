// Migration 0134 (issue 1690), applied the way the migrate step applies a
// file: one transaction, as rm_owner.
//
// The clean database is built from the snapshot, which already carries the six
// indexes. So the case first puts the database back to its pre-0134 shape
// (the six dropped, as rm_owner), the way a production database meets the file.
//   * after 0134 every index on the five tables is exactly what the snapshot
//     declares (pg_get_indexdef, name by name), so a snapshot-N database plus
//     migrate and a blank bootstrap end with the same indexes. The whole
//     catalog is compared by snapshot-advance.test.ts and
//     schema-equivalence.test.ts, which read 0134 from the snapshot's filename
//     list;
//   * a second run changes nothing: the same index oids;
//   * the header declares compat additive (the parser the runner uses), and
//     the file sets lock_timeout and builds only IF NOT EXISTS indexes.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { parseMigrationHeader } from "../src/db/schema-compat.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const FILE = "0134_read_path_indexes.sql";
const M0134 = readFileSync(join(import.meta.dir, "..", "migrations", FILE), "utf8");
const INDEXES = [
  "jobs_kind_id_idx",
  "job_runs_kind_started_idx",
  "source_value_versions_heads_idx",
  "source_value_versions_id_time_idx",
  "analytics_overwrite_events_id_time_idx",
  "analytics_vintage_members_vintage_id_idx",
];
const TABLES = ["jobs", "job_runs", "source_value_versions", "analytics_overwrite_events", "analytics_vintage_members"];

async function asOwner(text: string): Promise<void> {
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(text);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
}

/** Every index on the five tables: name, definition and oid. */
const indexes = () =>
  fixtureDb<{ name: string; def: string; oid: number }[]>`
    SELECT c.relname AS name, pg_get_indexdef(c.oid) AS def, c.oid::int AS oid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = ANY(${TABLES}::regclass[])
     ORDER BY 1`;

test("0134 on a pre-0134 database: the six indexes appear exactly as the snapshot declares them, and a second run changes nothing", async () => {
  const snapshot = await indexes();
  expect(INDEXES.every((name) => snapshot.some((i) => i.name === name))).toBe(true);

  await asOwner(INDEXES.map((name) => `DROP INDEX ${name};`).join("\n"));
  expect((await indexes()).filter((i) => INDEXES.includes(i.name))).toEqual([]);

  await asOwner(M0134);
  const migrated = await indexes();
  expect(migrated.map(({ name, def }) => ({ name, def }))).toEqual(snapshot.map(({ name, def }) => ({ name, def })));

  await asOwner(M0134);
  expect(await indexes()).toEqual(migrated);
});

test("0134's header declares compat additive; the file sets lock_timeout and only creates indexes IF NOT EXISTS", () => {
  expect(parseMigrationHeader(FILE, M0134)).toMatchObject({ filename: FILE, compat: "additive", metadataVersion: 1 });
  const statements = M0134.split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  expect(statements[0]).toBe("SET LOCAL lock_timeout = '2s'");
  expect(statements.slice(1).every((s) => s.startsWith("CREATE INDEX IF NOT EXISTS "))).toBe(true);
  expect(statements.slice(1).map((s) => s.split(" ")[5])).toEqual(INDEXES);
});
