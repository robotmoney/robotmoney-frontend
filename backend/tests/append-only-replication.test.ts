// THE APPEND-ONLY GUARD UNDER LOGICAL REPLICATION — the one removal path a
// statement-level trigger structurally cannot see (issue #684, round 2).
//
// WHAT WENT WRONG, AND WHY THIS FILE EXISTS AS A TEST RATHER THAN A COMMENT.
// Migration 0032 shipped with a statement-level trigger only, and its own
// header claimed that `ENABLE ALWAYS` made it hold "during a restore and a
// logical-replication apply". The first half was true; the second was not, and
// nothing in the suite could tell the difference:
//
//   A logical-replication apply worker removes a row through
//   `ExecSimpleRelationDelete`. There is NO STATEMENT. A `FOR EACH STATEMENT`
//   trigger is therefore never FIRED — not skipped, never considered — so
//   `ENABLE ALWAYS` has nothing to act on. Rows leave protected tables with
//   zero refusals raised and nothing logged.
//
// Every test in append-only-enforcement.test.ts passed throughout, because
// `SET session_replication_role = 'replica'` and a real apply worker are not
// the same thing: the former still issues a STATEMENT. The only way to catch
// this is to actually replicate, so this file actually replicates.
//
// It is CI-viable because logical replication works between two databases in
// the SAME PostgreSQL instance — no second container, no network. tests/preload.ts
// starts the instance with `wal_level=logical` for this file alone.
//
// THE CONTROL IS PART OF THE FILE, NOT A ONE-OFF RUN. The second test builds an
// identical publisher/subscriber pair with ONLY the row-level trigger removed
// (the statement-level one left in place, exactly as 0032 originally shipped)
// and asserts the row IS SILENTLY REMOVED. So:
//
//   * delete the row-level trigger from the migration → test 1 goes red;
//   * make the statement-level trigger somehow catch this → test 2 goes red.
//
// Neither can pass by accident, and the second is what proves the first is not
// passing for some unrelated reason.
//
// NO SILENT SKIP, anywhere. If `wal_level` is not `logical`, if a slot cannot
// be created, or if replication never establishes, this file FAILS. A guard
// test that skips itself when the harness is inconvenient is the false green
// this whole issue is about.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

const baseUrl = process.env.DATABASE_URL;
const template = process.env.RM_TEST_TEMPLATE_DB;
if (!baseUrl || !template) {
  throw new Error(
    "tests/append-only-replication.test.ts requires DATABASE_URL and RM_TEST_TEMPLATE_DB (set by tests/preload.ts)",
  );
}

const PUBLISHER = "rmt_ao_publisher";
const GUARDED = "rmt_ao_subscriber_guarded";
const CONTROL = "rmt_ao_subscriber_control";

/** The table under test. `audit_log` is the cleanest subject available: a
 *  plain bigserial primary key (so it has a usable REPLICA IDENTITY), no other
 *  `ENABLE ALWAYS` triggers to confuse the result, and it is squarely inside
 *  the protected set — an audit trail an apply worker can quietly empty is the
 *  worst version of this bug. */
const TABLE = "audit_log";

/** Explicit, absurd ids rather than letting the sequence pick. Both databases
 *  are clones of the same template, so a sequence-allocated id would collide
 *  with a row the subscriber already has and the apply would fail for a reason
 *  that has nothing to do with the guard — a false green in the shape of a
 *  false red. */
const GUARDED_ID = 900_001;
const CONTROL_ID = 900_002;

function urlFor(database: string): string {
  const url = new URL(baseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

/** The libpq conninfo the SUBSCRIBER uses to reach the publisher. Port 5432 and
 *  127.0.0.1 are correct here and the mapped host port is not: this string is
 *  dialled from INSIDE the server process, not from this test. */
function conninfo(database: string): string {
  const url = new URL(baseUrl!);
  return [
    `host=127.0.0.1`,
    `port=5432`,
    `dbname=${database}`,
    `user=${decodeURIComponent(url.username)}`,
    `password=${decodeURIComponent(url.password)}`,
  ].join(" ");
}

function connect(database: string) {
  return postgres(urlFor(database), { max: 1, onnotice: () => {} });
}

type Sql = ReturnType<typeof connect>;

let admin: Sql;
let publisher: Sql;
let guarded: Sql;
let control: Sql;

/** Poll until `check` returns true, or fail with `what`. Never returns a
 *  "gave up, assume fine" value: the caller asserts on the boolean. */
async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function rowExists(db: Sql, id: number): Promise<boolean> {
  const rows = (await db`SELECT 1 FROM audit_log WHERE id = ${id}`) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Wire one publisher → subscriber pair.
 *
 * THE SLOT IS CREATED SEPARATELY, and that is not an optimisation. A
 * `CREATE SUBSCRIPTION` that also creates its slot must build an exported
 * snapshot, which waits for every running transaction in the CLUSTER to finish
 * — including the transaction issuing the CREATE SUBSCRIPTION itself when the
 * publisher lives in the same instance. That is a permanent hang, not a slow
 * test. Creating the slot on its own connection first and passing
 * `create_slot = false` is the documented way round it.
 *
 * `copy_data = false` for the same family of reason: both databases are clones
 * of one template, so an initial COPY would try to re-insert rows the
 * subscriber already has.
 */
async function subscribe(subscriber: Sql, name: string): Promise<void> {
  await publisher.unsafe(`SELECT pg_create_logical_replication_slot('${name}', 'pgoutput')`);
  await subscriber.unsafe(
    `CREATE SUBSCRIPTION ${name} CONNECTION '${conninfo(PUBLISHER)}' PUBLICATION rm_ao_pub ` +
      `WITH (create_slot = false, slot_name = '${name}', copy_data = false)`,
  );
}

/**
 * Tear one pair down. THE SLOT MUST GO, and not merely for tidiness: a database
 * carrying a logical replication slot cannot be dropped at all — `WITH (FORCE)`
 * terminates sessions, not slots — so a leaked slot would leave the publisher
 * database (and its WAL) pinned for the rest of the run.
 */
async function unsubscribe(subscriber: Sql | undefined, name: string): Promise<void> {
  if (subscriber) {
    try {
      await subscriber.unsafe(`ALTER SUBSCRIPTION ${name} DISABLE`);
      // Detach the slot before dropping the subscription, so DROP SUBSCRIPTION
      // does not try to reach a publisher we are about to delete.
      await subscriber.unsafe(`ALTER SUBSCRIPTION ${name} SET (slot_name = NONE)`);
      await subscriber.unsafe(`DROP SUBSCRIPTION ${name}`);
    } catch { /* best effort; the slot drop below is the part that matters */ }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const held = (await publisher`
      SELECT active_pid FROM pg_replication_slots WHERE slot_name = ${name}
    `.catch(() => [])) as unknown as { active_pid: number | null }[];
    if (held.length === 0) return;
    try {
      await publisher.unsafe(`SELECT pg_drop_replication_slot('${name}')`);
      return;
    } catch {
      // Still held by its walsender — the apply worker has not noticed the
      // subscription is gone yet. Evict it and try again.
      await publisher`
        SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots
        WHERE slot_name = ${name} AND active_pid IS NOT NULL
      `.catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

beforeAll(async () => {
  admin = connect("postgres");

  // wal_level is a startup parameter — if it is not `logical` nothing below can
  // work, and the honest outcome is a failure that names the cause.
  const [{ wal_level }] = (await admin`SHOW wal_level`) as unknown as { wal_level: string }[];
  expect(
    wal_level,
    "logical replication is required to test the row-level guard; tests/preload.ts must start postgres with -c wal_level=logical",
  ).toBe("logical");

  for (const db of [PUBLISHER, GUARDED, CONTROL]) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);
  }

  publisher = connect(PUBLISHER);
  guarded = connect(GUARDED);
  control = connect(CONTROL);

  // The PUBLISHER must be able to delete, so its own guard comes off. This also
  // executes one of the residuals migration 0032's header records: the role in
  // DATABASE_URL owns these tables and can drop their triggers in one statement.
  await publisher.unsafe(`DROP TRIGGER IF EXISTS ${TABLE}_append_only ON ${TABLE}`);
  await publisher.unsafe(`DROP TRIGGER IF EXISTS ${TABLE}_append_only_row ON ${TABLE}`);
  await publisher.unsafe(`CREATE PUBLICATION rm_ao_pub FOR TABLE ${TABLE}`);

  // THE CONTROL DATABASE IS MIGRATION 0032 AS IT ORIGINALLY SHIPPED: the
  // statement-level trigger, ENABLE ALWAYS, and nothing else.
  // IF EXISTS, so that a CONTROL RUN of this file against a migration with the
  // row-level trigger deleted reaches the ASSERTIONS instead of dying in setup —
  // which is what makes "delete the trigger and watch test 1 go red" a usable
  // experiment rather than a stack trace.
  await control.unsafe(`DROP TRIGGER IF EXISTS ${TABLE}_append_only_row ON ${TABLE}`);

  await subscribe(guarded, "rm_ao_guarded");
  await subscribe(control, "rm_ao_control");
});

afterAll(async () => {
  await unsubscribe(guarded, "rm_ao_guarded");
  await unsubscribe(control, "rm_ao_control");
  for (const db of [publisher, guarded, control]) await db?.end({ timeout: 5 });
  if (admin) {
    for (const db of [PUBLISHER, GUARDED, CONTROL]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
    }
    await admin.end({ timeout: 5 });
  }
});

describe("append-only under a logical-replication apply", () => {
  test("a replicated row DELETE is REFUSED and the row survives on the subscriber", async () => {
    await publisher.unsafe(
      `INSERT INTO ${TABLE} (id, actor, action) VALUES (${GUARDED_ID}, 'append-only-replication', 'probe')`,
    );
    // The link has to be proved BEFORE the delete. Without this, a subscription
    // that never connected at all would make the "row survived" assertion below
    // pass for the most trivial possible wrong reason.
    expect(
      await until(() => rowExists(guarded, GUARDED_ID), 30_000),
      "the INSERT must replicate — if it does not, this test proves nothing about the DELETE",
    ).toBe(true);

    await publisher.unsafe(`DELETE FROM ${TABLE} WHERE id = ${GUARDED_ID}`);

    // The apply worker retries a failing transaction forever, so the error
    // COUNTER is the positive evidence that the guard answered — and it is
    // evidence the control test below cannot produce.
    const errored = await until(async () => {
      const rows = (await guarded`
        SELECT apply_error_count::int AS n FROM pg_stat_subscription_stats WHERE subname = 'rm_ao_guarded'
      `) as unknown as { n: number }[];
      return (rows[0]?.n ?? 0) > 0;
    }, 30_000);
    expect(errored, "the apply worker must have raised — a silent apply is the defect").toBe(true);

    expect(
      await rowExists(guarded, GUARDED_ID),
      "the replicated DELETE must not have removed the row from the protected table",
    ).toBe(true);
  }, 90_000);

  test("CONTROL: with only the statement-level trigger, the same DELETE is applied and the row is GONE", async () => {
    // This is the bug, reproduced on purpose and kept. It is the reason the
    // row-level trigger exists, and the reason the test above cannot be passing
    // for an unrelated reason (a broken subscription, a wrong table, a delete
    // that never replicated).
    await publisher.unsafe(
      `INSERT INTO ${TABLE} (id, actor, action) VALUES (${CONTROL_ID}, 'append-only-replication', 'control')`,
    );
    expect(await until(() => rowExists(control, CONTROL_ID), 30_000), "the INSERT must replicate").toBe(true);

    // The statement-level trigger is present and ENABLE ALWAYS on this
    // database. Assert that, so a control that passed because the table was
    // left completely unguarded would be caught.
    const [trg] = (await control`
      SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = ${`${TABLE}_append_only`}
    `) as unknown as { enabled: string }[];
    expect(trg?.enabled, "the control must still carry the statement-level guard, ENABLE ALWAYS").toBe("A");

    await publisher.unsafe(`DELETE FROM ${TABLE} WHERE id = ${CONTROL_ID}`);

    expect(
      await until(async () => !(await rowExists(control, CONTROL_ID)), 30_000),
      "with only a FOR EACH STATEMENT trigger the apply worker removes the row — if this ever stops " +
        "being true, the row-level trigger is no longer the thing preventing it and the test above is " +
        "passing for a different reason than it claims",
    ).toBe(true);

    // …and it happened SILENTLY. No error was raised, which is precisely what
    // made the original migration's replication claim look true.
    const rows = (await control`
      SELECT apply_error_count::int AS n FROM pg_stat_subscription_stats WHERE subname = 'rm_ao_control'
    `) as unknown as { n: number }[];
    expect(rows[0]?.n ?? 0, "the statement-level guard raised nothing at all — that is the point").toBe(0);
  }, 90_000);
});
