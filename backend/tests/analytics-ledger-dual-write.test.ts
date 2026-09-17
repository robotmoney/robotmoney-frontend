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
//
// Both calls carry the SAME data-source label, because the orchestrator's two
// calls do: extract/sources.ts captures with provenance 'live' by default and
// analytics/index.ts writes the merged floor with source 'live'. Sending the
// label on only one side would make this fixture model the very bug issue
// #979's `source` parity check exists to catch, so the two are parameters of
// one fixture and default together.
const LIVE = "live";
async function submitRawHistoryPoint(
  indicator: string,
  date: string,
  value: number,
  // `provenance: null` sends NO label at all — the shape of a writer that
  // stopped stamping one, which must never be confused with sending 'live'.
  labels: { provenance?: string | null; source?: string } = {},
) : Promise<void> {
  const provenance = labels.provenance === undefined ? LIVE : labels.provenance;
  const source = labels.source ?? LIVE;
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
      values: [{
        sourceKey: `raw_indicator_history:${indicator}`, marketDate: date, marketInstant: null, value,
        ...(provenance === null ? {} : { provenance }),
      }],
    },
  };
  const acqRes = await call(req("POST", A.sourceAcquisitions, acquisitionBody));
  expect(acqRes!.status, JSON.stringify(acqRes)).toBe(200);

  const rawRes = await call(req("POST", A.rawHistory, { history: { [indicator]: [{ date, value }] }, source }));
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

// Issue #979 AC3 fix: `source` is part of the raw-history DTO, so it has to be
// part of raw-history parity — otherwise a fully green observation window
// green-lights a cutover that silently changes that field. These pin BOTH
// halves: the divergence is caught, and the historical rows the product owner
// accepted as permanently unlabelled do NOT park the gate red forever.
describe("dual-write parity: raw-history `source` (issue #979 AC3)", () => {
  test("a row whose ledger label disagrees with its compatibility label is a MISMATCH, not an invisible difference", async () => {
    prodAuth();
    // Exactly the shape the producer's gap catch-up produced before this fix:
    // the acquisition captured 'live' while the floor writer tagged the very
    // same point 'seed'. Value, indicator and date all agree — `source` is the
    // ONLY difference, so a pass here can only come from comparing it.
    await submitRawHistoryPoint("DUALWRITE_LABEL_SPLIT", "2024-05-01", 1.25, { provenance: "live", source: "seed" });

    const raw = await checkRawIndicatorHistoryParity();
    expect(raw.matched, "a `source` split must fail parity").toBe(false);
    expect(
      raw.mismatches.some((m) => m.naturalKey.includes("DUALWRITE_LABEL_SPLIT") && m.reason.includes("canonical value differs")),
      JSON.stringify(raw.mismatches),
    ).toBe(true);
    // The split is real on both sides, not a fixture that failed to write.
    const [legacyRow] = (await sql`
      SELECT source FROM raw_indicator_history WHERE indicator = 'DUALWRITE_LABEL_SPLIT'`) as unknown as { source: string | null }[];
    expect(legacyRow!.source).toBe("seed");
    const [ledgerRow] = (await sql`
      SELECT provenance FROM source_value_versions
      WHERE source_key = 'raw_indicator_history:DUALWRITE_LABEL_SPLIT'`) as unknown as { provenance: string | null }[];
    expect(ledgerRow!.provenance).toBe("live");

    // Agreeing on the label is what clears it — same row, relabelled through
    // the same two production routes, no other change.
    await submitRawHistoryPoint("DUALWRITE_LABEL_SPLIT", "2024-05-01", 1.25, { provenance: "seed", source: "seed" });
    const fixed = await checkRawIndicatorHistoryParity();
    expect(fixed.mismatches, JSON.stringify(fixed.mismatches)).toEqual([]);
    expect(fixed.matched).toBe(true);
  });

  test("a version recorded BEFORE migration 0061 is exempt from the `source` comparison, so accepted history cannot park the gate red", async () => {
    prodAuth();
    // A pre-0061 row, built the only way an append-only ledger allows: a fresh
    // INSERT (never an UPDATE) with revision_kind 'legacy_baseline' and no
    // acquisition — migration 0057's own backfill shape — back-dated to one
    // day before 0061 was applied to this database. Its provenance is NULL and
    // can never become anything else, while the compatibility row carries the
    // real 'live' label raw-history has written since migration 0024.
    const [{ applied_at: appliedAt }] = (await sql`
      SELECT applied_at FROM schema_migrations WHERE name = '0061_source_value_provenance.sql'`) as unknown as { applied_at: Date }[];
    expect(appliedAt, "0061 must be applied here or this test proves nothing").toBeDefined();
    const before = new Date(new Date(appliedAt).getTime() - 86_400_000).toISOString();

    await sql`INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES ('2024-06-01', 'DUALWRITE_PRE_0061', 3.5, 'live')`;
    await sql`
      INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
      VALUES ('raw_indicator_history:DUALWRITE_PRE_0061', '2024-06-01', 3.5, 'legacy_baseline', ${before}::timestamptz)`;

    const [pre] = (await sql`
      SELECT provenance FROM source_value_versions
      WHERE source_key = 'raw_indicator_history:DUALWRITE_PRE_0061'`) as unknown as { provenance: string | null }[];
    expect(pre!.provenance, "the pre-0061 population is exactly the NULL one").toBeNull();

    const raw = await checkRawIndicatorHistoryParity();
    expect(raw.mismatches, JSON.stringify(raw.mismatches)).toEqual([]);
    expect(raw.matched, "a permanently unlabelled historical row must not block cutover").toBe(true);

    // ...and the exemption expires the moment anything writes to that key
    // again. Re-submitting the SAME value through the same two production
    // routes, with no label on the acquisition, appends a post-0061 current
    // version whose provenance is NULL against a legacy 'live' — in scope, and
    // caught, rather than inheriting history's exemption. This is the
    // "a writer stopped stamping provenance" regression, and the scope does
    // not hide it.
    await submitRawHistoryPoint("DUALWRITE_PRE_0061", "2024-06-01", 3.5, { provenance: null, source: "live" });
    const reopened = await checkRawIndicatorHistoryParity();
    expect(
      reopened.mismatches.some((m) => m.naturalKey.includes("DUALWRITE_PRE_0061")),
      JSON.stringify(reopened.mismatches),
    ).toBe(true);
  });
});

// Issue #979 fix: the mid-run false-mismatch race. checkRegimeSnapshotsParity/
// checkResearchSignalsParity's two reads are not one consistent snapshot — the
// compatibility row (saveRegimeSnapshots/saveResearchSignal, A.regimeSnapshots/
// A.researchSignals below) lands mid-run, while the ledger-derived
// reconstruction only gains that date's content once submitTerminalRunPackage
// freezes it, at the very end of the SAME run. These reproduce exactly that
// window — a compat write with NO terminal package (A.runPackage) ever
// submitted for that date — and prove the sweep does not record a false
// matched:false for it, while a genuinely persistent divergence on an
// ALREADY-settled date still correctly does.
describe("dual-write parity: mid-run race immunity (issue #979 fix)", () => {
  test("RACE: a compat-only write with no terminal package yet is not compared, so it cannot false-mismatch", async () => {
    prodAuth();
    const date = "2024-04-01";

    // Exactly the mid-run call shape (analytics/index.ts's
    // persistence.saveRegimeSnapshots/saveResearchSignal): the compat row
    // lands, but no A.runPackage submission has EVER frozen this asof, so
    // analytics_report_snapshots has no row for it — the date is "in-flight".
    const regimeRes = await call(req("POST", A.regimeSnapshots, { snapshots: [regimeFixture(date, 99)] }));
    expect(regimeRes!.status, JSON.stringify(regimeRes)).toBe(200);
    const researchRes = await call(
      req("POST", A.researchSignals, { signals: [researchFixture("race-signal", date, "in-flight")] }),
    );
    expect(researchRes!.status, JSON.stringify(researchRes)).toBe(200);

    // The compat write really landed — this is not a no-op test.
    const compatRegime = await sql`SELECT composite FROM regime_snapshots WHERE date = ${date}`;
    expect(compatRegime.length).toBe(1);
    const compatResearch = await sql`SELECT payload FROM research_signals WHERE signal_key = 'race-signal' AND date = ${date}`;
    expect(compatResearch.length).toBe(1);

    // No analytics_report_snapshots row exists for this asof — genuinely unsettled.
    const settled = await sql`SELECT 1 FROM analytics_report_snapshots WHERE asof = ${date}`;
    expect(settled.length).toBe(0);

    const regime = await checkRegimeSnapshotsParity();
    expect(regime.matched, JSON.stringify(regime.mismatches)).toBe(true);
    expect(regime.mismatches.some((m) => m.naturalKey === date)).toBe(false);

    const research = await checkResearchSignalsParity();
    expect(research.matched, JSON.stringify(research.mismatches)).toBe(true);
    expect(research.mismatches.some((m) => m.naturalKey === `race-signal ${date}`)).toBe(false);
  });

  test("PERSISTENT MISMATCH: a genuine divergence on an already-SETTLED date still records matched:false", async () => {
    prodAuth();
    const date = "2024-04-02";
    // Freeze this asof for real (A.runPackage) — analytics_report_snapshots
    // now has a row for it, so it is settled and eligible for comparison.
    await submitRegimeAndResearch(date, 10, "persistent-mismatch-signal", "v1");
    expect((await checkRegimeSnapshotsParity()).matched).toBe(true);
    expect((await checkResearchSignalsParity()).matched).toBe(true);

    // Drift the COMPATIBILITY table only, out of band, after settlement — the
    // ledger keeps the frozen value. This is a real, persistent divergence,
    // not a timing artifact, and AC2 requires it to still block cutover.
    await sql`UPDATE regime_snapshots SET composite = 424242 WHERE date = ${date}`;
    await sql`
      UPDATE research_signals SET payload = ${sql.json({ asof: date, title: "drifted-out-of-band", question: "q", spec: {}, gauges: [] })}
      WHERE signal_key = 'persistent-mismatch-signal' AND date = ${date}
    `;

    const regime = await checkRegimeSnapshotsParity();
    expect(regime.matched).toBe(false);
    expect(regime.mismatches.some((m) => m.naturalKey === date)).toBe(true);

    const research = await checkResearchSignalsParity();
    expect(research.matched).toBe(false);
    expect(research.mismatches.some((m) => m.naturalKey === `persistent-mismatch-signal ${date}`)).toBe(true);
  });
});
