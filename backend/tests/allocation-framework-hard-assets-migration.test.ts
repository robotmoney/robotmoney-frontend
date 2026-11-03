// Migration 0129 (issue 1496): the allocation_framework row becomes 50/7/29/14
// with Hard Assets, its asof lands after every existing session, a rerun changes
// nothing, and no session row moves. Applied the way the migrate step applies a
// file: one transaction, as rm_owner.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const M0129 = readFileSync(join(import.meta.dir, "..", "migrations", "0129_allocation_framework_hard_assets.sql"), "utf8");

async function apply(): Promise<void> {
  const { default: postgres } = await import("postgres");
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(M0129);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
}

const OLD_BUCKETS = [
  { id: "conservative_defi_yield", name: "Conservative DeFi Yield", target_weight: 0.95, items: [] },
  { id: "agent_tokens", name: "Agent Tokens", target_weight: 0.05, items: [] },
  { id: "protocol_tokens", name: "Protocol Tokens", target_weight: 0, items: [] },
  { id: "real_world_assets", name: "Real World Assets", target_weight: 0, items: [] },
];

const row = async () =>
  (await fixtureDb<{ asof: Date; buckets: { id: string; target_weight: number }[] }[]>`
    SELECT asof, buckets FROM allocation_framework WHERE id = 1`)[0]!;

test("an old row is rewritten to 50/7/29/14, asof lands after the newest session, a second run changes nothing, sessions stay", async () => {
  await fixtureDb`UPDATE allocation_framework SET asof = '2026-06-02', buckets = ${fixtureDb.json(OLD_BUCKETS)} WHERE id = 1`;
  await fixtureDb`INSERT INTO swarm_subjects (id, status, name) VALUES ('mig-1496', 'active', 'mig')`;
  await fixtureDb`INSERT INTO swarm_sessions (subject_id, subject_name, state) VALUES ('mig-1496', 'mig', 'scheduled')`;
  const [{ d }] = await fixtureDb<{ d: string }[]>`SELECT max(date)::text AS d FROM swarm_sessions`;
  const sessionsBefore = JSON.stringify(await fixtureDb`SELECT id, date, state FROM swarm_sessions ORDER BY id`);

  await apply();
  const first = await row();
  expect(first.buckets.map((b) => [b.id, b.target_weight])).toEqual([
    ["conservative_defi_yield", 0.5], ["protocol_tokens", 0.07], ["real_world_assets", 0.29], ["hard_assets", 0.14],
  ]);
  const asof = first.asof.toISOString().slice(0, 10);
  expect(asof > d).toBe(true);

  await apply();
  const second = await row();
  expect(second.asof.toISOString()).toBe(first.asof.toISOString());
  expect(second.buckets).toEqual(first.buckets);
  expect(JSON.stringify(await fixtureDb`SELECT id, date, state FROM swarm_sessions ORDER BY id`)).toBe(sessionsBefore);
});

test("a database with no framework row is left alone", async () => {
  await fixtureDb`DELETE FROM allocation_framework`;
  await apply();
  expect((await fixtureDb`SELECT 1 FROM allocation_framework`).length).toBe(0);
});
