import { test, expect, beforeAll } from "bun:test";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { generateKeyPair } from "../src/lib/signing.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import {
  adminHeaders,
  bearerHeaders,
  provisionAnalyticsToken,
  provisionOperatorToken,
  provisionSchedulerToken,
  schedulerHeaders,
} from "./support/automation-auth.ts";

// Own database per file, cloned from the migrated template — the roster this
// file admits into is its own, with no reset of anyone else's rows.
useCleanDatabase(import.meta.file);

// The three store-issued service tokens (smoke spec §3, D52 (1)). There is no
// env ADMIN_TOKEN to set and no insecure mode to flip: the store row's right is
// the whole answer, in every env.
let operator = "";
let scheduler = "";
let analytics = "";
beforeAll(async () => {
  operator = await provisionOperatorToken();
  scheduler = await provisionSchedulerToken();
  analytics = await provisionAnalyticsToken();
});

const REG = "/api/swarm/register"; // privileged + non-destructive
// A REAL Ed25519 public key, not a 44-character filler string. Since issue #789
// this route applies the same decode gate as apply/manual-add/rotate-key, so a
// string that merely looks key-shaped is a 400 and would make every "403 vs
// 201" assertion below meaningless. These tests are about authorization, so the
// body has to be one the route would otherwise accept.
const { publicKeyB64: AUTHZ_PUBLIC_KEY } = await generateKeyPair();
function regReq(headers: Record<string, string> = {}) {
  const id = `az_${crypto.randomUUID().slice(0, 8)}`;
  return new Request(`http://x${REG}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ memberId: id, name: id, publicKey: AUTHZ_PUBLIC_KEY }),
  });
}
const call = (req: Request) => handleSwarm(req, new URL(req.url));

test("fail-closed: no token → 403", async () => {
  expect((await call(regReq()))?.status).toBe(403);
});

test("RM_ENV=ephemeral no longer opens privileged endpoints without a token (D52 (1))", async () => {
  // tests/preload.ts runs this process as RM_ENV=ephemeral — the env that used
  // to wave a tokenless caller through.
  expect(process.env.RM_ENV).toBe("ephemeral");
  expect((await call(regReq()))?.status).toBe(403);
});

test("the operator token: required, and sufficient; a wrong string is refused", async () => {
  expect((await call(regReq(adminHeaders(operator))))?.status).toBe(201);
  expect((await call(regReq(adminHeaders("s3cret"))))?.status).toBe(403);
});

test("neither the scheduler's nor the producer's token substitutes for the operator's", async () => {
  for (const token of [scheduler, analytics]) {
    for (const headers of [adminHeaders(token), bearerHeaders(token), schedulerHeaders(token)]) {
      expect((await call(regReq(headers)))?.status).toBe(403);
    }
  }
});
