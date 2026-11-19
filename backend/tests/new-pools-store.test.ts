// Issue 1654: the new-pools store against the test database (migration 0133).
// A pool is stored once, with the knowledge time of the first poll that saw
// it; knowledge_time is the database clock; both tables are append-only; and
// the gaps the store records are the gaps the SDK's coverage derives.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "../src/db/client.ts";
import { loadNewPoolHead, loadNewPoolRunInputs, saveNewPoolPoll } from "../src/analytics/store/new-pools-store.ts";
import { pollNewPools } from "../src/analytics/new-pools-collector.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import type { NewPoolPollSubmission } from "../src/analytics/persistence.ts";
import { instantMs, newPoolCoverage, newPoolDailyCounts } from "../../packages/analyst-sdk/src/transform/new-pools.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

function submission(pools: { id: string; at: string }[], opts: { failed?: boolean } = {}): NewPoolPollSubmission {
  const ms = pools.map((p) => Date.parse(p.at));
  return {
    acquisition: {
      id: randomUUID(),
      provider: "geckoterminal_newpools",
      parserVersion: "new-pools:1",
      cacheIdentity: "geckoterminal:new_pools",
      requestedByRunId: null,
      events: [{ type: "started", detail: null }, opts.failed ? { type: "failed", detail: "page 1: HTTP 503" } : { type: "succeeded", detail: null }],
      fetches: [],
      values: [],
    },
    pools: pools.map((p) => ({ id: p.id, network: p.id.split("_")[0]!, createdAt: p.at })),
    oldestCreatedAt: pools.length ? new Date(Math.min(...ms)).toISOString() : null,
    newestCreatedAt: pools.length ? new Date(Math.max(...ms)).toISOString() : null,
    pagesRead: pools.length ? 1 : 0,
  };
}

const same = (a: string, b: string) => instantMs(a) === instantMs(b);

describe("new-pools store", () => {
  test("two polls that see the same pool store one row with the first poll's knowledge_time; every knowledge_time is the database clock", async () => {
    const before = (await sql<{ t: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`)[0]!.t;
    const first = await saveNewPoolPoll(submission([{ id: "base_a", at: "2026-11-18T22:50:00Z" }, { id: "base_b", at: "2026-11-18T22:51:00Z" }]));
    await Bun.sleep(20);
    const second = await saveNewPoolPoll(submission([{ id: "base_b", at: "2026-11-18T22:51:00Z" }, { id: "base_c", at: "2026-11-18T22:52:00Z" }]));
    const after = (await sql<{ t: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`)[0]!.t;
    expect([first.poolsNew, second.poolsNew]).toEqual([2, 1]);
    expect([first.gap, second.gap]).toEqual([null, null]);
    const rows = await sql<{ pool_id: string; acquisition_id: string; known: boolean }[]>`
      SELECT pool_id, acquisition_id::text, knowledge_time BETWEEN ${before}::text::timestamptz AND ${after}::text::timestamptz AS known
      FROM new_pool_records ORDER BY pool_id`;
    expect(rows.map((r) => r.pool_id)).toEqual(["base_a", "base_b", "base_c"]);
    expect(rows.find((r) => r.pool_id === "base_b")!.acquisition_id).toBe(first.acquisitionId);
    for (const r of rows) expect(r.known).toBe(true);
    const [b] = await sql<{ same: boolean }[]>`
      SELECT r.knowledge_time < p.knowledge_time AS same FROM new_pool_records r, new_pool_polls p
      WHERE r.pool_id = 'base_b' AND p.acquisition_id = ${second.acquisitionId}::uuid`;
    expect(b!.same).toBe(true); // stored by the first poll, before the second poll's row
    // The producer never supplies knowledge_time: the store has no way to take one.
    expect(Object.keys(submission([]).pools[0] ?? {})).not.toContain("knowledgeTime");
    expect(same((await loadNewPoolHead())!, "2026-11-18T22:52:00Z")).toBe(true);
  });

  test("a poll whose oldest pool is after the previous poll's newest stores the gap; an overlapping poll stores none", async () => {
    await saveNewPoolPoll(submission([{ id: "x_1", at: "2026-11-18T10:00:00Z" }, { id: "x_2", at: "2026-11-18T10:05:00Z" }]));
    const overlap = await saveNewPoolPoll(submission([{ id: "x_2", at: "2026-11-18T10:05:00Z" }, { id: "x_3", at: "2026-11-18T10:06:00Z" }]));
    const gapped = await saveNewPoolPoll(submission([{ id: "x_4", at: "2026-11-18T10:30:00Z" }, { id: "x_5", at: "2026-11-18T10:31:00Z" }]));
    expect(overlap.gap).toBeNull();
    expect(gapped.gap).not.toBeNull();
    expect(same(gapped.gap!.from, "2026-11-18T10:06:00Z")).toBe(true);
    expect(same(gapped.gap!.to, "2026-11-18T10:30:00Z")).toBe(true);
    const stored = await sql<{ gap_from: Date | null; gap_to: Date | null }[]>`SELECT gap_from, gap_to FROM new_pool_polls ORDER BY id`;
    expect(stored.map((r) => (r.gap_from ? [r.gap_from.toISOString(), r.gap_to!.toISOString()] : null))).toEqual([
      null, null, ["2026-11-18T10:06:00.000Z", "2026-11-18T10:30:00.000Z"],
    ]);
  });

  test("a failed poll records its acquisition and no poll row; the next poll is compared with the last stored poll", async () => {
    await saveNewPoolPoll(submission([{ id: "y_1", at: "2026-11-18T10:00:00Z" }]));
    const failed = await saveNewPoolPoll(submission([], { failed: true }));
    expect(failed.stored).toBe(false);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_acquisitions WHERE id = ${failed.acquisitionId}::uuid`;
    expect(n).toBe(1);
    const next = await saveNewPoolPoll(submission([{ id: "y_2", at: "2026-11-18T10:02:00Z" }]));
    expect(same(next.gap!.from, "2026-11-18T10:00:00Z")).toBe(true);
    // A replayed submission answers with the poll row its first submission stored.
    const again = submission([{ id: "y_3", at: "2026-11-18T10:03:00Z" }]);
    const once = await saveNewPoolPoll(again);
    const twice = await saveNewPoolPoll(again);
    expect(twice).toEqual({ ...once, replayed: true });
  });

  test("UPDATE and DELETE on new_pool_records and new_pool_polls raise, even for the owner", async () => {
    await saveNewPoolPoll(submission([{ id: "z_1", at: "2026-11-18T10:00:00Z" }]));
    for (const stmt of [
      "UPDATE new_pool_records SET network = 'x'",
      "DELETE FROM new_pool_records",
      "UPDATE new_pool_polls SET pages_read = 2",
      "DELETE FROM new_pool_polls",
      "TRUNCATE new_pool_records CASCADE",
    ]) {
      // The runtime role holds neither privilege.
      await expect(sql.unsafe(stmt)).rejects.toThrow();
      // The owner holds them, and the immutability trigger still refuses.
      await expect(sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(stmt);
      })).rejects.toThrow(/immutable/);
    }
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM new_pool_records`;
    expect(n).toBe(1);
  });

  test("the gaps stored for a sequence of polls equal the uncovered spans newPoolDailyCounts derives from the same polls, and the run inputs count the same days", async () => {
    const polls: { id: string; at: string }[][] = [
      [{ id: "s_1", at: "2026-11-15T23:00:00Z" }, { id: "s_2", at: "2026-11-16T12:00:00Z" }],
      [{ id: "s_2", at: "2026-11-16T12:00:00Z" }, { id: "s_3", at: "2026-11-17T01:00:00Z" }],
      [{ id: "s_4", at: "2026-11-17T03:00:00Z" }, { id: "s_5", at: "2026-11-17T05:00:00Z" }], // gap 01:00 to 03:00
      [{ id: "s_5", at: "2026-11-17T05:00:00Z" }, { id: "s_6", at: "2026-11-18T00:30:00Z" }],
      [{ id: "s_7", at: "2026-11-18T02:00:00Z" }, { id: "s_8", at: "2026-11-19T00:00:00Z" }], // gap 00:30 to 02:00
    ];
    for (const p of polls) await saveNewPoolPoll(submission(p));
    const stored = await sql<{ gap_from: Date; gap_to: Date }[]>`SELECT gap_from, gap_to FROM new_pool_polls WHERE gap_from IS NOT NULL ORDER BY id`;
    const inputs = await loadNewPoolRunInputs();
    const derived = newPoolCoverage(inputs.polls).gaps;
    expect(stored.map((r) => ({ from: r.gap_from.toISOString(), to: r.gap_to.toISOString() }))).toEqual(derived);
    expect(derived.length).toBe(2);
    // Only 2026-11-16 is gap-free and closed: s_2 (s_1 is on the 15th, s_3 on the 17th).
    expect(newPoolDailyCounts({ dayTallies: inputs.dayTallies, polls: inputs.polls })).toEqual([{ date: "2026-11-16", value: 1 }]);
    expect(inputs.dayTallies).toEqual([
      { date: "2026-11-15", pools: 1 }, { date: "2026-11-16", pools: 1 }, { date: "2026-11-17", pools: 3 },
      { date: "2026-11-18", pools: 2 }, { date: "2026-11-19", pools: 1 },
    ]);
  });

  test("the collector stores through the direct persistence and logs the stored gap", async () => {
    await saveNewPoolPoll(submission([{ id: "base_old", at: "2026-11-18T22:00:00Z" }]));
    const realFetch = globalThis.fetch;
    const newest = Date.parse("2026-11-18T22:55:30Z");
    globalThis.fetch = (async () => Response.json({ data: Array.from({ length: 20 }, (_, i) => ({ id: `base_p${i}`, attributes: { pool_created_at: new Date(newest - i * 1000).toISOString() } })) })) as unknown as typeof fetch;
    const warns: string[] = [];
    try {
      const res = await pollNewPools({ persistence: directAnalyticsPersistence, logger: { warn: (m) => warns.push(m) }, pace: (fn) => fn() });
      expect(res.stored).toBe(true);
      expect(res.poolsNew).toBe(20);
      expect(warns.filter((w) => w.startsWith("[new-pools] coverage gap")).length).toBe(1);
      expect(same(res.gap!.from, "2026-11-18T22:00:00Z")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
