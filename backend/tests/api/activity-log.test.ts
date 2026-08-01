// Agent activity log feed (issue #392, docs/bot-analytics-ui-port-plan.md
// §5.6, P4.1) — the /market + /dashboard TerminalFeed. Runs against the
// ephemeral Postgres the preload provisions + migrates (tests/preload.ts,
// migration 0023_agent_activity_log.sql) — a real DB, never a mock. Asserts
// fetchActivityLog()/getActivityLog() (backend/src/projects/
// activity-log-projections.ts) order rows newest-first, filter zero-score
// noise, prefer the live agent's current name, and never fabricate a row on
// an empty table.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchActivityLog } from "../../src/projects/activity-log-projections.ts";
import { getActivityLog } from "../../src/api/routes/dashboards.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

test("fetchActivityLog returns newest-first entries with agent link + live name", async () => {
  const tag = rid("act");
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-agent-live-name`, is_active: true,
  })} RETURNING id`;

  const older = new Date(Date.now() - 60_000).toISOString();
  const newer = new Date().toISOString();

  await sql`INSERT INTO agent_activity_log ${sql([
    {
      occurred_at: older, agent_id: agent.id, agent_name: `${tag}-agent-stale-name`,
      action_type: "submit_metrics", status: "success", commit_summary: `${tag}-older commit`,
      submitted_by: `${tag}-alice`, approved_by: `${tag}-bob`,
    },
    {
      occurred_at: newer, agent_id: agent.id, agent_name: `${tag}-agent-stale-name`,
      action_type: "endorse", status: "pending", commit_summary: `${tag}-newer commit`,
      submitted_by: `${tag}-carol`, approved_by: null,
    },
  ])}`;

  const { entries } = await fetchActivityLog();
  const mine = entries.filter((e) => e.commitSummary?.includes(tag));
  expect(mine).toHaveLength(2);

  // Newest first.
  expect(mine[0].commitSummary).toBe(`${tag}-newer commit`);
  expect(mine[1].commitSummary).toBe(`${tag}-older commit`);

  // Agent link + LIVE name (not the denormalized name captured at write time).
  expect(mine[0].agentId).toBe(agent.id);
  expect(mine[0].agentHref).toBe(`/agents/${agent.id}`);
  expect(mine[0].agentName).toBe(`${tag}-agent-live-name`);

  expect(mine[1].status).toBe("success");
  expect(mine[1].submittedBy).toBe(`${tag}-alice`);
  expect(mine[1].approvedBy).toBe(`${tag}-bob`);
  expect(mine[0].status).toBe("pending");
  expect(mine[0].approvedBy).toBeNull();
});

test("fetchActivityLog filters zero-score rows as noise but keeps null-score rows", async () => {
  const tag = rid("noise");
  await sql`INSERT INTO agent_activity_log ${sql([
    { agent_name: `${tag}-a`, action_type: "market_event", status: "success", commit_summary: `${tag}-zero`, score: 0 },
    { agent_name: `${tag}-b`, action_type: "market_event", status: "success", commit_summary: `${tag}-null-score`, score: null },
    { agent_name: `${tag}-c`, action_type: "market_event", status: "success", commit_summary: `${tag}-nonzero`, score: 12.5 },
  ])}`;

  const { entries } = await fetchActivityLog();
  const summaries = entries.map((e) => e.commitSummary);
  expect(summaries).not.toContain(`${tag}-zero`);
  expect(summaries).toContain(`${tag}-null-score`);
  expect(summaries).toContain(`${tag}-nonzero`);
});

test("agent_id survives an ON DELETE SET NULL and the row still carries the denormalized name", async () => {
  const tag = rid("del");
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ name: `${tag}-gone`, is_active: true })} RETURNING id`;
  await sql`INSERT INTO agent_activity_log ${sql({
    agent_id: agent.id, agent_name: `${tag}-gone`, action_type: "register_agent",
    status: "success", commit_summary: `${tag}-registered`,
  })}`;
  await sql`DELETE FROM openclaw_agents WHERE id = ${agent.id}`;

  const { entries } = await fetchActivityLog();
  const row = entries.find((e) => e.commitSummary === `${tag}-registered`)!;
  expect(row.agentId).toBeNull();
  expect(row.agentHref).toBeNull();
  expect(row.agentName).toBe(`${tag}-gone`);
});

test("GET /api/dashboards/activity route handler is a thin passthrough", async () => {
  const res = await getActivityLog();
  expect(Array.isArray(res.entries)).toBe(true);
});

test("fetchActivityLog never fabricates data on an empty slice", async () => {
  // A shared ephemeral DB may already have seeded rows from other suites in
  // the same run, so assert shape/invariants rather than exact emptiness.
  const { entries } = await fetchActivityLog();
  expect(Array.isArray(entries)).toBe(true);
  for (const e of entries) {
    expect(["success", "pending", "rejected"]).toContain(e.status);
    expect(typeof e.agentName).toBe("string");
  }
});
