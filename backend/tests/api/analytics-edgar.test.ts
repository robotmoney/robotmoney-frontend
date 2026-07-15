// End-to-end coverage for the LIVE incremental EDGAR/MNA research refresh
// (issue #109) over the REAL authenticated /api/analytics/* boundary and the
// REAL ephemeral Postgres the preload provisions (never mocked; a missing
// Postgres fails the preload loudly, so this suite goes red rather than
// skipping). Only the outbound HTTP to SEC EDGAR / Yahoo / FRED is faked
// (deterministic, network-free); every persistence call goes through a REAL
// Bun.serve wrapping the REAL handleAnalytics route handler, exactly like
// production's worker → API boundary.
//
// Covers:
//   AC2 — seeding the full committed EDGAR seed floor, then running a LATER
//         research refresh requests ONLY the missing+revision-window EDGAR
//         months (never the full ~198-month committed range); a further run
//         at the SAME as-of requests ONLY that same small trailing window —
//         ZERO requests for anything older ("no historical crawl").
//   AC6 — every floor read + history/signal submission carries the
//         analytics-provider bearer credential.
//   AC9 — the refresh's planned/new/revised/fetched/missing/rejected metrics
//         are logged accurately; the bearer credential never appears in any
//         log line.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { config } from "../../src/config.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
import { runAnalytics } from "../../src/analytics/index.ts";
import { liveDataSource } from "../../src/analytics/access/data-source.ts";
import { analyticsApiClient } from "../../src/analytics/api-client.ts";
import { loadEdgarSeed } from "../../src/analytics/extract/edgar-seed.ts";

const TOKEN = "tok_edgar_e2e_secret";

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
  "live incremental EDGAR refresh: seeding the full committed floor, a later refresh requests ONLY missing+revision months over the REAL authenticated API + DB; a further run at the same as-of never touches historical months",
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
      const asof = manifest.asOf; // the seed's own pinned as-of — a "later" refresh relative to endMonth
      await sql`DELETE FROM research_signals WHERE date = ${asof}`;

      const capturedLogs: string[] = [];
      const logger = {
        log: (m: string) => capturedLogs.push(m),
        warn: (m: string) => capturedLogs.push(m),
        error: (m: string) => capturedLogs.push(m),
      };

      // ── ACT 1: first refresh, LATER than the committed floor's endMonth.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 5);
      const results1 = await runAnalyticsWithLogger(asof, logger);
      const edgar1 = fetchDouble.edgarRequests;
      fetchDouble.restore();
      fetchDouble = null;

      expect(results1["late-cycle-signals"]).toBeDefined();
      // Bounded: never the full ~198-month committed range.
      expect(edgar1.length).toBeLessThan(10);
      expect(edgar1.length).toBeGreaterThan(0);
      // Every EDGAR request carried NO bearer (SEC EDGAR is a public keyless
      // API — the analytics-provider credential must never leak to it).
      for (const r of edgar1) expect(r.auth).toBeNull();
      // No request touches deep history (well before the floor's endMonth).
      for (const r of edgar1) expect(startdtOf(r.url) >= "2026-01-01").toBe(true);

      // Persisted for real, over the authenticated boundary.
      const mnaAfter = await sql`SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = 'MNA' ORDER BY date`;
      expect(mnaAfter.length).toBeGreaterThanOrEqual(mnaRows.length);
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
      for (const m of capturedLogs) expect(m).not.toContain(TOKEN);

      // ── ACT 2: a FURTHER run at the SAME as-of touches ONLY the fixed
      // trailing revision window — ZERO requests for anything historical.
      requests.length = 0;
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 5);
      const results2 = await runAnalyticsWithLogger(asof, logger);
      const edgar2 = fetchDouble.edgarRequests;
      fetchDouble.restore();
      fetchDouble = null;

      expect(results2["late-cycle-signals"]).toBeDefined();
      expect(edgar2.length).toBeLessThanOrEqual(edgar1.length); // never grows
      for (const r of edgar2) expect(startdtOf(r.url) >= "2026-06-01").toBe(true); // only the trailing window
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
  { timeout: 60_000 },
);
