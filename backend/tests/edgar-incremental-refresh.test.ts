// Orchestration coverage for the two-tier EDGAR/MNA research refresh:
// refreshEdgarIncremental ties a pure planner to a fetch loop under one hard
// deadline. R6 (docs/v0-v1-quant-platform-parity-report.md, finding 1.10)
// established that a revision-windowed plan can permanently miss an old
// EDGAR back-revision; the first R6 fix over-corrected by making EVERY run
// a full [floorStart, asof] crawl (~200 requests, daily, forever). The
// design under test here restores a cheap Tier 1 (incremental) default for
// most runs, with Tier 2 (full) running periodically — selected by
// `selectEdgarRefreshTier`, a pure function of `asOf` alone — so a
// historical revision still lands, just on a bounded periodic cadence
// instead of every single run. Every test here injects `fetchMonth` (and,
// for the deadline test, a fake `now`) — no real network, no real timers,
// deterministic and fast.
import { test, expect } from "bun:test";
import {
  refreshEdgarIncremental,
  selectEdgarRefreshTier,
  EDGAR_FULL_SWEEP_WEEKDAY_UTC,
} from "../src/analytics/edgar-incremental-refresh.ts";

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

// ── selectEdgarRefreshTier: pure, deterministic tier selection ───────────
// (no network, no clock — a direct function of `asOf` alone, so the SAME
// tier decision is reproducible for a replayed/backfilled past `asOf`)

test("selectEdgarRefreshTier: every day of a full week resolves to exactly one 'full' day, the rest 'incremental'", () => {
  // 2026-08-02 is a Sunday (UTC) — EDGAR_FULL_SWEEP_WEEKDAY_UTC's default.
  const week = ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"];
  const tiers = week.map((d) => selectEdgarRefreshTier(d));
  expect(tiers.filter((t) => t === "full").length).toBe(1);
  expect(tiers[0]).toBe("full"); // 2026-08-02 is the Sunday
  for (let i = 1; i < tiers.length; i++) expect(tiers[i]).toBe("incremental");
});

test("selectEdgarRefreshTier: is a pure function of asOf alone — same input, same output, no hidden clock dependency", () => {
  expect(selectEdgarRefreshTier("2026-08-02")).toBe(selectEdgarRefreshTier("2026-08-02"));
  expect(selectEdgarRefreshTier("2026-08-03")).toBe(selectEdgarRefreshTier("2026-08-03"));
});

test("selectEdgarRefreshTier: EDGAR_FULL_SWEEP_WEEKDAY_UTC default is Sunday (0)", () => {
  expect(EDGAR_FULL_SWEEP_WEEKDAY_UTC).toBe(0);
  expect(selectEdgarRefreshTier("2026-08-02")).toBe("full"); // Sunday
  expect(selectEdgarRefreshTier("2026-08-03")).toBe("incremental"); // Monday
});

test("selectEdgarRefreshTier: an explicit override weekday changes which day is 'full'", () => {
  // 2026-08-05 is a Wednesday (UTC).
  expect(selectEdgarRefreshTier("2026-08-05", 3)).toBe("full");
  expect(selectEdgarRefreshTier("2026-08-04", 3)).toBe("incremental");
});

// ── Tier 1 (incremental, the daily default): only missing + revision
//    window are requested — the whole point of running this tier at all ──

test("refreshEdgarIncremental: default tier on a non-full-sweep day is 'incremental' — a fully seeded floor requests ONLY the newly-missing month plus the revision window, not the whole history", async () => {
  const asOf = "2010-06-30"; // Wednesday (UTC) — not the full-sweep weekday
  expect(selectEdgarRefreshTier(asOf)).toBe("incremental");
  const persistedMonths = allMonthsBetween("2010-01", "2010-05"); // everything except the current month already persisted
  const requested: string[] = [];
  const fetchMonth = async (monthStart: string) => {
    requested.push(monthStart);
    return 7;
  };

  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths,
    deadlineAt: Date.now() + 60_000,
    fetchMonth,
    requestDelayMs: 0,
    logger: { log: () => {}, warn: () => {} },
  });

  expect(outcome.status).toBe("updated");
  expect(outcome.tier).toBe("incremental");
  // Only the genuinely-new month (2010-06) plus the trailing 2-month
  // revision window (2010-05, already covered by "new" here) are
  // requested — NOT the full Jan-Jun range. Deep history (2010-01..2010-03)
  // is NOT re-requested by this tier.
  expect(requested.sort()).toEqual(["2010-05-01", "2010-06-01"]);
  expect(outcome.plannedMonths).toBe(2);
  expect(outcome.newMonths).toBe(1); // 2010-06
  expect(outcome.revisedMonths).toBe(1); // 2010-05, re-fetched for the revision window
});

test("refreshEdgarIncremental: tier 'full' (forced — the periodic reconciliation sweep) requests EVERY month in range regardless of what is already persisted", async () => {
  const asOf = "2010-06-30"; // deliberately a non-full-sweep weekday — proves the override, not the default, drives this
  const persistedMonths = allMonthsBetween("2010-01", "2010-05");
  const requested: string[] = [];
  const fetchMonth = async (monthStart: string) => {
    requested.push(monthStart);
    return 7;
  };

  const first = await refreshEdgarIncremental({
    asOf,
    persistedMonths,
    tier: "full",
    deadlineAt: Date.now() + 60_000,
    fetchMonth,
    requestDelayMs: 0,
    logger: { log: () => {}, warn: () => {} },
  });

  expect(first.status).toBe("updated");
  expect(first.tier).toBe("full");
  // Every month Jan-Jun 2010 is requested, not just the newly-missing one —
  // this is the property that bounds EDGAR revision staleness even for
  // months far outside any trailing window.
  expect(requested.map((m) => m.slice(0, 7))).toEqual(allMonthsBetween("2010-01", "2010-06"));
  expect(first.newRows.length).toBe(requested.length);
  expect(first.plannedMonths).toBe(requested.length);
  expect(first.newMonths).toBe(1); // 2010-06 is the only month not already in persistedMonths
  expect(first.revisedMonths).toBe(5); // the other 5 WERE already persisted, and are re-fetched anyway

  // A LATER full-tier run against the now-updated floor STILL requests
  // every month — the request set never shrinks back to "only what's
  // missing" for this tier: any back-revision to Jan 2010, however old,
  // lands on this run.
  const updatedPersistedMonths = [...persistedMonths, ...first.newRows.map((r) => r.date.slice(0, 7))];
  const laterAsOf = "2010-07-31";
  const requested2: string[] = [];
  const second = await refreshEdgarIncremental({
    asOf: laterAsOf,
    persistedMonths: updatedPersistedMonths,
    tier: "full",
    deadlineAt: Date.now() + 60_000,
    fetchMonth: async (monthStart: string) => {
      requested2.push(monthStart);
      return 7;
    },
    requestDelayMs: 0,
  });
  expect(second.status).toBe("updated");
  expect(requested2.map((m) => m.slice(0, 7))).toEqual(allMonthsBetween("2010-01", "2010-07"));
  expect(second.newMonths).toBe(1); // only 2010-07 is genuinely new
  expect(second.revisedMonths).toBe(6); // every prior month is re-fetched despite already being persisted

  // Replaying the SAME (asOf, floor, tier) triple again is fully
  // stable/idempotent: identical request set, identical result shape (AC7).
  const requested3: string[] = [];
  const third = await refreshEdgarIncremental({
    asOf: laterAsOf,
    persistedMonths: updatedPersistedMonths,
    tier: "full",
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

// ── AC3: fake-clock hard-deadline abort (still enforced under either tier —
//    the two-tier split changes the PLAN size, not the honesty/degrade
//    safety net) ────────────────────────────────────────────────────────

test("refreshEdgarIncremental: aborts at the hard deadline (fake clock) — no request continues after cancellation", async () => {
  const asOf = "2015-12-31";
  let clock = 0;
  const now = () => clock;
  const STALL_MS = 50;
  const DEADLINE = 120; // fake-clock ms — well short of exhausting the ~72-month full-range plan
  const requested: string[] = [];
  const fetchMonth = async (monthStart: string) => {
    requested.push(monthStart);
    clock += STALL_MS; // simulate a stalled request consuming clock time
    return null; // every request "stalls"/fails — never resolves a real count
  };

  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths: [],
    tier: "full", // force the large (~72-month) plan so the deadline fires mid-sweep, not after exhausting a small one
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

// ── AC4: failure matrix — every case degrades honestly, no partial commit,
//    under the default (Tier 1 / cheap) path since that's what runs most
//    days; the honesty model itself is exercised tier-independently (an
//    empty persisted floor makes Tier 1's plan identical to Tier 2's) ─────

test("failure matrix: one missing month (unrecovered) degrades the whole batch", async () => {
  const asOf = "2010-03-31";
  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths: [],
    tier: "incremental",
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
  // both planners' months are already deduplicated — so two entries in
  // the same batch can never collide on date from this orchestration layer
  // alone. Returning the SAME count for every month (a plausible "duplicate
  // response" from a confused upstream) is therefore harmless here: dates
  // stay distinct, values coinciding is not itself invalid.
  const asOf = "2010-03-31";
  const outcome = await refreshEdgarIncremental({
    asOf,
    persistedMonths: [],
    tier: "incremental",
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
    tier: "incremental",
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
    tier: "incremental",
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
    tier: "incremental",
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
    tier: "incremental",
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
//    explicitly-reported no-op for NEW data, under both tiers ────────────

test("idempotency (tier 'incremental'): replaying the same as-of after the newly-missing month lands reports zero NEW months and stops re-requesting it", async () => {
  const asOf = "2010-02-28";
  const persistedMonths = allMonthsBetween("2010-01", "2010-01");
  let calls = 0;
  const fetchMonth = async () => {
    calls++;
    return 9; // deterministic — same upstream value every call
  };
  const first = await refreshEdgarIncremental({
    asOf,
    persistedMonths,
    tier: "incremental",
    fetchMonth,
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  expect(first.status).toBe("updated");
  expect(first.newMonths).toBe(1); // 2010-02 was genuinely missing
  expect(first.newRows.length).toBe(first.plannedMonths); // every planned month validated successfully

  const merged = [...persistedMonths, ...first.newRows.map((r) => r.date.slice(0, 7))];
  const callsAfterFirst = calls;
  const replay = await refreshEdgarIncremental({
    asOf,
    persistedMonths: merged,
    tier: "incremental",
    fetchMonth,
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  // Every month is now persisted, so ONLY the trailing revision window is
  // re-requested (not "everything", the way tier 'full' would) — a stable,
  // explicit "no NEW months" no-op.
  expect(replay.status).toBe("updated");
  expect(replay.newMonths).toBe(0); // explicit no-op signal: nothing NEW
  expect(replay.plannedMonths).toBeLessThanOrEqual(merged.length); // never re-crawls deep history
  expect(calls).toBeGreaterThan(callsAfterFirst); // the revision window is still re-confirmed every run, by design
});

test("idempotency (tier 'full'): replaying the same complete full-range payload against the updated floor is stable and explicitly reports zero NEW months", async () => {
  const asOf = "2010-02-28";
  const persistedMonths = allMonthsBetween("2010-01", "2010-01");
  let calls = 0;
  const fetchMonth = async () => {
    calls++;
    return 9; // deterministic — same upstream value every call
  };
  const first = await refreshEdgarIncremental({
    asOf,
    persistedMonths,
    tier: "full",
    fetchMonth,
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  expect(first.status).toBe("updated");
  expect(first.newMonths).toBe(1); // 2010-02 was genuinely missing
  expect(first.newRows.length).toBeGreaterThan(0);
  const callsAfterFirst = calls;

  const merged = [...persistedMonths, ...first.newRows.map((r) => r.date.slice(0, 7))];
  const replay = await refreshEdgarIncremental({
    asOf,
    persistedMonths: merged,
    tier: "full",
    fetchMonth,
    deadlineAt: Date.now() + 60_000,
    requestDelayMs: 0,
  });
  // The replay is NOT "up-to-date" (tier 'full' always re-confirms the
  // whole range) but explicitly reports zero NEW months this time — the
  // idempotent "no-op for new data" signal — with a STABLE result: the same
  // rows, re-submitted (an upsert on (date, indicator) converges, never
  // duplicates).
  expect(replay.status).toBe("updated");
  expect(replay.newMonths).toBe(0); // explicit no-op signal: nothing NEW
  expect(replay.revisedMonths).toBe(replay.plannedMonths);
  expect(replay.newRows).toEqual(first.newRows); // stable output on replay
  expect(calls).toBeGreaterThan(callsAfterFirst); // the FULL range is re-fetched every tier-'full' run, by design
});
