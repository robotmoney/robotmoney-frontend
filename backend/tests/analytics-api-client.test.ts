// The analytics producer's api client keeps at most ANALYTICS_CONCURRENCY
// requests in flight (issue 1514).
//
// The producer fetches series concurrently, so its source acquisitions used to
// reach the api at once and queue in the api's analytics limiter, on the request
// path: production logged 7 to 13 source-acquisitions requests over 5 s at every
// 3-hourly run. The client now holds the line itself, so the api only ever sees
// as many requests as it runs.
//
// Issue 1765: a producer tick reads the committed inputs once for every live
// model. The client sends one `methodology` parameter per model, and the real
// analytics route, in process over its own database, answers the sorted union
// of the models' storage keys. A label that names no methodology is a 400.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { analyticsApiClient } from "../src/analytics/api-client.ts";
import { ANALYTICS_CONCURRENCY, handleAnalytics } from "../src/api/routes/analytics.ts";
import { regimeStorageKeysFor } from "../src/analytics/store/run-ledger-store.ts";
import { provisionAnalyticsToken } from "./support/automation-auth.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabasePerTest(import.meta.file);

let server: ReturnType<typeof Bun.serve>;
let inFlight = 0;
let maxInFlight = 0;
let served = 0;

beforeAll(() => {
  // A stand-in api that answers every request after a short delay and counts
  // how many it holds at once.
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Bun.sleep(40);
        served++;
        const { acquisition } = (await req.json()) as { acquisition: { id: string } };
        return Response.json({ acquisitionId: acquisition.id, replayed: false, committed: [] });
      } finally {
        inFlight--;
      }
    },
  });
});

afterAll(() => server.stop(true));

test("a burst of concurrent acquisitions reaches the api at most ANALYTICS_CONCURRENCY at a time, and every one lands", async () => {
  const client = analyticsApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: null });
  const burst = ANALYTICS_CONCURRENCY * 5;
  const results = await Promise.all(Array.from({ length: burst }, (_, i) =>
    client.saveSourceAcquisition!({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      provider: "fixture", parserVersion: "fixture:1", cacheIdentity: `burst-${i}`, requestedByRunId: null,
      events: [], fetches: [], values: [],
    })));
  expect(results.map((r) => r.acquisitionId)).toEqual(Array.from({ length: burst }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`));
  expect(served).toBe(burst);
  // The cap is reached (the burst was concurrent) and never passed.
  expect(maxInFlight).toBe(ANALYTICS_CONCURRENCY);
});

test("a failed request gives its slot back", async () => {
  const client = analyticsApiClient({ baseUrl: "http://127.0.0.1:1", token: null });
  for (let i = 0; i < ANALYTICS_CONCURRENCY + 1; i++) {
    await expect(client.loadRawHistory()).rejects.toThrow("unreachable");
  }
  // The slots are free again: a request to the stand-in still goes through.
  const ok = analyticsApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: null });
  const r = await ok.saveSourceAcquisition!({ id: "00000000-0000-0000-0000-00000000ffff", provider: "fixture", parserVersion: "fixture:1", cacheIdentity: "after", requestedByRunId: null, events: [], fetches: [], values: [] });
  expect(r.acquisitionId).toBe("00000000-0000-0000-0000-00000000ffff");
});

test("a committed read for v4 and v5 sends one methodology parameter each, and the route answers the sorted union of both models' keys; v4 with v9 is a 400", async () => {
  const v4 = regimeStorageKeysFor("v4");
  const v5 = regimeStorageKeysFor("v5");
  const union = [...new Set([...v4, ...v5])].sort();
  // Not vacuous: v5 reads keys the main line does not.
  expect(union.length).toBeGreaterThan(v4.length);
  // One committed value for every key either model reads, and one for a key neither reads.
  const OTHER = "raw_indicator_history:NOT_READ_BY_A_REGIME";
  expect(union).not.toContain(OTHER);
  await fixtureDb`
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity, knowledge_time)
    VALUES (md5('acq-1765-union')::uuid, 'fixture', 'test:1', 'union-1765', '2026-08-15T12:00:00Z'::timestamptz)`;
  await fixtureDb`
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, revision_kind, knowledge_time)
    SELECT md5('acq-1765-union')::uuid, k, '2026-08-14'::date, 1, 'initial', '2026-08-15T12:00:00Z'::timestamptz
      FROM unnest(${[...union, OTHER]}::text[]) AS k`;

  const token = await provisionAnalyticsToken();
  const asked: string[][] = [];
  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      asked.push(url.searchParams.getAll("methodology"));
      const r = await handleAnalytics(req, url);
      if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    const client = analyticsApiClient({ baseUrl: `http://127.0.0.1:${api.port}`, token });
    const keysOf = async (methodology?: string | readonly string[]) =>
      [...new Set((await client.loadCommittedInputs!("2026-08-15", undefined, methodology)).values.map((v) => v.sourceKey))].sort();
    expect(await keysOf(["v4", "v5"])).toEqual(union);
    expect(asked.at(-1)).toEqual(["v4", "v5"]);
    // Each model alone reads its own keys, and no model reads the other key.
    expect(await keysOf("v4")).toEqual([...v4].sort());
    expect(await keysOf(["v5"])).toEqual([...v5].sort());
    expect(await keysOf()).toEqual([...v4].sort());
    await expect(client.loadCommittedInputs!("2026-08-15", undefined, ["v4", "v9"])).rejects.toThrow(/HTTP 400.*methodology must be one of/);
    expect(asked.at(-1)).toEqual(["v4", "v9"]);
  } finally {
    api.stop(true);
  }
}, 60_000);
