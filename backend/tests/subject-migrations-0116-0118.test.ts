// Migrations 0116 (vault take carries no weight vector), 0117 (one session per
// subject per day) and 0118 (purge the projects fixture rows, issue 1208), each
// applied to planted state the way the migrate step applies a file: one
// transaction, as rm_owner. Owner decisions 2026-10-09; production data changes
// only through a migration.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const text = (file: string) => readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8");
const M0116 = text("0116_vault_subject_position_actions.sql");
const M0117 = text("0117_subject_daily_epochs.sql");
const M0118 = text("0118_purge_projects_fixture_rows.sql");

async function apply(migration: string): Promise<string[]> {
  const notices: string[] = [];
  const { default: postgres } = await import("postgres");
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: (n) => notices.push(String(n.message)) });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(migration);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
  return notices;
}

async function plantSubject(id: string, type: string, extra: { duration?: number; anchor?: string; version?: number } = {}) {
  await fixtureDb`
    INSERT INTO swarm_subjects (id, status, name, recommendation_type, epoch_duration_seconds, epoch_anchor, version)
    VALUES (${id}, 'active', ${id}, ${type}, ${extra.duration ?? 21600}, ${extra.anchor ?? "2026-10-08T00:00:00Z"}::timestamptz, ${extra.version ?? 1})
    ON CONFLICT (id) DO UPDATE SET recommendation_type = EXCLUDED.recommendation_type,
      epoch_duration_seconds = EXCLUDED.epoch_duration_seconds, epoch_anchor = EXCLUDED.epoch_anchor,
      version = EXCLUDED.version`;
}
const subjectRow = async (id: string) =>
  (await fixtureDb`SELECT recommendation_type, epoch_duration_seconds, epoch_anchor, version FROM swarm_subjects WHERE id = ${id}`)[0] as
    { recommendation_type: string; epoch_duration_seconds: number; epoch_anchor: Date; version: number };

describe("0116: the vault take carries no weight vector", () => {
  test("types the vault position_actions, leaves allocation, treasury and woon alone, and a rerun changes nothing", async () => {
    await plantSubject("robotmoney-vault", "bucket_weights", { version: 4 });
    await plantSubject("robotmoney-allocation", "bucket_weights", { version: 4 });
    await plantSubject("robotmoney-treasury", "position_actions", { version: 4 });
    await plantSubject("woon", "position_actions", { version: 4 });
    await apply(M0116);
    expect(await subjectRow("robotmoney-vault")).toMatchObject({ recommendation_type: "position_actions", version: 5 });
    expect(await subjectRow("robotmoney-allocation")).toMatchObject({ recommendation_type: "bucket_weights", version: 4 });
    expect(await subjectRow("robotmoney-treasury")).toMatchObject({ recommendation_type: "position_actions", version: 4 });
    expect(await subjectRow("woon")).toMatchObject({ recommendation_type: "position_actions", version: 4 });
    await apply(M0116);
    expect(await subjectRow("robotmoney-vault")).toMatchObject({ recommendation_type: "position_actions", version: 5 });
  });
});

describe("0117: one session per subject per day", () => {
  const ANCHORS: Record<string, string> = {
    "robotmoney-vault": "2026-10-10T00:52:19.990Z",
    woon: "2026-10-10T06:58:21.970Z",
    "robotmoney-allocation": "2026-10-10T13:00:42.491Z",
    "robotmoney-treasury": "2026-10-09T19:03:59.504Z",
  };

  test("moves a 6 h subject onto the 24 h grid and leaves an open window's close alone", async () => {
    for (const id of Object.keys(ANCHORS)) await plantSubject(id, "position_actions", { version: 2 });
    const [{ id: sessionId }] = (await fixtureDb`
      INSERT INTO swarm_sessions (subject_id, subject_name, state, window_closes_at)
      VALUES ('robotmoney-vault', 'robotmoney-vault', 'collecting', '2026-10-09T18:52:19.990Z')
      RETURNING id`) as unknown as { id: string }[];
    await apply(M0117);
    for (const [id, anchor] of Object.entries(ANCHORS)) {
      const row = await subjectRow(id);
      expect(row.epoch_duration_seconds).toBe(86400);
      expect(row.epoch_anchor.toISOString()).toBe(anchor);
      expect(row.version).toBe(3);
    }
    const [session] = await fixtureDb`SELECT window_closes_at FROM swarm_sessions WHERE id = ${sessionId}`;
    expect(new Date(session!.window_closes_at).toISOString()).toBe("2026-10-09T18:52:19.990Z");
  });

  test("on production's state (set by hand already) it is a no-op: no version moves", async () => {
    for (const [id, anchor] of Object.entries(ANCHORS)) await plantSubject(id, "position_actions", { duration: 86400, anchor, version: 7 });
    await apply(M0117);
    for (const id of Object.keys(ANCHORS)) expect((await subjectRow(id)).version).toBe(7);
  });

  test("it only updates rows that exist: no subject row is created", async () => {
    const before = (await fixtureDb`SELECT count(*)::int AS n FROM swarm_subjects`)[0]!.n as number;
    await apply(M0117);
    expect((await fixtureDb`SELECT count(*)::int AS n FROM swarm_subjects`)[0]!.n).toBe(before);
  });
});

describe("0118: purge the projects fixture rows (issue 1208)", () => {
  const FIXTURE_LOGO = (n: string) => `https://cdn.example/${n}.png`;
  const counts = async () =>
    Object.fromEntries(await Promise.all(
      ["projects", "openclaw_agents", "lobster_coins", "tracked_wallets", "agent_vaults", "agent_revenue_daily",
        "daily_agent_snapshots", "daily_coin_snapshots", "daily_wallet_snapshots", "daily_tvl_snapshots", "agent_activity_log"]
        .map(async (t) => [t, ((await fixtureDb.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0] as unknown as { n: number }).n]),
    ));
  const project = async (slug: string, logo: string) =>
    ((await fixtureDb`INSERT INTO projects (slug, display_name, logo_url) VALUES (${slug}, ${slug}, ${logo}) RETURNING id`)[0] as { id: string }).id;
  let before: Record<string, number>;
  let notices: string[];

  beforeAll(async () => {
    await fixtureDb`DELETE FROM projects`;
    // virtuals-protocol: a complete fixture project with a snapshot under every child table.
    const v = await project("virtuals-protocol", FIXTURE_LOGO("virtuals"));
    const agent = (await fixtureDb`INSERT INTO openclaw_agents (project_id, name, virtuals_agent_id) VALUES (${v}, 'G.A.M.E. Protocol Agent', '0xvirt00000000000000000000000000000000game') RETURNING id`)[0] as { id: string };
    const coin = (await fixtureDb`INSERT INTO lobster_coins (project_id, name, contract_address) VALUES (${v}, 'G.A.M.E. by Virtuals', '0xgame00000000000000000000000000000000coin') RETURNING id`)[0] as { id: string };
    const wallet = (await fixtureDb`INSERT INTO tracked_wallets (project_id, label, address) VALUES (${v}, 'Virtuals DAO Treasury', '0xwallet0000000000000000000000000000000aaa') RETURNING id`)[0] as { id: string };
    const vault = (await fixtureDb`INSERT INTO agent_vaults (project_id, name, vault_address) VALUES (${v}, 'Virtuals Creator Vault', '0xvault0000000000000000000000000000000aaa') RETURNING id`)[0] as { id: string };
    await fixtureDb`INSERT INTO agent_revenue_daily (agent_id) VALUES (${agent.id})`;
    await fixtureDb`INSERT INTO daily_agent_snapshots (agent_id) VALUES (${agent.id})`;
    await fixtureDb`INSERT INTO daily_coin_snapshots (coin_id) VALUES (${coin.id})`;
    await fixtureDb`INSERT INTO daily_wallet_snapshots (wallet_id) VALUES (${wallet.id})`;
    await fixtureDb`INSERT INTO daily_tvl_snapshots (vault_id) VALUES (${vault.id})`;
    // Orphan fixture vault (its project is gone): deleted by its exact address.
    await fixtureDb`INSERT INTO agent_vaults (project_id, name, vault_address) VALUES (NULL, 'No Activity Vault', '0xvault0000000000000000000000000000000bbb')`;
    // coinbase-x402-facilitator: fixture, but an activity-log row references its agent: left whole.
    const x = await project("coinbase-x402-facilitator", FIXTURE_LOGO("x402"));
    const xAgent = (await fixtureDb`INSERT INTO openclaw_agents (project_id, name) VALUES (${x}, 'Coinbase x402 Facilitator') RETURNING id`)[0] as { id: string };
    await fixtureDb`INSERT INTO agent_activity_log (agent_id, agent_name, action_type, status) VALUES (${xAgent.id}, 'Coinbase x402 Facilitator', 'commit', 'success')`;
    // tokenless-no-activity: fixture, but carries one REAL wallet: left whole.
    const t = await project("tokenless-no-activity", FIXTURE_LOGO("noactivity"));
    await fixtureDb`INSERT INTO openclaw_agents (project_id, name) VALUES (${t}, 'No Activity Agent')`;
    await fixtureDb`INSERT INTO tracked_wallets (project_id, label, address) VALUES (${t}, 'Real Treasury', '0x00000000000000000000000000000000deadbeef')`;
    // aixbt: the same SLUG as a fixture project but a live logo and a live coin row: untouched.
    const a = await project("aixbt", "https://assets.example.org/aixbt.png");
    await fixtureDb`INSERT INTO lobster_coins (project_id, name, coingecko_id) VALUES (${a}, 'aixbt', 'aixbt')`;
    // A wholly real project: untouched.
    const r = await project("real-project", "https://assets.example.org/real.png");
    await fixtureDb`INSERT INTO tracked_wallets (project_id, label, address) VALUES (${r}, 'Real Wallet', '0x00000000000000000000000000000000cafef00d')`;
    before = await counts();
    notices = await apply(M0118);
  });

  test("a complete fixture project is deleted with every child and every snapshot, and the orphan fixture vault with it", async () => {
    const after = await counts();
    expect((await fixtureDb`SELECT 1 FROM projects WHERE slug = 'virtuals-protocol'`).length).toBe(0);
    expect(after.projects).toBe(before.projects! - 1);
    expect(after.openclaw_agents).toBe(before.openclaw_agents! - 1);
    expect(after.lobster_coins).toBe(before.lobster_coins! - 1);
    expect(after.tracked_wallets).toBe(before.tracked_wallets! - 1);
    expect(after.agent_vaults).toBe(before.agent_vaults! - 2);
    for (const t of ["agent_revenue_daily", "daily_agent_snapshots", "daily_coin_snapshots", "daily_wallet_snapshots", "daily_tvl_snapshots"]) {
      expect(after[t]).toBe(0);
    }
  });

  test("a fixture project with an activity-log reference, or with a real wallet, is left whole and named in a NOTICE", async () => {
    expect((await fixtureDb`SELECT 1 FROM projects WHERE slug IN ('coinbase-x402-facilitator', 'tokenless-no-activity')`).length).toBe(2);
    expect((await fixtureDb`SELECT 1 FROM openclaw_agents WHERE name IN ('Coinbase x402 Facilitator', 'No Activity Agent')`).length).toBe(2);
    expect((await fixtureDb`SELECT 1 FROM tracked_wallets WHERE address = '0x00000000000000000000000000000000deadbeef'`).length).toBe(1);
    expect((await counts()).agent_activity_log).toBe(1);
    const joined = notices.join("\n");
    expect(joined).toContain("coinbase-x402-facilitator");
    expect(joined).toContain("tokenless-no-activity");
  });

  test("a live project that shares a fixture slug or coin id, and a wholly real project, are untouched", async () => {
    expect((await fixtureDb`SELECT 1 FROM projects WHERE slug = 'aixbt'`).length).toBe(1);
    expect((await fixtureDb`SELECT 1 FROM lobster_coins WHERE coingecko_id = 'aixbt'`).length).toBe(1);
    expect((await fixtureDb`SELECT 1 FROM projects WHERE slug = 'real-project'`).length).toBe(1);
    expect((await fixtureDb`SELECT 1 FROM tracked_wallets WHERE address = '0x00000000000000000000000000000000cafef00d'`).length).toBe(1);
  });

  test("a second run deletes nothing, and a database that never held the fixture is untouched", async () => {
    const once = await counts();
    await apply(M0118);
    expect(await counts()).toEqual(once);
    await fixtureDb`DELETE FROM projects`;
    await apply(M0118);
    expect((await counts()).projects).toBe(0);
  });
});
