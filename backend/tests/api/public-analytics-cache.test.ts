// Issue 1629: the api keeps its own public analytics answers in process
// (docs/technical/web-serving-architecture.md §3.4), against the REAL ephemeral
// Postgres tests/preload.ts provisions. No skip, no env gate.
//
// What is proved here:
//   - a second GET of one URL is a HIT and runs no database query;
//   - twenty concurrent GETs of one cold URL run exactly one database query;
//   - a new api process answers MISS for a URL the old one stored;
//   - an entry is never served past its max-age (a fake clock);
//   - the store never holds more than its byte cap;
//   - a no-store answer (an error or a refusal) is never stored.
//
// Queries are counted two ways. Every public analytics statement runs inside
// publicRead, which takes one slot of publicQueryGate, so the gate's acquire
// calls count the public reads at once. Postgres's own scan counter for
// raw_indicator_history counts what reached the database, read once the
// backends have flushed their statistics.
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import {
  _publicAnalyticsCacheForTests,
  _resetPublicAnalyticsCacheForTests,
  _resetPublicAnalyticsRateLimitForTests,
  handlePublicAnalytics,
} from "../../src/api/routes/public-analytics.ts";
import { type CachedAnswer, createAnswerCache, publicQueryGate, storableSeconds } from "../../src/api/public-analytics-limits.ts";
import { saveRawIndicatorHistory } from "../../src/analytics/store/raw-history-store.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { fixtureDb } from "../support/fixture-db.ts";
import { bootApi } from "../support/automation-auth.ts";

useCleanDatabase(import.meta.file);

const P = ROUTES.publicAnalytics;
const URL_A = `${P.rawHistory}?indicator=CACHE&limit=5`;

let ipCounter = 0;
async function get(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`http://api.test${path}`, init);
  return handlePublicAnalytics(req, new URL(req.url), `198.51.100.${++ipCounter % 250}`);
}

/** Index and sequential scans of raw_indicator_history Postgres has recorded. */
async function scans(): Promise<number> {
  const [r] = await fixtureDb<{ n: string }[]>`
    SELECT (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text AS n
    FROM pg_stat_all_tables WHERE relname = 'raw_indicator_history'`;
  return Number(r!.n);
}
/** The scan counter once every backend has flushed (they flush within ~10 s of going idle). */
async function settledScans(): Promise<number> {
  let last = await scans();
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(1000);
    const now = await scans();
    if (now === last && i >= 11) return now;
    last = now;
  }
  return last;
}

let acquire: ReturnType<typeof spyOn>;

beforeAll(async () => {
  await saveRawIndicatorHistory({ CACHE: Array.from({ length: 8 }, (_, i) => ({ date: `2003-01-0${i + 1}`, value: i })) }, undefined, "seed");
}, 60_000);

beforeEach(() => {
  _resetPublicAnalyticsRateLimitForTests();
  _resetPublicAnalyticsCacheForTests();
  acquire = spyOn(publicQueryGate, "acquire");
});
afterEach(() => acquire.mockRestore());

describe("the store answers repeats without the database", () => {
  test("a second GET of one URL is a HIT and runs no database query", async () => {
    const first = await get(URL_A);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache-Status")).toBe("MISS");
    const firstBody = await first.text();
    expect(acquire).toHaveBeenCalledTimes(1);

    // A new row inside the page the URL names: a database read would see it.
    await saveRawIndicatorHistory({ CACHE: [{ date: "2002-12-31", value: 99 }] }, undefined, "seed");
    const base = await settledScans();
    for (let i = 0; i < 5; i++) {
      const again = await get(URL_A);
      expect(again.status).toBe(200);
      expect(again.headers.get("X-Cache-Status")).toBe("HIT");
      expect(Number(again.headers.get("Age"))).toBeGreaterThanOrEqual(0);
      expect(again.headers.get("ETag")).toBe(first.headers.get("ETag"));
      expect(await again.text()).toBe(firstBody);
    }
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(await settledScans()).toBe(base);

    // The control: an empty store reads the database and sees the new row.
    _resetPublicAnalyticsCacheForTests();
    const fresh = await get(URL_A);
    expect(fresh.headers.get("X-Cache-Status")).toBe("MISS");
    expect(((await fresh.json()) as any).rows[0].date).toBe("2002-12-31");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(await settledScans()).toBeGreaterThan(base);
  }, 120_000);

  test("a HIT still answers If-None-Match with 304 and gzip by the request, from one stored answer", async () => {
    const first = await get(URL_A, { headers: { "Accept-Encoding": "identity" } });
    const etag = first.headers.get("ETag")!;
    const cond = await get(URL_A, { headers: { "If-None-Match": etag } });
    expect(cond.status).toBe(304);
    expect(cond.headers.get("X-Cache-Status")).toBe("HIT");
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  test("twenty concurrent GETs of one cold URL run exactly one database query", async () => {
    const url = `${P.rawHistory}?indicator=CACHE&limit=7`;
    const base = await settledScans();
    const answers = await Promise.all(Array.from({ length: 20 }, () => get(url)));
    const bodies = new Set<string>();
    for (const res of answers) {
      // The gate has two slots and refuses a third at once: twenty 200s are only possible if they shared one read.
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Cache-Status")).toBe("MISS");
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    const twenty = (await settledScans()) - base;

    // The same URL from an empty store, once: what one query costs in scans.
    _resetPublicAnalyticsCacheForTests();
    const before = await settledScans();
    expect((await get(url)).status).toBe(200);
    const one = (await settledScans()) - before;
    expect(one).toBeGreaterThan(0);
    expect(twenty).toBe(one);
  }, 180_000);
});

describe("expiry: never past the route's max-age (fake clock)", () => {
  test("a list (max-age=300) is a HIT until 300 s and a MISS that reads again at 300 s", async () => {
    let now = 1_000_000;
    _resetPublicAnalyticsCacheForTests({ now: () => now });
    expect((await get(URL_A)).headers.get("X-Cache-Status")).toBe("MISS");
    now += 299_999;
    const late = await get(URL_A);
    expect(late.headers.get("X-Cache-Status")).toBe("HIT");
    expect(late.headers.get("Age")).toBe("299");
    expect(acquire).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await get(URL_A)).headers.get("X-Cache-Status")).toBe("MISS");
    expect(acquire).toHaveBeenCalledTimes(2);
    // Stored again from the read at 300 s.
    expect((await get(URL_A)).headers.get("X-Cache-Status")).toBe("HIT");
  });

  test("the store itself drops an entry at its max-age", async () => {
    let now = 0;
    const cache = createAnswerCache({ now: () => now });
    let computed = 0;
    const answer = (cc: string) => async (): Promise<CachedAnswer> => {
      computed++;
      return { status: 200, headers: { "Cache-Control": cc }, body: new Uint8Array(10) };
    };
    expect((await cache.get("k", answer("public, max-age=2"))).hit).toBe(false);
    now = 1999;
    expect((await cache.get("k", answer("public, max-age=2"))).hit).toBe(true);
    now = 2000;
    expect((await cache.get("k", answer("public, max-age=2"))).hit).toBe(false);
    expect(computed).toBe(2);
  });
});

describe("the byte cap", () => {
  test("the store never holds more than its cap: it evicts the least recently used, and never stores an answer larger than the cap", async () => {
    const cap = 10_000;
    const cache = createAnswerCache({ maxBytes: cap });
    const sized = (n: number) => async (): Promise<CachedAnswer> => ({
      status: 200,
      headers: { "Cache-Control": "public, max-age=300" },
      body: new Uint8Array(n),
    });
    for (let i = 0; i < 60; i++) {
      await cache.get(`k${i}`, sized(900 + (i % 7) * 50));
      expect(cache.bytes()).toBeLessThanOrEqual(cap);
      // Keep k0 recently used: it survives every eviction.
      expect((await cache.get("k0", sized(900))).hit).toBe(true);
    }
    expect(cache.size()).toBeGreaterThan(1);
    expect((await cache.get("k1", sized(900))).hit).toBe(false);
    // Larger than the whole cap: served, never stored, and nothing is evicted for it.
    const held = cache.size();
    expect((await cache.get("huge", sized(cap + 1))).hit).toBe(false);
    expect(cache.bytes()).toBeLessThanOrEqual(cap);
    expect(cache.size()).toBe(held);
    expect((await cache.get("huge", sized(cap + 1))).hit).toBe(false);
  });

  test("through the handler, with a small cap: many URLs, and the store stays under it", async () => {
    const cap = 4_000;
    _resetPublicAnalyticsCacheForTests({ maxBytes: cap });
    for (let limit = 1; limit <= 8; limit++) {
      expect((await get(`${P.rawHistory}?indicator=CACHE&limit=${limit}`)).status).toBe(200);
      const { bytes, size } = _publicAnalyticsCacheForTests();
      expect(bytes).toBeLessThanOrEqual(cap);
      expect(size).toBeGreaterThan(0);
    }
  });
});

describe("no-store answers are never stored", () => {
  test("a 404 report and a 400 parameter error are no-store, and every repeat reads again", async () => {
    const missing = `${P.reports}?run=33333333-3333-4333-8333-333333333333`;
    for (let i = 0; i < 3; i++) {
      const res = await get(missing);
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Cache-Status")).toBe("MISS");
    }
    expect(acquire).toHaveBeenCalledTimes(3);
    const bad = await get(`${P.rawHistory}?from=not-a-date`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("X-Cache-Status")).toBe("MISS");
    expect(_publicAnalyticsCacheForTests().size).toBe(0);
  });

  test("a refusal (405) carries X-Cache-Status MISS and no-store", async () => {
    const res = await get(URL_A, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Cache-Status")).toBe("MISS");
  });

  test("the store refuses no-store, private, no-cache, a missing max-age, and any status but 200", async () => {
    const a = (status: number, cc: string): CachedAnswer => ({ status, headers: { "Cache-Control": cc }, body: new Uint8Array(1) });
    expect(storableSeconds(a(200, "public, max-age=300"))).toBe(300);
    expect(storableSeconds(a(200, "public, max-age=31536000, immutable"))).toBe(31536000);
    expect(storableSeconds(a(200, "no-store"))).toBeNull();
    expect(storableSeconds(a(200, "public, max-age=300, no-store"))).toBeNull();
    expect(storableSeconds(a(200, "private, max-age=300"))).toBeNull();
    expect(storableSeconds(a(200, "no-cache"))).toBeNull();
    expect(storableSeconds(a(200, "public"))).toBeNull();
    expect(storableSeconds(a(200, "max-age=0"))).toBeNull();
    expect(storableSeconds(a(404, "public, max-age=300"))).toBeNull();

    const cache = createAnswerCache();
    let computed = 0;
    for (let i = 0; i < 3; i++) {
      const r = await cache.get("k", async () => {
        computed++;
        return a(200, "no-store");
      });
      expect(r.hit).toBe(false);
    }
    expect(computed).toBe(3);
    expect(cache.size()).toBe(0);
  });

  test("a computation that throws is not stored, and the next request computes again", async () => {
    const cache = createAnswerCache();
    await expect(cache.get("k", async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    const r = await cache.get("k", async () => ({ status: 200, headers: { "Cache-Control": "public, max-age=300" }, body: new Uint8Array(1) }));
    expect(r.hit).toBe(false);
  });
});

describe("a new api process starts with an empty store", () => {
  test("a URL the old process answered as a HIT is a MISS from a new process", async () => {
    const url = `${P.rawHistory}?indicator=CACHE&limit=3`;
    const first = await bootApi();
    try {
      expect((await fetch(`${first.base}${url}`)).headers.get("X-Cache-Status")).toBe("MISS");
      expect((await fetch(`${first.base}${url}`)).headers.get("X-Cache-Status")).toBe("HIT");
    } finally {
      first.stop();
    }
    const second = await bootApi();
    try {
      expect((await fetch(`${second.base}${url}`)).headers.get("X-Cache-Status")).toBe("MISS");
      expect((await fetch(`${second.base}${url}`)).headers.get("X-Cache-Status")).toBe("HIT");
    } finally {
      second.stop();
    }
  }, 180_000);
});
