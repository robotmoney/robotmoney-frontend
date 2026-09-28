// The event log is protected by GRANT, and only rm_owner prunes it, through
// the manual `bun run prune` — issue #1026 criterion 104, decisions D53 (2)
// and D55 (12).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §6.3 Retention ("No
// runtime role may delete from the event log. Only a manual, receipted operator
// command prunes it ... It deletes only events older than a retention window of
// at least 7 days."), D55 (12), which supersedes D52's retention bullet and
// D53 (2)'s bound of the oldest servable cursor, and D53 (2): the retention
// rule beats migration 0072's triggers. Migration 0080 drops them; DELETE and
// TRUNCATE stay revoked from rm_app and rm_worker (0089 revokes both from every
// runtime role on every table), grant reconciliation re-asserts that on every
// relation, and preflight check 2 refuses either grant. The command itself is
// backend/scripts/prune.ts; tests/prune-command.test.ts proves its terminal,
// lock, window and receipt, and this file proves what its prune does to the
// log and to a subscriber's cursor.
//
// EVERY REFUSAL HERE IS A REAL LOGIN. The runtime roles connect as themselves
// and run the statement; the answer asserted is SQLSTATE 42501 from the
// executor's privilege check. A superuser connection that merely inspected the
// ACL would pass on a database whose grants said one thing and whose triggers
// did another.
//
// WHAT THIS FILE DOES NOT OWN. The served side of a pruned cursor — the resync
// frame a subscriber below the floor receives on the wire — is
// backend/tests/api-event-stream.test.ts. The floor check it serves from
// (`resyncReasonFor`) is asserted here, after a real prune.
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
import { MIN_RETENTION_DAYS, runPrune } from "../scripts/prune.ts";
import { restoreRoles, saveRoles, type SavedRole } from "./fixtures/releases/release-fixture.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";
import { withTargetLock } from "./support/target-lock.ts";

useCleanDatabase(import.meta.file);

const PASSWORD = `rm_stream_retention_${crypto.randomUUID().slice(0, 8)}`;
const RUNTIME = ["rm_app", "rm_worker"] as const;
type Runtime = (typeof RUNTIME)[number];
const logins = new Map<Runtime, postgres.Sql<{}>>();
/** A real rm_owner login, the one `bun run prune` opens with the typed password. */
let owner: postgres.Sql<{}>;
/** The four roles as this file found them: cluster-wide, so put back exactly. */
let savedRoles: SavedRole[] = [];
let databaseUrl = "";

beforeAll(async () => {
  // rm_owner, rm_app and rm_worker are cluster-wide and backend `bun test` runs
  // every file in one process: record their LOGIN attribute and stored password
  // and put back exactly those (rule (j): no pass may depend on file order).
  savedRoles = await saveRoles(sql as unknown as postgres.Sql<{}>);
  const [{ db }] = (await sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${db}`;
  databaseUrl = url.toString();
  for (const role of RUNTIME) {
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${PASSWORD}'`);
    url.username = role;
    url.password = PASSWORD;
    logins.set(role, postgres(url.toString(), { max: 1, onnotice: () => {} }));
  }
  await sql.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${PASSWORD}'`);
  url.username = "rm_owner";
  url.password = PASSWORD;
  owner = postgres(url.toString(), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  for (const login of logins.values()) await login.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  await restoreRoles(sql as unknown as postgres.Sql<{}>, savedRoles);
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

test("the prune `bun run prune` runs, as a real rm_owner login, removes only events older than the 7-day window, and a cursor below the new floor gets log_truncated", async () => {
  await commitEvents("ret_owner_prune", 3);
  const head = await domain.streamHeadSequence();
  // The log's age, planted by rm_owner: everything up to head - 2 is 8 days
  // old, head - 1 is 6 days old (inside the window), head is new.
  await asOwner(async (tx) => {
    await tx`UPDATE swarm_stream_events SET committed_at = now() - interval '8 days' WHERE seq <= ${head - 2}`;
    await tx`UPDATE swarm_stream_events SET committed_at = now() - interval '6 days' WHERE seq = ${head - 1}`;
  });
  const [{ who }] = (await owner`SELECT current_user AS who`) as unknown as { who: string }[];
  expect(who).toBe("rm_owner");

  const pruned = await withTargetLock(databaseUrl, (lock) => runPrune(owner, { windowDays: MIN_RETENTION_DAYS, lock }));

  const events = pruned.find((t) => t.table === "swarm_stream_events")!;
  expect({ rows: events.rows, windowDays: events.windowDays, predicate: events.predicate }).toEqual({
    rows: head - 2,
    windowDays: 7,
    predicate: "committed_at < <cutoff>",
  });
  // Nothing younger than the window went: the 6-day-old event is the floor.
  expect(await domain.retainedFloor()).toBe(head - 1);
  expect((await domain.eventsAbove(head - 2)).map((e) => e.seq)).toEqual([head - 1, head]);
  // The domain's floor check, which the stream serves from: a cursor one below
  // the floor is still servable, and anything lower is told log_truncated —
  // resync-and-close, then a full read and a rebuild (§6.3).
  expect(await domain.resyncReasonFor(head - 2)).toBeNull();
  expect(await domain.resyncReasonFor(head - 3)).toBe("log_truncated");
  expect(await domain.resyncReasonFor(0)).toBe("log_truncated");
  // The counter row is never pruned: numbering continues from it.
  expect(await domain.streamHeadSequence()).toBe(head);
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

test("grant reconciliation revokes DELETE and TRUNCATE from every runtime role on every relation — by sweep, not from a list", async () => {
  const grantsSql = (await loadSnapshot()).grantsSql;
  // No list names the log: D55 (6)'s rule is every table.
  expect(grantsSql.replace(/--.*$/gm, "")).not.toMatch(/runtime_delete_revoked|append_only text\[\]/);
  expect(grantsSql).toContain("REVOKE DELETE, TRUNCATE ON %s FROM rm_app, rm_worker, rm_readonly");

  const held = async (): Promise<string[]> =>
    ((await sql`
      SELECT r.rolname || ':' || t.name || ':' || p.privilege AS item
        FROM (VALUES ('rm_app'), ('rm_worker'), ('rm_readonly')) AS r(rolname)
        CROSS JOIN (VALUES ('swarm_stream_events'), ('jobs')) AS t(name)
        CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS p(privilege)
       WHERE has_table_privilege(r.rolname, 'public.' || t.name, p.privilege)
       ORDER BY 1`) as unknown as { item: string }[]).map((r) => r.item);

  // A hand-run grant re-widens every runtime role, on the log and on an
  // ordinary table (the drift reconciliation exists for).
  await sql.unsafe("GRANT DELETE, TRUNCATE ON swarm_stream_events, jobs TO rm_app, rm_worker, rm_readonly");
  try {
    expect((await held()).length).toBe(12);
    await asOwner(async (tx) => tx.unsafe(grantsSql));
    expect(await held()).toEqual([]);
    expect(await sqlstate(logins.get("rm_app")!, "DELETE FROM swarm_stream_events WHERE seq = 1")).toBe("42501");
    expect(await sqlstate(logins.get("rm_worker")!, "DELETE FROM jobs WHERE false")).toBe("42501");
  } finally {
    await sql.unsafe("REVOKE DELETE, TRUNCATE ON swarm_stream_events, jobs FROM rm_app, rm_worker, rm_readonly");
  }
});

test("grant reconciliation also takes DELETE and TRUNCATE back on a view — every relation kind check 2 inspects", async () => {
  // Preflight check 2 refuses either privilege on a table, a partitioned table,
  // a view (an updatable view passes a DELETE through) or a foreign table. A
  // sweep narrower than that would let a hand-run grant on a view refuse every
  // boot while `bun run migrate` never took it back.
  const grantsSql = (await loadSnapshot()).grantsSql;
  const view = "rm_retention_planted_view";
  await asOwner(async (tx) => tx.unsafe(`CREATE VIEW ${view} AS SELECT id, kind FROM jobs`));
  const held = async (): Promise<string[]> =>
    ((await sql`
      SELECT r.rolname || ':' || p.privilege AS item
        FROM (VALUES ('rm_app'), ('rm_worker'), ('rm_readonly')) AS r(rolname)
        CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS p(privilege)
       WHERE has_table_privilege(r.rolname, ${"public." + view}, p.privilege)
       ORDER BY 1`) as unknown as { item: string }[]).map((r) => r.item);
  try {
    await asOwner(async (tx) => tx.unsafe(`GRANT DELETE, TRUNCATE ON ${view} TO rm_app, rm_worker, rm_readonly`));
    expect((await held()).length).toBe(6);
    expect(
      (await findDenylistViolations(sql, ["rm_app"])).filter((v) => v.object === view),
    ).toEqual([{ rule: "append_only_write", role: "rm_app", object: view }]);
    await asOwner(async (tx) => tx.unsafe(grantsSql));
    expect(await held()).toEqual([]);
    expect(await sqlstate(logins.get("rm_app")!, `DELETE FROM ${view} WHERE false`)).toBe("42501");
  } finally {
    await asOwner(async (tx) => tx.unsafe(`DROP VIEW ${view}`));
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
