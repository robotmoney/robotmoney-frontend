// Issue 1654: store a run of gap-free new-pools polls through the real store,
// one poll per UTC day. Each day's poll holds a pool at the day's 00:00, a
// deterministic number of pools inside the day, and the next day's 00:00 pool,
// which is also the next poll's oldest: every poll overlaps the one before, so
// every day from `start` to `end` is gap-free and closed. Returns the count
// each day must read (unique pools created that day).
import { randomUUID } from "node:crypto";
import { saveNewPoolPoll } from "../../src/analytics/store/new-pools-store.ts";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export async function storeGapFreePolls(start: string, end: string): Promise<{ date: string; value: number }[]> {
  const expected: { date: string; value: number }[] = [];
  const first = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  for (let t = first, i = 0; t <= last; t += DAY, i++) {
    const day = iso(t).slice(0, 10);
    const inside = 3 + ((i * 37) % 23);
    const pools = [{ id: `base_${day}_0`, network: "base", createdAt: iso(t) }];
    for (let k = 1; k <= inside; k++) pools.push({ id: `solana_${day}_${k}`, network: "solana", createdAt: iso(t + Math.floor((k * DAY) / (inside + 2))) });
    const next = iso(t + DAY);
    pools.push({ id: `base_${next.slice(0, 10)}_0`, network: "base", createdAt: next });
    await saveNewPoolPoll({
      acquisition: {
        id: randomUUID(), provider: "geckoterminal_newpools", parserVersion: "new-pools:1", cacheIdentity: "geckoterminal:new_pools",
        requestedByRunId: null, events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }], fetches: [], values: [],
      },
      pools,
      oldestCreatedAt: iso(t),
      newestCreatedAt: next,
      pagesRead: 1,
    });
    expected.push({ date: day, value: 1 + inside });
  }
  return expected;
}
