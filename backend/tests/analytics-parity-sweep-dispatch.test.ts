// Job-kind wiring for the dual-write parity sweep (issue #979 AC2).
//
// backend/tests/analytics-ledger-cutover.test.ts already proves the CUTOVER
// GATE reads analytics_parity_observations correctly, but every one of those
// rows is inserted directly via SQL in that file — never through
// recordParityObservation()/runParitySweep() the way a real deployment would.
// Net effect before this file existed: runParitySweep() had no production
// caller anywhere (not a worker handler, not a job_schedules row, not even
// analytics-ledger-cutover-gate.ts, which only EVALUATES existing
// observations and flips analytics_read_mode — it never records one), so in a
// real deployment analytics_parity_observations would stay permanently empty
// and the cutover gate could never accumulate the observation window it
// requires. This file is the other half, same shape as
// asset-prices-backfill-dispatch.test.ts (issue #927): the mechanism has to
// be reachable from the REAL dispatch registry and the REAL schedule seed,
// not just callable from a test.
import { expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { SCHEDULES } from "../src/db/seed.ts";
import { getHandler } from "../src/worker/handlers/index.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { ALL_PARITY_DOMAINS } from "../src/analytics/cutover/parity.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

test("analytics.parity_sweep is a seeded, enabled schedule with a registered handler", () => {
  const row = SCHEDULES.find((s) => s.kind === "analytics.parity_sweep");
  expect(row, "analytics.parity_sweep must be seeded in db/seed.ts::SCHEDULES — a sweep with no schedule row never runs").toBeDefined();
  expect(row!.enabled).toBe(true);
  // Must be frequent enough to clear the gate's default 12-observation
  // minimum well inside its default 24h window (defaultCutoverGateConfig,
  // analytics/cutover/gate.ts) — anything from every 5 minutes to hourly
  // does that; anything slower than hourly starts to cut it close.
  expect(row!.cron).toMatch(/^(\d{1,2}|\*\/(5|10|15|20|30)) \* \* \* \*$/);

  const handler = getHandler("analytics.parity_sweep");
  expect(handler, "worker/handlers/index.ts must map analytics.parity_sweep to a handler").toBeDefined();
});

test(
  "the registered analytics.parity_sweep handler calls the API's parity-sweep route over authenticated HTTP, never Postgres directly (issue #979 fix)",
  async () => {
    // Issue #979 fix: the handler used to import analytics/cutover/parity.ts
    // and call runParitySweep() straight against db/client.ts's rm_app pool —
    // a security-boundary regression (see analytics-api-boundary.test.ts's
    // transitive-reachability test). It now calls POST A.paritySweep over the
    // SAME authenticated-HTTP boundary every other worker→API write uses. A
    // real Bun server wrapping the REAL route handler (the exact code the api
    // process mounts) proves both that the handler never touches Postgres
    // itself and that runParitySweep() still runs for real, once it reaches
    // the API side of that boundary.
    const TOKEN = "tok_analytics_parity_sweep_dispatch";
    const requests: { method: string; path: string; auth: string | null }[] = [];
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("Authorization") });
        const r = await handleAnalytics(req, url);
        if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      },
    });

    const origConfig = { analyticsToken: config.analyticsToken, allowInsecure: config.allowInsecure };
    const origEnv = { ANALYTICS_API_URL: process.env.ANALYTICS_API_URL, ANALYTICS_TOKEN: process.env.ANALYTICS_TOKEN };
    try {
      // Server side verifies the analytics-provider bearer (prod-shaped: no
      // insecure fallback) — mirrors analytics-api-boundary.test.ts PART 2.
      config.analyticsToken = TOKEN;
      config.allowInsecure = false;
      process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;
      process.env.ANALYTICS_TOKEN = TOKEN;

      // A clean, freshly migrated+seeded database has no rows in any of the
      // four parity domains' source tables, so this exercises the REAL
      // queries on the API side (loadRawIndicatorHistory, the
      // regime_snapshots/research_signals/swarm_briefs SELECTs, and their
      // ledger-derived counterparts) rather than a mock of the scheduler —
      // the point is proving the WIRING is genuine end to end, not re-proving
      // checkDomainParity's comparison logic (analytics-ledger-cutover.test.ts
      // already does that with deliberately seeded mismatches).
      const before = await sql`SELECT count(*)::int AS n FROM analytics_parity_observations`;
      expect(before[0]!.n).toBe(0);

      const handler = getHandler("analytics.parity_sweep")!;
      const result = (await handler({})) as { domains: number; matched: string[]; mismatched: string[] };
      expect(result.domains).toBe(ALL_PARITY_DOMAINS.length);
      expect(result.mismatched).toEqual([]);
      expect(result.matched.sort()).toEqual([...ALL_PARITY_DOMAINS].sort());

      // Exactly one authenticated HTTP call, to the parity-sweep route — no
      // other path exists for this handler to reach Postgres.
      expect(requests).toHaveLength(1);
      expect(requests[0]!.method).toBe("POST");
      expect(requests[0]!.path).toBe(ROUTES.analytics.paritySweep);
      expect(requests[0]!.auth).toBe(`Bearer ${TOKEN}`);

      // One immutable observation row per domain, actually written on the API
      // side by the route this tick invoked — not by a test inserting SQL
      // directly, and not by the worker touching the table itself.
      const rows = await sql`
      SELECT domain, matched FROM analytics_parity_observations ORDER BY domain
    `;
      expect(rows).toHaveLength(ALL_PARITY_DOMAINS.length);
      for (const r of rows) expect(r.matched).toBe(true);

      // A second tick adds NEW rows (append-only evidence, migration 0060
      // refuses UPDATE/DELETE/TRUNCATE) — this is what lets the gate's
      // observation window actually accumulate over time instead of
      // overwriting one row per domain.
      await handler({});
      expect(requests).toHaveLength(2);
      const after = await sql`SELECT count(*)::int AS n FROM analytics_parity_observations`;
      expect(after[0]!.n).toBe(ALL_PARITY_DOMAINS.length * 2);
    } finally {
      server.stop(true);
      config.analyticsToken = origConfig.analyticsToken;
      config.allowInsecure = origConfig.allowInsecure;
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) delete process.env[k as keyof typeof origEnv];
        else process.env[k as keyof typeof origEnv] = v;
      }
    }
  },
  { timeout: 60_000 },
);
