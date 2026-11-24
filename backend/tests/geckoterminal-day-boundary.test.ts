// Issue 1733, finding E5: GeckoTerminal's NEW_TOKENS count is the trailing 24
// hours at the fetch instant, dated that instant's UTC day. The day ends at
// 00:00:00Z: a fetch at 23:59:59Z belongs to that day, one at 00:00:00Z to the
// next. A count fetched before its day ends is provisional (knowledge time).
import { expect, test } from "bun:test";
import { fetchGeckoTerminalNewPools } from "../src/analytics/extract/geckoterminal.ts";

const page = (createdAt: string[]) =>
  new Response(JSON.stringify({ data: createdAt.map((t) => ({ attributes: { pool_created_at: t } })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function fetchAt(iso: string) {
  const orig = globalThis.fetch;
  // Newest first; the last entry is older than 24h, so the sweep stops on page 1.
  globalThis.fetch = (async () => page(["2024-02-29T23:00:00Z", "2024-02-29T12:00:00Z", "2024-02-27T00:00:00Z"])) as unknown as typeof fetch;
  try {
    return await fetchGeckoTerminalNewPools(Date.parse(iso), 1000, { budgetMs: 5_000, logger: {}, sleep: async () => {} });
  } finally {
    globalThis.fetch = orig;
  }
}

test("a fetch at 23:59:59Z is dated that UTC day; one at 00:00:00Z the next", async () => {
  expect(await fetchAt("2024-02-29T23:59:59Z")).toEqual([{ date: "2024-02-29", value: 2 }]);
  expect(await fetchAt("2024-03-01T00:00:00Z")).toEqual([{ date: "2024-03-01", value: 2 }]);
});
