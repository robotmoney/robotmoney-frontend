// Migration 0047 (issue #779): a one-time backfill of swarm_sessions.subject_name
// from swarm_subjects.name, for every session whose subject was renamed before
// swarm/admin.ts's updateSubjectAdmin started keeping the two in sync in the same
// transaction.
//
// The shared test template already carries 0047 applied, so a genuine
// "pre-migration" database is not reachable here — but the migration is a plain
// idempotent UPDATE with no schema change, so re-running its SQL text against a
// database that has DRIFTED SINCE (simulating a subject renamed directly against
// swarm_subjects, bypassing the transactional backfill in admin.ts — exactly what
// a rename made before this release, or any future out-of-band edit, would leave
// behind) exercises the same statement production applies. Own clean database
// (useCleanDatabase) so the drift this file manufactures cannot leak into any
// other file's rows.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0047_swarm_session_subject_name_backfill.sql";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

async function applyMigration(): Promise<void> {
  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(ddl);
  });
}

test("0047 exists and is recorded as already applied on a freshly migrated database", async () => {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM schema_migrations WHERE name = ${MIGRATION}`;
  expect(n).toBe(1);
});

test("backfill: re-running 0047 resyncs a session whose subject_name drifted out-of-band", async () => {
  const subjectId = rid("subj");
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${subjectId}, 'active', 'Original Name')`;
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${subjectId}, '2026-08-15T09:00:00Z', 'Original Name', 'published')
    RETURNING id`;

  // Simulate a rename that bypassed the transactional backfill — exactly the
  // shape a rename made before this release (or any future direct edit) leaves.
  await sql`UPDATE swarm_subjects SET name = 'Renamed Later' WHERE id = ${subjectId}`;
  const drifted = (await sql`SELECT subject_name FROM swarm_sessions WHERE id = ${session.id}`)[0];
  expect(drifted.subject_name).toBe("Original Name");

  await applyMigration();

  const healed = (await sql`SELECT subject_name FROM swarm_sessions WHERE id = ${session.id}`)[0];
  expect(healed.subject_name).toBe("Renamed Later");
});

test("backfill: a session whose subject_name already agrees with its subject is left untouched", async () => {
  const subjectId = rid("subj");
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${subjectId}, 'active', 'Steady Name')`;
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${subjectId}, '2026-08-16T09:00:00Z', 'Steady Name', 'published')
    RETURNING id`;

  await applyMigration();

  const row = (await sql`SELECT subject_name FROM swarm_sessions WHERE id = ${session.id}`)[0];
  expect(row.subject_name).toBe("Steady Name");
});

test("0047 is idempotent: applying it a second time after a resync moves nothing further", async () => {
  const subjectId = rid("subj");
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${subjectId}, 'active', 'First Name')`;
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${subjectId}, '2026-08-17T09:00:00Z', 'First Name', 'published')
    RETURNING id`;
  await sql`UPDATE swarm_subjects SET name = 'Second Name' WHERE id = ${subjectId}`;

  await applyMigration();
  const once = (await sql`SELECT subject_name FROM swarm_sessions WHERE id = ${session.id}`)[0];
  expect(once.subject_name).toBe("Second Name");

  await applyMigration();
  const twice = (await sql`SELECT subject_name FROM swarm_sessions WHERE id = ${session.id}`)[0];
  expect(twice.subject_name).toBe("Second Name");
});
