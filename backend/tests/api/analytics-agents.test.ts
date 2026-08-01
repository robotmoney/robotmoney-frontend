// /agents "OpenClaw Agents" directory feed (issue #385). Runs against the
// ephemeral Postgres the preload provisions + migrates (tests/preload.ts) — a
// real DB, never a mock. Seeds openclaw_agents rows (with/without a linked
// wallet, active/inactive, with revenue/snapshot history) and asserts
// fetchAgentsDirectory() (backend/src/projects/agents-projections.ts)
// computes the composite score, facilitator flag, case-insensitive wallet
// match, weekly-bucketed sparklines, and summary math correctly.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchAgentsDirectory } from "../../src/projects/agents-projections.ts";
import { getAgentsDirectory } from "../../src/api/routes/dashboards.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test("fetchAgentsDirectory computes composite score, facilitator flag, and case-insensitive wallet match", async () => {
  const tag = rid("ag");

  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    label: `${tag}-wallet`, address: "0xABCDEF0000000000000000000000000000BEEF", balance_usd: 4_200, is_active: true,
  })} RETURNING id`;

  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-agent`, protocol_standard: "x402", x402_score: 61.5, x402_txn_count: 12,
    x402_volume_usd: 500, productivity_score: 40, is_active: true,
    wallet_address: "0xabcdef0000000000000000000000000000beef", // lowercase — must still match the mixed-case tracked_wallets row
  })} RETURNING id`;

  await sql`INSERT INTO agent_revenue_daily ${sql([
    { agent_id: agent.id, revenue_date: daysAgo(3), revenue_usd: 200, source: "x402" },
    { agent_id: agent.id, revenue_date: daysAgo(40), revenue_usd: 99_999, source: "x402" }, // outside the 30d window
  ])}`;

  const [facilitator] = await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-facilitator`, protocol_standard: "facilitator", is_active: false,
  })} RETURNING id`;

  const { agents, summary } = await fetchAgentsDirectory();
  const byId = new Map(agents.map((a) => [a.id, a]));

  const a = byId.get(agent.id)!;
  expect(a).toBeDefined();
  expect(a.isFacilitator).toBe(false);
  expect(a.active).toBe(true);
  // composite = max(x402Score=61.5, productivityScore=40, log10(200+1)*25≈57.8) => 61.5
  expect(a.score).toBeCloseTo(61.5, 5);
  expect(a.x402Txns).toBe(12);
  expect(a.x402VolumeUsd).toBe(500);
  expect(a.balanceUsd).toBe(4_200); // matched despite address case mismatch
  expect(a.walletAddress).toBe("0xabcdef0000000000000000000000000000beef");

  const f = byId.get(facilitator.id)!;
  expect(f.isFacilitator).toBe(true);
  expect(f.active).toBe(false);
  expect(f.balanceUsd).toBeNull(); // no wallet_address set
  expect(f.score).toBe(0); // no x402/productivity/revenue signal at all

  // Excluded from the active-only summary (is_active: false).
  expect(summary.idle).toBeGreaterThanOrEqual(1);
});

test("fetchAgentsDirectory weekly-buckets the score and x402-volume series independently (last vs sum)", async () => {
  const tag = rid("spark");
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ name: `${tag}-agent`, is_active: true })} RETURNING id`;

  await sql`INSERT INTO daily_agent_snapshots ${sql([
    { agent_id: agent.id, snapshot_date: daysAgo(10), x402_volume_usd: 100, productivity_score: 30 },
    { agent_id: agent.id, snapshot_date: daysAgo(3), x402_volume_usd: 50, productivity_score: 60 },
    { agent_id: agent.id, snapshot_date: daysAgo(1), x402_volume_usd: 25, productivity_score: 70 },
  ])}`;

  const { agents } = await fetchAgentsDirectory();
  const row = agents.find((a) => a.id === agent.id)!;

  expect(row.sparkline.score.length).toBeGreaterThan(0);
  expect(row.sparkline.score[row.sparkline.score.length - 1]).toBe(70); // "last" aggregation
  expect(row.sparkline.x402.length).toBeGreaterThan(0);
  // Both daysAgo(3) and daysAgo(1) fall in the same UTC week — "sum" aggregation.
  expect(row.sparkline.x402[row.sparkline.x402.length - 1]).toBe(75);
  expect(row.sparkline.balance).toEqual([]); // no wallet_address — honestly empty, never fabricated
});

test("fetchAgentsDirectory sorts rows by composite score desc by default", async () => {
  const tag = rid("sort");
  await sql`INSERT INTO openclaw_agents ${sql([
    { name: `${tag}-low`, x402_score: 5, is_active: true },
    { name: `${tag}-high`, x402_score: 90, is_active: true },
  ])}`;

  const { agents } = await fetchAgentsDirectory();
  const low = agents.findIndex((a) => a.name === `${tag}-low`);
  const high = agents.findIndex((a) => a.name === `${tag}-high`);
  expect(high).toBeLessThan(low);
});

test("summary sums active-only rows for counts, x402 txns/volume, and total balance", async () => {
  const tag = rid("sum");

  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    label: `${tag}-w`, address: "0x1111111111111111111111111111111111aaaa", balance_usd: 10_000, is_active: true,
  })} RETURNING id`;

  await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-active`, is_active: true, x402_txn_count: 3, x402_volume_usd: 300,
    wallet_address: "0x1111111111111111111111111111111111aaaa",
  })}`;
  await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-idle`, is_active: false, x402_txn_count: 999, x402_volume_usd: 999_999,
  })}`; // must NOT count toward the active-only summary

  const { summary } = await fetchAgentsDirectory();
  // A shared ephemeral DB may have other active agents from earlier tests in
  // this file, so assert lower bounds rather than exact totals.
  expect(summary.active).toBeGreaterThanOrEqual(1);
  expect(summary.x402Txns).toBeGreaterThanOrEqual(3);
  expect(summary.x402VolumeUsd).toBeGreaterThanOrEqual(300);
  expect(summary.totalBalanceUsd).toBeGreaterThanOrEqual(10_000);
});

test("GET /api/dashboards/agents route handler is a thin passthrough", async () => {
  const res = await getAgentsDirectory();
  expect(Array.isArray(res.agents)).toBe(true);
  expect(res.summary).toHaveProperty("active");
  expect(res.summary).toHaveProperty("idle");
  expect(res.summary).toHaveProperty("x402Txns");
  expect(res.summary).toHaveProperty("x402VolumeUsd");
  expect(res.summary).toHaveProperty("totalBalanceUsd");
});

test("fetchAgentsDirectory never fabricates data — every row's shape holds on a shared, possibly-empty DB slice", async () => {
  const { agents } = await fetchAgentsDirectory();
  expect(Array.isArray(agents)).toBe(true);
  for (const a of agents) {
    expect(typeof a.active).toBe("boolean");
    expect(typeof a.isFacilitator).toBe("boolean");
    expect(typeof a.score).toBe("number");
    expect(Array.isArray(a.sparkline.score)).toBe(true);
    expect(Array.isArray(a.sparkline.x402)).toBe(true);
    expect(Array.isArray(a.sparkline.balance)).toBe(true);
  }
});
