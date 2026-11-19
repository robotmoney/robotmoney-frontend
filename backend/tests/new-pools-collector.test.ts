// Issue 1654: one new-pools poll against a mocked feed. No network, no
// database: the store is a recording fake (the real store is covered by
// tests/new-pools-store.test.ts). The pacing case runs on a fake clock.
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { newPoolsTicker, parseNewPool, pollNewPools } from "../src/analytics/new-pools-collector.ts";
import { _resetGeckoEndpointForTests } from "../src/chain/gecko-endpoint.ts";
import { _resetRateLimitStateForTests } from "../src/chain/gecko-rate-limit.ts";
import type { AnalyticsPersistence, NewPoolPollResult, NewPoolPollSubmission } from "../src/analytics/persistence.ts";

const FREE = "https://api.geckoterminal.com/api/v2/networks/new_pools?page=";
const KEY = "sentinel-paid-key-1654";
const realFetch = globalThis.fetch;
const realKey = process.env.COINGECKO_API_KEY;
const quiet = { log: () => {}, warn: () => {} };

beforeEach(() => {
  _resetGeckoEndpointForTests();
  _resetRateLimitStateForTests();
  process.env.COINGECKO_API_KEY = KEY; // set on purpose: the collector must never use it
});
afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.COINGECKO_API_KEY;
  else process.env.COINGECKO_API_KEY = realKey;
  delete process.env.GECKO_MIN_INTERVAL_MS;
  _resetRateLimitStateForTests();
});

/** A feed of `pages` pages of 20 pools, newest first, one pool a second back from `newest`. */
function feed(newest: number, pages: number, opts: { badEvery?: number } = {}) {
  const sent: { url: string; key: string | null; at: number }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), key: new Headers(init.headers).get("x-cg-pro-api-key"), at: Date.now() });
    const page = Number(new URL(String(url)).searchParams.get("page"));
    if (page > pages) return Response.json({ data: [] });
    const data = Array.from({ length: 20 }, (_, i) => {
      const n = (page - 1) * 20 + i;
      const bad = opts.badEvery && n % opts.badEvery === opts.badEvery - 1;
      return {
        id: `base_0x${n.toString(16).padStart(4, "0")}`,
        attributes: { pool_created_at: bad ? "not a time" : new Date(newest - n * 1000).toISOString() },
        relationships: { network: { data: { id: "base" } } },
      };
    });
    return Response.json({ data });
  }) as unknown as typeof fetch;
  return sent;
}

function fakeStore(head: string | null, gap: NewPoolPollResult["gap"] = null) {
  const saved: NewPoolPollSubmission[] = [];
  const persistence: Pick<AnalyticsPersistence, "saveNewPoolPoll" | "loadNewPoolHead"> = {
    loadNewPoolHead: async () => head,
    saveNewPoolPoll: async (p) => {
      saved.push(p);
      return { acquisitionId: p.acquisition.id, replayed: false, stored: p.pools.length > 0, poolsSeen: p.pools.length, poolsNew: p.pools.length, gap };
    },
  };
  return { saved, persistence };
}

const NEWEST = Date.parse("2026-11-18T22:55:30Z");

test("a poll stops at the first page whose oldest pool is at or before the previous poll's newest, and every request goes to the keyless host with no key header", async () => {
  // The previous poll's newest pool is the 45th newest: page 3 (pools 40..59) reaches it.
  const sent = feed(NEWEST, 10);
  const { saved, persistence } = fakeStore(new Date(NEWEST - 45 * 1000).toISOString());
  await pollNewPools({ persistence, logger: quiet, pace: (fn) => fn() });
  expect(sent.map((s) => s.url)).toEqual([`${FREE}1`, `${FREE}2`, `${FREE}3`]);
  for (const s of sent) expect(s.key).toBeNull();
  expect(saved.length).toBe(1);
  const poll = saved[0]!;
  expect(poll.pagesRead).toBe(3);
  expect(poll.pools.length).toBe(60);
  expect(poll.newestCreatedAt).toBe(new Date(NEWEST).toISOString());
  expect(poll.oldestCreatedAt).toBe(new Date(NEWEST - 59 * 1000).toISOString());
  expect(poll.acquisition.provider).toBe("geckoterminal_newpools");
  expect(poll.acquisition.parserVersion).toBe("new-pools:1");
  expect(poll.acquisition.values).toEqual([]);
  expect(poll.acquisition.events.map((e) => e.type)).toEqual(["started", "succeeded"]);
  expect(poll.acquisition.fetches.length).toBe(3);
  expect(JSON.stringify(poll)).not.toContain(KEY);
});

test("the first poll ever reads to page 10, the feed's hard limit; an empty page stops a poll", async () => {
  const sent = feed(NEWEST, 12);
  const { saved, persistence } = fakeStore(null);
  await pollNewPools({ persistence, logger: quiet, pace: (fn) => fn() });
  expect(sent.length).toBe(10);
  expect(saved[0]!.pagesRead).toBe(10);
  expect(saved[0]!.pools.length).toBe(200);

  const sent2 = feed(NEWEST, 2);
  const second = fakeStore(null);
  await pollNewPools({ persistence: second.persistence, logger: quiet, pace: (fn) => fn() });
  expect(sent2.length).toBe(3); // pages 1, 2 and the empty page 3
  expect(second.saved[0]!.pagesRead).toBe(2);
});

test("a record without a parseable pool_created_at is refused, not stored, and counted in the poll's log line", async () => {
  feed(NEWEST, 1, { badEvery: 5 });
  const lines: string[] = [];
  const { saved, persistence } = fakeStore(new Date(NEWEST - 3600_000).toISOString());
  await pollNewPools({ persistence, logger: { log: (m) => lines.push(m), warn: (m) => lines.push(m) }, pace: (fn) => fn() });
  expect(saved[0]!.pools.length).toBe(16);
  for (const p of saved[0]!.pools) expect(Number.isFinite(Date.parse(p.createdAt))).toBe(true);
  expect(lines.some((l) => l.startsWith("[new-pools] poll:") && l.includes("refused=4"))).toBe(true);
  expect(parseNewPool({ id: "x_1", attributes: {} })).toBeNull();
  expect(parseNewPool({ attributes: { pool_created_at: "2026-11-18T00:00:00Z" } })).toBeNull();
});

test("requests are spaced at least 6 s apart on a fake clock, through the shared keyless pace", async () => {
  jest.useFakeTimers();
  process.env.GECKO_MIN_INTERVAL_MS = "6000";
  _resetRateLimitStateForTests();
  const sent = feed(NEWEST, 10);
  const { saved, persistence } = fakeStore(new Date(NEWEST - 70 * 1000).toISOString());
  let done = false;
  const p = pollNewPools({ persistence, logger: quiet }).then(() => { done = true; });
  for (let i = 0; i < 400 && !done; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    jest.advanceTimersByTime(500);
  }
  await p;
  expect(saved.length).toBe(1);
  expect(sent.length).toBe(4); // pool 70 is on page 4
  for (let i = 1; i < sent.length; i++) expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(6000);
});

test("a 429 is retried; a page 1 that never succeeds is a failed poll with no pools", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } }) : Response.json({ data: [] });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const ok = fakeStore(null);
  await pollNewPools({ persistence: ok.persistence, logger: quiet, pace: (fn) => fn(), sleep: async (ms) => { sleeps.push(ms); } });
  expect(calls).toBe(2);
  expect(sleeps).toEqual([1000]);

  globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
  const failed = fakeStore(null);
  const lines: string[] = [];
  await pollNewPools({ persistence: failed.persistence, logger: { log: (m) => lines.push(m), warn: (m) => lines.push(m) }, pace: (fn) => fn(), sleep: async () => {} });
  const poll = failed.saved[0]!;
  expect(poll.pools).toEqual([]);
  expect(poll.oldestCreatedAt).toBeNull();
  expect(poll.acquisition.events.at(-1)!.type).toBe("failed");
  expect(lines.some((l) => l.includes("poll failed"))).toBe(true);
});

test("when the 55 s budget ends before the overlap, the poll stores the pages it read", async () => {
  feed(NEWEST, 10);
  let t = 0;
  const { saved, persistence } = fakeStore(new Date(NEWEST - 150 * 1000).toISOString());
  // Each request takes 20 s of the poll's clock: pages 1 to 3 fit in 55 s.
  await pollNewPools({ persistence, logger: quiet, now: () => t, pace: async (fn) => { const r = await fn(); t += 20_000; return r; } });
  expect(saved[0]!.pagesRead).toBe(3);
  expect(saved[0]!.oldestCreatedAt).toBe(new Date(NEWEST - 59 * 1000).toISOString());
});

test("a stored gap is logged once as a [new-pools] coverage gap warning; an overlapping poll logs none", async () => {
  feed(NEWEST, 10);
  const from = "2026-11-18T22:40:00.000000Z";
  const to = new Date(NEWEST - 199 * 1000).toISOString();
  const warns: string[] = [];
  await pollNewPools({ persistence: fakeStore(from, { from, to }).persistence, logger: { warn: (m) => warns.push(m) }, pace: (fn) => fn() });
  expect(warns.filter((w) => w.startsWith("[new-pools] coverage gap"))).toEqual([`[new-pools] coverage gap ${from} to ${to}`]);

  const none: string[] = [];
  feed(NEWEST, 10);
  await pollNewPools({ persistence: fakeStore(new Date(NEWEST - 30_000).toISOString()).persistence, logger: { warn: (m) => none.push(m) }, pace: (fn) => fn() });
  expect(none.filter((w) => w.includes("coverage gap"))).toEqual([]);
});

test("the ticker starts no second poll while one is running", async () => {
  let release!: () => void;
  let started = 0;
  const ticker = newPoolsTicker(async () => {
    started++;
    await new Promise<void>((r) => { release = r; });
  }, { intervalMs: 60_000, logger: quiet, setInterval: (() => 0) as unknown as typeof setInterval, clearInterval: (() => {}) as unknown as typeof clearInterval });
  expect(ticker.tick()).toBe(true);
  expect(ticker.tick()).toBe(false);
  expect(started).toBe(1);
  release();
  await ticker.idle();
  expect(ticker.tick()).toBe(true);
  expect(started).toBe(2);
  release();
  await ticker.idle();
  ticker.stop();
});
