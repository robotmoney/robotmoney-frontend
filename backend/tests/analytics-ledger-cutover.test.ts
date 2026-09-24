// Issue #979 AC2/AC3/AC4/AC7/AC9: the cutover gate, current-read consumer
// equivalence, non-destructive rollback, legacy-baseline semantics, and
// migration/cutover/rollback stability of both the ledger and the
// pre-existing legacy tables.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";
import { ROUTES } from "@robotmoney/contract";
import { POSTGRES_IMAGE } from "../../scripts/lib/postgres-image.ts";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { handleAdmin, type AdminAuthConfig } from "../src/api/routes/admin.ts";
import { getRegimeSnapshots, getRegimeSnapshotsSummary, getResearchSignal } from "../src/api/routes/dashboards.ts";
import { ensureSubject, openSession, publishBrief, getBriefBySession } from "../src/swarm/domain.ts";
import { captureSourceAcquisition, payloadChecksum } from "../src/analytics/source-ledger.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import type { AnalyticsDataSource } from "../src/analytics/access/data-source.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { catchUpMissedIndicatorDays, CATCH_UP_PROVENANCE } from "../src/producer/index.ts";
import { checkRawIndicatorHistoryParity } from "../src/analytics/cutover/parity.ts";
import { evaluateCutoverGate, type CutoverGateConfig } from "../src/analytics/cutover/gate.ts";
import { runCutoverGateCli } from "../scripts/analytics-ledger-cutover-gate.ts";
import { getAnalyticsReadMode, setAnalyticsReadMode, CutoverGateNotPassedError } from "../src/analytics/cutover/read-mode.ts";
import type { ParityDomain } from "../src/analytics/cutover/parity.ts";
import { canonicalStringify, sha256Hex } from "../src/analytics/run-ledger.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// PER TEST, not per file: analytics_parity_observations is immutable
// (migration 0060 refuses DELETE/UPDATE/TRUNCATE), so a shared database would
// let one test's seeded observations leak into the next test's gate
// evaluation — exactly the kind of cross-test contamination a per-file clean
// database cannot undo for an append-only table.
useCleanDatabasePerTest(import.meta.file);

const TEST_GATE_ENV = {
  ANALYTICS_CUTOVER_MIN_WINDOW_MS: "60000",
  ANALYTICS_CUTOVER_MIN_OBSERVATIONS: "3",
  ANALYTICS_CUTOVER_MAX_STALENESS_MS: "30000",
};

const A = ROUTES.analytics;
const TOKEN = "tok_analytics_test_secret";
const ADMIN_TOKEN = "tok_admin_test_secret";

const orig = { analyticsToken: config.analyticsToken, adminToken: config.adminToken, allowInsecure: config.allowInsecure };
const origGateEnv = Object.fromEntries(Object.keys(TEST_GATE_ENV).map((k) => [k, process.env[k]]));
for (const [k, v] of Object.entries(TEST_GATE_ENV)) process.env[k] = v;
afterEach(async () => {
  config.analyticsToken = orig.analyticsToken;
  config.adminToken = orig.adminToken;
  config.allowInsecure = orig.allowInsecure;
  // Every test leaves the switch back on 'compatibility' — a raw SQL reset,
  // not setAnalyticsReadMode(), because a prior test may have left the gate
  // unsatisfied (compatibility is never gated, but this keeps every test
  // file's teardown identical and independent of gate state).
  await sql`UPDATE analytics_read_mode SET mode = 'compatibility', updated_by = 'test-teardown' WHERE id = true`;
});
afterAll(() => {
  for (const [k, v] of Object.entries(origGateEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
function prodAuth() {
  config.analyticsToken = TOKEN;
  config.adminToken = ADMIN_TOKEN;
  config.allowInsecure = false;
}

function req(method: string, path: string, body?: unknown, token = TOKEN): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const call = (r: Request) => handleAnalytics(r, new URL(r.url));

const ADMIN_CFG: AdminAuthConfig = { adminToken: ADMIN_TOKEN, allowInsecure: false };
function adminReq(path: string): Request {
  return new Request(`http://x${path}`, { headers: { "X-Admin-Token": ADMIN_TOKEN } });
}
const callAdmin = (r: Request) => handleAdmin(r, new URL(r.url), ADMIN_CFG);

// `provenance` is the acquisition-time data-source label (issue #979,
// migration 0061). Omitted here means the submitter observed none, which is
// the pre-0061 shape: the ledger row's provenance stays NULL.
async function submitRawHistoryPoint(indicator: string, date: string, value: number, provenance?: string): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ indicator, date, value }));
  await call(
    req("POST", A.sourceAcquisitions, {
      acquisition: {
        id: crypto.randomUUID(),
        provider: "fixture",
        parserVersion: "fixture:1",
        cacheIdentity: `cutover-${indicator}`,
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
          ...(provenance === undefined ? {} : { provenance }),
        }],
      },
    }),
  );
  const res = await call(req("POST", A.rawHistory, { history: { [indicator]: [{ date, value }] } }));
  expect(res!.status).toBe(200);
}

function regimeFixture(date: string, composite: number) {
  return {
    date, composite, compositePercentile: 0.5, regime: "risk_on",
    macroRegime: null, onchainRegime: null, factorRegime: null,
    macroIndex: null, onchainIndex: null, factorIndex: null,
    macroPercentile: null, onchainPercentile: null, factorPercentile: null,
    panelWeights: null, version: "v-test", source: "fixture",
    percentiles: {}, indicators: [], panels: null, bucketThresholds: null,
    backtest: null, correlations: null, extras: null,
  };
}

async function submitRegimeAndResearch(date: string, composite: number, signalKey: string, title: string): Promise<void> {
  const beginRes = await call(
    req("POST", A.runs, {
      run: {
        runKey: crypto.randomUUID(), asof: date, toolId: "cutover-test", sourceLabel: "fixture",
        methodology: { toolId: "cutover-test", versionLabel: "v-test", config: { k: "v" } },
        buildIdentity: "cutover-build",
      },
    }),
  );
  expect(beginRes!.status, JSON.stringify(beginRes)).toBe(200);
  const { runId } = beginRes!.body as { runId: string };
  const pkgRes = await call(
    req("POST", A.runPackage, {
      package: {
        runId, asof: date, status: "succeeded",
        regimeSnapshots: [regimeFixture(date, composite)],
        researchSignals: [{ key: signalKey, date, payload: { asof: date, title, question: "q", spec: {}, gauges: [] } }],
        reportBase64: Buffer.from(`report ${runId} ${date}`, "utf8").toString("base64"),
      },
    }),
  );
  expect(pkgRes!.status, JSON.stringify(pkgRes)).toBe(200);
}

// Insert a fully-formed, controllable observation directly — this is the
// evidence layer the real gate reads, and these tests need to place
// observations at PRECISE timestamps (spanning the configured window) far
// faster than waiting on a real clock.
async function insertObservation(domain: ParityDomain, observedAt: Date, matched: boolean): Promise<void> {
  const rows = [{ domain, value: matched ? "ok" : "bad" }];
  const checksum = sha256Hex(canonicalStringify(rows));
  await sql`
    INSERT INTO analytics_parity_observations
      (domain, observed_at, legacy_row_count, ledger_row_count, legacy_checksum, ledger_checksum, matched, detail)
    VALUES (${domain}, ${observedAt.toISOString()}::timestamptz, 1, ${matched ? 1 : 0},
            ${checksum}, ${matched ? checksum : "f".repeat(64)}, ${matched}, '{}'::jsonb)`;
}

const RAW_SOURCE = "cutover-dto-provenance";
const DOMAINS: ParityDomain[] = ["raw_indicator_history", "regime_snapshots", "research_signals", "swarm_briefs"];
const TEST_GATE: CutoverGateConfig = { minWindowMs: 60_000, minObservations: 3, maxStalenessMs: 30_000 };

/**
 * AC2's "exits zero"/"nonzero exit" and "prevents ledger-mode startup", both
 * asserted against the real things rather than restated from the in-process
 * `{ok, reasons}` object:
 *
 *  - the GATE CLI's actual return code (backend/scripts/analytics-ledger-
 *    cutover-gate.ts, the command an operator or a deploy step runs), including
 *    `--switch ledger`, which is the one that would arm production; and
 *  - setAnalyticsReadMode('ledger'), which is what ledger-mode reads are
 *    gated on — it must REFUSE, and the stored mode must still be
 *    'compatibility' afterwards.
 *
 * TEST_GATE_ENV (set at module load) is what defaultCutoverGateConfig() reads,
 * so the CLI evaluates the same window these tests seed for.
 */
async function expectLedgerModeRefused(): Promise<void> {
  expect(await runCutoverGateCli([]), "the gate CLI must exit NONZERO for a window that does not pass").toBe(1);
  expect(await runCutoverGateCli(["--switch", "ledger"]), "`--switch ledger` must exit nonzero and arm nothing").toBe(1);
  await expect(setAnalyticsReadMode("ledger", "test")).rejects.toBeInstanceOf(CutoverGateNotPassedError);
  expect(await getAnalyticsReadMode(), "a refused cutover must leave the read model on compatibility").toBe("compatibility");
}

async function seedPassingWindow(now: Date): Promise<void> {
  for (const domain of DOMAINS) {
    await insertObservation(domain, new Date(now.getTime() - 60_000), true);
    await insertObservation(domain, new Date(now.getTime() - 30_000), true);
    await insertObservation(domain, now, true);
  }
}

describe("issue #979 AC2: the cutover gate's observation window", () => {
  test("exits ok=true ONLY for a fully matching window spanning the configured minimum duration and count", async () => {
    const now = new Date();
    await seedPassingWindow(now);
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);

    // The "exits zero" half, against the real CLI's real return code — and
    // ONLY here, because every other test in this describe asserts the
    // nonzero counterpart for its own single defect.
    expect(await runCutoverGateCli([]), "a fully matching window must exit ZERO").toBe(0);
    await setAnalyticsReadMode("ledger", "test");
    expect(await getAnalyticsReadMode()).toBe("ledger");
  });

  test("a single checksum mismatch produces a nonzero (failing) gate result and blocks ledger-mode startup", async () => {
    const now = new Date();
    await seedPassingWindow(now);
    await insertObservation("regime_snapshots", now, false); // one mismatch
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('checksum mismatch: "regime_snapshots"'))).toBe(true);
    await expectLedgerModeRefused();
  });

  test("a missing domain produces a nonzero gate result and blocks ledger-mode startup", async () => {
    const now = new Date();
    for (const domain of DOMAINS) {
      if (domain === "research_signals") continue; // never observed
      await insertObservation(domain, new Date(now.getTime() - 60_000), true);
      await insertObservation(domain, now, true);
    }
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('missing domain: no parity observations recorded for "research_signals"'))).toBe(true);
    await expectLedgerModeRefused();
  });

  test("a stale result (no recent observation) produces a nonzero gate result and blocks ledger-mode startup", async () => {
    const now = new Date();
    await seedPassingWindow(new Date(now.getTime() - 10 * 60_000)); // all far in the past
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("stale result:"))).toBe(true);
    await expectLedgerModeRefused();
  });

  test("insufficient duration produces a nonzero gate result and blocks ledger-mode startup", async () => {
    const now = new Date();
    for (const domain of DOMAINS) {
      // Three observations, but all within one second — well under the
      // configured 60s minimum window.
      await insertObservation(domain, new Date(now.getTime() - 500), true);
      await insertObservation(domain, new Date(now.getTime() - 250), true);
      await insertObservation(domain, now, true);
    }
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("insufficient duration:"))).toBe(true);
    await expectLedgerModeRefused();
  });

  test("insufficient count produces a nonzero gate result and blocks ledger-mode startup", async () => {
    const now = new Date();
    for (const domain of DOMAINS) {
      // Spans the window but only TWO observations, below the minimum of 3.
      await insertObservation(domain, new Date(now.getTime() - 60_000), true);
      await insertObservation(domain, now, true);
    }
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("insufficient count:"))).toBe(true);
    await expectLedgerModeRefused();
  });
});

describe("issue #979 AC3/AC4: current-read consumer equivalence and non-destructive rollback", () => {
  test("dashboard, admin, raw-history, swarm-brief, and regime-summary reads return identical DTOs in both modes, and rollback restores the legacy fixture with zero ledger drift", async () => {
    prodAuth();
    const indicator = INDICATORS[0]!.id;
    const signalKey = "channel-divergence";
    const date = "2024-05-01";

    // The SAME real, non-default provenance label on both writes: into the
    // ledger at acquisition time (source_value_versions.provenance) and onto
    // the legacy current row (raw_indicator_history.source). Both sides of the
    // `source` comparison below are therefore genuinely populated, and with a
    // value neither writer would produce by default.
    await submitRawHistoryPoint(indicator, date, 3.25, RAW_SOURCE);
    await submitRegimeAndResearch(date, 55, signalKey, "cutover-dto-check");
    await sql`UPDATE raw_indicator_history SET source = ${RAW_SOURCE} WHERE indicator = ${indicator}`;

    const subjectId = `cutover-subject-${crypto.randomUUID()}`;
    await ensureSubject(subjectId, "Cutover DTO Subject");
    const session = await openSession(subjectId);
    await publishBrief(session.id, 60);

    // ── snapshot every consumer's DTO in COMPATIBILITY mode ──────────────────
    expect(await getAnalyticsReadMode()).toBe("compatibility");
    const compatRegime = await getRegimeSnapshots(new URL("http://x?range=10"));
    const compatSummary = await getRegimeSnapshotsSummary();
    const compatSignal = await getResearchSignal(signalKey);
    const compatRawSeries = (await callAdmin(adminReq(`/api/admin/research/raw-series/${indicator}`)))!.body as {
      points: { date: string; value: number; source: string | null }[];
    };
    const compatSignalSeries = (await callAdmin(adminReq(`/api/admin/research/signals/${signalKey}`)))!.body as {
      points: { date: string; payload: unknown }[];
    };
    const compatBrief = await getBriefBySession(session.id);

    // NON-VACUITY. Every assertion below is an equality between two reads, and
    // `toEqual` is happiest of all when both sides are empty — an upstream
    // write that silently persisted nothing would make this whole test pass
    // while proving nothing at all. So require each fixture to be genuinely
    // populated FIRST, before any comparison is trusted.
    expect(compatRegime.latest, "the regime fixture must be non-empty").not.toBeNull();
    expect(compatRegime.history.length, "the regime history fixture must be non-empty").toBeGreaterThan(0);
    expect(compatSummary.summary, "the regime summary fixture must be non-empty").not.toBeNull();
    expect(compatSignal, "the research signal fixture must be non-empty").not.toBeNull();
    expect(compatRawSeries.points.length, "the admin raw-series fixture must be non-empty").toBeGreaterThan(0);
    expect(compatSignalSeries.points.length, "the admin signal-series fixture must be non-empty").toBeGreaterThan(0);
    expect(compatBrief, "the swarm brief fixture must be non-empty").not.toBeNull();

    // Ledger tables' own row counts + checksums, recorded before cutover so
    // AC4's "byte-for-byte unchanged by rollback" is checkable at the end.
    const ledgerTablesBefore = await snapshotLedgerTables();

    // Arm the gate for real, then cut over.
    const now = new Date();
    await seedPassingWindow(now);
    await setAnalyticsReadMode("ledger", "test");
    expect(await getAnalyticsReadMode()).toBe("ledger");

    const ledgerRegime = await getRegimeSnapshots(new URL("http://x?range=10"));
    const ledgerSummary = await getRegimeSnapshotsSummary();
    const ledgerSignal = await getResearchSignal(signalKey);
    const ledgerRawSeries = (await callAdmin(adminReq(`/api/admin/research/raw-series/${indicator}`)))!.body as {
      points: { date: string; value: number; source: string | null }[];
    };
    const ledgerSignalSeries = (await callAdmin(adminReq(`/api/admin/research/signals/${signalKey}`)))!.body as {
      points: { date: string; payload: unknown }[];
    };
    const ledgerBrief = await getBriefBySession(session.id);

    expect(ledgerRegime).toEqual(compatRegime);
    expect(ledgerSummary).toEqual(compatSummary);
    expect(ledgerSignal).toEqual(compatSignal);
    expect(ledgerSignalSeries).toEqual(compatSignalSeries);
    expect(ledgerBrief).toEqual(compatBrief);
    // raw-history's `source` now has a real ledger equivalent:
    // source_value_versions.provenance (migration 0061), written at
    // acquisition time and read back by cutover/ledger-current.ts. For a row
    // written from 0061 onward the two DTOs agree field for field — asserted
    // here with a whole-object toEqual, not a field-excluded comparison.
    //
    // NON-VACUITY FOR THIS FIELD SPECIFICALLY. `toEqual` would be satisfied by
    // null on both sides, which is exactly the bug this closes. So require the
    // shared value to be the real, non-null, non-default label the fixture
    // wrote, on BOTH sides, before trusting the equality above it.
    expect(ledgerRawSeries).toEqual(compatRawSeries);
    expect(compatRawSeries.points.every((p) => p.source === RAW_SOURCE), "the legacy fixture must carry real provenance").toBe(true);
    expect(
      ledgerRawSeries.points.every((p) => p.source === RAW_SOURCE),
      "ledger mode must carry the SAME real provenance, not null and not a fabricated default",
    ).toBe(true);

    // ── AC4: rollback to compatibility, non-destructively ────────────────────
    //
    // "reads use the legacy fixture again" needs the two models to be
    // DISTINGUISHABLE first. Everything above just proved they agree, so a
    // post-rollback `toEqual(compatRegime)` would pass whichever one answered
    // and prove nothing. Drift the LEGACY table alone, out of band, to a
    // sentinel the ledger cannot know about: ledger mode must keep returning
    // the frozen value, and rollback must return the drifted one.
    const DRIFT = 424243;
    await sql`UPDATE regime_snapshots SET composite = ${DRIFT} WHERE date = ${date}`;
    const stillLedger = await getRegimeSnapshots(new URL("http://x?range=10"));
    expect(JSON.stringify(stillLedger), "ledger mode must ignore a legacy-table edit").not.toContain(String(DRIFT));
    expect(stillLedger).toEqual(compatRegime);

    await setAnalyticsReadMode("compatibility", "test");
    expect(await getAnalyticsReadMode()).toBe("compatibility");
    const driftedRegime = await getRegimeSnapshots(new URL("http://x?range=10"));
    expect(JSON.stringify(driftedRegime), "after rollback the LEGACY table is what answers").toContain(String(DRIFT));

    // Put the legacy fixture back and confirm the original DTO returns — the
    // AC's literal "reads use the legacy fixture again".
    await sql`UPDATE regime_snapshots SET composite = 55 WHERE date = ${date}`;
    const revertedRegime = await getRegimeSnapshots(new URL("http://x?range=10"));
    const revertedBrief = await getBriefBySession(session.id);
    expect(revertedRegime).toEqual(compatRegime);
    expect(revertedBrief).toEqual(compatBrief);

    // And none of that — cutover, the out-of-band legacy edit, or the
    // rollback — moved a single byte in any ledger table.
    const ledgerTablesAfter = await snapshotLedgerTables();
    expect(ledgerTablesAfter).toEqual(ledgerTablesBefore);
  });

  // The documented LIMIT of the parity above, asserted rather than described.
  // AC3's `source` agreement holds for rows written from migration 0061
  // onward. For rows written before it — migration 0057's legacy baselines,
  // and any acquisition submitted without a provenance label — the ledger
  // carries NULL while the COMPATIBILITY table still carries the real
  // 'live'/'seed' label raw_indicator_history.source has held since migration
  // 0024. So those rows genuinely READ DIFFERENTLY in the two modes, and they
  // always will: the append-only trigger refuses the UPDATE that would
  // backfill them. That is the accepted cost of arming the cutover (product
  // owner, 2026-09-17), not a defect to route around, and this test pins the
  // divergence itself rather than a comfortable claim that there is none.
  test("a row written without provenance reads NULL in ledger mode and its real legacy label in compatibility mode, and the append-only ledger refuses to backfill it", async () => {
    prodAuth();
    // A real registry id: the admin raw-series route only serves allowlisted
    // indicators, and this test has to read the DTO through that route in both
    // modes rather than assert on the tables behind it.
    const indicator = INDICATORS[0]!.id;
    const date = "2024-08-01";
    await submitRawHistoryPoint(indicator, date, 7.5); // no provenance: the pre-0061 shape

    const [row] = (await sql`
      SELECT id, provenance FROM source_value_versions
      WHERE source_key = ${`raw_indicator_history:${indicator}`}`) as unknown as { id: string; provenance: string | null }[];
    expect(row, "the unlabelled acquisition really reached the ledger").toBeDefined();
    expect(row!.provenance, "no label observed means NULL, never a fabricated default").toBeNull();

    // ── the divergence, through the SAME admin route in both modes ──────────
    expect(await getAnalyticsReadMode()).toBe("compatibility");
    const compatSeries = (await callAdmin(adminReq(`/api/admin/research/raw-series/${indicator}`)))!.body as {
      points: { date: string; value: number; source: string | null }[];
    };
    expect(compatSeries.points.length, "the compatibility fixture must be non-empty").toBeGreaterThan(0);
    expect(
      compatSeries.points.every((p) => p.source === "live"),
      "compatibility mode returns the legacy column's real default label, NOT null",
    ).toBe(true);

    await seedPassingWindow(new Date());
    await setAnalyticsReadMode("ledger", "test");
    const ledgerSeries = (await callAdmin(adminReq(`/api/admin/research/raw-series/${indicator}`)))!.body as {
      points: { date: string; value: number; source: string | null }[];
    };
    expect(ledgerSeries.points.length, "ledger mode must return the same points").toBe(compatSeries.points.length);
    expect(ledgerSeries.points.every((p) => p.source === null), "ledger mode has no label to return").toBe(true);
    // Stated as the inequality it is: everything but `source` agrees, and
    // `source` does not. An equality here would be the false claim the
    // amendment used to make.
    expect(ledgerSeries).not.toEqual(compatSeries);
    expect(ledgerSeries.points.map((p) => ({ date: p.date, value: p.value })))
      .toEqual(compatSeries.points.map((p) => ({ date: p.date, value: p.value })));
    await setAnalyticsReadMode("compatibility", "test");

    // Migration 0057's own backfill is the other NULL population: it read
    // raw_indicator_history but had no column to carry `source` into. The
    // template database is migrated against an EMPTY raw_indicator_history
    // (see the AC7 test below), so counting over it as-is would be 0 out of 0
    // — vacuous. Seed a probe the way that AC7 test does, re-running 0057's
    // backfill statement verbatim, so this counts a real population.
    await sql`INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES ('2024-01-02', 'PROVENANCE_BASELINE_PROBE', 2, 'seed')`;
    await sql.unsafe(`
      INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
      SELECT 'raw_indicator_history:' || indicator, date, value, 'legacy_baseline', statement_timestamp()
      FROM raw_indicator_history WHERE indicator = 'PROVENANCE_BASELINE_PROBE'
      ON CONFLICT DO NOTHING`);
    const [{ n: baselines }] = (await sql`
      SELECT count(*)::int AS n FROM source_value_versions WHERE revision_kind = 'legacy_baseline'`) as unknown as { n: number }[];
    expect(baselines, "the count below must run over a real population, not an empty one").toBeGreaterThan(0);
    const [{ n: labelledBaselines }] = (await sql`
      SELECT count(*)::int AS n FROM source_value_versions
      WHERE revision_kind = 'legacy_baseline' AND provenance IS NOT NULL`) as unknown as { n: number }[];
    expect(labelledBaselines, "0057's legacy baselines carry no provenance and cannot acquire one").toBe(0);

    // The append-only guarantee is why the two populations above are permanent.
    // Refused BY THE LEDGER TRIGGER, asserted on both the message and 0A000
    // (feature_not_supported) — not merely "some error", which a typo in the
    // statement would also satisfy.
    let raised: { message: string; code: string | null } | null = null;
    try {
      await sql.unsafe(`UPDATE source_value_versions SET provenance = 'backfilled' WHERE id = ${Number(row!.id)}`);
    } catch (e) {
      const err = e as { message?: string; code?: string };
      raised = { message: err?.message ?? String(e), code: err?.code ?? null };
    }
    expect(raised, "backfilling provenance must raise").not.toBeNull();
    expect(raised!.message).toMatch(/^source ledger is immutable: UPDATE is not permitted on source_value_versions/);
    expect(raised!.code).toBe("0A000");
    const [after] = (await sql`
      SELECT provenance FROM source_value_versions WHERE id = ${row!.id}`) as unknown as { provenance: string | null }[];
    expect(after!.provenance, "the refused backfill changed nothing").toBeNull();
  });

  // Issue #979 AC3: the producer's gap catch-up writes the SAME points into
  // both models in one pass — the ledger through captureSourceAcquisition, the
  // compatibility table through seedRawHistory → applyRawFloorSeed →
  // saveRawIndicatorHistory(..., "seed"). Before this fix the capture side
  // took its 'live' default while the floor writer tagged the very same row
  // 'seed', so ledger mode and compatibility mode answered DIFFERENTLY for a
  // row written after 0061 — new data, not accepted history.
  test("a producer catch-up row carries ONE label into both models, so both modes return the same `source` for it", async () => {
    prodAuth();
    const indicator = INDICATORS[0]!.id;
    const date = "2024-09-01";

    // The catch-up's real collaborators: the real persistence (so seedRawHistory
    // really runs applyRawFloorSeed and the acquisition really reaches the
    // ledger) and a source that captures through the real
    // captureSourceAcquisition, forwarding `opts.provenance` exactly as
    // extract/sources.ts's fetchAll does. What is under test is the LABEL the
    // producer chooses and carries, not the registry fetch itself.
    const source: AnalyticsDataSource = {
      fetchIndicators: (_indicators, _logger, acquisitionSink, requestedByRunId, opts) =>
        captureSourceAcquisition<Record<string, { date: string; value: number }[]>>(
          {
            provider: "fixture",
            sourceKey: `raw_indicator_history:${indicator}`,
            parserVersion: "fixture:1",
            cacheIdentity: "catchup",
            requestedByRunId: requestedByRunId ?? null,
            provenance: opts?.provenance,
            points: (r) => r[indicator]!,
          },
          acquisitionSink!,
          async () => ({ [indicator]: [{ date, value: 6.5 }] }),
        ),
      fetchResearchInputs: () => { throw new Error("catch-up must never fetch research inputs"); },
      fetchBacktestExtras: () => { throw new Error("catch-up must never fetch backtest extras"); },
    };

    const filled = await catchUpMissedIndicatorDays({
      // Only the gap LIST is stubbed — it is this catch-up's input, not its
      // behaviour. Every write below goes through the real store path.
      persistence: { ...directAnalyticsPersistence, loadRawHistoryGapDates: async () => [date] },
      source,
      now: () => new Date("2024-09-05T00:00:00Z"),
      beat: async () => {},
    });
    expect(filled, "the catch-up must have run for the missing day").toEqual([date]);

    // Both sides really wrote, and they wrote the SAME label — the producer's
    // one constant, not two literals that happen to match today.
    const [legacyRow] = (await sql`
      SELECT source FROM raw_indicator_history WHERE indicator = ${indicator} AND date = ${date}`) as unknown as { source: string | null }[];
    expect(legacyRow, "the catch-up must have filled the compatibility table").toBeDefined();
    expect(legacyRow!.source).toBe(CATCH_UP_PROVENANCE);
    const [ledgerRow] = (await sql`
      SELECT provenance FROM source_value_versions WHERE source_key = ${`raw_indicator_history:${indicator}`}`) as unknown as { provenance: string | null }[];
    expect(ledgerRow, "the catch-up must have reached the ledger").toBeDefined();
    expect(ledgerRow!.provenance, "the ledger must record the catch-up's label, not the 'live' capture default").toBe(CATCH_UP_PROVENANCE);

    // And the consumer-visible proof: the same admin DTO in both modes.
    expect(await getAnalyticsReadMode()).toBe("compatibility");
    const compatSeries = (await callAdmin(adminReq(`/api/admin/research/raw-series/${indicator}`)))!.body as {
      points: { date: string; value: number; source: string | null }[];
    };
    expect(compatSeries.points.length, "the compatibility fixture must be non-empty").toBeGreaterThan(0);
    await seedPassingWindow(new Date());
    await setAnalyticsReadMode("ledger", "test");
    const ledgerSeries = (await callAdmin(adminReq(`/api/admin/research/raw-series/${indicator}`)))!.body as {
      points: { date: string; value: number; source: string | null }[];
    };
    expect(ledgerSeries).toEqual(compatSeries);
    // Non-vacuity for this field: null on both sides would satisfy the
    // equality above and is exactly the bug it is meant to exclude.
    expect(compatSeries.points.every((p) => p.source === CATCH_UP_PROVENANCE)).toBe(true);
    expect(ledgerSeries.points.every((p) => p.source === CATCH_UP_PROVENANCE)).toBe(true);
    await setAnalyticsReadMode("compatibility", "test");

    // The cutover gate agrees: `source` is compared for this post-0061 row and
    // matches. Before the fix this same sweep reported matched:false.
    const parity = await checkRawIndicatorHistoryParity();
    expect(parity.mismatches, JSON.stringify(parity.mismatches)).toEqual([]);
    expect(parity.matched).toBe(true);
  });
});

// Row count + a content checksum for every Phase A ledger table — the AC4/AC9
// "byte-for-byte unchanged by rollback" proof. A checksum over the WHOLE
// table's content (not merely COUNT(*)) so a rollback that somehow rewrote
// rows without changing the count would still be caught.
const LEDGER_TABLES = [
  "source_acquisitions", "source_acquisition_events", "source_payloads", "source_fetches", "source_value_versions",
  "analytics_ledger_methodology_versions", "analytics_ledger_runs", "analytics_ledger_run_events",
  "analytics_data_vintages", "analytics_vintage_members",
  "analytics_output_snapshots", "analytics_report_snapshots", "swarm_brief_revisions",
] as const;

async function snapshotLedgerTables(): Promise<Record<string, { count: number; checksum: string }>> {
  const out: Record<string, { count: number; checksum: string }> = {};
  for (const table of LEDGER_TABLES) {
    const rows = (await sql.unsafe(`SELECT * FROM ${table} ORDER BY 1`)) as unknown as Record<string, unknown>[];
    out[table] = { count: rows.length, checksum: sha256Hex(canonicalStringify(rows)) };
  }
  return out;
}

// The AC9 migration-boundary test below builds its own throwaway Postgres —
// the only place a PRE-migration legacy snapshot can be taken (see its own
// comment).
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

// Legacy-table row counts + primary-key checksums — issue #979 AC9.
const LEGACY_TABLES: { table: string; pk: string }[] = [
  { table: "raw_indicator_history", pk: "indicator, date" },
  { table: "regime_snapshots", pk: "date" },
  { table: "research_signals", pk: "signal_key, date" },
];

async function snapshotLegacyTables(): Promise<Record<string, { count: number; checksum: string }>> {
  const out: Record<string, { count: number; checksum: string }> = {};
  for (const { table, pk } of LEGACY_TABLES) {
    const rows = (await sql.unsafe(`SELECT ${pk} FROM ${table} ORDER BY ${pk}`)) as unknown as Record<string, unknown>[];
    out[table] = { count: rows.length, checksum: sha256Hex(canonicalStringify(rows)) };
  }
  return out;
}

describe("issue #979 AC9: legacy row counts and PK checksums survive cutover and rollback unchanged", () => {
  test("recording legacy state, cutting over, and rolling back leaves it byte-for-byte identical", async () => {
    prodAuth();
    await submitRawHistoryPoint("AC9_IND", "2024-06-01", 9.5);
    await submitRegimeAndResearch("2024-06-01", 60, "late-cycle-signals", "ac9-check");

    const before = await snapshotLegacyTables();

    const now = new Date();
    await seedPassingWindow(now);
    await setAnalyticsReadMode("ledger", "test");
    const duringLedgerMode = await snapshotLegacyTables();
    await setAnalyticsReadMode("compatibility", "test");
    const after = await snapshotLegacyTables();

    expect(duringLedgerMode).toEqual(before);
    expect(after).toEqual(before);
  });

  // The "before MIGRATION" half of AC9, which the cutover test above cannot
  // reach: this file's databases are clones of an already-fully-migrated
  // template (tests/preload.ts), so by the time any test in it runs, 0057-0060
  // have long since been applied and there is no pre-migration state left to
  // snapshot. The only honest way to record legacy state BEFORE the Phase A
  // migrations is to stop short of them in a database of this test's own —
  // same harness shape as tests/source-ledger-migration.test.ts, which proves
  // 0057's backfill against a real, populated legacy table for the same reason.
  test("legacy row counts and PK checksums are identical before and after migrations 0057-0061 are applied for real", async () => {
    const port = await freePort();
    const container = `rmtest_ac9_migration_${crypto.randomUUID().slice(0, 8)}`;
    const up = Bun.spawnSync([
      "docker", "run", "-d", "--rm", "--name", container,
      "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
      "-p", `${port}:5432`, POSTGRES_IMAGE,
    ]);
    // Loud, never a silent skip: without Docker there is no migration boundary
    // to test, and that is a broken runner, not a passing test.
    if (up.exitCode !== 0) throw new Error(`AC9 migration-boundary test requires Docker+Postgres:\n${up.stderr.toString()}`);
    const db = postgres(`postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`, { max: 1, onnotice: () => {} });
    try {
      const started = Date.now();
      for (;;) {
        try { await db`SELECT 1`; break; }
        catch (error) { if (Date.now() - started > 30_000) throw error; await Bun.sleep(200); }
      }
      await db`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      const apply = async (file: string) => {
        await db.begin(async (tx) => {
          if (file >= "0054_rm_worker_allowlist.sql") await tx.unsafe("SET LOCAL ROLE rm_owner");
          await tx.unsafe(await readFile(join(migrationsDir, file), "utf8"));
          await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
        });
      };

      const PHASE_A = ["0057_source_acquisition_ledger.sql", "0058_analytics_run_ledger.sql",
        "0059_analytics_output_and_report_snapshots.sql", "0060_analytics_ledger_cutover.sql",
        "0061_source_value_provenance.sql"];
      for (const file of files.filter((f) => f < PHASE_A[0]!)) await apply(file);

      // Real legacy content, so the snapshot below is of something.
      await db`INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES
        ('2020-01-01', 'AC9_LEGACY_A', 1.5, 'legacy'), ('2020-01-02', 'AC9_LEGACY_B', 2.5, NULL)`;
      await db`INSERT INTO regime_snapshots (date, composite, regime) VALUES ('2020-01-01', 11, 'risk_on'), ('2020-01-02', 12, 'risk_off')`;
      await db`INSERT INTO research_signals (signal_key, date, payload) VALUES
        ('ac9-legacy', '2020-01-01', '{"a":1}'::jsonb), ('ac9-legacy', '2020-01-02', '{"a":2}'::jsonb)`;

      const snapshot = async () => {
        const out: Record<string, { count: number; checksum: string }> = {};
        for (const { table, pk } of LEGACY_TABLES) {
          const rows = (await db.unsafe(`SELECT ${pk} FROM ${table} ORDER BY ${pk}`)) as unknown as Record<string, unknown>[];
          out[table] = { count: rows.length, checksum: sha256Hex(canonicalStringify(rows)) };
        }
        return out;
      };

      const beforeMigration = await snapshot();
      for (const { table } of LEGACY_TABLES) {
        expect(beforeMigration[table]!.count, `${table} must be populated before the migration`).toBeGreaterThan(0);
      }
      // 0060 must not even exist yet — otherwise "before migration" is a lie.
      const [pre] = await db`SELECT to_regclass('public.analytics_parity_observations') AS t`;
      expect(pre!.t, "0060's table must not exist before 0060 runs").toBeNull();

      for (const file of PHASE_A) await apply(file);

      const [post] = await db`SELECT to_regclass('public.analytics_parity_observations') AS t`;
      expect(post!.t, "0060 really ran").not.toBeNull();
      // 0057's backfill really read the legacy rows — so this is a migration
      // that TOUCHED that data, not one that ignored it.
      const [{ n: baselines }] = (await db`SELECT count(*)::int AS n FROM source_value_versions WHERE revision_kind = 'legacy_baseline'`) as unknown as { n: number }[];
      expect(baselines, "0057 backfilled a legacy baseline per legacy raw row").toBe(2);

      expect(await snapshot(), "no Phase A migration may alter a legacy table").toEqual(beforeMigration);
    } finally {
      await db.end({ timeout: 5 }).catch(() => {});
      Bun.spawnSync(["docker", "rm", "-f", "-v", container]);
    }
  }, 180_000);
});

describe("issue #979 AC7: legacy-baseline source rows are never upgraded to historically reproducible", () => {
  test("every migration-time backfill row is legacy_baseline with no acquisition (not historically reproducible)", async () => {
    // The template database this file clones from is migrated against an
    // EMPTY raw_indicator_history, so migration 0057's own backfill produced
    // zero rows here — re-running its exact backfill statement (copied
    // verbatim from backend/migrations/0057_source_acquisition_ledger.sql)
    // against a seeded row makes this a real, non-vacuous check of what that
    // statement actually does, not merely an assertion over an empty set.
    await sql`INSERT INTO raw_indicator_history (date, indicator, value, source) VALUES ('2024-01-01', 'AC7_BACKFILL_PROBE', 1, 'seed')`;
    await sql.unsafe(`
      INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
      SELECT 'raw_indicator_history:' || indicator, date, value, 'legacy_baseline', statement_timestamp()
      FROM raw_indicator_history
      ON CONFLICT DO NOTHING`);

    const rows = (await sql`
      SELECT revision_kind, acquisition_id FROM source_value_versions WHERE revision_kind = 'legacy_baseline'
    `) as unknown as { revision_kind: string; acquisition_id: string | null }[];
    expect(rows.length, "the backfill must have produced at least the seeded probe row").toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.acquisition_id, "a legacy_baseline row must have NO acquisition — that is what 'not reproducible' means").toBeNull();
    }
  });

  test("the schema itself refuses a row that claims BOTH legacy_baseline and a real acquisition — no code path could 'upgrade' one in place", async () => {
    const acquisitionId = crypto.randomUUID();
    await sql`INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity) VALUES (${acquisitionId}, 'fixture', '1', 'ac7-check')`;
    let raised: { message?: string; code?: string } | null = null;
    try {
      await sql`
        INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind)
        VALUES (${acquisitionId}::uuid, 'ac7:test', '2024-01-01', 1, 'legacy_baseline')`;
    } catch (e) {
      raised = e as { message?: string; code?: string };
    }
    expect(raised, "legacy_baseline + a real acquisition_id must be rejected by the CHECK constraint").not.toBeNull();
    expect(raised!.code).toBe("23514"); // check_violation
  });

  test("a real revision for a key that has a legacy_baseline predecessor is never recorded as another legacy_baseline, and the baseline is not rewritten", async () => {
    prodAuth();
    // The predecessor has to actually EXIST, or the writer takes its
    // `no prior version` branch and this proves nothing about the
    // legacy-baseline path. Seed one exactly as migration 0057's backfill
    // does: no acquisition, revision_kind 'legacy_baseline'.
    await sql`
      INSERT INTO source_value_versions (source_key, market_date, value, revision_kind, knowledge_time)
      VALUES ('raw_indicator_history:AC7_REAL_IND', '2024-07-01', 10, 'legacy_baseline', now())`;

    await submitRawHistoryPoint("AC7_REAL_IND", "2024-07-01", 11);

    const rows = (await sql`
      SELECT revision_kind, value, acquisition_id FROM source_value_versions
      WHERE source_key = 'raw_indicator_history:AC7_REAL_IND' ORDER BY id
    `) as unknown as { revision_kind: string; value: string; acquisition_id: string | null }[];
    // Append, never upgrade-in-place: the baseline row survives untouched and
    // the real observation is a SECOND row with a real acquisition.
    expect(rows.length, "the real write must APPEND beside the baseline, not replace it").toBe(2);
    expect(rows[0]!.revision_kind).toBe("legacy_baseline");
    expect(rows[0]!.acquisition_id, "the baseline must still be un-attributed after the real write").toBeNull();
    expect(Number(rows[0]!.value), "the baseline's value must not have been rewritten").toBe(10);
    expect(rows[1]!.revision_kind, "the real observation is never another legacy_baseline").not.toBe("legacy_baseline");
    expect(rows[1]!.acquisition_id, "the real observation carries a real acquisition").not.toBeNull();
  });

  test("no projection or admin read exposes a legacy_baseline row as historically reproducible", async () => {
    prodAuth();
    await submitRawHistoryPoint("AC7_PROJ_IND", "2024-07-02", 4);
    const res = await callAdmin(adminReq(`/api/admin/research/raw-series/AC7_PROJ_IND`));
    // AC7_PROJ_IND is not on the admin allowlist (only real registry
    // indicators + MNA are), so this is exercised through the allowlisted
    // path instead: the point is that the response body never carries a
    // "historically reproducible" claim of any kind — there is no such field
    // in this or any other analytics DTO in this repo.
    expect(res!.status).toBe(400);
    const allowlisted = await callAdmin(adminReq(`/api/admin/research/raw-series/${INDICATORS[0]!.id}`));
    expect(JSON.stringify(allowlisted!.body)).not.toContain("historically_reproducible");
    expect(JSON.stringify(allowlisted!.body)).not.toContain("historicalReproducible");
  });
});
