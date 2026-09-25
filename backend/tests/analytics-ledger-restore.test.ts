// Issue #979 AC8: dump/restore preserves all Phase A evidence and guards.
//
// This is a REAL pg_dump / pg_restore round-trip, not a schema-text or
// SQL-compilation check: it seeds a populated Phase A lineage (source
// acquisition -> frozen vintage -> terminal run package -> report snapshot ->
// signed recommendation -> brief revision), dumps it with the ephemeral
// Postgres container's OWN bundled client tools (the host's pg_dump may be an
// older major than the server — pg_dump cannot dump from a newer server at
// all, see scripts/smoke-twin-capture.ts's clientVersionComplaint), restores
// it into a brand-new, empty database, and inspects the RESTORED copy: every
// foreign key validated, every stored checksum recomputes from the retrieved
// bytes, every join this ledger promises resolves, the ledger-derived current
// reconstruction queries successfully, and every immutability guard is still
// armed.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { checkAppendOnlyGuard } from "../src/db/append-only-guard.ts";
import { checkAnalyticsLedgerGuard } from "../src/db/analytics-ledger-guard.ts";
import {
  ledgerCurrentRawIndicatorHistory,
  ledgerCurrentRegimeSnapshots,
  ledgerCurrentResearchSignals,
} from "../src/analytics/cutover/ledger-current.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// `new URL(pgUrl).origin` is "null" for a non-special scheme like postgres:
// (WHATWG URL only computes a real origin for http/https/ws/wss/ftp/file) —
// build the base manually instead.
function pgBaseUrl(): string {
  const u = new URL(process.env.DATABASE_URL!);
  return `postgres://${u.username}:${u.password}@${u.host}`;
}

const container = process.env.RM_TEST_PG_CONTAINER;
if (!container) {
  // Loud, never a silent skip (test-coverage-policy.md invariant 1): a
  // missing container name means preload.ts's contract changed, not that
  // this test should quietly pass.
  throw new Error("RM_TEST_PG_CONTAINER is not set — tests/preload.ts must publish the ephemeral postgres container name");
}

function dockerExec(args: string[], stdin?: Buffer): { stdout: Buffer; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["docker", "exec", ...(stdin ? ["-i"] : []), container!, ...args], {
    stdin,
    env: { ...process.env, PGPASSWORD: "robotmoney" },
  });
  return { stdout: Buffer.from(proc.stdout), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? 1 };
}

let restoreDb: postgres.Sql<{}> | null = null;
let restoreDbName: string | null = null;

afterAll(async () => {
  if (restoreDb) await restoreDb.end({ timeout: 5 }).catch(() => {});
  if (restoreDbName) {
    const admin = postgres(pgBaseUrl() + "/postgres", { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${restoreDbName}" WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
});

test("a populated Phase A lineage survives a real pg_dump/pg_restore round-trip into a clean database, with every guard still armed", async () => {
  // ── seed a complete, cross-linked Phase A lineage ─────────────────────────
  const acquisition = crypto.randomUUID();
  const fetchId = crypto.randomUUID();
  const payloadBytes = Buffer.from('{"restore":"probe"}', "utf8");
  const payloadChecksum = sha256Hex(payloadBytes);
  await sql`INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity) VALUES (${acquisition}, 'fixture', '1', 'restore-test')`;
  await sql`INSERT INTO source_acquisition_events (acquisition_id, sequence, event_type) VALUES (${acquisition}, 1, 'succeeded')`;
  await sql`INSERT INTO source_fetches (id, acquisition_id, sequence, request_identity, cache_status, response_status, response_checksum)
            VALUES (${fetchId}, ${acquisition}, 1, '{"method":"GET","url":"https://example.invalid","headers":{}}', 'disabled', 200, ${payloadChecksum})`;
  const [svv] = (await sql`
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind)
    VALUES (${acquisition}, 'raw_indicator_history:RESTORE_IND', '2024-08-01', 3.5, 'initial')
    RETURNING id`) as unknown as { id: string }[];

  const [methodology] = (await sql`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
    VALUES ('restore-test', 'v-test', '{"k":"v"}'::jsonb, ${"4".repeat(64)}) RETURNING id`) as unknown as { id: string }[];
  const [run] = (await sql`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
    VALUES (${crypto.randomUUID()}, '2024-08-01', 'restore-test', 'fixture', ${methodology!.id}::bigint, 'restore-build')
    RETURNING id`) as unknown as { id: string }[];
  await sql`INSERT INTO analytics_ledger_run_events (run_id, sequence, event_type) VALUES (${run!.id}::bigint, 1, 'succeeded')`;
  const [vintage] = (await sql`
    INSERT INTO analytics_data_vintages
      (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id, build_identity, manifest, manifest_digest, member_count)
    VALUES (${run!.id}::bigint, 'restore-test', now(), '2024-08-01', ${methodology!.id}::bigint, 'restore-build', '{}'::jsonb, ${"5".repeat(64)}, 1)
    RETURNING id`) as unknown as { id: string }[];
  await sql`INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
            VALUES (${vintage!.id}::bigint, ${svv!.id}::bigint, 'raw_indicator_history:RESTORE_IND')`;

  const regimeBytes = Buffer.from(JSON.stringify([{ date: "2024-08-01", composite: 77, regime: "risk_on" }]), "utf8");
  const regimeChecksum = sha256Hex(regimeBytes);
  await sql`INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum)
            VALUES (${run!.id}::bigint, 'regime_snapshots', ${regimeBytes}, ${regimeChecksum})`;
  const researchBytes = Buffer.from(JSON.stringify([{ key: "restore-signal", date: "2024-08-01", payload: { title: "restore" } }]), "utf8");
  const researchChecksum = sha256Hex(researchBytes);
  await sql`INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum)
            VALUES (${run!.id}::bigint, 'research_signals', ${researchBytes}, ${researchChecksum})`;
  const reportBytes = Buffer.from("restore report bytes", "utf8");
  const reportChecksum = sha256Hex(reportBytes);
  const [report] = (await sql`
    INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum)
    VALUES (${run!.id}::bigint, '2024-08-01', ${reportBytes}, ${reportChecksum}) RETURNING id`) as unknown as { id: string }[];

  const subjectId = "restore-subject";
  const memberId = "restore-member";
  const sessionId = crypto.randomUUID();
  await sql`INSERT INTO swarm_subjects (id, name) VALUES (${subjectId}, 'Restore Subject')`;
  await sql`INSERT INTO swarm_sessions (id, subject_id, convened_at) VALUES (${sessionId}, ${subjectId}, '2024-08-01T00:00:00Z')`;
  await sql`INSERT INTO swarm_members (id, name, status) VALUES (${memberId}, 'Restore Member', 'inactive')`;
  await sql`INSERT INTO swarm_member_keys (member_id, public_key) VALUES (${memberId}, 'restore-test-pubkey')`;
  await sql`INSERT INTO swarm_briefs (session_id, date, subject_id, body, report_snapshot_id)
            VALUES (${sessionId}, '2024-08-01', ${subjectId}, '{"restore":true}'::jsonb, ${report!.id}::bigint)`;
  const briefBodyBytes = Buffer.from('{"restore":true}', "utf8");
  const briefChecksum = sha256Hex(briefBodyBytes);
  await sql`INSERT INTO swarm_brief_revisions (session_id, revision, body_bytes, checksum, report_snapshot_id)
            VALUES (${sessionId}, 1, ${briefBodyBytes}, ${briefChecksum}, ${report!.id}::bigint)`;
  // A signed recommendation resolving to this report snapshot (issue #978
  // AC6/migration 0059's swarm_recommendations.report_snapshot_id).
  await sql`
    INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, payload, signature, report_snapshot_id)
    VALUES (${sessionId}, ${memberId}, ${subjectId}, '2024-08-01', 'restore-nonce', 'neutral', '{}'::jsonb, 'sig', ${report!.id}::bigint)`;

  // ── real dump, using the container's OWN client tools ────────────────────
  const [{ current_database: dbName }] = (await sql`SELECT current_database()`) as unknown as { current_database: string }[];
  const dump = dockerExec(["pg_dump", "-h", "127.0.0.1", "-U", "robotmoney", "-d", dbName, "-Fc"]);
  expect(dump.exitCode, dump.stderr).toBe(0);
  expect(dump.stdout.length).toBeGreaterThan(0);

  // ── restore into a brand-new, EMPTY database (no template) ───────────────
  restoreDbName = `rm979_restore_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const admin = postgres(pgBaseUrl() + "/postgres", { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${restoreDbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const restore = dockerExec(
    ["pg_restore", "-h", "127.0.0.1", "-U", "robotmoney", "-d", restoreDbName, "--no-owner", "--role=robotmoney"],
    dump.stdout,
  );
  // pg_restore can exit nonzero on advisory warnings (e.g. role differences)
  // even on an otherwise-successful restore; what matters is that the DATA
  // and every guard this test checks below are actually there — asserted
  // directly rather than trusted from the exit code alone.
  if (restore.exitCode !== 0) console.error("pg_restore stderr:", restore.stderr);

  restoreDb = postgres(pgBaseUrl() + `/${restoreDbName}`, { max: 1, onnotice: () => {} });

  // ── every foreign key is VALIDATED (not merely present) ──────────────────
  const unvalidated = (await restoreDb`
    SELECT conname::text FROM pg_constraint WHERE contype = 'f' AND NOT convalidated
  `) as unknown as { conname: string }[];
  expect(unvalidated, JSON.stringify(unvalidated)).toEqual([]);

  // ── stored payload/artifact checksums recompute from retrieved bytes ─────
  // The ledger keeps a response's fingerprint, never its body (issue #1035).
  const [fetchRow] = (await restoreDb`SELECT response_checksum FROM source_fetches WHERE id = ${fetchId}`) as unknown as
    { response_checksum: string }[];
  expect(fetchRow, "source_fetches row must survive the restore").toBeDefined();
  expect(fetchRow!.response_checksum).toBe(payloadChecksum);

  const outputRows = (await restoreDb`SELECT payload_bytes, checksum FROM analytics_output_snapshots WHERE run_id = ${run!.id}::bigint`) as unknown as
    { payload_bytes: Buffer; checksum: string }[];
  expect(outputRows.length).toBe(2);
  for (const row of outputRows) expect(sha256Hex(row.payload_bytes)).toBe(row.checksum);

  const [reportRow] = (await restoreDb`SELECT report_bytes, checksum FROM analytics_report_snapshots WHERE id = ${report!.id}::bigint`) as unknown as
    { report_bytes: Buffer; checksum: string }[];
  expect(reportRow, "analytics_report_snapshots row must survive the restore").toBeDefined();
  expect(sha256Hex(reportRow!.report_bytes)).toBe(reportRow!.checksum);

  const [briefRevRow] = (await restoreDb`SELECT body_bytes, checksum FROM swarm_brief_revisions WHERE session_id = ${sessionId}`) as unknown as
    { body_bytes: Buffer; checksum: string }[];
  expect(briefRevRow, "swarm_brief_revisions row must survive the restore").toBeDefined();
  expect(sha256Hex(briefRevRow!.body_bytes)).toBe(briefRevRow!.checksum);

  // ── vintage members resolve ───────────────────────────────────────────────
  const vintageMembers = (await restoreDb`
    SELECT vm.source_key FROM analytics_vintage_members vm
    JOIN source_value_versions svv ON svv.id = vm.source_value_version_id
    WHERE vm.vintage_id = ${vintage!.id}::bigint`) as unknown as { source_key: string }[];
  expect(vintageMembers).toEqual([{ source_key: "raw_indicator_history:RESTORE_IND" }]);

  // ── report snapshots resolve to runs and artifacts ───────────────────────
  const [reportToRun] = (await restoreDb`
    SELECT r.tool_id FROM analytics_report_snapshots rs JOIN analytics_ledger_runs r ON r.id = rs.run_id
    WHERE rs.id = ${report!.id}::bigint`) as unknown as { tool_id: string }[];
  expect(reportToRun!.tool_id).toBe("restore-test");
  const artifactsForRun = (await restoreDb`SELECT artifact_kind FROM analytics_output_snapshots WHERE run_id = ${run!.id}::bigint ORDER BY artifact_kind`) as unknown as
    { artifact_kind: string }[];
  expect(artifactsForRun.map((r) => r.artifact_kind)).toEqual(["regime_snapshots", "research_signals"]);

  // ── recommendations resolve to report snapshots ──────────────────────────
  const [recToReport] = (await restoreDb`
    SELECT rec.nonce FROM swarm_recommendations rec JOIN analytics_report_snapshots rs ON rs.id = rec.report_snapshot_id
    WHERE rec.session_id = ${sessionId}`) as unknown as { nonce: string }[];
  expect(recToReport!.nonce).toBe("restore-nonce");

  // ── derived current views query successfully against the RESTORED copy ──
  const rawHistory = await ledgerCurrentRawIndicatorHistory(restoreDb);
  expect(rawHistory.some((p) => p.indicator === "RESTORE_IND" && p.date === "2024-08-01" && p.value === 3.5)).toBe(true);
  const regime = await ledgerCurrentRegimeSnapshots(restoreDb);
  expect(regime.some((r) => r.date === "2024-08-01" && r.composite === 77)).toBe(true);
  const research = await ledgerCurrentResearchSignals(restoreDb);
  expect(research.some((r) => r.signalKey === "restore-signal" && r.date === "2024-08-01")).toBe(true);

  // ── every immutable guard remains armed on the restored copy ─────────────
  const appendOnly = await checkAppendOnlyGuard(restoreDb);
  expect(appendOnly.problems, JSON.stringify(appendOnly.problems)).toEqual([]);
  expect(appendOnly.status).toBe("armed");
  const ledgerGuard = await checkAnalyticsLedgerGuard(restoreDb);
  expect(ledgerGuard.problems, JSON.stringify(ledgerGuard.problems)).toEqual([]);
  expect(ledgerGuard.status).toBe("armed");
}, 60_000);
