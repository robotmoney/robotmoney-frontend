// The analytics producer's api client keeps at most ANALYTICS_CONCURRENCY
// requests in flight (issue 1514).
//
// The producer fetches series concurrently, so its source acquisitions used to
// reach the api at once and queue in the api's analytics limiter, on the request
// path: production logged 7 to 13 source-acquisitions requests over 5 s at every
// 3-hourly run. The client now holds the line itself, so the api only ever sees
// as many requests as it runs.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { analyticsApiClient } from "../src/analytics/api-client.ts";
import { ANALYTICS_CONCURRENCY } from "../src/api/routes/analytics.ts";

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
