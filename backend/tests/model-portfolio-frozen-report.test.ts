// Issue 1398: collecting the model portfolio inputs changes no regime number.
//
// runAnalytics runs the frozen regime fixture (tests/fixtures/regime, the same
// inputs regime-sdk-equivalence.test.ts uses) twice: once from a source that
// collects nothing, and once from a source that also runs the REAL
// liveDataSource.collectModelPortfolioInputs over recorded responses and writes
// the series into the source ledger. The run's frozen report bytes and its
// regime snapshot rows must be byte-identical. Once that collection (the last
// extract step) returns, globalThis.fetch is a thrower that counts calls: any
// HTTP after extract fails the test. The SDK side of the same claim is
// packages/analyst-sdk/tests/model-portfolio.test.ts (golden report bytes with
// the series in the input).
import { afterAll, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import type { Point } from "../src/analytics/types.ts";
import type { Indicator } from "../src/analytics/analyze/indicators.ts";
import { liveDataSource, type AnalyticsDataSource, type ResearchInputs } from "../src/analytics/access/data-source.ts";
import { TOP7 } from "../src/analytics/analyze/research-signals.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { loadRawIndicatorHistory, loadJsonGz } from "./fixtures/regime/load.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { inventoryCollection, loadInventory, collectedByInventory } from "../src/analytics/extract/model-portfolio.ts";

useCleanDatabase(import.meta.file);

const originalFetch = globalThis.fetch;
const originalTtl = process.env.HTTP_FETCH_CACHE_TTL_MS;
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalTtl === undefined) delete process.env.HTTP_FETCH_CACHE_TTL_MS;
  else process.env.HTTP_FETCH_CACHE_TTL_MS = originalTtl;
});

const MP_FIX = new URL("../../packages/analyst-sdk/tests/fixtures/extract/model-portfolio/", import.meta.url);
// Issue 1514: the research-series inventory is collected in the same step.
const RS_FIX = new URL("../../packages/analyst-sdk/tests/fixtures/extract/research-series/", import.meta.url);
const gz = async (dir: URL, name: string) => new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await Bun.file(new URL(name, dir)).arrayBuffer())));
const modelPortfolioIds = new Set(loadInventory().series.filter(collectedByInventory).map((s) => s.id));
const collected = inventoryCollection();
const bodies: [string, string][] = [];
for (const s of collected) {
  const fragment = s.provider === "yahoo" ? `/v8/finance/chart/${encodeURIComponent(s.symbol)}?` : `yields.llama.fi/chart/${s.symbol}`;
  bodies.push([fragment, await gz(modelPortfolioIds.has(s.id) ? MP_FIX : RS_FIX, `${s.id.replace(":", "-")}.json.gz`)]);
}

let callsAfterExtract = 0;
const thrower = (() => {
  callsAfterExtract++;
  throw new Error("HTTP after extract");
}) as unknown as typeof fetch;

type Rows = Record<string, Point[]>;
const snap: any = await loadJsonGz("regime-snapshot.json.gz");
const asof: string = snap.asof;
const raw = (await loadRawIndicatorHistory()) as Rows;
const ex: any = await loadJsonGz("regime-extras.json.gz");

function fixtureSource(collect: boolean): AnalyticsDataSource {
  const research: ResearchInputs = { btc: [], qqq: [], spy: [], rsp: [], top7: TOP7.map(() => [] as Point[]), mna: [], margin: [], conf: [] };
  const source: AnalyticsDataSource = {
    async fetchIndicators(indicators: Indicator[]) {
      const out: Rows = {};
      for (const ind of indicators) out[ind.id] = (raw[ind.id] ?? []).map((p) => ({ ...p }));
      return out;
    },
    async fetchResearchInputs() { return research; },
    async fetchBacktestExtras() { return { spx: ex.spx, eth: ex.eth, tbill3m: ex.tbill3m }; },
  };
  if (collect) {
    source.collectModelPortfolioInputs = async (logger, sink, runId) => {
      process.env.HTTP_FETCH_CACHE_TTL_MS = "0";
      globalThis.fetch = ((input: URL | RequestInfo) => {
        const hit = bodies.find(([f]) => String(input).includes(f));
        return hit ? Promise.resolve(new Response(hit[1])) : Promise.reject(new Error(`unrecorded URL ${String(input)}`));
      }) as typeof fetch;
      try {
        return await liveDataSource.collectModelPortfolioInputs!(logger, sink, runId);
      } finally {
        globalThis.fetch = thrower;
      }
    };
  }
  return source;
}

async function run(collect: boolean) {
  globalThis.fetch = thrower;
  let captured: { reportBytes: Uint8Array; rows: unknown[] } | null = null;
  const persistence: AnalyticsPersistence = {
    ...directAnalyticsPersistence,
    async submitTerminalRunPackage(input) {
      expect(input.status).toBe("succeeded");
      captured = { reportBytes: input.reportBytes!, rows: [...(input.regimeSnapshots ?? [])] };
      return directAnalyticsPersistence.submitTerminalRunPackage(input);
    },
  };
  await runAnalytics(asof, "regime", fixtureSource(collect), persistence, noopTelemetrySink);
  expect(captured).not.toBeNull();
  return captured!;
}

test("issue 1398: the frozen regime report is byte-identical with and without model portfolio collection, and nothing fetches after extract", async () => {
  const before = await run(false);
  const after = await run(true);

  // The collection really ran and wrote the series into the ledger.
  const [{ n }] = await sql`SELECT count(DISTINCT source_key)::int AS n FROM source_value_versions WHERE source_key = ANY(${collected.map((c) => c.storageKey)}::text[])`;
  expect(n).toBe(collected.length);

  expect(before.reportBytes.length).toBeGreaterThan(100);
  expect(Buffer.from(after.reportBytes).equals(Buffer.from(before.reportBytes))).toBe(true);
  expect(before.rows.length).toBeGreaterThan(2900);
  expect(JSON.stringify(after.rows)).toBe(JSON.stringify(before.rows));
  expect(callsAfterExtract).toBe(0);
}, 600_000);
