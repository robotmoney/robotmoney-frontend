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
import { loadFrozenVintage } from "../src/analytics/store/run-ledger-store.ts";
import { buildVintageManifest } from "../src/analytics/run-ledger.ts";
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
    const [{ n: memberRows }] = await sql`
      SELECT COUNT(*)::int AS n FROM analytics_vintage_members WHERE vintage_id = ${original.vintageId}::bigint`;
    expect(memberRows).toBeGreaterThan(0);

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
