// Roster-cap invariant for the standing committee. This test drives the REAL
// domain/admin admission functions (applyMember → activateMember, addMemberAdmin,
// reactivateMemberAdmin, registerMember) against the ephemeral Postgres with NO
// test-side cap gate — the assertions fail if enforcement is ever dropped from
// the production write paths again. It proves the active roster is HARD-BOUNDED
// at COMMITTEE_ROSTER_CAP on every transition-to-active, that an over-cap
// admission is refused with a 409 (never silently admitted), and that an
// idempotent re-admission of an already-active id does not inflate the roster.
// Every assertion is pinned to the exported COMMITTEE_ROSTER_CAP constant, never
// a literal, so the cap and the assertions cannot drift.
import { test, expect } from "bun:test";
import * as ic from "../src/committee/domain.ts";
import { COMMITTEE_ROSTER_CAP, countActiveMembers } from "../src/committee/domain.ts";
import * as admin from "../src/committee/admin.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { applicationProofMessage } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";

// Isolate: own the committee_members table so countActiveMembers() reflects only
// the members this test admits (CASCADE clears the dependent key/application rows).
async function resetRoster() {
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
}

// Onboard a member through the REAL public path (apply → activate). Returns the
// activation result so the caller can assert on status/ok — NO cap pre-check.
async function onboard(memberId: string) {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const keyProofSignature = await signMessage(applicationProofMessage(memberId, publicKeyB64), privateKey);
  const applied = await ic.applyMember({ memberId, name: memberId, publicKey: publicKeyB64, keyProofSignature });
  expect(applied.status).toBe(201); // application is always allowed
  return ic.activateMember(memberId);
}

// Current optimistic-concurrency version of a member (needed by the admin
// deactivate/reactivate paths), read from the real admin projection.
async function memberVersion(id: string): Promise<number> {
  const m = (await admin.listMembersAdmin()).find((x) => x.id === id);
  if (!m) throw new Error(`member ${id} not found`);
  return m.version;
}

test("every transition-to-active path hard-blocks admissions past COMMITTEE_ROSTER_CAP", async () => {
  await resetRoster();

  // ── Fill the roster to EXACTLY the cap through the real apply → activate gate ─
  for (let i = 0; i < COMMITTEE_ROSTER_CAP; i++) {
    const act = await onboard(`cap_${i}`);
    expect(act.ok).toBe(true);
    expect(act.status).toBe(200);
  }
  expect(await countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP);
  // getMembers() (the read the API/UI use) agrees with the count helper.
  expect((await ic.getMembers()).length).toBe(COMMITTEE_ROSTER_CAP);

  // ── (CAP+1)th via activate: application allowed, activation REFUSED with 409 ─
  const extra = await onboard("cap_extra"); // applyMember returned 201 (asserted in helper)
  expect(extra.ok).toBe(false);
  expect(extra.status).toBe(409);
  expect(String((extra as { error?: string }).error ?? "")).toContain("roster full");
  expect(await countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP); // unchanged

  // ── Admin manual add of a brand-new id is ALSO refused with 409 when full ──
  const addFull = await admin.addMemberAdmin({
    memberId: "admin_over",
    name: "admin_over",
    publicKey: (await generateKeyPair()).publicKeyB64,
  });
  expect(addFull.ok).toBe(false);
  expect(addFull.status).toBe(409);
  expect(await countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP);

  // ── Idempotency: re-admitting an ALREADY-active id never inflates the roster ─
  // Public apply is create-only (409); the privileged registerMember shortcut is
  // exempt (same slot, ON CONFLICT DO UPDATE) so it succeeds WITHOUT a new seat.
  const dupApply = await ic.applyMember({
    memberId: "cap_0",
    name: "cap_0",
    publicKey: (await generateKeyPair()).publicKeyB64,
  });
  expect(dupApply.status).toBe(409);
  const reReg = await ic.registerMember({
    memberId: "cap_0",
    name: "cap_0",
    publicKey: (await generateKeyPair()).publicKeyB64,
  });
  expect((reReg as { token?: string }).token).toBeString(); // idempotent success shape preserved
  expect(await countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP); // still full, no duplicate

  // ── Reactivation respects the cap: a freed seat can be refilled, but the
  //    reactivation of a previously-deactivated member is refused once full. ──
  const deact = await admin.deactivateMemberAdmin("cap_0", await memberVersion("cap_0"));
  expect(deact.ok).toBe(true);
  expect(await countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP - 1);

  // Refill the single freed seat with a fresh admin add → back to the cap.
  const refill = await admin.addMemberAdmin({
    memberId: "refill",
    name: "refill",
    publicKey: (await generateKeyPair()).publicKeyB64,
  });
  expect(refill.ok).toBe(true);
  expect(await countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP);

  // Now reactivating cap_0 would push past the cap → 409, count unchanged.
  const react = await admin.reactivateMemberAdmin("cap_0", await memberVersion("cap_0"));
  expect(react.ok).toBe(false);
  expect(react.status).toBe(409);
  expect(await countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP);
});
