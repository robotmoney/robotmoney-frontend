// GET /api/dashboards/leaderboard holds one request-pool connection at a time
// (issue 1690).
//
// Production answered it 503 db_saturated (gate=request) on 2026-11-18.
// fetchLeaderboard ran five statements at once through Promise.all, each
// taking a permit of the api's 6-connection request pool, so one request held
// five and a second request, or an overview holding one, left none free. It
// now runs them one after another, and the three agent-scoped reads join
// openclaw_agents instead of binding the 909 active agents' ids.
//
// The pool here is the api's own gate (createPoolGate + gatedPool) over 6
// connections, with the gate's acquire counted so the peak is exact, and an
// admission wait of 0: a statement that finds no permit is refused at once.
//   * one fetchLeaderboard never holds more than one permit;
//   * six at once on the 6-permit pool raise no DbSaturatedError;
//   * red control: the pre-change fan-out holds five, and two of them at once
//     are refused;
//   * the response deep-equals the one built from the pre-change statements'
//     rows (the 909-id bind lists), at the same clock.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import postgres from "postgres";
import { createPoolGate, DbSaturatedError, gatedPool, type PoolGate } from "../src/db/pool-gate.ts";
import { buildLeaderboard, fetchLeaderboard, type LeaderboardRows } from "../src/projects/leaderboard-projections.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const ACTIVE = 909;
const PERMITS = 6;
const NOW = new Date("2026-11-20T12:00:00.000Z");

let raw: postgres.Sql<{}>;
let db: postgres.Sql<{}>;
let peak = 0;
let inUse = 0;

/** The api's request gate, with its permits counted. */
function countedGate(): PoolGate {
  const gate = createPoolGate("request", PERMITS, 0);
  return {
    ...gate,
    name: gate.name,
    acquire: async () => {
      const release = await gate.acquire();
      inUse += 1;
      peak = Math.max(peak, inUse);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inUse -= 1;
        release();
      };
    },
    noteError: (err) => gate.noteError(err),
    stats: () => gate.stats(),
  };
}

const since = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/** The five statements as they stood before issue 1690: bind lists, all at once. */
async function preChangeRows(handle: postgres.Sql<{}>): Promise<LeaderboardRows> {
  const agents = await handle`
    SELECT id, project_id, name, protocol_standard, wallet_address, enriched_at, is_active
    FROM openclaw_agents WHERE is_active = true`;
  const agentIds = agents.map((a) => a.id as string);
  const projectIds = [...new Set(agents.map((a) => a.project_id as string | null).filter((p): p is string => !!p))];
  const [wallets, revenue30, revenue182, agentSnaps30, projectCoins] = await Promise.all([
    handle`SELECT address, balance_usd, refreshed_at FROM tracked_wallets WHERE is_active = true`,
    handle`SELECT agent_id, revenue_usd, revenue_date::text AS revenue_date FROM agent_revenue_daily
            WHERE agent_id IN ${handle(agentIds)} AND revenue_date >= ${since(30)}`,
    handle`SELECT agent_id, revenue_usd, revenue_date::text AS revenue_date FROM agent_revenue_daily
            WHERE agent_id IN ${handle(agentIds)} AND revenue_date >= ${since(182)}`,
    handle`SELECT agent_id, snapshot_date::text AS snapshot_date, x402_volume_usd, x402_txn_count
            FROM daily_agent_snapshots WHERE agent_id IN ${handle(agentIds)} AND snapshot_date >= ${since(30)}`,
    handle`SELECT id, project_id, ticker, market_cap FROM lobster_coins WHERE project_id IN ${handle(projectIds)} AND is_active = true`,
  ]);
  return { agents: [...agents], wallets: [...wallets], revenue30: [...revenue30], revenue182: [...revenue182], agentSnaps30: [...agentSnaps30], projectCoins: [...projectCoins] };
}

beforeAll(async () => {
  setSystemTime(NOW);
  // Production's shape: 909 active agents (and some inactive ones whose rows
  // must stay out), half with a project, wallets, coins, 200 days of revenue
  // and 40 days of snapshots. Amounts are exact in binary, so a sum does not
  // depend on the order rows arrive in.
  await fixtureDb.unsafe(`
    INSERT INTO projects (id, slug, display_name)
    SELECT md5('p-1690-' || g)::uuid, 'lb-1690-' || g, 'Project ' || g FROM generate_series(1, 500) g;
    INSERT INTO openclaw_agents (id, project_id, name, protocol_standard, wallet_address, enriched_at, is_active)
    SELECT md5('a-1690-' || g)::uuid, CASE WHEN g % 2 = 0 THEN md5('p-1690-' || (g % 500 + 1))::uuid END, 'Agent ' || g,
           CASE WHEN g % 3 = 0 THEN 'x402' END, '0xWALLET' || g, '2026-11-01'::timestamptz + make_interval(hours => g % 400),
           g <= ${ACTIVE}
      FROM generate_series(1, ${ACTIVE + 91}) g;
    INSERT INTO tracked_wallets (address, label, balance_usd, refreshed_at, is_active)
    SELECT '0xwallet' || g, 'w' || g, (g % 97) * 1000.25, '2026-11-19'::timestamptz, g % 5 <> 0 FROM generate_series(1, ${ACTIVE + 91}) g;
    INSERT INTO lobster_coins (project_id, name, ticker, market_cap, is_active)
    SELECT md5('p-1690-' || (g % 500 + 1))::uuid, 'Coin ' || g, 'C' || g, g * 1000.5, g % 7 <> 0 FROM generate_series(1, 900) g;
    INSERT INTO agent_revenue_daily (agent_id, revenue_date, revenue_usd, source)
    SELECT md5('a-1690-' || a)::uuid, '2026-11-20'::date - d, (a % 13) * 0.25 + d * 0.5, 'fixture'
      FROM generate_series(1, ${ACTIVE + 91}, 4) a, generate_series(0, 199) d;
    INSERT INTO daily_agent_snapshots (agent_id, snapshot_date, x402_volume_usd, x402_txn_count)
    SELECT md5('a-1690-' || a)::uuid, '2026-11-20'::date - d, (a % 11) * 0.125, a % 5
      FROM generate_series(1, ${ACTIVE + 91}, 3) a, generate_series(0, 39) d;`);
  raw = postgres(process.env.DATABASE_URL!, { max: PERMITS, onnotice: () => {} });
  db = gatedPool(raw, countedGate());
}, 120_000);

afterAll(async () => {
  setSystemTime();
  await raw?.end({ timeout: 5 });
});

describe("the leaderboard on the request pool (issue 1690)", () => {
  test("one fetchLeaderboard never holds more than one request-pool permit", async () => {
    peak = 0;
    const response = await fetchLeaderboard(db);
    expect(response.rows.length).toBe(100);
    expect(peak).toBe(1);
  });

  test(`six at once on a ${PERMITS}-permit pool raise no DbSaturatedError`, async () => {
    peak = 0;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => fetchLeaderboard(db)));
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(peak).toBeLessThanOrEqual(PERMITS);
  });

  test("RED CONTROL: the pre-change fan-out holds five permits, and two at once are refused", async () => {
    peak = 0;
    await preChangeRows(db);
    expect(peak).toBe(5);
    const results = await Promise.allSettled([preChangeRows(db), preChangeRows(db)]);
    expect(results.some((r) => r.status === "rejected" && r.reason instanceof DbSaturatedError)).toBe(true);
  });

  test("the response deep-equals the one built from the pre-change statements' rows", async () => {
    const before = buildLeaderboard(await preChangeRows(raw));
    const after = await fetchLeaderboard(db);
    expect(after.rows.length).toBe(100);
    expect(after).toEqual(before);
  });
});
