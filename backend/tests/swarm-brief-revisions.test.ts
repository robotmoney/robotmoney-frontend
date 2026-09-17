// Issue #978 AC5: append-only swarm brief revisions. Publishing and
// republishing a session brief against fixed, pre-frozen report snapshots
// must append a new immutable revision each time, never edit the prior one;
// swarm_briefs (the compatibility current view) must resolve to the newest
// revision; and a failure between appending a revision and updating the
// current view must roll back BOTH, atomically.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import * as ic from "../src/swarm/domain.ts";
import { appendBriefRevision } from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function freezeReportSnapshot(asof: string, toolId: string, reportText: string): Promise<string> {
  const [methodology] = (await sql`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
    VALUES (${toolId}, 'v-test', '{"k":"v"}'::jsonb, ${"7".repeat(64)})
    RETURNING id
  `) as unknown as { id: string }[];
  const [run] = (await sql`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
    VALUES (${crypto.randomUUID()}, ${asof}::date, ${toolId}, 'fixture', ${methodology!.id}::bigint, 'brief-revision-test')
    RETURNING id
  `) as unknown as { id: string }[];
  // The regime output artifact this run froze AND the current-view row it
  // published in the same transaction — the two halves applyCurrentProjections
  // always writes together. publishBrief derives its binding from the
  // MAX-dated regime_snapshots row's date, so a report snapshot standing alone
  // (no published row) is correctly not a binding candidate. See publishBrief.
  const regimeBytes = new TextEncoder().encode(`[{"date":"${asof}","tool":"${toolId}"}]`);
  await sql`
    INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum)
    VALUES (${run!.id}::bigint, 'regime_snapshots', ${Buffer.from(regimeBytes)}, ${sha256Hex(regimeBytes)})`;
  await sql`
    INSERT INTO regime_snapshots (date, composite, composite_percentile, regime, percentiles, indicators)
    VALUES (${asof}::date, 12, 0.5, 'risk_on', '{}'::jsonb, '[]'::jsonb)
    ON CONFLICT (date) DO UPDATE SET composite = EXCLUDED.composite`;
  const bytes = new TextEncoder().encode(reportText);
  const [report] = (await sql`
    INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum)
    VALUES (${run!.id}::bigint, ${asof}::date, ${Buffer.from(bytes)}, ${sha256Hex(bytes)})
    RETURNING id
  `) as unknown as { id: string }[];
  return String(report!.id);
}

const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

test("publishing then republishing a session brief appends TWO immutable revisions; swarm_briefs resolves to the newest; the first revision's body/report-snapshot-id/checksum stay byte-identical", async () => {
  const subj = rid("brief-revision-subject");
  await ic.ensureSubject(subj, "Brief Revision Subject");
  const s = await ic.openSession(subj);
  const date = sessionDate(s);

  const reportSnapshotId = await freezeReportSnapshot(date, rid("brief-revision-tool"), "the frozen report this brief is built from");

  const first = await ic.publishBrief(s.id, 60);
  expect(first.state).toBe("collecting");

  const afterFirst = await sql`
    SELECT revision, body_bytes, checksum, report_snapshot_id FROM swarm_brief_revisions
    WHERE session_id = ${s.id} ORDER BY revision`;
  expect(afterFirst).toHaveLength(1);
  expect(Number(afterFirst[0]!.revision)).toBe(1);
  expect(String(afterFirst[0]!.report_snapshot_id)).toBe(reportSnapshotId);
  const firstBodyBytes = Buffer.from(afterFirst[0]!.body_bytes as Buffer);
  const firstChecksum = afterFirst[0]!.checksum as string;
  expect(sha256Hex(firstBodyBytes)).toBe(firstChecksum);

  // Republish the SAME session — this must APPEND revision 2, not edit revision 1.
  const second = await ic.publishBrief(s.id, 90);
  expect(second.state).toBe("collecting");

  const afterSecond = await sql`
    SELECT revision, body_bytes, checksum, report_snapshot_id FROM swarm_brief_revisions
    WHERE session_id = ${s.id} ORDER BY revision`;
  expect(afterSecond).toHaveLength(2);
  expect(afterSecond.map((r) => Number(r.revision))).toEqual([1, 2]);

  // The FIRST revision is untouched — byte-for-byte, not merely "same row count".
  expect(Buffer.from(afterSecond[0]!.body_bytes as Buffer)).toEqual(firstBodyBytes);
  expect(afterSecond[0]!.checksum).toBe(firstChecksum);
  expect(String(afterSecond[0]!.report_snapshot_id)).toBe(reportSnapshotId);

  // The current-view projection (swarm_briefs) resolves to the NEWEST revision:
  // its report_snapshot_id and body must match revision 2, not revision 1,
  // and its windowClosesAt reflects the SECOND publish (90 minutes, not 60).
  const [current] = await sql`SELECT body, report_snapshot_id FROM swarm_briefs WHERE session_id = ${s.id}`;
  expect(String(current.report_snapshot_id)).toBe(reportSnapshotId);
  const secondRevisionBody = JSON.parse(Buffer.from(afterSecond[1]!.body_bytes as Buffer).toString("utf8"));
  expect(current.body.windowClosesAt).toBe(secondRevisionBody.windowClosesAt);
  expect(current.body.windowClosesAt).not.toBe(JSON.parse(firstBodyBytes.toString("utf8")).windowClosesAt);
});

test("a session's date with NO analytics report snapshot yet publishes with report_snapshot_id = NULL (not an error)", async () => {
  const subj = rid("brief-revision-no-report");
  await ic.ensureSubject(subj, "No Report Subject");
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  const [revision] = await sql`SELECT report_snapshot_id FROM swarm_brief_revisions WHERE session_id = ${s.id}`;
  expect(revision.report_snapshot_id).toBeNull();
  const [current] = await sql`SELECT report_snapshot_id FROM swarm_briefs WHERE session_id = ${s.id}`;
  expect(current.report_snapshot_id).toBeNull();
});

test("transaction rollback: a failure AFTER appending a revision but before the current-view update leaves BOTH sides unchanged", async () => {
  const subj = rid("brief-revision-rollback");
  await ic.ensureSubject(subj, "Rollback Subject");
  const s = await ic.openSession(subj);

  const body = { probe: "rollback-body", n: 1 };
  await expect(
    sql.begin(async (tx) => {
      await appendBriefRevision(s.id, body, null, tx);
      throw new Error("INJECTED_FAILURE_BEFORE_CURRENT_VIEW_UPDATE");
    }),
  ).rejects.toThrow("INJECTED_FAILURE_BEFORE_CURRENT_VIEW_UPDATE");

  const [{ revisions, briefs }] = await sql`SELECT
    (SELECT count(*)::int FROM swarm_brief_revisions WHERE session_id = ${s.id}) AS revisions,
    (SELECT count(*)::int FROM swarm_briefs WHERE session_id = ${s.id}) AS briefs`;
  expect(revisions).toBe(0); // the immutable revision insert did NOT commit either
  expect(briefs).toBe(0);
});
