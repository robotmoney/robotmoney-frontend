// Migrations 0130 and 0131 (issues 1581 and 1584), applied the way the migrate
// step applies a file: one transaction each, as rm_owner.
//
// The clean database is built from the snapshot, which already carries both.
// So each case first puts the database back to its pre-0130 shape (the
// column, its trigger and function, and the four indexes dropped, as
// rm_owner) and plants briefs there, the way a production database meets the
// files.
//   * after 0130 and 0131 every existing swarm_briefs row has allocation =
//     body->'allocation' (a body with one, a body without one, a NULL body),
//     the indexes exist, and a second run changes nothing;
//   * after 0130 every write keeps the column equal to the body, whatever the
//     writer sends;
//   * the locks (issue 1584): 0130 sets lock_timeout, so a held lock fails the
//     file instead of queueing every route behind it; 0130 rewrites no table;
//     0131 takes no lock that blocks a read;
//   * pg_stat_statements: rm_owner may not create it, and the file still
//     commits, with a NOTICE naming the doadmin tool.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const DIR = join(import.meta.dir, "..", "migrations");
const M0130 = readFileSync(join(DIR, "0130_jobs_live_index_brief_allocation_stats.sql"), "utf8");
const M0131 = readFileSync(join(DIR, "0131_swarm_briefs_allocation_backfill.sql"), "utf8");
const INDEXES = ["jobs_live_kind_locked_idx", "audit_log_job_idx", "swarm_session_events_job_idx", "pipeline_ingest_receipts_job_idx"];

const connect = (onnotice: (n: postgres.Notice) => void = () => {}) =>
  postgres(process.env.DATABASE_URL!, { max: 1, onnotice });

async function asOwner(text: string): Promise<string[]> {
  const notices: string[] = [];
  const db = connect((n) => notices.push(String(n.message)));
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
    DROP TRIGGER IF EXISTS swarm_briefs_allocation ON swarm_briefs;
    DROP FUNCTION IF EXISTS rm_swarm_briefs_allocation();
    ALTER TABLE swarm_briefs DROP COLUMN IF EXISTS allocation;
    ${INDEXES.map((i) => `DROP INDEX IF EXISTS ${i};`).join("\n")}`);

const shape = async (): Promise<{ column: boolean; trigger: string | null; indexes: string[] }> => ({
  column:
    (await fixtureDb`
      SELECT 1 FROM pg_attribute WHERE attrelid = 'swarm_briefs'::regclass AND attname = 'allocation' AND NOT attisdropped AND attgenerated = ''`)
      .length === 1,
  trigger: (
    await fixtureDb<{ e: string }[]>`
      SELECT tgenabled::text AS e FROM pg_trigger WHERE tgrelid = 'swarm_briefs'::regclass AND tgname = 'swarm_briefs_allocation'`
  )[0]?.e ?? null,
  indexes: (await fixtureDb<{ i: string }[]>`SELECT indexname AS i FROM pg_indexes WHERE indexname = ANY(${INDEXES}) ORDER BY 1`).map((r) => r.i),
});

/** The briefs of one subject: each case plants its own, and an earlier case's rows meet a later pre-0130 reset. */
const check = async (subject: string) =>
  (await fixtureDb<{ total: number; mismatched: number; withAllocation: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE allocation IS DISTINCT FROM body->'allocation')::int AS mismatched,
           count(*) FILTER (WHERE allocation IS NOT NULL)::int AS "withAllocation"
      FROM swarm_briefs WHERE subject_id = ${subject}`)[0]!;

async function plantBriefs(subject: string, bodies: readonly (object | null)[]): Promise<void> {
  await fixtureDb`INSERT INTO swarm_subjects (id, status, name) VALUES (${subject}, 'active', 'mig') ON CONFLICT DO NOTHING`;
  for (const body of bodies) {
    const [s] = await fixtureDb<{ id: string; date: Date }[]>`
      INSERT INTO swarm_sessions (subject_id, subject_name, state) VALUES (${subject}, 'mig', 'scheduled') RETURNING id, date`;
    await fixtureDb`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
                    VALUES (${s!.id}, ${s!.date}, ${subject}, ${body === null ? null : fixtureDb.json(body as never)})`;
  }
}

const TARGETS = { asof: "2026-06-02", buckets: [{ id: "conservative_defi_yield", target_weight: 0.95 }] };

test("0130 then 0131: every existing brief gets allocation = body->'allocation', the indexes appear, and a second run changes nothing", async () => {
  await pre0130();
  expect(await shape()).toEqual({ column: false, trigger: null, indexes: [] });
  await plantBriefs("mig-1581", [{ allocation: TARGETS, prose: "x".repeat(5000) }, { prose: "no targets" }, null]);

  await asOwner(M0130);
  // A plain column and an ALWAYS trigger; 0130 fills no existing row.
  expect(await shape()).toEqual({ column: true, trigger: "A", indexes: [...INDEXES].sort() });
  expect(await check("mig-1581")).toEqual({ total: 3, mismatched: 1, withAllocation: 0 });

  await asOwner(M0131);
  expect(await check("mig-1581")).toEqual({ total: 3, mismatched: 0, withAllocation: 1 });

  const before = JSON.stringify(await fixtureDb`SELECT id, allocation, xmin::text FROM swarm_briefs ORDER BY id`);
  await asOwner(M0130);
  await asOwner(M0131);
  expect(await shape()).toEqual({ column: true, trigger: "A", indexes: [...INDEXES].sort() });
  // Not one row rewritten by the second run: same values, same row versions.
  expect(JSON.stringify(await fixtureDb`SELECT id, allocation, xmin::text FROM swarm_briefs ORDER BY id`)).toBe(before);
});

test("after 0130 every write keeps allocation equal to the body: an insert, an update of the body, and a writer that names the column", async () => {
  await pre0130();
  await asOwner(M0130);
  await plantBriefs("mig-1584-w", [{ allocation: TARGETS }]);
  expect((await check("mig-1584-w")).mismatched).toBe(0);
  const [row] = await fixtureDb<{ id: string }[]>`SELECT id FROM swarm_briefs WHERE subject_id = 'mig-1584-w'`;
  // The body loses its allocation: so does the column.
  await fixtureDb`UPDATE swarm_briefs SET body = body - 'allocation' WHERE id = ${row!.id}`;
  // A writer cannot store a value that disagrees with the body.
  await fixtureDb`UPDATE swarm_briefs SET allocation = '{"forged": true}'::jsonb WHERE id = ${row!.id}`;
  expect(await check("mig-1584-w")).toEqual({ total: 1, mismatched: 0, withAllocation: 0 });
  const [{ allocation }] = await fixtureDb<{ allocation: unknown }[]>`SELECT allocation FROM swarm_briefs WHERE id = ${row!.id}`;
  expect(allocation).toBeNull();
});

test("0130 rewrites no table, and with a lock held it fails at its lock_timeout instead of queueing behind it", async () => {
  await pre0130();
  await plantBriefs("mig-1584-l", [{ allocation: TARGETS }]);
  const file = async () =>
    (
      await fixtureDb<{ rel: string; node: string }[]>`
        SELECT relname AS rel, relfilenode::text AS node FROM pg_class
         WHERE relname IN ('swarm_briefs', 'jobs', 'audit_log', 'swarm_session_events', 'pipeline_ingest_receipts') ORDER BY 1`
    ).map((r) => `${r.rel}:${r.node}`);
  const nodesBefore = await file();

  // A reader that keeps its transaction open on swarm_briefs holds ACCESS
  // SHARE, which the ADD COLUMN's ACCESS EXCLUSIVE waits for.
  const reader = connect();
  let releaseReader!: () => void;
  const held = new Promise<void>((r) => (releaseReader = r));
  let readerOpen!: () => void;
  const opened = new Promise<void>((r) => (readerOpen = r));
  const readerTx = reader.begin(async (tx) => {
    await tx`SELECT count(*) FROM swarm_briefs`;
    readerOpen();
    await held;
  });
  try {
    await opened;
    const started = Date.now();
    const error = await asOwner(M0130).then(
      () => null,
      (e: { code?: string }) => e,
    );
    const waited = Date.now() - started;
    expect(error?.code).toBe("55P03"); // lock_not_available: the timeout fired
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(10_000);
  } finally {
    releaseReader();
    await readerTx;
    await reader.end({ timeout: 5 });
  }
  // Rolled back whole: not one index or column of it is left.
  expect(await shape()).toEqual({ column: false, trigger: null, indexes: [] });

  await asOwner(M0130);
  // Same relfilenode for every table it touched: nothing was rewritten.
  expect(await file()).toEqual(nodesBefore);
});

test("0131 holds no lock a read waits on: a reader with a 100 ms lock_timeout reads swarm_briefs while it is open", async () => {
  await pre0130();
  await plantBriefs("mig-1584-r", [{ allocation: TARGETS }, { allocation: TARGETS }]);
  await asOwner(M0130);

  const migrator = connect();
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  let applied!: (modes: string[]) => void;
  const locks = new Promise<string[]>((r) => (applied = r));
  const tx = migrator.begin(async (t) => {
    await t.unsafe("SET LOCAL ROLE rm_owner");
    await t.unsafe(M0131);
    const rows = await t<{ mode: string }[]>`
      SELECT mode FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation' AND relation = 'swarm_briefs'::regclass ORDER BY 1`;
    applied(rows.map((r) => r.mode));
    await done;
  });
  const reader = connect();
  try {
    expect(await locks).toEqual(["RowExclusiveLock"]);
    const rows = await reader.begin(async (r) => {
      await r`SET LOCAL lock_timeout = '100ms'`;
      return r<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm_briefs WHERE subject_id = 'mig-1584-r'`;
    });
    expect(rows[0]!.n).toBe(2);
  } finally {
    finish();
    await tx;
    await migrator.end({ timeout: 5 });
    await reader.end({ timeout: 5 });
  }
  expect(await check("mig-1584-r")).toEqual({ total: 2, mismatched: 0, withAllocation: 2 });
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
