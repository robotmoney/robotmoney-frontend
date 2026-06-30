import { test, expect } from "bun:test";
import { createFetcherProvider } from "../src/analytics/providers/fetcher.ts";

test("FetcherProvider degrades to seeded when every source fetch fails (never throws)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network down"); }) as any;
  try {
    const p = createFetcherProvider();
    await p.warm("2026-06-30"); // must not throw even though all fetches fail
    const s = p.getSeries({ id: "BTC", base: 65000, vol: 0.04 }, "2026-06-30", 30);
    expect(s.length).toBe(30);
    expect(Number.isFinite(s.at(-1)!.value)).toBe(true); // a sane seeded fallback value
  } finally {
    globalThis.fetch = orig;
  }
});
