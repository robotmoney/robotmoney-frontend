// Issue #978 AC1/AC2/AC3/AC8: the immutable analytics output/report snapshot
// HTTP boundary. Drives the REAL route handlers and SQL stores through
// handleAnalytics against real ephemeral Postgres — provider authentication,
// full-package validation, successful atomic commit (with current-view
// dual-write), injected rollback, failed-run diagnostics, exact report
// retrieval, unchanged current-view reads, and telemetry/historical-artifact
// separation.
import { test, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
import {
  insertOutputSnapshots,
  insertReportSnapshot,
  applyCurrentProjections,
} from "../../src/analytics/store/output-snapshot-store.ts";
import { getRegimeSnapshots, getResearchSignal } from "../../src/api/routes/dashboards.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { provisionAnalyticsToken, provisionOperatorToken } from "../support/automation-auth.ts";

useCleanDatabase(import.meta.file);

const A = ROUTES.analytics;
let TOKEN = "";
let ADMIN = "";

// Store-issued, like the real credentials (smoke spec §3, D52 (1)): the
// producer's token is the only one the analytics boundary accepts, and the
// operator's admin token is refused there, in every env.
beforeAll(async () => {
  TOKEN = await provisionAnalyticsToken();
  ADMIN = await provisionOperatorToken();
});

function req(method: string, path: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const call = (r: Request) => handleAnalytics(r, new URL(r.url));

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function beginRun(overrides: Record<string, unknown> = {}): Promise<{ runId: string; methodologyVersionId: string }> {
  const body = {
    run: {
      runKey: crypto.randomUUID(),
      asof: "2026-06-01",
      toolId: "output-snapshot-test",
      sourceLabel: "fixture",
      methodology: { toolId: "output-snapshot-test", versionLabel: "v-test", config: { k: "v" } },
      buildIdentity: "output-snapshot-build",
      ...overrides,
    },
  };
  const res = await call(req("POST", A.runs, body, TOKEN));
  expect(res!.status).toBe(200);
  return res!.body as { runId: string; methodologyVersionId: string };
}

function regimeSnapshotFixture(date: string) {
  return {
    date,
    composite: 42.5,
    compositePercentile: 0.6,
    regime: "risk_on",
    macroRegime: "expansion",
    onchainRegime: "accumulation",
    factorRegime: null,
    macroIndex: null,
    onchainIndex: null,
    factorIndex: null,
    macroPercentile: null,
    onchainPercentile: null,
    factorPercentile: null,
    panelWeights: null,
    version: "v-test",
    source: "fixture",
    percentiles: { macro: 0.6 },
    indicators: [{ key: "macro_growth", value: 1.23 }],
    panels: null,
    bucketThresholds: null,
    backtest: null,
    correlations: null,
    extras: null,
  };
}

function researchSignalFixture(key: string, date: string) {
  return {
    key,
    date,
    payload: {
      asof: date,
      title: `${key} signal`,
      question: "does the fixture round-trip byte for byte?",
      spec: {},
      gauges: [],
      series: { label: key, points: [{ date, value: 1 }] },
    },
  };
}

function succeededPackage(runId: string, asof: string, overrides: Record<string, unknown> = {}) {
  const reportBase64 = Buffer.from(`report for run ${runId} on ${asof}`, "utf8").toString("base64");
  return {
    package: {
      runId,
      asof,
      status: "succeeded",
      regimeSnapshots: [regimeSnapshotFixture(asof)],
      researchSignals: [researchSignalFixture("output-snapshot-signal", asof)],
      reportBase64,
      ...overrides,
    },
  };
}

function failedPackage(runId: string, asof: string, overrides: Record<string, unknown> = {}) {
  return {
    package: {
      runId,
      asof,
      status: "failed",
      warnings: [{ stage: "extract", message: "upstream returned a partial page" }],
      logs: [{ level: "error", message: "retry exhausted after 3 attempts", at: new Date().toISOString() }],
      exceptions: [{ message: "FetchError: connect ECONNREFUSED", stack: "FetchError: connect ECONNREFUSED\n    at fetch (native)" }],
      ...overrides,
    },
  };
}

// ── AC1 ──────────────────────────────────────────────────────────────────────
test("POST run-packages (succeeded): auth required, complete output artifacts and exact report bytes are inserted, checksums recompute clean, and current-view rows change in the SAME committed transaction", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-01", toolId: "ac1-test" });
  const asof = "2026-06-01";
  const body = succeededPackage(runId, asof);

  expect((await call(req("POST", A.runPackage, body)))?.status).toBe(401);
  expect((await call(req("POST", A.runPackage, body, ADMIN)))?.status).toBe(403);
  const [{ n: zero }] = await sql`SELECT count(*)::int AS n FROM analytics_output_snapshots`;
  expect(zero).toBe(0);

  const res = await call(req("POST", A.runPackage, body, TOKEN));
  expect(res!.status).toBe(200);
  const result = res!.body as { outputSnapshots: { id: string; artifactKind: string; checksum: string }[]; reportSnapshotId: string };

  // Complete output artifacts: both kinds present.
  const kinds = result.outputSnapshots.map((o) => o.artifactKind).sort();
  expect(kinds).toEqual(["regime_snapshots", "research_signals"]);

  // Stored checksums match recomputation from the RETRIEVED bytes.
  for (const artifact of result.outputSnapshots) {
    const [row] = await sql`SELECT payload_bytes, checksum FROM analytics_output_snapshots WHERE id = ${artifact.id}::bigint`;
    expect(row.checksum).toBe(artifact.checksum);
    expect(sha256Hex(new Uint8Array(row.payload_bytes as Buffer))).toBe(artifact.checksum);
  }

  // Exact report bytes, stored and checksum-verifiable.
  const [reportRow] = await sql`SELECT report_bytes, checksum FROM analytics_report_snapshots WHERE id = ${result.reportSnapshotId}::bigint`;
  const expectedReportBytes = new Uint8Array(Buffer.from(body.package.reportBase64, "base64"));
  expect(new Uint8Array(reportRow.report_bytes as Buffer)).toEqual(expectedReportBytes);
  expect(sha256Hex(new Uint8Array(reportRow.report_bytes as Buffer))).toBe(reportRow.checksum);

  // regime_snapshots and research_signals current rows changed in the SAME
  // committed transaction as the immutable insert above.
  const [regimeRow] = await sql`SELECT composite, regime FROM regime_snapshots WHERE date = ${asof}`;
  expect(Number(regimeRow.composite)).toBe(42.5);
  expect(regimeRow.regime).toBe("risk_on");
  const [signalRow] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'output-snapshot-signal' AND date = ${asof}`;
  expect(signalRow.payload.title).toBe("output-snapshot-signal signal");
});

test("POST run-packages: idempotent retry on the SAME runId replays the existing package rather than duplicating rows", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-02", toolId: "ac1-idempotent" });
  const body = succeededPackage(runId, "2026-06-02");
  const first = await call(req("POST", A.runPackage, body, TOKEN));
  expect(first!.status).toBe(200);
  const second = await call(req("POST", A.runPackage, body, TOKEN));
  expect(second!.status).toBe(200);
  expect((second!.body as any).reportSnapshotId).toBe((first!.body as any).reportSnapshotId);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  expect(n).toBe(1);
});

// ── AC2 ──────────────────────────────────────────────────────────────────────
test("a failed terminal package stores its complete warning/log/exception artifacts and leaves current projection rows unchanged", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-03", toolId: "ac2-failed" });
  const asof = "2026-06-03";
  const [{ regimeBefore, signalBefore }] = await sql`SELECT
    (SELECT count(*)::int FROM regime_snapshots WHERE date = ${asof}) AS "regimeBefore",
    (SELECT count(*)::int FROM research_signals WHERE date = ${asof}) AS "signalBefore"`;
  expect(regimeBefore).toBe(0);
  expect(signalBefore).toBe(0);

  const res = await call(req("POST", A.runPackage, failedPackage(runId, asof), TOKEN));
  expect(res!.status).toBe(200);
  const result = res!.body as { outputSnapshots: { artifactKind: string }[]; reportSnapshotId: string | null };
  expect(result.reportSnapshotId).toBeNull();
  expect(result.outputSnapshots.map((o) => o.artifactKind).sort()).toEqual(["exceptions", "logs", "warnings"]);

  const [{ n: reportRows }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  expect(reportRows).toBe(0);
  const [{ regimeAfter, signalAfter }] = await sql`SELECT
    (SELECT count(*)::int FROM regime_snapshots WHERE date = ${asof}) AS "regimeAfter",
    (SELECT count(*)::int FROM research_signals WHERE date = ${asof}) AS "signalAfter"`;
  expect(regimeAfter).toBe(0);
  expect(signalAfter).toBe(0);

  // Content is complete, not merely present — byte-compare the stored logs.
  const [logRow] = await sql`SELECT payload_bytes FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint AND artifact_kind = 'logs'`;
  const logs = JSON.parse(Buffer.from(logRow.payload_bytes as Buffer).toString("utf8"));
  expect(logs).toHaveLength(1);
  expect(logs[0].message).toBe("retry exhausted after 3 attempts");
});

test("failure-injection: an error between the immutable output insert and the compatibility projection update rolls back BOTH sides, atomically", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-04", toolId: "ac2-injected" });
  const asof = "2026-06-04";
  const pkg = (succeededPackage(runId, asof) as any).package;

  await expect(
    sql.begin(async (tx) => {
      await insertOutputSnapshots(pkg, tx);
      await insertReportSnapshot(pkg, tx);
      throw new Error("INJECTED_FAILURE_BEFORE_PROJECTION_UPDATE");
      // eslint-disable-next-line no-unreachable
      await applyCurrentProjections(pkg, tx);
    }),
  ).rejects.toThrow("INJECTED_FAILURE_BEFORE_PROJECTION_UPDATE");

  const [{ outputs, reports, regime, signals }] = await sql`SELECT
    (SELECT count(*)::int FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint) AS outputs,
    (SELECT count(*)::int FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint) AS reports,
    (SELECT count(*)::int FROM regime_snapshots WHERE date = ${asof}) AS regime,
    (SELECT count(*)::int FROM research_signals WHERE date = ${asof}) AS signals`;
  expect(outputs).toBe(0); // the immutable insert did NOT commit either
  expect(reports).toBe(0);
  expect(regime).toBe(0);
  expect(signals).toBe(0);
});

// ── AC3 ──────────────────────────────────────────────────────────────────────
test("GET reports: byte-exact retrieval by immutable id, and a later run for the SAME market date gets a DIFFERENT id without touching the first snapshot", async () => {
  const asof = "2026-06-05";
  const { runId: runA } = await beginRun({ runKey: crypto.randomUUID(), asof, toolId: "ac3-a" });
  const bodyA = succeededPackage(runA, asof, { reportBase64: Buffer.from("report A bytes, exact fixture").toString("base64") });
  const resA = await call(req("POST", A.runPackage, bodyA, TOKEN));
  expect(resA!.status).toBe(200);
  const reportIdA = (resA!.body as any).reportSnapshotId as string;

  expect((await call(req("GET", `${A.reportSnapshot}?id=${reportIdA}`)))?.status).toBe(401);
  const readA = await call(req("GET", `${A.reportSnapshot}?id=${reportIdA}`, undefined, TOKEN));
  expect(readA!.status).toBe(200);
  const reportA = (readA!.body as any).report;
  const fixtureBytes = Buffer.from("report A bytes, exact fixture");
  expect(Buffer.from(reportA.reportBase64, "base64").equals(fixtureBytes)).toBe(true);
  expect(reportA.checksum).toBe(sha256Hex(new Uint8Array(fixtureBytes)));

  const { runId: runB } = await beginRun({ runKey: crypto.randomUUID(), asof, toolId: "ac3-b" });
  const bodyB = succeededPackage(runB, asof, { reportBase64: Buffer.from("report B bytes, a later run same date").toString("base64") });
  const resB = await call(req("POST", A.runPackage, bodyB, TOKEN));
  expect(resB!.status).toBe(200);
  const reportIdB = (resB!.body as any).reportSnapshotId as string;

  expect(reportIdB).not.toBe(reportIdA);

  // The FIRST snapshot is byte-identical to what it always was.
  const rereadA = await call(req("GET", `${A.reportSnapshot}?id=${reportIdA}`, undefined, TOKEN));
  expect(Buffer.from((rereadA!.body as any).report.reportBase64, "base64").equals(fixtureBytes)).toBe(true);

  expect((await call(req("GET", `${A.reportSnapshot}?id=999999999`, undefined, TOKEN)))?.status).toBe(404);
});

// ── AC8 ──────────────────────────────────────────────────────────────────────
test("telemetry rejects an artifact larger than its preview cap, while the complete-artifact (run-package) endpoint accepts and stores the full bounded-by-contract artifact — telemetry and historical artifacts stay separate stores", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-06", toolId: "ac8-telemetry" });
  const asof = "2026-06-06";

  // A telemetry artifact preview over the ~20KB cap is rejected.
  const oversizedPreview = { data: "x".repeat(25_000) };
  const telemetryBody = {
    run: {
      kind: "research.refresh",
      asof,
      source: "fixture",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      checksum: null,
      summary: {},
      stages: [],
      warnings: [],
      artifacts: [{ stage: "analyze", kind: "regime-history", checksum: null, preview: oversizedPreview }],
    },
  };
  const telemetryRes = await call(req("POST", A.telemetry, telemetryBody, TOKEN));
  expect(telemetryRes!.status).toBe(400);

  // The SAME research signal content (well over telemetry's ~20KB preview cap
  // once serialized) is accepted whole and stored byte-exact through the
  // complete-artifact (run-package) endpoint.
  const bigPayload = researchSignalFixture("ac8-large-signal", asof);
  (bigPayload.payload as any).series.points = Array.from({ length: 5000 }, (_, i) => ({ date: asof, value: i }));
  const bigBytes = Buffer.byteLength(JSON.stringify([bigPayload]));
  expect(bigBytes).toBeGreaterThan(25_000); // genuinely larger than telemetry's cap, not merely asserted to be

  const pkgRes = await call(req("POST", A.runPackage, succeededPackage(runId, asof, { researchSignals: [bigPayload] }), TOKEN));
  expect(pkgRes!.status).toBe(200);
  const result = pkgRes!.body as { outputSnapshots: { artifactKind: string; byteLength: number }[] };
  const signalArtifact = result.outputSnapshots.find((o) => o.artifactKind === "research_signals")!;
  expect(signalArtifact.byteLength).toBeGreaterThan(25_000);

  const [storedRow] = await sql`SELECT payload_bytes FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint AND artifact_kind = 'research_signals'`;
  const stored = JSON.parse(Buffer.from(storedRow.payload_bytes as Buffer).toString("utf8"));
  expect(stored[0].payload.series.points).toHaveLength(5000); // the COMPLETE series, not a bounded preview
});

// ── AC7 ──────────────────────────────────────────────────────────────────────
test("existing dashboard regime and research-signal response fields retain their established values once the immutable snapshot dual-write is enabled", async () => {
  const asof = "2026-06-07";
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof, toolId: "ac7-regression" });
  const res = await call(req("POST", A.runPackage, succeededPackage(runId, asof), TOKEN));
  expect(res!.status).toBe(200);

  // GET /api/dashboards/regime-snapshots — the SAME response shape and field
  // names every existing caller already reads, not a new/renamed projection.
  const dashboard = await getRegimeSnapshots(new URL("http://x/api/dashboards/regime-snapshots?range=30"));
  expect(dashboard.latest?.date).toBe(asof);
  expect(dashboard.latest?.composite).toBe(42.5);
  expect(dashboard.latest?.regime).toBe("risk_on");
  expect(Array.isArray(dashboard.history)).toBe(true);

  // GET /api/dashboards/research-signals/:key
  const signal = await getResearchSignal("output-snapshot-signal");
  expect(signal?.date).toBe(asof);
  expect((signal?.payload as any)?.title).toBe("output-snapshot-signal signal");
});

// ── FIX2 (replay-integrity gap) ──────────────────────────────────────────────
test("an IDENTICAL resubmission for the same run_id still replays with 200, byte-for-byte", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-08", toolId: "fix2-identical" });
  const asof = "2026-06-08";
  const body = succeededPackage(runId, asof);

  const first = await call(req("POST", A.runPackage, body, TOKEN));
  expect(first!.status).toBe(200);
  const second = await call(req("POST", A.runPackage, body, TOKEN));
  expect(second!.status).toBe(200);
  expect((second!.body as any).reportSnapshotId).toBe((first!.body as any).reportSnapshotId);
  expect((second!.body as any).replayed).toBe(true);

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  expect(n).toBe(1);
});

test("a DIFFERENT-content resubmission for the same run_id is rejected with 409 and does not overwrite the original stored artifacts", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-09", toolId: "fix2-conflict" });
  const asof = "2026-06-09";
  const originalBody = succeededPackage(runId, asof);
  const first = await call(req("POST", A.runPackage, originalBody, TOKEN));
  expect(first!.status).toBe(200);
  const originalReportSnapshotId = (first!.body as any).reportSnapshotId as string;

  // Same run_id, DIFFERENT report bytes AND different regime snapshot content.
  const conflictingBody = succeededPackage(runId, asof, {
    reportBase64: Buffer.from(`a DIFFERENT report for run ${runId}`, "utf8").toString("base64"),
    regimeSnapshots: [{ ...regimeSnapshotFixture(asof), composite: 999 }],
  });
  const conflict = await call(req("POST", A.runPackage, conflictingBody, TOKEN));
  expect(conflict!.status).toBe(409);
  expect((conflict!.body as any).error).toMatch(/already frozen/);
  expect((conflict!.body as any).existing.reportSnapshotId).toBe(originalReportSnapshotId);

  // The original stored artifacts are untouched — same report id, same bytes.
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  expect(n).toBe(1);
  const [reportRow] = await sql`SELECT report_bytes FROM analytics_report_snapshots WHERE id = ${originalReportSnapshotId}::bigint`;
  const expectedOriginalBytes = new Uint8Array(Buffer.from(originalBody.package.reportBase64, "base64"));
  expect(new Uint8Array(reportRow.report_bytes as Buffer)).toEqual(expectedOriginalBytes);
  const [regimeRow] = await sql`SELECT composite FROM regime_snapshots WHERE date = ${asof}`;
  expect(Number(regimeRow.composite)).toBe(42.5); // NOT 999 — the conflicting submission never applied
});

// A different-STATUS resubmission (succeeded vs. failed) for the same run_id
// is also a content conflict, not a replay — proves the comparison checks
// the kind SET, not merely per-kind checksums of whatever happens to overlap.
test("resubmitting a DIFFERENT status (failed) for an already-succeeded run_id is rejected with 409", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-10", toolId: "fix2-status-conflict" });
  const asof = "2026-06-10";
  const first = await call(req("POST", A.runPackage, succeededPackage(runId, asof), TOKEN));
  expect(first!.status).toBe(200);

  const conflict = await call(req("POST", A.runPackage, failedPackage(runId, asof), TOKEN));
  expect(conflict!.status).toBe(409);

  const [{ n: reportRows }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  expect(reportRows).toBe(1); // the original succeeded package's report is untouched
});

// ── FIX3 (asof cross-check gap) ──────────────────────────────────────────────
test("a package.asof that disagrees with the run's own recorded asof (analytics_ledger_runs) is rejected with 400 and writes nothing", async () => {
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof: "2026-06-11", toolId: "fix3-asof-mismatch" });
  // The run's ledger asof is 2026-06-11; submit a package claiming a DIFFERENT
  // market date — a caller bug that must never freeze a report snapshot
  // under the wrong date.
  const wrongAsof = "2026-06-12";
  const body = succeededPackage(runId, wrongAsof);

  const res = await call(req("POST", A.runPackage, body, TOKEN));
  expect(res!.status).toBe(400);
  expect((res!.body as any).error).toMatch(/does not match run .* recorded asof/);

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint`;
  expect(n).toBe(0);
  const [{ n: reportRows }] = await sql`SELECT count(*)::int AS n FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  expect(reportRows).toBe(0);
});

test("a package.asof that MATCHES the run's own recorded asof is accepted normally", async () => {
  const asof = "2026-06-13";
  const { runId } = await beginRun({ runKey: crypto.randomUUID(), asof, toolId: "fix3-asof-match" });
  const res = await call(req("POST", A.runPackage, succeededPackage(runId, asof), TOKEN));
  expect(res!.status).toBe(200);
});
