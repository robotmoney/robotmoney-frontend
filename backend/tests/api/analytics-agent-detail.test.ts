// /agents/:id "Money-agent dossier" AgentProfile detail (issue #390). Runs
// against the ephemeral Postgres the preload provisions + migrates (tests/
// preload.ts) — a real DB, never a mock. Seeds a project (for description/
// website/twitter + its vault/wallet facets), an agent linked to it, revenue/
// snapshot history, and asserts fetchAgentDetail() (backend/src/projects/
// agent-detail-projections.ts) joins correctly, weekly-buckets the x402
// series, computes the same composite score formula as the directory feed,
// and derives evidence/whyIncluded/openGaps deterministically.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchAgentDetail } from "../../src/projects/agent-detail-projections.ts";
import { getAgentDetail } from "../../src/api/routes/dashboards.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// daysAgo() is fine for "some time in the past", but NOT for two dates that
// must share an ISO week: on a Tuesday or Wednesday, daysAgo(3) and daysAgo(1)
// straddle a Monday and the weekly sum bucket splits in two. Anchor to the
// last COMPLETE week instead, so the fixture dates are deterministic on every
// day of the week.
const DAY_MS = 86_400_000;
const isoDayIndex = (t: number) => (new Date(t).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
const lastCompleteWeekMonday = () => {
  const now = Date.now();
  return now - isoDayIndex(now) * DAY_MS - 7 * DAY_MS;
};
// n days into that week: inLastWeek(0) = Monday, inLastWeek(2) = Wednesday.
const inLastWeek = (n: number) =>
  new Date(lastCompleteWeekMonday() + n * DAY_MS).toISOString().slice(0, 10);
// The same offset one week earlier, for a row that must land in an EARLIER bucket.
const inWeekBefore = (n: number) =>
  new Date(lastCompleteWeekMonday() + (n - 7) * DAY_MS).toISOString().slice(0, 10);

test("fetchAgentDetail returns null for an unknown id (never fabricated)", async () => {
  const detail = await fetchAgentDetail(crypto.randomUUID());
  expect(detail).toBeNull();
});

// Regression for the dash-shell smoke test's `/agents/clawd` placeholder URL
// (frontend/test/browser/dash-shell.spec.ts) crashing the full-stack e2e
// demo: openclaw_agents.id is a `uuid` column, so an unvalidated non-UUID id
// used to reach Postgres and throw "invalid input syntax for type uuid"
// instead of resolving to this function's null -> 404 contract. Same
// malformed-id convention as dossier-projections.test.ts's fetchCoinProfile
// coverage.
test("fetchAgentDetail returns null for a malformed id (never a thrown Postgres error)", async () => {
  expect(await fetchAgentDetail("clawd")).toBeNull();
  expect(await fetchAgentDetail("")).toBeNull();
  expect(await fetchAgentDetail("not-a-uuid")).toBeNull();
  expect(await fetchAgentDetail(crypto.randomUUID().slice(0, 20))).toBeNull(); // truncated UUID
  expect(await fetchAgentDetail("../../etc/passwd")).toBeNull();
});

test("fetchAgentDetail joins project socials, matched wallet, project vaults/wallets, and computes the composite score", async () => {
  const tag = rid("dossier");

  const [project] = await sql`INSERT INTO projects ${sql({
    slug: tag, display_name: `${tag}-project`, overview_short: "A dossier test project.",
    website_url: "https://example.test", twitter_handle: "example",
  })} RETURNING id`;

  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    project_id: project.id, label: `${tag}-wallet`,
    address: "0xABCDEF0000000000000000000000000000BEEF", balance_usd: 4_200, is_active: true,
  })} RETURNING id`;
  // A second project wallet NOT matched by the agent's own wallet_address —
  // proves the "project's other wallets" join, not just the matched one.
  await sql`INSERT INTO tracked_wallets ${sql({
    project_id: project.id, label: `${tag}-treasury`, address: "0x2222222222222222222222222222222222bbbb", balance_usd: 900, is_active: true,
  })}`;

  await sql`INSERT INTO agent_vaults ${sql({
    project_id: project.id, name: `${tag}-vault`, strategy_type: "erc4626", tvl_usd: 50_000, yield_apy: 4.5,
  })}`;

  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    project_id: project.id, name: `${tag}-agent`, protocol_standard: "x402",
    x402_score: 61.5, x402_txn_count: 12, x402_resources_count: 3, x402_volume_usd: 500,
    cumulative_revenue_usd: 1_000, productivity_score: 40, is_active: true, source_confidence: "high",
    enriched_at: new Date().toISOString(),
    // lowercase — must still match the mixed-case tracked_wallets row, same case-insensitive rule as the directory feed.
    wallet_address: "0xabcdef0000000000000000000000000000beef",
  })} RETURNING id`;

  await sql`INSERT INTO agent_revenue_daily ${sql([
    { agent_id: agent.id, revenue_date: daysAgo(3), revenue_usd: 200, source: "x402" },
    { agent_id: agent.id, revenue_date: daysAgo(40), revenue_usd: 99_999, source: "x402" }, // outside the 30d window
  ])}`;

  await sql`INSERT INTO daily_agent_snapshots ${sql([
    { agent_id: agent.id, snapshot_date: inWeekBefore(0), x402_volume_usd: 100 },
    { agent_id: agent.id, snapshot_date: inLastWeek(0), x402_volume_usd: 50 },
    { agent_id: agent.id, snapshot_date: inLastWeek(2), x402_volume_usd: 25 },
  ])}`;

  const detail = await fetchAgentDetail(agent.id as string);
  expect(detail).not.toBeNull();
  const d = detail!;

  expect(d.name).toBe(`${tag}-agent`);
  expect(d.description).toBe("A dossier test project.");
  expect(d.websiteUrl).toBe("https://example.test");
  expect(d.twitterHandle).toBe("example");
  expect(d.walletBalanceUsd).toBe(4_200); // matched despite address case mismatch
  // composite = max(x402Score=61.5, productivityScore=40, log10(200+1)*25≈57.8) => 61.5
  expect(d.score).toBeCloseTo(61.5, 5);
  expect(d.revenue30dUsd).toBe(200);
  expect(d.x402Txns).toBe(12);
  expect(d.x402Resources).toBe(3);

  // Both project wallets appear; exactly one is flagged as the agent's own match.
  expect(d.wallets.length).toBeGreaterThanOrEqual(2);
  const flagged = d.wallets.filter((w) => w.isAgentWallet);
  expect(flagged.length).toBe(1);
  expect(flagged[0]!.id).toBe(wallet.id as string);

  expect(d.vaults.length).toBeGreaterThanOrEqual(1);
  expect(d.vaults.some((v) => v.name === `${tag}-vault`)).toBe(true);

  // x402 weekly series: inLastWeek(0) and inLastWeek(2) fall in the same ISO
  // week -> summed to 75 in the last bucket.
  expect(d.x402Sparkline.length).toBeGreaterThan(0);
  expect(d.x402Sparkline[d.x402Sparkline.length - 1]).toBe(75);

  // Evidence: wallet+moneyIn+x402+identity all verified given the seeded data; freshness verified (enriched_at = now).
  expect(d.evidence.wallet).toBe("verified");
  expect(d.evidence.moneyIn).toBe("verified");
  expect(d.evidence.x402).toBe("verified");
  expect(d.evidence.identity).toBe("verified");
  expect(d.evidence.freshness).toBe("verified");
  expect(d.whyIncluded.length).toBe(5);
  expect(d.openGaps.length).toBe(0);
});

test("fetchAgentDetail is honest about a sparse agent with no project, wallet, or history", async () => {
  const tag = rid("sparse");
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ name: `${tag}-agent`, is_active: true })} RETURNING id`;

  const detail = await fetchAgentDetail(agent.id as string);
  expect(detail).not.toBeNull();
  const d = detail!;

  expect(d.description).toBeNull();
  expect(d.websiteUrl).toBeNull();
  expect(d.walletAddress).toBeNull();
  expect(d.walletBalanceUsd).toBeNull();
  expect(d.vaults).toEqual([]);
  expect(d.wallets).toEqual([]);
  expect(d.x402Sparkline).toEqual([]);
  expect(d.score).toBe(0);

  expect(d.evidence.wallet).toBe("missing");
  expect(d.evidence.moneyIn).toBe("missing");
  expect(d.evidence.x402).toBe("missing");
  expect(d.evidence.identity).toBe("missing");
  expect(d.evidence.freshness).toBe("missing"); // no enriched_at set
  expect(d.openGaps.length).toBe(5);
  expect(d.whyIncluded.length).toBe(0);
});

test("GET /api/dashboards/agents/:id route handler is a thin passthrough returning null for an unknown id", async () => {
  const res = await getAgentDetail(crypto.randomUUID());
  expect(res).toBeNull();
});

test("GET /api/dashboards/agents/:id route handler returns the seeded agent's own id back", async () => {
  const tag = rid("passthrough");
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ name: `${tag}-agent`, is_active: true })} RETURNING id`;
  const res = await getAgentDetail(agent.id as string);
  expect(res).not.toBeNull();
  expect(res!.id).toBe(agent.id as string);
});
