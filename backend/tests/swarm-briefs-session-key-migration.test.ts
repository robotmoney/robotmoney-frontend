// Migration 0028 (swarm_briefs re-keyed from the day to the session — issue
// #574).
//
// This file provisions its OWN ephemeral Postgres, deliberately separate from
// the shared suite database that tests/preload.ts migrates through 0028 before
// any test file loads. By the time preload's database is available the old
// `UNIQUE (date, subject_id)` is already gone, so the pre-0028 rows whose
// backfill is under test can no longer be created there. Here we apply
// 0001..0027 for a genuine pre-0028 baseline, seed the exact row shapes
// production and the v0 archive actually contain, apply 0028, and assert what
// happened to each — then apply it a second time verbatim and assert nothing
// moved. Same pattern as tests/admin-surface-migration.test.ts.
//
// The three seeded shapes, and the backfill decision each one exercises:
//   A. A day with TWO sessions and the ONE surviving brief the old upsert left
//      behind → attaches to the NEWEST session (the one whose body actually
//      won last-write-wins), and the earlier session gets NO brief rather than
//      a fabricated copy of a windowClosesAt it never advertised.
//   B. A day with exactly one session → attaches to it.
//   C. A brief with NO session for its day (19 of the 73 briefs in the
//      committed v0 archive are this shape) → KEPT with session_id NULL, not
//      deleted.
//   D. A day whose NEWEST session is still 'scheduled' — i.e. convened but not
//      yet briefed — over an older session that did publish. The brief must
//      attach to the PUBLISHED one. This is the ordinary steady state, not an
//      edge case: openSession() inserts every session as 'scheduled' and the
//      brief follows on a separate cron, so for most of any given day the
//      newest session has no brief. Shapes A-C all seeded 'published' sessions
//      and so could never have caught it.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0028_swarm_briefs_session_key.sql";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

let containerName: string;
let db: postgres.Sql<{}>;

// Ids captured during fixture seeding, used by the assertions below.
let earlySessionId: string;  // shape A, first session of the day
let lateSessionId: string;   // shape A, second session of the same day
let soloSessionId: string;   // shape B
let publishedSessionId: string; // shape D, older session that DID publish a brief
let scheduledSessionId: string; // shape D, newer session convened but not yet briefed
let dupBriefId: string;      // shape A's single surviving brief row
let soloBriefId: string;     // shape B's brief
let orphanBriefId: string;   // shape C, sessionless
let pendingBriefId: string;  // shape D's brief

// Whether the PRE-0028 schema really rejected a second same-day brief. Proving
// this is what makes the rest of the file a migration test rather than a
// tautology: it is the mechanism that destroyed the earlier sessions' bodies.
let preMigrationRejectedSecondSameDayBrief = false;

const DUP_DAY = "2026-05-20";
const SOLO_DAY = "2026-05-21";
const ORPHAN_DAY = "2026-05-22";
const PENDING_DAY = "2026-05-23";
const SUBJECT = "briefs-migration-subject";

// postgres.js tagged-template results are lazy "PendingQuery" thenables, not
// plain Promises; bun:test's `expect(...).rejects` wrapper hangs against them.
// Assert rejection this way instead (mirrors admin-surface-migration.test.ts).
async function rejected(query: Promise<unknown>): Promise<boolean> {
  try {
    await query;
    return false;
  } catch {
    return true;
  }
}

interface BriefRow { id: string; session_id: string | null; date: Date | string; subject_id: string; body: unknown }

async function briefRows(): Promise<BriefRow[]> {
  return await db<BriefRow[]>`
    SELECT id, session_id, date, subject_id, body FROM swarm_briefs
    WHERE subject_id = ${SUBJECT} ORDER BY date`;
}

let afterFirstApply: BriefRow[];
let afterSecondApply: BriefRow[];

beforeAll(async () => {
  const port = await freePort();
  containerName = `rmtest_briefs_migration_${crypto.randomUUID().slice(0, 8)}`;
  const up = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
    "-p", `${port}:5432`, "postgres:17-alpine",
  ]);
  if (up.exitCode !== 0) {
    throw new Error(
      `swarm-briefs-session-key-migration test requires Docker+Postgres but the container failed to start:\n${up.stderr.toString()}`,
    );
  }
  db = postgres(`postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`, { max: 4, onnotice: () => {} });

  // Wait for a REAL accepting connection (mirrors src/db/migrate.ts's waitForDb).
  const start = Date.now();
  for (;;) {
    try { await db`SELECT 1`; break; } catch (err) {
      if (Date.now() - start > 30_000) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const pre = files.filter((f) => f < MIGRATION);
  if (!files.includes(MIGRATION)) throw new Error(`${MIGRATION} not found in backend/migrations`);
  expect(pre.length).toBeGreaterThan(0);
  for (const file of pre) {
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    await db.begin(async (tx) => { await tx.unsafe(ddl); });
  }

  // ── Seed a genuine PRE-0028 database ──────────────────────────────────────
  await db`INSERT INTO swarm_subjects (id, status, name) VALUES (${SUBJECT}, 'active', 'Briefs Migration Subject')`;

  // Shape A: two sessions on one day. convened_at is what 0022 made the
  // session's identity; `date` is the STORED column derived from it.
  const [early] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${SUBJECT}, ${`${DUP_DAY}T09:00:00Z`}, 'Briefs Migration Subject', 'published') RETURNING id`;
  earlySessionId = early.id;
  const [late] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${SUBJECT}, ${`${DUP_DAY}T10:30:00Z`}, 'Briefs Migration Subject', 'published') RETURNING id`;
  lateSessionId = late.id;

  // Shape B: a single session on its own day.
  const [solo] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${SUBJECT}, ${`${SOLO_DAY}T09:00:00Z`}, 'Briefs Migration Subject', 'published') RETURNING id`;
  soloSessionId = solo.id;

  // The ONE brief the old day-keyed upsert left for the two-session day. Its
  // body is the LATE session's — last write won — which is precisely why the
  // late session is its rightful owner.
  const [dup] = await db<{ id: string }[]>`
    INSERT INTO swarm_briefs (date, subject_id, body)
    VALUES (${DUP_DAY}, ${SUBJECT}, ${db.json({ windowClosesAt: `${DUP_DAY}T11:30:00.000Z`, marker: "late-session-body" })})
    RETURNING id`;
  dupBriefId = dup.id;

  // THE MECHANISM: pre-0028, a second brief for the same day is impossible.
  // This is what forced publishBrief() to overwrite instead of insert.
  preMigrationRejectedSecondSameDayBrief = await rejected(
    db`INSERT INTO swarm_briefs (date, subject_id, body)
       VALUES (${DUP_DAY}, ${SUBJECT}, ${db.json({ windowClosesAt: `${DUP_DAY}T10:00:00.000Z`, marker: "early-session-body" })})` as unknown as Promise<unknown>,
  );

  const [soloBrief] = await db<{ id: string }[]>`
    INSERT INTO swarm_briefs (date, subject_id, body)
    VALUES (${SOLO_DAY}, ${SUBJECT}, ${db.json({ windowClosesAt: `${SOLO_DAY}T10:00:00.000Z`, marker: "solo" })})
    RETURNING id`;
  soloBriefId = soloBrief.id;

  // Shape C: a brief whose day has no session at all — the v0-archive shape.
  const [orphan] = await db<{ id: string }[]>`
    INSERT INTO swarm_briefs (date, subject_id, body)
    VALUES (${ORPHAN_DAY}, ${SUBJECT}, ${db.json({ marker: "v0-archived-brief-with-no-archived-session" })})
    RETURNING id`;
  orphanBriefId = orphan.id;

  // Shape D: the ordinary steady state. An older session that published its
  // brief, and a NEWER one convened by openSession() but not yet briefed —
  // still 'scheduled', and carrying a pre-set window_closes_at exactly the way
  // swarm/admin.ts inserts one, so that column cannot be used to tell the two
  // apart. The brief belongs to the PUBLISHED session.
  const [published] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state, window_closes_at)
    VALUES (${SUBJECT}, ${`${PENDING_DAY}T07:00:00Z`}, 'Briefs Migration Subject', 'published', ${`${PENDING_DAY}T08:00:00Z`})
    RETURNING id`;
  publishedSessionId = published.id;
  const [scheduled] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state, window_closes_at)
    VALUES (${SUBJECT}, ${`${PENDING_DAY}T14:00:00Z`}, 'Briefs Migration Subject', 'scheduled', ${`${PENDING_DAY}T15:00:00Z`})
    RETURNING id`;
  scheduledSessionId = scheduled.id;
  const [pending] = await db<{ id: string }[]>`
    INSERT INTO swarm_briefs (date, subject_id, body)
    VALUES (${PENDING_DAY}, ${SUBJECT}, ${db.json({ windowClosesAt: `${PENDING_DAY}T08:00:00.000Z`, marker: "published-session-body" })})
    RETURNING id`;
  pendingBriefId = pending.id;

  // ── Apply 0028, then apply it a second time verbatim ──────────────────────
  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await db.begin(async (tx) => { await tx.unsafe(ddl); });
  afterFirstApply = await briefRows();
  await db.begin(async (tx) => { await tx.unsafe(ddl); });
  afterSecondApply = await briefRows();
}, 120_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  if (containerName) Bun.spawnSync(["docker", "rm", "-f", containerName]);
});

test("pre-0028 the day key is what made a second same-day brief impossible", () => {
  expect(preMigrationRejectedSecondSameDayBrief).toBe(true);
});

test("applying 0028 preserves EVERY existing brief row — nothing is dropped", async () => {
  expect(afterFirstApply.map((r) => r.id).sort()).toEqual([dupBriefId, soloBriefId, orphanBriefId, pendingBriefId].sort());
  // Bodies are untouched: this migration re-keys, it does not rewrite content.
  const dup = afterFirstApply.find((r) => r.id === dupBriefId)!;
  expect((dup.body as { marker: string }).marker).toBe("late-session-body");
});

test("backfill: the surviving brief of a two-session day attaches to the NEWEST session", () => {
  const dup = afterFirstApply.find((r) => r.id === dupBriefId)!;
  expect(dup.session_id).toBe(lateSessionId);
  expect(dup.session_id).not.toBe(earlySessionId);
});

test("backfill: the earlier session of that day gets NO brief — its body was destroyed pre-migration and is NOT fabricated", () => {
  const attachedToEarly = afterFirstApply.filter((r) => r.session_id === earlySessionId);
  expect(attachedToEarly.length).toBe(0);
  // …and specifically the surviving body was not COPIED onto it, which would
  // have advertised a windowClosesAt that session never promised.
  expect(afterFirstApply.filter((r) => (r.body as { marker: string }).marker === "late-session-body").length).toBe(1);
});

test("backfill: a single-session day attaches to its one session", () => {
  expect(afterFirstApply.find((r) => r.id === soloBriefId)!.session_id).toBe(soloSessionId);
});

// THE BLOCKER THIS SHAPE EXISTS FOR. openSession() inserts every session as
// 'scheduled' and the brief follows on a separate cron, so for most of any given
// day the newest session of a subject has not been briefed yet. A backfill that
// took the newest session unconditionally would hand the day's real brief to
// that unbriefed session — which would then advertise a windowClosesAt it never
// promised, and destroy the real body on its own ON CONFLICT (session_id) DO
// UPDATE the moment it published. One-shot, no rollback.
//
// RED CONTROL: drop `AND s.state <> 'scheduled'` from the migration's backfill
// subquery and this test fails with session_id = the scheduled session.
test("backfill: a day whose NEWEST session is still 'scheduled' attaches its brief to the PUBLISHED older session", () => {
  const pending = afterFirstApply.find((r) => r.id === pendingBriefId)!;
  expect(pending.session_id).toBe(publishedSessionId);
  expect(pending.session_id).not.toBe(scheduledSessionId);
  // The unbriefed session owns nothing at all.
  expect(afterFirstApply.filter((r) => r.session_id === scheduledSessionId).length).toBe(0);
  // …and the body that survived is the published session's own.
  expect((pending.body as { marker: string }).marker).toBe("published-session-body");
});

test("backfill: `window_closes_at` could not have discriminated — both shape-D sessions carry one", async () => {
  // Pinning WHY the filter is on `state`, not on window_closes_at: swarm/admin.ts
  // pre-sets that column on sessions it inserts as 'scheduled', so a
  // `window_closes_at IS NOT NULL` predicate would have selected the unbriefed
  // session just as happily.
  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_sessions
    WHERE id = ANY(${[publishedSessionId, scheduledSessionId]}) AND window_closes_at IS NOT NULL`;
  expect(n).toBe(2);
});

test("backfill: a brief with no session for its day is KEPT with session_id NULL (the v0-archive shape)", () => {
  const orphan = afterFirstApply.find((r) => r.id === orphanBriefId)!;
  expect(orphan.session_id).toBeNull();
  expect((orphan.body as { marker: string }).marker).toBe("v0-archived-brief-with-no-archived-session");
});

test("after 0028 the day key is gone and the session key is enforced", async () => {
  const [{ n: dayKey }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'swarm_briefs_date_subject_id_key'`;
  expect(dayKey).toBe(0);

  const [{ n: sessionKey }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'swarm_briefs_session_key' AND indexdef LIKE '%UNIQUE%'`;
  expect(sessionKey).toBe(1);

  // The day-scoped read path keeps an index of its own.
  const [{ n: dayIdx }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'swarm_briefs_subject_date_idx'`;
  expect(dayIdx).toBe(1);

  // The FK to the session exists and cascades.
  const [{ n: fk }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint
    WHERE conname = 'swarm_briefs_session_fk' AND contype = 'f' AND confdeltype = 'c'`;
  expect(fk).toBe(1);
});

// A unique index on a nullable column constrains NOTHING about its NULL rows —
// Postgres treats every NULL as distinct, so swarm_briefs_session_key alone
// would let sessionless briefs multiply per day, losing the guarantee the
// dropped UNIQUE (date, subject_id) used to give them. The partial index is
// what actually holds that line.
test("sessionless briefs really are one-per-day — the partial unique index, not the nullable one, enforces it", async () => {
  const [{ n: partial }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'swarm_briefs_sessionless_day_key' AND indexdef LIKE '%UNIQUE%'`;
  expect(partial).toBe(1);

  // A SECOND sessionless brief for a (subject, date) that already has one is
  // rejected. Without the partial index this INSERT succeeds.
  expect(
    await rejected(
      db`INSERT INTO swarm_briefs (date, subject_id, body)
         VALUES (${ORPHAN_DAY}, ${SUBJECT}, ${db.json({ marker: "second-sessionless" })})` as unknown as Promise<unknown>,
    ),
  ).toBe(true);

  // A sessionless brief on a DIFFERENT day is still fine — the index scopes to
  // (date, subject_id), it does not forbid sessionless rows outright.
  await db`INSERT INTO swarm_briefs (date, subject_id, body)
           VALUES ('2026-05-30', ${SUBJECT}, ${db.json({ marker: "other-day-sessionless" })})`;
  await db`DELETE FROM swarm_briefs WHERE date = '2026-05-30' AND subject_id = ${SUBJECT}`;
});

// The re-run shape the NOT EXISTS guard exists for: an orphan day that later
// gains a session which ALREADY carries its own brief. Re-resolving the orphan
// onto that session would collide on swarm_briefs_session_key and abort the
// whole migration. migrate.ts never re-applies a recorded file, so this was
// never a merge blocker — but "idempotent" should be true, not nearly true.
test("re-applying 0028 after an orphan day gains an already-briefed session does not abort", async () => {
  const [late] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${SUBJECT}, ${`${ORPHAN_DAY}T12:00:00Z`}, 'Briefs Migration Subject', 'published') RETURNING id`;
  await db`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
           VALUES (${late.id}, ${ORPHAN_DAY}, ${SUBJECT}, ${db.json({ marker: "its-own-brief" })})`;

  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await db.begin(async (tx) => { await tx.unsafe(ddl); });

  // The orphan stays sessionless rather than colliding, and the newer session
  // keeps the brief it already had.
  const [orphan] = await db<{ session_id: string | null }[]>`
    SELECT session_id FROM swarm_briefs WHERE id = ${orphanBriefId}`;
  expect(orphan.session_id).toBeNull();
  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_briefs WHERE session_id = ${late.id}`;
  expect(n).toBe(1);

  await db`DELETE FROM swarm_briefs WHERE session_id = ${late.id}`;
  await db`DELETE FROM swarm_sessions WHERE id = ${late.id}`;
});

test("after 0028 the EARLIER session of a day can be given its own brief; a session can never have two", async () => {
  // The write the defect made impossible now succeeds.
  await db`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
           VALUES (${earlySessionId}, ${DUP_DAY}, ${SUBJECT}, ${db.json({ marker: "early-session-body" })})`;
  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_briefs WHERE subject_id = ${SUBJECT} AND date = ${DUP_DAY}`;
  expect(n).toBe(2);

  // …but a SECOND brief for the same session is rejected: one brief per session.
  expect(
    await rejected(
      db`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
         VALUES (${earlySessionId}, ${DUP_DAY}, ${SUBJECT}, ${db.json({ marker: "dupe" })})` as unknown as Promise<unknown>,
    ),
  ).toBe(true);

  // Clean up so the idempotence assertion below compares like for like.
  await db`DELETE FROM swarm_briefs WHERE session_id = ${earlySessionId}`;
});

test("0028 is idempotent: applying it a second time verbatim moves nothing", () => {
  expect(afterSecondApply.map((r) => ({ id: r.id, session_id: r.session_id })))
    .toEqual(afterFirstApply.map((r) => ({ id: r.id, session_id: r.session_id })));
});

// Applying 0028 against a database that ALREADY carries same-day duplicate
// briefs. Pre-migration that database cannot exist — `UNIQUE (date,
// subject_id)` has forbidden it since 0001, which is the first test in this
// file — so the reachable form is a re-run against a post-0028 database where
// two sessions of one day have each published their own brief. The backfill's
// `WHERE session_id IS NULL` must leave both alone rather than re-resolving
// them onto the day's newest session and colliding on the session key.
test("re-applying 0028 to a database that already carries same-day duplicate briefs is a clean no-op", async () => {
  await db`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
           VALUES (${earlySessionId}, ${DUP_DAY}, ${SUBJECT}, ${db.json({ marker: "early-session-body" })})`;
  const before = await db<{ id: string; session_id: string | null }[]>`
    SELECT id, session_id FROM swarm_briefs WHERE subject_id = ${SUBJECT} ORDER BY id`;
  expect(before.filter((r) => r.session_id === earlySessionId).length).toBe(1);
  expect(before.filter((r) => r.session_id === lateSessionId).length).toBe(1);

  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await db.begin(async (tx) => { await tx.unsafe(ddl); });

  const after = await db<{ id: string; session_id: string | null }[]>`
    SELECT id, session_id FROM swarm_briefs WHERE subject_id = ${SUBJECT} ORDER BY id`;
  expect(after).toEqual(before);

  await db`DELETE FROM swarm_briefs WHERE session_id = ${earlySessionId}`;
});

test("deleting a session cascades to its brief, and a sessionless brief survives it", async () => {
  await db`DELETE FROM swarm_sessions WHERE id = ${soloSessionId}`;
  const [{ n: gone }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_briefs WHERE id = ${soloBriefId}`;
  expect(gone).toBe(0);
  const [{ n: kept }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_briefs WHERE id = ${orphanBriefId}`;
  expect(kept).toBe(1);
});
