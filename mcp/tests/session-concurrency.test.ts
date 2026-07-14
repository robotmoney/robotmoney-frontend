import { test, expect } from "bun:test";
import { mapSettledWithConcurrency } from "../src/e2e.ts";

// Hermetic unit tests for the bounded-concurrency settle helper that makes a
// committee session tolerant of a single member's failure/hang. No backend.

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// (a) Results come back in INPUT order regardless of completion order — a fast
// later item must not overtake a slow earlier one in the result array.
test("mapSettledWithConcurrency preserves input order", async () => {
  const items = [30, 5, 20, 1];
  const out = await mapSettledWithConcurrency(items, 4, async (ms, i) => {
    await tick(ms);
    return i;
  });
  expect(out.map((s) => (s.status === "fulfilled" ? s.value : null))).toEqual([0, 1, 2, 3]);
});

// (b) One rejecting item yields a status:'rejected' entry while the others still
// fulfill — the whole batch is NOT sunk (the core resilience property).
test("mapSettledWithConcurrency isolates a rejecting item", async () => {
  const items = ["ok0", "boom", "ok2"];
  const out = await mapSettledWithConcurrency(items, 2, async (v) => {
    if (v === "boom") throw new Error(`failed: ${v}`);
    return v.toUpperCase();
  });
  expect(out[0]).toEqual({ status: "fulfilled", value: "OK0" });
  expect(out[1].status).toBe("rejected");
  expect(out[2]).toEqual({ status: "fulfilled", value: "OK2" });
  if (out[1].status === "rejected") {
    expect(String(out[1].reason)).toMatch(/failed: boom/);
  }
});

// (c) Never more than `limit` invocations are in flight at once. Track a live
// counter and record the max — the async body holds the slot across an await.
test("mapSettledWithConcurrency never exceeds the concurrency limit", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await mapSettledWithConcurrency(items, 3, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(5);
    inFlight--;
    return null;
  });
  expect(maxInFlight).toBeLessThanOrEqual(3);
  // Sanity: with 12 items and a limit of 3 we should actually reach the cap.
  expect(maxInFlight).toBe(3);
});

// Unbounded sentinel (Infinity / <=0) runs everything at once — the hermetic
// path's behaviour, equivalent to Promise.allSettled.
test("mapSettledWithConcurrency treats Infinity as unbounded", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 6 }, (_, i) => i);
  await mapSettledWithConcurrency(items, Infinity, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(5);
    inFlight--;
    return null;
  });
  expect(maxInFlight).toBe(6);
});
