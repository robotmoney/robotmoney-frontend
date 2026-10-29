// Issue #977 AC7: a frozen data vintage must be loadable and
// fingerprint-verifiable OFFLINE — reloading it never needs the network or
// the AnalyticsDataSource that originally produced it. This test first
// freezes a complete fixture run for real (hermetic source, real ephemeral
// Postgres), then replaces BOTH `globalThis.fetch` and every method on a
// fresh AnalyticsDataSource with throwing sentinels before reloading the
// frozen inputs through the production loader (loadFrozenVintage) and
// re-deriving the manifest — proving the reload path never touches either.
import { afterEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { hermeticDataSource } from "../src/analytics/access/hermetic-source.ts";
import { liveDataSource } from "../src/analytics/access/data-source.ts";
import type { AnalyticsDataSource, ResearchInputs } from "../src/analytics/access/data-source.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { captureSourceAcquisition } from "../src/analytics/source-ledger.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { beginRun, freezeVintage, loadFrozenVintage, loadHistoricalSourceValues } from "../src/analytics/store/run-ledger-store.ts";
import { buildVintageManifest, sortedMembers } from "../src/analytics/run-ledger.ts";
import { SERIES_MAPPING, STORED_UNDER, inputHistoryFromStorage, selectConsumerObservations } from "../src/analytics/extras.ts";
import { parseRawHistory, toHistory } from "../../packages/analyst-sdk/src/input/load.ts";
import { buildReport, runRegime } from "../../packages/analyst-sdk/src/run.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useCleanDatabase } from "./support/clean-db.ts";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import type { TerminalRunPackageInput } from "../src/analytics/output-snapshots.ts";
import type { Point } from "../src/analytics/types.ts";
import { PANELS } from "../src/analytics/analyze/indicators.ts";
import { computeRegime } from "../src/analytics/analyze/compute.ts";
import { computeCorrelations } from "../src/analytics/analyze/correlations.ts";
import { computeBacktest, stripDailyFromSnapshot } from "../src/analytics/analyze/backtest.ts";
import { TOP7, computeChannelDivergence, computeLateCycle } from "../src/analytics/analyze/research-signals.ts";
import { prepareRegimeInputs } from "../src/analytics/prepare.ts";
import {
  ASOF as COMMITTED_ASOF,
  baseObservations,
  capturingTelemetry,
  committedAfterSecond,
  poisonedSource,
  secondObservations,
} from "./support/committed-inputs.ts";

useCleanDatabase(import.meta.file);

const originalFetch = globalThis.fetch;
const originalHermeticMethods = { ...hermeticDataSource };
const originalLiveMethods = { ...liveDataSource };
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(hermeticDataSource, originalHermeticMethods);
  Object.assign(liveDataSource, originalLiveMethods);
});

// Poison EVERY production AnalyticsDataSource singleton's methods in place —
// not a fresh fake object, the actual module-level exports every real caller
// resolves to (analytics/index.ts's resolveAnalyticsSource, hermetic tests,
// etc). If the offline reload path below reached for either of them for any
// reason, it would throw immediately.
function poisonEveryDataSourceMethod(): void {
  const sentinel = (name: string) => async (): Promise<never> => {
    throw new Error(`OFFLINE REPLAY MUST NEVER CALL AnalyticsDataSource.${name}`);
  };
  for (const source of [hermeticDataSource, liveDataSource]) {
    for (const method of ["fetchIndicators", "fetchResearchInputs", "fetchBacktestExtras"] as const) {
      (source as any)[method] = sentinel(method);
    }
  }
}

// hermeticDataSource never records source-ledger evidence (it is a synthetic,
// no-acquisition fixture) — this offline-replay claim needs a REAL, non-empty
// vintage, so this test uses a small fixture source that captures real
// acquisition evidence (through the same captureSourceAcquisition production
// path liveDataSource uses) for a handful of series.
const acquisitionSink = { saveSourceAcquisition };
function acquiringFixtureSource(): AnalyticsDataSource {
  const acquire = (sourceKey: string, points: { date: string; value: number }[]) =>
    captureSourceAcquisition(
      { provider: "fixture", sourceKey, parserVersion: "offline-replay-fixture:1", cacheIdentity: sourceKey },
      acquisitionSink,
      async () => points,
    );
  return {
    async fetchIndicators(): Promise<never> { throw new Error("not used by channel-divergence"); },
    async fetchResearchInputs(): Promise<ResearchInputs> {
      const btc = await acquire("research:BTC-USD", [{ date: "2020-01-01", value: 1 }, { date: "2020-01-02", value: 2 }]);
      const qqq = await acquire("research:QQQ", [{ date: "2020-01-01", value: 10 }, { date: "2020-01-02", value: 11 }]);
      const spy = await acquire("research:SPY", [{ date: "2020-01-01", value: 100 }]);
      return { btc, qqq, spy, rsp: [], top7: [[], [], [], [], [], [], []], mna: [], margin: [], conf: [] };
    },
    async fetchBacktestExtras(): Promise<never> { throw new Error("not used by channel-divergence"); },
  } as unknown as AnalyticsDataSource;
}

test(
  "a frozen vintage reloads and re-verifies with globalThis.fetch AND every AnalyticsDataSource method replaced by throwing sentinels",
  async () => {
    const ASOF = "2026-05-15";

    // (1) Freeze a real, complete fixture run against real ephemeral
    // Postgres, through the real orchestrator.
    const results = await runAnalytics(ASOF, "channel-divergence", acquiringFixtureSource(), directAnalyticsPersistence, noopTelemetrySink);
    const runLedger = (results as any).__runLedger as {
      runId: string; methodologyVersionId: string; buildIdentity: string;
      vintage: { vintageId: string; manifest: { manifestDigest: string; seriesFingerprints: Record<string, string> } } | null;
    };
    expect(runLedger.vintage).not.toBeNull();
    const original = runLedger.vintage!;
    expect(original.manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(original.manifest.seriesFingerprints).length).toBeGreaterThan(0);

    // Sanity: the vintage really is durable in Postgres, independent of the
    // in-memory `results` object this test just received.
    // Rows are runs of consecutive version ids (issue #1035), so the member
    // COUNT is the vintage header's member_count, not the row count.
    const [{ n: memberRows, rows: storedRows }] = await sql`
      SELECT v.member_count AS n,
             (SELECT COUNT(*)::int FROM analytics_vintage_members WHERE vintage_id = v.id) AS rows
      FROM analytics_data_vintages v WHERE v.id = ${original.vintageId}::bigint`;
    expect(memberRows).toBeGreaterThan(0);
    expect(storedRows).toBeGreaterThan(0);

    // (2) Cut off every avenue back to a live source: the global fetch AND
    // every method of both production AnalyticsDataSource singletons.
    globalThis.fetch = (async () => { throw new Error("OFFLINE REPLAY MUST NEVER CALL fetch"); }) as unknown as typeof fetch;
    poisonEveryDataSourceMethod();

    // (3) Reload the frozen inputs through the PRODUCTION loader alone.
    const reloaded = await loadFrozenVintage(original.vintageId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.members.length).toBe(memberRows);

    // (4) Re-derive the manifest from the reloaded members and assert BYTE
    // equality with the original — the replay proof. No network call and no
    // AnalyticsDataSource call could have happened above (both would have
    // thrown, and this assertion is still reached).
    const { manifest: rebuilt, manifestBytes } = buildVintageManifest(
      reloaded!.members,
      reloaded!.methodologyVersionId,
      reloaded!.buildIdentity,
      reloaded!.knowledgeTimeCutoff,
      reloaded!.marketTimeCutoff,
    );
    expect(rebuilt.manifestDigest).toBe(original.manifest.manifestDigest);
    expect(rebuilt.seriesFingerprints).toEqual(original.manifest.seriesFingerprints);
    expect(reloaded!.manifestDigest).toBe(original.manifest.manifestDigest); // the STORED digest agrees too
    expect(typeof manifestBytes).toBe("string");
    expect(manifestBytes.length).toBeGreaterThan(0);
  },
  { timeout: 60_000 },
);

// Issue 1423 (D74): the storage mapping must not change what a frozen vintage
// replays. The SDK's committed fixture is stored under the storage keys its
// consumers read today, frozen into a vintage, then reloaded with the network
// and every data source poisoned. Membership, version ids, values, dates and
// ordering come back unchanged, every member reaches its consumers through the
// mapping, and the report rebuilt from the reloaded members equals the
// committed golden byte for byte (no tolerance, no regenerated file).
const SDK_TESTS = join(import.meta.dir, "..", "..", "packages", "analyst-sdk", "tests");
// Regenerated once on purpose by decision D78 (compensated arithmetic; was 119b34cc561c59b33e53d27534ff64666e3cf30ee161684959517aee7545a8ce).
const GOLDEN_SHA256 = "08b36777a0822838abfaae0b3cfc0319b7f503476ad71470646e309ba11be8ba";

test(
  "a frozen regime vintage reloads offline with unchanged membership and rebuilds the golden report bytes through the D74 mapping",
  async () => {
    const goldenText = readFileSync(join(SDK_TESTS, "golden", "regime-report.json"), "utf8");
    expect(createHash("sha256").update(goldenText).digest("hex")).toBe(GOLDEN_SHA256);
    const fixture = toHistory(parseRawHistory(readFileSync(join(SDK_TESTS, "fixtures", "raw-indicator-history.csv"), "utf8")));
    const keyOf = new Map(SERIES_MAPPING.map((m) => [m.inputId, m.storageKey]));
    const sink = { saveSourceAcquisition };
    // DEFI_GROWTH and STABLES_GROWTH read the DEFI_TVL and STABLES keys (D74
    // amendment, issue 1514): their fixture series equal those, so they are
    // stored once, under that key.
    for (const id of Object.keys(fixture).sort().filter((id) => !Object.hasOwn(STORED_UNDER, id))) {
      const sourceKey = keyOf.get(id);
      expect(sourceKey, `fixture series ${id} has a storage key`).toBeDefined();
      await captureSourceAcquisition({ provider: "fixture", sourceKey: sourceKey!, parserVersion: "d74-replay-fixture:1", cacheIdentity: sourceKey! }, sink, async () => fixture[id]!);
    }

    // The fixture's last date; earlier tests in this file may have left research rows, which no regime consumer reads.
    const ASOF = Object.values(fixture).reduce((d, pts) => (pts[pts.length - 1]!.date > d ? pts[pts.length - 1]!.date : d), "");
    const mapped = new Set(SERIES_MAPPING.map((m) => m.storageKey));
    const methodology = { toolId: "regime", versionLabel: "d74-replay", config: { issue: 1423 } };
    const run = await beginRun({ runKey: crypto.randomUUID(), asof: ASOF, toolId: "regime", sourceLabel: "fixture", methodology, buildIdentity: "d74-replay" });
    const knowledgeTimeCutoff = new Date().toISOString();
    const frozen = await freezeVintage({ runId: run.runId, toolId: "regime", knowledgeTimeCutoff, marketTimeCutoff: ASOF, methodologyVersionId: run.methodologyVersionId, buildIdentity: "d74-replay" });
    const original = sortedMembers(await loadHistoricalSourceValues(knowledgeTimeCutoff, ASOF));
    expect(original.length).toBe(frozen.memberCount);
    expect(original.filter((m) => mapped.has(m.sourceKey)).length).toBe(Object.entries(fixture).filter(([id]) => !Object.hasOwn(STORED_UNDER, id)).reduce((n, [, pts]) => n + pts.length, 0));

    globalThis.fetch = (async () => { throw new Error("OFFLINE REPLAY MUST NEVER CALL fetch"); }) as unknown as typeof fetch;
    poisonEveryDataSourceMethod();

    const reloaded = await loadFrozenVintage(frozen.vintageId);
    expect(reloaded).not.toBeNull();
    const members = sortedMembers(reloaded!.members);
    // Membership, version ids, keys, dates, values and ordering: exact.
    expect(members).toEqual(original);
    expect(reloaded!.manifestDigest).toBe(frozen.manifest.manifestDigest);

    // Every member reaches the consumers that read its key, as itself.
    const seen = new Set<string>();
    for (const consumer of new Set(SERIES_MAPPING.map((m) => m.consumer))) {
      const keys = new Set(SERIES_MAPPING.filter((m) => m.consumer === consumer).map((m) => m.storageKey));
      const obs = selectConsumerObservations(members, consumer);
      expect(obs.map((o): unknown[] => [o.versionId, o.storageKey, o.date, o.value])).toEqual(
        members.filter((m) => keys.has(m.sourceKey)).map((m) => [m.versionId, m.sourceKey, m.marketDate, m.value]),
      );
      for (const o of obs) seen.add(o.versionId!);
    }
    expect(seen.size).toBe(members.filter((m) => mapped.has(m.sourceKey)).length);

    // The history the run reads equals the committed fixture, and the report its bytes.
    const history = inputHistoryFromStorage(members);
    expect(history).toEqual(fixture);
    expect(JSON.stringify(buildReport(runRegime(history)), null, 2) + "\n").toBe(goldenText);
  },
  { timeout: 120_000 },
);

// Issue 1514 (D74 amendment): a vintage frozen BEFORE the change holds the
// DEFI_GROWTH and STABLES_GROWTH versions under their own keys. Replayed now,
// those rows reach no consumer, the growth indicators read DEFI_TVL and
// STABLES, and the published report comes back byte for byte (the two series
// were equal on every date, as they are in production).
test(
  "a vintage frozen before the D74 amendment, whose members include *_GROWTH versions, replays to its published report byte for byte",
  async () => {
    const goldenText = readFileSync(join(SDK_TESTS, "golden", "regime-report.json"), "utf8");
    const fixture = toHistory(parseRawHistory(readFileSync(join(SDK_TESTS, "fixtures", "raw-indicator-history.csv"), "utf8")));
    for (const [id, stored] of Object.entries(STORED_UNDER)) expect(fixture[id]).toEqual(fixture[stored]!);
    const sink = { saveSourceAcquisition };
    // The pre-change shape: every registry id under raw_indicator_history:<id>.
    const legacy = (id: string) => `raw_indicator_history:${id}`;
    for (const id of Object.keys(fixture).sort()) {
      const key = SERIES_MAPPING.some((m) => m.inputId === id && m.consumer.startsWith("indicator:")) ? legacy(id) : SERIES_MAPPING.find((m) => m.inputId === id)!.storageKey;
      await captureSourceAcquisition({ provider: "fixture", sourceKey: key, parserVersion: "pre-d74-amendment:1", cacheIdentity: key }, sink, async () => fixture[id]!);
    }
    const ASOF = Object.values(fixture).reduce((d, pts) => (pts[pts.length - 1]!.date > d ? pts[pts.length - 1]!.date : d), "");
    const methodology = { toolId: "regime", versionLabel: "pre-d74-amendment", config: { issue: 1514 } };
    const run = await beginRun({ runKey: crypto.randomUUID(), asof: ASOF, toolId: "regime", sourceLabel: "fixture", methodology, buildIdentity: "pre-d74-amendment" });
    const frozen = await freezeVintage({ runId: run.runId, toolId: "regime", knowledgeTimeCutoff: new Date().toISOString(), marketTimeCutoff: ASOF, methodologyVersionId: run.methodologyVersionId, buildIdentity: "pre-d74-amendment" });

    globalThis.fetch = (async () => { throw new Error("OFFLINE REPLAY MUST NEVER CALL fetch"); }) as unknown as typeof fetch;
    poisonEveryDataSourceMethod();
    const reloaded = await loadFrozenVintage(frozen.vintageId);
    const members = sortedMembers(reloaded!.members);
    for (const id of Object.keys(STORED_UNDER)) expect(members.some((m) => m.sourceKey === legacy(id))).toBe(true);
    const history = inputHistoryFromStorage(members);
    expect(history).toEqual(fixture);
    expect(JSON.stringify(buildReport(runRegime(history)), null, 2) + "\n").toBe(goldenText);
  },
  { timeout: 120_000 },
);

// ── Issue 1421 (review findings AN-13, AN-15): downstream runs from committed data ──
// A whole-suite run (regime + both research signals) over real persistence.
// The source acquires through the production captureSourceAcquisition path,
// and the moment its third and last extract call returns it poisons fetch,
// node:http(s), WebSocket, EventSource and XMLHttpRequest, and turns every
// further source call and acquisition save into a recorded, throwing call.
// The second run's provider serves within-tolerance jitter and one material
// revision per handoff; every handoff must receive exactly the COMMITTED
// observations (the stored value for the jitter, the new version for the
// revision), the frozen vintage must hold exactly the versions consumed, and
// nothing may acquire after extract.
test(
  "after extract, with HTTP and acquisition poisoned, registry, backtest-extras and research handoffs receive exactly the committed observations and versions",
  async () => {
    const base = await baseObservations();
    await directAnalyticsPersistence.saveRawHistory({ MNA: base.mna }, "fixture");
    const first = poisonedSource(base, 3);
    try {
      await runAnalytics(COMMITTED_ASOF, undefined, first, directAnalyticsPersistence, noopTelemetrySink);
    } finally {
      first.restore();
    }

    const second = secondObservations(base);
    const committed = committedAfterSecond(base, second);
    const source = poisonedSource(second, 3);
    const telemetry = capturingTelemetry();
    const submitted: TerminalRunPackageInput[] = [];
    const persistence: AnalyticsPersistence = {
      ...directAnalyticsPersistence,
      async submitTerminalRunPackage(input) {
        submitted.push(input);
        return directAnalyticsPersistence.submitTerminalRunPackage(input);
      },
    };
    let results: Record<string, unknown>;
    try {
      results = await runAnalytics(COMMITTED_ASOF, undefined, source, persistence, telemetry);
    } finally {
      source.restore();
    }

    // Extract ran once per handoff, then nothing acquired: no source call, no
    // acquisition save and no HTTP attempt of any kind after it.
    expect(source.calls).toEqual(["fetchIndicators", "fetchBacktestExtras", "fetchResearchInputs"]);
    expect(source.poison).not.toBeNull();
    expect(source.afterExtract).toEqual([]);
    expect(source.poison!.attempts).toEqual([]);
    expect(source.acquired.length).toBe(Object.keys(second.registry).length + 3 + 4 + TOP7.length + 2);

    // Registry handoff: the jittered VIX reached downstream as the STORED value,
    // the revised T10Y2Y as its new version.
    const rows = submitted[0]!.regimeSnapshots!;
    const latest = rows[rows.length - 1]!;
    const rawOf = (id: string) => (latest.indicators as { id: string; raw_value: number | null }[]).find((i) => i.id === id)!.raw_value;
    expect(rawOf("VIX")).toBe(base.registry.VIX!.at(-1)!.value);
    expect(rawOf("VIX")).not.toBe(second.registry.VIX!.at(-1)!.value);
    expect(rawOf("T10Y2Y")).toBe(second.registry.T10Y2Y!.at(-1)!.value);

    // Regime and backtest-extras handoffs: the outputs are exactly the pure
    // calculation over the committed observations, and differ from the same
    // calculation over what was collected.
    // DEFI_GROWTH and STABLES_GROWTH read the DEFI_TVL and STABLES series (D74 amendment).
    const growth = Object.fromEntries(Object.entries(STORED_UNDER).map(([id, stored]) => [id, committed.registry[stored]!]));
    const prepared = prepareRegimeInputs({ ...committed.registry, ...growth }, { start: "2018-01-01", asof: COMMITTED_ASOF });
    const r2 = computeRegime(prepared.transformed, prepared.dateAxis, PANELS, prepared.ages);
    expect(latest.composite).toBe(r2.composite[r2.composite.length - 1]!);
    const analysis = (extras: typeof committed.extras) =>
      JSON.stringify({
        correlations: computeCorrelations(prepared.dateAxis, r2, extras),
        backtest: stripDailyFromSnapshot(computeBacktest(prepared.dateAxis, r2, extras)),
      });
    const published = JSON.stringify({ correlations: latest.correlations, backtest: latest.backtest });
    expect(published).toBe(analysis(committed.extras));
    expect(published).not.toBe(analysis(second.extras));

    // Research handoffs: both signals are exactly the calculation over the
    // committed research inputs (STABLES from the committed floor, MNA from the
    // persisted floor), and the jittered BTC-USD did not reach them.
    const stables = committed.registry.STABLES!;
    const channel = (btc: Point[], qqq: Point[]) => JSON.stringify(computeChannelDivergence({ btc, qqq, spy: committed.research.spy, stables }, COMMITTED_ASOF));
    expect(JSON.stringify(results["channel-divergence"])).toBe(channel(committed.research.btc, committed.research.qqq));
    expect(JSON.stringify(results["channel-divergence"])).not.toBe(channel(second.research.btc, second.research.qqq));
    const r = committed.research;
    expect(JSON.stringify(results["late-cycle-signals"])).toBe(
      JSON.stringify(computeLateCycle({ spy: r.spy, rsp: r.rsp, top7: r.top7, mna: base.mna, margin: r.margin, conf: r.conf }, COMMITTED_ASOF)),
    );

    // Versions: every committed value the ledger handed back is the member of
    // the run's frozen vintage at that coordinate, version for version.
    const vintageId = (results as any).__runLedger.vintage.vintageId as string;
    const vintage = await loadFrozenVintage(vintageId);
    const members = new Map(vintage!.members.map((m) => [`${m.sourceKey}|${m.marketDate}`, m]));
    let checked = 0;
    for (const { evidence, committed: heads } of source.acquired) {
      expect(heads.length).toBe(evidence.values.length);
      evidence.values.forEach((v, i) => {
        const member = members.get(`${v.sourceKey}|${v.marketDate}`);
        expect(member, `${v.sourceKey} ${v.marketDate}`).toBeDefined();
        expect(member!.versionId).toBe(heads[i]!.versionId);
        expect(member!.value).toBe(heads[i]!.value);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(50_000);

    // Input evidence: the collected-versus-committed differences are reported.
    const artifact = telemetry.runs[0]!.artifacts.find((a) => a.kind === "committed-input-evidence");
    expect(artifact).toBeDefined();
  },
  { timeout: 300_000 },
);
