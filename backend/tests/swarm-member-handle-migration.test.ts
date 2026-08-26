// Migration 0030 (swarm_members gains a public `handle` — issue #593).
//
// THE ACCEPTANCE CRITERION THIS FILE IS. "Migration is source-only and leaves
// child FK values and signed payloads unchanged." Both halves of that sentence
// are only checkable against a genuine PRE-0030 database carrying real child
// rows, so this file provisions its OWN ephemeral Postgres — the shared suite
// database (tests/preload.ts) has 0030 applied before any test file loads, and
// there the pre-migration state under test no longer exists. Same pattern as
// tests/swarm-briefs-session-key-migration.test.ts and
// tests/admin-surface-migration.test.ts.
//
// The seeded fixture is the shape that made the rename impossible in the first
// place: a member whose legacy id 'woon' is simultaneously the primary key,
// the `member_id` of four different child tables, and the identity string
// inside an already-signed recommendation payload. What the assertions check is
// what did NOT move:
//
//   - SOURCE-ONLY: after 0030 the ONLY table whose column set changed is
//      swarm_members, and the only change is the added `handle`. Every foreign
//      key constraint in the database — name, columns, delete behaviour — is
//      byte-identical, and swarm_members' PRIMARY KEY is still on `id`. (The
//      earlier design for this feature moved the primary key onto a generated
//      uuid and dropped/recreated seven foreign keys to do it; this asserts
//      that none of that happens.)
//   - CHILD FK VALUES: every child row's `member_id` still reads 'woon'.
//   - SIGNED PAYLOADS: the recommendation's `payload` and `signature` are
//      unchanged, and the payload still names 'woon' as the signer — so every
//      historical signature still verifies against the bytes it was made over.
//   - The backfill really ran (handle = id for a row that predates the column),
//      the unique index really constrains, the insert default really defaults,
//      and re-applying the file verbatim moves nothing.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";
// The SHARED ephemeral-Postgres pin (issue #691). This file provisions a
// container of its own, so it is one of the sites that has to stay on the
// major production runs; it must never hold its own literal again — that is
// exactly how the harness fell a major behind. See
// scripts/lib/postgres-image.ts for the version and the -alpine
// decision, and backend/tests/postgres-version-parity.test.ts, which fails if
// a literal reappears anywhere under backend/tests/.
import { POSTGRES_IMAGE } from "../../scripts/lib/postgres-image.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0030_swarm_member_handle.sql";

// The legacy id, chosen to be the real one from the issue: 'woon' is the
// persona whose public name had to change and could not.
const MEMBER = "woon";
const OTHER = "athena";
const SUBJECT = "handle-migration-subject";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

let containerName: string;
let db: postgres.Sql<{}>;

let sessionId: string;
let recommendationId: string;

// Structural snapshots either side of the migration.
type ColumnRow = { table_name: string; column_name: string };
type ConstraintRow = { conname: string; definition: string; table_name: string };
let columnsBefore: ColumnRow[];
let columnsAfter: ColumnRow[];
let fkBefore: ConstraintRow[];
let fkAfter: ConstraintRow[];
let pkBefore: ConstraintRow[];
let pkAfter: ConstraintRow[];

// Child-row snapshots either side.
type ChildRow = { table_name: string; member_id: string };
let childBefore: ChildRow[];
let childAfter: ChildRow[];
type RecRow = { id: string; member_id: string; payload: unknown; signature: string; nonce: string };
let recBefore: RecRow;
let recAfter: RecRow;

// The exact bytes a member signs are canonicalised elsewhere; this file only
// needs a payload that NAMES the member, because that is the thing a rewrite of
// `id` would have had to change (and therefore invalidate).
const SIGNED_PAYLOAD = {
  memberId: MEMBER,
  date: "2026-05-26",
  subjectId: SUBJECT,
  nonce: "handle-migration-nonce",
  stance: "constructive",
  confidence: 0.7,
  body: "signed before the handle column existed",
};
const SIGNATURE = "c2lnbmF0dXJlLW92ZXItdGhlLXBheWxvYWQtYWJvdmU=";

async function columns(): Promise<ColumnRow[]> {
  return await db<ColumnRow[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name`;
}

async function constraintsOfType(type: "f" | "p"): Promise<ConstraintRow[]> {
  return await db<ConstraintRow[]>`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS definition, rel.relname AS table_name
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND c.contype = ${type}
    ORDER BY rel.relname, c.conname`;
}

// Every table that carries a member_id foreign key, with the value it holds.
async function childMemberIds(): Promise<ChildRow[]> {
  const [recs, keys, memos, sessionMembers] = await Promise.all([
    db<{ member_id: string }[]>`SELECT member_id FROM swarm_recommendations ORDER BY member_id`,
    db<{ member_id: string }[]>`SELECT member_id FROM swarm_member_keys ORDER BY member_id`,
    db<{ member_id: string }[]>`SELECT member_id FROM swarm_memos ORDER BY member_id`,
    db<{ member_id: string }[]>`SELECT member_id FROM swarm_session_members ORDER BY member_id`,
  ]);
  return [
    ...recs.map((r) => ({ table_name: "swarm_recommendations", member_id: r.member_id })),
    ...keys.map((r) => ({ table_name: "swarm_member_keys", member_id: r.member_id })),
    ...memos.map((r) => ({ table_name: "swarm_memos", member_id: r.member_id })),
    ...sessionMembers.map((r) => ({ table_name: "swarm_session_members", member_id: r.member_id })),
  ];
}

async function recommendation(): Promise<RecRow> {
  const [row] = await db<RecRow[]>`
    SELECT id, member_id, payload, signature, nonce FROM swarm_recommendations WHERE id = ${recommendationId}`;
  if (!row) throw new Error("recommendation(): the seeded recommendation is gone");
  return row;
}

// postgres.js tagged-template results are lazy thenables, not plain Promises;
// bun:test's `expect(...).rejects` wrapper hangs against them.
async function rejected(query: Promise<unknown>): Promise<boolean> {
  try {
    await query;
    return false;
  } catch {
    return true;
  }
}

async function applyMigration(): Promise<void> {
  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await db.begin(async (tx) => { await tx.unsafe(ddl); });
}

beforeAll(async () => {
  const port = await freePort();
  containerName = `rmtest_handle_migration_${crypto.randomUUID().slice(0, 8)}`;
  const up = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
    "-p", `${port}:5432`, POSTGRES_IMAGE,
  ]);
  if (up.exitCode !== 0) {
    throw new Error(
      `swarm-member-handle-migration test requires Docker+Postgres but the container failed to start:\n${up.stderr.toString()}`,
    );
  }
  db = postgres(`postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`, { max: 4, onnotice: () => {} });

  const start = Date.now();
  for (;;) {
    try { await db`SELECT 1`; break; } catch (err) {
      if (Date.now() - start > 30_000) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  if (!files.includes(MIGRATION)) throw new Error(`${MIGRATION} not found in backend/migrations`);
  const pre = files.filter((f) => f < MIGRATION);
  expect(pre.length).toBeGreaterThan(0);
  for (const file of pre) {
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    await db.begin(async (tx) => { await tx.unsafe(ddl); });
  }

  // ── Seed a genuine PRE-0030 database ──────────────────────────────────────
  await db`INSERT INTO swarm_subjects (id, status, name) VALUES (${SUBJECT}, 'active', 'Handle Migration Subject')`;
  await db`INSERT INTO swarm_members (id, status, name, lens) VALUES (${MEMBER}, 'active', 'Woon', 'machine economy')`;
  await db`INSERT INTO swarm_members (id, status, name, lens) VALUES (${OTHER}, 'active', 'Athena', 'quant risk')`;

  const [session] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${SUBJECT}, '2026-05-26T09:00:00Z', 'Handle Migration Subject', 'published') RETURNING id`;
  sessionId = session!.id;

  // The four child tables that key on member_id, each holding the legacy id.
  const [rec] = await db<{ id: string }[]>`
    INSERT INTO swarm_recommendations
      (session_id, member_id, subject_id, date, nonce, stance, confidence, body, payload, signature, verified)
    VALUES (${sessionId}, ${MEMBER}, ${SUBJECT}, '2026-05-26', ${SIGNED_PAYLOAD.nonce},
            ${SIGNED_PAYLOAD.stance}, ${SIGNED_PAYLOAD.confidence}, ${SIGNED_PAYLOAD.body},
            ${db.json(SIGNED_PAYLOAD as any)}, ${SIGNATURE}, true)
    RETURNING id`;
  recommendationId = rec!.id;
  await db`INSERT INTO swarm_member_keys (member_id, public_key) VALUES (${MEMBER}, 'pk_woon')`;
  await db`INSERT INTO swarm_memos (member_id, session_id, title, body)
           VALUES (${MEMBER}, ${sessionId}, 'memo', 'a memo filed under the legacy id')`;
  await db`INSERT INTO swarm_session_members (session_id, member_id, member_name)
           VALUES (${sessionId}, ${MEMBER}, 'Woon')`;

  columnsBefore = await columns();
  fkBefore = await constraintsOfType("f");
  pkBefore = await constraintsOfType("p");
  childBefore = await childMemberIds();
  recBefore = await recommendation();

  await applyMigration();

  columnsAfter = await columns();
  fkAfter = await constraintsOfType("f");
  pkAfter = await constraintsOfType("p");
  childAfter = await childMemberIds();
  recAfter = await recommendation();
}, 180_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  if (containerName) Bun.spawnSync(["docker", "rm", "-f", containerName]);
});

// ── SOURCE-ONLY ─────────────────────────────────────────────────────────────

test("0030 is SOURCE-ONLY: swarm_members is the only table whose columns change, and `handle` is the only column added", () => {
  const key = (r: ColumnRow) => `${r.table_name}.${r.column_name}`;
  const before = new Set(columnsBefore.map(key));
  const after = new Set(columnsAfter.map(key));

  const added = [...after].filter((c) => !before.has(c));
  const removed = [...before].filter((c) => !after.has(c));
  expect(added).toEqual(["swarm_members.handle"]);
  expect(removed).toEqual([]);
});

test("0030 touches no foreign key: every FK constraint in the database is identical afterwards, name and definition alike", () => {
  // The alternative design for this feature re-keyed swarm_members onto a
  // generated uuid, which forced dropping and recreating SEVEN foreign keys —
  // any one of which could come back with a different ON DELETE behaviour. The
  // shipped migration does not touch them at all, and this is what says so.
  expect(fkAfter).toEqual(fkBefore);
  // Sanity: the snapshot is not vacuously empty.
  expect(fkBefore.some((c) => c.definition.includes("REFERENCES swarm_members(id)"))).toBe(true);
});

test("0030 leaves swarm_members' PRIMARY KEY on `id` — the target every child foreign key resolves against", async () => {
  expect(pkAfter).toEqual(pkBefore);
  const [pk] = await db<{ definition: string }[]>`
    SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'swarm_members' AND c.contype = 'p'`;
  expect(pk!.definition).toBe("PRIMARY KEY (id)");
});

// ── CHILD FK VALUES AND SIGNED PAYLOADS ─────────────────────────────────────

test("every child row's member_id still reads the legacy id after 0030", () => {
  expect(childAfter).toEqual(childBefore);
  // …and it really is the legacy id in all four child tables, not an empty set
  // trivially equal to itself.
  expect(childAfter).toHaveLength(4);
  expect(childAfter.every((r) => r.member_id === MEMBER)).toBe(true);
});

test("the signed recommendation's payload and signature are byte-identical after 0030, and still name the legacy id as signer", () => {
  expect(recAfter.id).toBe(recBefore.id);
  expect(recAfter.member_id).toBe(MEMBER);
  expect(recAfter.signature).toBe(SIGNATURE);
  expect(recAfter.signature).toBe(recBefore.signature);
  expect(JSON.stringify(recAfter.payload)).toBe(JSON.stringify(recBefore.payload));
  // THE POINT OF THE WHOLE ISSUE: the signer named inside the signed bytes is
  // untouched, so the signature still verifies against them. Rewriting `id` to
  // publish a new public name would have had to change this string.
  expect((recAfter.payload as { memberId: string }).memberId).toBe(MEMBER);
  expect(recAfter.nonce).toBe(SIGNED_PAYLOAD.nonce);
});

// ── WHAT 0030 DOES ADD ──────────────────────────────────────────────────────

test("the backfill gives every pre-existing member a handle equal to its id — no published URL changes on deploy", async () => {
  const rows = await db<{ id: string; handle: string }[]>`SELECT id, handle FROM swarm_members ORDER BY id`;
  expect(rows.map((r) => r.id)).toEqual([OTHER, MEMBER].sort());
  expect(rows.every((r) => r.handle === r.id)).toBe(true);

  const [{ notNull }] = await db<{ notNull: boolean }[]>`
    SELECT attnotnull AS "notNull" FROM pg_attribute
    WHERE attrelid = 'swarm_members'::regclass AND attname = 'handle'`;
  expect(notNull).toBe(true);
});

test("a handle addresses exactly one member: the unique index rejects a duplicate", async () => {
  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'swarm_members_handle_key' AND indexdef LIKE '%UNIQUE%'`;
  expect(n).toBe(1);

  expect(
    await rejected(
      db`INSERT INTO swarm_members (id, status, name, handle)
         VALUES ('dupe-handle', 'inactive', 'Dupe', ${MEMBER})` as unknown as Promise<unknown>,
    ),
  ).toBe(true);
});

test("an INSERT that names no handle gets its own id — the six existing writers keep working untouched", async () => {
  // roster-seed, apply, claim, admin add, the v0 archive backfill and smoke/e2e
  // all INSERT an explicit column list without `handle`. If the default were
  // not here, every one of them would fail the NOT NULL.
  await db`INSERT INTO swarm_members (id, status, name, lens) VALUES ('newcomer', 'inactive', 'Newcomer', 'macro')`;
  const [row] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = 'newcomer'`;
  expect(row!.handle).toBe("newcomer");

  // An empty string is treated as absent too — it would be a URL segment that
  // addresses nothing.
  await db`INSERT INTO swarm_members (id, status, name, handle) VALUES ('blankish', 'inactive', 'Blankish', '')`;
  const [blank] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = 'blankish'`;
  expect(blank!.handle).toBe("blankish");

  await db`DELETE FROM swarm_members WHERE id IN ('newcomer', 'blankish')`;
});

test("a renamed handle survives re-applying 0030 verbatim — the backfill only fills NULLs", async () => {
  await db`UPDATE swarm_members SET handle = 'noop-analyst' WHERE id = ${MEMBER}`;

  await applyMigration();

  // The rename is NOT reverted to the id by the backfill, the child rows are
  // still where they were, and the signed row is still untouched.
  const [row] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${MEMBER}`;
  expect(row!.handle).toBe("noop-analyst");
  expect(await childMemberIds()).toEqual(childBefore);
  const rec = await recommendation();
  expect(rec.signature).toBe(SIGNATURE);
  expect((rec.payload as { memberId: string }).memberId).toBe(MEMBER);

  await db`UPDATE swarm_members SET handle = ${MEMBER} WHERE id = ${MEMBER}`;
});
