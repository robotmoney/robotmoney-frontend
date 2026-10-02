// The analytics producer can hold at most ANALYTICS_CONCURRENCY of the api's
// database connections, so its write bursts can no longer starve public
// requests into 502s (production 2026-09-25..28, issue 1035).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { ANALYTICS_CONCURRENCY, ANALYTICS_PATHS, createLimiter } from "../src/api/routes/analytics.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createLimiter", () => {
  test("never runs more than the limit at once, and serves waiters in order", async () => {
    const lim = createLimiter(2);
    const order: string[] = [];
    const r1 = await lim.acquire();
    const r2 = await lim.acquire();
    const p3 = lim.acquire().then((r) => { order.push("3"); return r; });
    const p4 = lim.acquire().then((r) => { order.push("4"); return r; });
    await tick();
    expect(lim.inFlight()).toBe(2);
    expect(lim.waiting()).toBe(2);
    expect(order).toEqual([]);
    r1();
    const r3 = await p3;
    expect(order).toEqual(["3"]);
    expect(lim.inFlight()).toBe(2);
    r2(); r3();
    const r4 = await p4;
    expect(order).toEqual(["3", "4"]);
    r4();
    expect(lim.inFlight()).toBe(0);
  });

  test("releasing twice frees only one slot", async () => {
    const lim = createLimiter(1);
    const r = await lim.acquire();
    r(); r();
    expect(lim.inFlight()).toBe(0);
  });
});

describe("handleAnalytics", () => {
  test("every analytics route but the readiness probe goes through the cap, and the cap leaves most of the pool free", () => {
    const src = readFileSync(join(import.meta.dir, "../src/api/routes/analytics.ts"), "utf8");
    expect(src).toContain("if (!ANALYTICS_PATHS.has(url.pathname) || url.pathname === A.readiness) return handleAnalyticsUnbounded(req, url);");
    expect(src).toContain("const release = await analyticsSlots.acquire();");
    expect(ANALYTICS_CONCURRENCY).toBeLessThanOrEqual(Number(process.env.PG_POOL_MAX ?? 10) / 4);
  });
});

describe("ANALYTICS_PATHS", () => {
  test("equals the analytics route table, so a new route cannot 404 silently", () => {
    expect([...ANALYTICS_PATHS].sort()).toEqual(Object.values(ROUTES.analytics).sort());
  });
});
