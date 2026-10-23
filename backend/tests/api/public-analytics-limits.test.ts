// Issue 1422 §4.8: every server load limit of the public analytics API, held
// against the REAL ephemeral Postgres tests/preload.ts provisions. No skip.
//
//   - the weighted token budget: 100 a minute, a list costs 1, a heavy request
//     (a report's bytes, an archive body) costs 10, then 429 + Retry-After;
//   - the byte budget: 50 MB a minute, admitted while any is left, an archive
//     charged in full (the budget may go negative), then 429 + Retry-After;
//     bytes charged are the bytes sent (UTF-8, after gzip, 0 for a 304);
//   - the concurrency gate: at most 2 public queries hold a connection, a
//     third request is 503 + Retry-After at once, and other work is unaffected;
//   - the 5 s statement timeout: a held query answers 503 + Retry-After and
//     releases its connection, and the pool's own settings are untouched;
//   - 503 only for admission and timeouts: an unexpected error keeps its own
//     meaning.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  PUBLIC_ANALYTICS_BYTES_PER_MINUTE,
  PUBLIC_ANALYTICS_HEAVY_COST,
  PUBLIC_ANALYTICS_LIST_COST,
  PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES,
  PUBLIC_ANALYTICS_QUERY_TIMEOUT_MS,
  PUBLIC_ANALYTICS_TOKENS_PER_MINUTE,
  ROUTES,
} from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import {
  _chargePublicAnalyticsBytesForTests,
  _publicAnalyticsBudgetForTests,
  _resetPublicAnalyticsRateLimitForTests,
  handlePublicAnalytics,
} from "../../src/api/routes/public-analytics.ts";
import { createClientBudgets, createQueryGate, PublicBusyError, publicQueryGate } from "../../src/api/public-analytics-limits.ts";
import { _resetArchiveForTests, _setArchiveClockForTests, _setArchiveEncoderPinForTests, encoderFixtureSha256 } from "../../src/analytics/store/public-archive-store.ts";
import { saveRawIndicatorHistory } from "../../src/analytics/store/raw-history-store.ts";
import { resolveClientIp } from "../../src/api/client-ip.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { fixtureDb } from "../support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const P = ROUTES.publicAnalytics;
const MB = 1024 * 1024;
const RUN = "44444444-4444-4444-8444-444444444444";

async function get(path: string, ip: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`http://api.test${path}`, init);
  return handlePublicAnalytics(req, new URL(req.url), ip);
}

beforeAll(async () => {
  _resetArchiveForTests();
  _setArchiveEncoderPinForTests(await encoderFixtureSha256());
  _setArchiveClockForTests(() => Date.parse("2002-01-03T12:00:00Z"));
  await saveRawIndicatorHistory({ LIM: Array.from({ length: 28 }, (_, i) => ({ date: `2002-01-${String(i + 1).padStart(2, "0")}`, value: i })) }, undefined, "seed");
  // Unicode in a stored value the list routes serve (an asset's config identity).
  await fixtureDb`
    INSERT INTO asset_prices (price_date, symbol, time_basis, price_usd, currency, source, observed_at, fetched_at, config_identity)
    VALUES ('2002-01-01', 'UNI', 'utc-daily-close', 1, 'USD', 'geckoterminal', now(), now(), 'é✓日本語')`;
  const [mv] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest, created_at)
    VALUES ('regime', 'v', '{}', repeat('d', 64), '2002-01-01 00:00:00+00') RETURNING id::text AS id`;
  const [run] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity, created_at)
    VALUES (${RUN}, '2002-01-01', 'regime', 'live', ${mv!.id}, 'b', '2002-01-01 01:00:00+00') RETURNING id::text AS id`;
  await fixtureDb`
    INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum, created_at)
    VALUES (${run!.id}, '2002-01-01', convert_to('{"r":1}', 'UTF8'), encode(sha256(convert_to('{"r":1}', 'UTF8')), 'hex'), '2002-01-01 02:00:00+00')`;
}, 60_000);

afterAll(() => {
  _setArchiveEncoderPinForTests(null);
  _setArchiveClockForTests(null);
  _resetArchiveForTests();
});
beforeEach(() => _resetPublicAnalyticsRateLimitForTests());

describe("the budgets as specified (fake clock)", () => {
  test("constants: 2 queries, 5 s, 100 tokens a minute at 1 and 10, 50 MB a minute", () => {
    expect(PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES).toBe(2);
    expect(PUBLIC_ANALYTICS_QUERY_TIMEOUT_MS).toBe(5000);
    expect(PUBLIC_ANALYTICS_TOKENS_PER_MINUTE).toBe(100);
    expect(PUBLIC_ANALYTICS_LIST_COST).toBe(1);
    expect(PUBLIC_ANALYTICS_HEAVY_COST).toBe(10);
    expect(PUBLIC_ANALYTICS_BYTES_PER_MINUTE).toBe(50 * MB);
  });

  test("100 weighted tokens in any minute: the boundary, the heavy cost, and Retry-After until the oldest ages out", () => {
    const b = createClientBudgets();
    const t0 = 1_000_000;
    for (let i = 0; i < 90; i++) expect(b.admit("a", 1, t0 + i).admitted).toBe(true);
    expect(b.admit("a", 10, t0 + 100).admitted).toBe(true); // exactly 100
    const refused = b.admit("a", 1, t0 + 200);
    expect(refused).toEqual({ admitted: false, reason: "tokens", retryAfterSeconds: 60 });
    // Ten list tokens free up when the first ten age out, 60 s after they were spent.
    expect(b.admit("a", 1, t0 + 60_000).admitted).toBe(true);
    // A heavy request needs ten free tokens, not one.
    expect(b.admit("a", 10, t0 + 60_005).admitted).toBe(false);
    expect(b.admit("a", 10, t0 + 60_100).admitted).toBe(true);
    // Another client is untouched.
    expect(b.admit("b", 10, t0 + 200).admitted).toBe(true);
  });

  test("50 MB in any minute: admitted while any is left, charged in full, negative, then 429 until it recovers", () => {
    const b = createClientBudgets();
    const t0 = 5_000_000;
    expect(b.admit("c", 10, t0).admitted).toBe(true);
    b.chargeBytes("c", 50 * MB - 1, t0);
    expect(b.peek("c", t0).bytes).toBe(1);
    // One byte left: an 80 MB archive is still admitted, and charged in full.
    expect(b.admit("c", 10, t0 + 10).admitted).toBe(true);
    b.chargeBytes("c", 80 * MB, t0 + 10);
    expect(b.peek("c", t0 + 10).bytes).toBe(1 - 80 * MB);
    const refused = b.admit("c", 1, t0 + 20);
    expect(refused.admitted).toBe(false);
    expect(refused.reason).toBe("bytes");
    expect(refused.retryAfterSeconds).toBe(60);
    // The 50 MB charge ages out at t0 + 60 s, but the 80 MB one still exceeds the budget.
    expect(b.admit("c", 1, t0 + 60_001).admitted).toBe(false);
    expect(b.admit("c", 1, t0 + 60_011).admitted).toBe(true);
  });

  test("the gate: two slots, a third is refused at once, and a waiter takes a released slot", async () => {
    const g = createQueryGate();
    const r1 = await g.acquire();
    const r2 = await g.acquire();
    await expect(g.acquire()).rejects.toBeInstanceOf(PublicBusyError);
    const waiting = g.acquire(1000);
    r1();
    r1(); // releasing twice frees one slot, not two
    const r3 = await waiting;
    expect(g.inUse()).toBe(2);
    await expect(g.acquire(20)).rejects.toBeInstanceOf(PublicBusyError);
    r2();
    r3();
    expect(g.inUse()).toBe(0);
  });
});

describe("tokens through the handler", () => {
  test("a report's bytes cost 10: the eleventh in a minute is 429 with Retry-After", async () => {
    const ip = "198.18.0.1";
    for (let i = 0; i < 10; i++) expect((await get(`${P.reports}?run=${RUN}`, ip)).status).toBe(200);
    const limited = await get(`${P.reports}?run=${RUN}`, ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    // The list routes share the same budget: nothing is left.
    expect((await get(P.rawHistory, ip)).status).toBe(429);
    expect((await get(P.rawHistory, "198.18.0.2")).status).toBe(200);
  });

  test("a list costs 1: 100 lists, then 429", async () => {
    const ip = "198.18.0.3";
    for (let i = 0; i < 100; i++) expect((await get(`${P.reports}?limit=1`, ip)).status).toBe(200);
    expect((await get(`${P.reports}?limit=1`, ip)).status).toBe(429);
  });
});

describe("bytes through the handler: what is charged is what is sent", () => {
  test("UTF-8 bytes, not characters; gzip bytes when gzipped; nothing for a 304", async () => {
    const ip = "198.18.1.1";
    const res = await get(`${P.assetPrices}?symbol=UNI`, ip);
    const sent = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(sent)).toContain("é✓日本語");
    expect(sent.length).toBeGreaterThan(new TextDecoder().decode(sent).length);
    expect(_publicAnalyticsBudgetForTests(ip).bytes).toBe(PUBLIC_ANALYTICS_BYTES_PER_MINUTE - sent.length);

    const etag = res.headers.get("ETag")!;
    const cond = await get(`${P.assetPrices}?symbol=UNI`, ip, { headers: { "If-None-Match": etag } });
    expect(cond.status).toBe(304);
    expect(_publicAnalyticsBudgetForTests(ip).bytes).toBe(PUBLIC_ANALYTICS_BYTES_PER_MINUTE - sent.length);

    // A gzip-encoded body is charged its encoded size, and the encoding runs
    // on the threadpool: the synchronous gzip on the event loop is never called.
    await fixtureDb`
      INSERT INTO asset_prices (price_date, symbol, time_basis, price_usd, currency, source, observed_at, fetched_at, config_identity)
      SELECT DATE '2003-01-01' + g, 'BIG', 'utc-daily-close', 1, 'USD', 'geckoterminal', now(), now(), repeat('z', 400)
      FROM generate_series(0, 999) g`;
    const gip = "198.18.1.2";
    const syncGzip = spyOn(Bun, "gzipSync").mockImplementation(() => {
      throw new Error("a public analytics body was compressed on the event loop");
    });
    let gz: Response;
    try {
      gz = await get(`${P.assetPrices}?symbol=BIG&limit=1000`, gip, { headers: { "Accept-Encoding": "gzip" } });
    } finally {
      syncGzip.mockRestore();
    }
    expect(gz.headers.get("Content-Encoding")).toBe("gzip");
    const gzBytes = new Uint8Array(await gz.arrayBuffer()).length;
    expect(_publicAnalyticsBudgetForTests(gip).bytes).toBe(PUBLIC_ANALYTICS_BYTES_PER_MINUTE - gzBytes);
  });

  test("an archive is charged in full on admission, even when the download is cancelled; an exhausted budget is 429", async () => {
    const ip = "198.18.2.1";
    const listing: any = await (await get(P.archiveBackups, ip)).json();
    expect(listing.backups.length).toBeGreaterThan(0);
    let rec: any = null;
    for (let i = 0; i < 40 && !rec; i++) {
      const res = await get(`${P.archiveFiles}${listing.backups[0].record}`, ip);
      if (res.status === 200) rec = await res.json();
      else await Bun.sleep(250);
    }
    const f = rec.append_only.analytics_report_snapshots.files[0];
    const before = _publicAnalyticsBudgetForTests(ip).bytes;
    const body = await get(`${P.archiveFiles}${f.path}`, ip);
    expect(body.status).toBe(200);
    const reader = body.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(_publicAnalyticsBudgetForTests(ip).bytes).toBe(before - f.bytes_gz);

    // Drive the budget to zero: the next request, of any kind, is 429 + Retry-After.
    _chargePublicAnalyticsBytesForTests(ip, _publicAnalyticsBudgetForTests(ip).bytes);
    const limited = await get(P.rawHistory, ip);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as any).error).toBe("byte budget exceeded");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
  });
});

describe("the concurrency gate and the statement timeout, with real held queries", () => {
  test("two held public queries hold the only two slots; a third is 503 at once; both time out at 5 s, answer 503 and release their connections", async () => {
    const waitingLocks = async (): Promise<number> => {
      const [r] = await fixtureDb<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE c.relname = 'raw_indicator_history' AND NOT l.granted`;
      return r!.n;
    };
    const [{ statement_timeout: poolTimeout }] = await sql<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const holder = fixtureDb.begin(async (tx) => {
      await tx.unsafe("LOCK TABLE raw_indicator_history IN ACCESS EXCLUSIVE MODE");
      locked();
      await released;
    });
    await lockTaken;
    try {
      const started = performance.now();
      const held = [get(P.rawHistory, "198.18.3.1"), get(P.rawHistory, "198.18.3.2")];
      for (let i = 0; i < 100 && (await waitingLocks()) < 2; i++) await Bun.sleep(50);
      expect(await waitingLocks()).toBe(2);
      expect(publicQueryGate.inUse()).toBe(2);

      // A third public request is refused at once, on every route.
      for (const path of [P.rawHistory, P.reports, P.sourceVersions, `${P.reports}?run=${RUN}`]) {
        const t = performance.now();
        const busy = await get(path, "198.18.3.3");
        expect(busy.status, path).toBe(503);
        expect(Number(busy.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
        expect(busy.headers.get("Cache-Control")).toBe("no-store");
        expect(performance.now() - t).toBeLessThan(1000);
      }
      // Non-public work still gets a connection and answers.
      const [{ one }] = await sql<{ one: number }[]>`SELECT 1 AS one`;
      expect(one).toBe(1);
      expect(await waitingLocks()).toBe(2);

      const answers = await Promise.all(held);
      const elapsed = performance.now() - started;
      for (const res of answers) {
        expect(res.status).toBe(503);
        expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
        expect(((await res.json()) as any).error).toBe("query timed out");
      }
      expect(elapsed).toBeGreaterThanOrEqual(PUBLIC_ANALYTICS_QUERY_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(PUBLIC_ANALYTICS_QUERY_TIMEOUT_MS + 4000);
      // The cancelled statements gave their connections back: no lock waits remain, the gate is empty.
      expect(await waitingLocks()).toBe(0);
      expect(publicQueryGate.inUse()).toBe(0);
    } finally {
      release();
      await holder;
    }
    // The timeout was the transaction's, not the pool's.
    const [{ statement_timeout: after }] = await sql<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(after).toBe(poolTimeout);
    expect((await get(P.rawHistory, "198.18.3.4")).status).toBe(200);
  }, 60_000);

  test("an unexpected error keeps its own meaning: it is thrown to index.ts (a 500), never turned into a 503", async () => {
    const real = JSON.stringify;
    const spy = spyOn(JSON, "stringify").mockImplementation(((v: unknown, ...rest: unknown[]) => {
      if (v && typeof v === "object" && "schemaVersion" in (v as object)) throw new TypeError("unexpected handler bug");
      return (real as (...a: unknown[]) => string)(v, ...rest);
    }) as typeof JSON.stringify);
    try {
      await expect(get(P.rawHistory, "198.18.4.1")).rejects.toThrow("unexpected handler bug");
    } finally {
      spy.mockRestore();
    }
    expect(publicQueryGate.inUse()).toBe(0);
  });
});

describe("caching and client identity, as the handler answers them", () => {
  test("lists are cached 5 minutes with a weak ETag; a report is immutable with its SHA-256 as a strong ETag; refusals are no-store", async () => {
    const list = await get(P.rawHistory, "198.18.5.1");
    expect(list.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(list.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    const report = await get(`${P.reports}?run=${RUN}`, "198.18.5.1");
    expect(report.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(report.headers.get("ETag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await get(P.rawHistory, "198.18.5.1", { method: "POST" })).headers.get("Cache-Control")).toBe("no-store");
  });

  test("the budgets key on the resolved client ip: X-Client-IP behind the trusted proxy, never a header from an untrusted path", async () => {
    // index.ts resolves the ip with TRUST_PROXY=1 (website-server in front); the
    // nginx half that overwrites a caller's X-Client-IP is the integration proof.
    const a = resolveClientIp("172.20.0.5", true, null, null, "203.0.113.70");
    const b = resolveClientIp("172.20.0.5", true, null, null, "203.0.113.71");
    for (let i = 0; i < 10; i++) expect((await get(`${P.reports}?run=${RUN}`, a)).status).toBe(200);
    expect((await get(`${P.reports}?run=${RUN}`, a)).status).toBe(429);
    expect((await get(`${P.reports}?run=${RUN}`, b)).status).toBe(200);
    // Without the trusted proxy, a sent X-Client-IP is ignored: every caller is its peer.
    expect(resolveClientIp("203.0.113.99", false, null, null, "203.0.113.71")).toBe("203.0.113.99");
  });
});
