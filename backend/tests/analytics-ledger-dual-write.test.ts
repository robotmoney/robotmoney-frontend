// Issue #979 AC1: dual-write parity checking.
//
// Submits raw-history, regime, and research writes through the REAL
// authenticated analytics API (handleAnalytics, the exact route module
// production uses — never a store function called by hand) and asserts that
// the compatibility current-view rows (raw_indicator_history, regime_snapshots,
// research_signals) and the LEDGER-DERIVED current rows (reconstructed purely
// from source_value_versions / analytics_output_snapshots by
// analytics/cutover/ledger-current.ts) have identical natural keys, canonical
// values, row counts, and checksums — after an initial insert, an unchanged
// replay, and a genuine revision.
import { afterEach, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { payloadChecksum } from "../src/analytics/source-ledger.ts";
import { checkRawIndicatorHistoryParity, checkRegimeSnapshotsParity, checkResearchSignalsParity } from "../src/analytics/cutover/parity.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const A = ROUTES.analytics;
const TOKEN = "tok_analytics_test_secret";
const ADMIN = "tok_admin_test_secret";

const orig = { analyticsToken: config.analyticsToken, adminToken: config.adminToken, allowInsecure: config.allowInsecure };
function prodAuth() {
  config.analyticsToken = TOKEN;
  config.adminToken = ADMIN;
  config.allowInsecure = false;
}
afterEach(() => {
  config.analyticsToken = orig.analyticsToken;
  config.adminToken = orig.adminToken;
  config.allowInsecure = orig.allowInsecure;
});

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const call = (r: Request) => handleAnalytics(r, new URL(r.url));

// ── raw-history: acquisition (ledger) + rawHistory (compatibility), the SAME
// two calls the real orchestrator makes for one fetched point ────────────────
async function submitRawHistoryPoint(indicator: string, date: string, value: number): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ indicator, date, value }));
  const acquisitionBody = {
    acquisition: {
      id: crypto.randomUUID(),
      provider: "fixture",
      parserVersion: "fixture:1",
      cacheIdentity: `dual-write-${indicator}`,
      requestedByRunId: null,
      events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }],
      fetches: [
        {
          id: crypto.randomUUID(),
          sequence: 1,
          requestIdentity: { method: "GET", url: "https://example.invalid/data", headers: {} },
          cacheStatus: "disabled",
          responseStatus: 200,
          responseChecksum: payloadChecksum(bytes),
          payloadBase64: Buffer.from(bytes).toString("base64"),
          providerReleaseId: null,
          errorDetail: null,
        },
      ],
      values: [{ sourceKey: `raw_indicator_history:${indicator}`, marketDate: date, marketInstant: null, value }],
    },
  };
  const acqRes = await call(req("POST", A.sourceAcquisitions, acquisitionBody));
  expect(acqRes!.status, JSON.stringify(acqRes)).toBe(200);

  const rawRes = await call(req("POST", A.rawHistory, { history: { [indicator]: [{ date, value }] } }));
  expect(rawRes!.status).toBe(200);
}

// ── regime + research: beginRun (ledger header) + runPackage (dual-writes
// regime_snapshots/research_signals AND analytics_output_snapshots/
// analytics_report_snapshots in one transaction), the same shape issue #978
// already wires runAnalytics through ─────────────────────────────────────────
function regimeFixture(date: string, composite: number) {
  return {
    date,
    composite,
    compositePercentile: 0.5,
    regime: "risk_on",
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
    version: "v-test",
    source: "fixture",
    percentiles: {},
    indicators: [],
    panels: null,
    bucketThresholds: null,
    backtest: null,
    correlations: null,
    extras: null,
  };
}

function researchFixture(key: string, date: string, marker: string) {
  return { key, date, payload: { asof: date, title: marker, question: "q", spec: {}, gauges: [] } };
}

async function submitRegimeAndResearch(
  date: string,
  composite: number,
  signalKey: string,
  marker: string,
): Promise<string> {
  const runKey = crypto.randomUUID();
  const beginRes = await call(
    req("POST", A.runs, {
      run: {
        runKey,
        asof: date,
        toolId: "dual-write-test",
        sourceLabel: "fixture",
        methodology: { toolId: "dual-write-test", versionLabel: "v-test", config: { k: "v" } },
        buildIdentity: "dual-write-build",
      },
    }),
  );
  expect(beginRes!.status, JSON.stringify(beginRes)).toBe(200);
  const { runId } = beginRes!.body as { runId: string };

  const reportBase64 = Buffer.from(`report ${runId} ${date}`, "utf8").toString("base64");
  const pkgRes = await call(
    req("POST", A.runPackage, {
      package: {
        runId,
        asof: date,
        status: "succeeded",
        regimeSnapshots: [regimeFixture(date, composite)],
        researchSignals: [researchFixture(signalKey, date, marker)],
        reportBase64,
      },
    }),
  );
  expect(pkgRes!.status, JSON.stringify(pkgRes)).toBe(200);
  return runId;
}

describe("dual-write parity: raw-history, regime, and research through the authenticated analytics API", () => {
  test("INSERT: compatibility and ledger-derived current rows have identical natural keys, values, row counts, and checksums", async () => {
    prodAuth();
    await submitRawHistoryPoint("DUALWRITE_IND", "2024-01-01", 1.5);
    await submitRegimeAndResearch("2024-01-01", 10, "dualwrite-signal", "v1");

    const raw = await checkRawIndicatorHistoryParity();
    expect(raw.mismatches, JSON.stringify(raw.mismatches)).toEqual([]);
    expect(raw.matched).toBe(true);
    expect(raw.legacyRowCount).toBe(raw.ledgerRowCount);
    expect(raw.legacyChecksum).toBe(raw.ledgerChecksum);

    const regime = await checkRegimeSnapshotsParity();
    expect(regime.mismatches).toEqual([]);
    expect(regime.matched).toBe(true);
    expect(regime.legacyChecksum).toBe(regime.ledgerChecksum);

    const research = await checkResearchSignalsParity();
    expect(research.mismatches).toEqual([]);
    expect(research.matched).toBe(true);
    expect(research.legacyChecksum).toBe(research.ledgerChecksum);
  });

  test("UNCHANGED REPLAY: resubmitting the identical content converges (no duplication) and parity still matches", async () => {
    prodAuth();
    await submitRawHistoryPoint("DUALWRITE_REPLAY", "2024-02-01", 2.5);
    const before = await checkRawIndicatorHistoryParity();
    expect(before.matched).toBe(true);

    // A second, independent acquisition recording the SAME value is an
    // "unchanged" revision_kind (source-ledger-store.ts), and re-POSTing the
    // same rawHistory point is the writer's own idempotent upsert.
    await submitRawHistoryPoint("DUALWRITE_REPLAY", "2024-02-01", 2.5);

    const after = await checkRawIndicatorHistoryParity();
    expect(after.mismatches).toEqual([]);
    expect(after.matched).toBe(true);
    expect(after.legacyRowCount).toBe(before.legacyRowCount); // no duplication
    expect(after.legacyChecksum).toBe(after.ledgerChecksum);

    const runId1 = await submitRegimeAndResearch("2024-02-01", 20, "dualwrite-replay-signal", "same");
    const regimeBefore = await checkRegimeSnapshotsParity();
    expect(regimeBefore.matched).toBe(true);
    // A second run submitting the IDENTICAL regime/research content for the
    // same date (a different run_id — every run is its own ledger row, but
    // the compatibility upsert converges on the same current value).
    await submitRegimeAndResearch("2024-02-01", 20, "dualwrite-replay-signal", "same");
    const regimeAfter = await checkRegimeSnapshotsParity();
    expect(regimeAfter.matched).toBe(true);
    expect(regimeAfter.legacyChecksum).toBe(regimeAfter.ledgerChecksum);
    const researchAfter = await checkResearchSignalsParity();
    expect(researchAfter.matched).toBe(true);
    void runId1;
  });

  test("REVISION: a genuinely changed value still converges to matching compatibility and ledger current rows", async () => {
    prodAuth();
    await submitRawHistoryPoint("DUALWRITE_REVISED", "2024-03-01", 5);
    await submitRegimeAndResearch("2024-03-01", 30, "dualwrite-revision-signal", "v1");
    expect((await checkRawIndicatorHistoryParity()).matched).toBe(true);
    expect((await checkRegimeSnapshotsParity()).matched).toBe(true);
    expect((await checkResearchSignalsParity()).matched).toBe(true);

    // A genuine revision: same natural keys, a DIFFERENT value.
    await submitRawHistoryPoint("DUALWRITE_REVISED", "2024-03-01", 7);
    await submitRegimeAndResearch("2024-03-01", 42, "dualwrite-revision-signal", "v2");

    const raw = await checkRawIndicatorHistoryParity();
    expect(raw.mismatches).toEqual([]);
    expect(raw.matched, "the ledger must reflect the REVISED value, not the stale one").toBe(true);
    const rawRows = await sql`SELECT value FROM raw_indicator_history WHERE indicator = 'DUALWRITE_REVISED' AND date = '2024-03-01'`;
    expect(Number(rawRows[0]!.value)).toBe(7);

    const regime = await checkRegimeSnapshotsParity();
    expect(regime.mismatches).toEqual([]);
    expect(regime.matched).toBe(true);
    const regimeRows = await sql`SELECT composite FROM regime_snapshots WHERE date = '2024-03-01'`;
    expect(Number(regimeRows[0]!.composite)).toBe(42);

    const research = await checkResearchSignalsParity();
    expect(research.mismatches).toEqual([]);
    expect(research.matched).toBe(true);
    const researchRows = await sql`SELECT payload FROM research_signals WHERE signal_key = 'dualwrite-revision-signal' AND date = '2024-03-01'`;
    expect((researchRows[0]!.payload as { title: string }).title).toBe("v2");
  });
});
