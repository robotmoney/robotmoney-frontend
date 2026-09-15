// Issue #978 AC6: a take submitted against a session whose brief IS bound to
// an analytics report snapshot must name that exact snapshot. Exercises the
// real HTTP-adjacent submitRecommendation path (not a unit test of the
// canonicalizer alone — that lives in tests/signing.test.ts) against real
// ephemeral Postgres.
import { test, expect } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`activeMember(): registerMember failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}

async function freezeReportSnapshot(asof: string, toolId: string): Promise<string> {
  const [methodology] = (await sql`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
    VALUES (${toolId}, 'v-test', '{"k":"v"}'::jsonb, ${"9".repeat(64)})
    RETURNING id
  `) as unknown as { id: string }[];
  const [run] = (await sql`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
    VALUES (${crypto.randomUUID()}, ${asof}::date, ${toolId}, 'fixture', ${methodology!.id}::bigint, 'take-signing-test')
    RETURNING id
  `) as unknown as { id: string }[];
  const bytes = new TextEncoder().encode(`report for ${toolId}`);
  const checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const [report] = (await sql`
    INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum)
    VALUES (${run!.id}::bigint, ${asof}::date, ${Buffer.from(bytes)}, ${checksum})
    RETURNING id
  `) as unknown as { id: string }[];
  return String(report!.id);
}

async function openSessionBoundToReport(prefix: string) {
  const subj = rid(prefix);
  await ic.ensureSubject(subj, `${prefix} subject`);
  const s = await ic.openSession(subj);
  const date = sessionDate(s);
  const reportSnapshotId = await freezeReportSnapshot(date, rid(`${prefix}-tool`));
  await ic.publishBrief(s.id, 60);
  return { subj, session: s, date, reportSnapshotId };
}

async function submitSigned(
  m: Awaited<ReturnType<typeof activeMember>>,
  date: string,
  subjectId: string,
  reportSnapshotId: string | undefined,
  overrides: { signedReportSnapshotId?: string; nonce?: string } = {},
) {
  const sub = {
    memberId: m.id,
    date,
    subjectId,
    nonce: overrides.nonce ?? rid("n"),
    stance: "neutral",
    confidence: 0.5,
    body: "a take",
    reportSnapshotId,
  };
  // Sign over whatever `signedReportSnapshotId` says (defaults to the same
  // value being submitted) — lets a test sign one value and submit another,
  // proving that mismatch is caught by the SIGNATURE, not the business rule.
  const signedSub = overrides.signedReportSnapshotId !== undefined
    ? { ...sub, reportSnapshotId: overrides.signedReportSnapshotId }
    : sub;
  const signature = await signMessage(canonicalizeSubmission(signedSub), m.privateKey);
  return ic.submitRecommendation(m.token, { ...sub, signature });
}

test("a take naming the SAME reportSnapshotId as the session's brief is accepted and persisted", async () => {
  const { subj, session, date, reportSnapshotId } = await openSessionBoundToReport("take-sig-match");
  const m = await activeMember();
  const res = await submitSigned(m, date, subj, reportSnapshotId);
  expect((res as { ok?: boolean }).ok).not.toBe(false);
  expect((res as { status?: number }).status).toBe(201);
  const [row] = await sql`SELECT report_snapshot_id FROM swarm_recommendations WHERE session_id = ${session.id} AND member_id = ${m.id}`;
  expect(String(row.report_snapshot_id)).toBe(reportSnapshotId);
});

test("a take naming a DIFFERENT reportSnapshotId than the session's brief is rejected (409), before signature verification even matters", async () => {
  const { subj, date, reportSnapshotId } = await openSessionBoundToReport("take-sig-mismatch");
  const m = await activeMember();
  const wrongId = String(Number(reportSnapshotId) + 1);
  const res = await submitSigned(m, date, subj, wrongId);
  expect((res as { ok: boolean }).ok).toBe(false);
  expect((res as { status: number }).status).toBe(409);
  expect((res as { error: string }).error).toMatch(/reportSnapshotId does not match/);
});

test("a take naming NO reportSnapshotId when the session's brief HAS one bound is rejected (409)", async () => {
  const { subj, date } = await openSessionBoundToReport("take-sig-missing");
  const m = await activeMember();
  const res = await submitSigned(m, date, subj, undefined);
  expect((res as { ok: boolean }).ok).toBe(false);
  expect((res as { status: number }).status).toBe(409);
  expect((res as { error: string }).error).toMatch(/reportSnapshotId does not match/);
});

test("a take signed over a DIFFERENT reportSnapshotId than the one submitted fails signature verification (400), not the business rule (409)", async () => {
  const { subj, date, reportSnapshotId } = await openSessionBoundToReport("take-sig-tampered");
  const m = await activeMember();
  const otherId = String(Number(reportSnapshotId) + 1);
  // Submit the CORRECT id in the body, but the signature covers a DIFFERENT
  // one — the canonical bytes disagree, so verification must fail.
  const res = await submitSigned(m, date, subj, reportSnapshotId, { signedReportSnapshotId: otherId });
  expect((res as { ok: boolean }).ok).toBe(false);
  expect((res as { status: number }).status).toBe(400);
  expect((res as { error: string }).error).toBe("signature verification failed");
});

test("a session with NO analytics report snapshot bound accepts a legacy (schema 1.0) take with no reportSnapshotId at all", async () => {
  const subj = rid("take-sig-no-report");
  await ic.ensureSubject(subj, "no report subject");
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  const date = sessionDate(s);
  const m = await activeMember();
  const res = await submitSigned(m, date, subj, undefined);
  expect((res as { status?: number }).status).toBe(201);
});
