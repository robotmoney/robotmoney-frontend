// Issue #685: the v0 archive importer must not assume its own member ids are
// the database's member ids.
//
// The archive names members by published slug ("athena", "robotmoney",
// "woon") and every one of its ~216 historical takes references those slugs.
// The importer used them as the primary key directly, which welded the archive
// to a slug-id namespace: once the roster seed generates UUIDs, the importer's
// INSERT of id="athena" is refused by migration 0031 — the handle "athena" is
// already held by the seeded row, so the id would address a second member.
//
// The requirement: the archive slug is a HANDLE, not an id. The importer
// resolves each archive member to whatever id the database holds (or generates
// one), and remaps every take's FK onto it — while leaving the archive slug
// inside the SIGNED payload, because that is who authored the take and the
// signature is over those exact bytes.
//
// Required job: backend.yml (`bun test` in backend/, against the ephemeral
// Postgres tests/preload.ts starts via Docker). Every test runs the REAL
// committed archive through the REAL importer — a missing database fails the
// run loudly in the preload rather than skipping anything.
import { expect, test, describe } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runV0SeedBootstrap } from "../scripts/v0-seed-bootstrap.ts";
import { seedLiveRoster } from "../src/swarm/roster-seed.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template. Per TEST because
// "seed first, then import" and "import into an empty database" are different
// starting states for the SAME three archive members, and the importer is
// idempotent — a second test running against the first test's rows would
// observe `inserted: 0` and prove nothing. Deleting between tests is not an
// option: swarm_members and swarm_recommendations are append-only (migration
// 0032). See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Derived from the DISPLAY names, one algorithm for everyone — not the
// archive's internal slugs ("athena", "robotmoney", "woon"). The archive
// renames woon to "Noop analyst", so it derives noop-analyst.
const ARCHIVE_HANDLES = ["athena", "robot-money", "noop-analyst"] as const;

async function memberByHandle(handle: string) {
  const rows = (await sql`
    SELECT id, handle, name FROM swarm_members WHERE handle = ${handle}`) as unknown as
    { id: string; handle: string; name: string }[];
  return rows[0];
}

describe("issue #685 — the v0 importer resolves members by handle", () => {
  test("ordering B: seed first (UUID ids), then import — no id collision", async () => {
    await seedLiveRoster();
    // The seed owns athena + robot-money and gave them generated ids.
    const seeded = await memberByHandle("athena");
    expect(seeded?.id).toMatch(UUID_RE);

    // This is the call that used to be refused by 0031.
    const result = await runV0SeedBootstrap();
    expect(result.drifts).toEqual([]);

    // athena must still be ONE member, still holding the id the seed gave it.
    const after = (await sql`
      SELECT id FROM swarm_members WHERE handle = 'athena'`) as unknown as { id: string }[];
    expect(after.length, "the importer must not create a rival athena").toBe(1);
    expect(after[0].id, "and must not rewrite the id it found").toBe(seeded!.id);
  });

  test("every archive member is addressable by its published handle", async () => {
    await runV0SeedBootstrap();
    for (const handle of ARCHIVE_HANDLES) {
      const m = await memberByHandle(handle);
      expect(m, `archive member ${handle} must exist under that handle`).toBeDefined();
    }
    // The archive's own rename: its slug "woon" displays as "Noop analyst" and
    // therefore derives the handle noop-analyst. The bare "woon" handle is left
    // free for the member actually named Woon.
    expect((await memberByHandle("noop-analyst"))!.name).toBe("Noop analyst");
    expect(await memberByHandle("woon"), "the archive must not claim the handle 'woon'").toBeUndefined();
  });

  test("imported takes attach to the resolved member, not to the archive slug", async () => {
    await runV0SeedBootstrap();
    const woon = (await memberByHandle("noop-analyst"))!;

    // Every take the archive attributed to "woon" must hang off woon's ACTUAL
    // id. A leftover FK of the literal 'woon' would mean the remap was skipped.
    const mine = (await sql`
      SELECT count(*)::int AS n FROM swarm_recommendations WHERE member_id = ${woon.id}`) as unknown as
      { n: number }[];
    expect(mine[0].n, "the archive takes must be attached").toBeGreaterThan(0);

    const orphaned = (await sql`
      SELECT count(*)::int AS n FROM swarm_recommendations r
      WHERE NOT EXISTS (SELECT 1 FROM swarm_members m WHERE m.id = r.member_id)`) as unknown as
      { n: number }[];
    expect(orphaned[0].n, "no take may reference a member that does not exist").toBe(0);
  });

  test("the SIGNED payload keeps the archive's own signer id", async () => {
    await runV0SeedBootstrap();
    const woon = (await memberByHandle("noop-analyst"))!;
    const rows = (await sql`
      SELECT payload->>'memberId' AS signer FROM swarm_recommendations
      WHERE member_id = ${woon.id} LIMIT 1`) as unknown as { signer: string }[];
    // Provenance, not a bug: the signature is over bytes naming the archive
    // identity. Rewriting the payload to the new id would invalidate it.
    expect(rows[0].signer).toBe("woon");
  });

  test("re-running the import is still idempotent under the remap", async () => {
    await runV0SeedBootstrap();
    const first = await runV0SeedBootstrap();
    expect(first.drifts).toEqual([]);
    expect(first.members.inserted).toBe(0);
    expect(first.members.drifted).toBe(0);
  });
});
