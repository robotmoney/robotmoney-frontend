// End-to-end coverage for the LIVE EDGAR/MNA research refresh over the REAL
// authenticated /api/analytics/* boundary and the REAL ephemeral Postgres
// the preload provisions (never mocked; a missing Postgres fails the preload
// loudly, so this suite goes red rather than skipping). Only the outbound
// HTTP to SEC EDGAR / Yahoo / FRED is faked (deterministic, network-free);
// every persistence call goes through a REAL Bun.serve wrapping the REAL
// handleAnalytics route handler, exactly like production's worker → API
// boundary.
//
// R6 (docs/v0-v1-quant-platform-parity-report.md, finding 1.10) established
// that the live EDGAR/MNA refresh must periodically re-crawl the FULL
// [EDGAR_FLOOR_START, asof] range so an EDGAR back-revision to any
// historical month always lands — not just the months missing/revisable
// against the persisted floor. A follow-up review found that doing this on
// EVERY run (the first R6 fix) was itself too expensive for daily
// production use (~200 live EDGAR requests/day, forever), so the full
// re-crawl is now Tier 2 of a two-tier design: a cheap Tier 1 (incremental)
// sweep runs most days, and the full Tier 2 sweep runs periodically
// (`selectEdgarRefreshTier` — see ../../src/analytics/edgar-incremental-
// refresh.ts). This suite specifically exercises Tier 2 end to end over the
// REAL authenticated API + DB, so `asof` below is deliberately chosen to
// land on the periodic full-sweep weekday (Sunday UTC,
// EDGAR_FULL_SWEEP_WEEKDAY_UTC's default). That makes this specific test
// SLOW by design: it seeds the real ~198-month committed floor and drives
// two full real-paced (250ms/month) sweeps over it, on purpose, because
// that IS production behavior once a week (from the independent producer —
// see edgar-incremental-refresh.ts's DEFAULT_EDGAR_FULL_SWEEP_DEADLINE_MS
// comment) and this suite intentionally never mocks the pacing away.
//
// BOTH tiers are covered here, over the same real boundary (issue #509).
// PR #471 repinned this suite's only `asof` to a Sunday, which left the
// INCREMENTAL tier — 6 of 7 production runs — with no end-to-end coverage at
// all while the suite stayed green, and deleted the boundedness assertions
// that were the only thing proving the daily path never crawls history. The
// second test below is that coverage, restored: a NON-full-sweep `asof`, the
// same real seeded floor, and the same bounds (`< 10` requests, nothing
// older than the trailing window, a floor that never grows to the full
// range).
//
// Covers:
//   R6  — seeding the full committed EDGAR seed floor, a LATER Tier 2
//         (full) research refresh requests EVERY month in
//         [EDGAR_FLOOR_START, asof] — the full committed range, not just
//         what's missing/revisable; a further run at the SAME as-of
//         requests that SAME full range again (never shrinks to "only what
//         changed").
//   AC2 — on a NON-full-sweep `asof` the SAME seeded floor drives a Tier 1
//         sweep that requests ONLY the missing + revision-window months —
//         ZERO requests for anything historical, on either run.
//   AC6 — every floor read + history/signal submission carries the
//         analytics-provider bearer credential.
//   AC9 — the refresh's planned/new/revised/fetched/missing/rejected metrics
//         are logged accurately, `tier=` is on the line (issue #509), and
//         the bearer credential never appears in any log line.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { config } from "../../src/config.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
import { runAnalytics } from "../../src/analytics/index.ts";
import { liveDataSource } from "../../src/analytics/access/data-source.ts";
import { analyticsApiClient } from "../../src/analytics/api-client.ts";
import { loadEdgarSeed } from "../../src/analytics/extract/edgar-seed.ts";
import { enumerateMonths } from "../../src/analytics/extract/edgar.ts";
import { EDGAR_FLOOR_START } from "../../src/analytics/extract/edgar-fetch-plan.ts";
import { selectEdgarRefreshTier } from "../../src/analytics/edgar-incremental-refresh.ts";

const TOKEN = "tok_edgar_e2e_secret";

// The first Sunday (UTC — the periodic full-sweep weekday) on or after
// `from` — used to pick an `asof` for this Tier 2 (full-sweep) suite
// without hand-picking a date that could drift out of sync if the seed
// artifact's own `asOf` ever changes.
function nextFullSweepDate(from: string): string {
  let d = new Date(`${from}T00:00:00Z`);
  while (selectEdgarRefreshTier(d.toISOString().slice(0, 10)) !== "full") {
    d = new Date(d.getTime() + 86_400_000);
  }
  return d.toISOString().slice(0, 10);
}

// The mirror of the above: the first NON-full-sweep day on or after `from`,
// for the Tier 1 (incremental) suite. Derived rather than hand-picked for the
// same reason — if the seed artifact's own `asOf` is ever regenerated onto a
// Sunday, this keeps exercising the tier it means to exercise instead of
// silently flipping to the other one (which is exactly how the incremental
// tier lost its coverage in the first place).
function nextIncrementalDate(from: string): string {
  let d = new Date(`${from}T00:00:00Z`);
  while (selectEdgarRefreshTier(d.toISOString().slice(0, 10)) !== "incremental") {
    d = new Date(d.getTime() + 86_400_000);
  }
  return d.toISOString().slice(0, 10);
}

function startdtOf(url: string): string {
  try {
    return new URL(url).searchParams.get("startdt") ?? "";
  } catch {
    return "";
  }
}

// Installs a fetch double that:
//   - answers SEC EDGAR requests deterministically (recording every URL),
//   - forwards anything hitting our OWN local test server through to the
//     real fetch (so the analytics API boundary is genuinely exercised),
//   - and treats every OTHER outbound host (Yahoo/FRED) as unreachable —
//     `safe()` in data-source.ts catches that and degrades to [], exactly
//     the same honest behavior a real transient outage produces.
function installFetchDouble(localBaseUrl: string, edgarCountFor: (monthStart: string) => number | null) {
  const orig = globalThis.fetch;
  const edgarRequests: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const headers = new Headers(init?.headers ?? (typeof input === "object" ? input?.headers : undefined));
    if (url.startsWith("https://efts.sec.gov/")) {
      edgarRequests.push({ url, auth: headers.get("authorization") });
      const count = edgarCountFor(startdtOf(url));
      if (count == null) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => ({ hits: { total: { value: count } } }) } as Response;
    }
    if (url.startsWith(localBaseUrl)) {
      return orig(input, init);
    }
    // Yahoo/FRED/etc — simulated network outage; safe() degrades to [].
    throw new Error(`network disabled in test: ${url}`);
  }) as any;
  return { edgarRequests, restore: () => { globalThis.fetch = orig; } };
}

test(
  "live EDGAR refresh (R6 full re-crawl): seeding the full committed floor, a later refresh requests EVERY month in range over the REAL authenticated API + DB; a further run at the same as-of requests that SAME full range again",
  async () => {
    const origConfig = { analyticsToken: config.analyticsToken, allowInsecure: config.allowInsecure };
    const origEnv = {
      ANALYTICS_SOURCE: process.env.ANALYTICS_SOURCE,
      ANALYTICS_API_URL: process.env.ANALYTICS_API_URL,
      ANALYTICS_TOKEN: process.env.ANALYTICS_TOKEN,
    };
    const requests: { method: string; path: string; auth: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("Authorization") });
        const r = await handleAnalytics(req, url);
        if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      },
    });
    let fetchDouble: ReturnType<typeof installFetchDouble> | null = null;
    try {
      config.analyticsToken = TOKEN;
      config.allowInsecure = false;
      process.env.ANALYTICS_SOURCE = "live"; // exercise the REAL liveDataSource
      process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;
      process.env.ANALYTICS_TOKEN = TOKEN;

      // ── ARRANGE: seed raw_indicator_history with the FULL committed EDGAR
      // seed (issue #108's artifact) — the same real, checked-in floor
      // production boots from.
      const { history, manifest } = await loadEdgarSeed();
      const mnaRows = history[manifest.indicator]!;
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
      for (const row of mnaRows) {
        await sql`INSERT INTO raw_indicator_history (date, indicator, value) VALUES (${row.date}, 'MNA', ${row.value})`;
      }
      // A "later" refresh relative to endMonth, pinned to the periodic
      // full-sweep weekday so this suite deterministically exercises Tier 2
      // (see nextFullSweepDate above) rather than depending on which
      // weekday the seed's own manifest.asOf happens to fall on.
      const asof = nextFullSweepDate(manifest.asOf);
      await sql`DELETE FROM research_signals WHERE date = ${asof}`;

      // EDGAR answers each already-seeded month with the value the committed
      // artifact holds, and the one genuinely-new month with a fresh count.
      // That is what a HEALTHY weekly reconciliation looks like: the sweep
      // re-fetches all ~199 months and finds history unchanged. It matters
      // that this test models it, because issue #509's divergence guard now
      // DEGRADES a full sweep that would rewrite the whole floor — a fetch
      // double answering a single constant for every month back to 2010 is
      // precisely the corrupting batch that guard exists to refuse, not a
      // realistic reconciliation.
      const seedByMonth = new Map(mnaRows.map((r) => [r.date.slice(0, 7), r.value] as const));
      const seedCountFor = (monthStart: string) => seedByMonth.get(monthStart.slice(0, 7)) ?? 5;

      const capturedLogs: string[] = [];
      const logger = {
        log: (m: string) => capturedLogs.push(m),
        warn: (m: string) => capturedLogs.push(m),
        error: (m: string) => capturedLogs.push(m),
      };

      // ── ACT 1: first refresh, LATER than the committed floor's endMonth.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, seedCountFor);
      const results1 = await runAnalyticsWithLogger(asof, logger);
      const edgar1 = fetchDouble.edgarRequests;
      fetchDouble.restore();
      fetchDouble = null;

      expect(results1["late-cycle-signals"]).toBeDefined();
      // R6: EVERY month in [EDGAR_FLOOR_START, asof] is requested — the full
      // committed range, matching v0's unconditional full re-crawl.
      const expectedMonths = enumerateMonths(EDGAR_FLOOR_START, asof);
      expect(edgar1.length).toBe(expectedMonths.length);
      // Every EDGAR request carried NO bearer (SEC EDGAR is a public keyless
      // API — the analytics-provider credential must never leak to it).
      for (const r of edgar1) expect(r.auth).toBeNull();
      // Deep history IS touched (R6: no "well before the floor's endMonth"
      // exclusion any more) — proves this is a genuine full crawl, not a
      // windowed one.
      expect(edgar1.some((r) => startdtOf(r.url) === "2010-01-01")).toBe(true);

      // Persisted for real, over the authenticated boundary. Every
      // already-seeded month is re-submitted (an upsert on (date,
      // indicator)) plus whatever is newly in range, so the row count is
      // exactly the full range, not "at least what was seeded".
      const mnaAfter = await sql`SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = 'MNA' ORDER BY date`;
      expect(mnaAfter.length).toBe(expectedMonths.length);
      const sigRows = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigRows.length).toBe(1);

      // AC6: every analytics API request (floor read + submissions) carried
      // the bearer credential.
      const analyticsCalls = requests.filter((r) => r.path.startsWith("/api/analytics/"));
      expect(analyticsCalls.length).toBeGreaterThan(0);
      for (const r of analyticsCalls) expect(r.auth).toBe(`Bearer ${TOKEN}`);
      expect(analyticsCalls.some((r) => r.method === "GET" && r.path === "/api/analytics/raw-history")).toBe(true);
      expect(analyticsCalls.some((r) => r.method === "POST" && r.path === "/api/analytics/raw-history")).toBe(true);

      // AC9: the refresh's metrics were logged accurately, and the bearer
      // credential never appears in any log line.
      const refreshLog = capturedLogs.find((m) => m.includes("EDGAR MNA refresh"));
      expect(refreshLog).toBeDefined();
      expect(refreshLog).toMatch(/planned=\d+ new=\d+ revised=\d+ fetched=\d+ missing=0 rejected=0/);
      // Issue #509: WHICH tier ran is on the line, so "did the weekly
      // reconciliation ever actually happen?" is answerable from the log.
      expect(refreshLog).toContain("tier=full");
      for (const m of capturedLogs) expect(m).not.toContain(TOKEN);

      // ── ACT 2 (R6): a FURTHER run at the SAME as-of requests the SAME full
      // range again — the request set never shrinks to "only what's new",
      // which is exactly the R6 property under test: an EDGAR back-revision
      // to ANY historical month, however old, lands on every single run.
      requests.length = 0;
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, seedCountFor);
      const results2 = await runAnalyticsWithLogger(asof, logger);
      const edgar2 = fetchDouble.edgarRequests;
      fetchDouble.restore();
      fetchDouble = null;

      expect(results2["late-cycle-signals"]).toBeDefined();
      expect(edgar2.length).toBe(edgar1.length); // R6: identical full-range plan every run
      expect(edgar2.some((r) => startdtOf(r.url) === "2010-01-01")).toBe(true); // deep history requested AGAIN
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

    async function runAnalyticsWithLogger(asOfDate: string, logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }) {
      // runAnalytics's logger is fixed to console internally; capture via a
      // console monkey-patch scoped to this call so we can assert on the
      // EDGAR refresh's own log line without depending on stdout ordering.
      const real = { log: console.log, warn: console.warn, error: console.error };
      console.log = ((...a: unknown[]) => { logger.log(a.map(String).join(" ")); real.log(...a); }) as typeof console.log;
      console.warn = ((...a: unknown[]) => { logger.warn(a.map(String).join(" ")); real.warn(...a); }) as typeof console.warn;
      console.error = ((...a: unknown[]) => { logger.error(a.map(String).join(" ")); real.error(...a); }) as typeof console.error;
      try {
        return await runAnalytics(asOfDate, "late-cycle-signals", liveDataSource, analyticsApiClient());
      } finally {
        console.log = real.log;
        console.warn = real.warn;
        console.error = real.error;
      }
    }
  },
  // R6: two full ~199-month sweeps at v0's own 250ms/month pacing is ~100s
  // of pure politeness delay alone — generous margin above that for DB/HTTP
  // overhead. See the file-level comment: this slowness is deliberate, not
  // a regression to fix.
  { timeout: 180_000 },
);

// ── Tier 1 (incremental) — the path 6 of 7 production runs take ────────────
//
// Restored under issue #509. This is the ONLY end-to-end proof, over the real
// authenticated API + real Postgres + the real 198-month committed floor,
// that the daily refresh stays BOUNDED: a handful of requests, none of them
// touching deep history, and a persisted floor that never balloons to the
// full range. Every assertion marked "restored" below was deleted by PR #471
// when this suite was repinned to the full-sweep weekday.
test(
  "live EDGAR refresh (Tier 1 incremental, non-full-sweep asof): the SAME seeded floor drives ONLY missing+revision-window requests over the REAL authenticated API + DB — zero requests for historical months, on this run or a repeat run",
  async () => {
    const origConfig = { analyticsToken: config.analyticsToken, allowInsecure: config.allowInsecure };
    const origEnv = {
      ANALYTICS_SOURCE: process.env.ANALYTICS_SOURCE,
      ANALYTICS_API_URL: process.env.ANALYTICS_API_URL,
      ANALYTICS_TOKEN: process.env.ANALYTICS_TOKEN,
    };
    const requests: { method: string; path: string; auth: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("Authorization") });
        const r = await handleAnalytics(req, url);
        if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      },
    });
    let fetchDouble: ReturnType<typeof installFetchDouble> | null = null;
    const capturedLogs: string[] = [];
    try {
      config.analyticsToken = TOKEN;
      config.allowInsecure = false;
      process.env.ANALYTICS_SOURCE = "live";
      process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;
      process.env.ANALYTICS_TOKEN = TOKEN;

      const { history, manifest } = await loadEdgarSeed();
      const mnaRows = history[manifest.indicator]!;
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
      for (const row of mnaRows) {
        await sql`INSERT INTO raw_indicator_history (date, indicator, value) VALUES (${row.date}, 'MNA', ${row.value})`;
      }
      const asof = nextIncrementalDate(manifest.asOf);
      expect(selectEdgarRefreshTier(asof)).toBe("incremental"); // the tier under test, asserted not assumed
      await sql`DELETE FROM research_signals WHERE date = ${asof}`;

      // ── ACT 1: the daily refresh over the real committed floor.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 5);
      const results1 = await captureConsole(capturedLogs, () =>
        runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient()),
      );
      const edgar1 = fetchDouble.edgarRequests;
      fetchDouble.restore();
      fetchDouble = null;

      expect(results1["late-cycle-signals"]).toBeDefined();
      expect((results1["late-cycle-signals"] as any).skipped).toBeUndefined();
      // RESTORED: bounded — never the full ~198-month committed range.
      expect(edgar1.length).toBeLessThan(10);
      expect(edgar1.length).toBeGreaterThan(0);
      // Every EDGAR request carried NO bearer (SEC EDGAR is a public keyless
      // API — the analytics-provider credential must never leak to it).
      for (const r of edgar1) expect(r.auth).toBeNull();
      // RESTORED: no request touches deep history (well before the floor's
      // endMonth). This is the assertion whose deletion let a full crawl hide
      // inside a green suite.
      for (const r of edgar1) expect(startdtOf(r.url) >= "2026-01-01").toBe(true);
      expect(edgar1.some((r) => startdtOf(r.url) === "2010-01-01")).toBe(false);

      // RESTORED: the persisted floor grew by the handful of fetched months,
      // and stayed bounded — it never becomes "the whole range re-written".
      const mnaAfter = await sql`SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = 'MNA' ORDER BY date`;
      expect(mnaAfter.length).toBeGreaterThanOrEqual(mnaRows.length);
      expect(mnaAfter.length).toBeLessThan(mnaRows.length + 10);
      const sigRows = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigRows.length).toBe(1);

      // AC6 over this tier too: every analytics API call carried the bearer.
      const analyticsCalls = requests.filter((r) => r.path.startsWith("/api/analytics/"));
      expect(analyticsCalls.length).toBeGreaterThan(0);
      for (const r of analyticsCalls) expect(r.auth).toBe(`Bearer ${TOKEN}`);

      // AC9 + issue #509: metrics logged accurately AND the executed tier is
      // named on the line — this run must say `incremental`, not `full`.
      const refreshLog = capturedLogs.find((m) => m.includes("EDGAR MNA refresh"));
      expect(refreshLog).toBeDefined();
      expect(refreshLog).toMatch(/planned=\d+ new=\d+ revised=\d+ fetched=\d+ missing=0 rejected=0/);
      expect(refreshLog).toContain("tier=incremental");
      for (const m of capturedLogs) expect(m).not.toContain(TOKEN);

      // ── ACT 2: a FURTHER run at the SAME as-of touches ONLY the fixed
      // trailing revision window — ZERO requests for anything historical.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 5);
      const results2 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      const edgar2 = fetchDouble.edgarRequests;
      fetchDouble.restore();
      fetchDouble = null;

      expect(results2["late-cycle-signals"]).toBeDefined();
      // RESTORED: never grows, and only the trailing window.
      expect(edgar2.length).toBeLessThanOrEqual(edgar1.length);
      for (const r of edgar2) expect(startdtOf(r.url) >= "2026-06-01").toBe(true);

      // Idempotent: the replay converged on the same bounded floor.
      const mnaAfter2 = await sql`SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = 'MNA' ORDER BY date`;
      expect(mnaAfter2.length).toBe(mnaAfter.length);
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
  // Bounded by construction (a handful of 250ms-paced requests per run) —
  // deliberately NOT the full-sweep suite's 180s budget.
  { timeout: 60_000 },
);

// runAnalytics's logger is fixed to `console` internally; capture via a
// console monkey-patch scoped to one call so a test can assert on the EDGAR
// refresh's own log line without depending on stdout ordering.
async function captureConsole<T>(sink: string[], fn: () => Promise<T>): Promise<T> {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => { sink.push(a.map(String).join(" ")); };
  console.log = ((...a: unknown[]) => { push(...a); real.log(...a); }) as typeof console.log;
  console.warn = ((...a: unknown[]) => { push(...a); real.warn(...a); }) as typeof console.warn;
  console.error = ((...a: unknown[]) => { push(...a); real.error(...a); }) as typeof console.error;
  try {
    return await fn();
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
}
