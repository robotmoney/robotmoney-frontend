// Issue #961: give framework subjects their allocation targets in the brief.
// Snapshot the allocation_framework table at brief creation, omit for non-framework
// subjects, freeze policy on retry, and scope recentSessions to the target subject.
import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import * as swarm from "../src/swarm/domain.ts";
import { ALLOCATION_FRAMEWORK_SEED } from "../src/chain/allocation-framework.ts";

useCleanDatabasePerTest(import.meta.file);

test("publishBrief() for subject with source.type === 'framework' attaches body.allocation matching allocation_framework table", async () => {
  const subjId = "robotmoney-allocation";
  await sql`INSERT INTO swarm_subjects (id, status, name, source, recommendation_type)
            VALUES (${subjId}, 'active', 'Robot Money Allocation', ${sql.json({ type: "framework" })}, 'bucket_weights')
            ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source`;

  await sql`INSERT INTO allocation_framework (id, asof, vault_contract, buckets)
            VALUES (1, '2026-06-02', ${ALLOCATION_FRAMEWORK_SEED.vault_contract},
                    ${sql.json(JSON.parse(JSON.stringify(ALLOCATION_FRAMEWORK_SEED.buckets)))})
            ON CONFLICT (id) DO UPDATE SET asof = EXCLUDED.asof, buckets = EXCLUDED.buckets`;

  const session = await swarm.openSession(subjId);
  await swarm.publishBrief(session.id);
  const brief = await swarm.getBriefBySession(session.id);

  expect(brief).not.toBeNull();
  expect(brief?.body?.allocation).toBeDefined();
  expect(brief?.body?.allocation?.asof).toBe("2026-06-02");
  expect(brief?.body?.allocation?.buckets).toEqual(
    JSON.parse(JSON.stringify(ALLOCATION_FRAMEWORK_SEED.buckets)),
  );
});

test("publishBrief() for subject with source.type !== 'framework' omits body.allocation", async () => {
  const subjId = "woon";
  await sql`INSERT INTO swarm_subjects (id, status, name, source, recommendation_type)
            VALUES (${subjId}, 'active', 'Woon Treasury', ${sql.json({ type: "wallets" })}, 'bucket_weights')
            ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source`;

  const session = await swarm.openSession(subjId);
  await swarm.publishBrief(session.id);
  const brief = await swarm.getBriefBySession(session.id);

  expect(brief).not.toBeNull();
  expect(brief?.body?.allocation).toBeUndefined();
});

test("publishBrief() for framework subject without allocation_framework row carries no allocation (no seed fallback)", async () => {
  const subjId = "framework-no-row";
  await sql`INSERT INTO swarm_subjects (id, status, name, source, recommendation_type)
            VALUES (${subjId}, 'active', 'Framework No Row', ${sql.json({ type: "framework" })}, 'bucket_weights')
            ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source`;

  await sql`DELETE FROM allocation_framework WHERE id = 1`;

  const session = await swarm.openSession(subjId);
  await swarm.publishBrief(session.id);
  const brief = await swarm.getBriefBySession(session.id);

  expect(brief).not.toBeNull();
  expect(brief?.body?.allocation).toBeUndefined();
});

test("brief freezes policy at creation and retry cannot replace its reference", async () => {
  const subjId = "robotmoney-allocation";
  await sql`INSERT INTO swarm_subjects (id, status, name, source, recommendation_type)
            VALUES (${subjId}, 'active', 'Robot Money Allocation', ${sql.json({ type: "framework" })}, 'bucket_weights')
            ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source`;

  await sql`INSERT INTO allocation_framework (id, asof, vault_contract, buckets)
            VALUES (1, '2026-06-02', ${ALLOCATION_FRAMEWORK_SEED.vault_contract},
                    ${sql.json(JSON.parse(JSON.stringify(ALLOCATION_FRAMEWORK_SEED.buckets)))})
            ON CONFLICT (id) DO UPDATE SET asof = EXCLUDED.asof, buckets = EXCLUDED.buckets`;

  const first = await swarm.openSession(subjId);
  await swarm.publishBrief(first.id);
  const before = await swarm.getBriefBySession(first.id);
  expect(before?.body?.allocation?.buckets[0]?.target_weight).toBe(0.95);

  // Alter the policy in the database
  const changed = ALLOCATION_FRAMEWORK_SEED.buckets.map((b, i) => ({
    ...b,
    target_weight: i === 0 ? 0.9 : i === 1 ? 0.1 : 0,
  }));
  await sql`UPDATE allocation_framework SET buckets = ${sql.json(JSON.parse(JSON.stringify(changed)))} WHERE id = 1`;

  // Retry publishing the first session — must retain original reference
  await swarm.publishBrief(first.id);
  const afterRetry = await swarm.getBriefBySession(first.id);
  expect(afterRetry?.body?.allocation).toEqual(before?.body?.allocation);

  // Publishing a fresh session picks up the new policy
  await sql`UPDATE swarm_sessions SET state = 'published' WHERE id = ${first.id}`;
  const second = await swarm.openSession(subjId);
  await swarm.publishBrief(second.id);
  const secondBrief = await swarm.getBriefBySession(second.id);
  expect(secondBrief?.body?.allocation?.buckets[0]?.target_weight).toBe(0.9);
});

test("publishBrief()'s recentSessions only contains published sessions matching the target subject_id", async () => {
  const subjA = "subject-a";
  const subjB = "subject-b";
  await sql`INSERT INTO swarm_subjects (id, status, name)
            VALUES (${subjA}, 'active', 'Subject A'),
                   (${subjB}, 'active', 'Subject B')
            ON CONFLICT (id) DO NOTHING`;

  // Seed sessions for subjA: 6 published sessions on different dates, 1 collecting session
  for (let i = 1; i <= 6; i++) {
    const timeStr = `2026-01-0${i}T12:00:00Z`;
    await sql`INSERT INTO swarm_sessions (subject_id, subject_name, convened_at, state)
              VALUES (${subjA}, 'Subject A', ${timeStr}::timestamptz, 'published')`;
  }
  await sql`INSERT INTO swarm_sessions (subject_id, subject_name, convened_at, state)
            VALUES (${subjA}, 'Subject A', '2026-01-07T12:00:00Z'::timestamptz, 'collecting')`;

  // Seed sessions for subjB: 3 published sessions
  for (let i = 1; i <= 3; i++) {
    const timeStr = `2026-01-0${i}T12:00:00Z`;
    await sql`INSERT INTO swarm_sessions (subject_id, subject_name, convened_at, state)
              VALUES (${subjB}, 'Subject B', ${timeStr}::timestamptz, 'published')`;
  }

  // Open and publish a new session for subjA
  const targetSession = await swarm.openSession(subjA);
  await swarm.publishBrief(targetSession.id);

  const brief = await swarm.getBriefBySession(targetSession.id);
  expect(brief).not.toBeNull();

  const recent = brief?.body?.recentSessions as Array<{ date: string; subject_id: string; state: string }>;
  expect(Array.isArray(recent)).toBe(true);
  // Limited to 5
  expect(recent.length).toBe(5);

  // All entries must belong to subjA and have state = 'published'
  for (const item of recent) {
    expect(item.subject_id).toBe(subjA);
    expect(item.state).toBe("published");
  }

  // Ordered by date DESC (2026-01-06 down to 2026-01-02)
  const dates = recent.map((r) => (typeof r.date === "string" ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10)));
  expect(dates).toEqual(["2026-01-06", "2026-01-05", "2026-01-04", "2026-01-03", "2026-01-02"]);
});
