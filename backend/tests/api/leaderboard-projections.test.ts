// "List v3 · Money Agents" leaderboard (issue #387). Runs against the
// ephemeral Postgres the preload provisions + migrates (tests/preload.ts) —
// a real DB, never a mock. Asserts fetchLeaderboard() (backend/src/projects/
// leaderboard-projections.ts) computes the §5.3 signalScore formula, ranks
// rows by it, and derives evidence/confidence from real backing data only —
// never fabricated.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchLeaderboard } from "../../src/projects/leaderboard-projections.ts";
import { getLeaderboard } from "../../src/api/routes/dashboards.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test("fetchLeaderboard ranks a fully-evidenced agent above a bare one, and computes High confidence", async () => {
  const tag = rid("lb");
  const [project] = await sql`INSERT INTO projects ${sql({ slug: tag, display_name: tag })} RETURNING id`;

  const walletAddress = `0x${tag}wallet`.toLowerCase();
  await sql`INSERT INTO tracked_wallets ${sql({
    project_id: project.id, label: `${tag}-wallet`, address: walletAddress, balance_usd: 50_000, is_active: true,
  })}`;
  const [coin] = await sql`INSERT INTO lobster_coins ${sql({
    project_id: project.id, name: `${tag}-coin`, ticker: "RICH", market_cap: 2_000_000, is_active: true,
  })} RETURNING id`;

  const [richAgent] = await sql`INSERT INTO openclaw_agents ${sql({
    project_id: project.id, name: `${tag}-rich-agent`, protocol_standard: "x402",
    wallet_address: walletAddress, is_active: true, enriched_at: new Date().toISOString(),
  })} RETURNING id`;
  await sql`INSERT INTO agent_revenue_daily ${sql({ agent_id: richAgent.id, revenue_date: daysAgo(1), revenue_usd: 5_000, source: "x402" })}`;
  await sql`INSERT INTO daily_agent_snapshots ${sql({ agent_id: richAgent.id, snapshot_date: daysAgo(1), x402_volume_usd: 10_000, x402_txn_count: 40 })}`;

  const [bareAgent] = await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-bare-agent`, is_active: true,
  })} RETURNING id`;

  const { rows } = await fetchLeaderboard();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rich = byId.get(richAgent.id)!;
  const bare = byId.get(bareAgent.id)!;

  expect(rich).toBeDefined();
  expect(bare).toBeDefined();
  expect(rich.signalScore).toBeGreaterThan(bare.signalScore);
  expect(rich.rank).toBeLessThan(bare.rank); // lower rank number = higher on the board
  expect(rich.confidence).toBe("High");
  expect(rich.evidence.wallet).toBe("verified");
  expect(rich.evidence.moneyIn).toBe("verified");
  expect(rich.evidence.x402).toBe("verified");
  expect(rich.evidence.token).toBe("verified");
  expect(rich.tokenTicker).toBe("RICH");
  expect(rich.walletBalanceUsd).toBe(50_000);
  expect(rich.href).toBe(`/agents/${richAgent.id}`);

  expect(bare.confidence).toBe("Low");
  expect(bare.evidence.wallet).toBe("missing");
  expect(bare.evidence.moneyIn).toBe("missing");
  expect(bare.walletBalanceUsd).toBeNull();
  expect(bare.tokenMarketCapUsd).toBeNull();
});

test("fetchLeaderboard never fabricates a momentum sparkline for an agent with no revenue history", async () => {
  const tag = rid("lbspark");
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ name: `${tag}-agent`, is_active: true })} RETURNING id`;

  const { rows } = await fetchLeaderboard();
  const row = rows.find((r) => r.id === agent.id)!;
  expect(row.moneyTrailSparkline).toEqual([]); // no history — never zero-padded/invented
});

test("fetchLeaderboard reports real source-health freshness in the debug panel, capped at rank 100", async () => {
  const { rows, debug, stats } = await fetchLeaderboard();
  expect(rows.length).toBeLessThanOrEqual(100);
  expect(debug.sources.length).toBe(3);
  for (const s of debug.sources) {
    expect(["healthy", "partial", "stale", "empty"]).toContain(s.status);
    expect(s.freshCount).toBeLessThanOrEqual(s.totalCount);
  }
  expect(typeof stats.listedAgents).toBe("number");
  expect(typeof stats.highConfidenceCount).toBe("number");
  // Ranks are contiguous starting at 1.
  rows.forEach((r, i) => expect(r.rank).toBe(i + 1));
});

test("GET /api/dashboards/leaderboard route handler is a thin passthrough", async () => {
  const res = await getLeaderboard();
  expect(Array.isArray(res.rows)).toBe(true);
  expect(res.debug).toHaveProperty("sources");
  expect(res.stats).toHaveProperty("listedAgents");
});
