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

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

// Per-test reset rather than per-file: SWARM_ROSTER_CAP is hard-enforced on
// every transition-to-active, and this file seats several members per test.
beforeEach(async () => {
  await sql`TRUNCATE swarm_members RESTART IDENTITY CASCADE`;
});

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) {
    throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  }
  return { id, token: r.token, privateKey };
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

// ── 1. Every member starts with handle === id ───────────────────────────────

test("a newly admitted member's handle IS its id — migration 0030's default, so no published URL changes on deploy", async () => {
  const m = await activeMember();

  // The column really carries the value; it is not a read-time `?? id` fallback
  // pretending the separation exists.
  const [row] = await sql<{ id: string; handle: string }[]>`
    SELECT id, handle FROM swarm_members WHERE id = ${m.id}`;
  expect(row!.handle).toBe(m.id);

  const member = await ic.getMember(m.id);
  expect(member!.id).toBe(m.id);
  expect(member!.handle).toBe(m.id);

  // The admin projection shows BOTH, which is what lets an operator tell the
  // editable name from the one signatures are keyed on.
  const adminRows = await admin.listMembersAdmin();
  const adminRow = adminRows.find((r) => r.id === m.id);
  expect(adminRow!.handle).toBe(m.id);
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

  // A name that belongs to nobody is still nothing.
  const missing = await getMemberRoute("no-such-member");
  expect(missing!.body).toBeNull();
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
  expect(untouched!.handle).toBe(b.id);
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
    handle: m.id,
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
  expect(entry!.scope.handleFrom).toBe(m.id);
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
