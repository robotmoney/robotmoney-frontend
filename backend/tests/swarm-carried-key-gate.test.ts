// Issue #794 — the CARRIED-KEY gate: swarm/admin.ts's two `isRegistrablePublicKey()`
// calls on the public key a member ALREADY HAS ON FILE.
//
// WHY THIS FILE EXISTS SEPARATELY FROM tests/swarm.test.ts. That file covers the
// four paths that take a public key FROM THE CALLER — apply, register, admin
// manual add, rotate-key-with-a-key — exhaustively (14 encodings x 3 storing
// paths). Two paths take no key from anybody: reactivation and a key-less
// rotation both re-INSERT the member's own on-file key. Every path that FIRST
// stores a key screens it, so a key stored today passed that screen; the one
// row that did not is a row written BEFORE the gate shipped, which is exactly
// what scripts/scan-low-order-keys.ts and issue #793 exist to find. These two
// re-screens are the only thing stopping such a row from being copied into a
// NEW row after the gate — i.e. the only thing that keeps §11 R3's "can never
// be registered in swarm_member_keys" true going forward. Nothing exercised
// them: dropping either line left the suite fully green.
//
// So this file plants the pre-gate row directly (the same INSERT
// tests/scan-low-order-keys.test.ts uses, for the same reason: no code path can
// create this state any more) and drives the two carry-forward routes against
// it over HTTP.
//
// ROW COUNT, NOT JUST STATUS. A 409 that wrote the row anyway is the worst of
// both worlds — the operator is told no and the forgeable key is registered a
// second time regardless. Every refusal below asserts the member's
// swarm_member_keys rows are byte-for-byte what they were before the call.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { generateKeyPair } from "../src/lib/signing.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { path as routePath, ROUTES } from "@robotmoney/contract";
import { LOW_ORDER_ED25519_PUBLIC_KEYS_B64 } from "./support/low-order-ed25519.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

// Restated here rather than imported from swarm/admin.ts (which does not export
// it): a test that asserts a constant against itself asserts nothing. This is
// the sentence an operator actually reads, and it has to keep naming the remedy.
const CARRIED_KEY_UNREGISTRABLE =
  "member's on-file public key is not a valid Ed25519 public key (or is a low-order point) " +
  "and cannot be carried forward; use rotate-key with a freshly generated publicKey";

// `body` omitted sends a request with NO body at all — the literal "key-less
// rotate", which readJsonObject() turns into {} the same way an empty JSON
// object would. Both shapes are exercised below.
async function post(pathname: string, body?: Record<string, unknown>) {
  const req = body === undefined
    ? new Request(`http://test${pathname}`, { method: "POST" })
    : new Request(`http://test${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return handleSwarm(req, new URL(req.url));
}

const errorOf = (res: { body?: unknown } | null | undefined) => (res?.body as { error?: string } | undefined)?.error;

interface KeyRow { public_key: string; active: boolean }
const keyRows = (memberId: string) =>
  sql<KeyRow[]>`SELECT public_key, active FROM swarm_member_keys WHERE member_id = ${memberId} ORDER BY created_at`;

interface MemberRow { status: string; version: number }
const memberRow = async (memberId: string): Promise<MemberRow> => {
  const row = (await sql<MemberRow[]>`SELECT status, version FROM swarm_members WHERE id = ${memberId}`)[0];
  if (!row) throw new Error(`planted member ${memberId} vanished`);
  return { status: row.status, version: Number(row.version) };
};

// The pre-gate row. Written with raw SQL on purpose: since PR #792 there is no
// API path that will accept one of these, which is the whole point — the only
// way this row can exist is to have been written before the gate did.
// `created_at` is backdated so "newest key on file" is unambiguous once a
// remedy key is rotated in on top of it.
async function plantPreGateMember(opts: { status: string; publicKey: string; keyActive: boolean }): Promise<string> {
  const memberId = crypto.randomUUID();
  await sql`INSERT INTO swarm_members (id, name, status) VALUES (${memberId}, 'Pre-gate Member', ${opts.status})`;
  await sql`
    INSERT INTO swarm_member_keys (member_id, public_key, active, created_at)
    VALUES (${memberId}, ${opts.publicKey}, ${opts.keyActive}, now() - interval '30 days')`;
  return memberId;
}

// The stranded member's real shape: deactivateMemberAdmin() flips every key row
// to active = false, so an inactive member holds no active key — reactivation
// reads the NEWEST row by created_at regardless of `active`, and that is the
// row this screens.
test("reactivate refuses to carry a low-order on-file key forward, for every encoding, and writes no new key row", async () => {
  expect(LOW_ORDER_ED25519_PUBLIC_KEYS_B64).toHaveLength(14);
  let refusals = 0;
  for (const publicKey of LOW_ORDER_ED25519_PUBLIC_KEYS_B64) {
    const memberId = await plantPreGateMember({ status: "inactive", publicKey, keyActive: false });
    const res = await post(routePath(ROUTES.swarm.admin.memberReactivate, { id: memberId }), { expectedVersion: 1 });

    expect(res?.status).toBe(409);
    expect(errorOf(res)).toBe(CARRIED_KEY_UNREGISTRABLE);
    // No credential was minted on the way to the refusal.
    expect(res?.body).not.toHaveProperty("token");

    // The table is untouched: one row, the planted one, still rotated out.
    const rows = await keyRows(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.public_key).toBe(publicKey);
    expect(rows[0]?.active).toBe(false);
    // And the member did NOT come back: a refused reactivation is not a
    // half-applied one.
    expect(await memberRow(memberId)).toEqual({ status: "inactive", version: 1 });
    refusals++;
  }
  // Loud guard: a silently-empty fixture would otherwise let this "pass"
  // having asserted nothing at all.
  expect(refusals).toBe(14);
  // 14 planted rows and not one more — no carry-forward wrote anywhere.
  expect(await sql`SELECT id FROM swarm_member_keys`).toHaveLength(14);
});

// The other carry-forward: rotate-key with no publicKey rotates only the bearer
// token, re-registering whatever key is already active. Reachable for a member
// whose low-order row is still the ACTIVE one.
test("a key-less rotate-key refuses to re-register a low-order on-file key, for every encoding, and writes no new key row", async () => {
  expect(LOW_ORDER_ED25519_PUBLIC_KEYS_B64).toHaveLength(14);
  let refusals = 0;
  for (const [i, publicKey] of LOW_ORDER_ED25519_PUBLIC_KEYS_B64.entries()) {
    const memberId = await plantPreGateMember({ status: "active", publicKey, keyActive: true });
    const rotatePath = routePath(ROUTES.swarm.admin.memberRotateKey, { id: memberId });
    // Alternate the two ways a caller sends "no key": no request body at all,
    // and an explicit empty JSON object. Neither may reach the INSERT.
    const res = i % 2 === 0 ? await post(rotatePath) : await post(rotatePath, {});

    expect(res?.status).toBe(409);
    expect(errorOf(res)).toBe(CARRIED_KEY_UNREGISTRABLE);
    expect(res?.body).not.toHaveProperty("token");

    const rows = await keyRows(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.public_key).toBe(publicKey);
    // Not even the revocation half ran: refusing before the UPDATE is what
    // keeps a refused rotation from stranding the member with no active key.
    expect(rows[0]?.active).toBe(true);
    expect(await memberRow(memberId)).toEqual({ status: "active", version: 1 });
    refusals++;
  }
  expect(refusals).toBe(14);
  expect(await sql`SELECT id FROM swarm_member_keys`).toHaveLength(14);
});

// The refusal names a remedy. This proves the remedy, rather than assuming it:
// an operator who reads that sentence and follows it must end up with a member
// they can actually reactivate.
//
// The planted key is left ACTIVE here so BOTH carry-forward doors are shut on
// the SAME member — that is the dead end the sentence has to open.
test("rotate-key with a FRESH key is a real remedy: it registers, and reactivate then reads the new key", async () => {
  const lowOrderKey = LOW_ORDER_ED25519_PUBLIC_KEYS_B64[0];
  expect(lowOrderKey).toBeString();
  const memberId = await plantPreGateMember({ status: "inactive", publicKey: lowOrderKey!, keyActive: true });
  const rotatePath = routePath(ROUTES.swarm.admin.memberRotateKey, { id: memberId });
  const reactivatePath = routePath(ROUTES.swarm.admin.memberReactivate, { id: memberId });

  // Both doors shut, and nothing written by either attempt.
  const refusedReactivate = await post(reactivatePath, { expectedVersion: 1 });
  expect(refusedReactivate?.status).toBe(409);
  expect(errorOf(refusedReactivate)).toBe(CARRIED_KEY_UNREGISTRABLE);
  const refusedRotate = await post(rotatePath);
  expect(refusedRotate?.status).toBe(409);
  expect(errorOf(refusedRotate)).toBe(CARRIED_KEY_UNREGISTRABLE);
  expect(await keyRows(memberId)).toHaveLength(1);

  // The remedy, exactly as the refusal words it: rotate-key with a freshly
  // generated publicKey.
  const { publicKeyB64: freshKey } = await generateKeyPair();
  const rotated = await post(rotatePath, { publicKey: freshKey });
  expect(rotated?.status).toBe(200);
  expect((rotated?.body as { token?: string }).token).toBeString();

  const afterRotate = await keyRows(memberId);
  expect(afterRotate).toHaveLength(2);
  expect(afterRotate.find((r) => r.public_key === freshKey)?.active).toBe(true);
  // The low-order row is rotated OUT, not deleted: history is append-only, and
  // whatever it signed while it was live is still attributable.
  expect(afterRotate.find((r) => r.public_key === lowOrderKey)?.active).toBe(false);

  // rotate-key bumps the member version, so the operator's next call carries the
  // new one — and now reactivation goes through, because the newest key on file
  // is the honest one.
  expect(await memberRow(memberId)).toEqual({ status: "inactive", version: 2 });
  const reactivated = await post(reactivatePath, { expectedVersion: 2 });
  expect(reactivated?.status).toBe(200);
  expect((reactivated?.body as { token?: string }).token).toBeString();
  expect(await memberRow(memberId)).toEqual({ status: "active", version: 3 });

  // What reactivation carried forward is the FRESH key — the low-order one was
  // never copied into a new row, and there is still exactly one of it.
  const afterReactivate = await keyRows(memberId);
  expect(afterReactivate).toHaveLength(3);
  expect(afterReactivate.filter((r) => r.public_key === lowOrderKey)).toHaveLength(1);
  const active = afterReactivate.filter((r) => r.active);
  expect(active).toHaveLength(1);
  expect(active[0]?.public_key).toBe(freshKey);
});
