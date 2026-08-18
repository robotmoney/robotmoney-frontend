// Migration 0031 — the handle/id namespace invariant, enforced by the DATABASE
// (issue #597).
//
// WHAT THIS FILE IS. 0030 claimed "a handle is a public URL segment: it must
// address exactly one member" and then installed a unique index over `handle`
// alone. The half it left to an application probe is the cross-namespace one:
// one member's handle equalling a DIFFERENT member's id, which makes
// /swarm/members/:ref ambiguous because that route resolves both names. 0031
// installs a BEFORE INSERT OR UPDATE trigger that refuses it in either
// direction. This file proves that against a real Postgres, and it drives the
// collision through raw SQL because no public write path can reach it (that is
// the whole finding: the state is not reachable, and nothing in the schema said
// so).
//
// WHY ITS OWN CONTAINER. Two of the assertions are only checkable on a database
// where 0031 has NOT been applied yet — that the migration refuses to install
// itself over an already-violating pair, and that it names the pair. The shared
// suite database (tests/preload.ts) has every migration applied before any test
// file loads. Same pattern, and same reason, as
// tests/swarm-member-handle-migration.test.ts.
//
// Fails loudly if Docker/Postgres is unavailable — never a silent skip.
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
// backend/scripts/lib/postgres-image.ts for the version and the -alpine
// decision, and backend/tests/postgres-version-parity.test.ts, which fails if
// a literal reappears anywhere under backend/tests/.
import { POSTGRES_IMAGE } from "../scripts/lib/postgres-image.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0031_swarm_member_handle_namespace.sql";

// The failure scenario from the issue, verbatim: A is published at 'woon',
// which is B's immutable id.
const A = "ns-a";
const B = "woon";
const B_HANDLE = "ns-b";
const SUBJECT = "handle-namespace-subject";

// A payload that NAMES its signer, so "the migration rewrote nothing" is
// checkable on the one thing a rewrite would have had to touch.
const SIGNED_PAYLOAD = {
  memberId: B,
  date: "2026-05-26",
  subjectId: SUBJECT,
  nonce: "handle-namespace-nonce",
  stance: "constructive",
  confidence: 0.7,
  body: "signed before 0031 existed",
};
const SIGNATURE = "c2lnbmF0dXJlLW92ZXItdGhlLXBheWxvYWQtYWJvdmU=";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

let containerName: string;
let db: postgres.Sql<{}>;
let recommendationId: string;
// The signed payload as the SERVER renders it, snapshotted before 0031 runs.
// jsonb does not preserve key order, so "unchanged" has to be compared against
// the pre-migration text rather than against the literal above.
let payloadTextBefore: string;

async function applyMigration(): Promise<void> {
  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await db.begin(async (tx) => { await tx.unsafe(ddl); });
}

// postgres.js tagged-template results are lazy thenables, not plain Promises;
// bun:test's `expect(...).rejects` wrapper hangs against them. Returns the
// error so a test can assert on SQLSTATE / constraint name / message, which is
// the difference between "the write failed" and "the write failed for the
// reason this migration exists".
async function rejection(run: () => Promise<unknown>): Promise<Record<string, any>> {
  try {
    await run();
  } catch (e) {
    return e as Record<string, any>;
  }
  throw new Error("expected the write to be refused, but it succeeded");
}

beforeAll(async () => {
  const port = await freePort();
  containerName = `rmtest_handle_namespace_${crypto.randomUUID().slice(0, 8)}`;
  const up = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
    "-p", `${port}:5432`, POSTGRES_IMAGE,
  ]);
  if (up.exitCode !== 0) {
    throw new Error(
      `swarm-member-handle-namespace-migration test requires Docker+Postgres but the container failed to start:\n${up.stderr.toString()}`,
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

  // Everything up to but NOT including 0031 — a genuine pre-0031 database.
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  if (!files.includes(MIGRATION)) throw new Error(`${MIGRATION} not found in backend/migrations`);
  const pre = files.filter((f) => f < MIGRATION);
  expect(pre.length).toBeGreaterThan(0);
  // The runner (src/db/migrate.ts) applies backend/migrations/*.sql in filename
  // order, so 0031 running AFTER 0030 is a property of the name. Assert it here
  // rather than trusting the number: 0029 is used twice on main, so "the next
  // free number" is not self-evident.
  expect(pre[pre.length - 1]).toBe("0030_swarm_member_handle.sql");
  for (const file of pre) {
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    await db.begin(async (tx) => { await tx.unsafe(ddl); });
  }

  await db`INSERT INTO swarm_subjects (id, status, name) VALUES (${SUBJECT}, 'active', 'Handle Namespace Subject')`;
  await db`INSERT INTO swarm_members (id, status, name) VALUES (${A}, 'active', 'Member A')`;
  await db`INSERT INTO swarm_members (id, status, name) VALUES (${B}, 'active', 'Member B')`;
  // B is renamed — the ordinary thing 0030 exists for. It is ALSO what frees
  // 'woon' in the handle namespace: while B still published under its own id,
  // 0030's unique index happened to block A from taking that name, which is
  // why the hole this migration closes only opens after a rename.
  await db`UPDATE swarm_members SET handle = ${B_HANDLE} WHERE id = ${B}`;
  const [session] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${SUBJECT}, '2026-05-26T09:00:00Z', 'Handle Namespace Subject', 'published') RETURNING id`;
  const [rec] = await db<{ id: string }[]>`
    INSERT INTO swarm_recommendations
      (session_id, member_id, subject_id, date, nonce, stance, confidence, body, payload, signature, verified)
    VALUES (${session!.id}, ${B}, ${SUBJECT}, '2026-05-26', ${SIGNED_PAYLOAD.nonce},
            ${SIGNED_PAYLOAD.stance}, ${SIGNED_PAYLOAD.confidence}, ${SIGNED_PAYLOAD.body},
            ${db.json(SIGNED_PAYLOAD as any)}, ${SIGNATURE}, true)
    RETURNING id`;
  recommendationId = rec!.id;
  const [before] = await db<{ payload: string }[]>`
    SELECT payload::text AS payload FROM swarm_recommendations WHERE id = ${recommendationId}`;
  payloadTextBefore = before!.payload;
}, 120_000);

afterAll(async () => {
  try { await db?.end({ timeout: 5 }); } catch { /* closing a dead pool is not a failure */ }
  if (containerName) Bun.spawnSync(["docker", "rm", "-f", containerName]);
});

// ── DEPLOYING OVER DATA THAT ALREADY VIOLATES THE INVARIANT ─────────────────
// This test must run FIRST: it is the only point at which 0031 has not been
// applied, and it leaves the database with 0031 installed for everything below.

test("0031 refuses to install over an already-colliding pair, names it, and applies once repaired", async () => {
  // Reachable on a pre-0031 database: 0030's unique index constrains handle
  // against handle only, and 'woon' here is A's handle and B's id.
  await db`UPDATE swarm_members SET handle = ${B} WHERE id = ${A}`;

  const err = await rejection(applyMigration);
  // Named, both members, so an operator knows which two rows to look at.
  expect(String(err.message)).toContain(A);
  expect(String(err.message)).toContain(B);
  expect(String(err.message)).toContain("handle");

  // Nothing was installed and nothing was silently repaired: refusing is the
  // point, because auto-repair would repoint a published URL by guesswork.
  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_trigger
    WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(n).toBe(0);
  const [stillColliding] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${A}`;
  expect(stillColliding!.handle).toBe(B);

  // The operator's fix: change one of the two public names. Then it installs.
  await db`UPDATE swarm_members SET handle = ${A} WHERE id = ${A}`;
  await applyMigration();
  const [{ n: after }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_trigger
    WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(after).toBe(1);
});

test("0031 rewrites no id, no child FK value and no signed byte", async () => {
  const [member] = await db<{ id: string; handle: string }[]>`
    SELECT id, handle FROM swarm_members WHERE id = ${B}`;
  expect(member!.id).toBe(B);
  expect(member!.handle).toBe(B_HANDLE);

  const [rec] = await db<{ member_id: string; payload: string; signature: string }[]>`
    SELECT member_id, payload::text AS payload, signature
    FROM swarm_recommendations WHERE id = ${recommendationId}`;
  expect(rec!.member_id).toBe(B);
  expect(rec!.signature).toBe(SIGNATURE);
  // Byte-for-byte, against the pre-0031 rendering: the string a historical
  // signature was made over is the one thing a namespace fix must never touch.
  expect(rec!.payload).toBe(payloadTextBefore);
  expect(JSON.parse(rec!.payload).memberId).toBe(B);
});

// ── TRIGGER FIRING ORDER ────────────────────────────────────────────────────

test("the assertion trigger fires AFTER 0030's default-handle trigger, by name", async () => {
  // Postgres fires BEFORE row triggers in alphabetical order by trigger name.
  // 0030's trigger is what fills `NEW.handle := NEW.id` for the six writers
  // that insert no handle; if the assertion ran first it would inspect a NULL
  // handle. Read the ACTUAL order the server will use out of pg_trigger rather
  // than asserting the naming convention we intended.
  const rows = await db<{ tgname: string; timing: string; level: string }[]>`
    SELECT tgname,
           CASE WHEN (tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
           CASE WHEN (tgtype & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS level
    FROM pg_trigger
    WHERE tgrelid = 'swarm_members'::regclass AND NOT tgisinternal
    ORDER BY tgname`;
  const names = rows.map((r) => r.tgname);
  expect(names).toContain("swarm_members_default_handle_trigger");
  expect(names).toContain("swarm_members_handle_namespace_trigger");
  // Both are BEFORE ROW triggers, so name order IS firing order...
  expect(rows.every((r) => r.timing === "BEFORE" && r.level === "ROW")).toBe(true);
  // ...and the default runs first.
  expect(names.indexOf("swarm_members_default_handle_trigger"))
    .toBeLessThan(names.indexOf("swarm_members_handle_namespace_trigger"));

  // The behavioural consequence of that order: an insert naming no handle is
  // defaulted to its own id and then passes the assertion — it is not refused
  // for a NULL handle, and it is not waved through unchecked either (the next
  // test refuses the same insert once its defaulted handle would collide).
  await db`INSERT INTO swarm_members (id, status, name) VALUES ('ns-plain', 'inactive', 'Plain')`;
  const [plain] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = 'ns-plain'`;
  expect(plain!.handle).toBe("ns-plain");
  await db`DELETE FROM swarm_members WHERE id = 'ns-plain'`;
});

// ── AC1: THE DATABASE REFUSES THE COLLISION, IN BOTH DIRECTIONS ─────────────

test("an UPDATE setting a handle to another member's id is refused, as 23505 on a named constraint", async () => {
  // This is the exact write the pre-0031 database allowed and the application
  // probe alone was standing in front of.
  const err = await rejection(() => db`UPDATE swarm_members SET handle = ${B} WHERE id = ${A}`);
  expect(err.code).toBe("23505");
  // The name the API's isHandleUniqueViolation() keys on — without it this is a
  // 500 instead of a 409.
  expect(err.constraint_name ?? err.constraint).toBe("swarm_members_handle_namespace");

  const [row] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${A}`;
  expect(row!.handle).toBe(A);
});

test("an INSERT whose id is already another member's handle is refused", async () => {
  // The mirror direction, and the one that keeps the invariant true regardless
  // of which of the two rows is written second. A is published at 'ns-published'
  // — a name that is nobody's id yet.
  await db`UPDATE swarm_members SET handle = 'ns-published' WHERE id = ${A}`;

  // With an EXPLICIT handle, so 0030's unique index (handle vs handle) has
  // nothing to say: only the trigger's `m.handle = NEW.id` clause refuses this.
  const explicit = await rejection(() =>
    db`INSERT INTO swarm_members (id, status, name, handle)
       VALUES ('ns-published', 'inactive', 'Impostor', 'ns-impostor')`);
  expect(explicit.code).toBe("23505");
  expect(explicit.constraint_name ?? explicit.constraint).toBe("swarm_members_handle_namespace");

  // And with no handle at all, where 0030's default makes handle = id.
  const defaulted = await rejection(() =>
    db`INSERT INTO swarm_members (id, status, name) VALUES ('ns-published', 'inactive', 'Impostor')`);
  expect(defaulted.code).toBe("23505");

  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_members WHERE id = 'ns-published'`;
  expect(n).toBe(0);

  await db`UPDATE swarm_members SET handle = ${A} WHERE id = ${A}`;
});

test("an INSERT whose handle is already another member's id is refused", async () => {
  const err = await rejection(() =>
    db`INSERT INTO swarm_members (id, status, name, handle)
       VALUES ('ns-newcomer', 'inactive', 'Newcomer', ${B})`);
  expect(err.code).toBe("23505");
  expect(err.constraint_name ?? err.constraint).toBe("swarm_members_handle_namespace");
});

test("the trigger refuses only collisions: legitimate renames and unrelated edits still write", async () => {
  // A rename to a name nobody holds under EITHER name.
  await db`UPDATE swarm_members SET handle = 'ns-a-renamed' WHERE id = ${A}`;
  const [renamed] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${A}`;
  expect(renamed!.handle).toBe("ns-a-renamed");

  // Re-asserting a member's OWN handle is not a collision with itself.
  await db`UPDATE swarm_members SET handle = 'ns-a-renamed' WHERE id = ${A}`;

  // A row keeps its id as its own handle — `id = NEW.handle AND id <> NEW.id`
  // must not match the row being written.
  await db`UPDATE swarm_members SET status = 'inactive' WHERE id = ${B}`;
  await db`UPDATE swarm_members SET status = 'active' WHERE id = ${B}`;

  await db`UPDATE swarm_members SET handle = ${A} WHERE id = ${A}`;
});

// ── THE WRITE PATHS THAT DO NOT GO THROUGH A CLIENT SESSION ────────────────

test("session_replication_role = replica does not bypass the trigger — a restore cannot install the pair", async () => {
  // `pg_restore --disable-triggers` and a logical-replication apply worker both
  // run under this role, and it skips triggers whose pg_trigger.tgenabled is
  // 'O' — the value CREATE TRIGGER gives them. Observed on a real server before
  // 0031 carried `ALTER TABLE ... ENABLE ALWAYS TRIGGER`: the forbidden pair
  // went in with `INSERT 0 1` and no refusal, and nothing downstream re-checked
  // it, because migrate.ts never re-runs a file already in schema_migrations.
  //
  // Asserted BEHAVIOURALLY first and on the catalogue second: with the ALTER
  // removed from 0031 both rejection() calls below fail with "expected the
  // write to be refused, but it succeeded", which is the finding itself rather
  // than a restatement of the DDL.

  // Direction 1, under the replica role: a handle moving onto another member's id.
  const renameErr = await rejection(() =>
    db.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE swarm_members SET handle = ${B} WHERE id = ${A}`;
    }));
  expect(renameErr.code).toBe("23505");
  expect(renameErr.constraint_name ?? renameErr.constraint).toBe("swarm_members_handle_namespace");

  // Direction 2, under the replica role: the reviewer's observed bypass verbatim
  // — a row arriving with an id that is already another member's handle. 0030's
  // default-handle trigger is still ORIGIN-only, so the handle is supplied
  // explicitly here, exactly as a restore's COPY/INSERT would supply it.
  const insertErr = await rejection(() =>
    db.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO swarm_members (id, status, name, handle)
               VALUES (${B_HANDLE}, 'inactive', 'Bypasser', 'ns-bypass')`;
    }));
  expect(insertErr.code).toBe("23505");
  expect(insertErr.constraint_name ?? insertErr.constraint).toBe("swarm_members_handle_namespace");

  // Refused, not merely logged: neither write landed.
  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_members WHERE id = ${B_HANDLE}`;
  expect(n).toBe(0);
  const [a] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${A}`;
  expect(a!.handle).toBe(A);

  // And the mechanism, so a future edit that reverts the ALTER is named rather
  // than merely observed: 'A' = ALWAYS, 'O' = ORIGIN (what CREATE TRIGGER gives).
  const [trg] = await db<{ tgenabled: string }[]>`
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(trg!.tgenabled).toBe("A");
});

// ── THE COLLIDED STATE IS REPAIRABLE, AND FROM THE RIGHT ROW ────────────────

test("in a collided state the hijacked member can still rename itself, and the repair is the OTHER row", async () => {
  // The pair is unreachable through the trigger — that is the point of the file
  // — so force it for exactly one statement. Restored with ENABLE ALWAYS, not a
  // plain ENABLE: the latter silently downgrades tgenabled from 'A' back to 'O'
  // and would hand every later test the bypass this migration just closed.
  await db`ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_handle_namespace_trigger`;
  try {
    await db`UPDATE swarm_members SET handle = ${B} WHERE id = ${A}`;
  } finally {
    await db`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger`;
  }
  const [{ tgenabled }] = await db<{ tgenabled: string }[]>`
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(tgenabled).toBe("A");

  // B is the VICTIM: A publishes under B's id. Renaming B's own handle to a name
  // nobody holds under either namespace introduces no collision and must be
  // allowed. Before the `id_arrives` gate the `m.handle = NEW.id` clause refused
  // it — and every other candidate handle identically, since it depends only on
  // NEW.id, which never moves — while the admin surface reported that as
  // `409 handle already taken`, naming a handle nobody held and pointing at the
  // wrong row.
  await db`UPDATE swarm_members SET handle = 'ns-b-renamed' WHERE id = ${B}`;
  const [victim] = await db<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${B}`;
  expect(victim!.handle).toBe("ns-b-renamed");

  // Unrelated edits on the victim keep working too (the early return).
  await db`UPDATE swarm_members SET status = 'inactive' WHERE id = ${B}`;

  // The write that WOULD deepen the collision is still refused while it lasts:
  // a third member cannot also take B's id.
  const third = await rejection(() =>
    db`INSERT INTO swarm_members (id, status, name, handle) VALUES ('ns-third', 'inactive', 'Third', ${B})`);
  expect(third.code).toBe("23505");

  // THE REPAIR — move A's handle off B's id. That is the row that has to change,
  // and the refusal message says so by naming the other member.
  await db`UPDATE swarm_members SET handle = ${A} WHERE id = ${A}`;
  const err = await rejection(() => db`UPDATE swarm_members SET handle = ${B} WHERE id = ${A}`);
  expect(err.code).toBe("23505");
  expect(String(err.message)).toContain(B);

  await db`UPDATE swarm_members SET status = 'active', handle = ${B_HANDLE} WHERE id = ${B}`;
});

test("re-applying 0031 verbatim is a no-op — the runner may replay it on any boot", async () => {
  await applyMigration();
  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_trigger
    WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(n).toBe(1);
  // Including the ALWAYS state: a replay must not leave the trigger back at
  // ORIGIN, or the replica-role bypass silently reopens on the next boot.
  const [{ tgenabled }] = await db<{ tgenabled: string }[]>`
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(tgenabled).toBe("A");
  const err = await rejection(() => db`UPDATE swarm_members SET handle = ${B} WHERE id = ${A}`);
  expect(err.code).toBe("23505");
});
