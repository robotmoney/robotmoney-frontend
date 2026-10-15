// Issue 1375: the parity sweep's set-based SQL (src/analytics/cutover/parity.ts)
// reaches the same answer as the in-process comparison it replaced
// (tests/support/parity-oracle.ts) on the same database.
//
// For every domain the fixture is first written through the real writers (the
// analytics routes for raw history, regime and research; the brief tables as
// publishBrief writes them), and both checks must say matched. Then each
// mismatch kind is planted on its own: a compatibility row the ledger lacks, a
// ledger row the compatibility table lacks, and a value that differs. Plus the
// cases that must NOT mismatch: a value inside the source's tolerance, a value
// equal after rounding at 1e-9, an unsettled day, a pre-0059 brief. For each,
// checkDomainParity's verdict, both row counts, its mismatch count and its
// (capped) mismatching keys and reasons equal the oracle's.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { payloadChecksum } from "../src/analytics/source-ledger.ts";
import { checkDomainParity, MAX_MISMATCH_DETAIL } from "../src/analytics/cutover/parity.ts";
import { ALL_PARITY_DOMAINS, type ParityDomain } from "../src/analytics/cutover/parity-domains.ts";
import { ensureSubject, openSession } from "../src/swarm/domain.ts";
import { oracleDomainParity } from "./support/parity-oracle.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { provisionAnalyticsToken } from "./support/automation-auth.ts";

useCleanDatabasePerTest(import.meta.file);

const A = ROUTES.analytics;
let TOKEN = "";
beforeEach(async () => {
  TOKEN = await provisionAnalyticsToken();
});

async function call(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const r = new Request(`http://x${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const res = await handleAnalytics(r, new URL(r.url));
  return res!;
}

/** One raw point through both real writers: the source ledger, then the compatibility floor. */
async function submitRawPoint(indicator: string, date: string, value: number): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ indicator, date, value }));
  const acq = await call("POST", A.sourceAcquisitions, {
    acquisition: {
      id: crypto.randomUUID(),
      provider: "fixture",
      parserVersion: "fixture:1",
      cacheIdentity: `equivalence-${indicator}`,
      requestedByRunId: null,
      events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }],
      fetches: [{
        id: crypto.randomUUID(),
        sequence: 1,
        requestIdentity: { method: "GET", url: "https://example.invalid/data", headers: {} },
        cacheStatus: "disabled",
        responseStatus: 200,
        responseChecksum: payloadChecksum(bytes),
        payloadBase64: Buffer.from(bytes).toString("base64"),
        providerReleaseId: null,
        errorDetail: null,
      }],
      values: [{ sourceKey: `raw_indicator_history:${indicator}`, marketDate: date, marketInstant: null, value }],
    },
  });
  expect(acq.status, JSON.stringify(acq.body)).toBe(200);
  const res = await call("POST", A.rawHistory, { history: { [indicator]: [{ date, value }] } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

function regimeRow(date: string, composite: number, regime = "risk_on") {
  return {
    date, composite, compositePercentile: 0.5, regime,
    macroRegime: null, onchainRegime: null, factorRegime: null,
    macroIndex: null, onchainIndex: null, factorIndex: null,
    macroPercentile: null, onchainPercentile: null, factorPercentile: null,
    panelWeights: null, version: "v-test", source: "fixture",
    percentiles: {}, indicators: [], panels: null, bucketThresholds: null,
    backtest: null, correlations: null, extras: null,
  };
}

/** One succeeded run through the real run-package route: artifacts, report snapshot (settles `asof`) and compat rows. */
async function submitRun(
  asof: string,
  regime: ReturnType<typeof regimeRow>[],
  research: { key: string; date: string; payload: unknown }[],
): Promise<void> {
  const begin = await call("POST", A.runs, {
    run: {
      runKey: crypto.randomUUID(), asof, toolId: "equivalence-test", sourceLabel: "fixture",
      methodology: { toolId: "equivalence-test", versionLabel: "v-test", config: { k: "v" } },
      buildIdentity: "equivalence-build",
    },
  });
  expect(begin.status, JSON.stringify(begin.body)).toBe(200);
  const { runId } = begin.body as { runId: string };
  const pkg = await call("POST", A.runPackage, {
    package: {
      runId, asof, status: "succeeded",
      regimeSnapshots: regime,
      researchSignals: research,
      reportBase64: Buffer.from(`report ${runId} ${asof}`, "utf8").toString("base64"),
    },
  });
  expect(pkg.status, JSON.stringify(pkg.body)).toBe(200);
}

function researchPayload(asof: string, title: string) {
  return { asof, title, question: "q", spec: { window: 30, ratio: 1.0 }, gauges: [{ date: asof, value: 0.123456789 }] };
}

const BRIEF_MIGRATION = "0059_analytics_output_and_report_snapshots.sql";

async function briefBoundary(): Promise<Date> {
  const [r] = await fixtureDb<{ applied_at: Date }[]>`SELECT applied_at FROM schema_migrations WHERE name = ${BRIEF_MIGRATION}`;
  return r!.applied_at;
}

/** A brief as publishBrief writes it: the compat row, and (optionally) a canonical-bytes revision. */
async function makeBrief(opts: { createdAt: Date; revisions: unknown[]; body?: unknown }): Promise<string> {
  const tag = crypto.randomUUID().slice(0, 8);
  const subjectId = `equivalence-subject-${tag}`;
  await ensureSubject(subjectId, `Equivalence Subject ${tag}`);
  const session = (await openSession(subjectId)) as { id: string };
  const body = opts.body ?? { note: `brief ${session.id}`, score: 0.5, items: [1, 2.5, "x"] };
  await fixtureDb`
    INSERT INTO swarm_briefs (date, subject_id, body, created_at, session_id)
    VALUES (current_date, ${subjectId}, ${fixtureDb.json(body as never)}, ${opts.createdAt}, ${session.id})`;
  let revision = 0;
  for (const revBody of opts.revisions) {
    const bytes = Buffer.from(JSON.stringify(revBody), "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await fixtureDb`
      INSERT INTO swarm_brief_revisions (session_id, revision, body_bytes, checksum)
      VALUES (${session.id}, ${++revision}, ${bytes}, ${checksum})`;
  }
  return session.id;
}

/** The SQL and the oracle agree on everything the observation records. */
async function expectEquivalent(domain: ParityDomain, label: string): Promise<{ matched: boolean; mismatches: { naturalKey: string; reason: string }[] }> {
  const sqlResult = await checkDomainParity(domain);
  const oracle = await oracleDomainParity(domain);
  expect({ label, domain, sql: {
    matched: sqlResult.matched,
    legacyRowCount: sqlResult.legacyRowCount,
    ledgerRowCount: sqlResult.ledgerRowCount,
    mismatchCount: sqlResult.mismatchCount,
    mismatches: sqlResult.mismatches,
  } }).toEqual({ label, domain, sql: {
    matched: oracle.matched,
    legacyRowCount: oracle.legacyRowCount,
    ledgerRowCount: oracle.ledgerRowCount,
    mismatchCount: oracle.mismatches.length,
    mismatches: oracle.mismatches.slice(0, MAX_MISMATCH_DETAIL),
  } });
  // Both checksums agree exactly when the domain matches.
  expect({ label, checksumsEqual: sqlResult.legacyChecksum === sqlResult.ledgerChecksum }).toEqual({ label, checksumsEqual: sqlResult.matched });
  return { matched: sqlResult.matched, mismatches: sqlResult.mismatches };
}

const MISSING_FROM_LEDGER = "present in compatibility table, missing from ledger";
const MISSING_FROM_COMPAT = "present in ledger, missing from compatibility table";
const DIFFERS = "canonical value differs between compatibility and ledger";

describe("an empty database", () => {
  test("every domain matches with zero rows on both sides, in SQL and in the oracle", async () => {
    for (const domain of ALL_PARITY_DOMAINS) {
      const r = await expectEquivalent(domain, "empty");
      expect(r.matched).toBe(true);
    }
  });
});

describe("raw_indicator_history", () => {
  // DXY is exact (D56); IWF_IWD is a Yahoo ratio with a 5e-6 tolerance.
  async function seed(): Promise<void> {
    await submitRawPoint("DXY", "2026-09-01", 101.25);
    await submitRawPoint("DXY", "2026-09-02", 0.5);
    await submitRawPoint("IWF_IWD", "2026-09-01", 4523.68017578125);
    await submitRawPoint("IWF_IWD", "2026-09-02", 4524.5);
    // A revision: the ledger head moves, and so does the compat row.
    await submitRawPoint("DXY", "2026-09-01", 101.5);
  }

  test("matching rows written by the real writers match", async () => {
    await seed();
    const r = await expectEquivalent("raw_indicator_history", "seeded");
    expect(r.matched).toBe(true);
  });

  test("a compatibility row with no ledger version", async () => {
    await seed();
    await fixtureDb`INSERT INTO raw_indicator_history (indicator, date, value, source) VALUES ('DXY', '2026-09-03', 99, 'live')`;
    const r = await expectEquivalent("raw_indicator_history", "legacy only");
    expect(r.mismatches).toEqual([{ naturalKey: "DXY\u00002026-09-03", reason: MISSING_FROM_LEDGER }]);
  });

  test("a ledger head with no compatibility row", async () => {
    await seed();
    await fixtureDb`DELETE FROM raw_indicator_history WHERE indicator = 'IWF_IWD' AND date = '2026-09-02'`;
    const r = await expectEquivalent("raw_indicator_history", "ledger only");
    expect(r.mismatches).toEqual([{ naturalKey: "IWF_IWD\u00002026-09-02", reason: MISSING_FROM_COMPAT }]);
  });

  test("a value beyond the source's tolerance differs; one inside it, or equal at 1e-9, does not", async () => {
    await seed();
    // Inside the ratio's 5e-6 tolerance: still matched.
    await fixtureDb`UPDATE raw_indicator_history SET value = value * (1 + 1e-7) WHERE indicator = 'IWF_IWD' AND date = '2026-09-01'`;
    // An exact source, off by less than the 1e-9 rounding: still matched.
    await fixtureDb`UPDATE raw_indicator_history SET value = 0.5 + 1e-13 WHERE indicator = 'DXY' AND date = '2026-09-02'`;
    expect((await expectEquivalent("raw_indicator_history", "inside tolerance")).matched).toBe(true);
    // An exact source a relative 1e-7 off: differs.
    await fixtureDb`UPDATE raw_indicator_history SET value = 101.5 * (1 + 1e-7) WHERE indicator = 'DXY' AND date = '2026-09-01'`;
    const r = await expectEquivalent("raw_indicator_history", "beyond tolerance");
    expect(r.mismatches).toEqual([{ naturalKey: "DXY\u00002026-09-01", reason: DIFFERS }]);
  });

  test("more mismatches than one observation carries: the count is whole, the keys are the first twenty", async () => {
    await seed();
    for (let day = 1; day <= MAX_MISMATCH_DETAIL + 5; day++) {
      await fixtureDb`INSERT INTO raw_indicator_history (indicator, date, value) VALUES ('ICSA', ${`2026-08-${String(day).padStart(2, "0")}`}, ${day})`;
    }
    await expectEquivalent("raw_indicator_history", "over the cap");
    const sqlResult = await checkDomainParity("raw_indicator_history");
    expect(sqlResult.mismatchCount).toBe(MAX_MISMATCH_DETAIL + 5);
    expect(sqlResult.mismatches).toHaveLength(MAX_MISMATCH_DETAIL);
  });
});

describe("regime_snapshots and research_signals", () => {
  async function seed(): Promise<void> {
    await submitRun("2026-09-01", [regimeRow("2026-08-31", 0.1), regimeRow("2026-09-01", 0.25)], [
      { key: "channel-divergence", date: "2026-09-01", payload: researchPayload("2026-09-01", "first") },
      { key: "breadth", date: "2026-09-01", payload: researchPayload("2026-09-01", "breadth") },
    ]);
    await submitRun("2026-09-02", [regimeRow("2026-09-01", 0.3, "risk_off"), regimeRow("2026-09-02", 0.4)], [
      { key: "channel-divergence", date: "2026-09-02", payload: researchPayload("2026-09-02", "second") },
    ]);
    // A later run for the same day rewrites it: the newest artifact wins.
    await submitRun("2026-09-02", [regimeRow("2026-09-02", 0.45)], [
      { key: "channel-divergence", date: "2026-09-02", payload: researchPayload("2026-09-02", "second, revised") },
    ]);
  }

  test("rows written by the real run-package route match, newest artifact winning", async () => {
    await seed();
    for (const domain of ["regime_snapshots", "research_signals"] as const) {
      const r = await expectEquivalent(domain, "seeded");
      expect(r.matched).toBe(true);
    }
    const regime = await checkDomainParity("regime_snapshots");
    // 2026-09-01 and 2026-09-02 are settled; 2026-08-31 is not an as-of day.
    expect({ legacy: regime.legacyRowCount, ledger: regime.ledgerRowCount }).toEqual({ legacy: 2, ledger: 2 });
    const research = await checkDomainParity("research_signals");
    expect({ legacy: research.legacyRowCount, ledger: research.ledgerRowCount }).toEqual({ legacy: 3, ledger: 3 });
  });

  test("a settled compatibility row with no ledger element", async () => {
    await seed();
    // 2026-09-03 settles through a run that froze no regime or research for it.
    await submitRun("2026-09-03", [], []);
    await fixtureDb`INSERT INTO regime_snapshots (date, composite, regime) VALUES ('2026-09-03', 0.5, 'risk_on')`;
    await fixtureDb`INSERT INTO research_signals (signal_key, date, payload) VALUES ('breadth', '2026-09-03', ${fixtureDb.json({ x: 1 })})`;
    expect((await expectEquivalent("regime_snapshots", "legacy only")).mismatches).toEqual([{ naturalKey: "2026-09-03", reason: MISSING_FROM_LEDGER }]);
    expect((await expectEquivalent("research_signals", "legacy only")).mismatches).toEqual([{ naturalKey: "breadth 2026-09-03", reason: MISSING_FROM_LEDGER }]);
  });

  test("a ledger element with no compatibility row", async () => {
    await seed();
    // regime_snapshots refuses DELETE (append-only, 0032): the compat row moves
    // to a day no run settled, which neither side compares.
    await fixtureDb`UPDATE regime_snapshots SET date = '2026-07-15' WHERE date = '2026-09-01'`;
    await fixtureDb`DELETE FROM research_signals WHERE signal_key = 'breadth' AND date = '2026-09-01'`;
    expect((await expectEquivalent("regime_snapshots", "ledger only")).mismatches).toEqual([{ naturalKey: "2026-09-01", reason: MISSING_FROM_COMPAT }]);
    expect((await expectEquivalent("research_signals", "ledger only")).mismatches).toEqual([{ naturalKey: "breadth 2026-09-01", reason: MISSING_FROM_COMPAT }]);
  });

  test("a value that differs: an older artifact's value, a changed label, a changed payload, a null payload", async () => {
    await seed();
    // The superseded run's composite for 2026-09-02: the newest artifact says 0.45.
    await fixtureDb`UPDATE regime_snapshots SET composite = 0.4 WHERE date = '2026-09-02'`;
    await fixtureDb`UPDATE regime_snapshots SET regime = 'risk_on' WHERE date = '2026-09-01'`;
    await fixtureDb`UPDATE research_signals SET payload = ${fixtureDb.json(researchPayload("2026-09-02", "second"))} WHERE signal_key = 'channel-divergence' AND date = '2026-09-02'`;
    await fixtureDb`UPDATE research_signals SET payload = NULL WHERE signal_key = 'breadth' AND date = '2026-09-01'`;
    expect((await expectEquivalent("regime_snapshots", "differs")).mismatches).toEqual([
      { naturalKey: "2026-09-01", reason: DIFFERS },
      { naturalKey: "2026-09-02", reason: DIFFERS },
    ]);
    expect((await expectEquivalent("research_signals", "differs")).mismatches).toEqual([
      { naturalKey: "breadth 2026-09-01", reason: DIFFERS },
      { naturalKey: "channel-divergence 2026-09-02", reason: DIFFERS },
    ]);
  });

  test("a composite equal at 1e-9, a payload equal as jsonb, and an unsettled day do not mismatch", async () => {
    await seed();
    await fixtureDb`UPDATE regime_snapshots SET composite = 0.3 + 1e-12 WHERE date = '2026-09-01'`;
    // Key order and 1.0 vs 1 are the same jsonb value, as they are the same canonical JSON.
    await fixtureDb.unsafe(`UPDATE research_signals
        SET payload = '{"gauges":[{"value":0.123456789,"date":"2026-09-01"}],"spec":{"ratio":1.0,"window":30},"question":"q","title":"breadth","asof":"2026-09-01"}'::jsonb
      WHERE signal_key = 'breadth' AND date = '2026-09-01'`);
    // Not an as-of day of any frozen run: compared on neither side.
    await fixtureDb`INSERT INTO regime_snapshots (date, composite, regime) VALUES ('2026-07-01', 9, 'x')`;
    await fixtureDb`INSERT INTO research_signals (signal_key, date, payload) VALUES ('breadth', '2026-07-01', ${fixtureDb.json({ y: 2 })})`;
    for (const domain of ["regime_snapshots", "research_signals"] as const) {
      const r = await expectEquivalent(domain, "no mismatch");
      expect({ domain, mismatches: r.mismatches }).toEqual({ domain, mismatches: [] });
    }
  });
});

describe("swarm_briefs", () => {
  test("ledger-era briefs whose newest revision equals the compat body match; pre-0059 sessions are out of scope on both sides", async () => {
    const boundary = await briefBoundary();
    const body = { note: "same", score: 1.5, nested: { b: [1, 2], a: null } };
    await makeBrief({ createdAt: new Date(boundary.getTime() + 1000), revisions: [{ old: true }, body], body });
    await makeBrief({ createdAt: new Date(boundary.getTime() - 86_400_000), revisions: [] });
    await makeBrief({ createdAt: new Date(boundary.getTime() - 86_400_000), revisions: [{ revised: "after" }] });
    const r = await expectEquivalent("swarm_briefs", "seeded");
    expect(r.matched).toBe(true);
    const sqlResult = await checkDomainParity("swarm_briefs");
    expect({ legacy: sqlResult.legacyRowCount, ledger: sqlResult.ledgerRowCount }).toEqual({ legacy: 1, ledger: 1 });
  });

  test("a ledger-era brief with no revision, a revision with no ledger-era brief, and a body that differs", async () => {
    const boundary = await briefBoundary();
    const after = new Date(boundary.getTime() + 1000);
    const noRevision = await makeBrief({ createdAt: after, revisions: [] });
    const differs = await makeBrief({ createdAt: after, revisions: [{ v: 1 }], body: { v: 2 } });
    const orphan = await makeBrief({ createdAt: after, revisions: [{ v: 3 }], body: { v: 3 } });
    // swarm_briefs refuses DELETE (append-only, 0032): the compat row loses its
    // session, which takes it out of scope.
    await fixtureDb`UPDATE swarm_briefs SET session_id = NULL WHERE session_id = ${orphan}`;
    const r = await expectEquivalent("swarm_briefs", "planted");
    expect(r.mismatches).toEqual(
      [
        { naturalKey: noRevision, reason: MISSING_FROM_LEDGER },
        { naturalKey: differs, reason: DIFFERS },
        { naturalKey: orphan, reason: MISSING_FROM_COMPAT },
      ].sort((a, b) => (a.naturalKey < b.naturalKey ? -1 : 1)),
    );
  });

  test("the newest revision is the one compared", async () => {
    const boundary = await briefBoundary();
    const session = await makeBrief({ createdAt: new Date(boundary.getTime() + 1000), revisions: [{ v: "current" }, { v: "newer" }], body: { v: "current" } });
    const r = await expectEquivalent("swarm_briefs", "newest revision");
    expect(r.mismatches).toEqual([{ naturalKey: session, reason: DIFFERS }]);
  });
});
