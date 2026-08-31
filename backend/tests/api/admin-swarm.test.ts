// Swarm admin route contract (issue #152): every owned route is
// PRIVILEGED and fails 403 BEFORE any body parsing or DB work (fail-closed,
// same idiom as routes/admin.ts). Runs against the ephemeral Postgres from
// tests/preload.ts. Also asserts documented 200/201/404/409 envelopes and
// that a path this handler does not own falls through as null.
import { test, expect } from "bun:test";
import { generateKeyPair } from "../../src/lib/signing.ts";
import { handleSwarmAdmin } from "../../src/api/routes/swarm-admin.ts";
import { sql } from "../../src/db/client.ts";
import { ROUTES } from "@robotmoney/contract";
import { useCleanDatabase } from "../support/clean-db.ts";

const PROD = { adminToken: "s3cret-swarm-admin-token", allowInsecure: false } as const;
const INSECURE = { adminToken: null, allowInsecure: true } as const;

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// Issue #690. Deliberately the RFC-4122 v4 shape rather than "any 36 chars":
// the point of the change is that this route mints ids the same way
// crypto.randomUUID() does on the public apply path, and a laxer pattern would
// still pass for a slug an operator smuggled through.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Own database per file, cloned from the migrated template — the roster this
// file admits into is its own, with no reset of anyone else's rows.
useCleanDatabase(import.meta.file);

function req(method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== undefined) headers["X-Admin-Token"] = opts.token;
  const body = opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new Request(`http://x${path}`, { method, headers, body });
}
const call = (r: Request, cfg: typeof PROD | typeof INSECURE = PROD) => handleSwarmAdmin(r, new URL(r.url), cfg);

test("prod-mode with no token → 403 on every owned route, before body parsing", async () => {
  const routes: [string, string][] = [
    ["GET", "/api/swarm/admin/subjects"],
    ["POST", "/api/swarm/admin/subjects"],
    ["POST", "/api/swarm/admin/subjects/x/update"],
    ["POST", "/api/swarm/admin/subjects/x/deactivate"],
    ["GET", "/api/swarm/admin/members"],
    ["POST", "/api/swarm/admin/members"],
    ["GET", "/api/swarm/admin/applications"],
    ["POST", "/api/swarm/admin/members/x/review"],
    ["POST", "/api/swarm/admin/members/x/update"],
    ["POST", "/api/swarm/admin/members/x/deactivate"],
    ["POST", "/api/swarm/admin/members/x/reactivate"],
    ["POST", "/api/swarm/admin/members/x/rotate-key"],
    ["POST", "/api/swarm/admin/sessions"],
    ["GET", "/api/swarm/admin/sessions/x/roster"],
    // Issue #767: a `shadow` judgement is model-authored prose about named
    // members that the mode deliberately keeps OFF the public session page, so
    // its read path must be as fail-closed as everything else here.
    ["GET", "/api/swarm/admin/sessions/x/judgements"],
    ["POST", "/api/swarm/admin/sessions/x/roster/add"],
    ["POST", "/api/swarm/admin/sessions/x/roster/excuse"],
    ["POST", "/api/swarm/admin/sessions/x/roster/restore"],
    ["POST", "/api/swarm/admin/sessions/x/cancel"],
    ["POST", "/api/swarm/admin/sessions/x/close"],
    ["POST", "/api/swarm/admin/sessions/x/reopen"],
    ["POST", "/api/swarm/admin/sessions/x/aggregate"],
    ["POST", "/api/swarm/admin/sessions/x/publish"],
    ["GET", "/api/swarm/admin/audit"],
  ];
  for (const [method, path] of routes) {
    const res = await call(req(method, path), PROD);
    expect(res?.status).toBe(403);
  }
});

test("wrong token → 403", async () => {
  expect((await call(req("GET", "/api/swarm/admin/subjects", { token: "nope" }), PROD))?.status).toBe(403);
});

test("malformed JSON body never reaches parsing when unauthenticated (auth runs first)", async () => {
  // If auth ran AFTER body parsing, this malformed body would surface as a
  // 400 (or throw); it must still be a clean 403.
  const res = await call(req("POST", "/api/swarm/admin/subjects", { rawBody: "{not json" }), PROD);
  expect(res?.status).toBe(403);
});

test("a path this handler does not own returns null (falls through to the legacy dispatcher)", async () => {
  expect(await call(req("POST", "/api/swarm/admin/regime"), INSECURE)).toBeNull();
  expect(await call(req("POST", "/api/swarm/admin/open"), INSECURE)).toBeNull();
  expect(await call(req("GET", "/api/swarm/members"), INSECURE)).toBeNull();
});

test("topics: create (201) → list includes it (200) → update stale version (409) → update ok (200) → deactivate (200)", async () => {
  const id = rid("rtopic");
  const create = await call(req("POST", "/api/swarm/admin/subjects", { token: PROD.adminToken, body: { id, name: "Route Topic" } }), PROD);
  expect(create?.status).toBe(201);
  expect((create!.body as any).subject.id).toBe(id);

  const list = await call(req("GET", "/api/swarm/admin/subjects", { token: PROD.adminToken }), PROD);
  expect(list?.status).toBe(200);
  expect((list!.body as any).subjects.some((s: any) => s.id === id)).toBe(true);

  const staleUpdate = await call(
    req("POST", `/api/swarm/admin/subjects/${id}/update`, { token: PROD.adminToken, body: { expectedVersion: 99, name: "x" } }),
    PROD,
  );
  expect(staleUpdate?.status).toBe(409);

  const update = await call(
    req("POST", `/api/swarm/admin/subjects/${id}/update`, { token: PROD.adminToken, body: { expectedVersion: 1, name: "Renamed" } }),
    PROD,
  );
  expect(update?.status).toBe(200);
  expect((update!.body as any).subject.name).toBe("Renamed");

  const deactivate = await call(
    req("POST", `/api/swarm/admin/subjects/${id}/deactivate`, { token: PROD.adminToken, body: { expectedVersion: 2 } }),
    PROD,
  );
  expect(deactivate?.status).toBe(200);
  expect((deactivate!.body as any).subject.status).toBe("inactive");
});

test("topics: missing required fields → 400; missing expectedVersion on update → 400", async () => {
  const bad = await call(req("POST", "/api/swarm/admin/subjects", { token: PROD.adminToken, body: { name: "no id" } }), PROD);
  expect(bad?.status).toBe(400);
  const missingVersion = await call(
    req("POST", "/api/swarm/admin/subjects/x/update", { token: PROD.adminToken, body: { name: "x" } }),
    PROD,
  );
  expect(missingVersion?.status).toBe(400);
});

test("members: manual add (201, one-time token) → list is redacted → review/deactivate/rotate route through", async () => {
  const { publicKeyB64 } = await generateKeyPair();
  const add = await call(
    req("POST", "/api/swarm/admin/members", { token: PROD.adminToken, body: { name: "Route Member", publicKey: publicKeyB64 } }),
    PROD,
  );
  expect(add?.status).toBe(201);
  expect(typeof (add!.body as any).token).toBe("string");
  // Issue #690: the id is the server's, and the response is the ONLY place the
  // caller can learn it — so everything downstream is keyed on what came back.
  const memberId = (add!.body as any).member.id as string;
  expect(memberId).toMatch(UUID_RE);

  const list = await call(req("GET", "/api/swarm/admin/members", { token: PROD.adminToken }), PROD);
  expect(list?.status).toBe(200);
  const listed = (list!.body as any).members.find((m: any) => m.id === memberId);
  expect(listed).toBeTruthy();
  expect(listed).not.toHaveProperty("token_hash");
  expect(listed).not.toHaveProperty("public_key");

  const deactivate = await call(
    req("POST", `/api/swarm/admin/members/${memberId}/deactivate`, { token: PROD.adminToken, body: { expectedVersion: 1 } }),
    PROD,
  );
  expect(deactivate?.status).toBe(200);

  // Deactivation revokes the active key transactionally, so rotating without
  // a fresh publicKey correctly 409s (no on-file active key to rotate from).
  const rotateNoKey = await call(req("POST", `/api/swarm/admin/members/${memberId}/rotate-key`, { token: PROD.adminToken, body: {} }), PROD);
  expect(rotateNoKey?.status).toBe(409);

  const { publicKeyB64: freshKey } = await generateKeyPair();
  const rotate = await call(
    req("POST", `/api/swarm/admin/members/${memberId}/rotate-key`, { token: PROD.adminToken, body: { publicKey: freshKey } }),
    PROD,
  );
  expect(rotate?.status).toBe(200);
  expect(typeof (rotate!.body as any).token).toBe("string");
});

// ── The admin add path can no longer manufacture an id (issue #690) ─────────
//
// SWARM_ROSTER_CAP is 10 and this file's clean database is shared by every test
// in it, so a test that seats members and walks away spends seats the later
// `members: update …` tests need. Each #690 test hands its seats back the way
// an operator would — through the real deactivate route, which is also a small
// extra proof that a member created without a caller-supplied id is an ordinary
// member the rest of the admin surface can drive by the id it was given.
async function releaseSeat(id: string): Promise<void> {
  const res = await call(
    req("POST", `/api/swarm/admin/members/${id}/deactivate`, { token: PROD.adminToken, body: { expectedVersion: 1 } }),
    PROD,
  );
  if (res?.status !== 200) throw new Error(`releaseSeat(${id}) failed: ${JSON.stringify(res)}`);
}

//
// WHAT THIS PROTECTS. `addMemberAdmin` used to INSERT `input.memberId` as the
// primary key, validated only as a non-empty string under 100 characters. That
// was the last way to create a member whose id is a human slug, and a slug id
// is not cosmetic: migration 0031 refuses a handle equal to ANOTHER member's
// id (so an id of `woon` bars the member actually named Woon from ever holding
// `woon`), and migration 0030's `handle = id` sentinel makes such a member read
// as "handle unset" forever. Every assertion below goes over the REAL route and
// then reads the row back out of Postgres — a 201 envelope has never been proof
// of what landed in the column.

test("members: the manual add mints a UUID id — the caller cannot name one, and a body that tries is refused", async () => {
  const { publicKeyB64 } = await generateKeyPair();

  // 1. THE TAP IS CLOSED. A body naming an id is a 400 with its own sentence,
  //    not a 201 under some other id, and not the generic "required" message.
  const slug = "woon";
  const named = await call(
    req("POST", "/api/swarm/admin/members", { token: PROD.adminToken, body: { memberId: slug, name: "Woon", publicKey: publicKeyB64 } }),
    PROD,
  );
  expect(named?.status).toBe(400);
  expect((named!.body as any).error).toBe("memberId is not accepted: the member id is generated and returned as member.id");
  // Refused, not half-written: no member under that id, and none created at all
  // under some substituted id either (the key is still free below).
  expect((await sql`SELECT id FROM swarm_members WHERE id = ${slug}`).length).toBe(0);

  // 2. An EMPTY/NULL memberId is the same request, and gets the same answer —
  //    the parser tests key presence, not truthiness, so a client that clears
  //    the field rather than removing it is not silently let through.
  for (const value of ["", null]) {
    const blank = await call(
      req("POST", "/api/swarm/admin/members", { token: PROD.adminToken, body: { memberId: value, name: "Woon", publicKey: publicKeyB64 } }),
      PROD,
    );
    expect(blank?.status).toBe(400);
    expect((blank!.body as any).error).toBe("memberId is not accepted: the member id is generated and returned as member.id");
  }

  // 3. WITHOUT the field it is created, and the id in the DATABASE is a UUID.
  const ok = await call(
    req("POST", "/api/swarm/admin/members", { token: PROD.adminToken, body: { name: "Woon", publicKey: publicKeyB64 } }),
    PROD,
  );
  expect(ok?.status).toBe(201);
  const id = (ok!.body as any).member.id as string;
  expect(id).toMatch(UUID_RE);
  const [row] = await sql<{ id: string; handle: string }[]>`SELECT id, handle FROM swarm_members WHERE id = ${id}`;
  expect(row!.id).toMatch(UUID_RE);

  // 4. THE HANDLE IS UNCHANGED BY ALL THIS — still slugified from the display
  //    name, and NOT the id sentinel migration 0030 stamps at INSERT time.
  expect(row!.handle).toBe("woon");
  expect(row!.handle).not.toBe(row!.id);
  // …and the audit row records the id that was actually seated, not the one
  // the caller asked for (there is no longer any such thing).
  const [entry] = await sql<{ scope: any }[]>`
    SELECT scope FROM audit_log WHERE action = 'member_manual_add' AND scope->>'memberId' = ${id}`;
  expect(entry!.scope.handle).toBe("woon");

  await releaseSeat(id);
});

test("members: two adds with the SAME display name both get UUID ids and the derived-handle suffix — no id collision to trip over", async () => {
  const first = await call(
    req("POST", "/api/swarm/admin/members", {
      token: PROD.adminToken,
      body: { name: "Noop Analyst", publicKey: (await generateKeyPair()).publicKeyB64 },
    }),
    PROD,
  );
  const second = await call(
    req("POST", "/api/swarm/admin/members", {
      token: PROD.adminToken,
      body: { name: "Noop Analyst", publicKey: (await generateKeyPair()).publicKeyB64 },
    }),
    PROD,
  );
  expect(first?.status).toBe(201);
  expect(second?.status).toBe(201);
  const a = (first!.body as any).member;
  const b = (second!.body as any).member;
  expect(a.id).toMatch(UUID_RE);
  expect(b.id).toMatch(UUID_RE);
  expect(a.id).not.toBe(b.id);
  // Issue #562's collision rule, untouched by #690: the lowest free numeric
  // suffix, never a refusal.
  expect(a.handle).toBe("noop-analyst");
  expect(b.handle).toBe("noop-analyst-2");

  await releaseSeat(a.id);
  await releaseSeat(b.id);
});

test("members: duplicate detection moved to the public key — the same credential twice is a 409, and seats nobody", async () => {
  const { publicKeyB64 } = await generateKeyPair();
  const first = await call(
    req("POST", "/api/swarm/admin/members", { token: PROD.adminToken, body: { name: "Twice Over", publicKey: publicKeyB64 } }),
    PROD,
  );
  expect(first?.status).toBe(201);

  // The realistic accident the old `memberId already registered` 409 caught: an
  // operator submitting the add form twice. With the id minted server-side the
  // id can no longer be the duplicate signal, so the KEY is — and it is the
  // better signal anyway, because two members sharing a public key make every
  // signed take ambiguous about who produced it.
  const again = await call(
    req("POST", "/api/swarm/admin/members", { token: PROD.adminToken, body: { name: "Twice Over", publicKey: publicKeyB64 } }),
    PROD,
  );
  expect(again?.status).toBe(409);
  expect((again!.body as any).error).toContain("publicKey already belongs to a member");

  const seated = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_member_keys WHERE public_key = ${publicKeyB64}`;
  expect(seated[0]!.n).toBe(1);

  await releaseSeat((first!.body as any).member.id as string);
});

test("applications: GET list (200), optionally filtered by ?status=", async () => {
  const res = await call(req("GET", "/api/swarm/admin/applications?status=pending", { token: PROD.adminToken }), PROD);
  expect(res?.status).toBe(200);
  expect(Array.isArray((res!.body as any).applications)).toBe(true);
});

test("sessions: create (201) with bad payload → 400; unknown subject/session → 404", async () => {
  const bad = await call(req("POST", "/api/swarm/admin/sessions", { token: PROD.adminToken, body: { date: "2026-08-01" } }), PROD);
  expect(bad?.status).toBe(400);

  const notFoundSubject = await call(
    req("POST", "/api/swarm/admin/sessions", {
      token: PROD.adminToken,
      body: { date: "2026-08-01", subjectId: rid("nope"), briefOpensAt: "2026-08-01T09:00:00Z", windowClosesAt: "2026-08-01T10:00:00Z", publishAt: "2026-08-01T10:05:00Z" },
    }),
    PROD,
  );
  expect(notFoundSubject?.status).toBe(404);

  const notFoundCancel = await call(
    req("POST", `/api/swarm/admin/sessions/${crypto.randomUUID()}/cancel`, { token: PROD.adminToken, body: {} }),
    PROD,
  );
  expect(notFoundCancel?.status).toBe(404);
});

// The shadow soak's read path (issue #767). Content is pinned in
// tests/swarm-judge.test.ts, which can actually run a judge; what this file
// owns is the TRANSPORT — that the route exists on the admin dispatcher, is
// addressed by the contract's template, and answers 404 rather than 200-with-
// nothing for a session that does not exist.
test("sessions: the judgements read path is a real admin route — 200 with an empty history, 404 for an unknown session", async () => {
  const subjectId = rid("judgeread");
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES (${subjectId}, 'active', 'Judge read path')`;
  const created = await call(
    req("POST", "/api/swarm/admin/sessions", {
      token: PROD.adminToken,
      body: { date: "2026-08-11", subjectId, briefOpensAt: "2026-08-11T09:00:00Z", windowClosesAt: "2026-08-11T10:00:00Z", publishAt: "2026-08-11T10:05:00Z" },
    }),
    PROD,
  );
  expect(created?.status).toBe(201);
  const sessionId = (created!.body as any).session.id as string;

  const path = ROUTES.swarm.admin.sessionJudgements.replace(":id", sessionId);
  const res = await call(req("GET", path, { token: PROD.adminToken }), PROD);
  expect(res?.status).toBe(200);
  const body = res!.body as any;
  expect(body.sessionId).toBe(sessionId);
  expect(body.state).toBe("scheduled");
  expect(body.judgements).toEqual([]);
  expect(body.inForce).toBeNull();

  const missing = await call(
    req("GET", ROUTES.swarm.admin.sessionJudgements.replace(":id", crypto.randomUUID()), { token: PROD.adminToken }),
    PROD,
  );
  expect(missing?.status).toBe(404);
});

test("audit: GET returns entries (200) and honors ?limit=", async () => {
  const res = await call(req("GET", "/api/swarm/admin/audit?limit=5", { token: PROD.adminToken }), PROD);
  expect(res?.status).toBe(200);
  expect(Array.isArray((res!.body as any).entries)).toBe(true);
  expect((res!.body as any).entries.length).toBeLessThanOrEqual(5);
});

test("insecure config (RM_ALLOW_INSECURE/ephemeral) opens the surface without a token", async () => {
  const res = await call(req("GET", "/api/swarm/admin/subjects"), INSECURE);
  expect(res?.status).toBe(200);
});

// ── Member edit (issue #567) ────────────────────────────────────────────────
// The only write path that can correct name/lens/contact_email on a seated
// member. Every assertion below reads the real row back out of the ephemeral
// Postgres — a 200 envelope alone has never been proof that a column moved.

// Returns the immutable id AND the public handle the create derived from the
// name (issue #562). The two are no longer the same string, and which one a
// test means is now a real question: `id` is what every route path and audit
// row below is keyed on, `handle` is only ever the published URL segment.
async function seatMember(): Promise<{ id: string; handle: string }> {
  const { publicKeyB64 } = await generateKeyPair();
  const add = await call(
    req("POST", "/api/swarm/admin/members", { token: PROD.adminToken, body: { name: "Before", publicKey: publicKeyB64 } }),
    PROD,
  );
  // Fail loudly rather than let a bogus id flow into a confusing 404 later.
  if (add?.status !== 201) throw new Error(`seatMember(): manual add failed: ${JSON.stringify(add)}`);
  return { id: (add.body as any).member.id as string, handle: (add.body as any).member.handle as string };
}

const updateMember = (id: string, body: unknown) =>
  call(req("POST", `/api/swarm/admin/members/${id}/update`, { token: PROD.adminToken, body }), PROD);

const rowOf = async (id: string) =>
  (await sql`SELECT * FROM swarm_members WHERE id = ${id}`)[0] as Record<string, any>;

test("members: update writes every editable field, bumps version, and the projection returns them", async () => {
  const { id, handle } = await seatMember();
  const res = await updateMember(id, {
    expectedVersion: 1,
    name: "Woon",
    lens: "machine economy, first person",
    contactEmail: "woon@peaq.test",
    tagline: "peaq's social media intern",
    mandate: "watch the machine economy",
    biases: ["never-sells-agent-tokens", "openly-conflicted"],
    voiceMd: "# voice",
    mode: "self-advocacy",
    operator: "peaq",
    avatar: { path: "/img/woon.png" },
  });
  expect(res?.status).toBe(200);

  // The DB row is the authority — every column actually changed.
  const row = await rowOf(id);
  expect(row.name).toBe("Woon");
  expect(row.lens).toBe("machine economy, first person");
  expect(row.contact_email).toBe("woon@peaq.test");
  expect(row.tagline).toBe("peaq's social media intern");
  expect(row.mandate).toBe("watch the machine economy");
  expect(row.biases).toEqual(["never-sells-agent-tokens", "openly-conflicted"]);
  expect(row.voice_md).toBe("# voice");
  expect(row.mode).toBe("self-advocacy");
  expect(row.operator).toBe("peaq");
  expect(row.avatar).toEqual({ path: "/img/woon.png" });
  expect(Number(row.version)).toBe(2);

  // The admin projection must carry every editable field or the edit form
  // cannot prefill it — and must still carry no key material.
  const member = (res!.body as any).member;
  expect(member).toEqual({
    id,
    // The public handle is projected beside the immutable id (issue #593), and
    // since issue #562 it is DERIVED from the name the member was created with
    // ("Before") rather than copied from the id. What this assertion is really
    // for is that it did not MOVE: the patch above renames the member to
    // "Woon", and a rename must never repoint a published URL — changing the
    // handle stays a separate, audited act.
    handle,
    status: "active",
    version: 2,
    name: "Woon",
    tagline: "peaq's social media intern",
    lens: "machine economy, first person",
    mandate: "watch the machine economy",
    biases: ["never-sells-agent-tokens", "openly-conflicted"],
    voiceMd: "# voice",
    mode: "self-advocacy",
    operator: "peaq",
    avatar: { path: "/img/woon.png" },
    contactEmail: "woon@peaq.test",
    appliedAt: member.appliedAt,
    activatedAt: member.activatedAt,
    updatedAt: member.updatedAt,
  });
  expect(member).not.toHaveProperty("token_hash");
  expect(member).not.toHaveProperty("public_key");
  expect(member).not.toHaveProperty("key_hash");

  // Same fields are visible on the list projection the admin page loads.
  const list = await call(req("GET", "/api/swarm/admin/members", { token: PROD.adminToken }), PROD);
  const listed = (list!.body as any).members.find((m: any) => m.id === id);
  expect(listed.biases).toEqual(["never-sells-agent-tokens", "openly-conflicted"]);
  expect(listed.voiceMd).toBe("# voice");
  expect(listed.avatar).toEqual({ path: "/img/woon.png" });
});

test("members: an explicit null CLEARS the column, and an absent key leaves it alone", async () => {
  // This is the whole reason updateMemberAdmin merges with `!== undefined`
  // instead of `??`: with `??` every assertion below would still see a 200
  // and the OLD value still sitting in the column.
  const { id } = await seatMember();
  expect((await updateMember(id, {
    expectedVersion: 1,
    lens: "old lens",
    tagline: "old tagline",
    mandate: "old mandate",
    contactEmail: "old@example.test",
    biases: ["old-bias"],
    voiceMd: "# old",
    mode: "old mode",
    operator: "old operator",
    avatar: { path: "/old.png" },
  }))?.status).toBe(200);

  const cleared = await updateMember(id, {
    expectedVersion: 2,
    lens: null,
    tagline: null,
    mandate: null,
    contactEmail: null,
    biases: null,
    voiceMd: null,
    mode: null,
    operator: null,
    avatar: null,
  });
  expect(cleared?.status).toBe(200);

  const row = await rowOf(id);
  for (const col of ["lens", "tagline", "mandate", "contact_email", "biases", "voice_md", "mode", "operator", "avatar"]) {
    expect(row[col]).toBeNull();
  }
  // name was never in either patch, so it must be untouched.
  expect(row.name).toBe("Before");
  expect(Number(row.version)).toBe(3);

  const member = (cleared!.body as any).member;
  expect(member.lens).toBeNull();
  expect(member.biases).toBeNull();
  expect(member.avatar).toBeNull();
});

test("members: a single-field patch leaves every other column untouched", async () => {
  const { id } = await seatMember();
  expect((await updateMember(id, { expectedVersion: 1, lens: "a lens", tagline: "a tagline" }))?.status).toBe(200);
  expect((await updateMember(id, { expectedVersion: 2, tagline: "a new tagline" }))?.status).toBe(200);

  const row = await rowOf(id);
  expect(row.tagline).toBe("a new tagline");
  expect(row.lens).toBe("a lens");
  expect(row.name).toBe("Before");
});

test("members: stale expectedVersion → 409 and nothing is written; missing → 400; unknown member → 404", async () => {
  const { id } = await seatMember();

  const stale = await updateMember(id, { expectedVersion: 99, name: "Should Not Land" });
  expect(stale?.status).toBe(409);
  expect((stale!.body as any).error).toBe("stale_version");
  expect((await rowOf(id)).name).toBe("Before");
  expect(Number((await rowOf(id)).version)).toBe(1);

  const missing = await updateMember(id, { name: "Also Should Not Land" });
  expect(missing?.status).toBe(400);
  expect((await rowOf(id)).name).toBe("Before");

  const absent = await updateMember(rid("nosuch"), { expectedVersion: 1, name: "x" });
  expect(absent?.status).toBe(404);
});

test("members: a rejected patch (unknown key, bad email, bad biases) → 400 and no write", async () => {
  const { id } = await seatMember();
  const bodies: unknown[] = [
    { expectedVersion: 1, status: "inactive" }, // unknown key — status is not editable here
    { expectedVersion: 1, contactEmail: "not-an-email" },
    { expectedVersion: 1, biases: "not-an-array" },
    { expectedVersion: 1, avatar: ["not", "an", "object"] },
    { expectedVersion: 1, name: "   " },
    { expectedVersion: 1 }, // no editable field at all
  ];
  for (const body of bodies) {
    const res = await updateMember(id, body);
    expect(res?.status).toBe(400);
  }
  const row = await rowOf(id);
  expect(row.name).toBe("Before");
  expect(Number(row.version)).toBe(1);
});

test("members: update records an audit row naming the changed fields and the reason", async () => {
  const { id } = await seatMember();
  expect((await updateMember(id, {
    expectedVersion: 1,
    lens: "machine economy, first person",
    tagline: "still saving for legs",
    reason: "Operator correction after a duplicate apply; requested by peaq.",
  }))?.status).toBe(200);

  const entry = (await sql`
    SELECT actor, action, scope FROM audit_log
    WHERE action = 'member_update' AND scope->>'memberId' = ${id}
    ORDER BY id DESC LIMIT 1`)[0] as Record<string, any>;
  expect(entry).toBeTruthy();
  expect(entry.actor).toBe("admin");
  expect(entry.scope.memberId).toBe(id);
  expect(entry.scope.fields.sort()).toEqual(["lens", "tagline"]);
  expect(entry.scope.reason).toBe("Operator correction after a duplicate apply; requested by peaq.");

  // `reason` is operator context, never a member column — it must not have
  // been mistaken for a field to write.
  const row = await rowOf(id);
  expect(row.lens).toBe("machine economy, first person");
  expect(Object.values(row)).not.toContain("Operator correction after a duplicate apply; requested by peaq.");
});

test("members: a non-admin caller is refused before any row is read or written", async () => {
  const { id } = await seatMember();
  for (const token of [undefined, "nope"]) {
    const res = await call(
      req("POST", `/api/swarm/admin/members/${id}/update`, { ...(token === undefined ? {} : { token }), body: { expectedVersion: 1, name: "Escalated" } }),
      PROD,
    );
    expect(res?.status).toBe(403);
  }
  const row = await rowOf(id);
  expect(row.name).toBe("Before");
  expect(Number(row.version)).toBe(1);
});

test("members: the update path is the contract's swarm.admin.memberUpdate template", async () => {
  const { id } = await seatMember();
  // Guards against the handler and contract drifting onto two different URLs.
  const path = ROUTES.swarm.admin.memberUpdate.replace(":id", id);
  const res = await call(req("POST", path, { token: PROD.adminToken, body: { expectedVersion: 1, tagline: "via contract path" } }), PROD);
  expect(res?.status).toBe(200);
  expect((await rowOf(id)).tagline).toBe("via contract path");
});
