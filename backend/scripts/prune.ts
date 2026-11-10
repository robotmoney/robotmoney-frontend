// `bun run prune` — the manual, receipted rm_owner prune (issue #1026, decision
// D55 (12); smoke-production-spec.md §3, system-scheduler-spec.md §6.3
// Retention).
//
// D55 (12): "Pruning is an operator command: a planned root `prune` script, run
// through `bun run`. It takes a typed `rm_owner` password, runs fenced under the
// target lock (smoke spec §2), and writes a receipt. It runs at each upgrade or
// on a runbook cadence. Nothing schedules it. Its retention window is a minimum
// of 7 days ... The window is a floor, not a schedule: the command never
// removes a row younger than it. The command lists exactly the tables it may
// prune ... It never prunes a security tombstone or audit history."
//
// WHY IT EXISTS. D55 (6) took DELETE and TRUNCATE from every runtime role on
// every table (migration 0107), so the only way a row leaves the database is an
// rm_owner run. D61 moved the "typed" password above into `~/.env`'s
// `rm_owner` line and the `y` into `--confirm-target`. This is that run: the one pruning path, for the tables whose rows stop
// mattering after a while.
//
// WHAT IT PRUNES, AND NOTHING ELSE (PRUNE_TARGETS below, a closed constant):
//   * `swarm_stream_events` rows committed before the cutoff. The log keeps a
//     time window of at least 7 days; a scheduler whose cursor falls below the
//     retained floor is told `log_truncated`, resyncs and rebuilds (scheduler
//     spec §6.3), so a prune loses nothing a subscriber still needs. The
//     counter row (`swarm_stream_head`) is never touched: numbering continues
//     from it, never from the rows left.
//   * `admin_session` rows that EXPIRED before the cutoff and were never
//     revoked. An expired session is refused by every read (auth.ts filters
//     `expires_at > now()`), and the sign-in it came from is audit_log's
//     `login_passkey` row, so the row has no audit value. A REVOKED session is
//     a security tombstone (D55 (6)) and is kept, whatever its age.
//   * `jobs` rows that finished long ago (issue 1581). The queue table grew by
//     ~3,600 rows a day and was never pruned; every read of it that is not an
//     index lookup paid for the whole history. Two entries, each with its own
//     floor on top of the window: `succeeded` and `cancelled` rows last
//     updated more than 30 days ago, and `dead` and `failed` rows more than 90
//     days ago (kept longer: they are what an operator investigates). A job
//     that audit_log, analytics_runs or swarm_session_events still names is
//     KEPT, whatever its age: those edges are `ON DELETE SET NULL`, so
//     deleting it would blank the provenance on a history row, and the
//     command never edits audit history. `pending` and `running` rows are
//     never candidates. The rows go in chunks of JOBS_PRUNE_CHUNK, and each
//     chunk is its own transaction (issue 1584): no transaction holds more
//     than one chunk of row locks, and a chunk is committed before the next
//     one starts.
//   * the `job_runs` rows of each jobs row that goes, in the same statement
//     (issue 1584). job_runs.job_id has no foreign key, so a run left behind
//     would name a job that no longer exists, and GET /api/admin/runs's scope
//     filters (a LEFT JOIN to jobs) could no longer find it. A run is the log
//     of one attempt of a job that is gone and older than its floor: it is
//     operational state, not audit history. Nearly every job has a run, so
//     keeping the job instead would prune nothing.
//     The three other tables whose job_id has no foreign key keep their rows:
//     research_pipeline_runs and pipeline_ingest_receipts are provenance, and
//     analytics_ledger_runs is an immutable ledger. A job one of them names is
//     KEPT, like a job history names, so none of them names a deleted job.
// WHAT IT NEVER PRUNES, BY CONSTRUCTION: every other table. In particular the
// revocation tombstones (`admin_session` / `admin_passkey` rows with
// `revoked_at`), `swarm_member_keys`, `automation_tokens`, `audit_log`, every
// append-only history table and every analytics ledger. The WebAuthn challenge
// slots need no prune: there are always exactly 32, overwritten in place
// (migration 0106).
//
// THE WINDOW. `--retention-days <n>`, default 7. A value below 7 refuses before
// anything connects: the window is a floor the owner confirmed, configurable
// upward only. A target may carry a higher floor of its own (the
// jobs entries: 30 and 90 days); its window is the larger of the two. The cutoff is `now() - n days` by the DATABASE's clock, taken
// by the first prune statement, so a skewed operator clock cannot move it.
// Every later statement of the run is handed that same `now()`, so each
// target's cutoff is the run's time minus its window, whichever transaction
// it commits in.
//
// THE SEQUENCE, like `bun run migrate` (backend/scripts/migrate.ts):
//   plan (read the target) → lock (the §2 session lock, revalidated) → gates
//   (the §4.3 matrix) → owner (`~/.env`'s rm_owner line, proven by a login;
//   a missing line refuses naming the key and the file) → confirm
//   (`--confirm-target` equal to the target `~/.env` resolves, D61) → prune (one
//   transaction per target, and per chunk for jobs, each fenced with
//   `pg_advisory_xact_lock` on the target key, as rm_owner, after the session
//   lock is proven held again) → receipt.
// Beside the receipt a journal records the phase every run reached, refused
// and interrupted runs included (§2: a losing tool "journals the phase and
// exits non-zero"). A prune that fails after some transactions committed
// names, in the journal, the rows they removed.
//
// usage: bun run prune --confirm-target <host:port/database> [--retention-days <n>] [--instance <name>] [--receipt <path>] [--lock-timeout <seconds>]
//
// Nothing prompts and no terminal is needed (D61 rule 1).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import postgres from "postgres";
import type postgresTypes from "postgres";
import { homeEnvFilePath, loadEnvFile, urlForRole } from "../../scripts/lib/env-role.ts";
import {
  confirmTargetFlag,
  homeEnvTarget,
  requireConfirmTarget,
  requirePrivilegedPassword,
  type RemoteAuthority,
} from "../../scripts/lib/privileged-env.ts";
import { PRODUCTION_INSTANCE, instancePaths, stateRoot } from "../../scripts/lib/smoke-state.ts";
import { resolveDeploymentPolicy, resolveRmEnv } from "../src/deploy-policy.ts";
import { on, registerQuery } from "../src/db/registry.ts";
import {
  acquireTargetLock,
  assertStillHeld,
  describeHolderText,
  readTargetState,
  releaseTargetLockOnExit,
  withFenceOn,
  type HeldTargetLock,
  type LockHolder,
} from "../src/db/target-lock.ts";

/** The retention floor, in days (D55 (12): "a minimum of 7 days, which the owner confirmed"). */
export const MIN_RETENTION_DAYS = 7;
/** The window when none is given: the floor itself. */
export const DEFAULT_RETENTION_DAYS = MIN_RETENTION_DAYS;

const CALLERS = ["scripts/prune"];

// ── The statements, each a registered rm_owner site (spec §7.1) ─────────────
//
// Each is one statement: the cutoff, the DELETE and the count. `$1` is the
// run's `now()` as text, or NULL for the run's first statement, which takes
// the database's own `now()` and returns it for every later one. The cutoff
// is that time minus the window, and it is returned even when no row matched,
// so the receipt can always name it.

const pruneStreamEvents = registerQuery({
  role: "rm_owner",
  object: "swarm_stream_events",
  // SELECT because the WHERE reads committed_at and RETURNING reads seq.
  privileges: ["DELETE", "SELECT"],
  site: "scripts/prune:pruneStreamEvents",
  purpose:
    "Remove scheduler event-log rows committed before the retention cutoff (at least 7 days), on an operator's " +
    "typed-owner `bun run prune` (D55 (12)).",
  callers: CALLERS,
  probe: {
    statement: `WITH run AS (SELECT COALESCE($1::timestamptz, now()) AS now),
      cut AS (SELECT now - make_interval(days => $2) AS at FROM run),
      gone AS (DELETE FROM swarm_stream_events e USING cut WHERE e.committed_at < cut.at RETURNING e.seq)
      SELECT (SELECT now FROM run)::text AS now, (SELECT at FROM cut) AS cutoff, (SELECT count(*) FROM gone)::int AS rows`,
    params: [null, MIN_RETENTION_DAYS],
  },
});

const pruneExpiredSessions = registerQuery({
  role: "rm_owner",
  object: "admin_session",
  // SELECT because the WHERE reads revoked_at and expires_at, and RETURNING token.
  privileges: ["DELETE", "SELECT"],
  site: "scripts/prune:pruneExpiredSessions",
  purpose:
    "Remove admin sessions that expired before the retention cutoff and were never revoked; a revoked session is a " +
    "security tombstone and is kept (D55 (6), (12)).",
  callers: CALLERS,
  probe: {
    statement: `WITH run AS (SELECT COALESCE($1::timestamptz, now()) AS now),
      cut AS (SELECT now - make_interval(days => $2) AS at FROM run),
      gone AS (DELETE FROM admin_session s USING cut WHERE s.revoked_at IS NULL AND s.expires_at < cut.at RETURNING s.token)
      SELECT (SELECT now FROM run)::text AS now, (SELECT at FROM cut) AS cutoff, (SELECT count(*) FROM gone)::int AS rows`,
    params: [null, MIN_RETENTION_DAYS],
  },
});

// ── The jobs entries (issues 1581, 1584) ────────────────────────────────────
//
// One statement per chunk, each in its own transaction: the cutoff, up to
// JOBS_PRUNE_CHUNK candidate ids (oldest first), the DELETE of their job_runs
// rows and of the jobs themselves, and the counts. `$3` is the comma-separated
// status list of the entry. The NOT EXISTS edges are every table whose
// job_id names a job and must keep naming it: the three `ON DELETE SET NULL`
// foreign keys (audit_log, analytics_runs, swarm_session_events) and the three
// key-less provenance columns (research_pipeline_runs, analytics_ledger_runs,
// pipeline_ingest_receipts), each served by an index (migration 0130 adds the
// missing ones).

/** The most jobs rows one chunk (one statement, one transaction) removes. */
export const JOBS_PRUNE_CHUNK = 5000;
/** The floors of the two jobs entries, in days, on top of the command's window. */
export const JOBS_FINISHED_MIN_DAYS = 30;
export const JOBS_FAILED_MIN_DAYS = 90;

const JOBS_CHUNK_SQL = `WITH run AS (SELECT COALESCE($1::timestamptz, now()) AS now),
      cut AS (SELECT now - make_interval(days => $2) AS at FROM run),
      victims AS (SELECT j.id FROM jobs j, cut
        WHERE j.status = ANY (string_to_array($3, ',')) AND j.updated_at < cut.at
          AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM analytics_runs r WHERE r.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM swarm_session_events e WHERE e.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM research_pipeline_runs p WHERE p.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM analytics_ledger_runs l WHERE l.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM pipeline_ingest_receipts i WHERE i.job_id = j.id)
        ORDER BY j.id LIMIT $4),
      runs AS (DELETE FROM job_runs r USING victims v WHERE r.job_id = v.id RETURNING r.id),
      gone AS (DELETE FROM jobs j USING victims v WHERE j.id = v.id RETURNING j.id)
      SELECT (SELECT now FROM run)::text AS now, (SELECT at FROM cut) AS cutoff,
             (SELECT count(*) FROM gone)::int AS rows, (SELECT count(*) FROM runs)::int AS job_runs`;
const JOBS_PROBE = { statement: JOBS_CHUNK_SQL, params: [null, JOBS_FINISHED_MIN_DAYS, "succeeded,cancelled", JOBS_PRUNE_CHUNK] };
const JOBS_PURPOSE =
  "Remove one chunk of finished jobs older than their floor (30 days succeeded/cancelled, 90 days dead/failed) with " +
  "their job_runs rows, skipping any job history or provenance still names, on an operator's `bun run prune` " +
  "(D55 (12), issues 1581 and 1584).";

const pruneJobs = registerQuery({
  role: "rm_owner",
  object: "jobs",
  // SELECT because the WHERE reads status and updated_at, and RETURNING id.
  privileges: ["DELETE", "SELECT"],
  site: "scripts/prune:pruneJobs",
  purpose: JOBS_PURPOSE,
  callers: CALLERS,
  probe: JOBS_PROBE,
});
const pruneJobsRunLog = registerQuery({
  role: "rm_owner",
  object: "job_runs",
  // SELECT because the USING reads job_id and RETURNING id.
  privileges: ["DELETE", "SELECT"],
  site: "scripts/prune:pruneJobs.jobRuns",
  purpose:
    "Remove the job_runs rows of each job the prune removes, in the same statement, so no run names a deleted job " +
    "(job_runs.job_id has no foreign key; issue 1584).",
  callers: CALLERS,
  probe: JOBS_PROBE,
});
const pruneJobsAudit = registerQuery({
  role: "rm_owner",
  object: "audit_log",
  privileges: ["SELECT"],
  site: "scripts/prune:pruneJobs.audit",
  purpose: "Keep any job an audit_log row names, so the prune never blanks audit provenance (issue 1581).",
  callers: CALLERS,
  probe: JOBS_PROBE,
});
const pruneJobsRuns = registerQuery({
  role: "rm_owner",
  object: "analytics_runs",
  privileges: ["SELECT"],
  site: "scripts/prune:pruneJobs.analyticsRuns",
  purpose: "Keep any job an analytics_runs row names, so the prune never blanks a run's provenance (issue 1581).",
  callers: CALLERS,
  probe: JOBS_PROBE,
});
const pruneJobsEvents = registerQuery({
  role: "rm_owner",
  object: "swarm_session_events",
  privileges: ["SELECT"],
  site: "scripts/prune:pruneJobs.sessionEvents",
  purpose: "Keep any job a swarm_session_events row names, so the prune never blanks session history (issue 1581).",
  callers: CALLERS,
  probe: JOBS_PROBE,
});
const pruneJobsResearch = registerQuery({
  role: "rm_owner",
  object: "research_pipeline_runs",
  privileges: ["SELECT"],
  site: "scripts/prune:pruneJobs.researchRuns",
  purpose: "Keep any job a research_pipeline_runs row names: its job_id has no foreign key, and must never name a deleted job (issue 1584).",
  callers: CALLERS,
  probe: JOBS_PROBE,
});
const pruneJobsLedger = registerQuery({
  role: "rm_owner",
  object: "analytics_ledger_runs",
  privileges: ["SELECT"],
  site: "scripts/prune:pruneJobs.ledgerRuns",
  purpose: "Keep any job an analytics_ledger_runs row names: an immutable ledger row must never name a deleted job (issue 1584).",
  callers: CALLERS,
  probe: JOBS_PROBE,
});
const pruneJobsReceipts = registerQuery({
  role: "rm_owner",
  object: "pipeline_ingest_receipts",
  privileges: ["SELECT"],
  site: "scripts/prune:pruneJobs.ingestReceipts",
  purpose: "Keep any job a pipeline_ingest_receipts row names: its job_id has no foreign key, and must never name a deleted job (issue 1584).",
  callers: CALLERS,
  probe: JOBS_PROBE,
});

/** One prune transaction's result: the run's clock, the cutoff and what went. */
interface StatementResult {
  readonly now: string;
  readonly cutoff: Date;
  readonly rows: number;
}

/** What one target's prune removed, before the receipt adds its name and window. */
export interface TargetResult {
  readonly now: string;
  readonly cutoff: Date;
  readonly rows: number;
  readonly chunks?: number[];
  readonly jobRuns?: number;
}

/**
 * Run `body` in a transaction of its own, fenced with the target key's
 * `pg_advisory_xact_lock`, once the session target lock is proven held; then
 * report what that transaction removed, once it has committed.
 */
export type Fenced = <T extends { rows: number; jobRuns?: number }>(
  body: (tx: postgresTypes.TransactionSql<{}>) => Promise<T>,
) => Promise<T>;

/**
 * Delete the jobs of `statuses` last updated before `now - days`, with their
 * job_runs rows, chunk by chunk until a chunk comes back short. Each chunk is
 * one statement in its own fenced transaction, so it commits before the next
 * one starts.
 */
async function pruneJobsInChunks(fenced: Fenced, now: string | null, days: number, statuses: string): Promise<TargetResult> {
  const chunks: number[] = [];
  let jobRuns = 0;
  let first: StatementResult | null = null;
  let at = now;
  for (;;) {
    const row = await fenced(async (tx) => {
      const [r] = await on(tx, pruneJobs, pruneJobsRunLog, pruneJobsAudit, pruneJobsRuns, pruneJobsEvents, pruneJobsResearch, pruneJobsLedger, pruneJobsReceipts)<StatementResult & { job_runs: number }>`
        WITH run AS (SELECT COALESCE(${at}::timestamptz, now()) AS now),
          cut AS (SELECT now - make_interval(days => ${days}) AS at FROM run),
          victims AS (SELECT j.id FROM jobs j, cut
            WHERE j.status = ANY (string_to_array(${statuses}, ',')) AND j.updated_at < cut.at
              AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.job_id = j.id)
              AND NOT EXISTS (SELECT 1 FROM analytics_runs r WHERE r.job_id = j.id)
              AND NOT EXISTS (SELECT 1 FROM swarm_session_events e WHERE e.job_id = j.id)
              AND NOT EXISTS (SELECT 1 FROM research_pipeline_runs p WHERE p.job_id = j.id)
              AND NOT EXISTS (SELECT 1 FROM analytics_ledger_runs l WHERE l.job_id = j.id)
              AND NOT EXISTS (SELECT 1 FROM pipeline_ingest_receipts i WHERE i.job_id = j.id)
            ORDER BY j.id LIMIT ${JOBS_PRUNE_CHUNK}),
          runs AS (DELETE FROM job_runs r USING victims v WHERE r.job_id = v.id RETURNING r.id),
          gone AS (DELETE FROM jobs j USING victims v WHERE j.id = v.id RETURNING j.id)
          SELECT (SELECT now FROM run)::text AS now, (SELECT at FROM cut) AS cutoff,
                 (SELECT count(*) FROM gone)::int AS rows, (SELECT count(*) FROM runs)::int AS job_runs`;
      return { now: r!.now, cutoff: r!.cutoff, rows: Number(r!.rows), jobRuns: Number(r!.job_runs) };
    });
    // Every chunk is handed the first one's clock, so all name one cutoff.
    first ??= row;
    at = row.now;
    jobRuns += row.jobRuns;
    if (row.rows > 0) chunks.push(row.rows);
    if (row.rows < JOBS_PRUNE_CHUNK) break;
  }
  return { now: first!.now, cutoff: first!.cutoff, rows: chunks.reduce((n, c) => n + c, 0), chunks, jobRuns };
}

/** One table the command may prune: what it removes, and why that is safe. */
export interface PruneTarget {
  readonly table: string;
  /** The predicate, as the receipt records it. `<cutoff>` is `now() - window`. */
  readonly predicate: string;
  readonly why: string;
  /** A floor of this target's own, in days; its window is the larger of this and the command's. */
  readonly minDays?: number;
  /** `now` is the run's clock (`null` for its first statement, which reads the database's). */
  readonly run: (fenced: Fenced, now: string | null, days: number) => Promise<TargetResult>;
}

const JOBS_KEPT = "no audit_log, analytics_runs, swarm_session_events, research_pipeline_runs, analytics_ledger_runs or pipeline_ingest_receipts row names it";

/**
 * THE CLOSED LIST. A table is pruned only if it is here, and a new entry is a
 * decision with its reason written down. Never a security tombstone, never
 * audit history (D55 (12)); tests/prune-command.test.ts plants both and proves
 * each survives. The jobs entries also remove each pruned job's job_runs rows
 * (issue 1584), and the receipt counts them.
 */
export const PRUNE_TARGETS: readonly PruneTarget[] = Object.freeze([
  {
    table: "swarm_stream_events",
    predicate: "committed_at < <cutoff>",
    why: "the event log keeps a window; a cursor below the retained floor gets resync-and-close (log_truncated)",
    run: (fenced, now, days) =>
      fenced(async (tx) => {
        const [row] = await on(tx, pruneStreamEvents)<StatementResult>`
          WITH run AS (SELECT COALESCE(${now}::timestamptz, now()) AS now),
            cut AS (SELECT now - make_interval(days => ${days}) AS at FROM run),
            gone AS (DELETE FROM swarm_stream_events e USING cut WHERE e.committed_at < cut.at RETURNING e.seq)
            SELECT (SELECT now FROM run)::text AS now, (SELECT at FROM cut) AS cutoff, (SELECT count(*) FROM gone)::int AS rows`;
        return { now: row!.now, cutoff: row!.cutoff, rows: Number(row!.rows) };
      }),
  },
  {
    table: "admin_session",
    predicate: "revoked_at IS NULL AND expires_at < <cutoff>",
    why: "an expired, never-revoked session is refused by every read and its sign-in is audit_log's; revoked ones are tombstones and stay",
    run: (fenced, now, days) =>
      fenced(async (tx) => {
        const [row] = await on(tx, pruneExpiredSessions)<StatementResult>`
          WITH run AS (SELECT COALESCE(${now}::timestamptz, now()) AS now),
            cut AS (SELECT now - make_interval(days => ${days}) AS at FROM run),
            gone AS (DELETE FROM admin_session s USING cut WHERE s.revoked_at IS NULL AND s.expires_at < cut.at RETURNING s.token)
            SELECT (SELECT now FROM run)::text AS now, (SELECT at FROM cut) AS cutoff, (SELECT count(*) FROM gone)::int AS rows`;
        return { now: row!.now, cutoff: row!.cutoff, rows: Number(row!.rows) };
      }),
  },
  {
    table: "jobs",
    predicate: `status IN ('succeeded', 'cancelled') AND updated_at < <cutoff> AND ${JOBS_KEPT}; its job_runs rows go with it`,
    why: "a finished job older than 30 days is no live state; a job history or provenance still names is kept, so nothing is left naming a deleted job",
    minDays: JOBS_FINISHED_MIN_DAYS,
    run: (fenced, now, days) => pruneJobsInChunks(fenced, now, days, "succeeded,cancelled"),
  },
  {
    table: "jobs",
    predicate: `status IN ('dead', 'failed') AND updated_at < <cutoff> AND ${JOBS_KEPT}; its job_runs rows go with it`,
    why: "a dead or failed job is kept 90 days for investigation, then goes like a finished one",
    minDays: JOBS_FAILED_MIN_DAYS,
    run: (fenced, now, days) => pruneJobsInChunks(fenced, now, days, "dead,failed"),
  },
]);

/** A refusal the command reports and exits non-zero on, as distinct from a crash. */
export class PruneRefused extends Error {}

/**
 * The window from `--retention-days`. Refuses anything but a whole number of
 * days at or above the floor: the window is configurable upward only.
 */
export function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  if (!/^\d+$/.test(raw)) {
    throw new PruneRefused(`Refusing: --retention-days must be a whole number of days, got ${JSON.stringify(raw)}.`);
  }
  const days = Number(raw);
  if (days < MIN_RETENTION_DAYS) {
    throw new PruneRefused(
      `Refusing: --retention-days ${days} is below the ${MIN_RETENTION_DAYS}-day minimum (D55 (12)). The window is ` +
        "a floor the owner confirmed and may only be raised.",
    );
  }
  return days;
}

/** What one table's prune removed, as the receipt records it. */
export interface PrunedTable {
  readonly table: string;
  readonly predicate: string;
  readonly windowDays: number;
  readonly cutoff: string;
  readonly rows: number;
  /** The rows each chunk removed, for a chunked target (jobs); absent for a one-statement target. */
  readonly chunks?: readonly number[];
  /** The job_runs rows that went with the jobs (jobs entries only, issue 1584). */
  readonly jobRuns?: number;
}

/** One committed prune transaction, as {@link runPrune} reports it the moment it commits. */
export interface PruneCommit {
  readonly table: string;
  readonly rows: number;
  readonly jobRuns?: number;
}

/**
 * The prune itself: every PRUNE_TARGETS entry, on the rm_owner pool the caller
 * opened. Each target, and each chunk of a jobs entry, is its own transaction
 * fenced with the target key's `pg_advisory_xact_lock` (§2), and the session
 * lock is proven held before each one starts. A competitor that wins the
 * session lock after this process lost it still blocks on the fence until the
 * transaction in flight commits or aborts, and the next one then refuses.
 * `onCommit` hears of each transaction after it commits, so a run that fails
 * part way can still say what it removed.
 */
export async function runPrune(
  owner: postgresTypes.Sql<{}>,
  options: { readonly windowDays: number; readonly lock: HeldTargetLock; readonly onCommit?: (commit: PruneCommit) => void | Promise<void> },
): Promise<readonly PrunedTable[]> {
  if (options.windowDays < MIN_RETENTION_DAYS) {
    throw new PruneRefused(`Refusing: a ${options.windowDays}-day window is below the ${MIN_RETENTION_DAYS}-day minimum.`);
  }
  const pruned: PrunedTable[] = [];
  let now: string | null = null;
  for (const target of PRUNE_TARGETS) {
    const fenced: Fenced = async (body) => {
      await assertStillHeld(options.lock, "prune");
      const result = await withFenceOn(owner, "prune", (tx) => body(tx as postgresTypes.TransactionSql<{}>));
      await options.onCommit?.({
        table: target.table,
        rows: result.rows,
        ...(result.jobRuns === undefined ? {} : { jobRuns: result.jobRuns }),
      });
      return result;
    };
    const windowDays = Math.max(options.windowDays, target.minDays ?? 0);
    const result = await target.run(fenced, now, windowDays);
    now ??= result.now;
    pruned.push({
      table: target.table,
      predicate: target.predicate,
      windowDays,
      cutoff: new Date(result.cutoff).toISOString(),
      rows: result.rows,
      ...(result.chunks === undefined ? {} : { chunks: result.chunks }),
      ...(result.jobRuns === undefined ? {} : { jobRuns: result.jobRuns }),
    });
  }
  return pruned;
}

// ── The journal (§2) ────────────────────────────────────────────────────────

type JournalStatus = "started" | "committed" | "refused" | "failed" | "interrupted";

export interface PruneJournalFile {
  readonly kind: "prune-journal";
  readonly formatVersion: 1;
  readonly pid: number;
  readonly env: "prod" | "stage" | null;
  readonly target: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly outcome: "succeeded" | "refused" | "failed" | "interrupted" | null;
  readonly receipt: string | null;
  readonly phases: readonly {
    readonly phase: string;
    readonly status: JournalStatus;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly reason: string | null;
  }[];
}

/**
 * The prune's journal, beside its receipt: written before each phase, marked
 * after, closed with an outcome on every exit (the shape of
 * ./migrate-journal.ts's). Every write replaces the file through a rename, so
 * a reader never meets a half-written one. It holds no credential.
 */
export class PruneJournal {
  private record: PruneJournalFile;

  private constructor(readonly path: string, env: PruneJournalFile["env"], startedAt: Date) {
    this.record = {
      kind: "prune-journal",
      formatVersion: 1,
      pid: process.pid,
      env,
      target: null,
      openedAt: startedAt.toISOString(),
      closedAt: null,
      outcome: null,
      receipt: null,
      phases: [],
    };
  }

  /** Create the journal file. An existing file refuses: one run, one record. */
  static open(path: string, env: PruneJournalFile["env"], startedAt: Date): PruneJournal {
    const journal = new PruneJournal(path, env, startedAt);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, journal.text(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return journal;
  }

  get closed(): boolean {
    return this.record.closedAt !== null;
  }

  setTarget(target: string): void {
    this.record = { ...this.record, target };
    this.persist();
  }

  begin(phase: string): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    this.record = {
      ...this.record,
      phases: [...this.endCurrent("committed", null, now), { phase, status: "started", startedAt: now, endedAt: null, reason: null }],
    };
    this.persist();
  }

  close(outcome: "succeeded" | "refused" | "failed" | "interrupted", reason: string | null, receipt?: string): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    const status: JournalStatus = outcome === "succeeded" ? "committed" : outcome;
    const last = this.record.phases.at(-1);
    const phases =
      last?.status !== "started" && outcome !== "succeeded"
        ? [...this.record.phases, { phase: "(between phases)", status, startedAt: now, endedAt: now, reason }]
        : this.endCurrent(status, reason, now);
    this.record = { ...this.record, phases, closedAt: now, outcome, receipt: receipt ?? null };
    this.persist();
  }

  closeOnExit(code: number): void {
    this.close("interrupted", `the process exited with code ${code} before the run closed its journal`);
  }

  private endCurrent(status: JournalStatus, reason: string | null, at: string): PruneJournalFile["phases"][number][] {
    const phases = [...this.record.phases];
    const last = phases.at(-1);
    if (last?.status === "started") phases[phases.length - 1] = { ...last, status, endedAt: at, reason };
    return phases;
  }

  private text(): string {
    return `${JSON.stringify(this.record, null, 2)}\n`;
  }

  private persist(): void {
    const staging = `${this.path}.${process.pid}.tmp`;
    writeFileSync(staging, this.text(), { encoding: "utf8", mode: 0o600 });
    renameSync(staging, this.path);
  }
}

const stamp = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");

/** The receipt's filename in the directory it goes to, stamped like the journal's. */
export function pruneReceiptPath(dir: string, startedAt: Date): string {
  return join(dir, `prune-receipt-${stamp(startedAt)}.json`);
}

export function pruneJournalPath(dir: string, startedAt: Date): string {
  return join(dir, `prune-journal-${stamp(startedAt)}.json`);
}

// ── The command ─────────────────────────────────────────────────────────────

/** Password-free `host:port/dbname`, the only form of a target this command prints. */
function redacted(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}

function asOwner(url: string, password: string): string {
  const u = new URL(url);
  u.username = "rm_owner";
  u.password = encodeURIComponent(password);
  return u.toString();
}

export interface PruneReceipt {
  readonly kind: "prune-receipt";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly env: "prod" | "stage" | null;
  readonly target: string;
  readonly targetLock: string;
  readonly windowDays: number;
  readonly tables: readonly PrunedTable[];
}

/**
 * THE sequence: plan, lock, gates, owner, confirm, prune, receipt — each phase
 * journaled. Refusals throw {@link PruneRefused}; the caller exits non-zero.
 */
export async function pruneCommand(input: {
  readonly env: "prod" | "stage" | null;
  /** The target under a credential that cannot delete (`rm_readonly` from `~/.env`). */
  readonly readerUrl: string;
  readonly windowDays: number;
  readonly holder: Omit<LockHolder, "acquiredAt">;
  readonly lockTimeoutMs: number;
  readonly receiptPath: string;
  readonly journal: PruneJournal;
  /** `~/.env`'s rm_owner line, the file, `--confirm-target` and the target the
   *  file resolves to (D61). Never logged, never written. */
  readonly authority: RemoteAuthority;
  readonly log: (message: string) => void;
}): Promise<{ readonly receipt: string; readonly tables: readonly PrunedTable[] }> {
  const startedAt = new Date();
  const target = redacted(input.readerUrl);
  const journal = input.journal;
  journal.setTarget(target);
  const reader = postgres(input.readerUrl, { max: 1, onnotice: () => {} });
  let owner: postgresTypes.Sql<{}> | null = null;
  let release: (() => Promise<void>) | null = null;
  let lock: HeldTargetLock | null = null;
  // What committed so far, by table: a failure part way through the prune
  // phase names it in the journal, because those rows are gone either way.
  const committed = new Map<string, { rows: number; jobRuns: number }>();
  const phase = async (name: string): Promise<void> => {
    journal.begin(name);
    if (lock !== null) await assertStillHeld(lock, name);
  };
  try {
    // The window is judged again here, so no caller reaches the prune with a
    // window below the floor, whatever parsed it.
    parseRetentionDays(String(input.windowDays));

    await phase("plan");
    const expected = await readTargetState(reader);
    await phase("lock");
    const acquired = await acquireTargetLock({
      databaseUrl: input.readerUrl,
      holder: input.holder,
      timeoutMs: input.lockTimeoutMs,
      expected,
    });
    if (!acquired.acquired) throw new PruneRefused(`Refusing: ${acquired.reason}`);
    const held = acquired.lock;
    const dispose = releaseTargetLockOnExit(held);
    release = async () => {
      dispose();
      await held.release();
    };
    lock = held;

    // §4.3: the policy and the target's enrollment must agree, as for every
    // tool that writes a database. A target that is enrolled as nothing is
    // not pruned.
    await phase("gates");
    const verdict = resolveDeploymentPolicy({
      rmEnv: input.env ?? undefined,
      connection: "remote",
      identity: expected.identity === "missing" ? null : expected.identity,
    });
    if (!verdict.allow) throw new PruneRefused(`Refusing: ${verdict.reason}`);
    if (expected.identity === "missing") {
      throw new PruneRefused(
        "Refusing: this database has no deployment_identity row, so it is not enrolled as anything (spec §4.2).",
      );
    }
    input.log(`target ${target} (${expected.identity}) under ${describeHolderText(held.holder)}`);

    await phase("owner");
    let password: string;
    try {
      password = requirePrivilegedPassword({ rm_owner: input.authority.ownerPassword }, "rm_owner", input.authority.envFile);
    } catch (error) {
      throw new PruneRefused((error as Error).message);
    }
    // Prove the login before the confirmation: a connection is opened and
    // authenticated, and no statement is issued on it until the fenced prune.
    owner = postgres(asOwner(input.readerUrl, password), { max: 1, onnotice: () => {} });
    try {
      (await owner.reserve()).release();
    } catch (error) {
      const message = (error as Error).message.split(password).join("***");
      throw new PruneRefused(`Refusing: the rm_owner credential was not accepted by this database (${message}).`);
    }

    await phase("confirm");
    const plan = PRUNE_TARGETS.map((t) => `  ${t.table}: ${t.predicate}${t.minDays ? ` (window at least ${t.minDays} days)` : ""}`).join("\n");
    input.log(
      `WARNING: this deletes rows from ${target} as rm_owner, with a ${input.windowDays}-day window ` +
        "(<cutoff> = the database's now() minus the window):\n" +
        `${plan}\n` +
        "Nothing else is touched: no security tombstone, no audit history.",
    );
    try {
      requireConfirmTarget(input.authority.confirmTarget, input.authority.resolvedTarget, "this prune");
    } catch (error) {
      throw new PruneRefused((error as Error).message);
    }

    await phase("prune");
    const tables = await runPrune(owner, {
      windowDays: input.windowDays,
      lock: held,
      onCommit: (c) => {
        const sum = committed.get(c.table) ?? { rows: 0, jobRuns: 0 };
        committed.set(c.table, { rows: sum.rows + c.rows, jobRuns: sum.jobRuns + (c.jobRuns ?? 0) });
      },
    });
    for (const t of tables) {
      const runs = t.jobRuns === undefined ? "" : ` (and ${t.jobRuns} job_runs row(s))`;
      input.log(`${t.table}: ${t.rows} row(s)${runs} where ${t.predicate}, cutoff ${t.cutoff}`);
    }

    await phase("receipt");
    const receipt: PruneReceipt = {
      kind: "prune-receipt",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      env: input.env,
      target,
      targetLock: describeHolderText(held.holder),
      windowDays: input.windowDays,
      tables,
    };
    mkdirSync(dirname(input.receiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(input.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    journal.close("succeeded", null, input.receiptPath);
    return { receipt: input.receiptPath, tables };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const gone = [...committed].filter(([, c]) => c.rows + c.jobRuns > 0);
    const reason =
      gone.length === 0
        ? message
        : `${message} (committed before it stopped: ${gone
            .map(([table, c]) => `${table} ${c.rows} row(s)${c.jobRuns > 0 ? ` and ${c.jobRuns} job_runs row(s)` : ""}`)
            .join(", ")})`;
    journal.close(error instanceof PruneRefused || message.startsWith("Refusing") ? "refused" : "failed", reason);
    throw error;
  } finally {
    await owner?.end({ timeout: 5 }).catch(() => undefined);
    await release?.().catch(() => undefined);
    await reader.end({ timeout: 5 }).catch(() => undefined);
  }
}

// ── The CLI ─────────────────────────────────────────────────────────────────

async function main(): Promise<never> {
  const NAME = "prune";
  const err = (m: string) => console.error(`[${NAME}] ${m}`);
  const log = (m: string) => console.log(`[${NAME}] ${m}`);
  let journal: PruneJournal | undefined;
  const refuse = (message: string): never => {
    journal?.close("refused", message);
    err(message);
    process.exit(1);
  };
  const flag = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    if (at < 0) return undefined;
    const value = process.argv[at + 1];
    if (!value || value.startsWith("--")) refuse(`${name} needs a value`);
    return value;
  };

  // The window first: a refused window never connects to anything.
  let windowDays = DEFAULT_RETENTION_DAYS;
  try {
    windowDays = parseRetentionDays(flag("--retention-days"));
  } catch (error) {
    refuse((error as Error).message);
  }
  const receiptFlag = flag("--receipt");
  const instanceFlag = flag("--instance");
  const confirmTarget = confirmTargetFlag(process.argv.slice(2));
  const lockTimeoutSeconds = Number(flag("--lock-timeout") ?? 60);
  if (!Number.isFinite(lockTimeoutSeconds) || lockTimeoutSeconds < 0) refuse("--lock-timeout needs a number of seconds");

  const envPath = homeEnvFilePath();
  const env = loadEnvFile(envPath);
  const policy = resolveRmEnv({ RM_ENV: process.env.RM_ENV ?? env?.RM_ENV });
  if (!policy.ok) refuse(policy.reason);
  const rmEnv = policy.ok && policy.source !== "unset" ? policy.env : null;

  // The receipt's home, before anything connects.
  const startedAt = new Date();
  let receiptDir: string;
  if (receiptFlag === undefined) {
    const instance = instanceFlag ?? (rmEnv === "prod" ? PRODUCTION_INSTANCE : undefined);
    if (instance === undefined) {
      refuse("name the instance whose state directory receives the receipt (--instance <name>), or pass --receipt <path>.");
    }
    receiptDir = instancePaths(stateRoot(process.env), instance!).dir;
  } else {
    receiptDir = dirname(resolve(receiptFlag));
  }
  journal = PruneJournal.open(pruneJournalPath(receiptDir, startedAt), rmEnv, startedAt);
  process.on("exit", (code) => journal?.closeOnExit(code));
  journal.begin("config");

  if (!env) refuse(`no readable $HOME/.env (${envPath}).`);
  const readerUrl = urlForRole(env!, "rm_readonly");
  if (!readerUrl) {
    refuse("$HOME/.env cannot assemble an rm_readonly connection (host, port, database, sslmode and an rm_readonly line).");
  }

  const receiptPath = receiptFlag === undefined ? pruneReceiptPath(receiptDir, startedAt) : resolve(receiptFlag);
  try {
    const { receipt, tables } = await pruneCommand({
      env: rmEnv,
      readerUrl: readerUrl!,
      windowDays,
      holder: { tool: NAME, planId: null, instance: instanceFlag ?? null, host: hostname(), pid: process.pid },
      lockTimeoutMs: lockTimeoutSeconds * 1000,
      receiptPath,
      journal,
      authority: { ownerPassword: env!.rm_owner, envFile: envPath, confirmTarget, resolvedTarget: homeEnvTarget(env!)! },
      log,
    });
    log(`pruned ${tables.reduce((n, t) => n + t.rows, 0)} row(s) across ${tables.length} table(s)`);
    log(`receipt ${receipt}`);
    process.exit(0);
  } catch (error) {
    err(error instanceof PruneRefused ? error.message : `failed: ${error instanceof Error ? error.message : String(error)}`);
    log(`journal ${journal.path}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
