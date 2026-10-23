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
import { SERIES_MAPPING, inputHistoryFromStorage, selectConsumerObservations } from "../src/analytics/extras.ts";
import { parseRawHistory, toHistory } from "../../packages/analyst-sdk/src/input/load.ts";
import { buildReport, runRegime } from "../../packages/analyst-sdk/src/run.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useCleanDatabase } from "./support/clean-db.ts";

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
const GOLDEN_SHA256 = "119b34cc561c59b33e53d27534ff64666e3cf30ee161684959517aee7545a8ce";

test(
  "a frozen regime vintage reloads offline with unchanged membership and rebuilds the golden report bytes through the D74 mapping",
  async () => {
    const goldenText = readFileSync(join(SDK_TESTS, "golden", "regime-report.json"), "utf8");
    expect(createHash("sha256").update(goldenText).digest("hex")).toBe(GOLDEN_SHA256);
    const fixture = toHistory(parseRawHistory(readFileSync(join(SDK_TESTS, "fixtures", "raw-indicator-history.csv"), "utf8")));
    const keyOf = new Map(SERIES_MAPPING.map((m) => [m.inputId, m.storageKey]));
    const sink = { saveSourceAcquisition };
    for (const id of Object.keys(fixture).sort()) {
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
    expect(original.filter((m) => mapped.has(m.sourceKey)).length).toBe(Object.values(fixture).reduce((n, pts) => n + pts.length, 0));

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
