// The shared rate limiter's key map is bounded (issue #1095, review F10): a flood
// of distinct client keys cannot grow it past maxKeys, and the oldest-seen key is
// the one evicted. Pure unit test, no database.
import { describe, expect, test } from "bun:test";
import { createRateLimiter, DEFAULT_MAX_KEYS } from "../../src/api/rate-limit.ts";

describe("createRateLimiter", () => {
  test("limits a key past max within the window, with Retry-After", () => {
    const rl = createRateLimiter({ max: 2, windowMs: 60_000 });
    expect(rl.check("a", 0).limited).toBe(false);
    expect(rl.check("a", 1).limited).toBe(false);
    const third = rl.check("a", 2);
    expect(third.limited).toBe(true);
    expect(third.retryAfterSeconds).toBe(60);
    expect(rl.check("a", 60_001).limited).toBe(false);
  });

  test("the default cap is fixed and finite", () => {
    expect(DEFAULT_MAX_KEYS).toBe(10_000);
  });

  test("the key map never exceeds maxKeys, however many distinct keys arrive", () => {
    const rl = createRateLimiter({ max: 5, windowMs: 60_000, maxKeys: 50 });
    // The only observable of the map's size is eviction: after 50 + 1 distinct keys the first has been forgotten.
    for (let i = 0; i < 5; i++) rl.check("victim", 0);
    expect(rl.check("victim", 1).limited).toBe(true);
    for (let i = 0; i < 49; i++) rl.check(`k${i}`, 2); // 49 more keys: map now holds victim + 49 = 50, full
    expect(rl.check("victim", 3).limited).toBe(true); // still held; this touch also makes it the newest
    for (let i = 0; i < 49; i++) rl.check(`z${i}`, 4); // evicts k0..k48 (older than victim), victim survives
    expect(rl.check("victim", 5).limited).toBe(true);
    // One more wave of 50 new keys pushes victim out as the oldest.
    for (let i = 0; i < 50; i++) rl.check(`w${i}`, 6);
    expect(rl.check("victim", 7).limited).toBe(false); // fresh window: it was evicted
  });

  test("a flood of 100000 distinct keys evicts the oldest first and keeps the most recent ones", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 3_600_000, maxKeys: 1000 });
    for (let i = 0; i < 100_000; i++) rl.check(`ip-${i}`, i);
    // The newest key is still held (a second hit is limited); a long-evicted one starts fresh.
    expect(rl.check("ip-99999", 100_000).limited).toBe(true);
    expect(rl.check("ip-0", 100_001).limited).toBe(false);
  });

  test("reset forgets every key", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 60_000 });
    rl.check("a", 0);
    expect(rl.check("a", 1).limited).toBe(true);
    rl.reset();
    expect(rl.check("a", 2).limited).toBe(false);
  });
});
