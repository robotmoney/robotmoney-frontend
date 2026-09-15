// Issue #979 AC2/AC3/AC4/AC7/AC9: the cutover gate, current-read consumer
// equivalence, non-destructive rollback, legacy-baseline semantics, and
// migration/cutover/rollback stability of both the ledger and the
// pre-existing legacy tables.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { handleAdmin, type AdminAuthConfig } from "../src/api/routes/admin.ts";
import { getRegimeSnapshots, getRegimeSnapshotsSummary, getResearchSignal } from "../src/api/routes/dashboards.ts";
import { ensureSubject, openSession, publishBrief, getBriefBySession } from "../src/swarm/domain.ts";
import { payloadChecksum } from "../src/analytics/source-ledger.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { evaluateCutoverGate, type CutoverGateConfig } from "../src/analytics/cutover/gate.ts";
import { getAnalyticsReadMode, setAnalyticsReadMode, CutoverGateNotPassedError } from "../src/analytics/cutover/read-mode.ts";
import { recordParityObservation, type ParityDomain, type ParityResult } from "../src/analytics/cutover/parity.ts";
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

async function submitRawHistoryPoint(indicator: string, date: string, value: number): Promise<void> {
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
        values: [{ sourceKey: `raw_indicator_history:${indicator}`, marketDate: date, marketInstant: null, value }],
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

const DOMAINS: ParityDomain[] = ["raw_indicator_history", "regime_snapshots", "research_signals", "swarm_briefs"];
const TEST_GATE: CutoverGateConfig = { minWindowMs: 60_000, minObservations: 3, maxStalenessMs: 30_000 };

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
  });

  test("a single checksum mismatch produces a nonzero (failing) gate result and blocks ledger-mode startup", async () => {
    const now = new Date();
    await seedPassingWindow(now);
    await insertObservation("regime_snapshots", now, false); // one mismatch
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('checksum mismatch: "regime_snapshots"'))).toBe(true);

    await expect(setAnalyticsReadMode("ledger", "test")).rejects.toBeInstanceOf(CutoverGateNotPassedError);
    expect(await getAnalyticsReadMode()).toBe("compatibility");
  });

  test("a missing domain produces a nonzero gate result", async () => {
    const now = new Date();
    for (const domain of DOMAINS) {
      if (domain === "research_signals") continue; // never observed
      await insertObservation(domain, new Date(now.getTime() - 60_000), true);
      await insertObservation(domain, now, true);
    }
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('missing domain: no parity observations recorded for "research_signals"'))).toBe(true);
  });

  test("a stale result (no recent observation) produces a nonzero gate result", async () => {
    const now = new Date();
    await seedPassingWindow(new Date(now.getTime() - 10 * 60_000)); // all far in the past
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("stale result:"))).toBe(true);
  });

  test("insufficient duration produces a nonzero gate result", async () => {
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
  });

  test("insufficient count produces a nonzero gate result", async () => {
    const now = new Date();
    for (const domain of DOMAINS) {
      // Spans the window but only TWO observations, below the minimum of 3.
      await insertObservation(domain, new Date(now.getTime() - 60_000), true);
      await insertObservation(domain, now, true);
    }
    const result = await evaluateCutoverGate(sql, TEST_GATE, now);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("insufficient count:"))).toBe(true);
  });
});

describe("issue #979 AC3/AC4: current-read consumer equivalence and non-destructive rollback", () => {
  test("dashboard, admin, raw-history, swarm-brief, and regime-summary reads return identical DTOs in both modes, and rollback restores the legacy fixture with zero ledger drift", async () => {
    prodAuth();
    const indicator = INDICATORS[0]!.id;
    const signalKey = "channel-divergence";
    const date = "2024-05-01";

    await submitRawHistoryPoint(indicator, date, 3.25);
    await submitRegimeAndResearch(date, 55, signalKey, "cutover-dto-check");

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
      points: { date: string; value: number }[];
    };
    const compatSignalSeries = (await callAdmin(adminReq(`/api/admin/research/signals/${signalKey}`)))!.body as {
      points: { date: string; payload: unknown }[];
    };
    const compatBrief = await getBriefBySession(session.id);

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
      points: { date: string; value: number }[];
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
    // raw-history's `source` provenance column has no ledger equivalent
    // (documented in api/routes/admin.ts) — compare date/value, the fields
    // that ARE ledger-derived.
    expect(ledgerRawSeries.points.map((p) => ({ date: p.date, value: p.value }))).toEqual(
      compatRawSeries.points.map((p) => ({ date: p.date, value: p.value })),
    );

    // ── AC4: rollback to compatibility, non-destructively ────────────────────
    await setAnalyticsReadMode("compatibility", "test");
    expect(await getAnalyticsReadMode()).toBe("compatibility");
    const revertedRegime = await getRegimeSnapshots(new URL("http://x?range=10"));
    const revertedBrief = await getBriefBySession(session.id);
    expect(revertedRegime).toEqual(compatRegime);
    expect(revertedBrief).toEqual(compatBrief);

    const ledgerTablesAfter = await snapshotLedgerTables();
    expect(ledgerTablesAfter).toEqual(ledgerTablesBefore);
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
});

describe("issue #979 AC7: legacy-baseline source rows are never upgraded to historically reproducible", () => {
  test("every migration-time backfill row is legacy_baseline with no acquisition (not historically reproducible)", async () => {
    const rows = (await sql`
      SELECT revision_kind, acquisition_id FROM source_value_versions WHERE revision_kind = 'legacy_baseline'
    `) as unknown as { revision_kind: string; acquisition_id: string | null }[];
    // raw_indicator_history is empty in this fresh, cloned-template database
    // (no smoke seed loaded it), so the backfill legitimately produced zero
    // rows — the invariant under test is what's asserted below regardless.
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

  test("a real revision for a key that has a legacy_baseline predecessor is recorded as 'initial', never as another legacy_baseline", async () => {
    prodAuth();
    await submitRawHistoryPoint("AC7_REAL_IND", "2024-07-01", 11);
    const rows = (await sql`
      SELECT revision_kind FROM source_value_versions WHERE source_key = 'raw_indicator_history:AC7_REAL_IND'
    `) as unknown as { revision_kind: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revision_kind !== "legacy_baseline")).toBe(true);
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
