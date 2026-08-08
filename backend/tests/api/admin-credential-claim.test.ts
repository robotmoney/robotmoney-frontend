import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { sql, jsonValue } from "../../src/db/client.ts";
import { handleAdmin } from "../../src/api/routes/admin.ts";

const CFG = { adminToken: "s3cret-admin-token", allowInsecure: false };

describe("admin credential claim lifecycle", () => {
  beforeEach(async () => {
    await sql`DELETE FROM admin_credential`;
  });

  afterAll(async () => {
    // leave it clean
    await sql`DELETE FROM admin_credential`;
  });

  test("can claim credential if unclaimed and authenticated", async () => {
    // Not claimed yet
    const req1 = new Request("http://localhost/api/admin/is-claimed", { method: "GET" });
    const res1 = await handleAdmin(req1, new URL(req1.url), CFG);
    expect(res1?.status).toBe(200);
    expect(res1?.body).toEqual({ claimed: false });

    // Claim it (needs auth)
    const req2 = new Request("http://localhost/api/admin/claim", {
      method: "POST",
      headers: { "X-Admin-Token": "s3cret-admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ password: "new-secret-password" })
    });
    const res2 = await handleAdmin(req2, new URL(req2.url), CFG);
    expect(res2?.status).toBe(200);
    expect(res2?.body).toEqual({ ok: true });

    // Now it's claimed
    const req3 = new Request("http://localhost/api/admin/is-claimed", { method: "GET" });
    const res3 = await handleAdmin(req3, new URL(req3.url), CFG);
    expect(res3?.status).toBe(200);
    expect(res3?.body).toEqual({ claimed: true });

    // The plaintext password should NOT be stored
    const dbRows = await sql`SELECT pass_hash FROM admin_credential WHERE id = 1`;
    expect(dbRows[0].pass_hash).not.toContain("new-secret-password");

    // The old unclaimed token stops working post-claim
    const req4 = new Request("http://localhost/api/admin/auth", {
      method: "POST",
      headers: { "X-Admin-Token": "s3cret-admin-token" }
    });
    const res4 = await handleAdmin(req4, new URL(req4.url), CFG);
    expect(res4?.status).toBe(403);

    // The claimed credential works
    const req5 = new Request("http://localhost/api/admin/auth", {
      method: "POST",
      headers: { "X-Admin-Token": "new-secret-password" }
    });
    const res5 = await handleAdmin(req5, new URL(req5.url), CFG);
    expect(res5?.status).toBe(200);

    // Simulated process/stack restart (new generated adminToken in CFG)
    const restartedCfg = { adminToken: "another-random-token", allowInsecure: false };
    
    // The claimed credential still works despite restart
    const req6 = new Request("http://localhost/api/admin/auth", {
      method: "POST",
      headers: { "X-Admin-Token": "new-secret-password" }
    });
    const res6 = await handleAdmin(req6, new URL(req6.url), restartedCfg);
    expect(res6?.status).toBe(200);

    // The new randomly generated token does NOT work, because claimed credential overrides
    const req7 = new Request("http://localhost/api/admin/auth", {
      method: "POST",
      headers: { "X-Admin-Token": "another-random-token" }
    });
    const res7 = await handleAdmin(req7, new URL(req7.url), restartedCfg);
    expect(res7?.status).toBe(403);
  });

  test("cannot claim if unauthenticated", async () => {
    const req = new Request("http://localhost/api/admin/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "new-secret-password" })
    });
    const res = await handleAdmin(req, new URL(req.url), CFG);
    expect(res).toEqual({ status: 403, body: { error: "admin authorization required" } });
  });
});
