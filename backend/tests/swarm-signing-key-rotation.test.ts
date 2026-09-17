// Issue #697 — a signed take must stay VERIFIABLE after its author's key
// rotates. Two independent causes, fixed together:
//
//   1. registerMember hard-DELETEd every swarm_member_keys row for a member
//      before inserting the new one (swarm/domain.ts). Re-registration is the
//      smoke harness's every-boot idempotent path, so a historical take's key
//      row was routinely destroyed — its public_key then resolved NULL.
//   2. Every read path (withTakes, getMemberTakes, getTakeReceipt) resolved a
//      take's public_key as the member's CURRENTLY ACTIVE key, not the key
//      that actually signed it — so even where the old row survived (an
//      admin rotation, which has always deactivated rather than deleted), the
//      published key was the WRONG one once a newer key existed.
//
// This file drives a REAL signed submission through both bug shapes end to
// end — submit, rotate, read back through every surface that resolves a
// take's public key — and asserts `verified` stays true throughout. Before
// the fix, both tests below fail: the first because the key row is gone
// entirely, the second because the wrong (newer) key is checked against an
// older signature.
import { test, expect } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// The DATABASE dates a session (migration 0022); read it back rather than
// asserting a date this test chose (mirrors tests/swarm.test.ts's helper).
const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

interface Signer { publicKeyB64: string; privateKey: CryptoKey }

async function submitSignedTake(opts: {
  token: string;
  signer: Signer;
  memberId: string;
  date: string;
  subjectId: string;
  nonce: string;
}) {
  const sub = {
    memberId: opts.memberId,
    date: opts.date,
    subjectId: opts.subjectId,
    nonce: opts.nonce,
    stance: "bullish",
    confidence: 0.75,
    body: "signing-key-rotation take body",
  };
  const signature = await signMessage(canonicalizeSubmission(sub), opts.signer.privateKey);
  const res = await ic.submitRecommendation(opts.token, { ...sub, signature });
  if (!("recommendationId" in res) || !res.ok) {
    throw new Error(`submitRecommendation failed: ${JSON.stringify(res)}`);
  }
  return res;
}

test("a historical take still verifies after its author RE-REGISTERS (registerMember)", async () => {
  const memberId = rid("m");
  const subj = rid("s");
  await ic.ensureSubject(subj, "Re-register Rotation Subject");
  const session = await ic.openSession(subj);
  const date = sessionDate(session);

  const keyA: Signer = await generateKeyPair();
  const first = await ic.registerMember({ memberId, name: "Rotator", publicKey: keyA.publicKeyB64 });
  if (!("token" in first) || !first.token) throw new Error(`registerMember failed: ${JSON.stringify(first)}`);

  const submitted = await submitSignedTake({ token: first.token, signer: keyA, memberId, date, subjectId: subj, nonce: "n1" });

  // Verifies BEFORE any rotation — the control.
  const before = await ic.getTakeReceipt(submitted.recommendationId);
  expect(before?.take.verified).toBe(true);

  // Re-register the SAME member id with a NEW key — the exact call the smoke
  // harness makes on every boot, and the exact call that used to hard-DELETE
  // the old key row.
  const keyB: Signer = await generateKeyPair();
  const second = await ic.registerMember({ memberId, name: "Rotator", publicKey: keyB.publicKeyB64 });
  if (!("token" in second) || !second.token) throw new Error(`registerMember (2) failed: ${JSON.stringify(second)}`);

  // The OLD key row must still be on file — retired, not gone.
  const oldKeyRows = await sql<{ active: boolean }[]>`
    SELECT active FROM swarm_member_keys WHERE member_id = ${memberId} AND public_key = ${keyA.publicKeyB64}`;
  expect(oldKeyRows).toHaveLength(1);
  expect(oldKeyRows[0]!.active).toBe(false);

  // The historical take must STILL verify, through every read surface that
  // resolves a take's public key.
  const after = await ic.getTakeReceipt(submitted.recommendationId);
  expect(after?.take.verified).toBe(true);

  const sessionRead = await ic.getSession(date, subj);
  expect(sessionRead?.takes).toHaveLength(1);
  expect(sessionRead?.takes[0]?.verified).toBe(true);

  const memberTakes = await ic.getMemberTakes(memberId);
  expect(memberTakes.takes).toHaveLength(1);
  expect(memberTakes.takes[0]?.take.verified).toBe(true);
});

test("a historical take still verifies after an ADMIN key rotation (rotateMemberKeyAdmin)", async () => {
  const memberId = rid("m");
  const subj = rid("s");
  await ic.ensureSubject(subj, "Admin Rotation Subject");
  const session = await ic.openSession(subj);
  const date = sessionDate(session);

  const keyA: Signer = await generateKeyPair();
  const registered = await ic.registerMember({ memberId, name: "Admin Rotator", publicKey: keyA.publicKeyB64 });
  if (!("token" in registered) || !registered.token) throw new Error(`registerMember failed: ${JSON.stringify(registered)}`);

  const submitted = await submitSignedTake({ token: registered.token, signer: keyA, memberId, date, subjectId: subj, nonce: "n1" });

  const before = await ic.getTakeReceipt(submitted.recommendationId);
  expect(before?.take.verified).toBe(true);

  const keyB: Signer = await generateKeyPair();
  const rotated = await admin.rotateMemberKeyAdmin(memberId, { publicKey: keyB.publicKeyB64 });
  expect(rotated.ok).toBe(true);

  // The admin path has always deactivated rather than deleted; that part was
  // never the bug. Confirm it here so a regression there would fail loudly
  // alongside this issue's fix.
  const oldKeyRows = await sql<{ active: boolean }[]>`
    SELECT active FROM swarm_member_keys WHERE member_id = ${memberId} AND public_key = ${keyA.publicKeyB64}`;
  expect(oldKeyRows).toHaveLength(1);
  expect(oldKeyRows[0]!.active).toBe(false);

  // Before the fix this failed: the take was checked against keyB (the new
  // CURRENTLY ACTIVE key), not keyA (the key that actually signed it).
  const after = await ic.getTakeReceipt(submitted.recommendationId);
  expect(after?.take.verified).toBe(true);

  const sessionRead = await ic.getSession(date, subj);
  expect(sessionRead?.takes[0]?.verified).toBe(true);

  const memberTakes = await ic.getMemberTakes(memberId);
  expect(memberTakes.takes[0]?.take.verified).toBe(true);
});

test("submitRecommendation records the exact key row that verified it (signing_key_id)", async () => {
  const memberId = rid("m");
  const subj = rid("s");
  await ic.ensureSubject(subj, "Signing Key Id Subject");
  const session = await ic.openSession(subj);
  const date = sessionDate(session);

  const keyA: Signer = await generateKeyPair();
  const registered = await ic.registerMember({ memberId, name: "Key Id", publicKey: keyA.publicKeyB64 });
  if (!("token" in registered) || !registered.token) throw new Error(`registerMember failed: ${JSON.stringify(registered)}`);

  const submitted = await submitSignedTake({ token: registered.token, signer: keyA, memberId, date, subjectId: subj, nonce: "n1" });

  const [activeKey] = await sql<{ id: string }[]>`
    SELECT id FROM swarm_member_keys WHERE member_id = ${memberId} AND active`;
  const [row] = await sql<{ signing_key_id: string | null }[]>`
    SELECT signing_key_id FROM swarm_recommendations WHERE id = ${submitted.recommendationId}`;
  expect(row?.signing_key_id).not.toBeNull();
  expect(String(row?.signing_key_id)).toBe(String(activeKey!.id));
});

test("a pre-#697 row (signing_key_id NULL) falls back to the currently-active-key lookup", async () => {
  // The documented cutover point (migration 0049's header): a row written
  // before this column existed has no signing_key_id to resolve through, so
  // it keeps exhibiting the OLD behaviour rather than silently reporting
  // "unverifiable". Simulated here by blanking the column a real submission
  // wrote, on a member who has not rotated — the fallback must still find the
  // (still-active, unrotated) key and verify.
  const memberId = rid("m");
  const subj = rid("s");
  await ic.ensureSubject(subj, "Cutover Fallback Subject");
  const session = await ic.openSession(subj);
  const date = sessionDate(session);

  const key: Signer = await generateKeyPair();
  const registered = await ic.registerMember({ memberId, name: "Cutover", publicKey: key.publicKeyB64 });
  if (!("token" in registered) || !registered.token) throw new Error(`registerMember failed: ${JSON.stringify(registered)}`);

  const submitted = await submitSignedTake({ token: registered.token, signer: key, memberId, date, subjectId: subj, nonce: "n1" });

  await sql`UPDATE swarm_recommendations SET signing_key_id = NULL WHERE id = ${submitted.recommendationId}`;

  const after = await ic.getTakeReceipt(submitted.recommendationId);
  expect(after?.take.verified).toBe(true);
});
