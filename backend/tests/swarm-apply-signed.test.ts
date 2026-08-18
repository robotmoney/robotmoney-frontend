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
import { handleSwarm } from "../src/api/routes/swarm.ts";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// Own database per TEST, cloned from the migrated template. Per-test, not
// per-file: countActiveMembers() is global and SWARM_ROSTER_CAP is enforced on
// every transition-to-active, so members seated by one test would make the
// next test's admission a spurious 409. Unique ids cannot fix that; a clean
// database can.
useCleanDatabasePerTest(import.meta.file);

async function post(path: string, body: unknown) {
  const req = new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSwarm(req, new URL(req.url));
}

async function get(path: string) {
  const req = new Request(`http://test${path}`);
  return handleSwarm(req, new URL(req.url));
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

  const res = await post(ROUTES.swarm.apply, body);
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
    SELECT status, name, contact_email FROM swarm_members WHERE id = ${memberId}`)[0];
  expect(member.status).toBe("applied");
  expect(member.name).toBe("Nova Desk");

  const key = (await sql<{ public_key: string; active: boolean; token_hash: string | null }[]>`
    SELECT public_key, active, token_hash FROM swarm_member_keys WHERE member_id = ${memberId}`)[0];
  expect(key.public_key).toBe(publicKeyB64);
  expect(key.active).toBe(false);
  expect(key.token_hash).toBeNull();

  const application = (await sql<{ status: string }[]>`
    SELECT status FROM swarm_applications WHERE member_id = ${memberId}`)[0];
  expect(application.status).toBe("pending");

  const audit = await sql<{ action: string; scope: unknown }[]>`
    SELECT action, scope FROM audit_log WHERE action = 'apply' AND scope->>'memberId' = ${memberId}`;
  expect(audit).toHaveLength(1);
});

test("invalid signature: 400, nothing recorded", async () => {
  const { publicKeyB64 } = await generateKeyPair();
  const bogusSignature = Buffer.alloc(64, 7).toString("base64");
  const res = await post(ROUTES.swarm.apply, {
    name: "Ghost",
    contact: `${rid("ghost")}@example.test`,
    publicKey: publicKeyB64,
    signature: bogusSignature,
  });
  expect(res?.status).toBe(400);
  expect(await sql`SELECT id FROM swarm_member_keys WHERE public_key = ${publicKeyB64}`).toHaveLength(0);
  // swarm_applications has no FK to swarm_members (so beforeEach's
  // TRUNCATE ... CASCADE doesn't touch it and other files/tests may have left
  // rows behind) — scope this check to the payload this test actually sent.
  expect(await sql`SELECT id FROM swarm_applications WHERE payload->>'publicKey' = ${publicKeyB64}`).toHaveLength(0);
  expect(await sql`SELECT id FROM swarm_members`).toHaveLength(0);
});

test("key/signature mismatch (signed by a DIFFERENT key than the one submitted): 400, nothing recorded", async () => {
  const submitted = await generateKeyPair();
  const other = await generateKeyPair();
  const application = { name: "Mismatch", contact: `${rid("mismatch")}@example.test`, publicKey: submitted.publicKeyB64 };
  // Sign with `other`'s private key but submit `submitted`'s public key.
  const wrongKeySignature = await signMessage(canonicalizeApplication(application), other.privateKey);
  const res = await post(ROUTES.swarm.apply, { ...application, signature: wrongKeySignature });
  expect(res?.status).toBe(400);
  expect(await sql`SELECT id FROM swarm_member_keys WHERE public_key = ${submitted.publicKeyB64}`).toHaveLength(0);
  expect(await sql`SELECT id FROM swarm_members`).toHaveLength(0);
});

test("signature over the WRONG bytes (valid key/signature pair, wrong payload): 400, nothing recorded", async () => {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  // Sign a plausible-looking but different payload (e.g. a stale/edited name)
  // than the one actually submitted.
  const signedElsewhere = await signMessage(
    canonicalizeApplication({ name: "Original Name", contact: "x@example.test", publicKey: publicKeyB64 }),
    privateKey,
  );
  const res = await post(ROUTES.swarm.apply, {
    name: "Tampered Name",
    contact: "x@example.test",
    publicKey: publicKeyB64,
    signature: signedElsewhere,
  });
  expect(res?.status).toBe(400);
  expect(await sql`SELECT id FROM swarm_member_keys WHERE public_key = ${publicKeyB64}`).toHaveLength(0);
  expect(await sql`SELECT id FROM swarm_members`).toHaveLength(0);
});

test("a malformed application is answered with what a VALID one looks like, including the exact bytes the signature must cover", async () => {
  // The first response any unfamiliar client gets. Measured live in the §11 R8
  // eval: every real member-agent probes this endpoint with `{}` before it
  // builds anything, and the bare "…required" it used to get sent them off to
  // clone repos looking for the key order. An API whose documented audience is
  // a program that has never seen our source has to answer that question here.
  const res = await post(ROUTES.swarm.apply, {});
  expect(res?.status).toBe(400);
  const body = res!.body as Record<string, any>;
  expect(body.error).toContain("required");
  expect(Object.keys(body.expects).sort()).toEqual(["contact", "lens", "name", "publicKey", "signature"]);
  // The statement must actually describe canonicalizeApplication's contract:
  // fixed key order, optional lens omitted, no whitespace.
  expect(body.signatureCovers).toContain("{name, contact, lens?, publicKey}");
  expect(body.signatureCovers).toMatch(/EXACTLY that order/);
  expect(body.signatureCovers).toMatch(/omitted entirely when absent/);
  expect(body.signatureCovers).toMatch(/no whitespace/);
  // …and be TRUE of the real canonicalizer, not just plausible prose.
  const sample = { name: "N", contact: "c@example.test", publicKey: "PK" };
  expect(canonicalizeApplication(sample)).toBe('{"name":"N","contact":"c@example.test","publicKey":"PK"}');
  expect(canonicalizeApplication({ ...sample, lens: "L" })).toBe('{"name":"N","contact":"c@example.test","lens":"L","publicKey":"PK"}');
  expect(await sql`SELECT id FROM swarm_members`).toHaveLength(0);
});

test("a rejected signature names the EXACT canonical bytes it should have covered — and leaks nothing the caller did not send", async () => {
  // §11.3 E7 / R6: setup-gated apply is only fair if a correct setup can learn
  // WHY it was rejected. The canonicalizer lives in a private repo and the
  // participation guide renders client-side, so this 400 is the only reachable
  // statement of the byte layout for a headless applicant — measured live,
  // a real member-agent with a working key and a working `rmpc` spent minutes
  // brute-forcing key order against the bare message this replaced.
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const fields = { name: "Byte Order Desk", contact: `${rid("bytes")}@example.test`, lens: "macro" };
  // Signed over the same FIELDS in a different key order — the exact mistake.
  const wrongOrder = JSON.stringify({ contact: fields.contact, name: fields.name, lens: fields.lens, publicKey: publicKeyB64 });
  const res = await post(ROUTES.swarm.apply, {
    ...fields,
    publicKey: publicKeyB64,
    signature: await signMessage(wrongOrder, privateKey),
  });
  expect(res?.status).toBe(400);
  const body = res!.body as Record<string, unknown>;
  expect(body.expectedPayload).toBe(canonicalizeApplication({ ...fields, publicKey: publicKeyB64 }));
  // It is the canonical form, not an echo of what was signed.
  expect(body.expectedPayload).not.toBe(wrongOrder);
  // Nothing beyond the caller's own submitted fields: no signature, no key
  // material, no server state.
  const echoed = JSON.parse(body.expectedPayload as string);
  expect(Object.keys(echoed).sort()).toEqual(["contact", "lens", "name", "publicKey"]);
  expect(JSON.stringify(body)).not.toContain(await signMessage(wrongOrder, privateKey));
  // Still fully rejected: nothing recorded (R6).
  expect(await sql`SELECT id FROM swarm_members`).toHaveLength(0);
});

test("GET /api/swarm/apply/:id: redacted 'applied' state, no contact/name/publicKey echoed, unknown id is an indistinguishable 404", async () => {
  const unknown = await get(`${ROUTES.swarm.apply}/${crypto.randomUUID()}`);
  expect(unknown?.status).toBe(404);
  const unknownBody = unknown!.body as Record<string, unknown>;
  expect(unknownBody).not.toHaveProperty("contact");
  expect(unknownBody).not.toHaveProperty("name");

  const contact = `${rid("status")}@example.test`;
  const { publicKeyB64, body } = await buildSignedApply({ name: "Status Watcher", contact });
  const applyRes = await post(ROUTES.swarm.apply, body);
  const memberId = (applyRes!.body as { memberId: string }).memberId;

  const applied = await get(`${ROUTES.swarm.apply}/${memberId}`);
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
  const trailingSlash = await get(`${ROUTES.swarm.apply}/${memberId}/`);
  expect(trailingSlash?.status).toBe(404);
});

test("full chain: signed apply -> admin/activate -> challenge -> claim -> token; status route reflects each step", async () => {
  const contact = `${rid("chain")}@example.test`;
  const { publicKeyB64, privateKey, body } = await buildSignedApply({ name: "Chain Walker", contact });

  const applyRes = await post(ROUTES.swarm.apply, body);
  expect(applyRes?.status).toBe(201);
  const memberId = (applyRes!.body as { memberId: string }).memberId;

  expect((await get(`${ROUTES.swarm.apply}/${memberId}`))?.body).toMatchObject({ id: memberId, state: "applied" });

  // admin/activate — UNCHANGED behavior: flips to active, does NOT mint a
  // token, still returns claimRequired:true.
  const activation = await ic.activateMember(memberId);
  expect(activation.status).toBe(200);
  expect(activation).not.toHaveProperty("token");
  expect((activation as { claimRequired: boolean }).claimRequired).toBe(true);

  expect((await get(`${ROUTES.swarm.apply}/${memberId}`))?.body).toMatchObject({ id: memberId, state: "approved" });

  const challengeRes = await post(ROUTES.swarm.claimChallenge, { memberId });
  expect(challengeRes?.status).toBe(200);
  const challenge = challengeRes!.body as ic.TokenClaimChallenge;

  const signature = await signMessage(canonicalizeClaimChallenge(challenge), privateKey);
  const claimRes = await post(ROUTES.swarm.claimToken, { ...challenge, signature });
  expect(claimRes?.status).toBe(200);
  const token = (claimRes!.body as { token: string }).token;
  expect(token).toBeString();
  expect(await ic.memberIdForToken(token)).toBe(memberId);

  const finalStatus = await get(`${ROUTES.swarm.apply}/${memberId}`);
  expect(finalStatus?.status).toBe(200);
  expect((finalStatus!.body as { state: string }).state).toBe("claimed");
  expect(finalStatus!.body).not.toHaveProperty("contact");
  expect(JSON.stringify(finalStatus!.body)).not.toContain(contact);
  expect(JSON.stringify(finalStatus!.body)).not.toContain(publicKeyB64);
});

// domain.ts::sendApplicationReceipt reads resolveSwarmNotificationEmailFrom()
// (config.ts) live at call time rather than the frozen `config` singleton
// specifically so this branch is reachable from a running test process: the
// suite's preload.ts sets SWARM_NOTIFICATION_EMAIL_FROM before any file
// ever imports config.ts, so a check against the frozen value could never
// observe "unset" here. Clearing the live env var around a single call and
// restoring it after is what actually exercises the skip path apply's own
// doc comment describes: an unconfigured sender must not fail the application,
// only its receipt email.
test("apply with SWARM_NOTIFICATION_EMAIL_FROM unset: still 201, the receipt is skipped rather than thrown", async () => {
  const original = process.env.SWARM_NOTIFICATION_EMAIL_FROM;
  delete process.env.SWARM_NOTIFICATION_EMAIL_FROM;
  try {
    const { body } = await buildSignedApply({ name: "No Sender Desk", contact: `${rid("nosender")}@example.test` });
    const res = await post(ROUTES.swarm.apply, body);
    expect(res?.status).toBe(201);
    const memberId = (res!.body as { memberId: string }).memberId;

    // The application itself is fully recorded — only the receipt email is
    // skipped, per the AC ("applying still succeeds — the receipt is
    // skipped, not thrown").
    const member = (await sql<{ status: string }[]>`
      SELECT status FROM swarm_members WHERE id = ${memberId}`)[0];
    expect(member.status).toBe("applied");

    const outbox = await sql`
      SELECT id FROM swarm_notification_outbox
      WHERE member_id = ${memberId} AND kind = 'application_received'`;
    expect(outbox).toHaveLength(0);
  } finally {
    if (original === undefined) delete process.env.SWARM_NOTIFICATION_EMAIL_FROM;
    else process.env.SWARM_NOTIFICATION_EMAIL_FROM = original;
  }
});
