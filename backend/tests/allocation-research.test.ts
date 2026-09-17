import { test, expect } from 'bun:test';
import { sql } from '../src/db/client.ts';
import * as swarm from '../src/swarm/domain.ts';
import { useCleanDatabasePerTest } from './support/clean-db.ts';
import { ALLOCATION_FRAMEWORK_SEED } from '../src/chain/allocation-framework.ts';
useCleanDatabasePerTest(import.meta.file);

test('allocation history filters before pagination and retains each exact session reference', async () => {
  const subject = 'robotmoney-allocation';
  await swarm.ensureSubject(subject, 'Robot Money Allocation');
  const ids: string[] = [];
  for (let i = 0; i < 15; i++) {
    const [s] = await sql`INSERT INTO swarm_sessions (subject_id, subject_name, state, swarm_recommendation)
      VALUES (${subject}, 'Robot Money Allocation', 'published', ${sql.json({ rationale: `Review ${i} liquidity`, weights: [] })}) RETURNING id, date`;
    ids.push(s.id);
    await sql`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
      VALUES (${s.id}, ${s.date}, ${subject}, ${sql.json(JSON.parse(JSON.stringify({ allocation: ALLOCATION_FRAMEWORK_SEED })))})`;
  }
  await swarm.ensureSubject('other-book', 'Other book');
  await sql`INSERT INTO swarm_sessions (subject_id, state) VALUES ('other-book', 'published'), (${subject}, 'collecting')`;
  const first = await swarm.listSessions({ subject, state: 'published', limit: 12 });
  expect(first.sessions).toHaveLength(12);
  expect(first.nextCursor).not.toBeNull();
  expect(first.sessions.every(s => s.subjectId === subject && s.state === 'published')).toBe(true);
  expect((first.sessions[0] as any).referenceAllocation.buckets[0].target_weight).toBe(.95);
  expect((first.sessions[0] as any).referenceAllocation.buckets[0].items).toBeUndefined();
  expect((first.sessions[0] as any).takeCount).toBe(0);
  const second = await swarm.listSessions({ subject, state: 'published', limit: 12, cursor: first.nextCursor });
  expect(second.sessions).toHaveLength(3);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.sessions, ...second.sessions].map(s => s.id)).size).toBe(15);
  const search = await swarm.listSessions({ subject, search: 'Review 14', limit: 12 });
  expect(search.sessions.map(s => s.id)).toEqual([ids[14]!]);
  expect((await swarm.listSessions({ subject, search: '%', limit: 12 })).sessions).toHaveLength(0);
  await expect(swarm.listSessions({ subject, full: true })).rejects.toThrow('filtered requests');
  await expect(swarm.listSessions({ cursor: btoa(JSON.stringify({ d: 'no', g: 'no', i: 'no' })) })).rejects.toThrow('malformed cursor');
});

test('brief freezes policy at creation and retry cannot replace its reference', async () => {
  await swarm.ensureSubject('robotmoney-allocation', 'Robot Money Allocation');
  await sql`INSERT INTO allocation_framework (id, asof, vault_contract, buckets)
    VALUES (1, '2026-06-02', ${ALLOCATION_FRAMEWORK_SEED.vault_contract}, ${sql.json(JSON.parse(JSON.stringify(ALLOCATION_FRAMEWORK_SEED.buckets)))})
    ON CONFLICT (id) DO UPDATE SET buckets = EXCLUDED.buckets`;
  const first = await swarm.openSession('robotmoney-allocation');
  await swarm.publishBrief(first.id);
  const before = await swarm.getBriefBySession(first.id);
  expect(before?.body?.allocation?.buckets[0]?.target_weight).toBe(.95);
  const changed = ALLOCATION_FRAMEWORK_SEED.buckets.map((b, i) => ({ ...b, target_weight: i === 0 ? .9 : i === 1 ? .1 : 0 }));
  await sql`UPDATE allocation_framework SET buckets = ${sql.json(JSON.parse(JSON.stringify(changed)))} WHERE id = 1`;
  await swarm.publishBrief(first.id);
  expect((await swarm.getBriefBySession(first.id))?.body?.allocation).toEqual(before?.body?.allocation);
  await sql`UPDATE swarm_sessions SET state = 'published' WHERE id = ${first.id}`;
  const second = await swarm.openSession('robotmoney-allocation');
  await swarm.publishBrief(second.id);
  expect((await swarm.getBriefBySession(second.id))?.body?.allocation?.buckets[0]?.target_weight).toBe(.9);
  expect((await swarm.getBriefBySession(second.id))?.body?.recentSessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id })]));
});
