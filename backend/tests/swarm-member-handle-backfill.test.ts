// The missing consumer of 0030's "unset" signal.
//
// 0030 backfills `handle = id` because the column is NOT NULL and there is no
// null to mean "nobody chose a handle" — `handle === id` IS that sentinel
// (`handleIsUnset`). But the only code that ever fills a handle in runs on
// EVENTS: acceptApplication, registerMember, addMemberAdmin. Every member
// admitted before this release already passed those events, so nothing will
// ever fire for them again — Maximus, nat and the member named Woon would sit
// at a UUID handle forever, and /swarm/members/maximus would never resolve.
//
// So the sentinel was a flag with no reader. This is the reader.
import { expect, test, describe, beforeEach } from "bun:test";
import { sql } from "../src/db/client.ts";
import { backfillMemberHandles } from "../src/swarm/roster-seed.ts";
import { slugifyMemberName } from "../src/swarm/handle.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A member in the state 0030 leaves behind: handle == id, i.e. unset. */
async function memberWithUnsetHandle(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await sql`INSERT INTO swarm_members (id, handle, status, name) VALUES (${id}, ${id}, 'active', ${name})`;
  return id;
}

async function handleOf(id: string): Promise<string> {
  const rows = (await sql`SELECT handle FROM swarm_members WHERE id = ${id}`) as unknown as { handle: string }[];
  return rows[0]!.handle;
}

describe("handle backfill — every member gets the derived handle, once", () => {
  test("a member whose handle is still its id gets the derived handle", async () => {
    const id = await memberWithUnsetHandle("Maximus Backfill");
    expect(await handleOf(id), "starts unset (handle == id)").toBe(id);

    await backfillMemberHandles();

    expect(await handleOf(id)).toBe(slugifyMemberName("Maximus Backfill"));
  });

  test("the same algorithm as everywhere else — no special cases", async () => {
    // Names chosen to exercise the parts of slugifyMemberName that a hand-rolled
    // SQL version would get wrong: spacing, case, punctuation, accents.
    const names = ["Robot Money Backfill", "ÁTHENA Bäckfill", "noop analyst backfill"];
    const ids: string[] = [];
    for (const n of names) ids.push(await memberWithUnsetHandle(n));

    await backfillMemberHandles();

    for (let i = 0; i < names.length; i++) {
      expect(await handleOf(ids[i]!)).toBe(slugifyMemberName(names[i]!));
    }
  });

  test("it never overwrites a handle somebody deliberately set", async () => {
    // #562 decision 1: a handle set on purpose is a published URL, and moving it
    // without being asked is the failure that rule exists to prevent.
    const id = crypto.randomUUID();
    await sql`INSERT INTO swarm_members (id, handle, status, name)
              VALUES (${id}, 'chosen-on-purpose', 'active', 'Deliberate Backfill')`;

    await backfillMemberHandles();

    expect(await handleOf(id)).toBe("chosen-on-purpose");
  });

  test("idempotent: a second run changes nothing and reports no work", async () => {
    await memberWithUnsetHandle("Idempotent Backfill");
    const firstCount = await backfillMemberHandles();
    expect(firstCount).toBeGreaterThan(0);

    const secondCount = await backfillMemberHandles();
    expect(secondCount, "nothing is unset after the first pass").toBe(0);
  });

  test("two members sharing a name get distinct handles, not a collision", async () => {
    const a = await memberWithUnsetHandle("Twin Backfill");
    const b = await memberWithUnsetHandle("Twin Backfill");

    await backfillMemberHandles();

    const [ha, hb] = [await handleOf(a), await handleOf(b)];
    expect(ha).not.toBe(hb);
    // One gets the stem, the other a suffix — that is the derivation working,
    // and it is legitimate here because the NAMES genuinely collide.
    expect([ha, hb].sort()).toEqual(["twin-backfill", "twin-backfill-2"]);
  });

  test("a derived handle never collides with another member's id", async () => {
    // 0031 refuses a handle equal to another member's id. With UUID ids that
    // cannot happen, but a legacy slug id still in the table would make it
    // possible — so prove the derivation avoids it rather than raising.
    const squatterId = "twin-squatter-backfill";
    await sql`INSERT INTO swarm_members (id, handle, status, name)
              VALUES (${squatterId}, ${squatterId}, 'active', 'Unrelated Name')`;
    const victim = await memberWithUnsetHandle("Twin Squatter Backfill");

    await backfillMemberHandles();

    const got = await handleOf(victim);
    expect(got).not.toBe(squatterId);
    expect(got.startsWith("twin-squatter-backfill")).toBe(true);
  });
});
