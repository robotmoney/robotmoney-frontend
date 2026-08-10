// Credential-role boundary for the admin-auth revamp (issue #584). This file
// uses the real ephemeral Postgres from tests/preload.ts: Docker/Postgres
// absence fails this command loudly, so the claimed-state branch cannot be
// mistaken for a silent green.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "../../src/db/client.ts";
import { hasAutomationRole, isPrivileged } from "../../src/api/auth.ts";
import { handleSwarmAdmin } from "../../src/api/routes/swarm-admin.ts";

const cfg = {
  adminToken: "one-time-human-setup-token",
  automationToken: "dedicated-stack-automation-token",
  allowInsecure: false,
} as const;

const request = (headers: Record<string, string>) => new Request("http://localhost/api/admin/auth", { headers });

describe("admin setup and automation credentials (issue #584)", () => {
  beforeEach(async () => {
    await sql`DELETE FROM admin_credential`;
  });

  afterAll(async () => {
    await sql`DELETE FROM admin_credential`;
  });

  test("isPrivileged revokes ADMIN_TOKEN once the admin credential is claimed", async () => {
    const setup = request({ "X-Admin-Token": cfg.adminToken });
    expect(await isPrivileged(setup, cfg)).toBe(true);

    const password = "durable-operator-password";
    await sql`
      INSERT INTO admin_credential (id, pass_hash)
      VALUES (1, ${createHash("sha256").update(password).digest("hex")})
    `;

    expect(await isPrivileged(setup, cfg)).toBe(false);
    expect(await isPrivileged(request({ "X-Admin-Token": password }), cfg)).toBe(true);
  });

  test("hasAutomationRole accepts only the dedicated AUTOMATION_TOKEN", () => {
    expect(hasAutomationRole(request({ "X-Automation-Token": cfg.automationToken }), cfg)).toBe(true);
    expect(hasAutomationRole(request({ "X-Automation-Token": cfg.adminToken }), cfg)).toBe(false);
    expect(hasAutomationRole(request({ Authorization: `Bearer ${cfg.automationToken}` }), cfg)).toBe(true);
  });

  test("the stack-internal swarm-admin driver authenticates with AUTOMATION_TOKEN", async () => {
    const autoRequest = new Request("http://localhost/api/swarm/admin/members", {
      headers: { "X-Automation-Token": cfg.automationToken },
    });
    const setupRequest = new Request("http://localhost/api/swarm/admin/members", {
      headers: { "X-Admin-Token": cfg.adminToken },
    });

    await sql`
      INSERT INTO admin_credential (id, pass_hash)
      VALUES (1, ${createHash("sha256").update("durable-operator-password").digest("hex")})
    `;

    expect((await handleSwarmAdmin(autoRequest, new URL(autoRequest.url), cfg))?.status).toBe(200);
    expect((await handleSwarmAdmin(setupRequest, new URL(setupRequest.url), cfg))?.status).toBe(403);
  });
});
