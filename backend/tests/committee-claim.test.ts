import { beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeApplication, canonicalizeClaimChallenge, COMMITTEE_ROSTER_CAP, ROUTES } from "@robotmoney/contract";
import { handleCommittee } from "../src/api/routes/committee.ts";
import * as ic from "../src/committee/domain.ts";
import {
  deliverCommitteeNotification,
  type CommitteeEmailMessage,
} from "../src/committee/notifications.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

async function post(path: string, body: Record<string, unknown>) {
  const request = new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleCommittee(request, new URL(request.url));
}

async function get(path: string) {
  const request = new Request(`http://test${path}`);
  return handleCommittee(request, new URL(request.url));
}

async function applyAndActivate(prefix: string) {
  const label = rid(prefix);
  const keypair = await generateKeyPair();
  const application = { name: `Applicant ${label}`, contact: `${label}@example.test`, publicKey: keypair.publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), keypair.privateKey);
  const applied = await post(ROUTES.committee.apply, { ...application, signature });
  expect(applied?.status).toBe(201);
  const memberId = (applied!.body as { memberId: string }).memberId;
  const activated = await ic.activateMember(memberId);
  expect(activated.status).toBe(200);
  expect(activated).not.toHaveProperty("token");
  return { memberId, contact: application.contact, ...keypair, activated };
}

async function challengeFor(memberId: string) {
  const response = await post(ROUTES.committee.claimChallenge, { memberId });
  expect(response?.status).toBe(200);
  return response!.body as ic.TokenClaimChallenge;
}

beforeEach(async () => {
  await sql`DELETE FROM jobs WHERE kind = 'committee.send_activation_notification'`;
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
});

test("activation persists an email outbox and the executed fake transport delivers it", async () => {
  const applicant = await applyAndActivate("notify");
  expect((applicant.activated as any).notificationQueued).toBe(true);

  const outbox = (await sql<{ id: string; sent_at: Date | null }[]>`
    SELECT id, sent_at FROM committee_notification_outbox WHERE member_id = ${applicant.memberId}`)[0];
  expect(outbox).toBeTruthy();
  expect(outbox.sent_at).toBeNull();
  const jobs = await sql`
    SELECT id FROM jobs
    WHERE kind = 'committee.send_activation_notification'
      AND payload->>'outboxId' = ${outbox.id}`;
  expect(jobs).toHaveLength(1);

  const delivered: CommitteeEmailMessage[] = [];
  const fakeTransport = { send: async (message: CommitteeEmailMessage) => { delivered.push(message); } };
  expect(await deliverCommitteeNotification(outbox.id, fakeTransport)).toEqual({ sent: true });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    from: "committee-test@robotmoney.invalid",
    to: applicant.contact,
  });
  expect(delivered[0].text).toContain(ROUTES.committee.claimChallenge);
  expect(delivered[0].text).toContain(ROUTES.committee.claimToken);
  expect(await deliverCommitteeNotification(outbox.id, fakeTransport)).toEqual({ sent: false, idempotent: true });
  expect(delivered).toHaveLength(1);
});

test("challenge issuance is indistinguishable and keeps one live 10-minute challenge per active member", async () => {
  const applicant = await applyAndActivate("challenge");
  const knownFirst = await challengeFor(applicant.memberId);
  const unknown = await challengeFor(rid("unknown"));
  expect(Object.keys(unknown).sort()).toEqual(Object.keys(knownFirst).sort());
  expect(new Date(unknown.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
  expect(await sql`SELECT member_id FROM committee_claim_challenges WHERE member_id = ${unknown.memberId}`).toHaveLength(0);

  const knownSecond = await challengeFor(applicant.memberId);
  expect(knownSecond.challenge).not.toBe(knownFirst.challenge);
  const persisted = await sql<{ challenge: string; consumed_at: Date | null }[]>`
    SELECT challenge, consumed_at FROM committee_claim_challenges WHERE member_id = ${applicant.memberId}`;
  expect(persisted).toHaveLength(1);
  expect(persisted[0].challenge).toBe(knownSecond.challenge);
  expect(persisted[0].consumed_at).toBeNull();

  const staleSignature = await signMessage(canonicalizeClaimChallenge(knownFirst), applicant.privateKey);
  const stale = await post(ROUTES.committee.claimToken, { ...knownFirst, signature: staleSignature });
  expect(stale?.status).toBe(400);
});

test("first valid key proof mints the sole token; wrong/tampered/expired proofs do not and retry is 409", async () => {
  const applicant = await applyAndActivate("claim");
  const challenge = await challengeFor(applicant.memberId);
  const wrongKey = await generateKeyPair();
  const wrongSignature = await signMessage(canonicalizeClaimChallenge(challenge), wrongKey.privateKey);
  expect((await post(ROUTES.committee.claimToken, { ...challenge, signature: wrongSignature }))?.status).toBe(400);

  const validSignature = await signMessage(canonicalizeClaimChallenge(challenge), applicant.privateKey);
  expect((await post(ROUTES.committee.claimToken, {
    ...challenge,
    challenge: `${challenge.challenge}tampered`,
    signature: validSignature,
  }))?.status).toBe(400);
  expect((await sql<{ token_hash: string | null }[]>`
    SELECT token_hash FROM committee_member_keys WHERE member_id = ${applicant.memberId} AND active`)[0].token_hash).toBeNull();

  const concurrent = await Promise.all([
    post(ROUTES.committee.claimToken, { ...challenge, signature: validSignature }),
    post(ROUTES.committee.claimToken, { ...challenge, signature: validSignature }),
  ]);
  expect(concurrent.map((response) => response?.status).sort()).toEqual([200, 409]);
  const claimed = concurrent.find((response) => response?.status === 200);
  const token = (claimed?.body as { token: string }).token;
  expect(await ic.memberIdForToken(token)).toBe(applicant.memberId);
  expect((await sql`SELECT id FROM committee_member_keys WHERE member_id = ${applicant.memberId} AND active AND token_hash IS NOT NULL`)).toHaveLength(1);
  expect((await sql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM committee_claim_challenges WHERE member_id = ${applicant.memberId}`)[0].consumed_at).not.toBeNull();

  const retry = await post(ROUTES.committee.claimToken, { ...challenge, signature: validSignature });
  expect(retry?.status).toBe(409);
  expect((retry?.body as { error: string }).error).toContain("already claimed");
  expect((await sql`SELECT id FROM committee_member_keys WHERE member_id = ${applicant.memberId} AND active AND token_hash IS NOT NULL`)).toHaveLength(1);
  const throwawayAfterClaim = await challengeFor(applicant.memberId);
  expect(throwawayAfterClaim.challenge).not.toBe(challenge.challenge);
  const retainedConsumed = (await sql<{ challenge: string; consumed_at: Date | null }[]>`
    SELECT challenge, consumed_at FROM committee_claim_challenges WHERE member_id = ${applicant.memberId}`)[0];
  expect(retainedConsumed.challenge).toBe(challenge.challenge);
  expect(retainedConsumed.consumed_at).not.toBeNull();

  const expiredApplicant = await applyAndActivate("expired");
  const expired = await challengeFor(expiredApplicant.memberId);
  await sql`
    UPDATE committee_claim_challenges
    SET issued_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
    WHERE member_id = ${expiredApplicant.memberId}`;
  const expiredSignature = await signMessage(canonicalizeClaimChallenge(expired), expiredApplicant.privateKey);
  expect((await post(ROUTES.committee.claimToken, { ...expired, signature: expiredSignature }))?.status).toBe(400);
  expect((await sql<{ token_hash: string | null }[]>`
    SELECT token_hash FROM committee_member_keys WHERE member_id = ${expiredApplicant.memberId} AND active`)[0].token_hash).toBeNull();
});

test("claim never bypasses the imported committee roster cap", async () => {
  for (let i = 0; i < COMMITTEE_ROSTER_CAP; i++) {
    const publicKey = (await generateKeyPair()).publicKeyB64;
    const admitted = await ic.registerMember({ memberId: `claim_cap_${i}`, name: `Cap ${i}`, publicKey });
    expect("token" in admitted).toBe(true);
  }
  expect(await ic.countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP);

  const keypair = await generateKeyPair();
  const application = { name: "Over cap", contact: "over-cap@example.test", publicKey: keypair.publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), keypair.privateKey);
  const applied = await post(ROUTES.committee.apply, { ...application, signature });
  expect(applied?.status).toBe(201);
  const memberId = (applied!.body as { memberId: string }).memberId;
  expect((await ic.activateMember(memberId)).status).toBe(409);
  expect(await ic.countActiveMembers()).toBe(COMMITTEE_ROSTER_CAP);

  await challengeFor(memberId);
  expect(await sql`SELECT member_id FROM committee_claim_challenges WHERE member_id = ${memberId}`).toHaveLength(0);
  const status = (await sql<{ status: string }[]>`SELECT status FROM committee_members WHERE id = ${memberId}`)[0].status;
  expect(status).toBe("applied");
});

test("0019 migration is idempotent when executed repeatedly against real Postgres", async () => {
  const ddl = await readFile(join(process.cwd(), "migrations/0019_committee_self_serve_claim.sql"), "utf8");
  await sql.unsafe(ddl);
  await sql.unsafe(ddl);
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('committee_claim_challenges', 'committee_notification_outbox')
    ORDER BY table_name`;
  expect(tables.map((row) => row.table_name)).toEqual([
    "committee_claim_challenges",
    "committee_notification_outbox",
  ]);
});

test("GET /api/committee/applications/:memberId/status returns privacy-safe fields across onboarding lifecycle without PII", async () => {
  const secretContact = "secret_agent_007@example.test";
  const agentName = "Secret Agent Desk";
  const keypair = await generateKeyPair();
  const application = { name: agentName, contact: secretContact, lens: "macro", publicKey: keypair.publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), keypair.privateKey);

  const appliedRes = await post(ROUTES.committee.apply, { ...application, signature });
  expect(appliedRes?.status).toBe(201);
  const memberId = (appliedRes!.body as { memberId: string }).memberId;

  // 1. Pending stage
  const pendingStatusRes = await get(`/api/committee/applications/${memberId}/status`);
  expect(pendingStatusRes?.status).toBe(200);
  expect(pendingStatusRes?.body).toEqual({
    memberId,
    status: "pending",
    claimable: false,
    claimed: false,
  });
  // Verify strict key set: only memberId, status, claimable, claimed (no PII)
  expect(Object.keys(pendingStatusRes!.body as object).sort()).toEqual(["claimable", "claimed", "memberId", "status"]);
  expect(JSON.stringify(pendingStatusRes?.body)).not.toContain(secretContact);
  expect(JSON.stringify(pendingStatusRes?.body)).not.toContain(agentName);
  expect(JSON.stringify(pendingStatusRes?.body)).not.toContain(keypair.publicKeyB64);

  // 2. Approved-unclaimed stage
  const activated = await ic.activateMember(memberId);
  expect(activated.status).toBe(200);

  const approvedStatusRes = await get(`/api/committee/applications/${memberId}/status`);
  expect(approvedStatusRes?.status).toBe(200);
  expect(approvedStatusRes?.body).toEqual({
    memberId,
    status: "active",
    claimable: true,
    claimed: false,
  });
  expect(Object.keys(approvedStatusRes!.body as object).sort()).toEqual(["claimable", "claimed", "memberId", "status"]);

  // 3. Claimed stage
  const challenge = await challengeFor(memberId);
  const claimSig = await signMessage(canonicalizeClaimChallenge(challenge), keypair.privateKey);
  const claimRes = await post(ROUTES.committee.claimToken, { ...challenge, signature: claimSig });
  expect(claimRes?.status).toBe(200);

  const claimedStatusRes = await get(`/api/committee/applications/${memberId}/status`);
  expect(claimedStatusRes?.status).toBe(200);
  expect(claimedStatusRes?.body).toEqual({
    memberId,
    status: "active",
    claimable: false,
    claimed: true,
  });
  expect(Object.keys(claimedStatusRes!.body as object).sort()).toEqual(["claimable", "claimed", "memberId", "status"]);

  // 4. Unknown member ID -> benign unknown shape (no 404 existence oracle, no PII)
  const unknownId = rid("nonexistent_member");
  const unknownStatusRes = await get(`/api/committee/applications/${unknownId}/status`);
  expect(unknownStatusRes?.status).toBe(200);
  expect(unknownStatusRes?.body).toEqual({
    memberId: unknownId,
    status: "unknown",
    claimable: false,
    claimed: false,
  });
  expect(Object.keys(unknownStatusRes!.body as object).sort()).toEqual(["claimable", "claimed", "memberId", "status"]);
});
