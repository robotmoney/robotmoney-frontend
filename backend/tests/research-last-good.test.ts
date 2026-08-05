// AC5 (atomicity/last-good) + AC7 (idempotency) coverage for the EDGAR/MNA
// research refresh, over the REAL authenticated /api/analytics/* boundary
// and the REAL ephemeral Postgres the preload provisions. Only outbound SEC
// EDGAR/Yahoo/FRED HTTP is faked.
//
// R6 (docs/v0-v1-quant-platform-parity-report.md, finding 1.10) originally
// widened the fetch plan from "missing months + a 2-month revision window"
// to the FULL [EDGAR_FLOOR_START, asof] range every run, matching v0's
// late-cycle-signals.js — then a follow-up review found that "every run,
// forever" was itself too expensive for production (~200 live EDGAR
// requests/day), so the live pipeline now runs a cheap Tier 1 (incremental)
// sweep most days and only the FULL Tier 2 sweep on a bounded periodic
// cadence (selectEdgarRefreshTier — see edgar-incremental-refresh.ts).
// These tests specifically exercise the Tier 2 (full re-crawl) path end to
// end over the real API + DB, so every `asof` below is deliberately chosen
// to land on the periodic full-sweep weekday (Sunday UTC,
// EDGAR_FULL_SWEEP_WEEKDAY_UTC's default) — verify with
// `date -u -d "<asof>" +%A` if you ever need to change one. Every `asof` is
// ALSO close to EDGAR_FLOOR_START so the full-range plan stays a handful of
// months — otherwise a real full 2010-to-present sweep (~113+ months, each
// paced 250ms apart, times three sequential runs per test) blows well past
// any reasonable test timeout. The atomicity/idempotency PROPERTIES under
// test are independent of how many months are in the plan or which tier
// produced it — Tier 2 is simply the more expensive path to prove them on
// end to end, since it exercises the full-range planner over the real
// boundary.
//
//   AC5 — when the refresh DEGRADES (a required month comes back missing),
//         NEITHER the persisted MNA floor NOR the published
//         late-cycle-signals row for that as-of may change: readers observe
//         either the prior complete version or a new complete version,
//         never a signal computed against a partial floor. The run reports
//         an explicit degraded/skipped outcome — never silent success.
//   AC7 — replaying the SAME successful refresh (same as-of, same upstream
//         values) a second time converges: no duplicate raw-history rows,
//         a stable recomputed signal payload.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { liveDataSource } from "../src/analytics/access/data-source.ts";
import { analyticsApiClient } from "../src/analytics/api-client.ts";

const TOKEN = "tok_research_last_good_secret";

function startdtOf(url: string): string {
  try {
    return new URL(url).searchParams.get("startdt") ?? "";
  } catch {
    return "";
  }
}

function installFetchDouble(localBaseUrl: string, edgarCountFor: (monthStart: string) => number | null) {
  const orig = globalThis.fetch;
  const edgarRequests: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.startsWith("https://efts.sec.gov/")) {
      edgarRequests.push(url);
      const count = edgarCountFor(startdtOf(url));
      if (count == null) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => ({ hits: { total: { value: count } } }) } as Response;
    }
    if (url.startsWith(localBaseUrl)) return orig(input, init);
    throw new Error(`network disabled in test: ${url}`); // Yahoo/FRED — safe() degrades to []
  }) as any;
  return { edgarRequests, restore: () => { globalThis.fetch = orig; } };
}

async function mnaRows(): Promise<{ date: string; value: number }[]> {
  const rows = await sql`SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = 'MNA' ORDER BY date`;
  return rows.map((r) => ({ date: r.date, value: Number(r.value) }));
}

// A real Bun.serve wrapping the REAL handleAnalytics — except requests
// matching `failPath`/`failMethod` (when the toggle is armed) short-circuit
// to a 500 BEFORE ever reaching handleAnalytics, so no DB write happens for
// that specific call. Simulates "the analytics API rejects a fully
// validated submission" (issue #109 AC4's last failure-matrix case) without
// needing to fault-inject Postgres itself.
function startRejectingServer() {
  let failMethod: string | null = null;
  let failPath: string | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (failMethod && failPath && req.method === failMethod && url.pathname === failPath) {
        return new Response(JSON.stringify({ error: "simulated API rejection" }), { status: 500 });
      }
      const r = await handleAnalytics(req, url);
      if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    },
  });
  return {
    server,
    armFailure(method: string, path: string) { failMethod = method; failPath = path; },
    disarm() { failMethod = null; failPath = null; },
  };
}

test(
  "atomicity + idempotency: a degraded refresh NEVER changes the persisted floor or the published signal; a repeated SUCCESSFUL refresh converges",
  async () => {
    const origConfig = { analyticsToken: config.analyticsToken, allowInsecure: config.allowInsecure };
    const origEnv = {
      ANALYTICS_SOURCE: process.env.ANALYTICS_SOURCE,
      ANALYTICS_API_URL: process.env.ANALYTICS_API_URL,
      ANALYTICS_TOKEN: process.env.ANALYTICS_TOKEN,
    };
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const r = await handleAnalytics(req, url);
        if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      },
    });
    let fetchDouble: ReturnType<typeof installFetchDouble> | null = null;
    try {
      config.analyticsToken = TOKEN;
      config.allowInsecure = false;
      process.env.ANALYTICS_SOURCE = "live";
      process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;
      process.env.ANALYTICS_TOKEN = TOKEN;

      const asof = "2010-03-14"; // a Sunday (full-sweep weekday) close to EDGAR_FLOOR_START (2010-01) — full range is {2010-01, 2010-02, 2010-03}
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
      await sql`DELETE FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      // A partially seeded floor (2010-01 only) — this asof lands on the
      // full-sweep weekday, so tier 'full' is selected: the plan is the
      // FULL [EDGAR_FLOOR_START, asof] range regardless of what's already
      // persisted, so 2010-01/02/03 are ALL (re-)fetched this run, not just
      // the newly-missing months (contrast with the cheaper tier
      // 'incremental' plan any other day would select).
      const seed: { date: string; indicator: string; value: number }[] = [
        { date: "2010-01-31", indicator: "MNA", value: 11 },
      ];
      await sql`INSERT INTO raw_indicator_history ${sql(seed, "date", "indicator", "value")}`;
      const fullRangeMonths = 3; // 2010-01, 2010-02, 2010-03

      // ── RUN 1: a fully successful refresh — establishes the "last-good"
      // floor + signal for this as-of.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 99);
      const results1 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;
      expect(results1["late-cycle-signals"]).toBeDefined();
      expect((results1["late-cycle-signals"] as any).skipped).toBeUndefined();

      const floorAfterRun1 = await mnaRows();
      // Tier 'full': every month in range is (re-)submitted (an upsert on
      // (date, indicator)), so the ROW COUNT is exactly the full range —
      // not seed.length + "only what was missing".
      expect(floorAfterRun1.length).toBe(fullRangeMonths);
      // RESTORED (issue #509): bounded — a refresh for an asof this close to
      // EDGAR_FLOOR_START must never produce a ~200-row floor. Deleted by PR
      // #471; it is the assertion that would have caught a plan/write
      // silently widening to the whole history.
      expect(floorAfterRun1.length).toBeLessThan(200);
      const [sigAfterRun1] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigAfterRun1).toBeDefined();
      const payloadAfterRun1 = sigAfterRun1.payload;

      // ── RUN 2: the SAME as-of, but EDGAR now fails ONE required month
      // (tier 'full': every month is required — pick the current asof
      // month) — the refresh must degrade.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, (monthStart) =>
        monthStart === "2010-03-01" ? null : 99,
      );
      const results2 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;

      // Explicit degraded outcome — never silent success.
      expect((results2["late-cycle-signals"] as any).skipped).toBe(true);
      expect(typeof (results2["late-cycle-signals"] as any).reason).toBe("string");

      // NOTHING changed: same floor, same signal payload (last-good retained).
      const floorAfterRun2 = await mnaRows();
      expect(floorAfterRun2).toEqual(floorAfterRun1);
      const [sigAfterRun2] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigAfterRun2.payload).toEqual(payloadAfterRun1);

      // ── RUN 3 (AC7): replaying the SAME successful upstream a second time
      // converges — no duplicate rows, a stable recomputed payload.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 99);
      const results3 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;
      expect((results3["late-cycle-signals"] as any).skipped).toBeUndefined();

      const floorAfterRun3 = await mnaRows();
      expect(floorAfterRun3.length).toBe(floorAfterRun1.length); // no duplicate rows
      expect(floorAfterRun3).toEqual(floorAfterRun1); // same values, stable
      const [sigAfterRun3] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigAfterRun3.payload).toEqual(payloadAfterRun1); // stable signal output
    } finally {
      if (fetchDouble) fetchDouble.restore();
      server.stop(true);
      config.analyticsToken = origConfig.analyticsToken;
      config.allowInsecure = origConfig.allowInsecure;
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k as keyof typeof origEnv];
        else process.env[k as keyof typeof origEnv] = v;
      }
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
    }
  },
  { timeout: 60_000 },
);

// AC4's last failure-matrix case ("API rejection") + advisory: a genuine
// mid-operation failure BETWEEN the sequential saveRawHistory and
// saveResearchSignal submissions (not just "fail before any write").
test(
  "API rejection: a fully validated EDGAR batch that the analytics API itself rejects changes NOTHING and throws; a rejection on the LATER signal submission still leaves the just-committed floor write in place but never publishes a signal against it",
  async () => {
    const origConfig = { analyticsToken: config.analyticsToken, allowInsecure: config.allowInsecure };
    const origEnv = {
      ANALYTICS_SOURCE: process.env.ANALYTICS_SOURCE,
      ANALYTICS_API_URL: process.env.ANALYTICS_API_URL,
      ANALYTICS_TOKEN: process.env.ANALYTICS_TOKEN,
    };
    const { server, armFailure, disarm } = startRejectingServer();
    let fetchDouble: ReturnType<typeof installFetchDouble> | null = null;
    try {
      config.analyticsToken = TOKEN;
      config.allowInsecure = false;
      process.env.ANALYTICS_SOURCE = "live";
      process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;
      process.env.ANALYTICS_TOKEN = TOKEN;

      const asof = "2010-04-11"; // a Sunday (full-sweep weekday) close to EDGAR_FLOOR_START (2010-01) — full range is {2010-01..2010-04}
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
      await sql`DELETE FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      const seed: { date: string; indicator: string; value: number }[] = [
        { date: "2010-01-31", indicator: "MNA", value: 3 },
        { date: "2010-02-28", indicator: "MNA", value: 3 },
      ];
      await sql`INSERT INTO raw_indicator_history ${sql(seed, "date", "indicator", "value")}`;

      // ── RUN A: establishes last-good (this asof lands on the full-sweep
      // weekday → tier 'full': the FULL range 2010-01..2010-04 lands, value=5).
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 5);
      const resultsA = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;
      expect((resultsA["late-cycle-signals"] as any).skipped).toBeUndefined();
      const floorAfterA = await mnaRows();
      const [sigAfterA] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigAfterA).toBeDefined();

      // ── RUN B: a FULLY VALID EDGAR batch (tier 'full': the plan's FULL
      // range is re-fetched — new values every run by design), but the
      // analytics API's raw-history submission ITSELF rejects (500).
      armFailure("POST", "/api/analytics/raw-history");
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 11);
      await expect(runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient())).rejects.toThrow();
      fetchDouble.restore();
      fetchDouble = null;
      disarm();

      // NOTHING changed: the rejected submission never touched the DB, and
      // saveResearchSignal was never reached (the throw happened first).
      const floorAfterB = await mnaRows();
      expect(floorAfterB).toEqual(floorAfterA);
      const [sigAfterB] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigAfterB.payload).toEqual(sigAfterA.payload);

      // ── RUN C: the raw-history submission SUCCEEDS this time (a real,
      // durable write with a NEW deterministic value), but the LATER
      // research-signals submission is what the API rejects — a genuine
      // mid-operation failure BETWEEN the two sequential writes.
      armFailure("POST", "/api/analytics/research-signals");
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 17);
      await expect(runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient())).rejects.toThrow();
      fetchDouble.restore();
      fetchDouble = null;
      disarm();

      // The floor write DID commit (durable, even though the overall run
      // failed later) — readers of the floor see the new value.
      const floorAfterC = await mnaRows();
      const aprAfterC = floorAfterC.find((r) => r.date === "2010-04-30");
      expect(aprAfterC?.value).toBe(17);
      // But the signal was NEVER published against it: readers of
      // research_signals still see the PRIOR complete version (from RUN A),
      // never a signal computed from this run's (now-persisted) floor.
      const [sigAfterC] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigAfterC.payload).toEqual(sigAfterA.payload);
    } finally {
      disarm();
      if (fetchDouble) fetchDouble.restore();
      server.stop(true);
      config.analyticsToken = origConfig.analyticsToken;
      config.allowInsecure = origConfig.allowInsecure;
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k as keyof typeof origEnv];
        else process.env[k as keyof typeof origEnv] = v;
      }
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
    }
  },
  { timeout: 60_000 },
);

// ── the batch-level divergence guard, end to end (issue #509) ──────────────
//
// The defect this covers: a Tier 2 sweep's ONLY gate before ~200 rows became
// authoritative was the per-row `validateEdgarBatch`, which accepts any
// finite non-negative integer — including the `0` an HTTP-200
// `{"hits":{"total":{"value":0}}}` yields while SEC's FTS index is mid-
// rebuild. The write is `ON CONFLICT (date, indicator) DO UPDATE SET value,
// source`, and the gap-fill seed path can only restore MISSING dates, so a
// single bad Sunday rewrote the archived baseline unrepairably.
//
// Every run below goes through the REAL authenticated API + REAL Postgres,
// and the assertion that matters is on the DATABASE, not on a return value:
// after a degenerate sweep the persisted rows must be byte-identical to what
// they were before.
test(
  "divergence guard: a complete, well-formed but DEGENERATE full-sweep batch degrades instead of overwriting the persisted floor; a bulk rewrite is refused too; a realistic back-revision still lands",
  async () => {
    const origConfig = { analyticsToken: config.analyticsToken, allowInsecure: config.allowInsecure };
    const origEnv = {
      ANALYTICS_SOURCE: process.env.ANALYTICS_SOURCE,
      ANALYTICS_API_URL: process.env.ANALYTICS_API_URL,
      ANALYTICS_TOKEN: process.env.ANALYTICS_TOKEN,
    };
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const r = await handleAnalytics(req, url);
        if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      },
    });
    let fetchDouble: ReturnType<typeof installFetchDouble> | null = null;
    try {
      config.analyticsToken = TOKEN;
      config.allowInsecure = false;
      process.env.ANALYTICS_SOURCE = "live";
      process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;
      process.env.ANALYTICS_TOKEN = TOKEN;

      // 2011-01-02 is a Sunday (the full-sweep weekday), so tier 'full' plans
      // the whole 13-month [2010-01, 2011-01] range — a miniature of the real
      // ~199-month sweep, every month of it already persisted with a real
      // value. Small enough to run four real-paced sweeps inside a test.
      const asof = "2011-01-02";
      const fullRangeMonths = 13;
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
      await sql`DELETE FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      const seed: { date: string; indicator: string; value: number }[] = [];
      const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let i = 0; i < fullRangeMonths; i++) {
        const y = 2010 + Math.floor(i / 12);
        const m = (i % 12) + 1;
        const day = lastDayOfMonth(y, m);
        seed.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, indicator: "MNA", value: 100 });
      }
      await sql`INSERT INTO raw_indicator_history ${sql(seed, "date", "indicator", "value")}`;

      // ── RUN 1: a healthy reconciliation — EDGAR confirms every month
      // unchanged. Establishes last-good and proves the guard is not simply
      // refusing everything.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 100);
      const results1 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;
      expect((results1["late-cycle-signals"] as any).skipped).toBeUndefined();
      const floorAfterRun1 = await mnaRows();
      expect(floorAfterRun1.length).toBe(fullRangeMonths);
      expect(floorAfterRun1.every((r) => r.value === 100)).toBe(true);
      const [sigAfterRun1] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      const payloadAfterRun1 = sigAfterRun1.payload;

      // ── RUN 2 (the defect): every month answers HTTP 200 with a count of
      // 0. Individually valid; collectively degenerate.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 0);
      const results2 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;

      expect((results2["late-cycle-signals"] as any).skipped).toBe(true);
      expect((results2["late-cycle-signals"] as any).reason).toMatch(/degenerate batch/);
      // THE assertion: the persisted floor was not touched. Before the guard
      // existed, all 13 rows here would read 0 and their provenance would
      // have flipped seed→live, with no in-system way back.
      const floorAfterRun2 = await mnaRows();
      expect(floorAfterRun2).toEqual(floorAfterRun1);
      const [sigAfterRun2] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigAfterRun2.payload).toEqual(payloadAfterRun1);

      // ── RUN 3: a non-zero but wholesale rewrite (every month a different,
      // plausible integer) is refused on the same grounds.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 7);
      const results3 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;
      expect((results3["late-cycle-signals"] as any).skipped).toBe(true);
      expect((results3["late-cycle-signals"] as any).reason).toMatch(/bulk rewrite|aggregate diverges/);
      expect(await mnaRows()).toEqual(floorAfterRun1);

      // ── RUN 4: the guard is a blast-radius limiter, NOT a revision
      // blocker — a genuine back-revision to one old month lands.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, (monthStart) =>
        monthStart === "2010-01-01" ? 103 : 100,
      );
      const results4 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;
      expect((results4["late-cycle-signals"] as any).skipped).toBeUndefined();
      const floorAfterRun4 = await mnaRows();
      expect(floorAfterRun4.length).toBe(fullRangeMonths);
      expect(floorAfterRun4.find((r) => r.date === "2010-01-31")!.value).toBe(103);
      expect(floorAfterRun4.filter((r) => r.value === 100).length).toBe(fullRangeMonths - 1);
    } finally {
      if (fetchDouble) fetchDouble.restore();
      server.stop(true);
      config.analyticsToken = origConfig.analyticsToken;
      config.allowInsecure = origConfig.allowInsecure;
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k as keyof typeof origEnv];
        else process.env[k as keyof typeof origEnv] = v;
      }
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
    }
  },
  { timeout: 120_000 },
);
