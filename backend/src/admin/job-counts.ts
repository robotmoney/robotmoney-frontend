// The admin job counts, without scanning the jobs heap (issue 1581).
//
// WHY. `SELECT status, count(*) FROM jobs GROUP BY status` read every row: 278 ms
// on production's 64 MB heap (2026-11-05), on every admin overview and jobs page
// load, and each scan evicted pages the api routes needed. A heap scan of that
// size cannot meet the issue's 50 ms budget, so a large table is no longer
// counted row by row.
//
// HOW. One statement per count, deciding inside the database:
//   * SMALL TABLE (planner estimate under EXACT_COUNT_MAX_ROWS rows, or never
//     analyzed): the exact GROUP BY, as before. Cheap at that size.
//   * LARGE TABLE:
//       - `pending` and `running` (by status) are EXACT, read through the
//         partial index jobs_live_kind_locked_idx (migration 0130), which holds
//         only those rows;
//       - every other status, and every kind, is an ESTIMATE: the planner's row
//         count for jobs (`pg_class.reltuples`, kept by ANALYZE/autovacuum)
//         times the value's share in its most-common-values statistics
//         (`pg_stats.most_common_freqs`). No row of jobs is read for them. A
//         value too rare to be in the statistics is left out.
// The exact branch's heap scan stays in the plan behind a one-time filter, and
// is never executed on a large table (tests/jobs-query-plans.test.ts asserts
// both the time and that the scan ran zero times).
//
// The response keeps its shape (Record<string, number>), so the admin page is
// unchanged; on a large table the terminal totals are approximate.
import { on, registerQuery, type RegistryDb } from "../db/registry.ts";

/** Below this many rows (planner estimate) the counts stay exact. */
export const EXACT_COUNT_MAX_ROWS = 50_000;

const ADMIN_ROUTE = "src/api/routes/admin";

const BY_STATUS_SQL = `WITH est AS (
      SELECT GREATEST(c.reltuples, 0)::float8 AS total, c.reltuples >= 0 AS analyzed
        FROM pg_catalog.pg_class c WHERE c.oid = 'public.jobs'::regclass
    ), mcv AS (
      SELECT v.value, v.freq::float8 AS freq
        FROM pg_catalog.pg_stats s, unnest(s.most_common_vals::text::text[], s.most_common_freqs) AS v(value, freq)
       WHERE s.schemaname = 'public' AND s.tablename = 'jobs' AND s.attname = 'status'
    ), mode AS (
      SELECT (SELECT analyzed AND total >= $1 FROM est) AND EXISTS (SELECT 1 FROM mcv) AS estimate
    )
    SELECT status, count(*)::int AS n FROM jobs WHERE NOT (SELECT estimate FROM mode) GROUP BY status
    UNION ALL
    SELECT status, count(*)::int FROM jobs WHERE (SELECT estimate FROM mode) AND status IN ('pending', 'running') GROUP BY status
    UNION ALL
    SELECT m.value, round(m.freq * e.total)::int FROM mcv m, est e
     WHERE (SELECT estimate FROM mode) AND m.value NOT IN ('pending', 'running')`;

const BY_KIND_SQL = `WITH est AS (
      SELECT GREATEST(c.reltuples, 0)::float8 AS total, c.reltuples >= 0 AS analyzed
        FROM pg_catalog.pg_class c WHERE c.oid = 'public.jobs'::regclass
    ), mcv AS (
      SELECT v.value, v.freq::float8 AS freq
        FROM pg_catalog.pg_stats s, unnest(s.most_common_vals::text::text[], s.most_common_freqs) AS v(value, freq)
       WHERE s.schemaname = 'public' AND s.tablename = 'jobs' AND s.attname = 'kind'
    ), mode AS (
      SELECT (SELECT analyzed AND total >= $1 FROM est) AND EXISTS (SELECT 1 FROM mcv) AS estimate
    )
    SELECT kind, count(*)::int AS n FROM jobs WHERE NOT (SELECT estimate FROM mode) GROUP BY kind
    UNION ALL
    SELECT m.value, round(m.freq * e.total)::int FROM mcv m, est e WHERE (SELECT estimate FROM mode)`;

const jobsByStatus = registerQuery({
  role: "rm_app",
  object: "jobs",
  privileges: ["SELECT"],
  site: "src/admin/job-counts:jobCountsByStatus",
  purpose: "Count jobs per status for the admin overview and jobs page: exact on a small table; on a large one, live statuses exact through the partial index and the rest from planner statistics (issue 1581).",
  callers: [ADMIN_ROUTE],
  probe: { statement: BY_STATUS_SQL, params: [EXACT_COUNT_MAX_ROWS] },
});

const jobsByKind = registerQuery({
  role: "rm_app",
  object: "jobs",
  privileges: ["SELECT"],
  site: "src/admin/job-counts:jobCountsByKind",
  purpose: "Count jobs per kind for the admin jobs page: exact on a small table, from planner statistics on a large one (issue 1581).",
  callers: [ADMIN_ROUTE],
  probe: { statement: BY_KIND_SQL, params: [EXACT_COUNT_MAX_ROWS] },
});

const toRecord = (rows: readonly { k: string; n: number }[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k] = Number(r.n);
  return out;
};

/** Jobs per status: exact, or (large table) exact live statuses plus estimated terminal ones. */
export async function jobCountsByStatus(db: RegistryDb): Promise<Record<string, number>> {
  const rows = await on(db, jobsByStatus)<{ status: string; n: number }>`WITH est AS (
      SELECT GREATEST(c.reltuples, 0)::float8 AS total, c.reltuples >= 0 AS analyzed
        FROM pg_catalog.pg_class c WHERE c.oid = 'public.jobs'::regclass
    ), mcv AS (
      SELECT v.value, v.freq::float8 AS freq
        FROM pg_catalog.pg_stats s, unnest(s.most_common_vals::text::text[], s.most_common_freqs) AS v(value, freq)
       WHERE s.schemaname = 'public' AND s.tablename = 'jobs' AND s.attname = 'status'
    ), mode AS (
      SELECT (SELECT analyzed AND total >= ${EXACT_COUNT_MAX_ROWS} FROM est) AND EXISTS (SELECT 1 FROM mcv) AS estimate
    )
    SELECT status, count(*)::int AS n FROM jobs WHERE NOT (SELECT estimate FROM mode) GROUP BY status
    UNION ALL
    SELECT status, count(*)::int FROM jobs WHERE (SELECT estimate FROM mode) AND status IN ('pending', 'running') GROUP BY status
    UNION ALL
    SELECT m.value, round(m.freq * e.total)::int FROM mcv m, est e
     WHERE (SELECT estimate FROM mode) AND m.value NOT IN ('pending', 'running')`;
  return toRecord(rows.map((r) => ({ k: r.status, n: r.n })));
}

/** Jobs per kind: exact, or (large table) estimated from planner statistics. */
export async function jobCountsByKind(db: RegistryDb): Promise<Record<string, number>> {
  const rows = await on(db, jobsByKind)<{ kind: string; n: number }>`WITH est AS (
      SELECT GREATEST(c.reltuples, 0)::float8 AS total, c.reltuples >= 0 AS analyzed
        FROM pg_catalog.pg_class c WHERE c.oid = 'public.jobs'::regclass
    ), mcv AS (
      SELECT v.value, v.freq::float8 AS freq
        FROM pg_catalog.pg_stats s, unnest(s.most_common_vals::text::text[], s.most_common_freqs) AS v(value, freq)
       WHERE s.schemaname = 'public' AND s.tablename = 'jobs' AND s.attname = 'kind'
    ), mode AS (
      SELECT (SELECT analyzed AND total >= ${EXACT_COUNT_MAX_ROWS} FROM est) AND EXISTS (SELECT 1 FROM mcv) AS estimate
    )
    SELECT kind, count(*)::int AS n FROM jobs WHERE NOT (SELECT estimate FROM mode) GROUP BY kind
    UNION ALL
    SELECT m.value, round(m.freq * e.total)::int FROM mcv m, est e WHERE (SELECT estimate FROM mode)`;
  return toRecord(rows.map((r) => ({ k: r.kind, n: r.n })));
}
