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
import { describe, expect, test, beforeAll } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { payloadChecksum } from "../src/analytics/source-ledger.ts";
import { checkRawIndicatorHistoryParity, checkRegimeSnapshotsParity, checkResearchSignalsParity } from "../src/analytics/cutover/parity.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { provisionAnalyticsToken, provisionOperatorToken } from "./support/automation-auth.ts";

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
    await submitRawHistoryPoint("DUALWRITE_REPLAY", "2024-02-01", 2.5);
    const before = await checkRawIndicatorHistoryParity();
    expect(before.matched).toBe(true);

    // A second, independent acquisition recording the SAME value adds no
    // version at all (source-ledger-store.ts, issue #1035), and re-POSTing the
    // same rawHistory point rewrites nothing either.
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

// Owner, 2026-09-29 (D56's amendment): raw-history parity compares VALUES, within
// the tolerance both writers use, and does not compare `source`. These pin both
// halves, and that a difference beyond tolerance is still caught.
describe("dual-write parity: raw-history values within tolerance, labels not compared", () => {
  test("two tables holding different labels for one value match", async () => {
    await submitRawHistoryPoint("DUALWRITE_LABEL_SPLIT", "2024-05-01", 1.25, { provenance: "live", source: "seed" });
    // The split is real on both sides, not a fixture that failed to write.
    const [legacyRow] = (await sql`
      SELECT source FROM raw_indicator_history WHERE indicator = 'DUALWRITE_LABEL_SPLIT'`) as unknown as { source: string | null }[];
    expect(legacyRow!.source).toBe("seed");
    const [ledgerRow] = (await sql`
      SELECT provenance FROM source_value_versions
      WHERE source_key = 'raw_indicator_history:DUALWRITE_LABEL_SPLIT'`) as unknown as { provenance: string | null }[];
    expect(ledgerRow!.provenance).toBe("live");

    const raw = await checkRawIndicatorHistoryParity();
    expect(raw.mismatches, JSON.stringify(raw.mismatches)).toEqual([]);
    expect(raw.matched).toBe(true);
  });

  test("values within the source's tolerance match, with equal checksums; beyond it they do not", async () => {
    // IWF_IWD is a Yahoo ratio: relative 5e-6 (D56).
    const date = "2024-06-01";
    const base = 0.4797323800499549;
    await fixtureDb`INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES (${date}, 'IWF_IWD', ${base}, 'live')`;
    await fixtureDb`
      INSERT INTO source_value_versions (source_key, market_date, value, revision_kind)
      VALUES ('raw_indicator_history:IWF_IWD', ${date}, ${base * (1 + 1.5e-6)}, 'legacy_baseline')`;
    const within = await checkRawIndicatorHistoryParity();
    expect(within.mismatches, JSON.stringify(within.mismatches)).toEqual([]);
    expect(within.matched).toBe(true);
    expect(within.legacyChecksum).toBe(within.ledgerChecksum);

    // An exact source has no tolerance: the same relative difference is real.
    await fixtureDb`INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES (${date}, 'T10Y2Y', 1.25, 'live')`;
    await fixtureDb`
      INSERT INTO source_value_versions (source_key, market_date, value, revision_kind)
      VALUES ('raw_indicator_history:T10Y2Y', ${date}, ${1.25 * (1 + 1.5e-6)}, 'legacy_baseline')`;
    const beyond = await checkRawIndicatorHistoryParity();
    expect(beyond.matched).toBe(false);
    expect(beyond.mismatches.map((m) => m.naturalKey)).toEqual([`T10Y2Y\u0000${date}`]);
  });
});

// Issue #979 fix: the mid-run false-mismatch race. With issue #978's terminal
// package, a regime/research CURRENT-VIEW row and its ledger freeze arrive in
// ONE transaction (submitTerminalRunPackage → applyCurrentProjections), so the
// same-run split-window this issue originally fixed is gone by construction for
// the live producer. But compat-only rows whose date was NEVER frozen still
// exist out-of-band — the v0-seed archive, db/import-regime-eq.ts, a
// smoke/legacy subject — and checkRegimeSnapshotsParity/checkResearchSignals
// Parity's two reads are not one consistent snapshot. If an unsettled date were
// compared, the sweep would record a spurious — and, because
// analytics_parity_observations is append-only, PERMANENT — matched:false.
// These reproduce exactly that window (compat rows with NO terminal package
// ever submitted for their date) and prove the sweep does not record a false
// matched:false for them, while a genuinely persistent divergence on an
// ALREADY-settled date still correctly does.
describe("dual-write parity: mid-run race immunity (issue #979 fix)", () => {
  test("RACE: compat-only current rows with no frozen terminal package yet are not compared, so they cannot false-mismatch", async () => {
    const date = "2024-04-01";

    // The standalone `POST /api/analytics/regime-snapshots` /
    // `.../research-signals` routes are RETIRED (issue #978, see analytics.ts's
    // "RETIRED" comment) — a regime/research compat row now only ever arrives
    // inside a terminal package, which writes current-view AND ledger
    // atomically. An unsettled, compat-only row therefore has exactly one
    // honest shape in the merged model: a direct, out-of-band INSERT (the
    // v0-seed archive / import-regime-eq / legacy smoke subject — precisely
    // the rows publishBrief deliberately does NOT bind).
    await fixtureDb`INSERT INTO regime_snapshots (date, composite, regime) VALUES (${date}, 99, 'risk_on')`;
    await fixtureDb`
      INSERT INTO research_signals (signal_key, date, payload)
      VALUES ('race-signal', ${date}, ${fixtureDb.json({ asof: date, title: "in-flight", question: "q", spec: {}, gauges: [] })})`;

    // The compat rows really landed — this is not a no-op test.
    const compatRegime = await sql`SELECT composite FROM regime_snapshots WHERE date = ${date}`;
    expect(compatRegime.length).toBe(1);
    const compatResearch = await sql`SELECT payload FROM research_signals WHERE signal_key = 'race-signal' AND date = ${date}`;
    expect(compatResearch.length).toBe(1);

    // No analytics_report_snapshots row exists for this asof — genuinely
    // unsettled, so the comparison must not even look at the date.
    const settled = await sql`SELECT 1 FROM analytics_report_snapshots WHERE asof = ${date}`;
    expect(settled.length).toBe(0);

    const regime = await checkRegimeSnapshotsParity();
    expect(regime.matched, JSON.stringify(regime.mismatches)).toBe(true);
    expect(regime.mismatches.some((m) => m.naturalKey === date)).toBe(false);
    const regimeRowsWhileInFlight = regime.legacyRowCount;

    const research = await checkResearchSignalsParity();
    expect(research.matched, JSON.stringify(research.mismatches)).toBe(true);
    expect(research.mismatches.some((m) => m.naturalKey === `race-signal ${date}`)).toBe(false);
    const researchRowsWhileInFlight = research.legacyRowCount;

    // And the filter is per-date, not permanent: once a terminal package
    // freezes this asof FOR REAL, the same date enters the comparison, and the
    // current rows it dual-writes agree with its frozen artifacts — nothing
    // dangles, nothing mismatches, the row counts advance.
    await submitRegimeAndResearch(date, 99, "race-signal", "in-flight");
    expect((await sql`SELECT 1 FROM analytics_report_snapshots WHERE asof = ${date}`).length).toBe(1);

    const regimeSettled = await checkRegimeSnapshotsParity();
    expect(regimeSettled.matched, JSON.stringify(regimeSettled.mismatches)).toBe(true);
    expect(
      regimeSettled.legacyRowCount,
      "the settled date must now be IN the comparison",
    ).toBe(regimeRowsWhileInFlight + 1);
    const researchSettled = await checkResearchSignalsParity();
    expect(researchSettled.matched, JSON.stringify(researchSettled.mismatches)).toBe(true);
    expect(researchSettled.legacyRowCount).toBe(researchRowsWhileInFlight + 1);
  });

  test("PERSISTENT MISMATCH: a genuine divergence on an already-SETTLED date still records matched:false", async () => {
    const date = "2024-04-02";
    // Freeze this asof for real (A.runPackage) — analytics_report_snapshots
    // now has a row for it, so it is settled and eligible for comparison.
    await submitRegimeAndResearch(date, 10, "persistent-mismatch-signal", "v1");
    expect((await checkRegimeSnapshotsParity()).matched).toBe(true);
    expect((await checkResearchSignalsParity()).matched).toBe(true);

    // Drift the COMPATIBILITY table only, out of band, after settlement — the
    // ledger keeps the frozen value. This is a real, persistent divergence,
    // not a timing artifact, and AC2 requires it to still block cutover.
    await fixtureDb`UPDATE regime_snapshots SET composite = 424242 WHERE date = ${date}`;
    await fixtureDb`
      UPDATE research_signals SET payload = ${fixtureDb.json({ asof: date, title: "drifted-out-of-band", question: "q", spec: {}, gauges: [] })}
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
