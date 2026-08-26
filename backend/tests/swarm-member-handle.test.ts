// Separate member identity from public handle (issue #593).
//
// WHAT THIS FILE PROTECTS. `swarm_members.id` used to be the public URL segment
// as well as the primary key, the target of every child row's `member_id`, and
// the identity string historical signatures were made over. Renaming a persona
// in public therefore meant rewriting a column that four other things depend on
// — which is why nobody could. Migration 0030 adds `handle`, and the whole
// point is what does NOT move when it changes:
//
//   1. The rename is a handle-only write. `id`, every child row's `member_id`,
//      and every signed payload/signature byte are identical afterwards, and
//      the take still VERIFIES — proved by re-reading it through the public
//      receipt route, not by inspecting the column and hoping.
//   2. Public routes resolve BOTH names. A link published under the legacy id
//      keeps working after the rename; the new handle works too. This is what
//      makes the rename safe rather than a redirect problem.
//   3. Uniqueness is enforced against both namespaces. A handle equal to
//      another member's handle OR to another member's legacy id is refused with
//      a 409, because either one would silently steal a published URL.
//   4. The edit is audited with its before/after value — "the handle changed"
//      is not an answer to "what was this member called in the link I was
//      sent?".
//   5. Self-service cannot touch it, over the real HTTP route and not only in
//      the validator unit test.
//
// Shares the one ephemeral Postgres every other swarm test file uses
// (tests/preload.ts). A missing Docker/Postgres fails that preload loudly.
import { test, expect, beforeEach } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission, path as routePath, ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

// Own database per TEST, cloned from the migrated template. Per-test, not
// per-file: countActiveMembers() is global and SWARM_ROSTER_CAP is enforced on
// every transition-to-active, so members seated by one test would make the
// next test's admission a spurious 409. Unique ids cannot fix that; a clean
// database can.
useCleanDatabasePerTest(import.meta.file);

// `handle` is read back off the row rather than assumed to equal `id`: since
// issue #562 registerMember derives the public handle from the member's NAME,
// so a seated member's starting handle is the slug of `id` (the name this
// helper passes), not the id itself. Every assertion below that means "this
// member's handle did not move" compares against THIS value, so it keeps saying
// that and does not quietly become an assertion about the derivation rule.
async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) {
    throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  }
  const [row] = await sql<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${id}`;
  if (!row) throw new Error(`activeMember(): no row for ${id}`);
  return { id, handle: row.handle, token: r.token, privateKey };
}

type Member = Awaited<ReturnType<typeof activeMember>>;

async function openCollectingSession(prefix: string) {
  const subj = rid(prefix);
  await ic.ensureSubject(subj, `${prefix} subject`);
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  return { subj, session: s, date: sessionDate(s) };
}

async function submit(m: Member, date: string, subjectId: string) {
  const sub = {
    memberId: m.id,
    date,
    subjectId,
    nonce: rid("n"),
    stance: "constructive",
    confidence: 0.7,
    body: "a signed take filed under the legacy id",
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  return ic.submitRecommendation(m.token, { ...sub, signature });
}

/** The version the optimistic-concurrency guard on updateMemberAdmin wants. */
async function versionOf(memberId: string): Promise<number> {
  const row = (await sql<{ version: number }[]>`SELECT version FROM swarm_members WHERE id = ${memberId}`)[0];
  if (!row) throw new Error(`versionOf(): no member ${memberId}`);
  return Number(row.version);
}

const getMemberRoute = (ref: string) => {
  const p = routePath(ROUTES.swarm.member, { id: ref });
  return handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));
};

const getMemberTakesRoute = (ref: string) => {
  const p = routePath(ROUTES.swarm.memberTakes, { id: ref });
  return handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));
};

const postProfileRoute = (ref: string, token: string, body: unknown) => {
  const p = routePath(ROUTES.swarm.memberProfile, { id: ref });
  return handleSwarm(
    new Request(`http://localhost${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    new URL(`http://localhost${p}`),
  );
};

const takeReceiptRoute = (id: string) => {
  const p = routePath(ROUTES.swarm.take, { id });
  return handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));
};

// The API's outermost handler turns ANY escaped exception into a sanitized
// `500 {"error":"internal error"}` (backend/src/api/index.ts) — that is the
// literal thing issue #596 is about, so reproduce the mapping here instead of
// letting a raised 23505 blow the test up with a stack trace. A regression then
// reads as `expected 409, received 500`: the operator-visible failure.
async function callSwarm(req: Request): Promise<{ status: number; body: any }> {
  try {
    return (await handleSwarm(req, new URL(req.url))) ?? { status: 404, body: null };
  } catch {
    return { status: 500, body: { error: "internal error" } };
  }
}

const postJson = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** POST /api/swarm/admin/members — the admin manual-add create path. */
const adminAddMemberRoute = (body: unknown) => callSwarm(postJson(ROUTES.swarm.admin.members, body));
/** POST /api/swarm/register — the privileged apply+activate create path. */
const registerRoute = (body: unknown) => callSwarm(postJson(ROUTES.swarm.register, body));

const CONTENDED = "noop-analyst";
const HANDLE_CONFLICT = "memberId already in use as another member's public handle";

async function memberCount(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm_members`;
  return row!.n;
}

// ── 1. A member written with NO handle still falls back to its id ───────────
//
// REWRITTEN FOR ISSUE #562, deliberately and not by loosening. The original
// test here asserted "a newly admitted member's handle IS its id" over
// registerMember, and #562 changes exactly that: a member admitted through any
// of the three create/accept paths now gets a handle derived from its NAME, so
// applicants stop being published at /swarm/members/<uuid>. Asserting the old
// outcome would assert the bug.
//
// What that test was PROTECTING is a different property, and it survives intact
// — so it is what this test now states directly instead of by implication:
// migration 0030's BEFORE INSERT default is what guarantees no published URL
// moved when 0030 deployed, and it is still the last-resort fallback for the
// writers that supply no handle and go nowhere near the derivation
// (roster-seed.ts, smoke/e2e.ts, scripts/v0-seed-bootstrap.ts — the seeded
// roster `woon`/`athena`/`robotmoney` among them, which #562 explicitly
// declined to rename). A raw insert is the honest way to exercise that
// fallback, because a raw insert is precisely what those three writers do.
//
// The derivation itself has its own file: tests/swarm-member-handle-derivation.test.ts.

test("a member row inserted with NO handle falls back to its id — 0030's default, so a raw-inserting seed writer publishes no URL that moved", async () => {
  const id = rid("seeded");
  await sql`INSERT INTO swarm_members (id, status, name) VALUES (${id}, 'active', 'Seeded Persona')`;

  // The column really carries the value; it is not a read-time `?? id` fallback
  // pretending the separation exists. And it is the ID, not a slug of the name
  // — nothing derived reaches this writer.
  const [row] = await sql<{ id: string; handle: string }[]>`
    SELECT id, handle FROM swarm_members WHERE id = ${id}`;
  expect(row!.handle).toBe(id);

  const member = await ic.getMember(id);
  expect(member!.id).toBe(id);
  expect(member!.handle).toBe(id);

  // The admin projection shows BOTH, which is what lets an operator tell the
  // editable name from the one signatures are keyed on.
  const adminRows = await admin.listMembersAdmin();
  const adminRow = adminRows.find((r) => r.id === id);
  expect(adminRow!.handle).toBe(id);
});

// ── 2. The rename moves the handle and NOTHING else ─────────────────────────

test("renaming the handle leaves the id, the child recommendation row, and the signed bytes untouched — and the take still verifies", async () => {
  const { subj, session, date } = await openCollectingSession("rename");
  const m = await activeMember();
  const filed = await submit(m, date, subj);
  expect(filed.status).toBe(201);

  const before = (await sql<{ id: string; member_id: string; payload: unknown; signature: string }[]>`
    SELECT id, member_id, payload, signature FROM swarm_recommendations WHERE session_id = ${session.id}`)[0]!;
  expect(before.member_id).toBe(m.id);

  const res = await admin.updateMemberAdmin(m.id, await versionOf(m.id), { handle: "noop-analyst" });
  expect(res.status).toBe(200);
  expect((res as any).member.handle).toBe("noop-analyst");
  expect((res as any).member.id).toBe(m.id); // the id is NOT editable here

  const after = (await sql<{ id: string; member_id: string; payload: unknown; signature: string }[]>`
    SELECT id, member_id, payload, signature FROM swarm_recommendations WHERE session_id = ${session.id}`)[0]!;
  expect(after.id).toBe(before.id);
  // THE FOREIGN KEY VALUE. If the rename had gone through `id` this would now
  // be 'noop-analyst' (or the row would be gone).
  expect(after.member_id).toBe(m.id);
  expect(after.signature).toBe(before.signature);
  expect(JSON.stringify(after.payload)).toBe(JSON.stringify(before.payload));
  // The payload names the SIGNING identity, not the new public handle.
  expect((after.payload as { memberId: string }).memberId).toBe(m.id);

  // …and the signature is re-checked at read time against the member's active
  // key, so this is the assertion that says the rename did not invalidate it.
  const receipt = await takeReceiptRoute(before.id);
  expect(receipt!.status).toBe(200);
  const body = receipt!.body as any;
  expect(body.take.verified).toBe(true);
  expect(body.take.memberId).toBe(m.id);        // signing identity, verbatim
  expect(body.take.memberHandle).toBe("noop-analyst"); // where to link
  expect(body.signer.id).toBe(m.id);
  expect(body.signer.handle).toBe("noop-analyst");
});

// ── 3. Public routes resolve BOTH names ─────────────────────────────────────

test("GET /api/swarm/members/:ref resolves the new handle AND the legacy id, to the same row", async () => {
  const m = await activeMember();
  const renamed = await admin.updateMemberAdmin(m.id, await versionOf(m.id), { handle: "noop-analyst" });
  expect(renamed.status).toBe(200);

  const byHandle = await getMemberRoute("noop-analyst");
  expect(byHandle!.status).toBe(200);
  expect((byHandle!.body as any).id).toBe(m.id);
  expect((byHandle!.body as any).handle).toBe("noop-analyst");

  // THE LINK-ROT ASSERTION. Every URL published before the rename carries the
  // legacy id, and it must still resolve — that is the whole reason the id was
  // left alone instead of being rewritten.
  const byLegacyId = await getMemberRoute(m.id);
  expect(byLegacyId!.status).toBe(200);
  expect((byLegacyId!.body as any).id).toBe(m.id);
  expect((byLegacyId!.body as any).handle).toBe("noop-analyst");

  // A name that belongs to nobody is still nothing. #687: that is a
  // deliberate 404, not a 200 with a null body — a crawler must not be told
  // the page is fine for a ref that never resolves.
  const missing = await getMemberRoute("no-such-member");
  expect(missing!.status).toBe(404);
  expect(missing!.body).toEqual({ error: "not found" });
});

test("GET /api/swarm/members/:ref/takes answers to the handle and to the legacy id alike", async () => {
  const { subj, date } = await openCollectingSession("takes-by-handle");
  const m = await activeMember();
  expect((await submit(m, date, subj)).status).toBe(201);

  await admin.updateMemberAdmin(m.id, await versionOf(m.id), { handle: "noop-analyst" });

  const byHandle = await getMemberTakesRoute("noop-analyst");
  const byId = await getMemberTakesRoute(m.id);
  expect((byHandle!.body as any).takes).toHaveLength(1);
  expect((byId!.body as any).takes).toHaveLength(1);
  expect((byHandle!.body as any).takes[0].take.id).toBe((byId!.body as any).takes[0].take.id);
  // The take carries both names: the id it was signed under, the handle to link.
  expect((byHandle!.body as any).takes[0].take.memberId).toBe(m.id);
  expect((byHandle!.body as any).takes[0].take.memberHandle).toBe("noop-analyst");
});

// ── 4. Uniqueness across BOTH namespaces ────────────────────────────────────

test("a handle already held by another member is refused with 409, and nothing is written", async () => {
  const a = await activeMember();
  const b = await activeMember();
  await admin.updateMemberAdmin(a.id, await versionOf(a.id), { handle: "noop-analyst" });

  const collision = await admin.updateMemberAdmin(b.id, await versionOf(b.id), {
    handle: "noop-analyst",
    tagline: "a tagline that must not survive the refusal",
  });
  expect(collision.status).toBe(409);
  expect(collision.error).toBe("handle already taken");

  const untouched = await ic.getMember(b.id);
  expect(untouched!.handle).toBe(b.handle); // still the handle it was seated with
  expect(untouched!.tagline).toBeNull(); // the whole patch was refused, not part of it
});

test("a handle equal to ANOTHER member's legacy id is refused too — no index forbids it, and it would steal a live URL", async () => {
  const a = await activeMember();
  const b = await activeMember();

  // Nothing in the schema stops this: `a.id` is not in the handle unique index.
  // Allowed through, /swarm/members/<a.id> would become ambiguous and could
  // start serving b to readers holding a link to a.
  const stolen = await admin.updateMemberAdmin(b.id, await versionOf(b.id), { handle: a.id });
  expect(stolen.status).toBe(409);
  expect(stolen.error).toBe("handle already taken");

  const byA = await getMemberRoute(a.id);
  expect((byA!.body as any).id).toBe(a.id);
});

test("re-submitting a member's OWN current handle is not a self-collision", async () => {
  const m = await activeMember();
  // The guard must compare against OTHER rows only — a form that posts the
  // unchanged handle alongside a real edit is the common case.
  const res = await admin.updateMemberAdmin(m.id, await versionOf(m.id), {
    handle: m.handle,
    tagline: "edited alongside an unchanged handle",
  });
  expect(res.status).toBe(200);
  expect((res as any).member.tagline).toBe("edited alongside an unchanged handle");
});

// ── 5. The audit trail names the old and the new handle ─────────────────────

test("a handle edit is audited with its before/after value, not merely as a changed field", async () => {
  const m = await activeMember();
  await admin.updateMemberAdmin(m.id, await versionOf(m.id), { handle: "noop-analyst" }, "admin", "persona rename");

  const [entry] = await sql<{ actor: string; action: string; scope: any }[]>`
    SELECT actor, action, scope FROM audit_log
    WHERE action = 'member_update' AND scope->>'memberId' = ${m.id}
    ORDER BY id DESC LIMIT 1`;
  expect(entry!.actor).toBe("admin");
  expect(entry!.scope.fields).toEqual(["handle"]);
  // The part a `fields` list cannot give you months later.
  expect(entry!.scope.handleFrom).toBe(m.handle);
  expect(entry!.scope.handleTo).toBe("noop-analyst");
  expect(entry!.scope.reason).toBe("persona rename");

  // An edit that does NOT touch the handle carries no handle keys at all,
  // so a reader of the log never has to guess whether one moved.
  await admin.updateMemberAdmin(m.id, await versionOf(m.id), { tagline: "unrelated" });
  const [second] = await sql<{ scope: any }[]>`
    SELECT scope FROM audit_log
    WHERE action = 'member_update' AND scope->>'memberId' = ${m.id}
    ORDER BY id DESC LIMIT 1`;
  expect(second!.scope.fields).toEqual(["tagline"]);
  expect(second!.scope.handleFrom).toBeUndefined();
  expect(second!.scope.handleTo).toBeUndefined();
});

// ── 6. Self-service cannot move it, over the real route ─────────────────────

test("POST /api/swarm/members/:ref/profile refuses a handle (400) but accepts the member addressing ITSELF by its new handle", async () => {
  const m = await activeMember();
  await admin.updateMemberAdmin(m.id, await versionOf(m.id), { handle: "noop-analyst" });

  const refused = await postProfileRoute("noop-analyst", m.token, { handle: "something-else" });
  expect(refused!.status).toBe(400);
  expect((refused!.body as any).error).toBe(
    "handle is administrator-managed and cannot be set from a member profile update",
  );
  expect((await ic.getMember(m.id))!.handle).toBe("noop-analyst");

  // The member's own profile write still lands when it addresses itself by the
  // public name it now reads off its own profile — the token, not the path
  // segment, is what authorises it.
  const ok = await postProfileRoute("noop-analyst", m.token, { tagline: "filed under the new handle" });
  expect(ok!.status).toBe(200);
  expect((ok!.body as any).member.tagline).toBe("filed under the new handle");
  expect((ok!.body as any).member.id).toBe(m.id);

  // …and another member's token still cannot write it, whichever name is used.
  const other = await activeMember();
  const wrongOwner = await postProfileRoute("noop-analyst", other.token, { tagline: "not yours" });
  expect(wrongOwner!.status).toBe(403);
  expect((await ic.getMember(m.id))!.tagline).toBe("filed under the new handle");
});

// ── 7. The CREATE paths honour the same 409 the rename does (issue #596) ────
//
// Migration 0030's BEFORE INSERT trigger defaults `handle := id`, so a member
// created under a name another member already publishes as its handle trips
// swarm_members_handle_key INSIDE the admission transaction. Before this fix
// the exception escaped to api/index.ts and came back as `500 internal error`,
// which tells an operator nothing about a conflict the update path had been
// describing precisely for two releases. These tests go over the REAL HTTP
// routes, because a 500 is a transport-level outcome: exercising the domain
// function directly would only ever show you an exception.

test("POST /api/swarm/admin/members: the conflict class is GONE — the route refuses to take an id at all (issue #690)", async () => {
  const a = await activeMember();
  expect((await admin.updateMemberAdmin(a.id, await versionOf(a.id), { handle: CONTENDED })).status).toBe(200);

  const { publicKeyB64 } = await generateKeyPair();

  // This USED to be the interesting case: a caller-supplied id equal to another
  // member's published handle, answered with a 409 rather than the sanitized
  // 500 an escaped 23505 became. Since #690 the id is minted server-side and
  // the field is refused outright, so the collision cannot be reached from here
  // — and the answer is a 400 that names the field, never a silent substitution.
  const named = await adminAddMemberRoute({ memberId: CONTENDED, name: "Impostor", publicKey: publicKeyB64 });
  expect(named.status).toBe(400);
  expect(named.body.error).toBe("memberId is not accepted: the member id is generated and returned as member.id");
  expect(await memberCount()).toBe(1);
  expect(((await getMemberRoute(CONTENDED))!.body as any).id).toBe(a.id);

  // The same body WITHOUT the field is created, and lands beside the contended
  // name rather than on top of it: the derived handle takes the next free
  // suffix (issue #562's rule), and the published name still resolves to `a`.
  const created = await adminAddMemberRoute({ name: "Noop Analyst", publicKey: publicKeyB64 });
  expect(created.status).toBe(201);
  expect(created.body.member.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(created.body.member.handle).toBe(`${CONTENDED}-2`);
  expect(((await getMemberRoute(CONTENDED))!.body as any).id).toBe(a.id);

  // The 23505 → 409 mapping itself is NOT orphaned by this: registerMember
  // still takes a caller-supplied id (the smoke/E2E shortcut), and the test
  // below drives the same conflict through it. The admin path's own residual
  // race — on the DERIVED handle — is driven further down this file.
});

test("POST /api/swarm/register: the same conflict, answered the same way — ON CONFLICT (id) never covered the handle index", async () => {
  const a = await activeMember();
  expect((await admin.updateMemberAdmin(a.id, await versionOf(a.id), { handle: CONTENDED })).status).toBe(200);

  const { publicKeyB64 } = await generateKeyPair();
  const clash = await registerRoute({ memberId: CONTENDED, name: "Impostor", publicKey: publicKeyB64 });

  // registerMember has NO pre-probe at all: its upsert arbitrates the PRIMARY
  // KEY and nothing else, so this 409 is produced ENTIRELY by the SQLSTATE
  // 23505 → swarm_members_handle_key mapping. This test is the race mapping's
  // direct, non-timing-dependent coverage.
  expect(clash.status).toBe(409);
  expect(clash.body.error).toBe(HANDLE_CONFLICT);
  expect(await memberCount()).toBe(1);

  // …and the idempotent re-registration the upsert exists for is untouched:
  // re-registering the SAME id still succeeds, and does not reset the handle an
  // administrator moved.
  const again = await registerRoute({ memberId: a.id, name: a.id, publicKey: publicKeyB64 });
  expect(again.status).toBe(201);
  expect(again.body.memberId).toBe(a.id);
  expect((await ic.getMember(a.id))!.handle).toBe(CONTENDED);
  expect(await memberCount()).toBe(1);
});

// Block until a statement matching `fragment` is genuinely waiting on a lock,
// which is the only proof that the write passed its probe and reached the
// index. Times out LOUDLY: a silent give-up here would turn a race test into a
// test of the probe, which the non-racing tests already cover.
//
// `wait_event_type = 'Lock'` is what discriminates. The other transaction in
// each of these tests is parked in idle-in-transaction with a matching `query`
// text, but it is waiting on the Client, not on a Lock.
async function waitUntilBlockedOn(fragment: string, whatItProves: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${`%${fragment}%`}`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `no statement matching ${fragment} ever blocked on swarm_members_handle_key — ${whatItProves} was NOT reproduced, so this test proved nothing`,
  );
}

test("the race a probe cannot close — a rename committing between derivation and UPDATE — is still a 409, never a 500", async () => {
  const a = await activeMember();
  const { publicKeyB64 } = await generateKeyPair();

  // REPOINTED BY ISSUE #690. The window used to be probe→INSERT, because the
  // INSERT carried the caller's chosen id into swarm_members_handle_key. The id
  // is a fresh UUID now, so the INSERT contends for nothing — the create's only
  // contended write is the UPDATE that installs the DERIVED handle, and
  // deriveMemberHandle's SELECT is the probe that cannot see an uncommitted
  // rename. Same class of race, one statement later; the 23505 → 409 mapping
  // underneath it is what this test still exists to prove.
  let renameApplied!: () => void;
  let commitRename!: () => void;
  const renameLanded = new Promise<void>((resolve) => { renameApplied = resolve; });
  const renameHeld = new Promise<void>((resolve) => { commitRename = resolve; });
  const renamer = sql.begin(async (tx) => {
    await tx`UPDATE swarm_members SET handle = ${CONTENDED} WHERE id = ${a.id}`;
    renameApplied();
    await renameHeld;
  });
  await renameLanded;

  // "Noop Analyst" derives to CONTENDED — which the uncommitted rename above is
  // about to take.
  const create = adminAddMemberRoute({ name: "Noop Analyst", publicKey: publicKeyB64 });
  // Deterministic, not a sleep: the create is provably past its derivation and
  // parked on the handle index before the rename is allowed to commit.
  await waitUntilBlockedOn("UPDATE swarm_members SET handle", "the derive→UPDATE race");
  commitRename();
  await renamer;

  const raced = await create;
  expect(raced.status).toBe(409);
  // The SAME sentence the rename path's lost race gets, because it is the same
  // situation from the other side: the public name is gone, try again.
  expect(raced.body.error).toBe("handle already taken");

  // The loser wrote nothing; the winner owns the name.
  expect(await memberCount()).toBe(1);
  expect((await ic.getMember(a.id))!.handle).toBe(CONTENDED);
  expect(((await getMemberRoute(CONTENDED))!.body as any).id).toBe(a.id);
});

test("the SAME race on the RENAME path — two administrators, one free handle — is a 409, never a 500", async () => {
  // The update path's 23505 mapping (admin.ts's catch around updateMemberAdminTx)
  // is what stops this PR turning a lost race into a `500 internal error`, and
  // it is the ONE branch no other test can reach: every other 409 asserted
  // against updateMemberAdmin is produced by the in-transaction probe, which
  // returns before the database is ever asked. This test drives the update to
  // the point where the DATABASE refuses it.
  const a = await activeMember();
  const b = await activeMember();
  const bVersion = await versionOf(b.id);
  // A handle nobody holds under EITHER namespace, so both administrators' probes
  // legitimately pass. This is the ordinary way two operators collide: not a
  // hijack, just the same good name chosen twice.
  const free = rid("contended-rename");
  expect(await ic.getMember(free)).toBeNull();

  // Administrator 1's rename, applied but UNCOMMITTED. Under READ COMMITTED
  // administrator 2's probe cannot see it — the window a probe can never close.
  let renameApplied!: () => void;
  let commitRename!: () => void;
  const renameLanded = new Promise<void>((resolve) => { renameApplied = resolve; });
  const renameHeld = new Promise<void>((resolve) => { commitRename = resolve; });
  const renamer = sql.begin(async (tx) => {
    await tx`UPDATE swarm_members SET handle = ${free}, version = version + 1 WHERE id = ${a.id}`;
    renameApplied();
    await renameHeld;
  });
  await renameLanded;

  // Administrator 2 renames a DIFFERENT member to the same free handle.
  const loser = admin.updateMemberAdmin(b.id, bVersion, { handle: free });
  // Deterministic, not a sleep: administrator 2 is provably past its probe and
  // parked on swarm_members_handle_key before administrator 1 is allowed to
  // commit. Without this the test could pass on the probe alone and prove
  // nothing about the mapping.
  await waitUntilBlockedOn("UPDATE swarm_members SET", "the probe→UPDATE rename race");
  commitRename();
  await renamer;

  // THE ASSERTION. `500` here is what an escaped 23505 is sanitized to by
  // api/index.ts, and it is what this surface did before the catch existed.
  const raced = await loser;
  expect(raced.status).toBe(409);
  expect(raced.error).toBe("handle already taken");

  // The loser wrote nothing — not the handle, and not the version bump that
  // would have made an operator's next optimistic update fail for a second,
  // unrelated reason.
  const [row] = await sql<{ handle: string; version: number }[]>`
    SELECT handle, version FROM swarm_members WHERE id = ${b.id}`;
  expect(row!.handle).toBe(b.handle);
  expect(Number(row!.version)).toBe(bVersion);

  // The winner owns the name, and the public reference resolves to it.
  expect((await ic.getMember(a.id))!.handle).toBe(free);
  expect((await ic.getMember(free))!.id).toBe(a.id);
});

// ── 8. One reference, one member — in BOTH read paths (issue #597) ──────────
//
// 0030's unique index constrains handle against handle. It never constrained a
// handle against another member's `id`, and `id` is a public URL segment too:
// getMember and getMemberTakes both resolve `handle = $ref OR id = $ref`, which
// is what keeps every pre-rename link alive. So the pair A(id='a1',
// handle='woon') / B(id='woon', handle='b1') made /swarm/members/woon
// ambiguous, and the two read paths disagreed about it: getMember masked the
// collision with `ORDER BY (handle = $ref) DESC LIMIT 1`, while getMemberTakes
// matched BOTH rows and let `DISTINCT ON (r.session_id) … ORDER BY r.revision
// DESC` pick a per-session winner across two different members — A's identity,
// name and lens rendered over B's signed take, on a page whose whole premise is
// verifiable attribution.
//
// The state is NOT reachable through any public write path (every INSERT in the
// tree names no handle, and the admin probe refuses the rename), which is why
// these tests reach past the application and use SQL directly. A test that
// cannot create the collision proves nothing about how it is read.

test("the DATABASE refuses a handle equal to another member's id, not only the application probe", async () => {
  const a = await activeMember();
  const b = await activeMember();

  // Same refusal as the probe's, but with the probe out of the picture: this
  // statement never runs updateMemberAdmin. Pre-0031 it committed silently.
  let refusal: any;
  try {
    await sql`UPDATE swarm_members SET handle = ${b.id} WHERE id = ${a.id}`;
  } catch (e) { refusal = e; }
  expect(refusal).toBeDefined();
  expect(refusal.code).toBe("23505");
  expect(refusal.constraint_name ?? refusal.constraint).toBe("swarm_members_handle_namespace");
  expect((await ic.getMember(a.id))!.handle).toBe(a.handle);

  // The mirror direction — a member CREATED under a name another member already
  // publishes — is refused by the same trigger, so the invariant does not depend
  // on which of the two rows is written second.
  await admin.updateMemberAdmin(a.id, await versionOf(a.id), { handle: CONTENDED });
  let insertRefusal: any;
  try {
    await sql`INSERT INTO swarm_members (id, status, name, handle)
              VALUES (${CONTENDED}, 'inactive', 'Impostor', 'impostor-handle')`;
  } catch (e) { insertRefusal = e; }
  expect(insertRefusal).toBeDefined();
  expect(insertRefusal.code).toBe("23505");
  expect(insertRefusal.constraint_name ?? insertRefusal.constraint).toBe("swarm_members_handle_namespace");
});

test("getMemberTakes cannot merge two members' takes into one reference", async () => {
  // Two members, both taking in ONE session — the shape that made the merge
  // visible: DISTINCT ON collapses per session, so a merged match returns the
  // wrong member's row rather than an obviously-too-long list.
  const shared = await openCollectingSession("ns-collision");
  const a = await activeMember();
  const b = await activeMember();
  expect((await submit(a, shared.date, shared.subj)).status).toBe(201);
  expect((await submit(b, shared.date, shared.subj)).status).toBe(201);
  // B's take is the higher revision, so a merged query picks B deterministically
  // — without this the pre-fix result would depend on physical row order and the
  // test would prove nothing on a good day.
  await sql`UPDATE swarm_recommendations SET revision = 2 WHERE member_id = ${b.id}`;

  // A second session only B takes in, so a merged query also returns a take from
  // a session A never sat in.
  const solo = await openCollectingSession("ns-collision-solo");
  expect((await submit(b, solo.date, solo.subj)).status).toBe(201);

  // B is renamed first — the ordinary edit 0030 exists for, and also what frees
  // `b.id` in the handle namespace so that 0030's unique index has nothing to
  // say about A taking it. This is the failure scenario verbatim:
  // A(id=a, handle=b.id) / B(id=b.id, handle=b-renamed).
  expect((await admin.updateMemberAdmin(b.id, await versionOf(b.id), { handle: `${b.id}-renamed` })).status)
    .toBe(200);

  // FORCE THE COLLISION. Unreachable through the API (that is #597's first
  // half), so disable the trigger for exactly one statement.
  //
  // ENABLE ALWAYS, not ENABLE, in the finally: 0031 installs this trigger with
  // tgenabled = 'A' so that `session_replication_role = replica` (pg_restore
  // --disable-triggers, logical replication) cannot bypass it, and a plain
  // ENABLE silently downgrades it to 'O' for the rest of the suite — reopening
  // the exact hole the migration closes, in the shared database, invisibly.
  await sql`ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_handle_namespace_trigger`;
  try {
    await sql`UPDATE swarm_members SET handle = ${b.id} WHERE id = ${a.id}`;
  } finally {
    await sql`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger`;
  }
  const [trg] = await sql<{ tgenabled: string }[]>`
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(trg!.tgenabled).toBe("A");

  // getMember's answer for this reference: A, because the handle is preferred.
  const resolved = await ic.getMember(b.id);
  expect(resolved!.id).toBe(a.id);

  // THE ASSERTION. Pre-fix this returned two takes, BOTH of them B's — one of
  // them attributed to A on the profile page. The two read paths must agree on
  // WHO the reference names before anything is attributed to them.
  const { takes } = await ic.getMemberTakes(b.id, 50);
  expect(takes.every((t: any) => t.take.memberId === resolved!.id)).toBe(true);
  expect(takes).toHaveLength(1);
  expect(takes[0]!.subjectId).toBe(shared.subj);

  // Over the real public route too — the profile page is what actually reads
  // this, and it is where the misattribution would have been visible.
  const viaRoute = (await getMemberTakesRoute(b.id))!.body as any;
  expect(viaRoute.takes).toHaveLength(1);
  expect(viaRoute.takes[0].take.memberId).toBe(a.id);

  // Resolving the reference first adds a "nobody holds this name" branch that
  // did not exist when the takes query matched two namespaces itself. It must
  // still be an empty record, not a 500 and not somebody else's takes.
  const nobody = (await getMemberTakesRoute(`${b.id}-nobody`))!.body as any;
  expect(nobody.takes).toHaveLength(0);

  // REPAIR, before leaving. This is the only place in the tree that installs a
  // pair the schema forbids, and `beforeEach` only truncates for THIS file — so
  // without this the shared suite database ends the file in violation, and
  // db-preflight.test.ts's "the migrated database is clean" assertion would be
  // asserting the previous file's luck. The repair is the one 0031's message
  // names: move A's handle off B's id (see the migration test's collided-state
  // case for why the victim's own row is the wrong one to change).
  await sql`UPDATE swarm_members SET handle = ${`${a.id}-repaired`} WHERE id = ${a.id}`;
  expect((await ic.getMember(b.id))!.id).toBe(b.id);
});
