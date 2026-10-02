// The tokenless public analytics API (issue #1095, D58), against the REAL
// ephemeral Postgres tests/preload.ts provisions. No skip, no env gate.
//
// Two layers. Most cases drive `handlePublicAnalytics` itself, the exact handler
// api/index.ts hands every /api/public/analytics/ request to, so each assertion
// is over the Response a client receives (status, headers, body). The last
// describe boots the REAL api process and goes over HTTP, because routing, CORS
// and the client-ip resolution live in index.ts and the handler cannot prove
// them.
//
// The code under test runs as `rm_app` (the shared pool's session role). The
// overwrite-event rows are produced by the migration 0056 trigger firing on a
// real overwrite, never inserted: the app roles hold no INSERT on that table, and
// a hand-inserted row would prove nothing about the trigger.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ANALYTICS_SCHEMAS, ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { withCors } from "../../src/api/cors.ts";
import {
  _resetPublicAnalyticsRateLimitForTests,
  handlePublicAnalytics,
  yahooIndicatorIds,
  yahooSourceKeys,
} from "../../src/api/routes/public-analytics.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
import { saveRawIndicatorHistory } from "../../src/analytics/store/raw-history-store.ts";
import { saveSourceAcquisition } from "../../src/analytics/store/source-ledger-store.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { fixtureDb } from "../support/fixture-db.ts";
import { bootApi, provisionAnalyticsToken, type ApiProcess } from "../support/automation-auth.ts";
import { validateJsonSchema } from "../support/json-schema.ts";

useCleanDatabase(import.meta.file);

const P = ROUTES.publicAnalytics;
const CONTRACT_SRC = join(import.meta.dir, "..", "..", "..", "contract", "src");

function schemaFor(route: string): Record<string, any> {
  const file = PUBLIC_ANALYTICS_SCHEMAS[route];
  if (!file) throw new Error(`no schema registered for ${route}`);
  return JSON.parse(readFileSync(join(CONTRACT_SRC, file), "utf8"));
}

function expectValid(route: string, body: unknown): void {
  expect(validateJsonSchema(schemaFor(route), body)).toEqual([]);
}

let ipCounter = 0;
/** A request through the handler, from a fresh ip unless one is named, so the rate limit never couples cases. */
async function get(path: string, init: RequestInit = {}, ip = `198.51.100.${++ipCounter % 250}`): Promise<Response> {
  const req = new Request(`http://api.test${path}`, init);
  return handlePublicAnalytics(req, new URL(req.url), ip);
}
async function json(path: string, init: RequestInit = {}): Promise<any> {
  const res = await get(path, init);
  expect(res.status, `GET ${path}`).toBe(200);
  return res.json();
}

/** Follow nextCursor to the end, collecting every row. */
async function pageAll(path: string, key: string, limit: number): Promise<{ rows: any[]; pages: number }> {
  const rows: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const body: any = await json(`${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    rows.push(...body[key]);
    cursor = body.nextCursor;
    pages++;
    expect(pages, "a cursor loop that never ends").toBeLessThan(100);
  } while (cursor);
  return { rows, pages };
}

const day = (n: number): string => new Date(Date.UTC(2000, 0, 1 + n)).toISOString().slice(0, 10);
const SEEDED = 1200; // more than one page at the cap of 1000
let TOKEN = "";
let expectedRaw: { date: string; indicator: string }[] = [];

beforeAll(async () => {
  TOKEN = await provisionAnalyticsToken();

  // raw_indicator_history: 1200 rows of a non-Yahoo id, 5 of a Yahoo id (VIX).
  await saveRawIndicatorHistory(
    { PUB_RAW: Array.from({ length: SEEDED }, (_, i) => ({ date: day(i), value: i + 0.5 })) },
    undefined,
    "seed",
  );
  await saveRawIndicatorHistory(
    { VIX: Array.from({ length: 5 }, (_, i) => ({ date: day(i), value: 18 + i })) },
    undefined,
    "seed",
  );
  expectedRaw = (
    await fixtureDb<{ date: string; indicator: string }[]>`
      SELECT date::text AS date, indicator FROM raw_indicator_history WHERE indicator = 'PUB_RAW' ORDER BY date`
  ).map((r) => ({ date: r.date, indicator: r.indicator }));

  // asset_prices: 1200 rows of a gecko-sourced symbol with a long config identity
  // (so a 1000-row page is over 256 KB), plus two Yahoo-labelled rows.
  await fixtureDb`
    INSERT INTO asset_prices (price_date, symbol, time_basis, price_usd, currency, source, pool_key, token_address,
                              observed_at, fetched_at, config_identity)
    SELECT DATE '2000-01-01' + g, 'PUBPX', 'utc-daily-close', 1 + g / 100.0, 'USD', 'geckoterminal', 'pool-' || g,
           '0xabc', TIMESTAMPTZ '2000-01-01 23:59:59+00' + g * INTERVAL '1 day', now(), repeat('c', 200)
    FROM generate_series(0, ${SEEDED - 1}) g`;
  await fixtureDb`
    INSERT INTO asset_prices (price_date, symbol, time_basis, price_usd, currency, source, observed_at, fetched_at, config_identity)
    VALUES ('2000-01-01', 'YAHOOPX', 'utc-daily-close', 5, 'USD', 'yahoo', now(), now(), 'cfg'),
           ('2000-01-02', 'YAHOOPX2', 'utc-daily-close', 5, 'USD', 'Yahoo-Finance', now(), now(), 'cfg')`;
}, 60_000);

beforeEach(() => _resetPublicAnalyticsRateLimitForTests());

describe("every route: 200 with no Authorization header, a body that validates against its contract schema", () => {
  test("raw-history", async () => {
    const res = await get(P.rawHistory);
    expect(res.status).toBe(200);
    expect(res.headers.get("Authorization")).toBeNull();
    const body = await res.json();
    expectValid(P.rawHistory, body);
    expect(body.schemaVersion).toBe(1);
    expect(body.rows.length).toBe(100); // the default limit
  });

  test("asset-prices", async () => {
    const body = await json(P.assetPrices);
    expectValid(P.assetPrices, body);
    expect(body.rows[0]).toMatchObject({ symbol: "PUBPX", time_basis: "utc-daily-close", currency: "USD", source: "geckoterminal" });
  });

  test("overwrite-events (an empty page is still a valid body)", async () => {
    const body = await json(P.overwriteEvents);
    expectValid(P.overwriteEvents, body);
  });

  test("vintages (an empty page is still a valid body)", async () => {
    const body = await json(`${P.vintages}?run_key=00000000-0000-4000-8000-000000000000`);
    expectValid(P.vintages, body);
    expect(body.vintages).toEqual([]);
  });

  test("the schema checker is not vacuous: a body missing a required field, or with a wrong type, fails", () => {
    const good = { schemaVersion: 1, limit: 1, excludedProviders: [], rows: [], nextCursor: null };
    expect(validateJsonSchema(schemaFor(P.rawHistory), good)).toEqual([]);
    expect(validateJsonSchema(schemaFor(P.rawHistory), { ...good, schemaVersion: 2 })).not.toEqual([]);
    expect(validateJsonSchema(schemaFor(P.rawHistory), { ...good, nextCursor: 7 })).not.toEqual([]);
    const { nextCursor: _omit, ...missing } = good;
    expect(validateJsonSchema(schemaFor(P.rawHistory), missing)).not.toEqual([]);
    expect(
      validateJsonSchema(schemaFor(P.rawHistory), { ...good, rows: [{ date: "2000-1-1", indicator: "X", value: 1, source: "s" }] }),
    ).not.toEqual([]);
  });
});

describe("GET only", () => {
  test("POST, PUT, PATCH, DELETE and HEAD under the prefix answer 405 with Allow: GET, on every route", async () => {
    for (const route of Object.values(P)) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
        const res = await get(route, { method, body: method === "POST" || method === "PUT" || method === "PATCH" ? "{}" : undefined });
        expect(res.status, `${method} ${route}`).toBe(405);
        expect(res.headers.get("Allow")).toBe("GET");
        expect(res.headers.get("Cache-Control")).toBe("no-store");
      }
    }
  });

  test("an unknown path under the prefix is a 404, and a non-GET to it is still a 405", async () => {
    expect((await get("/api/public/analytics/nope")).status).toBe(404);
    expect((await get("/api/public/analytics/nope", { method: "POST", body: "{}" })).status).toBe(405);
  });

  test("a request with a store token gets exactly the body a request without one gets", async () => {
    for (const route of [P.rawHistory, P.assetPrices, P.overwriteEvents, P.vintages]) {
      const anon = await (await get(`${route}?limit=7`)).text();
      const authed = await (await get(`${route}?limit=7`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
      expect(authed, route).toBe(anon);
    }
  });
});

describe("limit and cursor", () => {
  test("raw-history: limit=1001 is clamped to 1000 and returns a cursor, and following it yields the seeded set exactly once", async () => {
    const first = await json(`${P.rawHistory}?indicator=PUB_RAW&limit=1001`);
    expect(first.limit).toBe(1000);
    expect(first.rows).toHaveLength(1000);
    expect(first.nextCursor).toBeTruthy();

    const { rows, pages } = await pageAll(`${P.rawHistory}?indicator=PUB_RAW`, "rows", 1001);
    expect(pages).toBe(2);
    expect(rows.map((r) => ({ date: r.date, indicator: r.indicator }))).toEqual(expectedRaw);
    expect(new Set(rows.map((r) => r.date)).size).toBe(SEEDED);
    expect(rows[5]).toEqual({ date: day(5), indicator: "PUB_RAW", value: 5.5, source: "seed" });
  });

  test("asset-prices: the same clamp, cursor and exactly-once guarantee", async () => {
    const first = await json(`${P.assetPrices}?symbol=PUBPX&limit=1001`);
    expect(first.limit).toBe(1000);
    expect(first.rows).toHaveLength(1000);
    expect(first.nextCursor).toBeTruthy();

    const { rows } = await pageAll(`${P.assetPrices}?symbol=PUBPX`, "rows", 1001);
    expect(rows).toHaveLength(SEEDED);
    expect(rows.map((r) => r.price_date)).toEqual(Array.from({ length: SEEDED }, (_, i) => day(i)));
  });

  test("a page ends with a null cursor exactly when the data does", async () => {
    const exact = await json(`${P.rawHistory}?indicator=PUB_RAW&limit=1000&from=${day(200)}`);
    expect(exact.rows).toHaveLength(1000);
    expect(exact.nextCursor).toBeNull(); // 1000 rows remain from day 200, no more
  });

  test("from and to bound the dates, both inclusive", async () => {
    const body = await json(`${P.rawHistory}?indicator=PUB_RAW&from=${day(10)}&to=${day(12)}`);
    expect(body.rows.map((r: any) => r.date)).toEqual([day(10), day(11), day(12)]);
  });

  test("a bad limit, date, cursor or include is a 400 that names the problem", async () => {
    for (const q of ["limit=0", "limit=-1", "limit=abc", "limit=1.5", "from=2000-13-01", "to=yesterday", "cursor=%%%", "cursor=e30"]) {
      const res = await get(`${P.rawHistory}?${q}`);
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as any).error).toBeTruthy();
    }
    expect((await get(`${P.vintages}?include=everything`)).status).toBe(400);
    expect((await get(`${P.vintages}?include=members`)).status).toBe(400);
    expect((await get(`${P.overwriteEvents}?table_name=users`)).status).toBe(400);
  });
});

describe("Yahoo-sourced rows are withheld (D58)", () => {
  test("the withheld set is derived from the registry, not configured", () => {
    expect(yahooIndicatorIds()).toContain("VIX");
    expect(yahooIndicatorIds()).not.toContain("T10Y2Y"); // fred
    expect(yahooSourceKeys()).toContain("raw_indicator_history:VIX");
    expect(yahooSourceKeys()).toContain("backtest:^GSPC"); // a D56 tolerance key, not in the registry
    expect(yahooSourceKeys()).not.toContain("raw_indicator_history:T10Y2Y");
  });

  test("raw-history never serves a Yahoo indicator, even when asked for it by name", async () => {
    const all = await pageAll(P.rawHistory, "rows", 1000);
    expect(all.rows.some((r) => r.indicator === "VIX")).toBe(false);
    const named = await json(`${P.rawHistory}?indicator=VIX`);
    expect(named.rows).toEqual([]);
    expect(named.excludedProviders).toEqual(["yahoo"]);
    // The rows are really there: it is the route that withholds them.
    const [{ n }] = await fixtureDb`SELECT count(*)::int AS n FROM raw_indicator_history WHERE indicator = 'VIX'`;
    expect(n).toBe(5);
  });

  test("asset-prices never serves a row whose provider is yahoo, whatever the casing or suffix", async () => {
    const all = await pageAll(P.assetPrices, "rows", 1000);
    expect(all.rows.filter((r) => /yahoo/i.test(r.source))).toEqual([]);
    expect((await json(`${P.assetPrices}?symbol=YAHOOPX`)).rows).toEqual([]);
    expect((await json(`${P.assetPrices}?symbol=YAHOOPX2`)).rows).toEqual([]);
  });
});

describe("overwrite-events", () => {
  test("an overwrite fires the 0056 trigger and the event appears; a Yahoo indicator's event does not", async () => {
    const indicator = "PUB_OVERWRITE";
    await saveRawIndicatorHistory({ [indicator]: [{ date: "2041-01-02", value: 10 }] }, undefined, "seed");
    await saveRawIndicatorHistory({ [indicator]: [{ date: "2041-01-02", value: 12.5 }] }, undefined, "live");
    // And a Yahoo-sourced overwrite, well outside the 1e-6 tolerance, so it records an event too.
    await saveRawIndicatorHistory({ VIX: [{ date: day(0), value: 99 }] }, undefined, "live");
    const [{ n: vixEvents }] = await fixtureDb`
      SELECT count(*)::int AS n FROM analytics_overwrite_events
      WHERE table_name = 'raw_indicator_history' AND natural_key->>'indicator' = 'VIX'`;
    expect(vixEvents, "the trigger recorded the VIX overwrite").toBeGreaterThan(0);

    const { rows: events } = await pageAll(P.overwriteEvents, "events", 1000);
    const mine = events.filter((e) => e.natural_key.indicator === indicator);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      table_name: "raw_indicator_history",
      operation: "update",
      natural_key: { date: "2041-01-02", indicator },
      previous_row: { date: "2041-01-02", indicator, value: 10, source: "seed" },
      replacement_row: { date: "2041-01-02", indicator, value: 12.5, source: "live" },
    });
    expect(events.some((e) => e.natural_key.indicator === "VIX")).toBe(false);
    expectValid(P.overwriteEvents, await json(P.overwriteEvents));

    // Filtered by table, and paged by id: ids strictly increase across pages.
    const filtered = await json(`${P.overwriteEvents}?table_name=raw_indicator_history&limit=1`);
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events.every((e: any) => e.table_name === "raw_indicator_history")).toBe(true);
    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("the api's role may READ the table and nothing else, and no runtime role can write it, so the only rows are the trigger's (migration 0093)", async () => {
    const privilege = async (role: string, p: string): Promise<boolean> => {
      const [r] = await fixtureDb<{ ok: boolean }[]>`SELECT has_table_privilege(${role}, 'public.analytics_overwrite_events', ${p}) AS ok`;
      return r!.ok;
    };
    for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      expect(await privilege("rm_app", p), `rm_app ${p}`).toBe(false);
      expect(await privilege("rm_worker", p), `rm_worker ${p}`).toBe(false);
    }
    expect(await privilege("rm_app", "SELECT")).toBe(true);
    expect(await privilege("rm_worker", "SELECT")).toBe(false);
  });
});

describe("vintages", () => {
  const SOURCE_KEY_A = "series:pub-a";
  const SOURCE_KEY_B = "series:pub-b";
  const YAHOO_KEY = "raw_indicator_history:VIX";
  let runKey = "";

  async function acquire(sourceKey: string, count: number, offset: number): Promise<void> {
    await saveSourceAcquisition({
      id: crypto.randomUUID(),
      provider: "fixture",
      parserVersion: "fixture:1",
      cacheIdentity: `pub-${sourceKey}-${offset}`,
      requestedByRunId: null,
      events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }],
      fetches: [],
      values: Array.from({ length: count }, (_, i) => ({
        sourceKey, marketDate: day(offset + i), marketInstant: null, value: i + 1, provenance: "live",
      })),
    });
  }

  beforeAll(async () => {
    await acquire(SOURCE_KEY_A, 6, 0);
    await acquire(YAHOO_KEY, 3, 0);
    await acquire(SOURCE_KEY_B, 4, 0);
    runKey = crypto.randomUUID();
    const call = (path: string, body: unknown) =>
      handleAnalytics(
        new Request(`http://x${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body),
        }),
        new URL(`http://x${path}`),
      );
    const begun = await call(ROUTES.analytics.runs, {
      run: {
        runKey, asof: "2026-05-15", toolId: "pub-test", sourceLabel: "fixture",
        methodology: { toolId: "pub-test", versionLabel: "v-pub", config: { k: "v" } }, buildIdentity: "pub-build",
      },
    });
    expect(begun!.status).toBe(200);
    const { runId, methodologyVersionId } = begun!.body as { runId: string; methodologyVersionId: string };
    const frozen = await call(ROUTES.analytics.vintages, {
      vintage: {
        runId, toolId: "pub-test", knowledgeTimeCutoff: "2099-01-01T00:00:00.000Z", marketTimeCutoff: "2099-01-01",
        methodologyVersionId, buildIdentity: "pub-build",
      },
    });
    expect(frozen!.status).toBe(200);
  }, 30_000);

  test("carries run_key, knowledge_time_cutoff, market_time_cutoff, manifest_digest and member_count", async () => {
    const body = await json(`${P.vintages}?run_key=${runKey}`);
    expectValid(P.vintages, body);
    expect(body.vintages).toHaveLength(1);
    const [v] = body.vintages;
    expect(v).toMatchObject({
      run_key: runKey,
      tool_id: "pub-test",
      asof: "2026-05-15",
      source_label: "fixture",
      knowledge_time_cutoff: "2099-01-01T00:00:00.000Z",
      market_time_cutoff: "2099-01-01",
      build_identity: "pub-build",
      methodology: { tool_id: "pub-test", version_label: "v-pub" },
    });
    expect(v.manifest_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(v.methodology.config_digest).toMatch(/^[0-9a-f]{64}$/);
    // The frozen count, before any withholding: 6 + 3 + 4.
    expect(v.member_count).toBe(13);
    expect(v.members).toBeUndefined();
  });

  test("members are expanded from the stored id ranges, one row per source_value_versions id, with Yahoo-backed keys withheld", async () => {
    const [{ id: vintageId }] = await fixtureDb<{ id: string }[]>`
      SELECT v.id::text AS id FROM analytics_data_vintages v JOIN analytics_ledger_runs r ON r.id = v.run_id WHERE r.run_key = ${runKey}`;
    const stored = await fixtureDb<{ source_key: string; first: string; last: string | null }[]>`
      SELECT source_key, source_value_version_id::text AS first, last_source_value_version_id::text AS last
      FROM analytics_vintage_members WHERE vintage_id = ${vintageId}::bigint ORDER BY source_value_version_id`;
    // The compaction is real here: a run of consecutive ids is ONE row.
    expect(stored.some((m) => m.last !== null), "at least one stored member row is a range").toBe(true);
    expect(stored.length).toBeLessThan(13);

    const expected: { source_key: string; source_value_version_id: number }[] = [];
    for (const m of stored) {
      if (m.source_key === YAHOO_KEY) continue;
      for (let id = Number(m.first); id <= Number(m.last ?? m.first); id++) expected.push({ source_key: m.source_key, source_value_version_id: id });
    }
    expect(expected).toHaveLength(10); // 6 + 4, the 3 Yahoo ids withheld

    const path = `${P.vintages}?run_key=${runKey}&tool_id=pub-test&include=members`;
    const whole = await json(path);
    expectValid(P.vintages, whole);
    expect(whole.vintages[0].members.rows).toEqual(expected);
    expect(whole.vintages[0].members.nextCursor).toBeNull();
    expect(whole.nextCursor).toBeNull();

    // Paged by the same limit/cursor: 3 at a time, every id once, in order.
    const got: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: any = await json(`${path}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      got.push(...page.vintages[0].members.rows);
      cursor = page.vintages[0].members.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBe(4);
    expect(got).toEqual(expected);
    expect(got.some((m) => m.source_key === YAHOO_KEY)).toBe(false);
  });

  test("vintages page by id with a cursor and filter by tool_id", async () => {
    const byTool = await json(`${P.vintages}?tool_id=pub-test`);
    expect(byTool.vintages.map((v: any) => v.run_key)).toEqual([runKey]);
    expect((await json(`${P.vintages}?tool_id=no-such-tool`)).vintages).toEqual([]);
    const paged = await pageAll(P.vintages, "vintages", 1);
    expect(paged.rows.map((v) => v.run_key)).toContain(runKey);
  });
});

describe("transport: Cache-Control, ETag, 304, gzip", () => {
  test("a success carries Cache-Control: public, max-age=300 and an ETag, and a matching If-None-Match is a 304", async () => {
    const res = await get(`${P.rawHistory}?limit=5`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Vary")).toContain("Accept-Encoding");
    const etag = res.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);

    const again = await get(`${P.rawHistory}?limit=5`);
    expect(again.headers.get("ETag")).toBe(etag); // same data, same tag

    const cond = await get(`${P.rawHistory}?limit=5`, { headers: { "If-None-Match": etag } });
    expect(cond.status).toBe(304);
    expect(await cond.text()).toBe("");
    expect(cond.headers.get("ETag")).toBe(etag);
    expect(cond.headers.get("Cache-Control")).toBe("public, max-age=300");

    expect((await get(`${P.rawHistory}?limit=5`, { headers: { "If-None-Match": `"other", ${etag}` } })).status).toBe(304);
    expect((await get(`${P.rawHistory}?limit=5`, { headers: { "If-None-Match": "*" } })).status).toBe(304);
    expect((await get(`${P.rawHistory}?limit=5`, { headers: { "If-None-Match": 'W/"stale"' } })).status).toBe(200);
    expect((await get(`${P.rawHistory}?limit=6`, { headers: { "If-None-Match": etag } })).status).toBe(200); // different body
  });

  test("errors are not cacheable", async () => {
    const res = await get(`${P.rawHistory}?limit=0`);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("ETag")).toBeNull();
  });

  test("a 300 KB body is served gzip-encoded with its ETag, and a conditional request with that ETag returns 304", async () => {
    const path = `${P.assetPrices}?symbol=PUBPX&limit=1000`;
    const plain = await get(path);
    const identity = new Uint8Array(await plain.arrayBuffer());
    expect(plain.headers.get("Content-Encoding"), "no Accept-Encoding, no encoding").toBeNull();
    expect(identity.length).toBeGreaterThan(300 * 1024);

    const gz = await get(path, { headers: { "Accept-Encoding": "gzip, deflate, br" } });
    expect(gz.status).toBe(200);
    expect(gz.headers.get("Content-Encoding")).toBe("gzip");
    const etag = gz.headers.get("ETag")!;
    expect(etag).toBe(plain.headers.get("ETag")!);
    const wire = new Uint8Array(await gz.arrayBuffer());
    expect(wire.length).toBeLessThan(identity.length / 2);
    expect(Buffer.from(Bun.gunzipSync(wire))).toEqual(Buffer.from(identity));
    expectValid(P.assetPrices, JSON.parse(new TextDecoder().decode(Bun.gunzipSync(wire))));

    const cond = await get(path, { headers: { "Accept-Encoding": "gzip", "If-None-Match": etag } });
    expect(cond.status).toBe(304);
    expect(cond.headers.get("ETag")).toBe(etag);

    // gzip;q=0 is a refusal; a small body is never encoded.
    expect((await get(path, { headers: { "Accept-Encoding": "gzip;q=0" } })).headers.get("Content-Encoding")).toBeNull();
    expect((await get(`${P.assetPrices}?limit=2`, { headers: { "Accept-Encoding": "gzip" } })).headers.get("Content-Encoding")).toBeNull();
  });
});

describe("rate limit", () => {
  test("the 101st request in the window from one ip is a 429 with Retry-After; another ip is unaffected", async () => {
    const ip = "203.0.113.77";
    for (let i = 1; i <= 100; i++) expect((await get(`${P.rawHistory}?limit=1`, {}, ip)).status, `request ${i}`).toBe(200);
    const limited = await get(`${P.rawHistory}?limit=1`, {}, ip);
    expect(limited.status).toBe(429);
    const retry = Number(limited.headers.get("Retry-After"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(((await limited.json()) as any).error).toBeTruthy();

    expect((await get(`${P.rawHistory}?limit=1`, {}, "203.0.113.78")).status).toBe(200);
  });

  test("the budget is shared across the four routes, and a 405 counts against it", async () => {
    const ip = "203.0.113.90";
    const routes = Object.values(P);
    for (let i = 0; i < 100; i++) {
      const res = await get(`${routes[i % 4]}?limit=1`, i % 25 === 0 ? { method: "POST" } : {}, ip);
      expect([200, 405]).toContain(res.status);
    }
    expect((await get(P.assetPrices, {}, ip)).status).toBe(429);
    expect((await get(P.vintages, { method: "POST" }, ip)).status).toBe(429);
  });
});

describe("CORS", () => {
  test("a cross-origin GET from a foreign origin receives Access-Control-Allow-Origin: *", async () => {
    const req = new Request(`http://api.test${P.rawHistory}?limit=1`, { headers: { Origin: "https://elsewhere.example" } });
    const res = withCors(await handlePublicAnalytics(req, new URL(req.url), "198.51.100.200"), req, new URL(req.url).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});

describe("through the real api process", () => {
  let api: ApiProcess;
  beforeAll(async () => {
    api = await bootApi({ env: { RM_ENV: "ephemeral" } });
  }, 90_000);
  afterAll(() => api?.stop());

  test("GET answers 200 over HTTP as rm_app with no token, cross-origin readable, and the schema holds", async () => {
    for (const route of Object.values(P)) {
      const res = await fetch(`${api.base}${route}?limit=3`, { headers: { Origin: "https://elsewhere.example" } });
      expect(res.status, route).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
      expectValid(route, await res.json());
    }
  }, 30_000);

  test("every write method is a 405 over HTTP, a preflight for a GET is allowed, and a token changes nothing", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${api.base}${P.rawHistory}`, { method, body: "{}", headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(res.status, method).toBe(405);
    }
    const preflight = await fetch(`${api.base}${P.rawHistory}`, {
      method: "OPTIONS",
      headers: { Origin: "https://elsewhere.example", "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const anon = await (await fetch(`${api.base}${P.assetPrices}?limit=4`)).text();
    const authed = await (await fetch(`${api.base}${P.assetPrices}?limit=4`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
    expect(authed).toBe(anon);
  }, 30_000);

  test("the limiter keys on the resolved client ip: with TRUST_PROXY=1, CF-Connecting-IP picks the bucket", async () => {
    const proxied = await bootApi({ env: { RM_ENV: "ephemeral", TRUST_PROXY: "1" } });
    try {
      const hit = (headers: Record<string, string>) => fetch(`${proxied.base}${P.rawHistory}?limit=1`, { headers });
      for (let i = 0; i < 100; i++) expect((await hit({ "CF-Connecting-IP": "203.0.113.5" })).status).toBe(200);
      const limited = await hit({ "CF-Connecting-IP": "203.0.113.5" });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      // A different CF-Connecting-IP is a different client.
      expect((await hit({ "CF-Connecting-IP": "203.0.113.6" })).status).toBe(200);
    } finally {
      proxied.stop();
    }
  }, 120_000);
});
