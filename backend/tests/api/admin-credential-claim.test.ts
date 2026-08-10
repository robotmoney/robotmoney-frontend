// One-time admin credential claim (issue #553 / D32) — full lifecycle against
// the REAL ephemeral Postgres (tests/preload.ts). If Docker/Postgres is absent
// the preload THROWS, so this file fails loudly rather than silently skipping
// (test-coverage policy).
//
// Design under test (strict setup-token revocation — issue #584):
//  • unclaimed: the per-boot ADMIN_TOKEN env credential (or allowInsecure)
//    authorizes exactly as before;
//  • claim: the token holder persists a password — stored ONLY as sha256 hex;
//  • claimed: the stored hash is the durable operator credential and survives
//    any restart (a restart = a NEW random adminToken in cfg); every setup
//    ADMIN_TOKEN is revoked, and allowInsecure no longer opens the gate;
//  • the claim is one-time: a second claim is 409 until an operator deletes
//    the row.
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "../../src/db/client.ts";
import { handleAdmin, type AdminAuthConfig } from "../../src/api/routes/admin.ts";

const CFG: AdminAuthConfig = { adminToken: "s3cret-admin-token", allowInsecure: false };
const PASSWORD = "operator-chosen-password"; // ≥ 12 chars

const call = (req: Request, cfg: AdminAuthConfig = CFG) => handleAdmin(req, new URL(req.url), cfg);
const authReq = (token?: string | null) =>
  new Request("http://localhost/api/admin/auth", {
    method: "POST",
    headers: token ? { "X-Admin-Token": token } : {},
  });
const claimReq = (password: unknown, token?: string | null) =>
  new Request("http://localhost/api/admin/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Admin-Token": token } : {}) },
    body: JSON.stringify({ password }),
  });
const isClaimedReq = () => new Request("http://localhost/api/admin/is-claimed", { method: "GET" });

describe("admin credential claim lifecycle (issue #553 / D32)", () => {
  beforeEach(async () => {
    await sql`DELETE FROM admin_credential`;
    await sql`DELETE FROM audit_log WHERE action = 'claim_admin_credential'`;
  });

  afterAll(async () => {
    await sql`DELETE FROM admin_credential`;
    await sql`DELETE FROM audit_log WHERE action = 'claim_admin_credential'`;
  });

  test("full lifecycle: unclaimed setup token → claim → durable credential survives restart", async () => {
    // Unclaimed: probe says so, and the env token authorizes (pre-claim behaviour).
    expect(await call(isClaimedReq())).toEqual({ status: 200, body: { claimed: false } });
    expect((await call(authReq(CFG.adminToken)))?.status).toBe(200);
    expect((await call(authReq("wrong")))?.status).toBe(403);

    // Claim with the current credential. The response echoes NOTHING secret.
    const claimed = await call(claimReq(PASSWORD, CFG.adminToken));
    expect(claimed).toEqual({ status: 200, body: { ok: true } });

    // Probe flips; boolean only — no hash, no secret in the body.
    const probe = await call(isClaimedReq());
    expect(probe).toEqual({ status: 200, body: { claimed: true } });

    // Storage holds ONLY the sha256 hex of the password — never the plaintext.
    const rows = await sql<{ pass_hash: string }[]>`SELECT pass_hash FROM admin_credential WHERE id = 1`;
    expect(rows.length).toBe(1);
    expect(rows[0].pass_hash).toBe(createHash("sha256").update(PASSWORD).digest("hex"));
    expect(rows[0].pass_hash).not.toContain(PASSWORD);

    // The claimed credential authenticates.
    expect((await call(authReq(PASSWORD)))?.status).toBe(200);

    // A claim revokes the one-time setup token. Stack automation has a distinct
    // AUTOMATION_TOKEN and cannot use the human login endpoint as a substitute.
    expect((await call(authReq(CFG.adminToken)))?.status).toBe(403);

    // Simulated restart: a fresh boot mints an unrelated random token. The
    // claimed credential MUST keep working (the lockout this issue fixes)…
    const restarted = { adminToken: "brand-new-boot-token-123", allowInsecure: false };
    expect((await call(authReq(PASSWORD), restarted))?.status).toBe(200);
    // No future setup token can authenticate a claimed human-admin surface.
    expect((await call(authReq(restarted.adminToken), restarted))?.status).toBe(403);
    // The previous boot's token remains revoked too.
    expect((await call(authReq(CFG.adminToken), restarted))?.status).toBe(403);
  });

  test("claiming requires the current admin credential", async () => {
    expect(await call(claimReq(PASSWORD))).toEqual({
      status: 403,
      body: { error: "admin authorization required" },
    });
    expect(await call(isClaimedReq())).toEqual({ status: 200, body: { claimed: false } });
  });

  test("claim is one-time: a second claim is 409 and does not overwrite the hash", async () => {
    expect((await call(claimReq(PASSWORD, CFG.adminToken)))?.status).toBe(200);
    const again = await call(claimReq("some-other-password", PASSWORD));
    expect(again).toEqual({ status: 409, body: { error: "admin credential already claimed" } });
    // Original claimed credential still the one that authenticates.
    expect((await call(authReq(PASSWORD)))?.status).toBe(200);
    expect((await call(authReq("some-other-password")))?.status).toBe(403);
  });

  test("a short or missing password is rejected before any write", async () => {
    for (const bad of ["", "short", "elevenchars", 42, null]) {
      const res = await call(claimReq(bad, CFG.adminToken));
      expect(res).toEqual({ status: 400, body: { error: "password must be at least 12 characters" } });
    }
    expect(await call(isClaimedReq())).toEqual({ status: 200, body: { claimed: false } });
  });

  test("allowInsecure no longer opens the admin gate once claimed", async () => {
    const insecure = { adminToken: null, allowInsecure: true };
    // Pre-claim: insecure mode opens the gate (historical behaviour).
    expect((await call(authReq(), insecure))?.status).toBe(200);
    expect((await call(claimReq(PASSWORD, CFG.adminToken)))?.status).toBe(200);
    // Post-claim: a claim is an explicit security opt-in — insecure mode is out.
    expect((await call(authReq(), insecure))?.status).toBe(403);
    expect((await call(authReq(PASSWORD), insecure))?.status).toBe(200);
  });

  test("the plaintext password never reaches logs, response bodies, or the audit trail", async () => {
    // Capture EVERYTHING the process would log during the claim.
    const logged: string[] = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => { logged.push(args.map((a) => String(a)).join(" ")); };
    console.log = capture; console.info = capture; console.warn = capture; console.error = capture;
    let claimBody: unknown, probeBody: unknown, authBody: unknown;
    try {
      claimBody = (await call(claimReq(PASSWORD, CFG.adminToken)))?.body;
      probeBody = (await call(isClaimedReq()))?.body;
      authBody = (await call(authReq(PASSWORD)))?.body;
    } finally {
      console.log = orig.log; console.info = orig.info; console.warn = orig.warn; console.error = orig.error;
    }
    expect(logged.join("\n")).not.toContain(PASSWORD);
    for (const body of [claimBody, probeBody, authBody]) {
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    }

    // The lifecycle event IS audited — without any secret material.
    const audit = await sql<{ actor: string; action: string; scope: unknown }[]>`
      SELECT actor, action, scope FROM audit_log WHERE action = 'claim_admin_credential'`;
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0])).not.toContain(PASSWORD);
  });
});
