// The event log is protected by GRANT, and only rm_owner prunes it — issue
// #1026 criterion 104, decision D53 (2).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §6.3 ("Retention. The
// event log is append-only and is retained at least as far back as the oldest
// cursor the API may still be asked to serve. Pruning above that point is
// permitted; pruning below it is forbidden."), D52, and D53 (2): the retention
// rule beats migration 0072's triggers. Migration 0080 drops them; DELETE and
// TRUNCATE stay revoked from rm_app and rm_worker, grant reconciliation
// re-asserts that revoke from its own list, and preflight check 2 refuses
// either grant.
//
// EVERY REFUSAL HERE IS A REAL LOGIN. The runtime roles connect as themselves
// and run the statement; the answer asserted is SQLSTATE 42501 from the
// executor's privilege check. A superuser connection that merely inspected the
// ACL would pass on a database whose grants said one thing and whose triggers
// did another.
//
// WHAT THIS FILE DOES NOT OWN. The served side of a pruned cursor — the resync
// a subscriber below the floor receives — is backend/tests/api-event-stream.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import * as domain from "../src/swarm/domain.ts";
import {
  APPEND_ONLY_RELEASED,
  APPEND_ONLY_TABLE_MIGRATION,
  APPEND_ONLY_TABLES,
} from "../src/db/append-only-guard.ts";
import { APPEND_ONLY_TABLES as POSTFLIGHT_ROSTER } from "../scripts/upgrades/0.2.2-to-0.3.0/release.ts";
import { findDenylistViolations, RUNTIME_DELETE_REVOKED_TABLES } from "../src/db/preflight.ts";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

const PASSWORD = `rm_stream_retention_${crypto.randomUUID().slice(0, 8)}`;
const RUNTIME = ["rm_app", "rm_worker"] as const;
type Runtime = (typeof RUNTIME)[number];
const logins = new Map<Runtime, postgres.Sql<{}>>();

beforeAll(async () => {
  const [{ db }] = (await sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  for (const role of RUNTIME) {
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${PASSWORD}'`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${db}`;
    url.username = role;
    url.password = PASSWORD;
    logins.set(role, postgres(url.toString(), { max: 1, onnotice: () => {} }));
  }
});

afterAll(async () => {
  for (const login of logins.values()) await login.end({ timeout: 5 });
});

async function sqlstate(db: postgres.Sql<{}>, statement: string): Promise<string | null> {
  try {
    await db.unsafe(statement);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-sqlstate";
  }
}

/** Commit `n` real transitions' events: an open, then turnovers. */
async function commitEvents(prefix: string, turnovers: number): Promise<void> {
  const subjectId = await activeSubject(prefix, 600);
  const opened = await domain.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  let open = opened.sessionId;
  for (let i = 0; i < turnovers; i++) {
    const t = await domain.turnOverEpoch(subjectId, open);
    if (!t.ok) throw new Error("turnOverEpoch failed");
    open = t.openedSessionId;
  }
}

/** rm_owner, the only role that may prune (D53 (2)), in one transaction. */
async function asOwner<T>(fn: (tx: postgres.TransactionSql<{}>) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    return fn(tx as unknown as postgres.TransactionSql<{}>);
  })) as T;
}

const count = async (): Promise<number> =>
  Number(((await sql`SELECT count(*)::int AS n FROM swarm_stream_events`) as unknown as { n: number }[])[0]!.n);

test("the event log has left every append-only roster, and is on the grant-only list instead", () => {
  expect((APPEND_ONLY_TABLES as readonly string[]).includes("swarm_stream_events")).toBe(false);
  expect("swarm_stream_events" in APPEND_ONLY_TABLE_MIGRATION).toBe(false);
  expect((POSTFLIGHT_ROSTER as readonly string[]).includes("swarm_stream_events")).toBe(false);
  expect(APPEND_ONLY_RELEASED.swarm_stream_events).toEqual({
    declaredBy: "0072_drop_swarm_schedules.sql",
    releasedBy: "0080_stream_events_grant_only.sql",
  });
  expect(RUNTIME_DELETE_REVOKED_TABLES).toContain("swarm_stream_events");
});

test("the migrated log carries no append-only trigger: nothing but the grant stands in rm_owner's way", async () => {
  const triggers = (await sql`
    SELECT t.tgname::text AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND c.relname = 'swarm_stream_events'`) as unknown as { name: string }[];
  expect(triggers).toEqual([]);
});

for (const role of RUNTIME) {
  test(`${role}, logged in as itself, gets 42501 for DELETE and TRUNCATE on the log and its counter`, async () => {
    await commitEvents(`ret_${role}`, 2);
    const before = await count();
    expect(before).toBeGreaterThan(0);
    const db = logins.get(role)!;
    const [{ who }] = (await db`SELECT current_user AS who`) as unknown as { who: string }[];
    expect(who).toBe(role);
    expect({
      "DELETE swarm_stream_events": await sqlstate(db, "DELETE FROM swarm_stream_events WHERE seq = 1"),
      "DELETE swarm_stream_events (all)": await sqlstate(db, "DELETE FROM swarm_stream_events"),
      "TRUNCATE swarm_stream_events": await sqlstate(db, "TRUNCATE swarm_stream_events"),
      "DELETE swarm_stream_head": await sqlstate(db, "DELETE FROM swarm_stream_head"),
      "TRUNCATE swarm_stream_head": await sqlstate(db, "TRUNCATE swarm_stream_head"),
    }).toEqual({
      "DELETE swarm_stream_events": "42501",
      "DELETE swarm_stream_events (all)": "42501",
      "TRUNCATE swarm_stream_events": "42501",
      "DELETE swarm_stream_head": "42501",
      "TRUNCATE swarm_stream_head": "42501",
    });
    expect(await count()).toBe(before);
    // Reading stays open: rm_app serves the stream, and rm_worker's SELECT is
    // 0062's.
    expect(await sqlstate(db, "SELECT seq FROM swarm_stream_events LIMIT 1")).toBeNull();
  });
}

test("rm_app cannot rewind the counter either: it only moves forward", async () => {
  const app = logins.get("rm_app")!;
  expect(await sqlstate(app, "UPDATE swarm_stream_head SET seq = seq - 1")).toBe("23514");
  expect(await sqlstate(app, "UPDATE swarm_stream_head SET seq = 0")).toBe("23514");
});

test("rm_owner CAN prune, and a cursor at the new floor is still served", async () => {
  await commitEvents("ret_owner_prune", 3);
  const head = await domain.streamHeadSequence();
  // NOT PROVED HERE: that a prune stays below the oldest cursor the API may
  // still be asked to serve. Nothing records that cursor or bounds a DELETE by
  // it; this case picks head - 2 by hand. It proves only the grant half (the
  // owner may DELETE) and the served half (the new floor is honest).
  const oldestServable = head - 2;
  const pruned = await asOwner(
    async (tx) => (await tx`DELETE FROM swarm_stream_events WHERE seq <= ${oldestServable} RETURNING seq`).length,
  );
  expect(pruned).toBe(oldestServable);
  expect(await domain.retainedFloor()).toBe(oldestServable + 1);
  expect(await domain.resyncReasonFor(oldestServable)).toBeNull();
  expect((await domain.eventsAbove(oldestServable)).map((e) => e.seq)).toEqual([head - 1, head]);
  // One below it is now honestly out of reach, and says so.
  expect(await domain.resyncReasonFor(oldestServable - 1)).toBe("log_truncated");
});

test("a prune never renumbers: with every row gone the next event continues from the counter, not MAX + 1", async () => {
  // Criterion 93's closing instruction: "Built with MAX + 1 under an advisory
  // lock — verify that is equivalent to the counter row or align it." It was
  // equivalent only while nothing was pruned; this is the case that separates
  // them, so it is the case that shows the counter was the right alignment.
  await commitEvents("ret_renumber", 1);
  const head = await domain.streamHeadSequence();
  await asOwner(async (tx) => tx`DELETE FROM swarm_stream_events`);
  expect(await count()).toBe(0);
  const [{ maxPlusOne }] = (await sql`
    SELECT COALESCE(MAX(seq), 0) + 1 AS "maxPlusOne" FROM swarm_stream_events`) as unknown as { maxPlusOne: number }[];
  expect(Number(maxPlusOne)).toBe(1); // what the old numbering would have handed out again

  await commitEvents("ret_renumber_after", 1);
  const next = (await domain.eventsAbove(head)).map((e) => e.seq);
  expect(next).toEqual([head + 1]);
  expect(await domain.streamHeadSequence()).toBe(head + 1);
  // A subscriber that held `head` as its cursor is still served, not skipped.
  expect(await domain.resyncReasonFor(head)).toBeNull();
});

test("grant reconciliation re-asserts the revoke from its own list, not from the append-only one", async () => {
  const grantsSql = (await loadSnapshot()).grantsSql;
  const arrayOf = (name: string): string[] => {
    const block = new RegExp(`${name} text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(grantsSql.replace(/--.*$/gm, ""));
    expect(block, `grants.sql must declare ${name}`).not.toBeNull();
    return [...block![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  };
  expect(arrayOf("append_only")).not.toContain("swarm_stream_events");
  expect(arrayOf("runtime_delete_revoked")).toContain("swarm_stream_events");

  const held = async (): Promise<string[]> =>
    ((await sql`
      SELECT r.rolname || ':' || p.privilege AS item
        FROM (VALUES ('rm_app'), ('rm_worker')) AS r(rolname)
        CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS p(privilege)
       WHERE has_table_privilege(r.rolname, 'public.swarm_stream_events', p.privilege)
       ORDER BY 1`) as unknown as { item: string }[]).map((r) => r.item);

  // A hand-run grant re-widens both roles (the drift reconciliation exists for).
  await sql.unsafe("GRANT DELETE, TRUNCATE ON swarm_stream_events TO rm_app, rm_worker");
  try {
    expect(await held()).toEqual(["rm_app:DELETE", "rm_app:TRUNCATE", "rm_worker:DELETE", "rm_worker:TRUNCATE"]);
    await asOwner(async (tx) => tx.unsafe(grantsSql));
    expect(await held()).toEqual([]);
    expect(await sqlstate(logins.get("rm_app")!, "DELETE FROM swarm_stream_events WHERE seq = 1")).toBe("42501");
  } finally {
    await sql.unsafe("REVOKE DELETE, TRUNCATE ON swarm_stream_events FROM rm_app, rm_worker");
  }
});

test("grant reconciliation gives rm_app exactly SELECT and UPDATE on the counter row, as 0081 does — never INSERT", async () => {
  const grantsSql = (await loadSnapshot()).grantsSql;
  const held = async (): Promise<string[]> =>
    ((await sql`
      SELECT r.rolname || ':' || p.privilege AS item
        FROM (VALUES ('rm_app'), ('rm_worker'), ('rm_readonly')) AS r(rolname)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(privilege)
       WHERE has_table_privilege(r.rolname, 'public.swarm_stream_head', p.privilege)
       ORDER BY 1`) as unknown as { item: string }[]).map((r) => r.item);
  const exactly0081 = ["rm_app:SELECT", "rm_app:UPDATE", "rm_readonly:SELECT", "rm_worker:SELECT"];
  expect(await held()).toEqual(exactly0081);
  // Red control: a hand-widened INSERT is taken back, and a reconciliation run
  // on a clean database adds nothing (the ordinary sweep would add INSERT).
  await sql.unsafe("GRANT INSERT ON swarm_stream_head TO rm_app, rm_worker");
  try {
    expect(await held()).toContain("rm_app:INSERT");
    await asOwner(async (tx) => tx.unsafe(grantsSql));
    expect(await held()).toEqual(exactly0081);
    await asOwner(async (tx) => tx.unsafe(grantsSql));
    expect(await held()).toEqual(exactly0081);
  } finally {
    await sql.unsafe("REVOKE INSERT ON swarm_stream_head FROM rm_app, rm_worker");
  }
});

test("preflight check 2 refuses a runtime DELETE grant on the log, which it no longer finds on the clean clone", async () => {
  const onLog = async () =>
    (await findDenylistViolations(sql, RUNTIME)).filter((v) => v.object === "swarm_stream_events");
  // Control: the migrated clone is clean.
  expect(await onLog()).toEqual([]);
  await sql.unsafe("GRANT DELETE ON swarm_stream_events TO rm_app");
  await sql.unsafe("GRANT TRUNCATE ON swarm_stream_events TO rm_worker");
  try {
    const found = (await onLog()).map((v) => `${v.rule} ${v.role}`).sort();
    expect(found).toEqual(["append_only_write rm_app", "append_only_write rm_worker"]);
  } finally {
    await sql.unsafe("REVOKE DELETE, TRUNCATE ON swarm_stream_events FROM rm_app, rm_worker");
  }
  expect(await onLog()).toEqual([]);
});

test("migration 0081 seeds the counter from the log it finds, so an upgraded database never reissues a number", async () => {
  // A database that reached 0080 numbered its log with MAX + 1. 0081 must start
  // the counter at that MAX, or the first event after the upgrade would take a
  // number a subscriber already holds. Rebuilt here from 0081's own text on a
  // log whose rows are already numbered.
  await commitEvents("ret_seed", 2);
  const [{ max }] = (await sql`SELECT MAX(seq)::int AS max FROM swarm_stream_events`) as unknown as { max: number }[];
  expect(max).toBeGreaterThan(0);
  const ddl = readFileSync(join(import.meta.dir, "..", "migrations", "0081_stream_event_counter.sql"), "utf8");
  expect(ddl.split("\n")[0]).toBe("-- compat: breaking");
  // As the migrate step runs it: one transaction, as rm_owner.
  await asOwner(async (tx) => {
    await tx.unsafe("DROP TABLE swarm_stream_head CASCADE");
    await tx.unsafe(ddl);
  });
  expect(await domain.streamHeadSequence()).toBe(max);
  await commitEvents("ret_seed_after", 1);
  expect(await domain.streamHeadSequence()).toBe(max + 1);
  // The grants the file itself gives, as reconciliation would re-assert them.
  expect(await sqlstate(logins.get("rm_app")!, "SELECT seq FROM swarm_stream_head")).toBeNull();
  expect(await sqlstate(logins.get("rm_worker")!, "UPDATE swarm_stream_head SET seq = seq + 1")).toBe("42501");
});

test("migration 0080 is what dropped the triggers, and it keeps the revoke in the same file", () => {
  const ddl = readFileSync(join(import.meta.dir, "..", "migrations", "0080_stream_events_grant_only.sql"), "utf8");
  expect(ddl.split("\n")[0]).toBe("-- compat: breaking");
  expect(ddl).toContain("DROP TRIGGER IF EXISTS swarm_stream_events_append_only ON swarm_stream_events;");
  expect(ddl).toContain("DROP TRIGGER IF EXISTS swarm_stream_events_append_only_row ON swarm_stream_events;");
  expect(ddl).toContain("REVOKE DELETE, TRUNCATE ON swarm_stream_events FROM rm_app, rm_worker;");
});
