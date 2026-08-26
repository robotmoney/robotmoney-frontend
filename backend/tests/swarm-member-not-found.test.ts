// An unresolvable member reference is a deliberate 404, not a 200 with a null
// body (issue #687). `resolveMemberRow` (src/swarm/domain.ts) matches
// `handle = $ref OR id = $ref`; when neither matches, the route used to answer
// `200 {}`-shaped null, which is indistinguishable from "the member exists and
// has no fields" and tells a crawler with the old slug indexed that the page
// is fine — the exact mistake #603 made. The frontend's memberProfile.init()
// (frontend/public/assets/js/app/alpine/static-views.js) relies on this status:
// only once BOTH the live API and the static-archive fallback (#595's
// precedence) have missed does it render the committee roster in place of a
// blank profile.
//
// Shares the one ephemeral Postgres every other swarm test file uses
// (tests/preload.ts). A missing Docker/Postgres fails that preload loudly.
import { test, expect } from "bun:test";
import { ROUTES, path as routePath } from "@robotmoney/contract";
import * as ic from "../src/swarm/domain.ts";
import { generateKeyPair } from "../src/lib/signing.ts";
import { sql } from "../src/db/client.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

const getMemberRoute = (ref: string) => {
  const p = routePath(ROUTES.swarm.member, { id: ref });
  return handleSwarm(new Request(`http://test${p}`), new URL(`http://test${p}`));
};

// Same shortcut swarm-member-handle.test.ts's activeMember() uses: registerMember
// is the smoke/E2E path that upserts a member straight to active with no
// approval flow, which is all this file needs — a real row to resolve.
async function activeMember() {
  const id = rid("m");
  const { publicKeyB64 } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) {
    throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  }
  const [row] = await sql<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${id}`;
  if (!row) throw new Error(`activeMember(): no row for ${id}`);
  return { id, handle: row.handle };
}

test("GET /api/swarm/members/:ref for a ref that resolves to nothing is 404, not 200 with a null body", async () => {
  const res = await getMemberRoute("no-member-has-ever-had-this-handle");
  expect(res?.status).toBe(404);
  expect(res?.body).toEqual({ error: "not found" });
});

// The other half of the acceptance criteria: a reference that DOES resolve
// must be completely unaffected — no status change, no body change — by the
// 404 path existing at all.
test("GET /api/swarm/members/:ref for a ref that DOES resolve is unaffected — still 200 with the member", async () => {
  const m = await activeMember();

  const byId = await getMemberRoute(m.id);
  expect(byId?.status).toBe(200);
  expect((byId?.body as { id: string }).id).toBe(m.id);

  const byHandle = await getMemberRoute(m.handle);
  expect(byHandle?.status).toBe(200);
  expect((byHandle?.body as { id: string }).id).toBe(m.id);
});
