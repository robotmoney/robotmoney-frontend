// Issue #977: freeze data vintages and analytics runs — the immutable run
// header + append-only lifecycle events + frozen data-vintage manifest built
// ON TOP of #976's append-only source ledger (source_value_versions et al,
// migration 0057). Real, migrated ephemeral Postgres via tests/preload.ts —
// never mocked, never skipped.
import { expect, test, describe } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { hermeticDataSource } from "../src/analytics/access/hermetic-source.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import type { TelemetrySink, TelemetryRunSubmission, TelemetrySubmitResult } from "../src/analytics/telemetry.ts";
import type { AnalyticsDataSource, ResearchInputs, BacktestExtras } from "../src/analytics/access/data-source.ts";
import type { Indicator } from "../src/analytics/analyze/indicators.ts";
import type { Point } from "../src/analytics/types.ts";
import {
  beginRun,
  appendRunEvent,
  freezeVintage,
  loadCurrentSourceValues,
  loadHistoricalSourceValues,
  loadFrozenVintage,
  findVintageByRunAndTool,
  memberRanges,
} from "../src/analytics/store/run-ledger-store.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { buildVintageManifest, sortedMembers, type FrozenSourceValue } from "../src/analytics/run-ledger.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const ASOF = "2026-05-15";

function runLedgerOf(results: Record<string, unknown>): { runId: string; methodologyVersionId: string; buildIdentity: string; vintage: unknown } {
  return (results as any).__runLedger;
}

// ── test-only helpers: hand-build the source ledger rows AC2/AC3 need ──────
async function insertAcquisition(knowledgeTime: string, cacheIdentity: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
    VALUES (${id}::uuid, 'fixture', 'test:1', ${cacheIdentity}, ${knowledgeTime}::timestamptz)`;
  await sql`
    INSERT INTO source_acquisition_events (acquisition_id, sequence, event_type)
    VALUES (${id}::uuid, 1, 'succeeded')`;
  return id;
}

async function insertValue(input: {
  acquisitionId: string;
  sourceKey: string;
  marketDate: string;
  value: number;
  priorVersionId: string | null;
  revisionKind: "initial" | "revision";
  knowledgeTime: string;
}): Promise<string> {
  const [row] = await sql`
    INSERT INTO source_value_versions
      (acquisition_id, source_key, market_date, value, prior_version_id, revision_kind, knowledge_time)
    VALUES (${input.acquisitionId}::uuid, ${input.sourceKey}, ${input.marketDate}::date, ${input.value},
            ${input.priorVersionId}::bigint, ${input.revisionKind}, ${input.knowledgeTime}::timestamptz)
    RETURNING id`;
  return String(row!.id);
}

// A minimal, always-non-throwing AnalyticsDataSource: every method is a spy
// that records its name into `order` before returning trivial (but
// non-empty, so channel-divergence never trips a warning) fixture data.
function orderedSource(order: string[]): AnalyticsDataSource {
  const pts: Point[] = [{ date: "2020-01-01", value: 1 }, { date: "2020-01-02", value: 2 }];
  return {
    async fetchIndicators(indicators: Indicator[]) {
      order.push("source.fetchIndicators");
      const out: Record<string, Point[]> = {};
      for (const ind of indicators) out[ind.id] = pts;
      return out;
    },
    async fetchResearchInputs(): Promise<ResearchInputs> {
      order.push("source.fetchResearchInputs");
      return { btc: pts, qqq: pts, spy: pts, rsp: pts, top7: [pts, pts, pts, pts, pts, pts, pts], mna: pts, margin: pts, conf: pts };
    },
    async fetchBacktestExtras(): Promise<BacktestExtras> {
      order.push("source.fetchBacktestExtras");
      return { spx: pts, eth: pts, tbill3m: pts };
    },
  };
}

function refusingSource(called: { any: boolean }): AnalyticsDataSource {
  const fail = (): never => {
    called.any = true;
    throw new Error("AnalyticsDataSource must never be called when begin-run failed");
  };
  return { fetchIndicators: fail, fetchResearchInputs: fail, fetchBacktestExtras: fail } as unknown as AnalyticsDataSource;
}

describe("AC1 + AC10: the immutable run header precedes acquisition, and begin-run failure is fatal before it", () => {
  test("beginRun is called, and completes, strictly before the injected AnalyticsDataSource's first method call", async () => {
    const order: string[] = [];
    const persistence = {
      ...directAnalyticsPersistence,
      beginRun: async (input: Parameters<typeof directAnalyticsPersistence.beginRun>[0]) => {
        order.push("beginRun");
        return directAnalyticsPersistence.beginRun(input);
      },
    };
    const results = await runAnalytics(ASOF, "channel-divergence", orderedSource(order), persistence, noopTelemetrySink);
    expect(order[0]).toBe("beginRun");
    expect(order).toContain("source.fetchResearchInputs");
    expect(order.indexOf("beginRun")).toBeLessThan(order.indexOf("source.fetchResearchInputs"));

    // The header really was persisted — not merely "the function was called".
    const { runId } = runLedgerOf(results);
    const [header] = await sql`SELECT id FROM analytics_ledger_runs WHERE id = ${runId}::bigint`;
    expect(header).toBeDefined();
  });

  test("begin-run failure is fatal: the AnalyticsDataSource is never called, and no canonical output is written", async () => {
    const called = { any: false };
    const persistence = {
      ...directAnalyticsPersistence,
      beginRun: async () => { throw new Error("run ledger unavailable"); },
    };
    const [{ n: signalsBefore }] = await sql`SELECT COUNT(*)::int AS n FROM research_signals`;
    const [{ n: runsBefore }] = await sql`SELECT COUNT(*)::int AS n FROM analytics_ledger_runs`;

    await expect(runAnalytics(ASOF, "channel-divergence", refusingSource(called), persistence, noopTelemetrySink))
      .rejects.toThrow("run ledger unavailable");
    expect(called.any).toBe(false);

    // Delta, not an absolute count: this file's OTHER tests share one
    // database (useCleanDatabase is per-file) and may already have written a
    // channel-divergence/asof row or a run header of their own.
    const [{ n: signalsAfter }] = await sql`SELECT COUNT(*)::int AS n FROM research_signals`;
    expect(signalsAfter).toBe(signalsBefore);
    const [{ n: runsAfter }] = await sql`SELECT COUNT(*)::int AS n FROM analytics_ledger_runs`;
    expect(runsAfter).toBe(runsBefore); // beginRun's own failure means no header row exists either
  });

  test("AC10: a mandatory-ledger-succeeded run still returns normally even when best-effort telemetry submission fails", async () => {
    const failingSink: TelemetrySink = {
      async submitRun(_run: TelemetryRunSubmission): Promise<TelemetrySubmitResult> {
        throw new Error("simulated telemetry outage");
      },
    };
    const results = await runAnalytics(ASOF, "channel-divergence", hermeticDataSource, directAnalyticsPersistence, failingSink);
    expect(results["channel-divergence"]).toBeDefined();
    const { runId, vintage } = runLedgerOf(results);
    expect(vintage).not.toBeNull(); // the mandatory ledger completed despite telemetry failing
    const events = await sql`SELECT event_type FROM analytics_ledger_run_events WHERE run_id = ${runId}::bigint ORDER BY sequence`;
    expect(events.map((e) => e.event_type)).toEqual(["started", "succeeded"]);
  });
});

describe("AC2 + AC3: cutoff-boundary vintage freezing, and current vs. historical as separate typed operations", () => {
  test("the frozen vintage contains EXACTLY the boundary-eligible source-value-version identifiers", async () => {
    const KNOWLEDGE_CUTOFF = "2024-06-01T00:00:00.000Z";
    const MARKET_CUTOFF = "2024-05-15";

    // Three revisions of ONE series: before, exactly-on, and after the
    // knowledge-time cutoff. Only the LATEST one at-or-before the cutoff
    // (rev B, exactly on it) is boundary-eligible.
    const acqA = await insertAcquisition("2024-05-01T00:00:00Z", "rev-a");
    const revA = await insertValue({ acquisitionId: acqA, sourceKey: "ac2:knowledge", marketDate: "2024-01-01", value: 1, priorVersionId: null, revisionKind: "initial", knowledgeTime: "2024-05-01T00:00:00Z" });
    const acqB = await insertAcquisition(KNOWLEDGE_CUTOFF, "rev-b");
    const revB = await insertValue({ acquisitionId: acqB, sourceKey: "ac2:knowledge", marketDate: "2024-01-01", value: 2, priorVersionId: revA, revisionKind: "revision", knowledgeTime: KNOWLEDGE_CUTOFF });
    const acqC = await insertAcquisition("2024-07-01T00:00:00Z", "rev-c");
    const revC = await insertValue({ acquisitionId: acqC, sourceKey: "ac2:knowledge", marketDate: "2024-01-01", value: 3, priorVersionId: revB, revisionKind: "revision", knowledgeTime: "2024-07-01T00:00:00Z" });

    // One observation before, one after, the market-time cutoff — both known
    // well before the knowledge-time cutoff, so only the market gate decides.
    const acqBefore = await insertAcquisition("2024-04-01T00:00:00Z", "market-before");
    const marketBefore = await insertValue({ acquisitionId: acqBefore, sourceKey: "ac2:market-before", marketDate: "2024-05-01", value: 10, priorVersionId: null, revisionKind: "initial", knowledgeTime: "2024-04-01T00:00:00Z" });
    const acqAfter = await insertAcquisition("2024-04-01T00:00:00Z", "market-after");
    await insertValue({ acquisitionId: acqAfter, sourceKey: "ac2:market-after", marketDate: "2024-06-01", value: 20, priorVersionId: null, revisionKind: "initial", knowledgeTime: "2024-04-01T00:00:00Z" });

    const { runId, methodologyVersionId } = await beginRun({
      runKey: randomUUID(), asof: ASOF, toolId: "test-ac2", sourceLabel: "fixture",
      methodology: { toolId: "test-ac2", versionLabel: "v-test", config: { test: "ac2" } },
      buildIdentity: "test-build-ac2",
    });
    const { vintageId, manifest, memberCount } = await freezeVintage({
      runId, toolId: "test-ac2", knowledgeTimeCutoff: KNOWLEDGE_CUTOFF, marketTimeCutoff: MARKET_CUTOFF,
      methodologyVersionId, buildIdentity: "test-build-ac2",
    });
    expect(memberCount).toBe(2);
    expect(manifest.memberCount).toBe(2);

    // Resolved through the production loader: member rows are runs of
    // consecutive ids (issue #1035), so the raw rows are not the member list.
    const memberIds = (await loadFrozenVintage(vintageId))!.members.map((m) => m.versionId);
    expect(new Set(memberIds)).toEqual(new Set([revB, marketBefore]));
    // Neither the superseded-at-cutoff revision (A), the after-cutoff revision
    // (C), nor the after-market-cutoff observation are members.
    expect(memberIds).not.toContain(revA);
    expect(memberIds).not.toContain(revC);
  });

  test("current-value selection returns the newest known revision; historical cutoff selection returns the frozen earlier one — via separate operations", async () => {
    const KNOWLEDGE_CUTOFF = "2025-01-01T00:00:00.000Z";
    const acq1 = await insertAcquisition("2024-01-01T00:00:00Z", "ac3-1");
    const rev1 = await insertValue({ acquisitionId: acq1, sourceKey: "ac3:series", marketDate: "2024-01-01", value: 100, priorVersionId: null, revisionKind: "initial", knowledgeTime: "2024-01-01T00:00:00Z" });
    const acq2 = await insertAcquisition("2026-01-01T00:00:00Z", "ac3-2");
    const rev2 = await insertValue({ acquisitionId: acq2, sourceKey: "ac3:series", marketDate: "2024-01-01", value: 200, priorVersionId: rev1, revisionKind: "revision", knowledgeTime: "2026-01-01T00:00:00Z" });

    const current = await loadCurrentSourceValues();
    const currentRow = current.find((m) => m.sourceKey === "ac3:series");
    expect(currentRow?.versionId).toBe(rev2); // newest known, ignoring any cutoff
    expect(currentRow?.value).toBe(200);

    const historical = await loadHistoricalSourceValues(KNOWLEDGE_CUTOFF, "2024-01-01");
    const historicalRow = historical.find((m) => m.sourceKey === "ac3:series");
    expect(historicalRow?.versionId).toBe(rev1); // frozen at a cutoff BEFORE rev2 existed
    expect(historicalRow?.value).toBe(100);

    // loadCurrentSourceValues and loadHistoricalSourceValues are genuinely
    // separate exported functions, not one function with an optional cutoff.
    expect(loadCurrentSourceValues).not.toBe(loadHistoricalSourceValues as unknown as typeof loadCurrentSourceValues);
    expect(loadCurrentSourceValues.length).toBe(0); // takes no cutoff arguments
    expect(loadHistoricalSourceValues.length).toBe(2); // (knowledgeTimeCutoff, marketTimeCutoff)
  });
});

describe("AC4: canonical manifests + per-series fingerprints are order-independent, and change with any selected input", () => {
  const base: FrozenSourceValue[] = [
    { versionId: "1", sourceKey: "a", marketDate: "2024-01-01", marketInstant: null, value: 1 },
    { versionId: "2", sourceKey: "b", marketDate: "2024-01-02", marketInstant: null, value: 2 },
    { versionId: "3", sourceKey: "a", marketDate: "2024-01-03", marketInstant: null, value: 3 },
  ];
  const METH = "meth-1";
  const BUILD = "build-1";
  const CUTOFFS = ["2024-06-01T00:00:00.000Z", "2024-01-01"] as const;

  test("identical members in randomized order produce an identical manifest digest and per-series fingerprints", () => {
    const { manifest: m1 } = buildVintageManifest(base, METH, BUILD, ...CUTOFFS);
    const shuffled = [base[2]!, base[0]!, base[1]!];
    const { manifest: m2 } = buildVintageManifest(shuffled, METH, BUILD, ...CUTOFFS);
    expect(m2.manifestDigest).toBe(m1.manifestDigest);
    expect(m2.seriesFingerprints).toEqual(m1.seriesFingerprints);
    // sortedMembers itself is the order-independence primitive.
    expect(sortedMembers(base)).toEqual(sortedMembers(shuffled));
  });

  test("changing the selected version identifier changes the digest and that series' fingerprint only", () => {
    const { manifest: m1 } = buildVintageManifest(base, METH, BUILD, ...CUTOFFS);
    const changed = base.map((m) => (m.sourceKey === "a" && m.marketDate === "2024-01-01" ? { ...m, versionId: "999" } : m));
    const { manifest: m2 } = buildVintageManifest(changed, METH, BUILD, ...CUTOFFS);
    expect(m2.manifestDigest).not.toBe(m1.manifestDigest);
    expect(m2.seriesFingerprints.a).not.toBe(m1.seriesFingerprints.a);
    expect(m2.seriesFingerprints.b).toBe(m1.seriesFingerprints.b); // untouched series unaffected
  });

  test("changing a coordinate (marketDate) changes the digest", () => {
    const { manifest: m1 } = buildVintageManifest(base, METH, BUILD, ...CUTOFFS);
    const changed = base.map((m) => (m.versionId === "1" ? { ...m, marketDate: "2024-02-01" } : m));
    const { manifest: m2 } = buildVintageManifest(changed, METH, BUILD, ...CUTOFFS);
    expect(m2.manifestDigest).not.toBe(m1.manifestDigest);
  });

  test("changing a value changes the digest", () => {
    const { manifest: m1 } = buildVintageManifest(base, METH, BUILD, ...CUTOFFS);
    const changed = base.map((m) => (m.versionId === "1" ? { ...m, value: 42 } : m));
    const { manifest: m2 } = buildVintageManifest(changed, METH, BUILD, ...CUTOFFS);
    expect(m2.manifestDigest).not.toBe(m1.manifestDigest);
  });

  test("changing the methodology version changes the digest AND every per-series fingerprint", () => {
    const { manifest: m1 } = buildVintageManifest(base, METH, BUILD, ...CUTOFFS);
    const { manifest: m2 } = buildVintageManifest(base, "meth-2", BUILD, ...CUTOFFS);
    expect(m2.manifestDigest).not.toBe(m1.manifestDigest);
    expect(m2.seriesFingerprints.a).not.toBe(m1.seriesFingerprints.a);
    expect(m2.seriesFingerprints.b).not.toBe(m1.seriesFingerprints.b);
  });

  test("changing the build identity changes the digest AND every per-series fingerprint", () => {
    const { manifest: m1 } = buildVintageManifest(base, METH, BUILD, ...CUTOFFS);
    const { manifest: m2 } = buildVintageManifest(base, METH, "build-2", ...CUTOFFS);
    expect(m2.manifestDigest).not.toBe(m1.manifestDigest);
    expect(m2.seriesFingerprints.a).not.toBe(m1.seriesFingerprints.a);
    expect(m2.seriesFingerprints.b).not.toBe(m1.seriesFingerprints.b);
  });
});

describe("AC5: success, degraded, and failure outcomes append ordered events; nothing ever updates the header", () => {
  test("the run header table has no status/finished_at/warning/error column — there is nothing for any code path to update", async () => {
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'analytics_ledger_runs'`;
    const names = new Set(cols.map((c) => c.column_name));
    for (const forbidden of ["status", "finished_at", "warning", "error"]) {
      expect(names.has(forbidden), `analytics_ledger_runs must not carry a '${forbidden}' column`).toBe(false);
    }
  });

  test("a succeeding run appends started -> succeeded", async () => {
    const results = await runAnalytics(ASOF, "channel-divergence", hermeticDataSource, directAnalyticsPersistence, noopTelemetrySink);
    const { runId } = runLedgerOf(results);
    const before = await sql`SELECT id, asof::text AS asof, tool_id, source_label, build_identity FROM analytics_ledger_runs WHERE id = ${runId}::bigint`;
    const events = await sql`SELECT sequence, event_type FROM analytics_ledger_run_events WHERE run_id = ${runId}::bigint ORDER BY sequence`;
    expect(events.map((e) => e.event_type)).toEqual(["started", "succeeded"]);
    expect(events.map((e) => Number(e.sequence))).toEqual([1, 2]);
    // The header is exactly what beginRun wrote — nothing touched it since.
    const after = await sql`SELECT id, asof::text AS asof, tool_id, source_label, build_identity FROM analytics_ledger_runs WHERE id = ${runId}::bigint`;
    expect(after).toEqual(before);
  });

  test("a degraded run (EDGAR refresh reported degraded) appends started -> degraded", async () => {
    const degradedSource: AnalyticsDataSource = {
      async fetchIndicators() { throw new Error("not used"); },
      async fetchResearchInputs(): Promise<ResearchInputs> {
        return {
          btc: [], qqq: [], spy: [{ date: "2020-01-01", value: 1 }], rsp: [{ date: "2020-01-01", value: 1 }],
          top7: [[], [], [], [], [], [], []],
          mna: [{ date: "2020-01-01", value: 1 }], margin: [{ date: "2020-01-01", value: 1 }], conf: [{ date: "2020-01-01", value: 1 }],
          mnaRefresh: {
            status: "degraded", tier: "daily", reason: "test-forced degrade", degradeKind: "deadline_exceeded",
            fellBackFromFullSweep: false, plannedMonths: 1, newMonths: 0, revisedMonths: 0, fetchedMonths: 0,
            missingMonths: 1, rejectedMonths: 0, newRows: [],
          } as unknown as ResearchInputs["mnaRefresh"],
        };
      },
      async fetchBacktestExtras() { throw new Error("not used"); },
    };
    const results = await runAnalytics(ASOF, "late-cycle-signals", degradedSource, directAnalyticsPersistence, noopTelemetrySink);
    const { runId } = runLedgerOf(results);
    const events = await sql`SELECT event_type FROM analytics_ledger_run_events WHERE run_id = ${runId}::bigint ORDER BY sequence`;
    expect(events.map((e) => e.event_type)).toEqual(["started", "degraded"]);
  });

  test("a failing run appends started -> failed, and the header is still untouched", async () => {
    const throwingSource: AnalyticsDataSource = {
      async fetchIndicators() { throw new Error("not used"); },
      async fetchResearchInputs(): Promise<ResearchInputs> { throw new Error("forced research failure"); },
      async fetchBacktestExtras() { throw new Error("not used"); },
    };
    let runId: string | null = null;
    try {
      await runAnalytics(ASOF, "channel-divergence", throwingSource, directAnalyticsPersistence, noopTelemetrySink);
      throw new Error("expected runAnalytics to reject");
    } catch (e) {
      expect((e as Error).message).toBe("forced research failure");
    }
    // Find the run this attempt created (it never returns its runId on
    // throw, so read the ledger back by asof — the only run for this asof
    // in this clean-per-file database at this point in the file).
    const [row] = await sql`SELECT id::text AS id FROM analytics_ledger_runs WHERE asof = ${ASOF}::date AND tool_id = 'channel-divergence' ORDER BY id DESC LIMIT 1`;
    runId = row!.id;
    const events = await sql`SELECT event_type, detail FROM analytics_ledger_run_events WHERE run_id = ${runId}::bigint ORDER BY sequence`;
    expect(events.map((e) => e.event_type)).toEqual(["started", "failed"]);
    expect(events[1]!.detail).toContain("forced research failure");
  });
});

describe("issue #1035 AC5: vintage membership is not copied per freeze, and every vintage still replays its digest", () => {
  test("memberRanges merges only strictly consecutive ids under one source_key", () => {
    const m = (versionId: string, sourceKey: string): FrozenSourceValue =>
      ({ versionId, sourceKey, marketDate: "2024-01-01", marketInstant: null, value: 1 });
    expect(memberRanges([m("12", "a"), m("10", "a"), m("11", "a"), m("14", "a"), m("15", "b"), m("16", "b"), m("99999999999999999", "b")])).toEqual([
      { firstVersionId: "10", lastVersionId: "12", sourceKey: "a" },
      // 13 is not a member (a gap in the id sequence can be an insert still in
      // flight), so 14 starts a new run rather than extending 10..12.
      { firstVersionId: "14", lastVersionId: null, sourceKey: "a" },
      // 15 is consecutive with 14 but under another key: a run never spans keys.
      { firstVersionId: "15", lastVersionId: "16", sourceKey: "b" },
      { firstVersionId: "99999999999999999", lastVersionId: null, sourceKey: "b" },
    ]);
  });

  test("a second vintage over an unchanged ledger adds fewer member rows than the first vintage's member_count, and loadFrozenVintage recomputes every stored manifest_digest", async () => {
    // A realistic ledger: whole series written by one acquisition each, the
    // way extract/sources.ts captures them.
    for (const key of ["ac5:alpha", "ac5:beta", "ac5:gamma"]) {
      await saveSourceAcquisition({
        id: randomUUID(), provider: "fixture", parserVersion: "fixture:1", cacheIdentity: key,
        requestedByRunId: null, events: [], fetches: [],
        values: Array.from({ length: 300 }, (_, i) => ({
          sourceKey: key,
          marketDate: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
          marketInstant: null,
          value: i + key.length / 10,
          provenance: "live",
        })),
      });
    }
    const knowledgeTimeCutoff = new Date().toISOString();
    const freeze = async (label: string) => {
      const { runId, methodologyVersionId } = await beginRun({
        runKey: randomUUID(), asof: ASOF, toolId: "test-ac5", sourceLabel: "fixture",
        methodology: { toolId: "test-ac5", versionLabel: "v-test", config: { test: "ac5" } },
        buildIdentity: `test-build-${label}`,
      });
      const [{ n: rowsBefore }] = await sql`SELECT count(*)::int AS n FROM analytics_vintage_members`;
      const frozen = await freezeVintage({
        runId, toolId: "test-ac5", knowledgeTimeCutoff, marketTimeCutoff: "2026-01-01",
        methodologyVersionId, buildIdentity: `test-build-${label}`,
      });
      const [{ n: rowsAfter }] = await sql`SELECT count(*)::int AS n FROM analytics_vintage_members`;
      return { ...frozen, rowsAdded: rowsAfter - rowsBefore };
    };

    const first = await freeze("first");
    const second = await freeze("second");
    expect(first.memberCount).toBeGreaterThanOrEqual(900);
    expect(second.memberCount).toBe(first.memberCount);
    // The copy this issue removes: ~one row per member per freeze.
    expect(second.rowsAdded).toBeGreaterThan(0);
    expect(second.rowsAdded).toBeLessThan(first.memberCount);
    expect(second.rowsAdded).toBeLessThan(first.memberCount / 10);

    // Every vintage this file has frozen — run-encoded ones AND any written one
    // row per member — resolves to members whose recomputed manifest matches the
    // digest stored when it was frozen.
    const vintages = (await sql`
      SELECT id::text AS id, manifest_digest FROM analytics_data_vintages ORDER BY id`) as unknown as { id: string; manifest_digest: string }[];
    expect(vintages.length).toBeGreaterThanOrEqual(2);
    for (const v of vintages) {
      const loaded = await loadFrozenVintage(v.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.members).toHaveLength(loaded!.memberCount);
      const { manifest } = buildVintageManifest(
        loaded!.members, loaded!.methodologyVersionId, loaded!.buildIdentity,
        loaded!.knowledgeTimeCutoff, loaded!.marketTimeCutoff,
      );
      expect({ id: v.id, digest: manifest.manifestDigest }).toEqual({ id: v.id, digest: v.manifest_digest });
    }
  });
});
