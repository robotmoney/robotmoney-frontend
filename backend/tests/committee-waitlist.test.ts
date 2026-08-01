import { test, expect, beforeAll } from "bun:test";
import { handleCommittee } from "../src/api/routes/committee.ts";
import * as ic from "../src/committee/domain.ts";
import { COMMITTEE_ROSTER_CAP, getRosterCapacityStatus } from "../src/committee/domain.ts";
import * as admin from "../src/committee/admin.ts";
import { deliverSwarmNotification, type SwarmEmailTransport, type SwarmEmailMessage } from "../src/committee/notifications.ts";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { canonicalizeApplication } from "@robotmoney/contract";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";

beforeAll(async () => {
  await sql`TRUNCATE committee_members, committee_waitlist, committee_notification_outbox, jobs RESTART IDENTITY CASCADE`;
});

function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const b = body !== undefined ? JSON.stringify(body) : undefined;
  return new Request(`http://x${path}`, { method, headers, body: b });
}

async function callApi(method: string, path: string, body?: unknown) {
  const r = req(method, path, body);
  return await handleCommittee(r, new URL(r.url));
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

test("POST /api/committee/waitlist — input validation & privacy bounds", async () => {
  // Invalid inputs -> 400 valid email required
  const badInputs = [{}, { email: "" }, { email: "not-an-email" }, { email: 123 }, null];
  for (const b of badInputs) {
    const res = await callApi("POST", "/api/committee/waitlist", b);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect((res!.body as any).error).toBe("valid email required");
  }

  // Valid submission -> 201 { ok: true }
  const res1 = await callApi("POST", "/api/committee/waitlist", { email: "Waitlist_User@Example.Com ", source: "apply-page" });
  expect(res1).not.toBeNull();
  expect(res1!.status).toBe(201);
  expect(res1!.body).toEqual({ ok: true });

  const rows = await sql<{ email: string; email_norm: string; source: string; notified_at: Date | null }[]>`
    SELECT email, email_norm, source, notified_at FROM committee_waitlist WHERE email_norm = 'waitlist_user@example.com'`;
  expect(rows.length).toBe(1);
  expect(rows[0].email).toBe("Waitlist_User@Example.Com ");
  expect(rows[0].email_norm).toBe("waitlist_user@example.com");
  expect(rows[0].source).toBe("apply-page");
  expect(rows[0].notified_at).toBeNull();

  // Idempotent re-submission -> 201 { ok: true } (privacy: same response, no leak)
  const res2 = await callApi("POST", "/api/committee/waitlist", { email: "waitlist_user@example.com" });
  expect(res2!.status).toBe(201);
  expect(res2!.body).toEqual({ ok: true });

  const rows2 = await sql`SELECT count(*)::int as n FROM committee_waitlist WHERE email_norm = 'waitlist_user@example.com'`;
  expect(Number(rows2[0].n)).toBe(1);
});

test("getRosterCapacityStatus() — returns active count, cap, and available seats seam", async () => {
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
  let status = await getRosterCapacityStatus();
  expect(status.cap).toBe(COMMITTEE_ROSTER_CAP);
  expect(status.active).toBe(0);
  expect(status.seatsAvailable).toBe(COMMITTEE_ROSTER_CAP);

  await onboard("m1");
  status = await getRosterCapacityStatus();
  expect(status.active).toBe(1);
  expect(status.seatsAvailable).toBe(COMMITTEE_ROSTER_CAP - 1);
});

test("notify-on-seat-open — enqueues outbox + worker jobs on member deactivation and stamps notified_at", async () => {
  await sql`TRUNCATE committee_members, committee_waitlist, committee_notification_outbox, jobs RESTART IDENTITY CASCADE`;

  process.env.COMMITTEE_NOTIFICATION_EMAIL_FROM = "noreply@robotmoney.net";

  // Fill committee roster to cap
  const members: string[] = [];
  for (let i = 0; i < COMMITTEE_ROSTER_CAP; i++) {
    const m = await onboard(`seat_member_${i}`);
    members.push(m.memberId);
  }
  let capStatus = await getRosterCapacityStatus();
  expect(capStatus.active).toBe(COMMITTEE_ROSTER_CAP);
  expect(capStatus.seatsAvailable).toBe(0);

  // Add 2 waitlist entries
  await callApi("POST", "/api/committee/waitlist", { email: "waitlist1@example.com" });
  await callApi("POST", "/api/committee/waitlist", { email: "waitlist2@example.com" });

  // Get optimistic concurrency version of first member
  const mList = await admin.listMembersAdmin();
  const targetMember = mList.find((x) => x.id === members[0])!;
  expect(targetMember).toBeDefined();

  // Deactivate member when roster is full -> frees a seat (active drops below COMMITTEE_ROSTER_CAP)
  const deactRes = await admin.deactivateMemberAdmin(targetMember.id, targetMember.version);
  expect(deactRes.ok).toBe(true);

  capStatus = await getRosterCapacityStatus();
  expect(capStatus.active).toBe(COMMITTEE_ROSTER_CAP - 1);
  expect(capStatus.seatsAvailable).toBe(1);

  // Check outbox entries
  const outboxRows = await sql<{ id: string; kind: string; to_email: string }[]>`
    SELECT id, kind, to_email FROM committee_notification_outbox WHERE kind = 'seat_open' ORDER BY to_email`;
  expect(outboxRows.length).toBe(2);
  expect(outboxRows.map((r) => r.to_email)).toEqual(["waitlist1@example.com", "waitlist2@example.com"]);

  // Check worker jobs
  const jobRows = await sql<{ kind: string; payload: any }[]>`
    SELECT kind, payload FROM jobs WHERE kind = 'committee.send_seat_open_notification'`;
  expect(jobRows.length).toBe(2);

  // Queueing is not delivery: waitlist rows are only marked after the transport
  // accepts the notification, so failed jobs remain retryable.
  const queuedWaitlistRows = await sql<{ notified_at: Date | null }[]>`
    SELECT notified_at FROM committee_waitlist ORDER BY email`;
  expect(queuedWaitlistRows.every((row) => row.notified_at === null)).toBe(true);

  // Deliver notifications using test transport
  const sentMessages: SwarmEmailMessage[] = [];
  const fakeTransport: SwarmEmailTransport = {
    async send(msg) {
      sentMessages.push(msg);
    },
  };

  for (const o of outboxRows) {
    const result = await deliverSwarmNotification(o.id, fakeTransport);
    expect(result.sent).toBe(true);
  }

  expect(sentMessages.length).toBe(2);
  expect(sentMessages[0].subject).toContain("seat has opened");
  // The apply link is built from the configured public origin (issue #322),
  // not a hardcoded production URL — a staging/local waitlist notice must
  // point back at the deployment that issued it, not always robotmoney.net.
  expect(sentMessages[0].text).toContain(`${config.committeePublicBaseUrl}/committee/apply`);

  // Verify notified_at is stamped on waitlist rows
  const waitlistRows = await sql<{ email: string; notified_at: Date | null }[]>`
    SELECT email, notified_at FROM committee_waitlist ORDER BY email`;
  expect(waitlistRows.length).toBe(2);
  expect(waitlistRows[0].notified_at).not.toBeNull();
  expect(waitlistRows[1].notified_at).not.toBeNull();
});
