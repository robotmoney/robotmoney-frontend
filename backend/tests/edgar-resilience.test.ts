// Resilience coverage for the EDGAR S-4 monthly sweep (backend/src/analytics/extract/edgar.ts).
// Without network access, the naive sequential loop over ~198 months (each with
// 4 retry attempts × a 15s abort timeout) can hang for hours before returning [].
// These tests prove the preflight probe + circuit breaker bound that: total
// unreachability fails fast at the preflight stage, sustained mid-sweep failure
// trips a circuit breaker well short of the full range, and an isolated single-
// month flake does NOT trip the breaker (full range still recovered).
import { test, expect } from "bun:test";
import { fetchEdgarS4Monthly, fetchEdgarMonthCount } from "../src/analytics/extract/edgar.ts";

function okResponse(count: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ hits: { total: { value: count } } }),
  } as Response;
}

// Non-retryable 4xx (not 429): fetchEdgarMonthCount's own retry loop `break`s
// immediately on this, so no backoff sleeps are incurred.
function badResponse() {
  return {
    ok: false,
    status: 400,
    json: async () => ({}),
  } as Response;
}

function startdtOf(url: string): string {
  return new URL(url).searchParams.get("startdt") ?? "";
}

test("fetchEdgarS4Monthly: total unreachability aborts at the preflight probe (bounded fetch calls)", async () => {
  const orig = globalThis.fetch;
  const warnings: string[] = [];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("network down");
  }) as any;
  try {
    const result = await fetchEdgarS4Monthly("2010-01-01", "2011-12-31", 15000, { warn: (m) => warnings.push(m) });
    expect(result).toEqual([]);
    expect(calls).toBeLessThanOrEqual(2); // PREFLIGHT_MAX_ATTEMPTS, not 24*4
    expect(warnings.some((m) => /preflight/i.test(m) && /(skip|unreachable)/i.test(m))).toBe(true);
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

test("fetchEdgarS4Monthly: sustained mid-sweep failure trips the circuit breaker (bounded, not full range)", async () => {
  const orig = globalThis.fetch;
  const warnings: string[] = [];
  let calls = 0;
  // Preflight targets the LAST month in the range. Succeed only for that one
  // month's startdt; fail (non-retryable 4xx) for every other month.
  const lastMonthStart = "2011-12-01";
  globalThis.fetch = (async (url: string) => {
    calls++;
    return startdtOf(url) === lastMonthStart ? okResponse(42) : badResponse();
  }) as any;
  try {
    const result = await fetchEdgarS4Monthly("2010-01-01", "2011-12-31", 15000, { warn: (m) => warnings.push(m) });
    // 24 months total; preflight recovers the last one, then the breaker trips
    // after CIRCUIT_BREAKER_THRESHOLD (3) consecutive misses among the rest.
    expect(result.length).toBe(1);
    expect(result[0]!.value).toBe(42);
    expect(calls).toBeLessThan(24); // aborted well short of iterating every month
    expect(warnings.some((m) => /consecutive/i.test(m))).toBe(true);
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

test("fetchEdgarS4Monthly: an isolated single-month flake does not trip the breaker", async () => {
  const orig = globalThis.fetch;
  const warnings: string[] = [];
  const flakyMonthStart = "2011-03-01"; // one month in the middle of the range
  globalThis.fetch = (async (url: string) => {
    return startdtOf(url) === flakyMonthStart ? badResponse() : okResponse(7);
  }) as any;
  try {
    const result = await fetchEdgarS4Monthly("2011-01-01", "2011-06-30", 15000, { warn: (m) => warnings.push(m) });
    const months = 6; // Jan..Jun 2011
    expect(result.length).toBe(months - 1); // every month recovered except the one flaky miss
    expect(warnings.some((m) => /unrecovered/i.test(m))).toBe(true);
    expect(warnings.some((m) => /consecutive/i.test(m))).toBe(false); // breaker never tripped
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

// Issue #109: fetchEdgarMonthCount's own retry/backoff loop must honor an
// OPTIONAL absolute `deadlineAt` — a sustained-429 month must NOT run its
// full maxAttempts×exponential-backoff cycle (which would take several
// real seconds) once the deadline has passed; it must bail out fast.
test("fetchEdgarMonthCount: an absolute deadlineAt cuts a sustained-429 retry loop short (never runs the full backoff cycle)", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({}) } as Response;
  }) as any;
  try {
    const start = Date.now();
    const deadlineAt = start + 50; // real ms — well short of 500+1000+2000ms of backoff
    const result = await fetchEdgarMonthCount("2020-01-01", "2020-01-31", 15000, { warn: () => {} }, 4, deadlineAt);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Without deadline propagation this would take >3.5s (500+1000+2000ms of
    // backoff sleeps); with it, it must return well before the first full
    // backoff sleep completes.
    expect(elapsed).toBeLessThan(1000);
    expect(calls).toBeLessThan(4); // never reaches all 4 attempts
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);

test("fetchEdgarMonthCount: no deadlineAt behaves exactly as before (unbounded by any outer deadline)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ hits: { total: { value: 11 } } }),
  })) as any;
  try {
    const result = await fetchEdgarMonthCount("2020-01-01", "2020-01-31", 15000, { warn: () => {} });
    expect(result).toBe(11);
  } finally {
    globalThis.fetch = orig;
  }
}, 10_000);
