// AC5 (atomicity/last-good) + AC7 (idempotency) coverage for the live
// incremental EDGAR/MNA research refresh (issue #109), over the REAL
// authenticated /api/analytics/* boundary and the REAL ephemeral Postgres
// the preload provisions. Only outbound SEC EDGAR/Yahoo/FRED HTTP is faked.
//
//   AC5 — when the incremental refresh DEGRADES (a required month comes
//         back missing), NEITHER the persisted MNA floor NOR the published
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

      const asof = "2019-05-15";
      await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
      await sql`DELETE FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      // A FULLY seeded floor from the declared EDGAR_FLOOR_START (2010-01)
      // through 2019-03 — 2019-04 and 2019-05 (asof's month) are both
      // missing, so the plan is exactly {2019-04, 2019-05}, never the whole
      // ~110-month range.
      const seed: { date: string; indicator: string; value: number }[] = [];
      const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let y = 2010; y <= 2019; y++) {
        const lastMonth = y === 2019 ? 3 : 12;
        for (let m = 1; m <= lastMonth; m++) {
          const day = lastDayOfMonth(y, m);
          seed.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, indicator: "MNA", value: 10 + m });
        }
      }
      await sql`INSERT INTO raw_indicator_history ${sql(seed, "date", "indicator", "value")}`;

      // ── RUN 1: a fully successful refresh — establishes the "last-good"
      // floor + signal for this as-of.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, () => 99);
      const results1 = await runAnalytics(asof, "late-cycle-signals", liveDataSource, analyticsApiClient());
      fetchDouble.restore();
      fetchDouble = null;
      expect(results1["late-cycle-signals"]).toBeDefined();
      expect((results1["late-cycle-signals"] as any).skipped).toBeUndefined();

      const floorAfterRun1 = await mnaRows();
      expect(floorAfterRun1.length).toBe(seed.length + 2); // 2019-04 + 2019-05 landed
      expect(floorAfterRun1.length).toBeLessThan(200); // sanity: bounded, not a full re-crawl
      const [sigAfterRun1] = await sql`SELECT payload FROM research_signals WHERE signal_key = 'late-cycle-signals' AND date = ${asof}`;
      expect(sigAfterRun1).toBeDefined();
      const payloadAfterRun1 = sigAfterRun1.payload;

      // ── RUN 2: the SAME as-of, but EDGAR now fails ONE required month
      // (the newly-missing 2019-05 slot re-requested as part of the
      // trailing revision window) — the refresh must degrade.
      fetchDouble = installFetchDouble(process.env.ANALYTICS_API_URL, (monthStart) =>
        monthStart === "2019-05-01" ? null : 99,
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
