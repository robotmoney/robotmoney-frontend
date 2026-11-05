// Migration 0130 (issue 1581), applied the way the migrate step applies a file:
// one transaction, as rm_owner.
//
// The clean database is built from the snapshot, which already carries 0130.
// So each case first puts the database back to its pre-0130 shape (the column
// and the four indexes dropped, as rm_owner) and plants briefs there, the way a
// production database meets the file.
//   * every existing swarm_briefs row gets allocation = body->'allocation'
//     (a body with one, a body without one, a NULL body);
//   * the indexes exist afterwards, and a second run changes nothing;
//   * pg_stat_statements: rm_owner may not create it, and the file still
//     commits, with a NOTICE naming the doadmin tool.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const M0130 = readFileSync(join(import.meta.dir, "..", "migrations", "0130_jobs_live_index_brief_allocation_stats.sql"), "utf8");
const INDEXES = ["jobs_live_kind_locked_idx", "audit_log_job_idx", "swarm_session_events_job_idx"];

async function asOwner(text: string): Promise<string[]> {
  const notices: string[] = [];
  const { default: postgres } = await import("postgres");
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: (n) => notices.push(String(n.message)) });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(text);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
  return notices;
}

const pre0130 = () =>
  asOwner(`
    ALTER TABLE swarm_briefs DROP COLUMN IF EXISTS allocation;
    ${INDEXES.map((i) => `DROP INDEX IF EXISTS ${i};`).join("\n")}`);

const shape = async (): Promise<{ column: string | null; indexes: string[] }> => ({
  column: (
    await fixtureDb<{ g: string }[]>`
      SELECT attgenerated AS g FROM pg_attribute WHERE attrelid = 'swarm_briefs'::regclass AND attname = 'allocation' AND NOT attisdropped`
  )[0]?.g ?? null,
  indexes: (await fixtureDb<{ i: string }[]>`SELECT indexname AS i FROM pg_indexes WHERE indexname = ANY(${INDEXES}) ORDER BY 1`).map((r) => r.i),
});

test("every existing brief gets allocation = body->'allocation', the indexes appear, and a second run changes nothing", async () => {
  await pre0130();
  expect(await shape()).toEqual({ column: null, indexes: [] });
  await fixtureDb`INSERT INTO swarm_subjects (id, status, name) VALUES ('mig-1581', 'active', 'mig')`;
  const bodies = [
    { allocation: { asof: "2026-06-02", buckets: [{ id: "conservative_defi_yield", target_weight: 0.95 }] }, prose: "x".repeat(5000) },
    { prose: "no targets" },
    null,
  ];
  for (const body of bodies) {
    const [s] = await fixtureDb<{ id: string; date: Date }[]>`
      INSERT INTO swarm_sessions (subject_id, subject_name, state) VALUES ('mig-1581', 'mig', 'scheduled') RETURNING id, date`;
    await fixtureDb`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
                    VALUES (${s!.id}, ${s!.date}, 'mig-1581', ${body === null ? null : fixtureDb.json(body)})`;
  }

  await asOwner(M0130);
  expect(await shape()).toEqual({ column: "s", indexes: [...INDEXES].sort() });
  const check = async () =>
    (await fixtureDb<{ total: number; mismatched: number; withAllocation: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE allocation IS DISTINCT FROM body->'allocation')::int AS mismatched,
             count(*) FILTER (WHERE allocation IS NOT NULL)::int AS "withAllocation"
        FROM swarm_briefs`)[0]!;
  const first = await check();
  expect(first).toEqual({ total: 3, mismatched: 0, withAllocation: 1 });

  const before = JSON.stringify(await fixtureDb`SELECT id, allocation FROM swarm_briefs ORDER BY id`);
  await asOwner(M0130);
  expect(await shape()).toEqual({ column: "s", indexes: [...INDEXES].sort() });
  expect(JSON.stringify(await fixtureDb`SELECT id, allocation FROM swarm_briefs ORDER BY id`)).toBe(before);
});

test("pg_stat_statements: rm_owner may not create it, and the file still commits with a NOTICE naming role-passwords", async () => {
  const [{ available }] = await fixtureDb<{ available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') AS available`;
  // Not a silent pass: the image ships contrib, so the guarded CREATE is attempted.
  expect(available).toBe(true);
  const [{ installed }] = await fixtureDb<{ installed: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed`;
  expect(installed).toBe(false);
  const notices = await asOwner(M0130);
  expect(notices.some((n) => n.includes("pg_stat_statements not created by rm_owner") && n.includes("role-passwords"))).toBe(true);
  expect((await fixtureDb`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`).length).toBe(0);
});
