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
//         final"); a take inserted afterwards by code that predates the column
//         still leaves exactly one final take, the newest; and the migration's
//         own REVOKE narrows rm_app to UPDATE (final) with no grants.sql run.
//   0077  the migration's own REVOKE refuses rm_app an UPDATE on an immutable
//         ledger, again with no grants.sql run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
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

// rm_app over a real login to this file's clean clone. The role's password is a
// CLUSTER property, so it is set here rather than assumed from another file.
const RM_APP_PASSWORD = "rm_app_additive_backfills";
let app: postgres.Sql<{}>;

beforeAll(async () => {
  await sql.unsafe(`ALTER ROLE rm_app WITH LOGIN PASSWORD '${RM_APP_PASSWORD}'`);
  const [row] = (await sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${row!.db}`;
  url.username = "rm_app";
  url.password = RM_APP_PASSWORD;
  app = postgres(url.toString(), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await app?.end({ timeout: 5 });
});

async function sqlstate(statement: string): Promise<string | null> {
  try {
    await app.unsafe(statement);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-sqlstate";
  }
}

async function seedTakes(): Promise<{ subject: string; member: string; session: string }> {
  const subject = `final-legacy-${uid()}`;
  const member = `legacy-${uid()}`;
  await sql`INSERT INTO swarm_subjects (id, name) VALUES (${subject}, 'Legacy writer')`;
  await sql`INSERT INTO swarm_members (id, name, handle) VALUES (${member}, ${member}, ${member})`;
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, state) VALUES (${subject}, 'collecting') RETURNING id`;
  return { subject, member, session: session!.id };
}

/** An INSERT exactly as the pre-0075 accepting code writes it: no `final`. */
const legacyTake = (t: { subject: string; member: string; session: string }, revision: number): string => `
  INSERT INTO swarm_recommendations
    (session_id, member_id, subject_id, date, nonce, stance, payload, signature, revision)
  VALUES ('${t.session}', '${t.member}', '${t.subject}', CURRENT_DATE, 'legacy-${t.member}-${revision}', 'hold',
          '{}'::jsonb, 'sig-${revision}', ${revision})`;

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

describe("0075 — writers that predate `final`, after the backfill has run", () => {
  test("a first take and then an amendment, inserted as rm_app without naming `final`, each leave exactly one final take — the newest", async () => {
    // §8.5 runs an additive migrate against the running stack, so the OLD code
    // keeps accepting takes after 0075 applies — and again after a code-only
    // rollback. The backfill ran once; this is what keeps D51 true afterwards.
    const t = await seedTakes();
    await rerunAsOwner("0075_swarm_recommendations_final.sql");
    const finals = async (): Promise<number[]> =>
      (
        await sql<{ revision: number }[]>`
          SELECT revision FROM swarm_recommendations
           WHERE session_id = ${t.session} AND member_id = ${t.member} AND final ORDER BY revision`
      ).map((r) => r.revision);

    await app.unsafe(legacyTake(t, 1));
    expect(await finals()).toEqual([1]);
    await app.unsafe(legacyTake(t, 2));
    expect(await finals()).toEqual([2]);
    await app.unsafe(legacyTake(t, 3));
    expect(await finals()).toEqual([3]);
  });

  test("an older revision arriving after a newer one stays non-final; the newest keeps the flag", async () => {
    const t = await seedTakes();
    await app.unsafe(legacyTake(t, 2));
    await app.unsafe(legacyTake(t, 1));
    const rows = await sql<{ revision: number; final: boolean }[]>`
      SELECT revision, final FROM swarm_recommendations
       WHERE session_id = ${t.session} AND member_id = ${t.member} ORDER BY revision`;
    expect(rows.map((r) => ({ revision: r.revision, final: r.final }))).toEqual([
      { revision: 1, final: false },
      { revision: 2, final: true },
    ]);
  });

  test("a writer that sets `final = true` itself is not rescued — forgetting to unset the old take is still 23505", async () => {
    // The trigger fills in D51 only for a writer that does not know the column.
    // A writer that names `final` owns the unsetting, and the partial unique
    // index stays its check.
    const t = await seedTakes();
    await app.unsafe(legacyTake(t, 1));
    const aware = `
      INSERT INTO swarm_recommendations
        (session_id, member_id, subject_id, date, nonce, stance, payload, signature, revision, final)
      VALUES ('${t.session}', '${t.member}', '${t.subject}', CURRENT_DATE, 'aware-${t.member}', 'hold',
              '{}'::jsonb, 'sig-aware', 2, true)`;
    expect(await sqlstate(aware)).toBe("23505");
    const rows = await sql<{ revision: number; final: boolean }[]>`
      SELECT revision, final FROM swarm_recommendations
       WHERE session_id = ${t.session} AND member_id = ${t.member} ORDER BY revision`;
    expect(rows.map((r) => ({ revision: r.revision, final: r.final }))).toEqual([{ revision: 1, final: true }]);
  });
});

describe("the migrations' own privilege narrowing, on the migrated path, with no grants.sql run", () => {
  test("0075 leaves rm_app UPDATE on `final` only; 0077 refuses rm_app every UPDATE on an immutable ledger", async () => {
    // The state production is in before these files: 0053's table-wide UPDATE
    // for rm_app on both tables. Put it back, then apply ONLY the migrations.
    await sql.unsafe("GRANT UPDATE ON swarm_recommendations, source_acquisitions TO rm_app");
    await rerunAsOwner("0075_swarm_recommendations_final.sql");
    await rerunAsOwner("0077_immutable_ledger_grants.sql");

    const t = await seedTakes();
    await app.unsafe(legacyTake(t, 1));
    const [who] = (await app`SELECT current_user AS role`) as unknown as { role: string }[];
    expect(who?.role).toBe("rm_app");
    const scope = `WHERE session_id = '${t.session}'`;
    expect({
      stance: await sqlstate(`UPDATE swarm_recommendations SET stance = 'sell' ${scope}`),
      payload: await sqlstate(`UPDATE swarm_recommendations SET payload = '{"x":1}'::jsonb ${scope}`),
      signature: await sqlstate(`UPDATE swarm_recommendations SET signature = 'forged' ${scope}`),
      revision: await sqlstate(`UPDATE swarm_recommendations SET revision = 9 ${scope}`),
      final: await sqlstate(`UPDATE swarm_recommendations SET final = true ${scope}`),
      ledger: await sqlstate("UPDATE source_acquisitions SET cache_identity = cache_identity"),
    }).toEqual({ stance: "42501", payload: "42501", signature: "42501", revision: "42501", final: null, ledger: "42501" });
  });
});
