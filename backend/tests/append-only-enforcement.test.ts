// APPEND-ONLY ENFORCEMENT (the historical record is immutable).
//
// The swarm record is meant to behave like a chain: a published take, memo,
// session or member is history, and history is not editable by deletion. Until
// now that was CONVENTION only — `resetSessions()` was removed by hand
// (swarm/domain.ts:1219) with a comment saying "Nothing wipes rows any more",
// and nothing in the database stopped the next caller from re-adding it.
// Convention is not an invariant; a trigger is.
//
// WHAT THESE TESTS DO. For every table declared append-only, they put a real
// row in it and then ATTEMPT TO REMOVE IT — in each form the guard claims to
// cover — and prove that the removal is refused and the row is still there
// afterwards.
//
// WHY THE ASSERTIONS LOOK PEDANTIC. A refusal test is worthless if it can pass
// for a reason other than the thing under test. The first version of this file
// accepted `/…|cannot truncate/i` on the TRUNCATE cases — but
// `cannot truncate a table referenced in a foreign key constraint` is
// PostgreSQL's own RESTRICT cross-check, it carries the same SQLSTATE 0A000,
// and it fires BEFORE any `BEFORE TRUNCATE` statement trigger runs. Three of
// the twelve tables (`swarm_members`, `swarm_sessions`, `swarm_subjects`) have
// inbound foreign keys, so those cases passed on a stock-Postgres restriction
// and would have passed with migration 0032 deleted. Every assertion below now
// matches `rm_append_only_guard()`'s OWN message — table name and TG_OP — so a
// green result can only mean the trigger ran. Verified by neutering
// migrations/0032_append_only_history.sql and watching every case go red.
//
// They run against the fresh ephemeral Postgres tests/preload.ts creates per
// run, in a database cloned for this file alone, so a pass here is a property
// of the migrated schema and nothing else.
import { expect, test, describe, beforeAll } from "bun:test";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

// Own database, cloned from the migrated template. This file SEEDS the
// protected tables and never cleans up after itself — deleting the fixture is
// the exact operation under test — so it must not do that in a database
// anybody else reads.
useCleanDatabase(import.meta.file);

/**
 * Tables holding the immutable record. A row here is a historical fact:
 * signed takes and the memos they cite, the sessions that produced them, the
 * members who authored them, the audit trail, the analytics series other
 * numbers are derived from, and the migration ledger itself.
 *
 * NOT listed, and each for a stated reason — this list is the spec, so an
 * exclusion has to justify itself here rather than be silently absent:
 *
 *  - `admin_session`, `admin_webauthn_challenge`, `swarm_claim_challenges`:
 *    ephemeral auth state whose PURPOSE is to be consumed or expire. A
 *    WebAuthn challenge that cannot be deleted is a replay window.
 *  - `swarm_member_keys`: rotated on re-registration (swarm/domain.ts).
 *  - `jobs`, `job_runs`, `job_schedules`: queue/coordination churn.
 *  - `raw_indicator_history`: re-derivable from its external sources, and it
 *    has a live repair path that deletes calendar-invalid rows —
 *    `verifySeedProvenance(db, clean = true)`
 *    (analytics/store/seed-provenance.ts:59), a documented one-time
 *    production cleanup. Protecting this table breaks that tool, and the data
 *    it holds can be re-fetched; signed takes cannot.
 *
 * Extending the list is one edit here plus one line in the migration — if the
 * boundary should move, move it deliberately.
 */
export const APPEND_ONLY_TABLES = [
  "swarm_members",
  "swarm_recommendations",
  "swarm_memos",
  "swarm_sessions",
  "swarm_briefs",
  "swarm_subjects",
  "swarm_session_events",
  "swarm_applications",
  "audit_log",
  "agent_activity_log",
  "regime_snapshots",
  "schema_migrations",
] as const;

type Table = (typeof APPEND_ONLY_TABLES)[number];
type Raised = { message: string; code: string | null } | null;

// One round trip for the whole vector, so "the rows survived" can be asserted
// across EVERY protected table after each attempt — a TRUNCATE ... CASCADE
// that was refused on the named table but had already emptied a cascaded one
// would show up here and nowhere else.
const COUNT_ALL = APPEND_ONLY_TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(" UNION ALL ");

async function counts(): Promise<Record<string, number>> {
  const rows = (await sql.unsafe(COUNT_ALL)) as unknown as { t: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

async function attempt(statement: string): Promise<Raised> {
  try {
    await sql.unsafe(statement);
    return null;
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return { message: err?.message ?? String(e), code: err?.code ?? null };
  }
}

/**
 * The ONLY acceptable reason a removal attempt may fail: the guard itself said
 * no. `rm_append_only_guard()` interpolates the table name and TG_OP into its
 * message, so nothing else in PostgreSQL produces this string.
 */
function expectGuardRefused(raised: Raised, table: string, op: "DELETE" | "TRUNCATE", what: string): void {
  expect(raised, `${what} must raise`).not.toBeNull();
  expect(raised!.message, `${what} must be refused BY THE GUARD, not by anything else`).toMatch(
    new RegExp(`^table "${table}" is append-only: row deletion is not permitted \\(${op}\\)`),
  );
  // 0A000 = feature_not_supported. Asserted as a pair with the message, never
  // instead of it: Postgres's own TRUNCATE-RESTRICT refusal uses 0A000 too.
  expect(raised!.code).toBe("0A000");
}

// Tables with inbound foreign keys. `TRUNCATE t` (implicitly RESTRICT) on one
// of these is refused by heap_truncate_check_FKs() before the trigger stage is
// reached, so for them the plain form cannot be evidence about migration 0032
// — the CASCADE form, which removes that objection, is.
const fkParents = new Set<string>();

// One real row per protected table, so every "the data is still there"
// assertion below is about actual data. `schema_migrations` is already
// populated by the migration runner and is deliberately not touched.
const SUBJECT = "append-only-subject";
const MEMBER = "append-only-member";
let SESSION = "";

beforeAll(async () => {
  SESSION = crypto.randomUUID();
  await sql`INSERT INTO swarm_subjects (id, name) VALUES (${SUBJECT}, 'Append Only Subject')`;
  await sql`INSERT INTO swarm_sessions (id, subject_id) VALUES (${SESSION}, ${SUBJECT})`;
  await sql`INSERT INTO swarm_members (id, name, status) VALUES (${MEMBER}, 'Append Only Member', 'inactive')`;
  await sql`INSERT INTO swarm_briefs (date, subject_id, session_id) VALUES ('2031-01-02', ${SUBJECT}, ${SESSION})`;
  await sql`
    INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, payload, signature)
    VALUES (${SESSION}, ${MEMBER}, ${SUBJECT}, '2031-01-02', 'append-only-nonce', 'neutral', '{}'::jsonb, 'sig')`;
  await sql`INSERT INTO swarm_memos (member_id, session_id, body) VALUES (${MEMBER}, ${SESSION}, 'memo body')`;
  await sql`
    INSERT INTO swarm_session_events (session_id, to_state, action, actor)
    VALUES (${SESSION}, 'scheduled', 'convene', 'append-only-test')`;
  await sql`INSERT INTO swarm_applications (payload) VALUES ('{}'::jsonb)`;
  await sql`INSERT INTO audit_log (actor, action) VALUES ('append-only-test', 'probe')`;
  await sql`INSERT INTO agent_activity_log (action_type, status) VALUES ('probe', 'success')`;
  await sql`INSERT INTO regime_snapshots (date) VALUES ('2031-01-02')`;

  const parents = (await sql`
    SELECT DISTINCT confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f'
  `) as unknown as { parent: string }[];
  for (const p of parents) fkParents.add(p.parent);
});

describe("append-only: every protected table holds data that cannot be removed", () => {
  test("the fixture actually seeded every protected table — an empty table proves nothing", async () => {
    const n = await counts();
    for (const table of APPEND_ONLY_TABLES) {
      expect(n[table], `${table} must hold at least one row before deletion is attempted`).toBeGreaterThan(0);
    }
  });

  test("the guard is installed on every protected table, as ENABLE ALWAYS", async () => {
    // tgenabled: 'O' = origin only (silently skipped under
    // session_replication_role='replica'), 'A' = ALWAYS. A guard that is only
    // 'O' is absent during exactly the restore that would erase history.
    const rows = (await sql`
      SELECT c.relname::text AS table_name, t.tgenabled::text AS enabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname = c.relname || '_append_only'
    `) as unknown as { table_name: string; enabled: string }[];
    const installed = new Map(rows.map((r) => [r.table_name, r.enabled]));
    for (const table of APPEND_ONLY_TABLES) {
      expect(installed.get(table), `${table} must carry an append-only trigger`).toBe("A");
    }
  });

  for (const table of APPEND_ONLY_TABLES as readonly Table[]) {
    test(`DELETE FROM ${table} is refused and the rows survive`, async () => {
      const before = await counts();
      const raised = await attempt(`DELETE FROM ${table}`);
      expectGuardRefused(raised, table, "DELETE", `DELETE FROM ${table}`);
      expect(await counts(), "a refused DELETE must not have removed anything").toEqual(before);
    });

    test(`DELETE FROM ${table} WHERE false is refused (the OPERATION, not the match)`, async () => {
      // A DELETE that matches NOTHING must still be refused: the guard is on
      // the operation, not on whether it happened to find a row. Anything
      // narrower can be walked past with a WHERE clause that matches later.
      const before = await counts();
      const raised = await attempt(`DELETE FROM ${table} WHERE false`);
      expectGuardRefused(raised, table, "DELETE", `DELETE FROM ${table} WHERE false`);
      expect(await counts()).toEqual(before);
    });

    test(`TRUNCATE ${table} CASCADE is refused and the rows survive`, async () => {
      // CASCADE is the dangerous form AND the discriminating one: it removes
      // the foreign-key objection, so the guard is the only thing left that
      // can refuse. If migration 0032 were deleted this statement would empty
      // the table and its whole dependent closure.
      const before = await counts();
      const raised = await attempt(`TRUNCATE TABLE ${table} CASCADE`);
      expectGuardRefused(raised, table, "TRUNCATE", `TRUNCATE ${table} CASCADE`);
      expect(await counts(), "a refused TRUNCATE ... CASCADE must not have emptied anything").toEqual(before);
    });

    test(`TRUNCATE ${table} is refused and the rows survive`, async () => {
      const before = await counts();
      const raised = await attempt(`TRUNCATE TABLE ${table}`);
      expect(raised, `TRUNCATE ${table} must raise`).not.toBeNull();
      if (fkParents.has(table)) {
        // Assert the OTHER reason explicitly rather than let a permissive
        // pattern accept either: this branch is a statement about PostgreSQL,
        // not about the guard, and the CASCADE case above is what proves 0032
        // for these tables.
        expect(raised!.message).toMatch(/cannot truncate a table referenced in a foreign key constraint/);
      } else {
        expectGuardRefused(raised, table, "TRUNCATE", `TRUNCATE ${table}`);
      }
      expect(await counts()).toEqual(before);
    });

    test(`a replica-role session cannot delete from ${table}`, async () => {
      // session_replication_role='replica' is what a restore or a
      // logical-replication apply runs as, and it silently skips ordinary
      // triggers. 0031 already learned this lesson for the handle namespace
      // (ENABLE ALWAYS); the append-only guard has to hold under the same
      // condition for EVERY table or a restore can erase history without
      // raising.
      const before = await counts();
      let raised: Raised = null;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role = 'replica'");
          await tx.unsafe(`DELETE FROM ${table}`);
        });
      } catch (e) {
        const err = e as { message?: string; code?: string };
        raised = { message: err?.message ?? String(e), code: err?.code ?? null };
      }
      expectGuardRefused(raised, table, "DELETE", `replica-role DELETE FROM ${table}`);
      expect(await counts()).toEqual(before);
    });
  }

  test("the exact statement this issue exists to prevent is refused", async () => {
    // `resetSessions()`, verbatim (swarm/domain.ts:1219 records its removal).
    // RESTART IDENTITY CASCADE is what makes it total: CASCADE strips the
    // foreign-key objection that would otherwise refuse it, so with migration
    // 0032 absent this one statement empties the takes, the briefs, the
    // sessions, and everything hanging off them.
    const before = await counts();
    const raised = await attempt(
      "TRUNCATE swarm_recommendations, swarm_briefs, swarm_sessions RESTART IDENTITY CASCADE",
    );
    expectGuardRefused(raised, "swarm_recommendations", "TRUNCATE", "resetSessions()'s TRUNCATE");
    expect(await counts(), "resetSessions() must not have emptied anything").toEqual(before);
  });

  test("INSERT and UPDATE still work — append-only, not read-only", async () => {
    // The invariant is "history is not erased", NOT "the table is frozen".
    // A guard that also blocked writes would break every normal flow, so prove
    // the allowed operations still pass.
    const id = `append-only-probe-${crypto.randomUUID()}`;
    await sql`INSERT INTO swarm_members (id, name, status) VALUES (${id}, 'Append Probe', 'inactive')`;
    await sql`UPDATE swarm_members SET name = 'Append Probe 2' WHERE id = ${id}`;
    const [row] = await sql`SELECT name FROM swarm_members WHERE id = ${id}`;
    expect(row.name).toBe("Append Probe 2");
    // Deliberately NOT cleaned up: this database is thrown away at the end of
    // the run, and deleting the probe is the exact operation under test.
  });
});
