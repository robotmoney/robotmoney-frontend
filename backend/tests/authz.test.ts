import { test, expect, afterEach } from "bun:test";
import { config } from "../src/config.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

// privileged() reads config at call time, so we flip config per test (restored after).
const orig = { adminToken: config.adminToken, allowInsecure: config.allowInsecure };
afterEach(() => { config.adminToken = orig.adminToken; config.allowInsecure = orig.allowInsecure; });

// Own database per file, cloned from the migrated template — the roster this
// file admits into is its own, with no reset of anyone else's rows.
useCleanDatabase(import.meta.file);

const REG = "/api/swarm/register"; // privileged + non-destructive
function regReq(headers: Record<string, string> = {}) {
  const id = `az_${crypto.randomUUID().slice(0, 8)}`;
  return new Request(`http://x${REG}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ memberId: id, name: id, publicKey: "A".repeat(44) }),
  });
}
const call = (req: Request) => handleSwarm(req, new URL(req.url));

test("fail-closed: no token and not insecure → 403", async () => {
  config.adminToken = null; config.allowInsecure = false;
  expect((await call(regReq()))?.status).toBe(403);
});

test("RM_ALLOW_INSECURE/ephemeral opens privileged endpoints without a token", async () => {
  config.adminToken = null; config.allowInsecure = true;
  expect((await call(regReq()))?.status).toBe(201);
});

test("admin token: required when set, and sufficient", async () => {
  config.adminToken = "s3cret"; config.allowInsecure = false;
  expect((await call(regReq()))?.status).toBe(403);
  expect((await call(regReq({ "X-Admin-Token": "s3cret" })))?.status).toBe(201);
  expect((await call(regReq({ "X-Admin-Token": "wrong" })))?.status).toBe(403);
});
