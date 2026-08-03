// The live roster seed: the two house members a public deployment seats, and
// the copy robotmoney.net publishes for them.
//
// The FIRST test is the reason this file exists. LIVE_ROSTER hand-copies the
// committed manifests (the ALLOCATION_FRAMEWORK_SEED pattern), so the only
// thing standing between "the site shows what the manifests say" and a silent
// divergence is a test that reads both and compares them literally. It asserts
// field-by-field equality against the JSON on disk, so editing a manifest
// without editing the seed (or the reverse) is a red test, not a wrong page.
//
// The rest drive the REAL seed functions against the ephemeral Postgres and
// assert what /api/committee/members actually serves, including the two
// properties an operator depends on: seeding is idempotent, and pruning
// retires off-roster members WITHOUT deleting rows that published sessions
// still reference.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_ROSTER, LIVE_ROSTER_IDS, seedLiveRoster, pruneToLiveRoster, readLiveRoster } from "../src/swarm/roster-seed.ts";
import { getMembers } from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";

const MANIFEST_DIR = join(import.meta.dir, "..", "..", "frontend", "public", "data", "swarm", "manifests", "members");

function manifest(id: string): Record<string, any> {
  return JSON.parse(readFileSync(join(MANIFEST_DIR, `${id}.json`), "utf8"));
}

async function resetRoster() {
  await sql`TRUNCATE swarm_members RESTART IDENTITY CASCADE`;
}

test("LIVE_ROSTER matches the committed manifests field for field", () => {
  expect(LIVE_ROSTER.length).toBeGreaterThan(0);
  for (const seeded of LIVE_ROSTER) {
    const source = manifest(seeded.id);
    expect(source.id).toBe(seeded.id);
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
  expect(LIVE_ROSTER_IDS).not.toContain("woon");
});

test("seeding seats the roster with the published profile copy", async () => {
  await resetRoster();
  expect(await seedLiveRoster()).toBe(LIVE_ROSTER.length);

  const served = await getMembers();
  expect(served.map((m) => m.id)).toEqual([...LIVE_ROSTER_IDS].sort());

  const athena = served.find((m) => m.id === "athena")!;
  expect(athena.name).toBe("Athena");
  expect(athena.lens).toBe("quant risk");
  expect(athena.tagline).toBe("Risk officer. Reads the composite. Looks for what breaks.");
  // The directory renders the first three biases; assert the whole array is
  // stored in manifest order so that slice is the one the old site shows.
  expect(athena.biases).toEqual(["pro-diversification", "pro-drawdown-survival", "anti-reflexivity", "skeptical-of-illiquidity"]);
  expect(athena.avatar).toEqual({ path: "/avatars/swarm/athena.jpg", source_url: null, credit: "Athena brand mark" });

  const rm = served.find((m) => m.id === "robotmoney")!;
  expect(rm.name).toBe("Robot Money");
  expect(rm.lens).toBe("institutional treasury");
  expect(rm.tagline).toBe("Reads chain. Cites mechanism. Closes positions.");
  expect((rm.biases as string[]).slice(0, 3)).toEqual(["pro-mechanism", "pro-receipt", "anti-narrative-only"]);
});

test("re-seeding is idempotent and repairs drifted copy", async () => {
  await resetRoster();
  await seedLiveRoster();
  await seedLiveRoster();
  expect((await getMembers()).length).toBe(LIVE_ROSTER.length);

  // A deployment whose copy was edited by hand (or left null by an older
  // seed) is corrected by the next run: the manifest is the source of truth
  // for the profile columns, which is what makes a re-run the fix.
  await sql`UPDATE swarm_members SET tagline = 'stale', status = 'inactive' WHERE id = 'athena'`;
  await seedLiveRoster();
  const athena = (await readLiveRoster()).find((m) => m.id === "athena")!;
  expect(athena.tagline).toBe("Risk officer. Reads the composite. Looks for what breaks.");
  expect(athena.status).toBe("active");
});

test("seeding leaves credentials alone, so a seeded member holds no token", async () => {
  await resetRoster();
  await seedLiveRoster();
  const keys = await sql`SELECT member_id FROM swarm_member_keys WHERE member_id = ANY(${[...LIVE_ROSTER_IDS]})`;
  expect(keys.length).toBe(0);
});

test("prune retires off-roster members without deleting them", async () => {
  await resetRoster();
  await sql`INSERT INTO swarm_members (id, status, name, lens)
            VALUES ('draco', 'active', 'Draco', 'contrarian'), ('helios', 'active', 'Helios', 'liquidity')`;
  await seedLiveRoster();
  expect((await getMembers()).length).toBe(LIVE_ROSTER.length + 2);

  const retired = await pruneToLiveRoster();
  expect(retired.sort()).toEqual(["draco", "helios"]);
  expect((await getMembers()).map((m) => m.id)).toEqual([...LIVE_ROSTER_IDS].sort());

  // Rows survive: published sessions reference their takes by member id, so a
  // retirement that deleted them would tear holes in the archive.
  const rows = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM swarm_members WHERE id IN ('draco', 'helios') ORDER BY id`;
  expect(rows.map((r) => ({ id: r.id, status: r.status }))).toEqual([
    { id: "draco", status: "inactive" },
    { id: "helios", status: "inactive" },
  ]);

  // Idempotent: nothing left to retire on a second run.
  expect(await pruneToLiveRoster()).toEqual([]);
});

test("prune never retires a live-roster member", async () => {
  await resetRoster();
  await seedLiveRoster();
  expect(await pruneToLiveRoster()).toEqual([]);
  expect((await getMembers()).length).toBe(LIVE_ROSTER.length);
});
