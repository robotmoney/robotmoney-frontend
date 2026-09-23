// W4.1 — the subject's epoch duration column (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §2.2/§2.3/§2.4 and §9.
//
//   "Each subject has one scheduling parameter: its epoch duration ... That is
//    the entire schedule."
//   "On a blank database it is set by the bootstrap data in the schema
//    snapshot, once, at initial migration. Afterwards it is changed only
//    through the admin API."
//   "There is no on/off state for scheduling."
//
// WHAT IS ASSERTED HERE AND WHAT IS NOT. The value's existence, its shape, its
// blank-vs-populated boot behaviour and the admin write path are all API- and
// database-side, so they live here. The `subject.changed` EVENT the spec pairs
// with a duration change is the API event stream, which is W4.4's criterion and
// a later worker's migration — this file asserts nothing about it, and W4.1
// stays unticked until that half lands.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, refusedByDatabase, rid } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

const MIGRATION = new URL("../migrations/0067_subject_epoch_duration.sql", import.meta.url).pathname;
const SNAPSHOT = new URL("../schema/snapshot.sql", import.meta.url).pathname;

test("the column exists on swarm_subjects, NOT NULL, with a positive default", async () => {
  const [col] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
    SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'swarm_subjects' AND column_name = 'epoch_duration_seconds'`;
  expect(col).toBeDefined();
  expect(col.is_nullable).toBe("NO");
  expect(col.column_default).not.toBeNull();
  expect(Number(String(col.column_default).replace(/[^0-9]/g, ""))).toBeGreaterThan(0);
});

test("the schema snapshot declares it, so a blank-database boot sets every subject's duration", () => {
  // The snapshot (spec §8.1) is what a blank database is built from. No
  // bootstrap ROW carries the value because bootstrap-data.sql seeds no
  // subjects; the declaration's NOT NULL default is therefore the thing that
  // makes "every subject has a duration" true from the first instant.
  // `includes`, not `toContain`: the snapshot is ~200KB and a failing
  // `toContain` renders the whole of it into the diff.
  const snapshot = readFileSync(SNAPSHOT, "utf8");
  expect(snapshot.includes("epoch_duration_seconds integer DEFAULT")).toBe(true);
  expect(snapshot.includes("swarm_subjects_epoch_duration_seconds_check")).toBe(true);
});

test("every subject on a freshly migrated database has a positive duration", async () => {
  const [{ bad }] = await sql<{ bad: number }[]>`
    SELECT count(*)::int AS bad FROM swarm_subjects
     WHERE epoch_duration_seconds IS NULL OR epoch_duration_seconds <= 0`;
  expect(bad).toBe(0);
});

test("there is no off switch: zero and negative durations are refused by the database", async () => {
  const id = await activeSubject("dur_off");
  await refusedByDatabase(() => sql`UPDATE swarm_subjects SET epoch_duration_seconds = 0 WHERE id = ${id}`);
  await refusedByDatabase(() => sql`UPDATE swarm_subjects SET epoch_duration_seconds = -1 WHERE id = ${id}`);
  await refusedByDatabase(() => sql`UPDATE swarm_subjects SET epoch_duration_seconds = NULL WHERE id = ${id}`);
});

test("a subject created through the admin API carries a duration without being given one", async () => {
  const id = rid("dur_new");
  const created = await admin.createSubjectAdmin({ id, name: "new subject" });
  expect(created.status).toBe(201);
  expect((created as any).subject.epochDuration).toBeGreaterThan(0);
});

test("the admin subject route is how the duration changes, versioned like every other field", async () => {
  const id = await activeSubject("dur_admin", 3600);
  const [before] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${id}`;

  const stale = await admin.updateSubjectAdmin(id, before.version + 7, { epochDuration: 120 });
  expect(stale.status).toBe(409);
  const [unchanged] = await sql<{ epoch_duration_seconds: number }[]>`
    SELECT epoch_duration_seconds FROM swarm_subjects WHERE id = ${id}`;
  expect(unchanged.epoch_duration_seconds).toBe(3600);

  const ok = await admin.updateSubjectAdmin(id, before.version, { epochDuration: 120 });
  expect(ok.status).toBe(200);
  expect((ok as any).subject.epochDuration).toBe(120);
  const [after] = await sql<{ epoch_duration_seconds: number }[]>`
    SELECT epoch_duration_seconds FROM swarm_subjects WHERE id = ${id}`;
  expect(after.epoch_duration_seconds).toBe(120);
});

test("the admin route refuses a non-positive duration rather than storing a disabled subject", async () => {
  const id = await activeSubject("dur_reject", 600);
  const [{ version }] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${id}`;
  for (const bad of [0, -5, 1.5]) {
    const r = await admin.updateSubjectAdmin(id, version, { epochDuration: bad as number });
    expect(r.status).toBe(400);
  }
  const [after] = await sql<{ epoch_duration_seconds: number }[]>`
    SELECT epoch_duration_seconds FROM swarm_subjects WHERE id = ${id}`;
  expect(after.epoch_duration_seconds).toBe(600);
});

test("a boot on a populated database changes no subject's duration", async () => {
  // Re-applying the migration is exactly what a boot on a populated database
  // would do if `schema_migrations` had not already recorded it — the strongest
  // available statement that the migration is not a seeder in disguise.
  const id = await activeSubject("dur_populated", 4242);
  await sql.unsafe(readFileSync(MIGRATION, "utf8"));
  const [after] = await sql<{ epoch_duration_seconds: number }[]>`
    SELECT epoch_duration_seconds FROM swarm_subjects WHERE id = ${id}`;
  expect(after.epoch_duration_seconds).toBe(4242);
});
