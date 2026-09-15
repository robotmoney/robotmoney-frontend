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
