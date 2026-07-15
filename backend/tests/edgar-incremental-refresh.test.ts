// Orchestration coverage for the incremental EDGAR/MNA research refresh
// (issue #109): refreshEdgarIncremental ties the pure planner to a fetch
// loop under one hard deadline. Every test here injects `fetchMonth` (and,
// for the deadline test, a fake `now`) — no real network, no real timers,
// deterministic and fast.
import { test, expect } from "bun:test";
import { refreshEdgarIncremental } from "../src/analytics/edgar-incremental-refresh.ts";
import { EDGAR_REVISION_WINDOW_MONTHS } from "../src/analytics/extract/edgar-fetch-plan.ts";

function allMonthsBetween(startYm: string, endYm: string): string[] {
  const out: string[] = [];
  let [y, m] = startYm.split("-").map(Number) as [number, number];
  const [ey, em] = endYm.split("-").map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// ── AC2: a fully-seeded floor requests only missing/revisable months; a
//    second run against the (now-updated) floor performs ZERO requests ────

test("refreshEdgarIncremental: a fully seeded floor requests only missing+revision months; a LATER run performs ZERO historical (pre-revision-window) requests", async () => {
  const asOf = "2020-06-30";
  const persistedMonths = allMonthsBetween("2010-01", "2020-05"); // everything EXCEPT the current month
  const requested: string[] = [];
  const fetchMonth = async (monthStart: string, monthEnd: string) => {
    requested.push(monthStart);
    return 7;
  };

  const first = await refreshEdgarIncremental({
    asOf,
    persistedMonths,
    deadlineAt: Date.now() + 60_000,
    fetchMonth,
    requestDelayMs: 0,
    logger: { log: () => {}, warn: () => {} },
  });

  expect(first.status).toBe("updated");
  // Only the missing month (2020-06) + the revision window are requested —
  // never the full ~125-month history.
  expect(requested.length).toBe(1 + EDGAR_REVISION_WINDOW_MONTHS - 1); // 2020-06 already covers 1 of the window slots
  expect(first.newRows.length).toBe(requested.length);
  expect(first.plannedMonths).toBe(requested.length);

  // A LATER run (the next scheduled tick, one month on) against the
  // now-updated floor requests ONLY the (small, fixed) trailing revision
  // window — ZERO requests for any month outside it. This is the
  // "no historical crawl" invariant: the request set never grows back
  // toward the full ~125-month range no matter how many times the job runs.
  const updatedPersistedMonths = [...persistedMonths, ...first.newRows.map((r) => r.date.slice(0, 7))];
  const laterAsOf = "2020-07-31";
  const requested2: string[] = [];
  const second = await refreshEdgarIncremental({
    asOf: laterAsOf,
    persistedMonths: updatedPersistedMonths,
    deadlineAt: Date.now() + 60_000,
    fetchMonth: async (monthStart: string) => {
      requested2.push(monthStart);
      return 7;
    },
    requestDelayMs: 0,
  });
  expect(second.status).toBe("updated");
  // 2020-07 is the one newly-missing month; it also happens to fall inside
  // its own trailing revision window, so the plan is exactly the window size.
  expect(requested2.length).toBe(EDGAR_REVISION_WINDOW_MONTHS);
  // Every requested month is within the trailing revision window of the
  // LATER as-of — none is "historical" (older than 2020-06).
  for (const m of requested2) expect(m >= "2020-06-01").toBe(true);

  // Replaying the SAME (asOf, floor) pair again is fully stable/idempotent:
  // identical request set, identical result shape (AC7).
  const requested3: string[] = [];
  const third = await refreshEdgarIncremental({
    asOf: laterAsOf,
    persistedMonths: updatedPersistedMonths,
    deadlineAt: Date.now() + 60_000,
    fetchMonth: async (monthStart: string) => {
      requested3.push(monthStart);
      return 7;
    },
    requestDelayMs: 0,
  });
  expect(third.plannedMonths).toBe(second.plannedMonths);
  expect(third.newRows).toEqual(second.newRows); // stable output on replay
  expect(requested3).toEqual(requested2);
});

// ── AC3: fake-clock hard-deadline abort ──────────────────────────────────

test("refreshEdgarIncremental: aborts at the hard deadline (fake clock) — no request continues after cancellation", async () => {
  const asOf = "2015-12-31";
  const persistedMonths: string[] = []; // nothing persisted — a long plan (72 months)
  let clock = 0;
  const now = () => clock;
  const STALL_MS = 50;
  const DEADLINE = 120; // fake-clock ms — well short of exhausting the ~72-month plan
  const requested: string[] = [];
  const fetchMonth = async (monthStart: string) => {
    requested.push(monthStart);
    clock += STALL_MS; // simulate a stalled request consuming clock time
    return null; // every request "stalls"/fails — never resolves a real count
  };

  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths,
    deadlineAt: DEADLINE,
    now,
    fetchMonth,
    requestDelayMs: 0, // isolate the deadline check from the politeness delay
    logger: { log: () => {}, warn: () => {} },
  });

  expect(outcome.status).toBe("degraded");
  expect(outcome.reason).toMatch(/deadline/);
  // Bounded well short of the full plan — proves the sweep stopped at (or
  // just past, by at most one stalled request) the deadline, not after
  // exhausting every planned month.
  const fullPlanMonths = 72; // Jan-2010..Dec-2015 is 72 months
  expect(requested.length).toBeLessThan(fullPlanMonths);
  // "plus a small deterministic tolerance": at most one in-flight request is
  // allowed to have started before the deadline check fired.
  expect(clock).toBeLessThanOrEqual(DEADLINE + STALL_MS);
  expect(outcome.newRows).toEqual([]); // no partial commit
});

// ── AC4: failure matrix — every case degrades honestly, no partial commit ─

test("failure matrix: one missing month (unrecovered) degrades the whole batch", async () => {
  const asOf = "2010-03-31";
  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths: [],
    deadlineAt: Date.now() + 60_000,
    fetchMonth: async (monthStart: string) => (monthStart === "2010-02-01" ? null : 3),
    requestDelayMs: 0,
  });
  expect(outcome.status).toBe("degraded");
  expect(outcome.newRows).toEqual([]);
  expect(outcome.missingMonths).toBeGreaterThan(0);
});

test("failure matrix: a duplicate response can never surface a duplicate date at this layer (structural guarantee); the payload-level case is covered by validateEdgarBatch + the raw-history API's duplicate-(date) rejection", async () => {
  // refreshEdgarIncremental stamps each fetched count on ITS OWN planned
  // month's monthEnd (fetchMonth returns only a count, never a date) — and
  // planEdgarFetch's months are already deduplicated — so two entries in
  // the same batch can never collide on date from this orchestration layer
  // alone. Returning the SAME count for every month (a plausible "duplicate
  // response" from a confused upstream) is therefore harmless here: dates
  // stay distinct, values coinciding is not itself invalid.
  const asOf = "2010-03-31";
  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths: [],
    fetchMonth: async () => 3, // identical count for every month — not a date collision
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  expect(outcome.status).toBe("updated");
  const dates = outcome.newRows.map((r) => r.date);
  expect(new Set(dates).size).toBe(dates.length); // still all-distinct dates
  // The genuine duplicate-DATE failure case (two batch entries claiming the
  // same date) is exercised directly against validateEdgarBatch in
  // edgar-fetch-plan.test.ts ("a duplicate date across two batch entries
  // fails"), and defended a second time at the raw-history API boundary
  // (backend/src/api/routes/analytics.ts parseRawHistory rejects a
  // duplicate (indicator, date) pair in any submitted payload).
});

test("failure matrix: an invalid (negative) count degrades the whole batch", async () => {
  const asOf = "2010-02-28";
  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths: [],
    fetchMonth: async (monthStart: string) => (monthStart === "2010-01-01" ? -1 : 3),
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  expect(outcome.status).toBe("degraded");
  expect(outcome.reason).toMatch(/finite non-negative integer/);
  expect(outcome.rejectedMonths).toBeGreaterThan(0); // a RESPONSE was received, just invalid — not "missing"
  expect(outcome.newRows).toEqual([]);
});

test("failure matrix: 429/5xx exhaustion (fetchMonth returns null after retries) degrades the whole batch", async () => {
  const asOf = "2010-01-31";
  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths: [],
    fetchMonth: async () => null, // simulates fetchEdgarMonthCount exhausting retries on 429/5xx
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  expect(outcome.status).toBe("degraded");
  expect(outcome.newRows).toEqual([]);
});

test("failure matrix: malformed JSON (fetchMonth resolves null, matching parseEdgarCount's contract) degrades", async () => {
  const asOf = "2010-01-31";
  // parseEdgarCount already returns null for a response missing hits.total.value;
  // fetchEdgarMonthCount surfaces that as null (no count in response). The
  // refresh treats it identically to any other unrecovered month.
  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths: [],
    fetchMonth: async () => null,
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  expect(outcome.status).toBe("degraded");
});

test("failure matrix: an as-of before the declared floor start plans (and fetches) NOTHING rather than an out-of-range request", async () => {
  let calls = 0;
  const outcome = await refreshEdgarIncremental({
    asOf: "2009-06-30", // before EDGAR_FLOOR_START (2010-01-01)
    persistedMonths: [],
    fetchMonth: async () => {
      calls++;
      return 3;
    },
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  expect(outcome.status).toBe("up-to-date");
  expect(outcome.plannedMonths).toBe(0);
  expect(calls).toBe(0); // never even attempts an out-of-range request
});

// ── AC7: idempotency — replaying the same (asOf, floor) is a stable,
//    explicitly-reported no-op for NEW data even though the fixed trailing
//    revision window is (by design) always re-confirmed ──────────────────

test("idempotency: replaying the same complete incremental payload against the updated floor is stable and explicitly reports zero NEW months", async () => {
  const asOf = "2011-01-31";
  const persistedMonths = allMonthsBetween("2010-01", "2010-12");
  let calls = 0;
  const fetchMonth = async () => {
    calls++;
    return 9; // deterministic — same upstream value every call
  };
  const first = await refreshEdgarIncremental({
    asOf,
    persistedMonths,
    fetchMonth,
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  expect(first.status).toBe("updated");
  expect(first.newMonths).toBe(1); // 2011-01 was genuinely missing
  expect(first.newRows.length).toBeGreaterThan(0);
  const callsAfterFirst = calls;

  const merged = [...persistedMonths, ...first.newRows.map((r) => r.date.slice(0, 7))];
  const replay = await refreshEdgarIncremental({
    asOf,
    persistedMonths: merged,
    fetchMonth,
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  // The replay is NOT "up-to-date" (the fixed revision window is always
  // re-confirmed) but explicitly reports zero NEW months this time — the
  // idempotent "no-op for new data" signal — with a STABLE result: the same
  // rows, re-submitted (an upsert on (date, indicator) converges, never
  // duplicates).
  expect(replay.status).toBe("updated");
  expect(replay.newMonths).toBe(0); // explicit no-op signal: nothing NEW
  expect(replay.revisedMonths).toBe(replay.plannedMonths);
  expect(replay.newRows).toEqual(first.newRows); // stable output on replay
  expect(calls).toBeGreaterThan(callsAfterFirst); // revision window IS re-fetched (by design)
});
