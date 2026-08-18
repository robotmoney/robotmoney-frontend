// Issue #685: the seed must key members by HANDLE, not by a hardcoded slug id.
//
// WHY THIS TEST EXISTS. `seedLiveRoster()` upserted `ON CONFLICT (id)` with the
// id hardcoded in `LIVE_ROSTER` ("athena", "robotmoney"). Two failures follow:
// the seed is what keeps human-slug ids alive at all (self-serve registration
// already uses crypto.randomUUID()), and — worse — it silently REVERTS any
// migration that re-ids a seeded member. Re-id `athena` to a UUID and the next
// boot matches no row on `id = 'athena'`, so it INSERTS a second member: the
// UUID row holds the history, a fresh empty `athena` sits beside it.
//
// Required job: backend.yml (`bun test` in backend/, against the ephemeral
// Postgres tests/preload.ts starts via Docker). Every test below writes and
// reads REAL rows through the REAL seedLiveRoster() — a missing database fails
// the run loudly in the preload rather than skipping anything.
import { expect, test, describe } from "bun:test";
import { sql } from "../src/db/client.ts";
import { LIVE_ROSTER, seedLiveRoster } from "../src/swarm/roster-seed.ts";
import { slugifyMemberName } from "../src/swarm/handle.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template. Per TEST rather
// than per file because every case here asserts on the state of the SAME two
// roster rows — "a fresh seed generates a UUID" and "an existing row keeps its
// legacy slug id" are contradictory starting points, and unique ids cannot
// separate them when the key under test is a fixed handle. Deleting the rows
// between tests is not an option either: swarm_members is append-only
// (migration 0032). See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Rows the seed owns, addressed the way the seed now addresses them. */
function seededHandles(): string[] {
  return LIVE_ROSTER.map((m) => m.handle);
}

async function rowsForRoster() {
  return (await sql`
    SELECT id, handle, name FROM swarm_members
    WHERE handle = ANY(${seededHandles()}) ORDER BY handle`) as unknown as
    { id: string; handle: string; name: string }[];
}

describe("issue #685 — roster seeding is keyed by handle", () => {
  // NO FIXTURE RESET. There used to be a `beforeEach` here that deactivated the
  // roster rows so the next test could re-seat them; useCleanDatabasePerTest
  // makes it dead weight, and the DELETE it was written to avoid is refused by
  // migration 0032 anyway.
  test("the seeded roster starts empty in this file's own database", async () => {
    // Guards the harness itself, not the seed: every assertion below reads
    // "after seeding, exactly N rows", which is only a statement about
    // seedLiveRoster() if the table began with none. A per-file (rather than
    // per-test) clone, or a template that seeded the roster, would make the
    // duplicate-detection tests pass for the wrong reason.
    expect(await rowsForRoster()).toEqual([]);
  });

  test("LIVE_ROSTER declares a handle, and no hardcoded member id", () => {
    expect(LIVE_ROSTER.length).toBeGreaterThan(0);
    for (const m of LIVE_ROSTER) {
      expect(typeof m.handle, `${m.name} must declare a handle`).toBe("string");
      expect(m.handle.length).toBeGreaterThan(0);
      // The seed must not carry an `id` at all: whatever it carried would be
      // the slug-id class this issue removes.
      expect(m).not.toHaveProperty("id");
    }
  });

  test("ONE algorithm for every member — no hand-picked handles", () => {
    // The handle is always slugifyMemberName(name). A seeded member with a
    // handle it could not have earned by that rule is an exception, and an
    // exception is what let "robotmoney" and "robot-money" mean the same member
    // in two different subsystems — the seed matching nothing the v0 importer
    // had created, and inserting a rival row.
    for (const m of LIVE_ROSTER) {
      expect(m.handle, `${m.name}'s handle must be the derived one, not a special case`)
        .toBe(slugifyMemberName(m.name));
    }
  });

  test("a fresh seed gives every member a UUID id and its declared handle", async () => {
    await seedLiveRoster();
    const rows = await rowsForRoster();
    expect(rows.length).toBe(LIVE_ROSTER.length);
    for (const row of rows) {
      expect(row.id, `${row.handle} must get a generated UUID id`).toMatch(UUID_RE);
      expect(seededHandles()).toContain(row.handle);
    }
  });

  test("seeding twice creates no duplicate — idempotent on handle", async () => {
    await seedLiveRoster();
    const first = await rowsForRoster();
    await seedLiveRoster();
    const second = await rowsForRoster();
    expect(second.length).toBe(first.length);
    // And the ids must be STABLE: a second seed that regenerated the UUID would
    // orphan every child row pointing at the first one.
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  test("re-iding a seeded member does not make the next boot insert a second row", async () => {
    // This is the regression that motivated the issue.
    await seedLiveRoster();
    const [before] = await rowsForRoster();
    const newId = crypto.randomUUID();
    await sql`UPDATE swarm_members SET id = ${newId} WHERE id = ${before.id}`;

    await seedLiveRoster(); // the "next boot"

    const after = (await sql`
      SELECT id FROM swarm_members WHERE handle = ${before.handle}`) as unknown as { id: string }[];
    expect(after.length, `handle ${before.handle} must still address exactly one member`).toBe(1);
    expect(after[0].id).toBe(newId);
  });

  test("the seed matches an EXISTING row by handle and leaves a LEGACY slug id alone", async () => {
    // Production's case: 0030 backfilled handle = id, so the row this seed will
    // meet on a real upgrade has a human-slug id, not a UUID. It must be found
    // by handle and keep the id it already has.
    //
    // Seated DIRECTLY rather than via seedLiveRoster(), because that is the
    // shape a pre-#685 deployment actually holds: a row this code never wrote.
    const handle = LIVE_ROSTER[0].handle;
    const legacyId = handle; // exactly 0030's backfill: handle = id
    await sql`INSERT INTO swarm_members (id, handle, status, name, lens)
              VALUES (${legacyId}, ${handle}, 'inactive', ${LIVE_ROSTER[0].name}, 'legacy')`;

    await seedLiveRoster(); // the upgrade boot

    const rows = (await sql`
      SELECT id, status FROM swarm_members WHERE handle = ${handle}`) as unknown as
      { id: string; status: string }[];
    expect(rows.length, "must UPDATE the existing row, not insert a rival").toBe(1);
    expect(rows[0].id, "an existing member's id must not be rewritten by the seed").toBe(legacyId);
    expect(rows[0].status, "and it must still be seated").toBe("active");
  });
});
