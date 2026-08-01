// Migration 0017 (admin surface: queue scope metadata, analytics telemetry
// tables + worker-role revokes, committee versioning/session roster+event
// backfill, audit_log extension — issue #150, docs/architecture.md §5).
//
// This file provisions its OWN ephemeral Postgres, deliberately separate from
// the shared suite database that tests/preload.ts migrates through 0017
// before any test file loads. By the time preload's database is available,
// 0017's constraints (FKs, status checks) are already enforced, so pre-0017
// legacy/orphan/unknown-status fixtures can no longer be seeded there. Here we
// apply migrations 0001..0016 for a genuine pre-0017 baseline, seed legacy
// fixtures, apply 0017 (AC1), then apply it again verbatim (AC2) and assert
// the catalog and row counts are stable — proving the migration is idempotent
// and preserves existing data, exactly like every other migration in this repo.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const WORKER_PASSWORD = "rm_worker_admin_surface_ci_password";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

let containerName: string;
let db: postgres.Sql<{}>;
let worker: postgres.Sql<{}>;

// IDs captured during fixture seeding, used by later assertions.
let s1Id: string; // valid subject, quorum evidence forces incomplete reconstruction
let s2Id: string; // orphan subject, no quorum evidence

interface CatalogSnapshot {
  tables: number;
  indexes: number;
  constraints: number;
  rosterRows: number;
  eventRows: number;
  backfillAudit: number;
}

const NEW_TABLES = [
  "analytics_runs", "analytics_stage_runs", "analytics_artifacts",
  "committee_session_members", "committee_session_events",
];
const NEW_INDEXES = [
  "jobs_scope_idx", "analytics_runs_started_idx", "analytics_runs_job_attempt_idx",
  "analytics_runs_asof_kind_idx", "analytics_artifacts_run_tool_idx",
  "analytics_artifacts_key_created_idx", "committee_session_events_session_idx",
  "audit_log_at_idx", "audit_log_target_idx", "audit_log_request_idx",
];
const NEW_CONSTRAINTS = [
  "jobs_status_check", "committee_members_status_check", "committee_subjects_status_check",
  "committee_applications_status_check", "committee_sessions_state_check",
  "committee_sessions_subject_fk", "committee_recommendations_subject_fk",
  "committee_subject_snapshots_subject_fk", "committee_briefs_subject_fk",
];

async function snapshot(): Promise<CatalogSnapshot> {
  const [{ n: tables }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${NEW_TABLES})`;
  const [{ n: indexes }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = ANY(${NEW_INDEXES})`;
  const [{ n: constraints }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint WHERE conname = ANY(${NEW_CONSTRAINTS})`;
  const [{ n: rosterRows }] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM committee_session_members`;
  const [{ n: eventRows }] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM committee_session_events`;
  const [{ n: backfillAudit }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log WHERE action = 'backfill_session_roster'`;
  return { tables, indexes, constraints, rosterRows, eventRows, backfillAudit };
}

let afterFirstApply: CatalogSnapshot;
let afterSecondApply: CatalogSnapshot;

// postgres.js tagged-template results are lazy "PendingQuery" thenables, not
// plain Promises; bun:test's `expect(query).rejects` wrapper hangs against
// them rather than resolving (mirrors why every other DB test in this repo
// uses a manual try/catch instead — see analytics-worker-role.test.ts's
// `denied` helper). Assert rejection this way instead.
async function rejected(query: Promise<unknown>): Promise<boolean> {
  try {
    await query;
    return false;
  } catch {
    return true;
  }
}

beforeAll(async () => {
  const port = await freePort();
  containerName = `rmtest_admin_migration_${crypto.randomUUID().slice(0, 8)}`;
  const up = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
    "-p", `${port}:5432`, "postgres:17-alpine",
  ]);
  if (up.exitCode !== 0) {
    throw new Error(
      `admin-surface-migration test requires Docker+Postgres but the container failed to start:\n${up.stderr.toString()}`,
    );
  }
  const url = `postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`;
  db = postgres(url, { max: 4, onnotice: () => {} });

  // Wait for a REAL accepting connection (mirrors src/db/migrate.ts's waitForDb).
  const start = Date.now();
  for (;;) {
    try { await db`SELECT 1`; break; } catch (err) {
      if (Date.now() - start > 30_000) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const preAdminSurface = files.filter((f) => f < "0017_admin_surface.sql");
  const adminSurface = files.find((f) => f === "0017_admin_surface.sql");
  if (!adminSurface) throw new Error("0017_admin_surface.sql not found in backend/migrations");
  expect(preAdminSurface.length).toBeGreaterThan(0);

  for (const file of preAdminSurface) {
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    await db.begin(async (tx) => { await tx.unsafe(ddl); });
  }

  // ── Seed representative LEGACY fixtures BEFORE 0017 exists ────────────────
  // (0017's FK/status/state checks are not yet enforced at this point).
  await db`INSERT INTO committee_subjects (id, status, name) VALUES ('legacy-subj', 'active', 'Legacy Subject')`;
  await db`INSERT INTO committee_members (id, status, name, lens) VALUES
    ('legacy-member-1', 'active', 'Member One', 'macro'),
    ('legacy-member-2', 'bogus', 'Member Two', 'flows'),
    ('legacy-member-3', 'active', 'Member Three', 'onchain')`;
  await db`INSERT INTO committee_applications (member_id, payload, status)
    VALUES ('legacy-member-2', '{}'::jsonb, 'bogus')`;
  await db`INSERT INTO jobs (kind, payload, status) VALUES ('legacy.kind', '{}'::jsonb, 'failed')`;
  await db`INSERT INTO jobs (kind, payload, status) VALUES ('legacy.kind2', '{}'::jsonb, 'pending')`;

  // S1: valid subject, quorum evidence (active=3) but only 2 active members
  // will ever exist — forces the "reconstruction incomplete" branch.
  const [s1] = await db<{ id: string }[]>`
    INSERT INTO committee_sessions (id, date, subject_id, subject_name, state, committee_recommendation, generated_at)
    VALUES (gen_random_uuid(), '2024-01-01', 'legacy-subj', 'Legacy Subject', 'published',
            ${db.json({ quorum: { active: 3, submitted: 1, absent: 2 } })}, now())
    RETURNING id`;
  s1Id = s1.id;

  // S2: orphan subject reference, no quorum evidence at all.
  const [s2] = await db<{ id: string }[]>`
    INSERT INTO committee_sessions (id, date, subject_id, subject_name, state, generated_at)
    VALUES (gen_random_uuid(), '2024-02-01', 'orphan-subject-1', 'Orphan Subject', 'scheduled', now())
    RETURNING id`;
  s2Id = s2.id;

  // One accepted recommendation for S1 from the active member who submitted.
  await db`INSERT INTO committee_recommendations
      (session_id, member_id, subject_id, date, nonce, stance, payload, signature, verified)
    VALUES (${s1Id}, 'legacy-member-1', 'legacy-subj', '2024-01-01', 'nonce-1', 'bullish', '{}'::jsonb, 'sig', true)`;

  // A second orphan subject reference via a different table (snapshots).
  await db`INSERT INTO committee_subject_snapshots (subject_id, date, total_value_usd)
    VALUES ('orphan-subject-2', '2024-01-01', 100)`;

  await db`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'legacy_action', '{}'::jsonb)`;

  // ── AC1: apply 0017 to this legacy-seeded database ─────────────────────────
  const ddl0017 = await readFile(join(migrationsDir, adminSurface), "utf8");
  await db.begin(async (tx) => { await tx.unsafe(ddl0017); });
  afterFirstApply = await snapshot();

  // ── AC2: re-run 0017 verbatim a second time ────────────────────────────────
  await db.begin(async (tx) => { await tx.unsafe(ddl0017); });
  afterSecondApply = await snapshot();

  // Provision the worker role's CI login (mirrors analytics-worker-role.test.ts).
  await db.unsafe(`ALTER ROLE rm_worker WITH LOGIN PASSWORD '${WORKER_PASSWORD}'`);
  const workerUrl = new URL(url);
  workerUrl.username = "rm_worker";
  workerUrl.password = WORKER_PASSWORD;
  worker = postgres(workerUrl.toString(), { max: 2, onnotice: () => {} });
}, 60_000);

afterAll(async () => {
  await worker?.end({ timeout: 5 });
  await db?.end({ timeout: 5 });
  if (containerName) Bun.spawnSync(["docker", "rm", "-f", containerName]);
});

test("AC1: applying 0017 to a DB with legacy rows exits successfully and preserves every seeded row", async () => {
  const [job1] = await db<{ kind: string; status: string }[]>`SELECT kind, status FROM jobs WHERE kind = 'legacy.kind'`;
  expect(job1).toEqual({ kind: "legacy.kind", status: "failed" });
  const [job2] = await db<{ kind: string; status: string }[]>`SELECT kind, status FROM jobs WHERE kind = 'legacy.kind2'`;
  expect(job2).toEqual({ kind: "legacy.kind2", status: "pending" });

  const [subject] = await db<{ status: string; name: string }[]>`
    SELECT status, name FROM committee_subjects WHERE id = 'legacy-subj'`;
  expect(subject).toEqual({ status: "active", name: "Legacy Subject" });

  const [session1] = await db<{ state: string; subject_id: string }[]>`
    SELECT state, subject_id FROM committee_sessions WHERE id = ${s1Id}`;
  expect(session1).toEqual({ state: "published", subject_id: "legacy-subj" });

  const [session2] = await db<{ state: string }[]>`SELECT state FROM committee_sessions WHERE id = ${s2Id}`;
  expect(session2.state).toBe("scheduled");

  const [rec] = await db<{ stance: string }[]>`
    SELECT stance FROM committee_recommendations WHERE session_id = ${s1Id} AND member_id = 'legacy-member-1'`;
  expect(rec.stance).toBe("bullish");

  const [audit] = await db<{ action: string; outcome: string }[]>`
    SELECT action, outcome FROM audit_log WHERE action = 'legacy_action'`;
  // outcome NOT NULL DEFAULT 'succeeded' backfills the pre-existing legacy row too.
  expect(audit).toEqual({ action: "legacy_action", outcome: "succeeded" });
});

test("AC2: running 0017 twice produces no duplicate tables, indexes, constraints, backfill events, or roster rows", () => {
  expect(afterFirstApply.tables).toBe(NEW_TABLES.length);
  expect(afterFirstApply.indexes).toBe(NEW_INDEXES.length);
  expect(afterFirstApply.constraints).toBe(NEW_CONSTRAINTS.length);
  expect(afterFirstApply.rosterRows).toBeGreaterThan(0);
  expect(afterFirstApply.eventRows).toBeGreaterThan(0);
  expect(afterFirstApply.backfillAudit).toBeGreaterThan(0);

  expect(afterSecondApply).toEqual(afterFirstApply);
});

test("jobs: accepts cancelled, retains failed, has the four metadata columns and the scoped-job index", async () => {
  await db`INSERT INTO jobs (kind, payload, status) VALUES ('cancel-test', '{}'::jsonb, 'cancelled')`;
  const [row] = await db<{ status: string }[]>`SELECT status FROM jobs WHERE kind = 'cancel-test'`;
  expect(row.status).toBe("cancelled");

  const cols = await db<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'jobs' AND column_name IN ('scope_type', 'scope_id', 'requested_by', 'audit_request_id')`;
  expect(cols.map((c) => c.column_name).sort()).toEqual(
    ["audit_request_id", "requested_by", "scope_id", "scope_type"],
  );

  const [idx] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'jobs_scope_idx'`;
  expect(idx.n).toBe(1);

  // 'failed' must still be a legal status (existing/legacy rows may carry it).
  await db`INSERT INTO jobs (kind, payload, status) VALUES ('failed-still-legal', '{}'::jsonb, 'failed')`;
  const [failedRow] = await db<{ status: string }[]>`SELECT status FROM jobs WHERE kind = 'failed-still-legal'`;
  expect(failedRow.status).toBe("failed");
});

test("analytics telemetry tables, stage/status checks, foreign keys, indexes, and defaults exist", async () => {
  const [run] = await db<{
    status: string; tools: unknown; warning_count: number; warnings: unknown; code_version: string; audit_request_id: string | null;
  }[]>`
    INSERT INTO analytics_runs (job_kind, attempt, asof, source_mode, created_by)
    VALUES ('regime.classify', 1, '2024-01-01', 'hermetic', 'test')
    RETURNING status, tools, warning_count, warnings, code_version, audit_request_id`;
  expect(run.status).toBe("running");
  expect(run.tools).toEqual([]);
  expect(run.warning_count).toBe(0);
  expect(run.warnings).toEqual([]);
  expect(run.code_version).toBe("unknown");
  expect(run.audit_request_id).toBeNull();

  const [runId] = await db<{ id: string }[]>`SELECT id FROM analytics_runs WHERE job_kind = 'regime.classify' AND created_by = 'test'`;

  const [stage] = await db<{ status: string; summary: unknown }[]>`
    INSERT INTO analytics_stage_runs (analytics_run_id, tool_id, stage, sequence)
    VALUES (${runId.id}, 'regime', 'access', 1)
    RETURNING status, summary`;
  expect(stage.status).toBe("pending");
  expect(stage.summary).toEqual({});

  // Bad stage/status values are rejected.
  expect(await rejected(
    db`INSERT INTO analytics_stage_runs (analytics_run_id, tool_id, stage, sequence)
       VALUES (${runId.id}, 'regime', 'not-a-real-stage', 2)`,
  )).toBe(true);
  expect(await rejected(
    db`INSERT INTO analytics_runs (job_kind, attempt, asof, source_mode, created_by)
       VALUES ('x', 1, '2024-01-01', 'not-a-real-source', 'test')`,
  )).toBe(true);

  const [artifact] = await db<{ storage_ref: unknown }[]>`
    INSERT INTO analytics_artifacts (analytics_run_id, tool_id, kind, artifact_key)
    VALUES (${runId.id}, 'regime', 'indicator', 'ROLE_TEST')
    RETURNING storage_ref`;
  expect(artifact.storage_ref).toEqual({});

  // FKs: deleting the run cascades to its stage runs and artifacts.
  await db`DELETE FROM analytics_runs WHERE id = ${runId.id}`;
  const [{ n: remainingStages }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM analytics_stage_runs WHERE analytics_run_id = ${runId.id}`;
  const [{ n: remainingArtifacts }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM analytics_artifacts WHERE analytics_run_id = ${runId.id}`;
  expect(remainingStages).toBe(0);
  expect(remainingArtifacts).toBe(0);
});

test("rm_worker is DENIED insert/update/delete on every analytics telemetry table; queue insert/update/select still work", async () => {
  const [{ id: runId }] = await db<{ id: string }[]>`
    INSERT INTO analytics_runs (job_kind, attempt, asof, source_mode, created_by)
    VALUES ('regime.classify', 1, '2024-01-02', 'hermetic', 'role-test')
    RETURNING id`;
  const [{ id: stageId }] = await db<{ id: number }[]>`
    INSERT INTO analytics_stage_runs (analytics_run_id, tool_id, stage, sequence)
    VALUES (${runId}, 'regime', 'access', 1) RETURNING id`;
  await db`INSERT INTO analytics_artifacts (analytics_run_id, stage_run_id, tool_id, kind, artifact_key)
    VALUES (${runId}, ${stageId}, 'regime', 'indicator', 'ROLE_TEST_2')`;

  const denied = async (q: Promise<unknown>) => {
    try { await q; return null; } catch (e) { return (e as { code?: string }).code ?? "unknown"; }
  };

  expect(await denied(worker`INSERT INTO analytics_runs (job_kind, attempt, asof, source_mode, created_by)
    VALUES ('x', 1, '2024-01-02', 'hermetic', 'worker')`)).toBe("42501");
  expect(await denied(worker`UPDATE analytics_runs SET status = 'failed' WHERE id = ${runId}`)).toBe("42501");
  expect(await denied(worker`DELETE FROM analytics_runs WHERE id = ${runId}`)).toBe("42501");

  expect(await denied(worker`INSERT INTO analytics_stage_runs (analytics_run_id, tool_id, stage, sequence)
    VALUES (${runId}, 'regime', 'extract', 2)`)).toBe("42501");
  expect(await denied(worker`UPDATE analytics_stage_runs SET status = 'failed' WHERE id = ${stageId}`)).toBe("42501");
  expect(await denied(worker`DELETE FROM analytics_stage_runs WHERE id = ${stageId}`)).toBe("42501");

  expect(await denied(worker`INSERT INTO analytics_artifacts (analytics_run_id, tool_id, kind, artifact_key)
    VALUES (${runId}, 'regime', 'indicator', 'ROLE_TEST_3')`)).toBe("42501");
  expect(await denied(worker`UPDATE analytics_artifacts SET checksum = 'x' WHERE artifact_key = 'ROLE_TEST_2'`)).toBe("42501");
  expect(await denied(worker`DELETE FROM analytics_artifacts WHERE artifact_key = 'ROLE_TEST_2'`)).toBe("42501");

  // Reads remain allowed.
  const [read] = await worker<{ id: string }[]>`SELECT id FROM analytics_runs WHERE id = ${runId}`;
  expect(read.id).toBe(runId);

  // Queue lifecycle is untouched by the telemetry revoke.
  const [{ id: jobId }] = await worker`INSERT INTO jobs (kind, payload) VALUES ('role-noop', '{}') RETURNING id`;
  await worker`UPDATE jobs SET status = 'succeeded' WHERE id = ${jobId}`;
  const [job] = await worker<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}`;
  expect(job.status).toBe("succeeded");
});

test("committee version/updated_at columns, six legal session states, and roster/event tables exist", async () => {
  for (const table of ["committee_members", "committee_subjects", "committee_sessions"]) {
    const cols = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${table} AND column_name IN ('version', 'updated_at')`;
    expect(cols.map((c) => c.column_name).sort()).toEqual(["updated_at", "version"]);
  }

  const schedulingCols = await db<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'committee_sessions'
      AND column_name IN ('brief_opens_at', 'window_closes_at', 'publish_at', 'cancelled_at')`;
  expect(schedulingCols.map((c) => c.column_name).sort()).toEqual(
    ["brief_opens_at", "cancelled_at", "publish_at", "window_closes_at"],
  );

  for (const state of ["scheduled", "collecting", "window_closed", "aggregated", "published", "cancelled"]) {
    await db`INSERT INTO committee_sessions (date, subject_id, subject_name, state)
      VALUES (${`2030-01-0${["scheduled", "collecting", "window_closed", "aggregated", "published", "cancelled"].indexOf(state) + 1}`}, 'legacy-subj', 'Legacy Subject', ${state})`;
  }
  expect(await rejected(
    db`INSERT INTO committee_sessions (date, subject_id, subject_name, state)
       VALUES ('2030-02-01', 'legacy-subj', 'Legacy Subject', 'brief_published')`,
  )).toBe(true);

  const memberCols = await db<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'committee_session_members'`;
  expect(memberCols.map((c) => c.column_name).sort()).toEqual(
    ["excused_at", "included_at", "member_id", "member_lens", "member_name", "reason", "session_id", "status"].sort(),
  );

  const eventCols = await db<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'committee_session_events'`;
  expect(eventCols.map((c) => c.column_name).sort()).toEqual(
    ["action", "actor", "at", "from_state", "id", "job_id", "reason", "session_id", "to_state"].sort(),
  );
});

test("session roster/event backfill: submitted members are expected, incomplete reconstruction is flagged approximate, one backfill event per session", async () => {
  const roster = await db<{ member_id: string; status: string }[]>`
    SELECT member_id, status FROM committee_session_members WHERE session_id = ${s1Id} ORDER BY member_id`;
  // legacy-member-1 submitted (step 1); only one more active member exists
  // globally (legacy-member-3) to fill the recorded quorum of 3 (step 2), so
  // exactly 2 rows land — the target of 3 cannot be reached.
  expect([...roster]).toEqual([
    { member_id: "legacy-member-1", status: "expected" },
    { member_id: "legacy-member-3", status: "expected" },
  ]);

  const [approxAudit] = await db<{ scope: { sessionId: string; approximate: boolean; target: number; reconstructed: number } }[]>`
    SELECT scope FROM audit_log WHERE action = 'backfill_session_roster' AND target_id = ${s1Id}`;
  expect(approxAudit.scope).toEqual({ sessionId: s1Id, approximate: true, target: 3, reconstructed: 2 });

  // S2 had no submissions and no quorum evidence: no roster rows, but it still
  // gets exactly one lifecycle backfill event.
  const [{ n: s2Roster }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM committee_session_members WHERE session_id = ${s2Id}`;
  expect(s2Roster).toBe(0);

  for (const sessionId of [s1Id, s2Id]) {
    const events = await db<{ action: string; to_state: string }[]>`
      SELECT action, to_state FROM committee_session_events WHERE session_id = ${sessionId} AND action = 'backfill'`;
    expect(events.length).toBe(1);
  }
  const [s1Event] = await db<{ to_state: string }[]>`
    SELECT to_state FROM committee_session_events WHERE session_id = ${s1Id} AND action = 'backfill'`;
  expect(s1Event.to_state).toBe("published");
});

test("orphan subject_id references get inactive placeholders and unknown statuses are normalized, before constraints are enforced", async () => {
  const placeholders = await db<{ id: string; status: string }[]>`
    SELECT id, status FROM committee_subjects WHERE id IN ('orphan-subject-1', 'orphan-subject-2') ORDER BY id`;
  expect([...placeholders]).toEqual([
    { id: "orphan-subject-1", status: "inactive" },
    { id: "orphan-subject-2", status: "inactive" },
  ]);

  const [member2] = await db<{ status: string }[]>`SELECT status FROM committee_members WHERE id = 'legacy-member-2'`;
  expect(member2.status).toBe("inactive");
  const [app2] = await db<{ status: string }[]>`
    SELECT status FROM committee_applications WHERE member_id = 'legacy-member-2'`;
  expect(app2.status).toBe("rejected");

  // The subject FK is now live: a brand-new orphan reference is rejected.
  expect(await rejected(
    db`INSERT INTO committee_sessions (date, subject_id, subject_name, state)
       VALUES ('2030-03-01', 'still-orphan', 'Still Orphan', 'scheduled')`,
  )).toBe(true);

  // And the status checks are live too.
  expect(await rejected(
    db`UPDATE committee_members SET status = 'not-a-real-status' WHERE id = 'legacy-member-1'`,
  )).toBe(true);
});

test("audit_log retains scope and supports request, target, reason, before/after, outcome, and job/session references, with the required indexes", async () => {
  const cols = await db<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'`;
  expect(cols.map((c) => c.column_name).sort()).toEqual(
    [
      "id", "actor", "action", "scope", "at",
      "request_id", "target_type", "target_id", "reason",
      "before_state", "after_state", "outcome", "job_id", "session_id",
    ].sort(),
  );

  const [{ id: jobId }] = await db<{ id: number }[]>`
    INSERT INTO jobs (kind, payload) VALUES ('audit-fk-test', '{}'::jsonb) RETURNING id`;

  const [row] = await db<{
    request_id: string; target_type: string; target_id: string; reason: string;
    before_state: unknown; after_state: unknown; outcome: string; job_id: number; session_id: string;
  }[]>`
    INSERT INTO audit_log (actor, action, scope, target_type, target_id, reason, before_state, after_state, job_id, session_id)
    VALUES ('admin', 'audit_columns_test', '{}'::jsonb, 'job', ${String(jobId)}, 'testing audit columns',
            ${db.json({ status: "pending" })}, ${db.json({ status: "cancelled" })}, ${jobId}, ${s1Id})
    RETURNING request_id, target_type, target_id, reason, before_state, after_state, outcome, job_id, session_id`;
  expect(row.request_id).toBeTruthy();
  expect(row.target_type).toBe("job");
  expect(row.target_id).toBe(String(jobId));
  expect(row.reason).toBe("testing audit columns");
  expect(row.before_state).toEqual({ status: "pending" });
  expect(row.after_state).toEqual({ status: "cancelled" });
  expect(row.outcome).toBe("succeeded"); // default, not passed explicitly
  expect(row.job_id).toBe(jobId);
  expect(row.session_id).toBe(s1Id);

  // ON DELETE SET NULL: deleting the referenced job/session never deletes the audit row.
  await db`DELETE FROM jobs WHERE id = ${jobId}`;
  const [afterDelete] = await db<{ job_id: number | null; outcome: string }[]>`
    SELECT job_id, outcome FROM audit_log WHERE action = 'audit_columns_test'`;
  expect(afterDelete.job_id).toBeNull();
  expect(afterDelete.outcome).toBe("succeeded");

  const idx = await db<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'audit_log'
      AND indexname IN ('audit_log_at_idx', 'audit_log_target_idx', 'audit_log_request_idx')`;
  expect(idx.map((i) => i.indexname).sort()).toEqual(
    ["audit_log_at_idx", "audit_log_request_idx", "audit_log_target_idx"],
  );
});
