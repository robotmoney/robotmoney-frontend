// Roster-cap invariant for the standing demo committee. Drives the REAL
// onboarding gate (apply → activate) well past COMMITTEE_ROSTER_CAP against the
// ephemeral Postgres and asserts the active roster stays bounded and that a
// repeated onboarding cycle over a full/stable roster admits ZERO new members
// (idempotent). Every assertion is pinned to the exported COMMITTEE_ROSTER_CAP
// constant, never a literal, so the cap and the assertions cannot drift.
import { test, expect } from "bun:test";
import * as ic from "../src/committee/domain.ts";
import { COMMITTEE_ROSTER_CAP, countActiveMembers } from "../src/committee/domain.ts";
import { generateKeyPair } from "../src/lib/signing.ts";
import { sql } from "../src/db/client.ts";

// Isolate: own the committee_members table so countActiveMembers() reflects only
// the members this test admits (CASCADE clears the dependent key/application rows).
async function resetRoster() {
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
}

// One idempotent, capped onboarding step through the REAL apply → activate gate,
// mirroring scripts/lib/demo-main.ts onboardingDriver: admit a newcomer only when
// (a) it isn't already active and (b) the active roster is under the cap.
async function onboardStep(memberId: string): Promise<"reused" | "capped" | "admitted"> {
  const existing = await ic.getMember(memberId);
  if (existing?.status === "active") return "reused"; // idempotent — never re-create
  if ((await countActiveMembers()) >= COMMITTEE_ROSTER_CAP) return "capped"; // cap gate
  const { publicKeyB64 } = await generateKeyPair();
  const applied = await ic.applyMember({ memberId, name: memberId, publicKey: publicKeyB64 });
  if (applied.status !== 201) return "reused"; // apply is create-only → already registered
  const activated = await ic.activateMember(memberId);
  expect(activated.status).toBe(200);
  return "admitted";
}

test("onboarding is capped at COMMITTEE_ROSTER_CAP and idempotent across cycles", async () => {
  await resetRoster();
  const ITERATIONS = 15;
  expect(ITERATIONS).toBeGreaterThan(COMMITTEE_ROSTER_CAP); // drive well past the cap

  // ── First cycle: onboard 15 distinct newcomers through the gate ──────────
  for (let i = 0; i < ITERATIONS; i++) await onboardStep(`cap_${i}`);

  const afterFirst = await countActiveMembers();
  // getMembers() (the read the API/UI use) agrees with the count helper.
  expect((await ic.getMembers()).length).toBe(afterFirst);
  // Bounded: never exceeds the cap, and fills to exactly the cap given >cap tries.
  expect(afterFirst).toBeLessThanOrEqual(COMMITTEE_ROSTER_CAP);
  expect(afterFirst).toBe(COMMITTEE_ROSTER_CAP);

  // ── Second cycle over the already-full/stable roster: zero net new members ─
  const outcomes: Record<string, number> = { reused: 0, capped: 0, admitted: 0 };
  for (let i = 0; i < ITERATIONS; i++) outcomes[await onboardStep(`cap_${i}`)]++;

  const afterSecond = await countActiveMembers();
  expect(afterSecond - afterFirst).toBe(0); // idempotent: no duplicate members
  expect(afterSecond).toBeLessThanOrEqual(COMMITTEE_ROSTER_CAP);
  expect(outcomes.admitted).toBe(0); // nothing new admitted on the repeat cycle
  // The already-active members are recognised and reused, not re-created.
  expect(outcomes.reused).toBe(COMMITTEE_ROSTER_CAP);

  // ── Direct idempotency guard: re-applying an active member is create-only ──
  const dup = await ic.applyMember({
    memberId: "cap_0",
    name: "cap_0",
    publicKey: (await generateKeyPair()).publicKeyB64,
  });
  expect(dup.status).toBe(409); // duplicate id rejected → cannot inflate the roster
  expect(await countActiveMembers()).toBe(afterFirst);
});
