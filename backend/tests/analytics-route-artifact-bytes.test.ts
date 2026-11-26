// The HTTP analytics route freezes the same regime artifact bytes as the direct
// persistence path (issue 1765, D-f; acceptance box 6, first form).
//
// One v4 regime run goes through the HTTP path: the production orchestrator
// over analyticsApiClient, against the REAL analytics route handler wrapped in
// Bun.serve, authenticated with analytics-producer's store token delivered as
// a token file. One goes through the direct path (directAnalyticsPersistence).
// Same inputs (the committed-input fixture source), same as-of day, each on a
// clean database of its own. The two frozen regime artifacts have equal
// checksums (equal to sha256(payload_bytes) by the CHECK on
// analytics_output_snapshots), equal to the sha256 of the canonical bytes of
// the rows the direct run computed. Wave 3 of issue 1765 switches that
// reference to the SDK's publishedRows. Box 6 names publishedRows, so this
// first form leaves the box open until wave 3 lands.
//
// Before D-f, parseSnapshotRow added `bucketThresholds: null` and
// `extras: null` to every row. No row builder sets either key, and
// canonicalStringify keeps a null key, so the HTTP path froze different bytes.
// The served body never differed (every reader maps a missing key to null),
// and still does not: the as-of rows the dashboards route serves from each
// run's ledger are deep-equal.
//
// Artifacts are selected by REGIME_ARTIFACT_KIND, never by a literal kind.
import { describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { handleAnalytics, parseSnapshots } from "../src/api/routes/analytics.ts";
import { getRegimeSnapshots } from "../src/api/routes/dashboards.ts";
import { analyticsApiClient, readAnalyticsToken } from "../src/analytics/api-client.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { REGIME_ARTIFACT_KIND, canonicalArtifactBytes } from "../src/analytics/output-snapshots.ts";
import { sha256Hex } from "../src/analytics/run-ledger.ts";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import type { RegimeSnapshotRow } from "../src/analytics/report/regime-projection.ts";
import { baseObservations } from "./support/committed-inputs.ts";
import { ASOF, runRegime, sourceFor } from "./support/regime-v5.ts";
import { provisionAnalyticsToken, writeTokenFile } from "./support/automation-auth.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// A database per test: each path starts from the same empty ledger.
useCleanDatabasePerTest(import.meta.file);

interface PathRun {
  /** The rows the orchestrator handed to submitTerminalRunPackage, before any wire. */
  rows: RegimeSnapshotRow[];
  /** The frozen main-line regime artifact: its stored checksum and sha256(payload_bytes). */
  checksum: string;
  payloadSha256: string;
  /** The as-of row the dashboards route serves from this database's ledger. */
  servedLatest: unknown;
}

const runs: { direct?: PathRun; http?: PathRun } = {};

/** `persistence` with the submitted regime rows captured. */
function capturing(persistence: AnalyticsPersistence): { persistence: AnalyticsPersistence; rows: () => RegimeSnapshotRow[] } {
  let captured: RegimeSnapshotRow[] | null = null;
  return {
    persistence: {
      ...persistence,
      async submitTerminalRunPackage(input) {
        captured = [...(input.regimeSnapshots ?? [])];
        return persistence.submitTerminalRunPackage(input);
      },
    },
    rows: () => {
      expect(captured).not.toBeNull();
      return captured!;
    },
  };
}

async function runPath(persistence: AnalyticsPersistence): Promise<PathRun> {
  const capture = capturing(persistence);
  const { runId } = await runRegime(ASOF, sourceFor(await baseObservations()), "v4", capture.persistence);
  const rows = capture.rows();
  expect(rows.length).toBeGreaterThan(1000);
  expect(rows[rows.length - 1]!.date).toBe(ASOF);
  const frozen = await sql<{ checksum: string; payload_bytes: Uint8Array }[]>`
    SELECT checksum, payload_bytes FROM analytics_output_snapshots
     WHERE run_id = ${runId}::bigint AND artifact_kind = ${REGIME_ARTIFACT_KIND.main}`;
  expect(frozen.length).toBe(1);
  // The as-of row the dashboards route serves (ledgerRowToSnapshot of the published row, backtest included).
  const body = await getRegimeSnapshots(new URL(`http://backend.test${ROUTES.dashboards.regimeSnapshots}?range=1&include=backtest`));
  expect(body.source).toBe("ledger");
  expect(body.latest?.date).toBe(ASOF);
  return { rows, checksum: frozen[0]!.checksum, payloadSha256: sha256Hex(frozen[0]!.payload_bytes), servedLatest: JSON.parse(JSON.stringify(body.latest)) };
}

describe("HTTP route and direct path freeze the same regime artifact bytes (D-f)", () => {
  test("direct path: one v4 regime run through directAnalyticsPersistence", async () => {
    runs.direct = await runPath(directAnalyticsPersistence);
    expect(runs.direct.checksum).toBe(runs.direct.payloadSha256);
  }, 600_000);

  test("HTTP path: the same run through analyticsApiClient and the real analytics route", async () => {
    // analytics-producer's store token, delivered as the file the client reads.
    const token = readAnalyticsToken({ ANALYTICS_TOKEN_FILE: writeTokenFile(await provisionAnalyticsToken()) });
    expect(token).not.toBeNull();
    let served = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        served++;
        const r = await handleAnalytics(req, new URL(req.url));
        if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      runs.http = await runPath(analyticsApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token }));
    } finally {
      server.stop(true);
    }
    // Not vacuous: the run really went over the route.
    expect(served).toBeGreaterThan(5);
    expect(runs.http.checksum).toBe(runs.http.payloadSha256);
  }, 600_000);

  test("the two artifacts have equal checksums, equal to sha256 of the canonical bytes of the direct run's rows; the served as-of rows are deep-equal", () => {
    const { direct, http } = runs;
    expect(direct).toBeDefined();
    expect(http).toBeDefined();
    // Both runs computed the same rows (in memory, before any wire).
    expect(sha256Hex(canonicalArtifactBytes(http!.rows))).toBe(sha256Hex(canonicalArtifactBytes(direct!.rows)));
    const reference = sha256Hex(canonicalArtifactBytes(direct!.rows));
    expect(direct!.checksum).toBe(reference);
    expect(http!.checksum).toBe(reference);
    expect(http!.checksum).toBe(direct!.checksum);
    // The served body is unchanged: the as-of row each ledger serves is the same.
    expect(http!.servedLatest).toEqual(direct!.servedLatest);
  });
});

describe("parseSnapshotRow carries bucketThresholds and extras only when sent (D-f red control)", () => {
  const row = {
    date: "2026-08-14",
    composite: 0.5,
    compositePercentile: null,
    regime: "neutral",
    macroRegime: null,
    onchainRegime: null,
    factorRegime: null,
    macroIndex: null,
    onchainIndex: null,
    factorIndex: null,
    macroPercentile: null,
    onchainPercentile: null,
    factorPercentile: null,
    panelWeights: null,
    version: "v4",
    source: "fixture",
    percentiles: {},
    indicators: [],
    panels: null,
    backtest: null,
    correlations: null,
  };

  const parseOne = (r: Record<string, unknown>): Record<string, unknown> => {
    const parsed = parseSnapshots({ snapshots: [r] });
    if (!Array.isArray(parsed)) throw new Error(`parseSnapshots refused the row: ${JSON.stringify(parsed)}`);
    return parsed[0] as unknown as Record<string, unknown>;
  };

  test("a row without either key parses to a row without either key", () => {
    const parsed = parseOne(row);
    expect(Object.hasOwn(parsed, "bucketThresholds")).toBe(false);
    expect(Object.hasOwn(parsed, "extras")).toBe(false);
    // So its canonical bytes are the sender's.
    expect(sha256Hex(canonicalArtifactBytes([parsed]))).toBe(sha256Hex(canonicalArtifactBytes([row])));
  });

  test("an explicit null is kept, and so is a sent object", () => {
    const withNull = parseOne({ ...row, bucketThresholds: null, extras: null });
    expect(Object.hasOwn(withNull, "bucketThresholds")).toBe(true);
    expect(withNull.bucketThresholds).toBeNull();
    expect(Object.hasOwn(withNull, "extras")).toBe(true);
    expect(withNull.extras).toBeNull();
    const withObjects = parseOne({ ...row, bucketThresholds: { risk_off: 0.33, risk_on: 0.67 }, extras: { spx: [] } });
    expect(withObjects.bucketThresholds).toEqual({ risk_off: 0.33, risk_on: 0.67 });
    expect(withObjects.extras).toEqual({ spx: [] });
  });
});
