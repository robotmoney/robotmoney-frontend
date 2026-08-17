// The live roster seed (issue #529): the two house members a public deployment
// seats, and the copy robotmoney.net publishes for them.
//
// Required job: backend.yml (`bun test` in backend/, against the ephemeral
// Postgres tests/preload.ts starts via Docker). Every test below writes and
// reads REAL rows through the REAL seed functions — a missing database fails
// the run loudly in the preload rather than skipping anything.
//
// The FIRST test is the reason this file exists. LIVE_ROSTER hand-copies the
// committed manifests (the ALLOCATION_FRAMEWORK_SEED pattern), so the only
// thing standing between "the site shows what the manifests say" and a silent
// divergence is a test that reads both and compares them literally. It asserts
// field-by-field equality against the JSON on disk, so editing a manifest
// without editing the seed (or the reverse) is a red test, not a wrong page.
//
// The rest drive seedLiveRoster() and the SWARM_SEED_ROSTER gate in
// src/db/seed.ts, and assert what /api/swarm/members actually serves, plus the
// three properties an operator depends on: seeding is idempotent, a re-run
// repairs drifted copy, and it writes no credential and neither applied_at nor
// activated_at.
//
// The LAST four drive the CONTRACT half (issue #530): pruneToLiveRoster() and
// the SWARM_SEED_ROSTER_PRUNE gate — off-roster actives are retired to
// 'inactive' and never deleted, a pending application survives, a live-roster
// member is never swept, and the flag does nothing unless SWARM_SEED_ROSTER is
// set too.
//
// CLEANUP IS DELIBERATELY NARROW — DELETE of exactly the two roster ids and
// this suite's own throwaway fixture ids, never `TRUNCATE swarm_members ...
// CASCADE`. This suite shares one ephemeral Postgres with
// v0-seed-bootstrap.test.ts and prod-bootstrap.test.ts, whose archive rows a
// cascade would destroy (decision #502). The prune is a GLOBAL statement by
// design, so the tests that run it snapshot every active member row they did
// not create and put it back exactly as found (withForeignRowsRestored below)
// — nothing outside the live roster and the fixtures is left changed, in
// either direction.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_ROSTER, LIVE_ROSTER_HANDLES, pruneToLiveRoster, readLiveRoster, seedLiveRoster } from "../src/swarm/roster-seed.ts";
import { getMembers } from "../src/swarm/domain.ts";
import { seed } from "../src/db/seed.ts";
import { sql } from "../src/db/client.ts";

const MANIFEST_DIR = join(import.meta.dir, "..", "..", "frontend", "public", "data", "swarm", "manifests", "members");

function manifest(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(MANIFEST_DIR, `${name}.json`), "utf8"));
}

// Throwaway off-roster members the prune tests insert. Deliberately prefixed
// ids that no demo driver, manifest or archive uses, so cleaning them up by id
// can never delete a row another suite owns.
const FIXTURE_IDS = ["prune-fixture-draco", "prune-fixture-helios", "prune-fixture-applicant"] as const;

async function clearRoster(): Promise<void> {
  await sql`DELETE FROM swarm_members WHERE handle = ANY(${[...LIVE_ROSTER_HANDLES]})`;
  await sql`DELETE FROM swarm_members WHERE id = ANY(${[...FIXTURE_IDS]})`;
}

interface MemberSnapshot {
  id: string;
  status: string;
  version: number;
  updated_at: Date;
}

// pruneToLiveRoster() retires EVERY active member outside the roster — that is
// the behaviour under test, and it does not stop at rows this file created.
// Snapshot the ones belonging to sibling suites, run the prune, then restore
// them byte-for-byte (status, version, updated_at) so the shared ephemeral
// Postgres leaves this file exactly as it entered it.
async function withForeignRowsRestored<T>(fn: () => Promise<T>): Promise<T> {
  const foreign = await sql<MemberSnapshot[]>`
    SELECT id, status, version, updated_at FROM swarm_members
     WHERE status = 'active'
       AND handle <> ALL(${[...LIVE_ROSTER_HANDLES]})
       AND id <> ALL(${[...FIXTURE_IDS]})`;
  try {
    return await fn();
  } finally {
    for (const r of foreign) {
      await sql`UPDATE swarm_members SET status = ${r.status}, version = ${r.version}, updated_at = ${r.updated_at}
                WHERE id = ${r.id}`;
    }
  }
}

async function statusOf(id: string): Promise<string | null> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM swarm_members WHERE id = ${id}`;
  return rows.length ? rows[0]!.status : null;
}

// Roster members are addressed by handle now (issue #685): their ids are
// generated per deployment, so no test can name one.
async function statusOfHandle(handle: string): Promise<string | null> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM swarm_members WHERE handle = ${handle}`;
  return rows.length ? rows[0]!.status : null;
}

const origFlag = process.env.SWARM_SEED_ROSTER;
const origPruneFlag = process.env.SWARM_SEED_ROSTER_PRUNE;

beforeEach(clearRoster);
afterEach(async () => {
  if (origFlag === undefined) delete process.env.SWARM_SEED_ROSTER;
  else process.env.SWARM_SEED_ROSTER = origFlag;
  if (origPruneFlag === undefined) delete process.env.SWARM_SEED_ROSTER_PRUNE;
  else process.env.SWARM_SEED_ROSTER_PRUNE = origPruneFlag;
  await clearRoster();
});
afterAll(clearRoster);

test("LIVE_ROSTER matches the committed manifests field for field", () => {
  expect(LIVE_ROSTER.length).toBeGreaterThan(0);
  for (const seeded of LIVE_ROSTER) {
    const source = manifest(seeded.manifest);
    expect(source.id, "the manifest's id field must match its filename").toBe(seeded.manifest);
    expect(source.status).toBe("active"); // a retired manifest must not stay on the live roster
    expect(source.name).toBe(seeded.name);
    expect(source.tagline).toBe(seeded.tagline);
    expect(source.lens).toBe(seeded.lens);
    expect(source.mandate).toBe(seeded.mandate);
    expect(source.biases).toEqual(seeded.biases);
    expect(source.mode).toBe(seeded.mode);
    expect(source.operator).toBe(seeded.operator);
    expect(source.avatar).toEqual(seeded.avatar);
  }
});

// Woon is a real member of the historical committee whose operator is
// onboarding through the real apply flow, so its manifest MUST stay committed
// (the archive renders its takes) while staying off the seeded roster. This
// pins that distinction: deleting the manifest, or seating woon from the seed,
// both fail here.
test("woon stays a committed manifest and stays off the seeded roster", () => {
  expect(manifest("woon").name).toBe("Woon");
  expect(LIVE_ROSTER_HANDLES).not.toContain("woon");
});

test("seeding seats the roster with the published profile copy", async () => {
  expect(await seedLiveRoster()).toBe(LIVE_ROSTER.length);

  // Read back through the REAL members query (status='active' filter and the
  // toMember projection), scoped to the roster so a sibling suite's rows
  // cannot make this assertion pass or fail for the wrong reason.
  const served = (await getMembers()).filter((m) => LIVE_ROSTER_HANDLES.includes(m.handle));
  expect(served.map((m) => m.handle).sort()).toEqual([...LIVE_ROSTER_HANDLES].sort());

  const athena = served.find((m) => m.handle === "athena")!;
  expect(athena.name).toBe("Athena");
  expect(athena.lens).toBe("quant risk");
  expect(athena.tagline).toBe("Risk officer. Reads the composite. Looks for what breaks.");
  // The directory renders the first three biases; assert the whole array is
  // stored in manifest order so that slice is the one the old site shows.
  expect(athena.biases).toEqual(["pro-diversification", "pro-drawdown-survival", "anti-reflexivity", "skeptical-of-illiquidity"]);
  expect(athena.avatar).toEqual({ path: "/avatars/swarm/athena.jpg", source_url: null, credit: "Athena brand mark" });

  const rm = served.find((m) => m.handle === "robot-money")!;
  expect(rm.name).toBe("Robot Money");
  expect(rm.lens).toBe("institutional treasury");
  expect(rm.tagline).toBe("Reads chain. Cites mechanism. Closes positions.");
  expect(rm.mode).toBe("hybrid");
  expect((rm.biases as string[]).slice(0, 3)).toEqual(["pro-mechanism", "pro-receipt", "anti-narrative-only"]);
});

test("re-seeding is idempotent and repairs drifted copy", async () => {
  await seedLiveRoster();
  const first = await readLiveRoster();
  await seedLiveRoster();
  expect(await readLiveRoster()).toEqual(first);

  // A deployment whose copy was edited by hand (or left null by an older
  // seed) is corrected by the next run: the manifest is the source of truth
  // for the profile columns, which is what makes a re-run the fix.
  await sql`UPDATE swarm_members SET tagline = 'stale', status = 'inactive' WHERE handle = 'athena'`;
  await seedLiveRoster();
  const athena = (await readLiveRoster()).find((m) => m.handle === "athena")!;
  expect(athena.tagline).toBe("Risk officer. Reads the composite. Looks for what breaks.");
  expect(athena.status).toBe("active");
});

test("seeding leaves credentials and lifecycle timestamps alone", async () => {
  await seedLiveRoster();

  // A seeded member holds no token: it cannot submit a take until an operator
  // issues one through the normal admin path.
  const keys = await sql`
    SELECT member_id FROM swarm_member_keys
    WHERE member_id IN (SELECT id FROM swarm_members WHERE handle = ANY(${[...LIVE_ROSTER_HANDLES]}))`;
  expect(keys.length).toBe(0);

  const rows = await sql<{ id: string; applied_at: Date | null; activated_at: Date | null; key_hash: string | null; public_key: string | null }[]>`
    SELECT id, applied_at, activated_at, key_hash, public_key
    FROM swarm_members WHERE handle = ANY(${[...LIVE_ROSTER_HANDLES]}) ORDER BY handle`;
  expect(rows.length).toBe(LIVE_ROSTER.length);
  for (const r of rows) {
    expect(r.applied_at).toBeNull();
    expect(r.activated_at).toBeNull();
    expect(r.key_hash).toBeNull();
    expect(r.public_key).toBeNull();
  }
});

// The gate, driven through the REAL seed() entry point `bun run migrate` calls
// — not by re-reading the env var here. With the flag unset, CI, `bun run demo`
// and a local dev seed must produce exactly the database they produced before
// this issue.
test("SWARM_SEED_ROSTER gates the seeding: inert unset, seats when =1", async () => {
  delete process.env.SWARM_SEED_ROSTER;
  await seed();
  expect(await readLiveRoster()).toEqual([]);

  process.env.SWARM_SEED_ROSTER = "0";
  await seed();
  expect(await readLiveRoster()).toEqual([]);

  process.env.SWARM_SEED_ROSTER = "1";
  await seed();
  expect((await readLiveRoster()).map((m) => m.handle).sort()).toEqual([...LIVE_ROSTER_HANDLES].sort());
});

// ── The Contract half (issue #530): pruneToLiveRoster ────────────────────────

test("prune retires off-roster members to inactive and never deletes them", async () => {
  await withForeignRowsRestored(async () => {
    await sql`INSERT INTO swarm_members (id, status, name, lens)
              VALUES ('prune-fixture-draco', 'active', 'Draco', 'contrarian'),
                     ('prune-fixture-helios', 'active', 'Helios', 'liquidity')`;
    await seedLiveRoster();

    const retired = await pruneToLiveRoster();
    expect(retired.filter((id) => (FIXTURE_IDS as readonly string[]).includes(id)).sort()).toEqual([
      "prune-fixture-draco",
      "prune-fixture-helios",
    ]);
    // The roster is what the prune converges TO, so it is never in the sweep.
    for (const h of LIVE_ROSTER_HANDLES) expect(retired).not.toContain(h);

    // The ROWS SURVIVE. Published sessions reference their takes by member id
    // (swarm_recommendations.member_id has no ON DELETE CASCADE), so a
    // retirement that deleted them would tear holes in the archive.
    const rows = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM swarm_members WHERE id = ANY(${[...FIXTURE_IDS]}) ORDER BY id`;
    expect(rows.map((r) => ({ id: r.id, status: r.status }))).toEqual([
      { id: "prune-fixture-draco", status: "inactive" },
      { id: "prune-fixture-helios", status: "inactive" },
    ]);

    // What /api/swarm/members serves is exactly what changed: getMembers()
    // filters on status='active', so the retired members drop out of the
    // directory while the roster stays in it.
    const served = await getMembers();
    const servedIds = served.map((m) => m.id);
    const servedHandles = served.map((m) => m.handle);
    for (const id of FIXTURE_IDS) expect(servedIds).not.toContain(id);
    for (const h of LIVE_ROSTER_HANDLES) expect(servedHandles).toContain(h);

    // Idempotent: a second run finds nothing left to retire.
    expect(await pruneToLiveRoster()).toEqual([]);
  });
});

// status='applied' is a member who applied through the real flow and is
// waiting on an admin. The prune only touches status='active', so a
// convergence run must not sweep the queue an operator is about to approve.
test("prune leaves a pending application seated", async () => {
  await withForeignRowsRestored(async () => {
    await sql`INSERT INTO swarm_members (id, status, name, lens)
              VALUES ('prune-fixture-applicant', 'applied', 'Applicant', 'macro')`;
    await seedLiveRoster();

    const retired = await pruneToLiveRoster();
    expect(retired).not.toContain("prune-fixture-applicant");
    expect(await statusOf("prune-fixture-applicant")).toBe("applied");
  });
});

test("prune never retires a live-roster member", async () => {
  await withForeignRowsRestored(async () => {
    await seedLiveRoster();

    const retired = await pruneToLiveRoster();
    for (const h of LIVE_ROSTER_HANDLES) expect(retired).not.toContain(h);
    for (const h of LIVE_ROSTER_HANDLES) expect(await statusOfHandle(h)).toBe("active");
    expect((await readLiveRoster()).map((m) => m.handle).sort()).toEqual([...LIVE_ROSTER_HANDLES].sort());
  });
});

// The gate, driven through the REAL seed() entry point `bun run migrate`
// calls. The prune flag is read INSIDE the SWARM_SEED_ROSTER block, so the
// first leg below is the important one: on its own it does nothing, and a
// deployment can never end up with its members retired and no roster seated.
test("SWARM_SEED_ROSTER_PRUNE gates the pruning: inert alone, inert unset, retires when =1", async () => {
  await withForeignRowsRestored(async () => {
    await sql`INSERT INTO swarm_members (id, status, name, lens)
              VALUES ('prune-fixture-draco', 'active', 'Draco', 'contrarian')`;

    delete process.env.SWARM_SEED_ROSTER;
    process.env.SWARM_SEED_ROSTER_PRUNE = "1";
    await seed();
    expect(await readLiveRoster()).toEqual([]);
    expect(await statusOf("prune-fixture-draco")).toBe("active");

    // Seeding without the prune flag stays additive: the roster is seated and
    // the off-roster member is left exactly where it was.
    process.env.SWARM_SEED_ROSTER = "1";
    delete process.env.SWARM_SEED_ROSTER_PRUNE;
    await seed();
    expect((await readLiveRoster()).map((m) => m.handle).sort()).toEqual([...LIVE_ROSTER_HANDLES].sort());
    expect(await statusOf("prune-fixture-draco")).toBe("active");

    process.env.SWARM_SEED_ROSTER_PRUNE = "0";
    await seed();
    expect(await statusOf("prune-fixture-draco")).toBe("active");

    // Both flags set: the convergence run retires the off-roster member and
    // leaves the seated roster active.
    process.env.SWARM_SEED_ROSTER_PRUNE = "1";
    await seed();
    expect(await statusOf("prune-fixture-draco")).toBe("inactive");
    for (const h of LIVE_ROSTER_HANDLES) expect(await statusOfHandle(h)).toBe("active");
    expect((await readLiveRoster()).map((m) => m.handle).sort()).toEqual([...LIVE_ROSTER_HANDLES].sort());
  });
});
