// Roster-cap invariant for the standing swarm. This test drives the REAL
// domain/admin admission functions (applyMember → activateMember, addMemberAdmin,
// reactivateMemberAdmin, registerMember) against the ephemeral Postgres with NO
// test-side cap gate — the assertions fail if enforcement is ever dropped from
// the production write paths again. It proves the active roster is HARD-BOUNDED
// at SWARM_ROSTER_CAP on every transition-to-active, that an over-cap
// admission is refused with a 409 (never silently admitted), and that an
// idempotent re-admission of an already-active id does not inflate the roster.
// Every assertion is pinned to the exported SWARM_ROSTER_CAP constant, never
// a literal, so the cap and the assertions cannot drift.
import { test, expect } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import { SWARM_ROSTER_CAP, countActiveMembers } from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { canonicalizeApplication } from "@robotmoney/contract";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

// Own database per file, so countActiveMembers() reflects only the members this
// test admits — and nothing has to be erased to make that true.
useCleanDatabase(import.meta.file);

// Onboard a member through the REAL public path (apply → activate), signing
// the canonical application payload the way an rmpc-equipped agent would. The
// server mints the memberId (§11 R2) — the caller never supplies one. Returns
// the activation result plus the identity (id/key/privateKey) so the caller
// can assert on status/ok and reuse the SAME key for re-apply assertions —
// NO cap pre-check.
async function onboard(name: string) {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const application = { name, contact: `${name}@example.test`, publicKey: publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), privateKey);
  const applied = await ic.applyMember({ ...application, signature });
  expect(applied.status).toBe(201); // application is always allowed
  const memberId = (applied as { memberId: string }).memberId;
  return { memberId, publicKeyB64, privateKey, activation: await ic.activateMember(memberId) };
}

// Current optimistic-concurrency version of a member (needed by the admin
// deactivate/reactivate paths), read from the real admin projection.
async function memberVersion(id: string): Promise<number> {
  const m = (await admin.listMembersAdmin()).find((x) => x.id === id);
  if (!m) throw new Error(`member ${id} not found`);
  return m.version;
}

test("every transition-to-active path hard-blocks admissions past SWARM_ROSTER_CAP", async () => {
  // ── Fill the roster to EXACTLY the cap through the real apply → activate gate ─
  const capMembers: Awaited<ReturnType<typeof onboard>>[] = [];
  for (let i = 0; i < SWARM_ROSTER_CAP; i++) {
    const m = await onboard(`cap_${i}`);
    expect(m.activation.ok).toBe(true);
    expect(m.activation.status).toBe(200);
    capMembers.push(m);
  }
  expect(await countActiveMembers()).toBe(SWARM_ROSTER_CAP);
  // getMembers() (the read the API/UI use) agrees with the count helper.
  expect((await ic.getMembers()).length).toBe(SWARM_ROSTER_CAP);

  // ── (CAP+1)th via activate: application allowed, activation REFUSED with 409 ─
  const extra = await onboard("cap_extra"); // applyMember returned 201 (asserted in helper)
  expect(extra.activation.ok).toBe(false);
  expect(extra.activation.status).toBe(409);
  expect(String((extra.activation as { error?: string }).error ?? "")).toContain("roster full");
  expect(await countActiveMembers()).toBe(SWARM_ROSTER_CAP); // unchanged

  // ── Admin manual add of a brand-new id is ALSO refused with 409 when full ──
  const addFull = await admin.addMemberAdmin({
    memberId: "admin_over",
    name: "admin_over",
    publicKey: (await generateKeyPair()).publicKeyB64,
  });
  expect(addFull.ok).toBe(false);
  expect(addFull.status).toBe(409);
  expect(await countActiveMembers()).toBe(SWARM_ROSTER_CAP);

  // ── Idempotency: re-admitting an ALREADY-active KEY never inflates the roster ─
  // Public apply is now refresh-or-reject BY KEY (the id is server-minted, so
  // it can no longer be the re-apply key): re-applying with the SAME key as an
  // already-ACTIVE member is refused (409) — that stays an admin operation
  // (key rotation). The privileged registerMember shortcut IS exempt (same
  // slot, ON CONFLICT DO UPDATE) so it succeeds WITHOUT a new seat.
  const first = capMembers[0];
  const dupApplication = { name: "cap_0 impersonation", contact: "cap0-dup@example.test", publicKey: first.publicKeyB64 };
  const dupSignature = await signMessage(canonicalizeApplication(dupApplication), first.privateKey);
  const dupApply = await ic.applyMember({ ...dupApplication, signature: dupSignature });
  expect(dupApply.status).toBe(409);
  const reReg = await ic.registerMember({
    memberId: first.memberId,
    name: "cap_0",
    publicKey: (await generateKeyPair()).publicKeyB64,
  });
  expect((reReg as { token?: string }).token).toBeString(); // idempotent success shape preserved
  expect(await countActiveMembers()).toBe(SWARM_ROSTER_CAP); // still full, no duplicate

  // ── Reactivation respects the cap: a freed seat can be refilled, but the
  //    reactivation of a previously-deactivated member is refused once full. ──
  const deact = await admin.deactivateMemberAdmin(first.memberId, await memberVersion(first.memberId));
  expect(deact.ok).toBe(true);
  expect(await countActiveMembers()).toBe(SWARM_ROSTER_CAP - 1);

  // Refill the single freed seat with a fresh admin add → back to the cap.
  const refill = await admin.addMemberAdmin({
    memberId: "refill",
    name: "refill",
    publicKey: (await generateKeyPair()).publicKeyB64,
  });
  expect(refill.ok).toBe(true);
  expect(await countActiveMembers()).toBe(SWARM_ROSTER_CAP);

  // Now reactivating cap_0 would push past the cap → 409, count unchanged.
  const react = await admin.reactivateMemberAdmin(first.memberId, await memberVersion(first.memberId));
  expect(react.ok).toBe(false);
  expect(react.status).toBe(409);
  expect(await countActiveMembers()).toBe(SWARM_ROSTER_CAP);
});
