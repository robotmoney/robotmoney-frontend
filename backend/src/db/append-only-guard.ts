// The append-only guard's RUNTIME verification — the half migration 0032
// cannot do for itself — plus the canonical list of what it protects.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A RUNTIME CHECK EXISTS AT ALL
// ─────────────────────────────────────────────────────────────────────────────
//
// Migration 0032 installs two `ENABLE ALWAYS` triggers per protected table, and
// applying it is a one-time act. Everything that happens to the database
// AFTERWARDS can remove them, and none of it re-runs the migration:
//
//   * `pg_restore` emits triggers in the post-data section, so a restore that
//     fails or is stopped part-way loads rows into unguarded tables — and the
//     dump already carries `0032_append_only_history.sql` in
//     `schema_migrations`, so src/db/migrate.ts will skip the file forever.
//     This is the same shape as issue #602 for migration 0031.
//   * The role in DATABASE_URL owns these tables and this function, so
//     `DROP TRIGGER`, `ALTER TABLE ... DISABLE TRIGGER USER`,
//     `ALTER TABLE ... ENABLE REPLICA TRIGGER`,
//     `DROP FUNCTION rm_append_only_guard() CASCADE` and a
//     `CREATE OR REPLACE FUNCTION rm_append_only_guard() ... RETURN NULL` are
//     all one statement away at any moment. (Ownership is the real fix and is
//     tracked in issue #692; it is not attempted here.)
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT PROBES INSTEAD OF COUNTING TRIGGERS
// ─────────────────────────────────────────────────────────────────────────────
//
// This was very nearly built as an inventory — "are there N triggers, are they
// ENABLE ALWAYS" — and an inventory is worthless on its own. `CREATE OR REPLACE
// FUNCTION rm_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS
// $$ BEGIN RETURN NULL; END $$` is ONE statement, needs only FUNCTION
// ownership (which the application role has), and disarms every guard on every
// table while:
//
//   * every trigger still exists,
//   * every trigger still attaches to the right table,
//   * every trigger still names `rm_append_only_guard`,
//   * every trigger still reports `tgenabled = 'A'`.
//
// A catalog check passes, cleanly, against a database where deletion is now
// completely unguarded. So the load-bearing half of this module is the PROBE:
// it issues a real removal statement and requires the guard's OWN message back.
// That cannot be satisfied by anything except the function actually running and
// actually raising.
//
// The inventory is kept ALONGSIDE the probe, because it covers the cases the
// probe cannot see — a trigger dropped from ONE table (the probe would catch
// that too), a trigger switched to `ENABLE REPLICA` (`tgenabled = 'R'`: it
// still fires for ordinary clients, so the probe is happy, but it is now absent
// during exactly the restore/replication apply it exists for), and the
// row-level trigger's presence, which no client-issued statement can
// demonstrate (see the next section). Neither half is sufficient. Together they
// fail on function replacement, on `DROP TRIGGER`, on `DISABLE TRIGGER`, on
// `ENABLE REPLICA TRIGGER`, and on a restore that never installed them.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE PROBE CAN AND CANNOT EXERCISE
// ─────────────────────────────────────────────────────────────────────────────
//
// The probe statement is `DELETE FROM <table> WHERE false`, and that shape is
// deliberate in both directions:
//
//   SAFE ON A LIVE DATABASE, in EVERY outcome. If the guard is armed the
//   statement is refused before any scan (a BEFORE STATEMENT trigger runs ahead
//   of the delete). If the guard is DISARMED — the case this exists to detect —
//   the statement still matches no rows and removes nothing. There is no
//   outcome in which running this check costs a row, so it needs no transaction
//   to protect the database from it and takes no locks worth naming.
//
//   IT EXERCISES THE STATEMENT-LEVEL TRIGGER ONLY. A row-level trigger cannot
//   fire for a statement that matches nothing, and any statement that DID match
//   would hit the statement-level trigger first (BEFORE STATEMENT precedes
//   BEFORE ROW), so no client-issued DELETE can make the row-level trigger the
//   one that answers. The row-level trigger's whole purpose is a removal with
//   NO statement behind it — a logical-replication apply — which cannot be
//   synthesised from a connection. Its presence is therefore checked in the
//   catalog here, and its BEHAVIOUR is proved by an executed publisher →
//   subscriber test (backend/tests/append-only-replication.test.ts) with its own
//   control. Both triggers call the same function, and the probe proves that
//   function raises, so the pair is: "the function is armed" (probe, unfakeable)
//   + "both triggers are attached, ALWAYS, and call it" (catalog).
//
// ─────────────────────────────────────────────────────────────────────────────
// CALLERS (all three, so a future reader can check this list against `grep`)
// ─────────────────────────────────────────────────────────────────────────────
//
//   - backend/src/api/index.ts — assertAppendOnlyGuardArmed(), before Bun.serve
//     binds a port. This is the `docker compose up -d` path, which runs neither
//     migrate nor db-preflight.
//   - backend/scripts/prod-bootstrap.ts — after migrate(), because migrate() is
//     what installs the thing being verified.
//   - backend/scripts/db-preflight.ts — the `--external-pg` demo boot.
import type postgresTypes from "postgres";
import { sql } from "./client.ts";
import { createNamespaceGuardClient } from "./handle-namespace.ts";

/** Same narrow handle the sibling guard takes: plain queries only, so a test
 *  can pass a throwaway-database connection or a transaction. */
export type AppendOnlyDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/**
 * THE PROTECTED SET — the canonical copy.
 *
 * Migration 0032's DO block carries the same list because an applied migration
 * is a frozen artefact whose SQL has to be self-contained; the two are held in
 * agreement by an executed test
 * (backend/tests/append-only-enforcement.test.ts, which extracts the array from
 * the .sql file and compares it to this one). Moving the boundary is one edit
 * here and one there.
 *
 * THE TEST FOR MEMBERSHIP is not "is this table important". It is: **is this a
 * historical fact that cannot be reconstructed once the row is gone?** State
 * that is churn, ephemeral by design, or re-derivable from a source that still
 * exists does not belong here, and protecting it costs a real capability.
 *
 * Protected, and why:
 *
 *  - `swarm_members`, `swarm_recommendations`, `swarm_memos`, `swarm_sessions`,
 *    `swarm_briefs`, `swarm_subjects` — the signed record and everything a
 *    signature is over. A take was signed by a key the server never held, so a
 *    deleted take cannot be re-made by anyone, including its author.
 *  - `swarm_session_events` — the state trail of a session (convened, opened,
 *    closed, published) and the times it happened at.
 *  - `swarm_session_members` — the ATTENDANCE ROSTER for a session. Added in
 *    review, and it is the sharpest of the sibling cases: `swarm_session_events`
 *    was protected while the record of WHO was seated for the very same session
 *    was not. A roster is a snapshot of a membership that moves, so it cannot be
 *    recovered from today's `swarm_members` — and "who was in the room" is
 *    exactly the fact a reader of a published session is checking.
 *  - `swarm_subject_snapshots` — the portfolio the session's takes were made
 *    ABOUT, as of that day. A point-in-time observation of an external system;
 *    re-reading that system now answers a different question, and the memo's
 *    numbers are checked against this row.
 *  - `swarm_applications` — the inbound application record behind an admission
 *    or a rejection.
 *  - `audit_log`, `agent_activity_log` — the trail of who did what. An audit
 *    trail that can be pruned by the actor it records is not one.
 *  - `regime_snapshots` — the analytics series other published numbers are
 *    derived from; the inputs it was computed from are not all retained.
 *  - `schema_migrations` — the migration ledger. See the deliberate cost of
 *    this one in migration 0032's header: `DELETE FROM schema_migrations` is
 *    the usual lever for forcing a re-run, and it now raises.
 *
 * NOT protected. Each is a decision, not an omission — a table missing from
 * BOTH lists is the defect this section exists to prevent:
 *
 *  - `admin_session`, `admin_webauthn_challenge`, `swarm_claim_challenges` —
 *    ephemeral auth state whose PURPOSE is to be consumed or to expire. A
 *    WebAuthn challenge that cannot be deleted is a replay window: protecting
 *    these would REDUCE security.
 *  - `swarm_member_keys` — key lifecycle, not history: an operator must be able
 *    to remove a key, and every admin rotation path already retains the old row
 *    as `active = false` rather than deleting it. NOTE a known consequence that
 *    is NOT fixed here and is tracked separately: swarm/domain.ts's
 *    registerMember hard-removes every key row on re-registration, and the read
 *    paths resolve a take's key as the member's CURRENTLY ACTIVE one, so a
 *    retained (append-only) take can stop verifying after a rotation. Protecting
 *    this table would not fix that; the register path and the read path are what
 *    need to change.
 *  - `jobs`, `job_runs`, `job_schedules` — queue and coordination churn, and
 *    the queue is periodically pruned by design. NOTE the cost, recorded in
 *    0032's header: `jobs` has `ON DELETE SET NULL` edges into protected tables
 *    (`audit_log.job_id`, `swarm_session_events.job_id`), so removing a job
 *    blanks provenance on rows that themselves survive.
 *  - `raw_indicator_history` — re-derivable from its external sources, and it
 *    has a live repair path that deletes calendar-invalid rows
 *    (`verifySeedProvenance(db, clean = true)`,
 *    analytics/store/seed-provenance.ts). Protecting it breaks a shipped tool
 *    to preserve data that can be re-fetched.
 *  - `swarm_agent_health_events` — liveness telemetry. High-volume, per-tick,
 *    and meaningful only while it is recent; it records that a process was up,
 *    not a fact anyone later relies on. It is the table most likely to need a
 *    retention window, and a retention window is a DELETE.
 *  - `swarm_waitlist` — contact details somebody gave us so we could get in
 *    touch. Removal on request is an obligation, not a hazard; a table you
 *    cannot erase a person from is the wrong default for personal data.
 *  - `analytics_runs`, `analytics_stage_runs`, `analytics_artifacts`,
 *    `analytics_submissions`, `research_signals`, `research_pipeline_runs`,
 *    `research_pipeline_stages`, `research_pipeline_warnings`,
 *    `research_pipeline_artifacts` — pipeline execution records, re-derivable
 *    by re-running the pipeline against the same inputs, and already deleted by
 *    live paths (see backend/tests/analytics-worker-role.test.ts). Their
 *    integrity guarantee is the `rm_worker` role's lack of DELETE privilege,
 *    which is a stronger and separate mechanism — a privilege refusal (42501)
 *    beats a trigger the owner can drop.
 *  - `buyback_swaps` — every row is an on-chain event addressed by `tx_hash`
 *    and re-indexable from the chain; this is the one producer in the system
 *    that self-heals. Re-derivable by definition.
 */
export const APPEND_ONLY_TABLES = [
  "swarm_members",
  "swarm_recommendations",
  "swarm_memos",
  "swarm_sessions",
  "swarm_briefs",
  "swarm_subjects",
  "swarm_session_events",
  "swarm_session_members",
  "swarm_subject_snapshots",
  "swarm_applications",
  "audit_log",
  "agent_activity_log",
  "regime_snapshots",
  "schema_migrations",
] as const;

export type AppendOnlyTable = (typeof APPEND_ONLY_TABLES)[number];

/** The migration filename, as `schema_migrations` records it. Used to tell
 *  "the guard was never installed here" (a legitimate pre-migration boot) from
 *  "it was installed and is now gone" (the thing worth refusing over). */
export const APPEND_ONLY_MIGRATION = "0032_append_only_history.sql";

/** The two trigger names migration 0032 installs on each protected table. */
export function triggerNames(table: string): { statement: string; row: string } {
  return { statement: `${table}_append_only`, row: `${table}_append_only_row` };
}

/**
 * The guard's own refusal, recognised by its TEXT and not merely its SQLSTATE.
 *
 * SQLSTATE ALONE IS A FALSE GREEN. `heap_truncate_check_FKs()` raises
 * `cannot truncate a table referenced in a foreign key constraint` with the
 * same `0A000`, and fires BEFORE the trigger stage — so on any table with an
 * inbound foreign key (most of these) a SQLSTATE-only check passes against a
 * database where migration 0032 was never applied at all. Both are required
 * here, always as a pair.
 */
export function isAppendOnlyRefusal(err: unknown, table: string): boolean {
  const e = err as { message?: string; code?: string } | null;
  if (e?.code !== "0A000") return false;
  return new RegExp(`^table "${table}" is append-only: row deletion is not permitted \\(DELETE\\)`).test(
    String(e?.message ?? ""),
  );
}

export type AppendOnlyGuardStatus = "armed" | "disarmed" | "not_applied" | "unavailable" | "unchecked";

export interface AppendOnlyGuardCheck {
  status: AppendOnlyGuardStatus;
  /** One operator-readable sentence per problem. Non-empty only when
   *  status is "disarmed". */
  problems: string[];
  /** Why the check could not run. Set only when status is "unavailable". */
  detail?: string;
}

interface TriggerRow {
  table_name: string;
  trigger_name: string;
  enabled: string;
  function_name: string;
  is_row: boolean;
}

/** Which protected tables this database actually has. A deployment mid-way
 *  through the migration series legitimately has only some of them, and
 *  migration 0032 skips the rest for the same reason. */
async function existingTables(db: AppendOnlyDb): Promise<string[]> {
  const rows = (await db`
    SELECT t AS table_name
    FROM unnest(${[...APPEND_ONLY_TABLES] as string[]}::text[]) AS t
    WHERE to_regclass('public.' || t) IS NOT NULL
  `) as unknown as { table_name: string }[];
  return rows.map((r) => r.table_name);
}

/**
 * The catalog half: both triggers present, ENABLE ALWAYS, calling this
 * function. `tgtype` bit 0 is ROW-level; `tgenabled` is 'O' (origin only —
 * silently skipped under `session_replication_role = 'replica'`), 'D'
 * (disabled), 'R' (replica only) or 'A' (always).
 */
async function triggerInventory(db: AppendOnlyDb, tables: string[]): Promise<string[]> {
  if (tables.length === 0) return [];
  const rows = (await db`
    SELECT c.relname::text AS table_name,
           t.tgname::text AS trigger_name,
           t.tgenabled::text AS enabled,
           p.proname::text AS function_name,
           (t.tgtype & 1) = 1 AS is_row
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname = ANY(${tables}::text[])
  `) as unknown as TriggerRow[];
  const byName = new Map(rows.map((r) => [`${r.table_name}.${r.trigger_name}`, r]));

  const problems: string[] = [];
  for (const table of tables) {
    const names = triggerNames(table);
    for (const [level, name] of [["statement", names.statement], ["row", names.row]] as const) {
      const row = byName.get(`${table}.${name}`);
      if (!row) {
        problems.push(
          `${table}: the ${level}-level trigger '${name}' is MISSING — repair: re-apply ` +
            `backend/migrations/${APPEND_ONLY_MIGRATION} (it is idempotent).`,
        );
        continue;
      }
      if (row.function_name !== "rm_append_only_guard") {
        problems.push(`${table}: trigger '${name}' calls '${row.function_name}()', not rm_append_only_guard().`);
      }
      if ((level === "row") !== row.is_row) {
        problems.push(`${table}: trigger '${name}' is ${row.is_row ? "ROW" : "STATEMENT"} level, expected ${level.toUpperCase()}.`);
      }
      if (row.enabled !== "A") {
        problems.push(
          `${table}: trigger '${name}' is tgenabled='${row.enabled}', not 'A' (ALWAYS) — it is skipped under ` +
            `session_replication_role='replica', i.e. during exactly the restore or replication apply it exists for. ` +
            `Repair: ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${name};`,
        );
      }
    }
  }
  return problems;
}

/**
 * Thrown when the database did not ANSWER the probe — as distinct from
 * answering it wrongly. It exists because conflating the two is a way to turn
 * a slow database into an outage: see `INCONCLUSIVE_CODES`.
 */
class GuardCheckInconclusive extends Error {}

/**
 * SQLSTATEs that mean "this database could not answer right now", never "the
 * guard is gone".
 *
 * THIS DISTINCTION IS THE DIFFERENCE BETWEEN A CHECK AND AN OUTAGE, and it was
 * found by an executed test rather than reasoned about: with the probe treating
 * every error as evidence, an api booted against a database whose swarm_members
 * was held under `ACCESS EXCLUSIVE` (a migration replay, a REINDEX, a VACUUM
 * FULL, an ALTER queued behind an idle transaction — all ordinary
 * deploy-window events) got `57014 canceling statement due to statement
 * timeout` from the probe, classified it as `disarmed`, and REFUSED TO START.
 * A lock on one table would have taken the whole site down, including the
 * static frontend this process serves.
 *
 * A DELETE that is genuinely unguarded either succeeds or comes back with the
 * guard's own 0A000. Everything else here is the database declining to speak:
 *   57014 query_canceled (statement_timeout), 55P03 lock_not_available,
 *   57P0x admin/crash shutdown and "cannot connect now", 53300 too many
 *   connections, and the whole 08 class (connection exceptions).
 * `42501 insufficient_privilege` is included for a different reason: a role
 * without DELETE on the table never reaches the trigger stage at all, so the
 * probe learns nothing about the guard either way.
 */
const INCONCLUSIVE_CODES = new Set(["57014", "55P03", "57P01", "57P02", "57P03", "53300", "42501"]);

function isInconclusive(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  // No SQLSTATE at all is a client-side failure (connect timeout, socket
  // closed) — postgres.js reports those with string codes of its own.
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return true;
  return INCONCLUSIVE_CODES.has(code) || code.startsWith("08");
}

/**
 * The probe half: issue a real removal statement per protected table and
 * require the guard's own message back.
 *
 * `DELETE ... WHERE false` matches nothing in either outcome, so this is safe
 * against a live database whether the guard answers or not — see the header.
 * Each probe is its own statement on the pool rather than one transaction: a
 * raised error aborts a transaction, so every subsequent probe inside one would
 * fail with 25P02 and report the wrong table.
 *
 * It stops at the FIRST inconclusive answer rather than working through the
 * rest: under a lock every remaining table would pay the same timeout, turning
 * a bounded check into fourteen of them.
 */
async function deleteProbe(db: AppendOnlyDb, tables: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const table of tables) {
    let raised: unknown = null;
    try {
      await db.unsafe(`DELETE FROM public.${table} WHERE false`);
    } catch (e) {
      raised = e;
    }
    if (raised === null) {
      problems.push(
        `${table}: a DELETE was ACCEPTED — the append-only guard is not refusing anything on this table. ` +
          `The trigger may still exist and still look correct; check rm_append_only_guard()'s BODY ` +
          `(\\sf rm_append_only_guard) — replacing it is one statement and disarms every table at once. ` +
          `Repair: re-apply backend/migrations/${APPEND_ONLY_MIGRATION}.`,
      );
      continue;
    }
    if (isAppendOnlyRefusal(raised, table)) continue;
    const e = raised as { message?: string; code?: string };
    const first = String(e?.message ?? raised).split("\n")[0];
    if (isInconclusive(raised)) {
      throw new GuardCheckInconclusive(`probing ${table}: ${e?.code ?? "no SQLSTATE"}: ${first}`);
    }
    problems.push(
      `${table}: a DELETE was refused, but NOT by the append-only guard — got ${e?.code ?? "?"}: ` +
        `${first}. Only rm_append_only_guard()'s own message counts as evidence.`,
    );
  }
  return problems;
}

/** Whether migration 0032 is recorded as applied. `false` means this database
 *  legitimately predates the guard (a first boot, a partially-migrated
 *  deployment) and its absence is not a violation — `migrate()` will install it.
 *  `true` with the guard missing is the case worth refusing over. */
async function migrationRecorded(db: AppendOnlyDb): Promise<boolean> {
  const [{ present }] = (await db`
    SELECT (
      to_regclass('public.schema_migrations') IS NOT NULL
      AND EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${APPEND_ONLY_MIGRATION})
    ) AS present
  `) as unknown as { present: boolean }[];
  return present;
}

/**
 * Run both halves and classify.
 *
 * "unavailable" is returned rather than thrown, for the same reason
 * checkHandleNamespace does it: whether an unqueryable database should stop a
 * process is the caller's decision and the callers answer it differently.
 */
export async function checkAppendOnlyGuard(db: AppendOnlyDb = sql): Promise<AppendOnlyGuardCheck> {
  try {
    const applied = await migrationRecorded(db);
    const tables = await existingTables(db);
    if (!applied) {
      // Not "clean" and not "disarmed": nothing has claimed to install this yet.
      return { status: "not_applied", problems: [] };
    }
    if (tables.length === 0) {
      return {
        status: "disarmed",
        problems: [
          `${APPEND_ONLY_MIGRATION} is recorded in schema_migrations but NONE of the ${APPEND_ONLY_TABLES.length} ` +
            `protected tables exists in this database. The ledger and the schema disagree.`,
        ],
      };
    }
    const problems = [...(await triggerInventory(db, tables)), ...(await deleteProbe(db, tables))];
    return problems.length > 0 ? { status: "disarmed", problems } : { status: "armed", problems: [] };
  } catch (err) {
    // Every failure lands here as "unavailable", never as "disarmed": a
    // database that cannot answer has said nothing about its triggers, and
    // treating silence as a violation is how a lock on one table becomes a
    // refused boot. GuardCheckInconclusive is the deliberate version of that
    // (see INCONCLUSIVE_CODES); a catalog query that throws is the accidental
    // one, and both mean the same thing to a caller.
    return { status: "unavailable", problems: [], detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The api guard's WALL-CLOCK budget.
 *
 * MUCH SHORTER than the handle-namespace guard's 8000ms, and deliberately so:
 * this check runs AFTER that one, so its budget is added to the same boot, and
 * unlike that one it issues a statement per protected table. Its own client
 * bounds each statement at the server (statement_timeout and lock_timeout), so
 * the realistic worst case is one timed-out probe — the loop stops at the first
 * inconclusive answer rather than paying the timeout fourteen times.
 */
export const APPEND_ONLY_GUARD_BUDGET_MS = 2_000;

/** A promise that rejects after `ms`, plus the cancel that stops its timer from
 *  outliving the attempt it bounds. */
function expireAfter(ms: number): { expiry: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
  });
  return { expiry, cancel: () => clearTimeout(timer!) };
}

/**
 * The operator-facing refusal block, shared by all three callers so they say
 * the same thing. Each appends its own closing line describing what IT did not
 * do, exactly as handleNamespaceRefusalLines is used.
 */
export function appendOnlyRefusalLines(problems: readonly string[], prefix: string): string[] {
  return [
    `${prefix} REFUSING the boot: the append-only guard (migration 0032) is NOT armed on this database.`,
    `${prefix} ${APPEND_ONLY_MIGRATION} is recorded as applied, so something removed or disarmed it AFTER`,
    `${prefix} it was installed — a partial pg_restore, a DROP/DISABLE TRIGGER, or a replaced`,
    `${prefix} rm_append_only_guard() function body. Rows in these tables can be deleted right now:`,
    ...problems.map((p) => `${prefix}   ${p}`),
    `${prefix} Re-apply backend/migrations/${APPEND_ONLY_MIGRATION} (it is idempotent) and re-boot.`,
  ];
}

/** The env var that turns the api's fail-closed refusal into a loud warning.
 *  `RM_ALLOW_*` is the repo's existing shape for a deliberate, operator-set
 *  relaxation of a fail-closed default. */
export const APPEND_ONLY_OVERRIDE_ENV = "RM_ALLOW_UNARMED_APPEND_ONLY_GUARD";

/** What the boot check concluded, for `/health`. "unchecked" is the initial
 *  value on purpose: before the check has returned, nothing is verified, and a
 *  reader must never be told "armed" by default. */
let guardOutcome: AppendOnlyGuardStatus = "unchecked";

export function appendOnlyGuardOutcome(): AppendOnlyGuardStatus {
  return guardOutcome;
}

/**
 * The api's boot check: refuse to serve a database whose history guard is gone.
 *
 * Exits rather than throws, so the refusal is the LAST thing in the log. Called
 * before Bun.serve, so a refused boot has bound no port.
 *
 * BOUNDED, by reusing the sibling guard's short-lived client
 * (createNamespaceGuardClient — server-side statement/lock/connect timeouts on
 * its own connection). This check sits in front of the port for the same reason
 * the namespace one does, so it must not be the thing that hangs a boot.
 *
 * WHAT IT DOES NOT GUARANTEE, stated in full because an incomplete list here is
 * the defect this whole issue was filed about:
 *   1. AN UNQUERYABLE DATABASE IS NOT REFUSED. The api has always started
 *      against an unreachable database (`/health` answers `db: "down"`), and
 *      turning that into a crash-loop would be a worse failure. The outcome is
 *      then "unchecked", loudly, and readable at /health.
 *   2. A DATABASE THAT NEVER HAD 0032 APPLIED IS NOT REFUSED ("not_applied").
 *      That is an ordinary first boot; migrate() installs the guard.
 *   3. IT IS A BOOT-TIME SNAPSHOT. Nothing re-checks. A `DROP TRIGGER` issued
 *      against a live database is not noticed until the next restart, and the
 *      role in DATABASE_URL can issue one at any time — the standing fix is the
 *      ownership split in issue #692, not this function.
 *   4. IT CANNOT SEE THE ROW-LEVEL TRIGGER FIRE. Its presence is checked in the
 *      catalog; its behaviour is proved by
 *      backend/tests/append-only-replication.test.ts. See the header.
 */
export async function assertAppendOnlyGuardArmed(db?: AppendOnlyDb): Promise<void> {
  // createNamespaceGuardClient is reused rather than re-implemented: it is
  // exactly the connection shape this needs (max: 1, server-side
  // statement/lock/connect timeouts derived from a budget), and having one
  // implementation of "a bounded connection for a boot guard" is the point.
  const own = db === undefined ? createNamespaceGuardClient(APPEND_ONLY_GUARD_BUDGET_MS) : undefined;
  try {
    const bound = expireAfter(APPEND_ONLY_GUARD_BUDGET_MS);
    // Promise.race attaches a handler to BOTH, so an attempt abandoned at the
    // deadline can never surface as an unhandled rejection later. The server-side
    // timeouts stop the abandoned query at the database too.
    const result = await Promise.race([checkAppendOnlyGuard(own ?? db!), bound.expiry])
      .catch((err): AppendOnlyGuardCheck => ({
        status: "unavailable",
        problems: [],
        detail: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => bound.cancel());
    guardOutcome = result.status;
    if (result.status === "disarmed") {
      for (const line of appendOnlyRefusalLines(result.problems, "[api]")) console.error(line);
      if (process.env[APPEND_ONLY_OVERRIDE_ENV] === "1") {
        console.error(
          `[api] ${APPEND_ONLY_OVERRIDE_ENV}=1 — OVERRIDE: serving ANYWAY with the append-only guard ` +
            `unarmed. Signed takes, the audit trail and the session record can be deleted from this ` +
            `database and nothing will refuse it. Re-apply the migration and unset ${APPEND_ONLY_OVERRIDE_ENV}.`,
        );
        guardOutcome = "disarmed";
        return;
      }
      console.error(`[api] The api will NOT start: nothing is being served from this database.`);
      console.error(
        `[api] To start anyway (accepting that history can be erased), set ${APPEND_ONLY_OVERRIDE_ENV}=1.`,
      );
      process.exit(1);
    }
    if (result.status === "unavailable") {
      console.error(
        `[api] append-only guard check could NOT run — database not queryable: ${result.detail}. ` +
          `Serving anyway (an unreachable database is not a disarmed guard), but this boot is UNCHECKED.`,
      );
      guardOutcome = "unchecked";
      return;
    }
    if (result.status === "not_applied") {
      console.log(
        `[api] append-only guard: ${APPEND_ONLY_MIGRATION} is not recorded in schema_migrations — ` +
          `this database predates it. migrate() will install it; nothing is wrong.`,
      );
    }
  } finally {
    if (own) void own.end({ timeout: 0 }).catch(() => {});
  }
}
