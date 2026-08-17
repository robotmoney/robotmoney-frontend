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
// Fresh database per run (tests/preload.ts), never a reused one.
import { expect, test, describe, beforeEach } from "bun:test";
import { sql } from "../src/db/client.ts";
import { LIVE_ROSTER, seedLiveRoster } from "../src/swarm/roster-seed.ts";
import { slugifyMemberName } from "../src/swarm/handle.ts";

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
  beforeEach(async () => {
    // Deactivate rather than delete: this schema treats history as append-only
    // (#684), and the seed's own contract is DEACTIVATES-never-deletes.
    //
    // SCOPED to the roster's own handles. An unscoped
    // `UPDATE swarm_members SET status='inactive'` reaches every row in the
    // shared ephemeral database and breaks sibling suites — which is exactly
    // the cross-file interference these files already suffer from, and not
    // something to add more of.
    await sql`UPDATE swarm_members SET status = 'inactive' WHERE handle = ANY(${seededHandles()})`;
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
    // Written to be independent of what earlier tests left behind — these files
    // share one ephemeral database, so creating a row with a roster handle would
    // collide with an already-seeded one. Reshape the existing row instead.
    const handle = LIVE_ROSTER[0].handle;
    await seedLiveRoster();
    const legacyId = `legacy-slug-${handle}`;
    await sql`UPDATE swarm_members SET id = ${legacyId} WHERE handle = ${handle}`;

    await seedLiveRoster(); // the upgrade boot

    const rows = (await sql`
      SELECT id, status FROM swarm_members WHERE handle = ${handle}`) as unknown as
      { id: string; status: string }[];
    expect(rows.length, "must UPDATE the existing row, not insert a rival").toBe(1);
    expect(rows[0].id, "an existing member's id must not be rewritten by the seed").toBe(legacyId);
    expect(rows[0].status, "and it must still be seated").toBe("active");
  });
});
