import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { canonicalizeApplication, canonicalizeClaimChallenge, SWARM_ROSTER_CAP, ROUTES } from "@robotmoney/contract";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import * as ic from "../src/swarm/domain.ts";
import {
  deliverSwarmNotification,
  type SwarmEmailMessage,
} from "../src/swarm/notifications.ts";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

async function post(path: string, body: Record<string, unknown>) {
  const request = new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSwarm(request, new URL(request.url));
}

async function get(path: string) {
  const request = new Request(`http://test${path}`);
  return handleSwarm(request, new URL(request.url));
}

async function applyAndActivate(prefix: string) {
  const label = rid(prefix);
  const keypair = await generateKeyPair();
  const application = { name: `Applicant ${label}`, contact: `${label}@example.test`, publicKey: keypair.publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), keypair.privateKey);
  const applied = await post(ROUTES.swarm.apply, { ...application, signature });
  expect(applied?.status).toBe(201);
  const memberId = (applied!.body as { memberId: string }).memberId;
  const activated = await ic.activateMember(memberId);
  expect(activated.status).toBe(200);
  expect(activated).not.toHaveProperty("token");
  return { memberId, name: application.name, contact: application.contact, ...keypair, activated };
}

async function challengeFor(memberId: string) {
  const response = await post(ROUTES.swarm.claimChallenge, { memberId });
  expect(response?.status).toBe(200);
  return response!.body as ic.TokenClaimChallenge;
}

// Own database per TEST, cloned from the migrated template. Per-test, not
// per-file: countActiveMembers() is global and SWARM_ROSTER_CAP is enforced on
// every transition-to-active, so members seated by one test would make the
// next test's admission a spurious 409. Unique ids cannot fix that; a clean
// database can.
useCleanDatabasePerTest(import.meta.file);

test("activation persists an email outbox and the executed fake transport delivers it", async () => {
  const applicant = await applyAndActivate("notify");
  expect((applicant.activated as any).notificationQueued).toBe(true);

  // Filtered by kind: applying also writes an 'application_received' row for
  // this same member, so an unfiltered read here would return two rows in
  // arbitrary order and pick the wrong one roughly half the time.
  const outbox = (await sql<{ id: string; sent_at: Date | null }[]>`
    SELECT id, sent_at FROM swarm_notification_outbox
    WHERE member_id = ${applicant.memberId} AND kind = 'activation_approved'`)[0];
  expect(outbox).toBeTruthy();
  expect(outbox.sent_at).toBeNull();
  const jobs = await sql`
    SELECT id FROM jobs
    WHERE kind = 'swarm.send_activation_notification'
      AND payload->>'outboxId' = ${outbox.id}`;
  expect(jobs).toHaveLength(1);

  const delivered: SwarmEmailMessage[] = [];
  const fakeTransport = { send: async (message: SwarmEmailMessage) => { delivered.push(message); } };
  expect(await deliverSwarmNotification(outbox.id, fakeTransport)).toEqual({ sent: true });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    from: "swarm-test@robotmoney.invalid",
    to: applicant.contact,
  });
  // The approval mail is read by an operator and by nobody else, so it is judged
  // on what a person can do with it. The name leads (nobody recognises a member
  // by UUID, and one operator may run several), the id survives only as a
  // reference line, and the raw claim endpoints are gone: the agent already holds
  // the id and the claim flow, and it never reads this inbox.
  expect(delivered[0].subject).toContain(applicant.name);
  expect(delivered[0].text).toContain(applicant.name);
  expect(delivered[0].text).not.toContain(ROUTES.swarm.claimChallenge);
  expect(delivered[0].text).not.toContain(ROUTES.swarm.claimToken);
  expect(delivered[0].text).toContain(applicant.memberId);
  // Four links, all built from the configured public origin, all real routes in
  // frontend/public/assets/js/app/routes.js. The swarm link carries its
  // paragraph break so the assertion cannot be satisfied by the /swarm prefix
  // of the two per-member URLs above.
  expect(delivered[0].text).toContain(`${config.swarmPublicBaseUrl}/swarm/members/${applicant.memberId}`);
  expect(delivered[0].text).toContain(`${config.swarmPublicBaseUrl}/swarm/apply/${applicant.memberId}`);
  expect(delivered[0].text).toContain(`${config.swarmPublicBaseUrl}/swarm\n`);
  expect(delivered[0].text).toContain(`${config.swarmPublicBaseUrl}/docs/investment-swarm/how-it-works`);
  expect(await deliverSwarmNotification(outbox.id, fakeTransport)).toEqual({ sent: false, idempotent: true });
  expect(delivered).toHaveLength(1);
});

// The status page URL reaches an operator exactly once, printed by their own
// agent into a chat transcript, and nothing on the site links to it. This email
// is the only durable copy, so its existence and its contents are both load
// bearing, and so is the re-send on the recovery path.
test("applying persists an application-received email carrying the status page URL", async () => {
  const label = rid("receipt");
  const keypair = await generateKeyPair();
  const application = { name: `Applicant ${label}`, contact: `${label}@example.test`, publicKey: keypair.publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), keypair.privateKey);
  const applied = await post(ROUTES.swarm.apply, { ...application, signature });
  expect(applied?.status).toBe(201);
  const memberId = (applied!.body as { memberId: string }).memberId;

  const outbox = (await sql<{ id: string; to_email: string; sent_at: Date | null }[]>`
    SELECT id, to_email, sent_at FROM swarm_notification_outbox
    WHERE member_id = ${memberId} AND kind = 'application_received'`)[0];
  expect(outbox).toBeTruthy();
  expect(outbox.to_email).toBe(application.contact);
  // Queued, not sent: the outbox write is complete at commit and owes nothing to
  // a reachable transport.
  expect(outbox.sent_at).toBeNull();
  expect(await sql`
    SELECT id FROM jobs
    WHERE kind = 'swarm.send_application_received_notification'
      AND payload->>'outboxId' = ${outbox.id}`).toHaveLength(1);

  const delivered: SwarmEmailMessage[] = [];
  const fakeTransport = { send: async (message: SwarmEmailMessage) => { delivered.push(message); } };
  expect(await deliverSwarmNotification(outbox.id, fakeTransport)).toEqual({ sent: true });
  expect(delivered[0].to).toBe(application.contact);
  expect(delivered[0].text).toContain(`${config.swarmPublicBaseUrl}/swarm/apply/${memberId}`);
  // Same name-first rule as the approval mail: two receipts separated only by
  // UUID are two indistinguishable emails to the operator holding both.
  expect(delivered[0].subject).toContain(application.name);
  expect(delivered[0].text).toContain(application.name);

  // Re-applying with the same key is the operator recovering a lost id, so it
  // re-arms the one permitted row (UNIQUE (kind, member_id)) and enqueues a
  // fresh job under a new send generation rather than silently no-oping.
  const reapplied = await post(ROUTES.swarm.apply, { ...application, signature });
  expect(reapplied?.status).toBe(201);
  expect((reapplied!.body as { memberId: string }).memberId).toBe(memberId);
  const rearmed = await sql<{ id: string; sent_at: Date | null }[]>`
    SELECT id, sent_at FROM swarm_notification_outbox
    WHERE member_id = ${memberId} AND kind = 'application_received'`;
  expect(rearmed).toHaveLength(1);
  expect(rearmed[0].id).toBe(outbox.id);
  expect(rearmed[0].sent_at).toBeNull();
  expect((await sql`
    SELECT id FROM jobs
    WHERE kind = 'swarm.send_application_received_notification'
      AND payload->>'outboxId' = ${outbox.id}`).length).toBeGreaterThan(1);
  expect(await deliverSwarmNotification(outbox.id, fakeTransport)).toEqual({ sent: true });
  expect(delivered).toHaveLength(2);
});

test("challenge issuance is indistinguishable and keeps one live 10-minute challenge per active member", async () => {
  const applicant = await applyAndActivate("challenge");
  const knownFirst = await challengeFor(applicant.memberId);
  const unknown = await challengeFor(rid("unknown"));
  expect(Object.keys(unknown).sort()).toEqual(Object.keys(knownFirst).sort());
  expect(new Date(unknown.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
  expect(await sql`SELECT member_id FROM swarm_claim_challenges WHERE member_id = ${unknown.memberId}`).toHaveLength(0);

  const knownSecond = await challengeFor(applicant.memberId);
  expect(knownSecond.challenge).not.toBe(knownFirst.challenge);
  const persisted = await sql<{ challenge: string; consumed_at: Date | null }[]>`
    SELECT challenge, consumed_at FROM swarm_claim_challenges WHERE member_id = ${applicant.memberId}`;
  expect(persisted).toHaveLength(1);
  expect(persisted[0].challenge).toBe(knownSecond.challenge);
  expect(persisted[0].consumed_at).toBeNull();

  const staleSignature = await signMessage(canonicalizeClaimChallenge(knownFirst), applicant.privateKey);
  const stale = await post(ROUTES.swarm.claimToken, { ...knownFirst, signature: staleSignature });
  expect(stale?.status).toBe(400);
});

test("first valid key proof mints the sole token; wrong/tampered/expired proofs do not and retry is 409", async () => {
  const applicant = await applyAndActivate("claim");
  const challenge = await challengeFor(applicant.memberId);
  const wrongKey = await generateKeyPair();
  const wrongSignature = await signMessage(canonicalizeClaimChallenge(challenge), wrongKey.privateKey);
  expect((await post(ROUTES.swarm.claimToken, { ...challenge, signature: wrongSignature }))?.status).toBe(400);

  const validSignature = await signMessage(canonicalizeClaimChallenge(challenge), applicant.privateKey);
  expect((await post(ROUTES.swarm.claimToken, {
    ...challenge,
    challenge: `${challenge.challenge}tampered`,
    signature: validSignature,
  }))?.status).toBe(400);
  expect((await sql<{ token_hash: string | null }[]>`
    SELECT token_hash FROM swarm_member_keys WHERE member_id = ${applicant.memberId} AND active`)[0].token_hash).toBeNull();

  const concurrent = await Promise.all([
    post(ROUTES.swarm.claimToken, { ...challenge, signature: validSignature }),
    post(ROUTES.swarm.claimToken, { ...challenge, signature: validSignature }),
  ]);
  expect(concurrent.map((response) => response?.status).sort()).toEqual([200, 409]);
  const claimed = concurrent.find((response) => response?.status === 200);
  const token = (claimed?.body as { token: string }).token;
  expect(await ic.memberIdForToken(token)).toBe(applicant.memberId);
  expect((await sql`SELECT id FROM swarm_member_keys WHERE member_id = ${applicant.memberId} AND active AND token_hash IS NOT NULL`)).toHaveLength(1);
  expect((await sql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM swarm_claim_challenges WHERE member_id = ${applicant.memberId}`)[0].consumed_at).not.toBeNull();

  const retry = await post(ROUTES.swarm.claimToken, { ...challenge, signature: validSignature });
  expect(retry?.status).toBe(409);
  expect((retry?.body as { error: string }).error).toContain("already claimed");
  expect((await sql`SELECT id FROM swarm_member_keys WHERE member_id = ${applicant.memberId} AND active AND token_hash IS NOT NULL`)).toHaveLength(1);
  const throwawayAfterClaim = await challengeFor(applicant.memberId);
  expect(throwawayAfterClaim.challenge).not.toBe(challenge.challenge);
  const retainedConsumed = (await sql<{ challenge: string; consumed_at: Date | null }[]>`
    SELECT challenge, consumed_at FROM swarm_claim_challenges WHERE member_id = ${applicant.memberId}`)[0];
  expect(retainedConsumed.challenge).toBe(challenge.challenge);
  expect(retainedConsumed.consumed_at).not.toBeNull();

  const expiredApplicant = await applyAndActivate("expired");
  const expired = await challengeFor(expiredApplicant.memberId);
  await sql`
    UPDATE swarm_claim_challenges
    SET issued_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
    WHERE member_id = ${expiredApplicant.memberId}`;
  const expiredSignature = await signMessage(canonicalizeClaimChallenge(expired), expiredApplicant.privateKey);
  expect((await post(ROUTES.swarm.claimToken, { ...expired, signature: expiredSignature }))?.status).toBe(400);
  expect((await sql<{ token_hash: string | null }[]>`
    SELECT token_hash FROM swarm_member_keys WHERE member_id = ${expiredApplicant.memberId} AND active`)[0].token_hash).toBeNull();
});

test("claim never bypasses the imported swarm roster cap", async () => {
  for (let i = 0; i < SWARM_ROSTER_CAP; i++) {
    const publicKey = (await generateKeyPair()).publicKeyB64;
    const admitted = await ic.registerMember({ memberId: `claim_cap_${i}`, name: `Cap ${i}`, publicKey });
    expect("token" in admitted).toBe(true);
  }
  expect(await ic.countActiveMembers()).toBe(SWARM_ROSTER_CAP);

  const keypair = await generateKeyPair();
  const application = { name: "Over cap", contact: "over-cap@example.test", publicKey: keypair.publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), keypair.privateKey);
  const applied = await post(ROUTES.swarm.apply, { ...application, signature });
  expect(applied?.status).toBe(201);
  const memberId = (applied!.body as { memberId: string }).memberId;
  expect((await ic.activateMember(memberId)).status).toBe(409);
  expect(await ic.countActiveMembers()).toBe(SWARM_ROSTER_CAP);

  await challengeFor(memberId);
  expect(await sql`SELECT member_id FROM swarm_claim_challenges WHERE member_id = ${memberId}`).toHaveLength(0);
  const status = (await sql<{ status: string }[]>`SELECT status FROM swarm_members WHERE id = ${memberId}`)[0].status;
  expect(status).toBe("applied");
});

// 0019's own DDL creates committee_claim_challenges/committee_notification_outbox
// (immutable historical filenames and table names — issue #263's #0025 rename
// only touches the LIVE schema, never 0019's own file). The shared suite
// database (tests/preload.ts) has 0025 applied, so committee_members no
// longer exists there and replaying 0019 against it would fail on the FK
// reference. This test provisions its OWN throwaway database on the same
// Postgres instance, migrated only through 0019, to genuinely re-test 0019's
// idempotency against the schema shape it was actually written for.
test("0019 migration is idempotent when executed repeatedly against real Postgres", async () => {
  const base = new URL(config.databaseUrl);
  const dbName = `tmp_0019_idem_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const tmpUrl = new URL(base.toString());
  tmpUrl.pathname = `/${dbName}`;
  const db = postgres(tmpUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const upTo0019 = files.filter((f) => f <= "0019_committee_self_serve_claim.sql");
    expect(upTo0019.length).toBeGreaterThan(0);
    for (const file of upTo0019) {
      const migrationDdl = await readFile(join(migrationsDir, file), "utf8");
      await db.begin(async (tx) => { await tx.unsafe(migrationDdl); });
    }

    const ddl = await readFile(join(migrationsDir, "0019_committee_self_serve_claim.sql"), "utf8");
    await db.unsafe(ddl);
    await db.unsafe(ddl);
    const tables = await db<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('committee_claim_challenges', 'committee_notification_outbox')
      ORDER BY table_name`;
    expect(tables.map((row) => row.table_name)).toEqual([
      "committee_claim_challenges",
      "committee_notification_outbox",
    ]);
  } finally {
    await db.end();
    const cleanup = postgres(base.toString(), { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await cleanup.end();
  }
});

test("GET /api/swarm/applications/:memberId/status returns privacy-safe fields across onboarding lifecycle without PII", async () => {
  const secretContact = "secret_agent_007@example.test";
  const agentName = "Secret Agent Desk";
  const keypair = await generateKeyPair();
  const application = { name: agentName, contact: secretContact, lens: "macro", publicKey: keypair.publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), keypair.privateKey);

  const appliedRes = await post(ROUTES.swarm.apply, { ...application, signature });
  expect(appliedRes?.status).toBe(201);
  const memberId = (appliedRes!.body as { memberId: string }).memberId;

  // 1. Pending stage
  const pendingStatusRes = await get(`/api/swarm/applications/${memberId}/status`);
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

  const approvedStatusRes = await get(`/api/swarm/applications/${memberId}/status`);
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
  const claimRes = await post(ROUTES.swarm.claimToken, { ...challenge, signature: claimSig });
  expect(claimRes?.status).toBe(200);

  const claimedStatusRes = await get(`/api/swarm/applications/${memberId}/status`);
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
  const unknownStatusRes = await get(`/api/swarm/applications/${unknownId}/status`);
  expect(unknownStatusRes?.status).toBe(200);
  expect(unknownStatusRes?.body).toEqual({
    memberId: unknownId,
    status: "unknown",
    claimable: false,
    claimed: false,
  });
  expect(Object.keys(unknownStatusRes!.body as object).sort()).toEqual(["claimable", "claimed", "memberId", "status"]);
});
