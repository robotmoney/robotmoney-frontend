// The backfills in migrations 0073 and 0075 — issue #1026, run against a
// POPULATED database, the only kind a backfill exists for.
//
// A blank bootstrap never runs a backfill (the snapshot's declaration already
// carries the columns), so the proof that these migrations leave production's
// existing rows in the right state has to come from replaying the migration's
// own text over rows shaped the way production's are. Each case builds the
// pre-migration state in this file's clean clone, re-runs the real file as
// rm_owner — both files are written to be re-runnable (`ADD COLUMN IF NOT
// EXISTS`, `CREATE ... IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`) — and reads
// the result back.
//
//   0073  epoch_anchor backfills to the subject's open window's close, so the
//         open window is on the new grid (k = 0) and nothing it waits on moves;
//         a subject with no open window keeps the fixed default.
//   0075  the newest revision per (session, member) becomes final, and only it
//         (D51: "backfills each legacy session's newest revision per member as
//         final").
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const migrationText = (file: string): string => readFileSync(join(MIGRATIONS, file), "utf8");

async function rerunAsOwner(file: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe(migrationText(file));
  });
}

const uid = (): string => crypto.randomUUID().slice(0, 8);

describe("0073 — epoch_anchor backfill", () => {
  test("a subject with an open window is anchored at that window's close; one without keeps the unix-epoch default", async () => {
    const open = `anchor-open-${uid()}`;
    const idle = `anchor-idle-${uid()}`;
    await sql`INSERT INTO swarm_subjects (id, name) VALUES (${open}, 'Open'), (${idle}, 'Idle')`;
    const closes = new Date("2026-09-24T18:30:00Z");
    await sql`
      INSERT INTO swarm_sessions (subject_id, state, window_closes_at)
      VALUES (${open}, 'collecting', ${closes}), (${idle}, 'published', ${new Date("2026-09-20T00:00:00Z")})`;
    // The state before 0073 ran: every subject on the column default.
    await sql`UPDATE swarm_subjects SET epoch_anchor = DEFAULT WHERE id IN (${open}, ${idle})`;

    await rerunAsOwner("0073_subject_grid_columns.sql");

    const rows = await sql<{ id: string; epoch_anchor: Date; judging_duration_seconds: number }[]>`
      SELECT id, epoch_anchor, judging_duration_seconds FROM swarm_subjects WHERE id IN (${open}, ${idle})`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(open)?.epoch_anchor.toISOString()).toBe(closes.toISOString());
    // A published session is not an open window.
    expect(byId.get(idle)?.epoch_anchor.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    // The judging duration is the value the code hardcodes today.
    expect(byId.get(open)?.judging_duration_seconds).toBe(900);
    expect(byId.get(idle)?.judging_duration_seconds).toBe(900);
  });
});

describe("0075 — final-take backfill", () => {
  test("the newest revision per (session, member) is final, and no other row is", async () => {
    const subject = `final-backfill-${uid()}`;
    const alice = `alice-${uid()}`;
    const bob = `bob-${uid()}`;
    await sql`INSERT INTO swarm_subjects (id, name) VALUES (${subject}, 'Backfill')`;
    await sql`INSERT INTO swarm_members (id, name, handle) VALUES (${alice}, ${alice}, ${alice}), (${bob}, ${bob}, ${bob})`;
    const [s1] = await sql<{ id: string }[]>`
      INSERT INTO swarm_sessions (subject_id, state) VALUES (${subject}, 'published') RETURNING id`;
    const [s2] = await sql<{ id: string }[]>`
      INSERT INTO swarm_sessions (subject_id, state) VALUES (${subject}, 'collecting') RETURNING id`;

    // A legacy shape: alice amended twice in s1, bob once; alice once in s2.
    const takes: [string, string, number][] = [
      [s1!.id, alice, 1],
      [s1!.id, alice, 2],
      [s1!.id, alice, 3],
      [s1!.id, bob, 1],
      [s2!.id, alice, 1],
    ];
    for (const [session, member, revision] of takes) {
      await sql`
        INSERT INTO swarm_recommendations
          (session_id, member_id, subject_id, date, nonce, stance, payload, signature, revision)
        VALUES (${session}, ${member}, ${subject}, CURRENT_DATE, ${`n-${session}-${member}-${revision}`}, 'hold',
                '{}'::jsonb, ${`sig-${revision}`}, ${revision})`;
    }
    // Before 0075: nothing final (the column did not exist).
    await sql`UPDATE swarm_recommendations SET final = false WHERE subject_id = ${subject}`;

    await rerunAsOwner("0075_swarm_recommendations_final.sql");

    const rows = await sql<{ session_id: string; member_id: string; revision: number; final: boolean }[]>`
      SELECT session_id, member_id, revision, final FROM swarm_recommendations
       WHERE subject_id = ${subject} ORDER BY session_id, member_id, revision`;
    const finals = rows.filter((r) => r.final).map((r) => `${r.session_id === s1!.id ? "s1" : "s2"}:${r.member_id === alice ? "alice" : "bob"}:${r.revision}`);
    expect(finals.sort()).toEqual(["s1:alice:3", "s1:bob:1", "s2:alice:1"]);
    expect(rows.filter((r) => !r.final)).toHaveLength(2);

    // Re-running is a no-op: the migration is safe to resume over.
    await rerunAsOwner("0075_swarm_recommendations_final.sql");
    const [again] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM swarm_recommendations WHERE subject_id = ${subject} AND final`;
    expect(again?.n).toBe(3);
  });
});
