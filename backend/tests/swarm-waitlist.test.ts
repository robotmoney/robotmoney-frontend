import { test, expect } from "bun:test";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import * as ic from "../src/swarm/domain.ts";
import { SWARM_ROSTER_CAP, getRosterCapacityStatus } from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { sql } from "../src/db/client.ts";
import { canonicalizeApplication } from "@robotmoney/contract";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template. Per-test, not
// per-file: countActiveMembers() is global and SWARM_ROSTER_CAP is enforced on
// every transition-to-active, so members seated by one test would make the
// next test's admission a spurious 409. Unique ids cannot fix that; a clean
// database can.
useCleanDatabasePerTest(import.meta.file);

function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const b = body !== undefined ? JSON.stringify(body) : undefined;
  return new Request(`http://x${path}`, { method, headers, body: b });
}

async function callApi(method: string, path: string, body?: unknown) {
  const r = req(method, path, body);
  return await handleSwarm(r, new URL(r.url));
}

async function onboard(name: string) {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const application = { name, contact: `${name}@example.test`, publicKey: publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), privateKey);
  const applied = await ic.applyMember({ ...application, signature });
  expect(applied.status).toBe(201);
  const memberId = (applied as { memberId: string }).memberId;
  const activation = await ic.activateMember(memberId);
  expect(activation.ok).toBe(true);
  return { memberId };
}

test("POST /api/swarm/waitlist — input validation & privacy bounds", async () => {
  // Invalid inputs -> 400 valid email required
  const badInputs = [{}, { email: "" }, { email: "not-an-email" }, { email: 123 }, null];
  for (const b of badInputs) {
    const res = await callApi("POST", "/api/swarm/waitlist", b);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect((res!.body as any).error).toBe("valid email required");
  }

  // Valid submission -> 201 { ok: true }
  const res1 = await callApi("POST", "/api/swarm/waitlist", { email: "Waitlist_User@Example.Com ", source: "apply-page" });
  expect(res1).not.toBeNull();
  expect(res1!.status).toBe(201);
  expect(res1!.body).toEqual({ ok: true });

  const rows = await sql<{ email: string; email_norm: string; source: string }[]>`
    SELECT email, email_norm, source FROM swarm_waitlist WHERE email_norm = 'waitlist_user@example.com'`;
  expect(rows.length).toBe(1);
  expect(rows[0].email).toBe("Waitlist_User@Example.Com ");
  expect(rows[0].email_norm).toBe("waitlist_user@example.com");
  expect(rows[0].source).toBe("apply-page");

  // Idempotent re-submission -> 201 { ok: true } (privacy: same response, no leak)
  const res2 = await callApi("POST", "/api/swarm/waitlist", { email: "waitlist_user@example.com" });
  expect(res2!.status).toBe(201);
  expect(res2!.body).toEqual({ ok: true });

  const rows2 = await sql`SELECT count(*)::int as n FROM swarm_waitlist WHERE email_norm = 'waitlist_user@example.com'`;
  expect(Number(rows2[0].n)).toBe(1);
});

test("getRosterCapacityStatus() — returns active count, cap, and available seats seam", async () => {
  let status = await getRosterCapacityStatus();
  expect(status.cap).toBe(SWARM_ROSTER_CAP);
  expect(status.active).toBe(0);
  expect(status.seatsAvailable).toBe(SWARM_ROSTER_CAP);

  await onboard("m1");
  status = await getRosterCapacityStatus();
  expect(status.active).toBe(1);
  expect(status.seatsAvailable).toBe(SWARM_ROSTER_CAP - 1);
});

// W5.2 (issue #1026): the waitlist still works with NO email step.
//
// This replaces the old "notify-on-seat-open" case, which asserted that
// deactivating a member at cap wrote outbox rows, queued
// `swarm.send_seat_open_notification` jobs and stamped a "notified" timestamp
// on the waitlist row.
// All three are gone — the outbox table and the column are dropped by migration
// 0066 and the handler kind is unregistered (decision D50, reversing D30). What
// has to remain true is everything the waitlist is actually FOR: an address
// submitted is stored, and a seat freed by a deactivation is genuinely free. An
// operator reads the list and invites by hand.
test("a seat opening frees the seat and sends nothing — the waitlist survives with no email step", async () => {
  // Fill swarm roster to cap
  const members: string[] = [];
  for (let i = 0; i < SWARM_ROSTER_CAP; i++) {
    const m = await onboard(`seat_member_${i}`);
    members.push(m.memberId);
  }
  let capStatus = await getRosterCapacityStatus();
  expect(capStatus.active).toBe(SWARM_ROSTER_CAP);
  expect(capStatus.seatsAvailable).toBe(0);

  await callApi("POST", "/api/swarm/waitlist", { email: "waitlist1@example.com" });
  await callApi("POST", "/api/swarm/waitlist", { email: "waitlist2@example.com" });

  const mList = await admin.listMembersAdmin();
  const targetMember = mList.find((x) => x.id === members[0])!;
  expect(targetMember).toBeDefined();

  // Deactivate a member while the roster is full -> the seat is freed.
  const deactRes = await admin.deactivateMemberAdmin(targetMember.id, targetMember.version);
  expect(deactRes.ok).toBe(true);

  capStatus = await getRosterCapacityStatus();
  expect(capStatus.active).toBe(SWARM_ROSTER_CAP - 1);
  expect(capStatus.seatsAvailable).toBe(1);

  // The list is intact and readable — that is the whole feature now.
  const waitlistRows = await sql<{ email: string }[]>`
    SELECT email FROM swarm_waitlist ORDER BY email`;
  expect(waitlistRows.map((r) => r.email)).toEqual(["waitlist1@example.com", "waitlist2@example.com"]);

  // And nothing queued a delivery. Asserted over the whole `jobs` table rather
  // than the three retired kinds by name, so a new mail kind under some other
  // name fails here too.
  const jobRows = await sql<{ kind: string }[]>`SELECT kind FROM jobs`;
  expect(jobRows.filter((r) => /notification|email|mail/i.test(r.kind))).toEqual([]);
});
