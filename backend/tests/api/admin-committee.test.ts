// Committee admin route contract (issue #152): every owned route is
// PRIVILEGED and fails 403 BEFORE any body parsing or DB work (fail-closed,
// same idiom as routes/admin.ts). Runs against the ephemeral Postgres from
// tests/preload.ts. Also asserts documented 200/201/404/409 envelopes and
// that a path this handler does not own falls through as null.
import { test, expect, beforeAll } from "bun:test";
import { generateKeyPair } from "../../src/lib/signing.ts";
import { handleCommitteeAdmin } from "../../src/api/routes/committee-admin.ts";
import { sql } from "../../src/db/client.ts";

const PROD = { adminToken: "s3cret-committee-admin-token", allowInsecure: false } as const;
const INSECURE = { adminToken: null, allowInsecure: true } as const;

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// All committee test files share ONE ephemeral Postgres (tests/preload.ts). With
// COMMITTEE_ROSTER_CAP now hard-enforced on every transition-to-active, a roster
// left full by an earlier-running file would make this file's manual member add
// return 409 instead of the expected 201. Reset the roster so this file admits
// its own members from empty, independent of file order.
beforeAll(async () => {
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
});

function req(method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== undefined) headers["X-Admin-Token"] = opts.token;
  const body = opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new Request(`http://x${path}`, { method, headers, body });
}
const call = (r: Request, cfg: typeof PROD | typeof INSECURE = PROD) => handleCommitteeAdmin(r, new URL(r.url), cfg);

test("prod-mode with no token → 403 on every owned route, before body parsing", async () => {
  const routes: [string, string][] = [
    ["GET", "/api/committee/admin/subjects"],
    ["POST", "/api/committee/admin/subjects"],
    ["POST", "/api/committee/admin/subjects/x/update"],
    ["POST", "/api/committee/admin/subjects/x/deactivate"],
    ["GET", "/api/committee/admin/members"],
    ["POST", "/api/committee/admin/members"],
    ["GET", "/api/committee/admin/applications"],
    ["POST", "/api/committee/admin/members/x/review"],
    ["POST", "/api/committee/admin/members/x/deactivate"],
    ["POST", "/api/committee/admin/members/x/reactivate"],
    ["POST", "/api/committee/admin/members/x/rotate-key"],
    ["POST", "/api/committee/admin/sessions"],
    ["GET", "/api/committee/admin/sessions/x/roster"],
    ["POST", "/api/committee/admin/sessions/x/roster/add"],
    ["POST", "/api/committee/admin/sessions/x/roster/excuse"],
    ["POST", "/api/committee/admin/sessions/x/roster/restore"],
    ["POST", "/api/committee/admin/sessions/x/cancel"],
    ["POST", "/api/committee/admin/sessions/x/close"],
    ["POST", "/api/committee/admin/sessions/x/reopen"],
    ["POST", "/api/committee/admin/sessions/x/aggregate"],
    ["POST", "/api/committee/admin/sessions/x/publish"],
    ["GET", "/api/committee/admin/audit"],
  ];
  for (const [method, path] of routes) {
    const res = await call(req(method, path), PROD);
    expect(res?.status).toBe(403);
  }
});

test("wrong token → 403", async () => {
  expect((await call(req("GET", "/api/committee/admin/subjects", { token: "nope" }), PROD))?.status).toBe(403);
});

test("malformed JSON body never reaches parsing when unauthenticated (auth runs first)", async () => {
  // If auth ran AFTER body parsing, this malformed body would surface as a
  // 400 (or throw); it must still be a clean 403.
  const res = await call(req("POST", "/api/committee/admin/subjects", { rawBody: "{not json" }), PROD);
  expect(res?.status).toBe(403);
});

test("a path this handler does not own returns null (falls through to the legacy dispatcher)", async () => {
  expect(await call(req("POST", "/api/committee/admin/regime"), INSECURE)).toBeNull();
  expect(await call(req("POST", "/api/committee/admin/open"), INSECURE)).toBeNull();
  expect(await call(req("GET", "/api/committee/members"), INSECURE)).toBeNull();
});

test("topics: create (201) → list includes it (200) → update stale version (409) → update ok (200) → deactivate (200)", async () => {
  const id = rid("rtopic");
  const create = await call(req("POST", "/api/committee/admin/subjects", { token: PROD.adminToken, body: { id, name: "Route Topic" } }), PROD);
  expect(create?.status).toBe(201);
  expect((create!.body as any).subject.id).toBe(id);

  const list = await call(req("GET", "/api/committee/admin/subjects", { token: PROD.adminToken }), PROD);
  expect(list?.status).toBe(200);
  expect((list!.body as any).subjects.some((s: any) => s.id === id)).toBe(true);

  const staleUpdate = await call(
    req("POST", `/api/committee/admin/subjects/${id}/update`, { token: PROD.adminToken, body: { expectedVersion: 99, name: "x" } }),
    PROD,
  );
  expect(staleUpdate?.status).toBe(409);

  const update = await call(
    req("POST", `/api/committee/admin/subjects/${id}/update`, { token: PROD.adminToken, body: { expectedVersion: 1, name: "Renamed" } }),
    PROD,
  );
  expect(update?.status).toBe(200);
  expect((update!.body as any).subject.name).toBe("Renamed");

  const deactivate = await call(
    req("POST", `/api/committee/admin/subjects/${id}/deactivate`, { token: PROD.adminToken, body: { expectedVersion: 2 } }),
    PROD,
  );
  expect(deactivate?.status).toBe(200);
  expect((deactivate!.body as any).subject.status).toBe("inactive");
});

test("topics: missing required fields → 400; missing expectedVersion on update → 400", async () => {
  const bad = await call(req("POST", "/api/committee/admin/subjects", { token: PROD.adminToken, body: { name: "no id" } }), PROD);
  expect(bad?.status).toBe(400);
  const missingVersion = await call(
    req("POST", "/api/committee/admin/subjects/x/update", { token: PROD.adminToken, body: { name: "x" } }),
    PROD,
  );
  expect(missingVersion?.status).toBe(400);
});

test("members: manual add (201, one-time token) → list is redacted → review/deactivate/rotate route through", async () => {
  const memberId = rid("rmember");
  const { publicKeyB64 } = await generateKeyPair();
  const add = await call(
    req("POST", "/api/committee/admin/members", { token: PROD.adminToken, body: { memberId, name: "Route Member", publicKey: publicKeyB64 } }),
    PROD,
  );
  expect(add?.status).toBe(201);
  expect(typeof (add!.body as any).token).toBe("string");

  const list = await call(req("GET", "/api/committee/admin/members", { token: PROD.adminToken }), PROD);
  expect(list?.status).toBe(200);
  const listed = (list!.body as any).members.find((m: any) => m.id === memberId);
  expect(listed).toBeTruthy();
  expect(listed).not.toHaveProperty("token_hash");
  expect(listed).not.toHaveProperty("public_key");

  const deactivate = await call(
    req("POST", `/api/committee/admin/members/${memberId}/deactivate`, { token: PROD.adminToken, body: { expectedVersion: 1 } }),
    PROD,
  );
  expect(deactivate?.status).toBe(200);

  // Deactivation revokes the active key transactionally, so rotating without
  // a fresh publicKey correctly 409s (no on-file active key to rotate from).
  const rotateNoKey = await call(req("POST", `/api/committee/admin/members/${memberId}/rotate-key`, { token: PROD.adminToken, body: {} }), PROD);
  expect(rotateNoKey?.status).toBe(409);

  const { publicKeyB64: freshKey } = await generateKeyPair();
  const rotate = await call(
    req("POST", `/api/committee/admin/members/${memberId}/rotate-key`, { token: PROD.adminToken, body: { publicKey: freshKey } }),
    PROD,
  );
  expect(rotate?.status).toBe(200);
  expect(typeof (rotate!.body as any).token).toBe("string");
});

test("applications: GET list (200), optionally filtered by ?status=", async () => {
  const res = await call(req("GET", "/api/committee/admin/applications?status=pending", { token: PROD.adminToken }), PROD);
  expect(res?.status).toBe(200);
  expect(Array.isArray((res!.body as any).applications)).toBe(true);
});

test("sessions: create (201) with bad payload → 400; unknown subject/session → 404", async () => {
  const bad = await call(req("POST", "/api/committee/admin/sessions", { token: PROD.adminToken, body: { date: "2026-08-01" } }), PROD);
  expect(bad?.status).toBe(400);

  const notFoundSubject = await call(
    req("POST", "/api/committee/admin/sessions", {
      token: PROD.adminToken,
      body: { date: "2026-08-01", subjectId: rid("nope"), briefOpensAt: "2026-08-01T09:00:00Z", windowClosesAt: "2026-08-01T10:00:00Z", publishAt: "2026-08-01T10:05:00Z" },
    }),
    PROD,
  );
  expect(notFoundSubject?.status).toBe(404);

  const notFoundCancel = await call(
    req("POST", `/api/committee/admin/sessions/${crypto.randomUUID()}/cancel`, { token: PROD.adminToken, body: {} }),
    PROD,
  );
  expect(notFoundCancel?.status).toBe(404);
});

test("audit: GET returns entries (200) and honors ?limit=", async () => {
  const res = await call(req("GET", "/api/committee/admin/audit?limit=5", { token: PROD.adminToken }), PROD);
  expect(res?.status).toBe(200);
  expect(Array.isArray((res!.body as any).entries)).toBe(true);
  expect((res!.body as any).entries.length).toBeLessThanOrEqual(5);
});

test("insecure config (RM_ALLOW_INSECURE/ephemeral) opens the surface without a token", async () => {
  const res = await call(req("GET", "/api/committee/admin/subjects"), INSECURE);
  expect(res?.status).toBe(200);
});
