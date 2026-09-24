// The append-only guard's RUNTIME verification — the half migration 0032
// cannot do for itself — plus the canonical list of what it protects.
//
// TWO PROTECTED SETS, ONE CHECK. `APPEND_ONLY_TABLES` is migration 0032's set,
// guarded by `rm_append_only_guard()`. `LEDGER_IMMUTABLE_FAMILIES` is the
// immutable-ledger set — migrations 0057/0058/0059/0060, each with its own guard
// function, its own refusal text and its own trigger names, and each refusing
// UPDATE as well. They are separate registries because nothing about them is
// interchangeable, and they run through the SAME two halves below and the same
// boot call, because a trigger installed by a migration is a trigger a restore
// can leave out no matter which migration installed it.
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
// smokenstrate (see the next section). Neither half is sufficient. Together they
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
//   - backend/scripts/db-preflight.ts — a pre-populated smoke boot (`--db
//     external` / `--db smoke-twin`).
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
 *  - `swarm_session_judgements` — one row per consensus-judge run (issue #752,
 *    migration 0039), shadow runs included. Each carries `prompt_hash` and
 *    `inputs_digest`: "this opinion was formed under these instructions over
 *    exactly these takes". Attribution that can be deleted is attribution
 *    nobody has to stand behind — and it is precisely the rows that turned out
 *    wrong that somebody would want gone. Its triggers are installed by
 *    migration 0040, not 0032, because an applied migration is frozen; see
 *    APPEND_ONLY_MIGRATIONS below.
 *  - `swarm_consensus_receipts` — the PUBLISHED consensus receipt for a session
 *    (issue #754, migration 0042): the canonical bytes `robotmoney-core`
 *    anchors a keccak256 digest of, plus the payload they serialize. A deleted
 *    receipt leaves an on-chain digest pointing at nothing anyone can produce
 *    again — the analyst signatures inside it were made by keys the server
 *    never held. It is also the one protected table that additionally refuses
 *    UPDATE (`rm_consensus_receipt_immutable()`, migration 0042), because
 *    amending these bytes does not amend the receipt, it orphans the anchor.
 *  - `swarm_member_keys` — issue #697. Every take's `public_key` at read time
 *    was, until this migration, resolved as "the member's CURRENTLY ACTIVE
 *    key", not the key that actually signed it — so once a member's key
 *    rotated, an already-stored, append-only-protected take silently stopped
 *    verifying (an admin rotation) or lost its signing key row outright (a
 *    hard-DELETE on re-registration, since fixed in swarm/domain.ts's
 *    registerMember to deactivate like every other rotation path). This table
 *    was ORIGINALLY excluded here with the reason "key lifecycle, not
 *    history: an operator must be able to remove a key" — see the git history
 *    of this comment. That reasoning was already false the day it was
 *    written: every real removal path retained the old row as
 *    `active = false`, so nothing ever needed DELETE here, and the exclusion
 *    served only to leave the re-registration bug legal. A `swarm_member_keys`
 *    row is exactly the material 0032's own header says the guarantee is
 *    about — "the signatures were made by keys the server never held" — for
 *    every take that row verified, so it belongs in the same protected set as
 *    the takes themselves. UPDATE (`active = false`) is untouched and remains
 *    the correct way to retire a key.
 *  - `swarm_applications` — the inbound application record behind an admission
 *    or a rejection.
 *  - `audit_log`, `agent_activity_log` — the trail of who did what. An audit
 *    trail that can be pruned by the actor it records is not one.
 *  - `regime_snapshots` — the analytics series other published numbers are
 *    derived from; the inputs it was computed from are not all retained.
 *  - `schema_migrations` — the migration ledger. See the deliberate cost of
 *    this one in migration 0032's header: `DELETE FROM schema_migrations` is
 *    the usual lever for forcing a re-run, and it now raises.
 *  - `analytics_overwrite_events` — issue #974's immutable evidence for every
 *    future material replacement or allowed removal of an analytics
 *    current-view row. An evidence ledger that can itself be edited or erased
 *    cannot establish that an overwrite happened.
 *
 * NOT protected. Each is a decision, not an omission — a table missing from
 * BOTH lists is the defect this section exists to prevent:
 *
 *  - `admin_session`, `admin_webauthn_challenge`, `swarm_claim_challenges` —
 *    ephemeral auth state whose PURPOSE is to be consumed or to expire. A
 *    WebAuthn challenge that cannot be deleted is a replay window: protecting
 *    these would REDUCE security.
 *  - `jobs`, `job_runs`, `job_schedules` — queue and coordination churn, and
 *    the queue is periodically pruned by design. NOTE the cost, recorded in
 *    0032's header: `jobs` has `ON DELETE SET NULL` edges into protected tables
 *    (`audit_log.job_id`, `swarm_session_events.job_id`), so removing a job
 *    blanks provenance on rows that themselves survive.
 *  - `raw_indicator_history` — a self-healing current view, and it
 *    has a live repair path that deletes calendar-invalid rows
 *    (`verifySeedProvenance(db, clean = true)`,
 *    analytics/store/seed-provenance.ts). Protecting it breaks a shipped tool;
 *    migration 0056 instead preserves its changed/deleted rows in
 *    `analytics_overwrite_events`.
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
 *    beats a trigger the owner can drop. `research_signals` remains a current
 *    view, but migration 0056 captures each changed/deleted row before it is
 *    replaced or removed.
 *  - `swarm_judge_config` — a ONE-ROW operator switch (mode, min_takes, model).
 *    Mutable configuration, not history; the record of who changed it and when
 *    is `audit_log`, which IS protected.
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
  "swarm_session_judgements",
  "swarm_consensus_receipts",
  "swarm_member_keys",
  "swarm_applications",
  "audit_log",
  "agent_activity_log",
  "regime_snapshots",
  "schema_migrations",
  "analytics_overwrite_events",
  // Issue #1026 W4: the epoch scheduler's two logs. `swarm_stream_events` is
  // the log §6.3's gap rule rests on — a deleted row IS a gap, and one the
  // scheduler cannot tell from a lost frame. `swarm_scheduler_jobs` holds the
  // idempotency keys, and a guarantee that disappears when the work finishes
  // lets the same key back in as fresh work (migration 0070's header).
  "swarm_stream_events",
  "swarm_scheduler_jobs",
] as const;

export type AppendOnlyTable = (typeof APPEND_ONLY_TABLES)[number];

/** The migration filename, as `schema_migrations` records it. Used to tell
 *  "the guard was never installed here" (a legitimate pre-migration boot) from
 *  "it was installed and is now gone" (the thing worth refusing over).
 *
 *  Still 0032 on purpose: it is the migration that installs
 *  `rm_append_only_guard()` itself, so its absence is what "never installed
 *  here" means. Later migrations opt individual tables in. */
export const APPEND_ONLY_MIGRATION = "0032_append_only_history.sql";

/** Every migration that declares a protected-table array, in apply order. The
 *  union of their arrays must equal APPEND_ONLY_TABLES — pinned by an executed
 *  test, because a table added to one list and not the other is a table nobody
 *  protects. */
export const APPEND_ONLY_MIGRATIONS = [
  "0032_append_only_history.sql",
  "0040_swarm_judgements_append_only.sql",
  "0042_swarm_consensus_receipts.sql",
  "0050_swarm_member_keys_append_only.sql",
  "0056_analytics_overwrite_events.sql",
  "0072_drop_swarm_schedules.sql",
] as const;

/**
 * Which of APPEND_ONLY_MIGRATIONS opts each table in.
 *
 * PINNED IN BOTH DIRECTIONS, because a wrong entry here FAILS OPEN. The key set
 * is the `Record` type — a table in APPEND_ONLY_TABLES with no entry does not
 * compile. The VALUES are pinned by append-only-enforcement.test.ts's "protected
 * arrays" test, which already parses each migration's own `protected text[]`
 * array and so knows which file declares each table; without that, a filename
 * that is merely WRONG type-checks, `appliedMigrations.has()` is false forever,
 * the table drops out of both triggerInventory and deleteProbe, and
 * checkAppendOnlyGuard reports `armed` for a table carrying no triggers at all.
 *
 * THE BUG THIS MAP FIXES (found capturing a fresh prod replica on
 * 2026-09-11): `checkAppendOnlyGuard` used to gate ONLY on whether 0032 was
 * recorded, then treated every table that merely EXISTS as "should already
 * be protected" — but `swarm_member_keys` has existed since long before 0050
 * opted it in, so a database that has 0032 but genuinely has not reached 0050
 * yet (an ordinary, expected mid-rollout state, not tampering) got the same
 * "something removed or disarmed it" refusal as an actually-disarmed one.
 * Gating each table on ITS OWN migration removes that false positive without
 * weakening the check for a table whose migration truly has run.
 */
export const APPEND_ONLY_TABLE_MIGRATION: Record<
  (typeof APPEND_ONLY_TABLES)[number],
  (typeof APPEND_ONLY_MIGRATIONS)[number]
> = {
  swarm_members: "0032_append_only_history.sql",
  swarm_recommendations: "0032_append_only_history.sql",
  swarm_memos: "0032_append_only_history.sql",
  swarm_sessions: "0032_append_only_history.sql",
  swarm_briefs: "0032_append_only_history.sql",
  swarm_subjects: "0032_append_only_history.sql",
  swarm_session_events: "0032_append_only_history.sql",
  swarm_session_members: "0032_append_only_history.sql",
  swarm_subject_snapshots: "0032_append_only_history.sql",
  swarm_applications: "0032_append_only_history.sql",
  audit_log: "0032_append_only_history.sql",
  agent_activity_log: "0032_append_only_history.sql",
  regime_snapshots: "0032_append_only_history.sql",
  schema_migrations: "0032_append_only_history.sql",
  swarm_session_judgements: "0040_swarm_judgements_append_only.sql",
  swarm_consensus_receipts: "0042_swarm_consensus_receipts.sql",
  swarm_member_keys: "0050_swarm_member_keys_append_only.sql",
  // Added with the remote 0056 work, which landed after this map was first
  // written: 0056 both CREATES this table and installs its own ENABLE ALWAYS
  // triggers, so it is its own opt-in migration.
  analytics_overwrite_events: "0056_analytics_overwrite_events.sql",
  // 0068 and 0070 CREATED these two; 0072 is what opts them in, so 0072 is the
  // migration a database must have reached before the guard expects triggers on
  // them. Pointing at their creating migration instead would make every
  // database between 0068 and 0072 report a disarmed guard.
  swarm_stream_events: "0072_drop_swarm_schedules.sql",
  swarm_scheduler_jobs: "0072_drop_swarm_schedules.sql",
};

/** The two trigger names migration 0032 installs on each protected table. */
export function triggerNames(table: string): { statement: string; row: string } {
  return { statement: `${table}_append_only`, row: `${table}_append_only_row` };
}

/**
 * THE LEDGER-IMMUTABILITY FAMILIES — the SECOND protected set, and the reason
 * it is separate from APPEND_ONLY_TABLES rather than merged into it.
 *
 * Migrations 0057, 0058, 0059 and 0060 each install their OWN guard function with its
 * OWN refusal text, its own trigger-name suffixes (`_immutable`,
 * `_immutable_row` rather than `_append_only`), and a STRICTER rule than 0032's:
 * they refuse UPDATE as well as DELETE and TRUNCATE, because a ledger row is
 * never rewritten — a correction is a new row. `APPEND_ONLY_TABLES` cannot
 * absorb them: every consumer of that list (triggerNames above,
 * isAppendOnlyRefusal below, and the pinned message in
 * backend/tests/append-only-enforcement.test.ts) is bound to migration 0032's
 * `rm_append_only_guard()` name and its exact sentence.
 *
 * WHAT THIS REGISTRY IS FOR. Without it these tables had the trigger half of
 * the guarantee and none of the runtime half: `assertAppendOnlyGuardArmed()`
 * verified nothing about them at boot, so the partial-`pg_restore` /
 * `DROP TRIGGER` failure mode this whole module exists for (see the header) was
 * unguarded for exactly the tables three features were built to freeze. It is
 * also what the migration/registry union test keys off, so a later migration
 * that declares an immutable table and forgets its triggers goes red instead of
 * shipping green.
 *
 * Each entry is the complete description of one family: the migration that
 * installs it (as `schema_migrations` records it), the function both its
 * triggers must call, the two trigger-name suffixes, the prefix of its refusal
 * message, and the tables it covers — the same array its migration declares.
 */
export interface LedgerImmutableFamily {
  /** The migration filename, as `schema_migrations` records it. */
  readonly migration: string;
  /** The plpgsql function both of this family's triggers must call. */
  readonly functionName: string;
  /** The literal start of the guard's RAISE, before `<TG_OP> is not permitted
   *  on <table>`. Distinct per family on purpose, so an operator can tell which
   *  layer refused. */
  readonly messagePrefix: string;
  /** Suffix of the FOR EACH STATEMENT trigger's name. */
  readonly statementSuffix: string;
  /** Suffix of the FOR EACH ROW trigger's name. */
  readonly rowSuffix: string;
  /** The tables this family freezes — the same set its migration's
   *  `protected text[] := ARRAY[...]` block declares, pinned by an executed
   *  test. */
  readonly tables: readonly string[];
}

export const LEDGER_IMMUTABLE_FAMILIES: readonly LedgerImmutableFamily[] = [
  {
    migration: "0057_source_acquisition_ledger.sql",
    functionName: "rm_source_ledger_immutable",
    messagePrefix: "source ledger is immutable",
    statementSuffix: "_immutable",
    rowSuffix: "_immutable_row",
    tables: [
      "source_acquisitions",
      "source_acquisition_events",
      "source_payloads",
      "source_fetches",
      "source_value_versions",
    ],
  },
  {
    migration: "0058_analytics_run_ledger.sql",
    functionName: "rm_analytics_run_ledger_immutable",
    messagePrefix: "analytics run ledger is immutable",
    statementSuffix: "_immutable",
    rowSuffix: "_immutable_row",
    tables: [
      "analytics_ledger_methodology_versions",
      "analytics_ledger_runs",
      "analytics_ledger_run_events",
      "analytics_data_vintages",
      "analytics_vintage_members",
    ],
  },
  {
    migration: "0059_analytics_output_and_report_snapshots.sql",
    functionName: "rm_analytics_output_ledger_immutable",
    messagePrefix: "analytics output ledger is immutable",
    statementSuffix: "_immutable",
    rowSuffix: "_immutable_row",
    tables: ["analytics_output_snapshots", "analytics_report_snapshots", "swarm_brief_revisions"],
  },
  {
    // Issue #979: the analytics dual-write CUTOVER ledger. `analytics_read_mode`
    // (the operator switch) is deliberately NOT in the family — it is mutable,
    // one-row configuration, like swarm_judge_config; the record of who flipped
    // it lives in audit_log. `analytics_parity_observations` is the immutable
    // evidence the cutover gate reads; an observation that could be edited or
    // deleted after the fact would let a failed check be erased rather than
    // superseded by a later, real one.
    migration: "0060_analytics_ledger_cutover.sql",
    functionName: "rm_analytics_cutover_immutable",
    messagePrefix: "analytics cutover ledger is immutable",
    statementSuffix: "_immutable",
    rowSuffix: "_immutable_row",
    tables: ["analytics_parity_observations"],
  },
];

/** The two trigger names a ledger family installs on each of its tables. */
export function ledgerTriggerNames(family: LedgerImmutableFamily, table: string): { statement: string; row: string } {
  return { statement: `${table}${family.statementSuffix}`, row: `${table}${family.rowSuffix}` };
}

/**
 * A ledger family's OWN refusal, recognised by its text and not merely its
 * SQLSTATE — for the same reason isAppendOnlyRefusal is (see below): these
 * guards also raise `feature_not_supported` (0A000), and so does PostgreSQL's
 * own TRUNCATE-RESTRICT cross-check on any table with an inbound foreign key.
 */
export function isLedgerRefusal(
  err: unknown,
  family: LedgerImmutableFamily,
  table: string,
  op: "DELETE" | "UPDATE" | "TRUNCATE" = "DELETE",
): boolean {
  const e = err as { message?: string; code?: string } | null;
  if (e?.code !== "0A000") return false;
  return String(e?.message ?? "").startsWith(`${family.messagePrefix}: ${op} is not permitted on ${table}`);
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
async function existingTables(db: AppendOnlyDb, tables: readonly string[]): Promise<string[]> {
  const rows = (await db`
    SELECT t AS table_name
    FROM unnest(${[...tables] as string[]}::text[]) AS t
    WHERE to_regclass('public.' || t) IS NOT NULL
  `) as unknown as { table_name: string }[];
  return rows.map((r) => r.table_name);
}

/** Which of APPEND_ONLY_MIGRATIONS this database has recorded as applied. */
async function appliedAppendOnlyMigrations(db: AppendOnlyDb): Promise<Set<string>> {
  const rows = (await db`
    SELECT name FROM schema_migrations WHERE name = ANY(${[...APPEND_ONLY_MIGRATIONS] as string[]})
  `) as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** `existing`, narrowed to tables whose OWN opt-in migration (not just 0032)
 *  is recorded as applied — see APPEND_ONLY_TABLE_MIGRATION's header for why
 *  table existence alone is not enough once more than one migration opts
 *  tables in. */
function tablesExpectedProtected(existing: readonly string[], appliedMigrations: ReadonlySet<string>): string[] {
  return existing.filter((t) => appliedMigrations.has(APPEND_ONLY_TABLE_MIGRATION[t as (typeof APPEND_ONLY_TABLES)[number]]));
}

/**
 * ONE guard's description, so the two halves below are written once and run
 * against migration 0032's guard and against each ledger family's.
 */
interface GuardSpec {
  migration: string;
  functionName: string;
  triggerNames(table: string): { statement: string; row: string };
  isRefusal(err: unknown, table: string): boolean;
  /** What to tell an operator to do about a missing or altered trigger. */
  repair(table: string, trigger: string): string;
}

const APPEND_ONLY_SPEC: GuardSpec = {
  migration: APPEND_ONLY_MIGRATION,
  functionName: "rm_append_only_guard",
  triggerNames,
  isRefusal: isAppendOnlyRefusal,
  repair: () => `re-apply backend/migrations/${APPEND_ONLY_MIGRATION} (it is idempotent)`,
};

function ledgerSpec(family: LedgerImmutableFamily): GuardSpec {
  return {
    migration: family.migration,
    functionName: family.functionName,
    triggerNames: (table) => ledgerTriggerNames(family, table),
    isRefusal: (err, table) => isLedgerRefusal(err, family, table),
    // NOT "re-apply the migration": unlike 0032 these files use bare
    // CREATE FUNCTION / CREATE TRIGGER, so re-running one fails on the object
    // that is still there instead of repairing the one that is gone.
    repair: (table, trigger) =>
      `re-create it with the CREATE TRIGGER + ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${trigger} ` +
      `statements from backend/migrations/${family.migration}'s DO block (that file is NOT idempotent — do not re-run it whole)`,
  };
}

/**
 * The catalog half: both triggers present, ENABLE ALWAYS, calling this
 * function. `tgtype` bit 0 is ROW-level; `tgenabled` is 'O' (origin only —
 * silently skipped under `session_replication_role = 'replica'`), 'D'
 * (disabled), 'R' (replica only) or 'A' (always).
 */
async function triggerInventory(db: AppendOnlyDb, tables: string[], spec: GuardSpec): Promise<string[]> {
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
    const names = spec.triggerNames(table);
    for (const [level, name] of [["statement", names.statement], ["row", names.row]] as const) {
      const row = byName.get(`${table}.${name}`);
      if (!row) {
        problems.push(`${table}: the ${level}-level trigger '${name}' is MISSING — repair: ${spec.repair(table, name)}.`);
        continue;
      }
      if (row.function_name !== spec.functionName) {
        problems.push(`${table}: trigger '${name}' calls '${row.function_name}()', not ${spec.functionName}().`);
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
async function deleteProbe(db: AppendOnlyDb, tables: string[], spec: GuardSpec): Promise<string[]> {
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
        `${table}: a DELETE was ACCEPTED — ${spec.functionName}() is not refusing anything on this table. ` +
          `The trigger may still exist and still look correct; check the function's BODY ` +
          `(\\sf ${spec.functionName}) — replacing it is one statement and disarms every table at once. ` +
          `Repair: ${spec.repair(table, spec.triggerNames(table).statement)}.`,
      );
      continue;
    }
    if (spec.isRefusal(raised, table)) continue;
    const e = raised as { message?: string; code?: string };
    const first = String(e?.message ?? raised).split("\n")[0];
    if (isInconclusive(raised)) {
      throw new GuardCheckInconclusive(`probing ${table}: ${e?.code ?? "no SQLSTATE"}: ${first}`);
    }
    problems.push(
      `${table}: a DELETE was refused, but NOT by the guard — got ${e?.code ?? "?"}: ` +
        `${first}. Only ${spec.functionName}()'s own message counts as evidence.`,
    );
  }
  return problems;
}

/** Whether migration 0032 is recorded as applied. `false` means this database
 *  legitimately predates the guard (a first boot, a partially-migrated
 *  deployment) and its absence is not a violation — `migrate()` will install it.
 *  `true` with the guard missing is the case worth refusing over. */
async function migrationRecorded(db: AppendOnlyDb, migration: string): Promise<boolean> {
  const [{ present }] = (await db`
    SELECT (
      to_regclass('public.schema_migrations') IS NOT NULL
      AND EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${migration})
    ) AS present
  `) as unknown as { present: boolean }[];
  return present;
}

/**
 * Which of `tables` the CURRENT ROLE could actually issue a DELETE against.
 *
 * WHY THE PROBE IS FILTERED AT ALL, AND WHY THAT IS A FIX AND NOT A WEAKENING.
 * The api connects as `rm_app`. Migrations 0056, 0057, 0058, 0059 and 0060 all grant
 * that role SELECT and INSERT on their tables and NOT DELETE, so an unfiltered
 * probe takes `42501 insufficient_privilege` there — which INCONCLUSIVE_CODES
 * correctly classifies as "this database did not answer", and ONE such throw
 * turns the WHOLE check "unavailable". That is not hypothetical and it is not
 * new to the ledger families: `analytics_overwrite_events` (migration 0056) is
 * already in APPEND_ONLY_TABLES with the same grant, so on the production role
 * this check has been returning "unavailable" — verifying NOTHING, on every
 * boot, including 0032's own tables — since 0056 landed. It is measured by an
 * executed test (backend/tests/append-only-guard-check.test.ts, the rm_app
 * describe), not reasoned about.
 *
 * Skipping the probe where the role cannot reach the trigger stage costs
 * nothing real: a role without DELETE is refused by the executor before any
 * trigger runs (42501 — a refusal no trigger edit can disarm), and the role
 * that could replace a guard function is not the one the api connects as. Those
 * tables keep the catalog half here, and their behavioural half is executed in
 * CI as the owner, which does hold DELETE.
 */
async function probeTables(db: AppendOnlyDb, tables: string[]): Promise<string[]> {
  if (tables.length === 0) return tables;
  const rows = (await db`
    SELECT t AS table_name
    FROM unnest(${tables}::text[]) AS t
    WHERE has_table_privilege(current_user, 'public.' || quote_ident(t), 'DELETE')
  `) as unknown as { table_name: string }[];
  return rows.map((r) => r.table_name);
}

/**
 * One ledger family's half of the check: the same catalog inventory and the
 * same behavioural probe, against its own function name and its own refusal
 * text.
 *
 * A family whose migration is not recorded contributes nothing — that is a
 * database legitimately part-way through the series, exactly as "not_applied"
 * means for 0032. A family whose migration IS recorded must have every one of
 * its tables, because one migration creates them all.
 */
async function checkLedgerFamily(db: AppendOnlyDb, family: LedgerImmutableFamily): Promise<string[]> {
  if (!(await migrationRecorded(db, family.migration))) return [];
  const spec = ledgerSpec(family);
  const present = await existingTables(db, family.tables);
  const problems = family.tables
    .filter((t) => !present.includes(t))
    .map(
      (t) =>
        `${t}: ${family.migration} is recorded in schema_migrations, and it CREATES this table — ` +
        `but the table is not there. The ledger and the schema disagree.`,
    );
  problems.push(...(await triggerInventory(db, present, spec)));
  problems.push(...(await deleteProbe(db, await probeTables(db, present), spec)));
  return problems;
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
    const applied = await migrationRecorded(db, APPEND_ONLY_MIGRATION);
    const existing = await existingTables(db, APPEND_ONLY_TABLES);
    if (!applied) {
      // Not "clean" and not "disarmed": nothing has claimed to install this yet.
      return { status: "not_applied", problems: [] };
    }
    if (existing.length === 0) {
      return {
        status: "disarmed",
        problems: [
          `${APPEND_ONLY_MIGRATION} is recorded in schema_migrations but NONE of the ${APPEND_ONLY_TABLES.length} ` +
            `protected tables exists in this database. The ledger and the schema disagree.`,
        ],
      };
    }
    // Table EXISTENCE is not enough once more than one migration opts tables
    // in one at a time (APPEND_ONLY_TABLE_MIGRATION): `swarm_member_keys` has
    // existed since long before 0050 protected it, so a database that has not
    // reached 0050 yet — an ordinary mid-rollout state — must not be graded
    // against it, the same way `applied` above excuses a database that has
    // not reached 0032 yet. LEDGER_IMMUTABLE_FAMILIES already does the
    // equivalent for itself (checkLedgerFamily's first line); this is the same
    // rule for the 0032 family, which had only ever gated on 0032 itself.
    const appliedMigrations = await appliedAppendOnlyMigrations(db);
    const tables = tablesExpectedProtected(existing, appliedMigrations);
    const problems = [
      ...(await triggerInventory(db, tables, APPEND_ONLY_SPEC)),
      ...(await deleteProbe(db, await probeTables(db, tables), APPEND_ONLY_SPEC)),
    ];
    // The ledger families (0057/0058/0059/0060) are checked on the SAME boot path,
    // because a trigger that only a migration installs is a trigger a restore
    // can leave out — the reason this module exists at all.
    for (const family of LEDGER_IMMUTABLE_FAMILIES) {
      problems.push(...(await checkLedgerFamily(db, family)));
    }
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
 * unlike that one it issues a statement per probed table plus a handful of
 * catalog queries per ledger family. Its own client bounds each statement at
 * the server (statement_timeout and lock_timeout), so the realistic worst case
 * is one timed-out probe — the loop stops at the first inconclusive answer
 * rather than paying the timeout once per table. On the production role the
 * ledger tables are not probed at all (probeTables), so what the second
 * protected set adds to a boot is catalog reads, not DELETEs.
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
    `${prefix} REFUSING the boot: the append-only guard is NOT armed on this database — migration 0032's`,
    `${prefix} guard, one of the immutable-ledger guards (0057/0058/0059/0060), or both.`,
    `${prefix} The migration that installs it is recorded as applied, so something removed or disarmed`,
    `${prefix} it AFTER it was installed — a partial pg_restore, a DROP/DISABLE TRIGGER, or a replaced`,
    `${prefix} guard function body. Rows in these tables can be removed right now:`,
    ...problems.map((p) => `${prefix}   ${p}`),
    `${prefix} Each line above names its own repair. Apply them and re-boot.`,
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
 *   5. A TABLE THE CONNECTING ROLE CANNOT DELETE FROM GETS THE CATALOG HALF
 *      ONLY. `rm_app` holds no DELETE on the 0056–0060 tables, so the probe is
 *      skipped there (probeTables) — the executor's own 42501 is what stands in
 *      for it. CI probes them as the owner.
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
