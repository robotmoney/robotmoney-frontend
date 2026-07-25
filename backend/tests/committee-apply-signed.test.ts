// Stage 1 (docs/plans/onboarding-ic-workflow.md Phase 1 / docs/architecture.md
// §11 R1-R6) — signed apply + the public applyStatus route. This is the
// setup-gated onboarding contract: an application can only complete if it
// carries an rmpc signature over the canonical application payload
// (@robotmoney/contract) that verifies against the submitted key. The server
// mints the member id; the client never supplies one. Runs the REAL ed25519
// verification path (no mocking the subject under test) against the ephemeral
// Postgres from tests/preload.ts.
import { beforeEach, expect, test } from "bun:test";
import { canonicalizeApplication, canonicalizeClaimChallenge, ROUTES } from "@robotmoney/contract";
import { handleCommittee } from "../src/api/routes/committee.ts";
import * as ic from "../src/committee/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

beforeEach(async () => {
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
});

async function post(path: string, body: unknown) {
  const req = new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleCommittee(req, new URL(req.url));
}

async function get(path: string) {
  const req = new Request(`http://test${path}`);
  return handleCommittee(req, new URL(req.url));
}

// Build a validly-signed apply request body the way an rmpc-equipped agent
// would: generate a keypair locally, sign the canonical application payload
// with it. Nothing here reaches into the server's verification internals —
// this is exactly what a real client sends over the wire.
async function buildSignedApply(fields: { name: string; contact: string; lens?: string }) {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const application = { name: fields.name, contact: fields.contact, lens: fields.lens, publicKey: publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), privateKey);
  return { publicKeyB64, privateKey, body: { ...fields, publicKey: publicKeyB64, signature } };
}

test("valid signed apply: 201 with a server-minted UUID, member applied, key inactive, application pending, audit row", async () => {
  const { publicKeyB64, body } = await buildSignedApply({ name: "Nova Desk", contact: `${rid("nova")}@example.test` });

  const res = await post(ROUTES.committee.apply, body);
  expect(res?.status).toBe(201);
  const resBody = res!.body as { ok: boolean; status: number; memberId: string; memberStatus: string };
  expect(resBody.ok).toBe(true);
  expect(resBody.memberStatus).toBe("applied");
  const memberId = resBody.memberId;
  // Server-minted UUID — NOT anything the client supplied (the request body
  // carried no id field at all).
  expect(memberId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  expect(body).not.toHaveProperty("memberId");

  const member = (await sql<{ status: string; name: string; contact_email: string }[]>`
    SELECT status, name, contact_email FROM committee_members WHERE id = ${memberId}`)[0];
  expect(member.status).toBe("applied");
  expect(member.name).toBe("Nova Desk");

  const key = (await sql<{ public_key: string; active: boolean; token_hash: string | null }[]>`
    SELECT public_key, active, token_hash FROM committee_member_keys WHERE member_id = ${memberId}`)[0];
  expect(key.public_key).toBe(publicKeyB64);
  expect(key.active).toBe(false);
  expect(key.token_hash).toBeNull();

  const application = (await sql<{ status: string }[]>`
    SELECT status FROM committee_applications WHERE member_id = ${memberId}`)[0];
  expect(application.status).toBe("pending");

  const audit = await sql<{ action: string; scope: unknown }[]>`
    SELECT action, scope FROM audit_log WHERE action = 'apply' AND scope->>'memberId' = ${memberId}`;
  expect(audit).toHaveLength(1);
});

test("invalid signature: 400, nothing recorded", async () => {
  const { publicKeyB64 } = await generateKeyPair();
  const bogusSignature = Buffer.alloc(64, 7).toString("base64");
  const res = await post(ROUTES.committee.apply, {
    name: "Ghost",
    contact: `${rid("ghost")}@example.test`,
    publicKey: publicKeyB64,
    signature: bogusSignature,
  });
  expect(res?.status).toBe(400);
  expect(await sql`SELECT id FROM committee_member_keys WHERE public_key = ${publicKeyB64}`).toHaveLength(0);
  // committee_applications has no FK to committee_members (so beforeEach's
  // TRUNCATE ... CASCADE doesn't touch it and other files/tests may have left
  // rows behind) — scope this check to the payload this test actually sent.
  expect(await sql`SELECT id FROM committee_applications WHERE payload->>'publicKey' = ${publicKeyB64}`).toHaveLength(0);
  expect(await sql`SELECT id FROM committee_members`).toHaveLength(0);
});

test("key/signature mismatch (signed by a DIFFERENT key than the one submitted): 400, nothing recorded", async () => {
  const submitted = await generateKeyPair();
  const other = await generateKeyPair();
  const application = { name: "Mismatch", contact: `${rid("mismatch")}@example.test`, publicKey: submitted.publicKeyB64 };
  // Sign with `other`'s private key but submit `submitted`'s public key.
  const wrongKeySignature = await signMessage(canonicalizeApplication(application), other.privateKey);
  const res = await post(ROUTES.committee.apply, { ...application, signature: wrongKeySignature });
  expect(res?.status).toBe(400);
  expect(await sql`SELECT id FROM committee_member_keys WHERE public_key = ${submitted.publicKeyB64}`).toHaveLength(0);
  expect(await sql`SELECT id FROM committee_members`).toHaveLength(0);
});

test("signature over the WRONG bytes (valid key/signature pair, wrong payload): 400, nothing recorded", async () => {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  // Sign a plausible-looking but different payload (e.g. a stale/edited name)
  // than the one actually submitted.
  const signedElsewhere = await signMessage(
    canonicalizeApplication({ name: "Original Name", contact: "x@example.test", publicKey: publicKeyB64 }),
    privateKey,
  );
  const res = await post(ROUTES.committee.apply, {
    name: "Tampered Name",
    contact: "x@example.test",
    publicKey: publicKeyB64,
    signature: signedElsewhere,
  });
  expect(res?.status).toBe(400);
  expect(await sql`SELECT id FROM committee_member_keys WHERE public_key = ${publicKeyB64}`).toHaveLength(0);
  expect(await sql`SELECT id FROM committee_members`).toHaveLength(0);
});

test("GET /api/committee/apply/:id: redacted 'applied' state, no contact/name/publicKey echoed, unknown id is an indistinguishable 404", async () => {
  const unknown = await get(`${ROUTES.committee.apply}/${crypto.randomUUID()}`);
  expect(unknown?.status).toBe(404);
  const unknownBody = unknown!.body as Record<string, unknown>;
  expect(unknownBody).not.toHaveProperty("contact");
  expect(unknownBody).not.toHaveProperty("name");

  const contact = `${rid("status")}@example.test`;
  const { publicKeyB64, body } = await buildSignedApply({ name: "Status Watcher", contact });
  const applyRes = await post(ROUTES.committee.apply, body);
  const memberId = (applyRes!.body as { memberId: string }).memberId;

  const applied = await get(`${ROUTES.committee.apply}/${memberId}`);
  expect(applied?.status).toBe(200);
  const appliedBody = applied!.body as { id: string; state: string };
  expect(appliedBody.id).toBe(memberId);
  expect(appliedBody.state).toBe("applied");
  expect(applied!.body).not.toHaveProperty("contact");
  expect(applied!.body).not.toHaveProperty("name");
  expect(applied!.body).not.toHaveProperty("publicKey");
  expect(JSON.stringify(applied!.body)).not.toContain(contact);
  expect(JSON.stringify(applied!.body)).not.toContain(publicKeyB64);

  // A trailing-segment path (id + "/") must not be misread as a shorter id —
  // still 404, not a crash or a partial match.
  const trailingSlash = await get(`${ROUTES.committee.apply}/${memberId}/`);
  expect(trailingSlash?.status).toBe(404);
});

test("full chain: signed apply -> admin/activate -> challenge -> claim -> token; status route reflects each step", async () => {
  const contact = `${rid("chain")}@example.test`;
  const { publicKeyB64, privateKey, body } = await buildSignedApply({ name: "Chain Walker", contact });

  const applyRes = await post(ROUTES.committee.apply, body);
  expect(applyRes?.status).toBe(201);
  const memberId = (applyRes!.body as { memberId: string }).memberId;

  expect((await get(`${ROUTES.committee.apply}/${memberId}`))?.body).toMatchObject({ id: memberId, state: "applied" });

  // admin/activate — UNCHANGED behavior: flips to active, does NOT mint a
  // token, still returns claimRequired:true.
  const activation = await ic.activateMember(memberId);
  expect(activation.status).toBe(200);
  expect(activation).not.toHaveProperty("token");
  expect((activation as { claimRequired: boolean }).claimRequired).toBe(true);

  expect((await get(`${ROUTES.committee.apply}/${memberId}`))?.body).toMatchObject({ id: memberId, state: "approved" });

  const challengeRes = await post(ROUTES.committee.claimChallenge, { memberId });
  expect(challengeRes?.status).toBe(200);
  const challenge = challengeRes!.body as ic.TokenClaimChallenge;

  const signature = await signMessage(canonicalizeClaimChallenge(challenge), privateKey);
  const claimRes = await post(ROUTES.committee.claimToken, { ...challenge, signature });
  expect(claimRes?.status).toBe(200);
  const token = (claimRes!.body as { token: string }).token;
  expect(token).toBeString();
  expect(await ic.memberIdForToken(token)).toBe(memberId);

  const finalStatus = await get(`${ROUTES.committee.apply}/${memberId}`);
  expect(finalStatus?.status).toBe(200);
  expect((finalStatus!.body as { state: string }).state).toBe("claimed");
  expect(finalStatus!.body).not.toHaveProperty("contact");
  expect(JSON.stringify(finalStatus!.body)).not.toContain(contact);
  expect(JSON.stringify(finalStatus!.body)).not.toContain(publicKeyB64);
});
