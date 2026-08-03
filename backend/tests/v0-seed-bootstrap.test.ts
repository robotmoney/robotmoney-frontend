// Integration coverage for the v0 (robotmoney-site) Investment Committee
// archive bootstrap (issue #467), against the SAME ephemeral Postgres the
// rest of the suite uses. Runs the REAL committed archive
// (seed-data/v0-committee-archive.json.gz) through the REAL
// runV0SeedBootstrap() core against a clean schema and proves the three
// contractual behaviors from the issue's acceptance criteria:
//   • cold DB: exactly 3 members, 4 subjects, 32 sessions inserted, with
//     legacy_takes populated (athena + woon present) on every session
//   • idempotent: a second run against the now-seeded DB is a clean no-op
//   • drift-detection: a deliberate mutation of an existing row is reported
//     field-by-field and NEVER silently overwritten
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runV0SeedBootstrap } from "../scripts/v0-seed-bootstrap.ts";
import { loadV0Archive } from "../src/swarm/v0-archive.ts";

const MEMBER_IDS = ["athena", "robotmoney", "woon"];
const SUBJECT_IDS = ["robotmoney-allocation", "robotmoney-treasury", "robotmoney-vault", "woon"];

async function cleanArchiveRows(): Promise<void> {
  // Sessions first (no FK dependency either way here, but keep dependency
  // order symmetric with the bootstrap's own members -> subjects -> sessions
  // ordering), then subjects, then members.
  await sql`DELETE FROM swarm_sessions WHERE subject_id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_subjects WHERE id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_members WHERE id = ANY(${MEMBER_IDS})`;
}

beforeEach(cleanArchiveRows);
afterEach(cleanArchiveRows);

test("cold DB: v0-seed-bootstrap inserts exactly 3 members, 4 subjects, 32 sessions, with legacy_takes on every session", async () => {
  const result = await runV0SeedBootstrap();

  expect(result.members).toEqual({ inserted: 3, unchanged: 0, drifted: 0, total: 3 });
  expect(result.subjects).toEqual({ inserted: 4, unchanged: 0, drifted: 0, total: 4 });
  expect(result.sessions).toEqual({ inserted: 32, unchanged: 0, drifted: 0, total: 32 });
  expect(result.drifts).toEqual([]);

  const [{ n: memberCount }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_members WHERE id = ANY(${MEMBER_IDS})`;
  expect(memberCount).toBe(3);

  const [{ n: subjectCount }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_subjects WHERE id = ANY(${SUBJECT_IDS})`;
  expect(subjectCount).toBe(4);

  const sessionRows = await sql<{ legacy_takes: { member_id: string }[] | null }[]>`
    SELECT legacy_takes FROM swarm_sessions WHERE subject_id = ANY(${SUBJECT_IDS})`;
  expect(sessionRows.length).toBe(32);
  for (const row of sessionRows) {
    expect(row.legacy_takes).not.toBeNull();
    expect(Array.isArray(row.legacy_takes)).toBe(true);
    expect(row.legacy_takes!.length).toBeGreaterThan(0);
    const memberIds = row.legacy_takes!.map((t) => t.member_id);
    // AC: "athena and woon takes confirmed present in every session".
    expect(memberIds).toContain("athena");
    expect(memberIds).toContain("woon");
  }
});

test("idempotent: a second run against the now-seeded DB is a clean no-op", async () => {
  const first = await runV0SeedBootstrap();
  expect(first.members.inserted).toBe(3);
  expect(first.subjects.inserted).toBe(4);
  expect(first.sessions.inserted).toBe(32);
  expect(first.drifts).toEqual([]);

  const second = await runV0SeedBootstrap();
  expect(second.members).toEqual({ inserted: 0, unchanged: 3, drifted: 0, total: 3 });
  expect(second.subjects).toEqual({ inserted: 0, unchanged: 4, drifted: 0, total: 4 });
  expect(second.sessions).toEqual({ inserted: 0, unchanged: 32, drifted: 0, total: 32 });
  expect(second.drifts).toEqual([]);

  const [{ n: memberCount }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_members WHERE id = ANY(${MEMBER_IDS})`;
  expect(memberCount).toBe(3);
  const [{ n: sessionCount }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_sessions WHERE subject_id = ANY(${SUBJECT_IDS})`;
  expect(sessionCount).toBe(32);
});

test("drift: a mutated existing member field is reported field-by-field and never silently overwritten", async () => {
  await runV0SeedBootstrap();

  const { payload } = await loadV0Archive();
  const athena = payload.members.find((m) => m.id === "athena")!;
  const mutatedTagline = "MUTATED — this should never be overwritten by the archive";
  await sql`UPDATE swarm_members SET tagline = ${mutatedTagline} WHERE id = 'athena'`;

  const result = await runV0SeedBootstrap();

  // No inserts (everything already existed); athena counts as drifted, the
  // other two members are unchanged.
  expect(result.members).toEqual({ inserted: 0, unchanged: 2, drifted: 1, total: 3 });
  expect(result.subjects).toEqual({ inserted: 0, unchanged: 4, drifted: 0, total: 4 });
  expect(result.sessions).toEqual({ inserted: 0, unchanged: 32, drifted: 0, total: 32 });

  expect(result.drifts).toEqual([
    {
      entity: "swarm_members",
      naturalKey: "id=athena",
      field: "tagline",
      oldValue: mutatedTagline,
      newValue: athena.tagline,
    },
  ]);

  // The mutated row was NEVER silently overwritten.
  const [{ tagline }] = await sql<{ tagline: string }[]>`SELECT tagline FROM swarm_members WHERE id = 'athena'`;
  expect(tagline).toBe(mutatedTagline);
});

test("drift: a mutated existing session's legacy_takes is reported and never silently overwritten", async () => {
  await runV0SeedBootstrap();

  const mutatedTakes = [{ member_id: "athena", stance: "MUTATED", body: "tampered take" }];
  await sql`
    UPDATE swarm_sessions SET legacy_takes = ${sql.json(mutatedTakes)}
    WHERE subject_id = 'woon'
    AND id = (SELECT id FROM swarm_sessions WHERE subject_id = 'woon' ORDER BY convened_at LIMIT 1)`;

  const result = await runV0SeedBootstrap();

  expect(result.members).toEqual({ inserted: 0, unchanged: 3, drifted: 0, total: 3 });
  expect(result.subjects).toEqual({ inserted: 0, unchanged: 4, drifted: 0, total: 4 });
  expect(result.sessions.inserted).toBe(0);
  expect(result.sessions.drifted).toBe(1);
  expect(result.sessions.unchanged).toBe(31);

  const legacyTakesDrift = result.drifts.find((d) => d.entity === "swarm_sessions" && d.field === "legacy_takes");
  expect(legacyTakesDrift).toBeDefined();
  expect(legacyTakesDrift!.naturalKey).toContain("subject_id=woon");
  expect((legacyTakesDrift!.oldValue as { stance: string }[])[0].stance).toBe("MUTATED");

  // Never silently overwritten.
  const [{ legacy_takes }] = await sql<{ legacy_takes: { stance: string }[] }[]>`
    SELECT legacy_takes FROM swarm_sessions
    WHERE subject_id = 'woon' AND id = (SELECT id FROM swarm_sessions WHERE subject_id = 'woon' ORDER BY convened_at LIMIT 1)`;
  expect(legacy_takes[0]!.stance).toBe("MUTATED");
});
