// Issue #978: the immutable output/report snapshot SQL layer, exercised
// directly against the store functions (not the HTTP boundary — see
// tests/api/analytics-run-snapshots.test.ts for that). Inserts canonical
// fixture artifacts, recomputes SHA-256 from the RETRIEVED bytes, appends a
// same-date replacement run, and asserts both versions remain independently
// addressable.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "../src/db/client.ts";
import {
  submitTerminalRunPackage,
  loadOutputSnapshot,
  loadReportSnapshot,
  findPackageByRun,
} from "../src/analytics/store/output-snapshot-store.ts";
import { canonicalArtifactBytes } from "../src/analytics/output-snapshots.ts";
import type { RegimeSnapshotRow } from "../src/analytics/report/regime-projection.ts";
import type { TerminalRunPackageInput } from "../src/analytics/output-snapshots.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import type { AnalyticsDataSource, ResearchInputs, BacktestExtras } from "../src/analytics/access/data-source.ts";
import type { Indicator } from "../src/analytics/analyze/indicators.ts";
import type { Point } from "../src/analytics/types.ts";
import * as swarmDomain from "../src/swarm/domain.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function beginRun(runKey: string, asof: string, toolId: string): Promise<string> {
  const [existing] = (await sql`
    SELECT id FROM analytics_ledger_methodology_versions WHERE tool_id = ${toolId} AND config_digest = ${"0".repeat(64)}
  `) as unknown as { id: string }[];
  const methodology =
    existing ??
    (await sql`
      INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
      VALUES (${toolId}, 'v-test', '{"k":"v"}'::jsonb, ${"0".repeat(64)})
      RETURNING id
    `.then((rows: unknown) => (rows as { id: string }[])[0]));
  const [run] = (await sql`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
    VALUES (${runKey}, ${asof}::date, ${toolId}, 'fixture', ${methodology!.id}::bigint, 'output-snapshot-store-test')
    RETURNING id
  `) as unknown as { id: string }[];
  return String(run!.id);
}

function regimeRow(date: string): RegimeSnapshotRow {
  return {
    date,
    composite: 10,
    compositePercentile: 0.5,
    regime: "risk_on",
    macroRegime: null,
    onchainRegime: null,
    factorRegime: null,
    percentiles: {},
    indicators: [],
    panels: null,
    bucketThresholds: null,
    backtest: null,
    correlations: null,
    extras: null,
  };
}

function packageFor(runId: string, asof: string, reportText: string): TerminalRunPackageInput {
  return {
    runId,
    asof,
    status: "succeeded",
    regimeSnapshots: [regimeRow(asof)],
    researchSignals: [
      {
        key: "output-store-signal",
        date: asof,
        payload: {
          asof,
          title: "store test",
          question: "round trip?",
          spec: {},
          gauges: [],
          series: { label: "s", points: [{ date: asof, value: 1 }] },
        },
      },
    ],
    reportBytes: new TextEncoder().encode(reportText),
  };
}

test("canonical fixture artifacts insert and recompute SHA-256 clean from retrieved bytes", async () => {
  const runId = await beginRun(crypto.randomUUID(), "2026-07-01", "output-store-a");
  const pkg = packageFor(runId, "2026-07-01", "report bytes for run A");
  const result = await submitTerminalRunPackage(pkg);
  expect(result.replayed).toBe(false);
  expect(result.outputSnapshots).toHaveLength(2);

  // Recompute from EXACTLY what canonicalArtifactBytes would build for the
  // same logical rows — proves the stored bytes are the canonical
  // serialization, not some other encoding that merely happens to hash right.
  const expectedRegimeBytes = canonicalArtifactBytes(pkg.regimeSnapshots!);
  const stored = await loadOutputSnapshot(runId, "regime_snapshots");
  expect(stored).not.toBeNull();
  expect(stored!.bytes).toEqual(expectedRegimeBytes);
  expect(sha256Hex(stored!.bytes)).toBe(stored!.checksum);
  expect(stored!.checksum).toBe(sha256Hex(expectedRegimeBytes));

  const report = await loadReportSnapshot(result.reportSnapshotId!);
  expect(report).not.toBeNull();
  expect(Buffer.from(report!.bytes).toString("utf8")).toBe("report bytes for run A");
  expect(sha256Hex(report!.bytes)).toBe(report!.checksum);
});

test("a same-date REPLACEMENT run appends its own independently addressable output and report snapshots, never overwriting the first", async () => {
  const asof = "2026-07-02";
  const runA = await beginRun(crypto.randomUUID(), asof, "output-store-b1");
  const runB = await beginRun(crypto.randomUUID(), asof, "output-store-b2");

  const resultA = await submitTerminalRunPackage(packageFor(runA, asof, "report A"));
  const resultB = await submitTerminalRunPackage(packageFor(runB, asof, "report B — a correction for the same date"));

  expect(resultB.reportSnapshotId).not.toBe(resultA.reportSnapshotId);
  const idsA = new Set(resultA.outputSnapshots.map((o) => o.id));
  const idsB = new Set(resultB.outputSnapshots.map((o) => o.id));
  for (const id of idsB) expect(idsA.has(id)).toBe(false);

  // Both versions independently addressable, byte-exact, for the SAME asof.
  const reportA = await loadReportSnapshot(resultA.reportSnapshotId!);
  const reportB = await loadReportSnapshot(resultB.reportSnapshotId!);
  expect(Buffer.from(reportA!.bytes).toString("utf8")).toBe("report A");
  expect(Buffer.from(reportB!.bytes).toString("utf8")).toBe("report B — a correction for the same date");
  expect(reportA!.asof).toBe(asof);
  expect(reportB!.asof).toBe(asof);

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE asof = ${asof}`;
  expect(n).toBe(2);
});

// ── the brief binds to the run that produced the numbers it SHOWS ──────────
//
// The producer arms two runs per `asof`: regime at 22:30 and research at
// 23:00. Both freeze a report snapshot for the same date, and the research
// run — which computes no regime data at all — always wins a plain
// `ORDER BY id DESC`. publishBrief builds its body from regime_snapshots, so
// that ordering made every schema-2.0 take sign a binding to a report holding
// none of the numbers the brief showed.
test("publishBrief binds to the REGIME run's report snapshot, not the later research run's, for the same asof", async () => {
  const asof = "2026-07-04";
  const regimeRunId = await beginRun(crypto.randomUUID(), asof, "regime");
  const regimeResult = await submitTerminalRunPackage(packageFor(regimeRunId, asof, "the regime report for 2026-07-04"));

  // The 23:00 research run: a REAL terminal package for the same date whose
  // regime artifact is the empty array (analytics/index.ts's `want("regime")`
  // is false for RESEARCH_TOOL_GROUP), and whose id is therefore higher.
  const researchRunId = await beginRun(crypto.randomUUID(), asof, "research");
  const researchPkg: TerminalRunPackageInput = { ...packageFor(researchRunId, asof, "the research report for 2026-07-04"), regimeSnapshots: [] };
  const researchResult = await submitTerminalRunPackage(researchPkg);
  expect(Number(researchResult.reportSnapshotId)).toBeGreaterThan(Number(regimeResult.reportSnapshotId));

  const subjectId = `brief-binding-${crypto.randomUUID().slice(0, 8)}`;
  await swarmDomain.ensureSubject(subjectId, "Brief Binding Subject");
  const session = await swarmDomain.openSession(subjectId);
  // `date` is a STORED generated column derived from `convened_at`, so this is
  // how a session is dated to a past market day.
  await sql`UPDATE swarm_sessions SET convened_at = ${asof}::date WHERE id = ${session.id}`;
  await swarmDomain.publishBrief(session.id, 60);

  const [brief] = await sql`SELECT report_snapshot_id FROM swarm_briefs WHERE session_id = ${session.id}`;
  expect(String(brief.report_snapshot_id)).toBe(String(regimeResult.reportSnapshotId));
  expect(String(brief.report_snapshot_id)).not.toBe(String(researchResult.reportSnapshotId));

  // And the bytes it points at really are the regime run's — the whole point.
  const bound = await loadReportSnapshot(String(brief.report_snapshot_id));
  expect(Buffer.from(bound!.bytes).toString("utf8")).toBe("the regime report for 2026-07-04");
});

// ── the committed cron offset: the brief publishes BEFORE its own day's run ─
//
// This is the schedule the repository actually ships, not a contrived one:
//
//   22:30 UTC on day D-1  PRODUCER_REGIME_CRON `30 22 * * *`
//                         (producer/index.ts:395, docker-compose.yml:423)
//                         runs with asof = D-1 and freezes report R(D-1).
//   06:00 UTC on day D    SWARM_OPEN_SESSION_CRON `0 6 * * *`
//                         (config.ts:625, docker-compose.yml:288) convenes a
//                         session, so swarm_sessions.date = D.
//   07:00 UTC on day D    SWARM_PUBLISH_BRIEF_CRON `0 7 * * *`
//                         (config.ts:626, docker-compose.yml:289) publishes
//                         the brief. Day D's own regime run is still 15.5
//                         hours away and the session closes at 08:00.
//
// The brief body therefore embeds the D-1 regime row, and the ONLY honest
// binding is R(D-1). Keying the lookup on the session's date instead made
// every brief in a default deployment bind to NULL — silently, since NULL is
// also the legitimate "no report for this subject" value — which in turn 409'd
// every schema-2.0 take. No date alignment is forced here: the session is
// dated D and the report is dated D-1, exactly as the crons produce them.
test("a brief published on day D at 07:00 binds to the previous night's regime report R(D-1), the run whose numbers its body shows", async () => {
  const dMinus1 = "2026-07-10"; // the 22:30 regime run's asof
  const d = "2026-07-11"; // the session's own date, one day later

  const regimeRunId = await beginRun(crypto.randomUUID(), dMinus1, "regime");
  const nightlyResult = await submitTerminalRunPackage(
    packageFor(regimeRunId, dMinus1, `the regime report frozen at 22:30 on ${dMinus1}`),
  );
  expect(nightlyResult.reportSnapshotId).not.toBeNull();

  // Day D's run has NOT happened yet — nothing exists for the session's date.
  const [{ n: reportsForD }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE asof = ${d}::date`;
  expect(reportsForD).toBe(0);

  const subjectId = `cron-offset-${crypto.randomUUID().slice(0, 8)}`;
  await swarmDomain.ensureSubject(subjectId, "Cron Offset Subject");
  const session = await swarmDomain.openSession(subjectId);
  // 06:00 UTC on day D. `date` is a STORED generated column over convened_at,
  // so setting the timestamp is how the session is dated to that morning.
  await sql`UPDATE swarm_sessions SET convened_at = ${`${d}T06:00:00Z`}::timestamptz WHERE id = ${session.id}`;
  const [dated] = await sql`SELECT date::text AS date FROM swarm_sessions WHERE id = ${session.id}`;
  expect(dated!.date).toBe(d); // the session really is dated D, not D-1

  await swarmDomain.publishBrief(session.id, 60);

  const [brief] = await sql`SELECT body, report_snapshot_id FROM swarm_briefs WHERE session_id = ${session.id}`;
  // The binding exists at all — the whole defect was that it never did.
  expect(brief!.report_snapshot_id).not.toBeNull();
  expect(String(brief!.report_snapshot_id)).toBe(String(nightlyResult.reportSnapshotId));

  // And it points at the report holding the numbers the body is showing.
  const body = brief!.body as { regime: { date: string } | null };
  expect(body.regime).not.toBeNull();
  expect(String(body.regime!.date).slice(0, 10)).toBe(dMinus1);
  const bound = await loadReportSnapshot(String(brief!.report_snapshot_id));
  expect(Buffer.from(bound!.bytes).toString("utf8")).toBe(`the regime report frozen at 22:30 on ${dMinus1}`);

  // The revision the takes sign against carries the same binding.
  const [rev] = await sql`
    SELECT report_snapshot_id FROM swarm_brief_revisions WHERE session_id = ${session.id} ORDER BY revision DESC LIMIT 1`;
  expect(String(rev!.report_snapshot_id)).toBe(String(nightlyResult.reportSnapshotId));
});

// ── a run that fails AFTER computing its outputs publishes nothing ─────────
//
// runAnalytics used to write regime_snapshots/research_signals mid-run, long
// before the terminal package was assembled. A throw in between (freezeVintage
// is the realistic one) left the current view holding the failed run's numbers
// while its terminal package froze only warnings/logs/exceptions — no regime
// artifact, no report snapshot. The ledger and the current view then disagreed
// with nothing red. applyCurrentProjections is now the single publisher.
function minimalSource(): AnalyticsDataSource {
  const pts: Point[] = [{ date: "2020-01-01", value: 1 }, { date: "2020-01-02", value: 2 }];
  return {
    async fetchIndicators(indicators: Indicator[]) {
      const out: Record<string, Point[]> = {};
      for (const ind of indicators) out[ind.id] = pts;
      return out;
    },
    async fetchResearchInputs(): Promise<ResearchInputs> {
      return { btc: pts, qqq: pts, spy: pts, rsp: pts, top7: [pts, pts, pts, pts, pts, pts, pts], mna: pts, margin: pts, conf: pts };
    },
    async fetchBacktestExtras(): Promise<BacktestExtras> {
      return { spx: pts, eth: pts, tbill3m: pts };
    },
  };
}

test("a run that throws AFTER computing its outputs leaves the current projections untouched — the ledger and the current view can never disagree", async () => {
  const asof = "2026-07-05";
  const [{ n: regimeBefore }] = await sql`SELECT count(*)::int AS n FROM regime_snapshots`;
  const [{ n: signalsBefore }] = await sql`SELECT count(*)::int AS n FROM research_signals`;

  const persistence = {
    ...directAnalyticsPersistence,
    // The realistic mid-run throw: issue #977's mandatory vintage freeze runs
    // after every output above has been computed.
    freezeVintage: async () => { throw new Error("forced vintage freeze failure"); },
  };
  await expect(runAnalytics(asof, undefined, minimalSource(), persistence, noopTelemetrySink))
    .rejects.toThrow("forced vintage freeze failure");

  // NOTHING was published to the current view by the failed run.
  const [{ n: regimeAfter }] = await sql`SELECT count(*)::int AS n FROM regime_snapshots`;
  expect(regimeAfter).toBe(regimeBefore);
  const [{ n: signalsAfter }] = await sql`SELECT count(*)::int AS n FROM research_signals`;
  expect(signalsAfter).toBe(signalsBefore);

  // And the run DID record itself, in the failed shape: diagnostics only, no
  // regime/research output artifact and no report snapshot to bind a brief to.
  const [run] = await sql`SELECT id::text AS id FROM analytics_ledger_runs WHERE asof = ${asof}::date ORDER BY id DESC LIMIT 1`;
  const kinds = (
    await sql`SELECT artifact_kind FROM analytics_output_snapshots WHERE run_id = ${run!.id}::bigint ORDER BY artifact_kind`
  ).map((r) => r.artifact_kind);
  expect(kinds).toEqual(["exceptions", "logs", "warnings"]);
  const [{ n: reports }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE run_id = ${run!.id}::bigint`;
  expect(reports).toBe(0);
});

test("re-submitting the SAME run_id replays the existing package (idempotent), including under a concurrent race", async () => {
  const runId = await beginRun(crypto.randomUUID(), "2026-07-03", "output-store-c");
  const pkg = packageFor(runId, "2026-07-03", "report for the idempotency test");
  const [a, b] = await Promise.all([submitTerminalRunPackage(pkg), submitTerminalRunPackage(pkg)]);
  expect(a.reportSnapshotId).toBe(b.reportSnapshotId);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  expect(n).toBe(1);

  const replay = await findPackageByRun(runId);
  expect(replay).not.toBeNull();
  expect(replay!.reportSnapshotId).toBe(a.reportSnapshotId);
});
