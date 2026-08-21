// Admin per-member avatar upload (issue #626): the real thing behind
// updateMemberAdmin's metadata-only avatar patch (which merely lets an admin
// point avatar.path at an arbitrary URL string). This route stores actual
// image bytes in Postgres (swarm_member_avatars, migration 0035) and points
// avatar.path at a GET route that serves them back — DB-backed rather than
// STATIC_DIR because scripts/static-assembly.sh wipes and re-copies
// STATIC_DIR's contents on every `docker compose up`/redeploy, so a
// file-on-disk upload would not survive one.
//
// PRECEDENCE (AC3 of #626, and the third test the issue's test plan
// requires) is proven at the boundary this backend owns, not by re-deriving
// frontend/public/assets/js/app/lib/member-mark.js's mark logic here.
// Companion issue #625 (a SIBLING, not-yet-merged worktree — its diff is not
// in this tree) makes memberAvatarMarkup() render an <img src=avatarPath>
// with the derived mark as its onerror fallback: any avatar.path that LOADS
// wins over the derived mark, and only a load FAILURE falls back to it. So
// the backend-provable form of "uploaded wins over derived" is: before
// upload, the member carries no avatar.path (a consumer has nothing to try
// loading, so it falls to the derived mark); after upload, avatar.path is
// set AND resolves — served back byte-for-byte through the SAME public GET
// route production traffic uses — so a real <img> pointed at it can never
// hit that onerror fallback. That is the whole condition #625's precedence
// check depends on; there is no separate flag to assert.
import { test, expect } from "bun:test";
import { generateKeyPair } from "../../src/lib/signing.ts";
import { handleSwarmAdmin } from "../../src/api/routes/swarm-admin.ts";
import { handleSwarm } from "../../src/api/routes/swarm.ts";
import { AVATAR_MAX_BYTES } from "../../src/swarm/admin.ts";
import { sql } from "../../src/db/client.ts";
import { ROUTES, path as buildPath } from "@robotmoney/contract";
import { useCleanDatabase } from "../support/clean-db.ts";

// Own database per file — see admin-swarm.test.ts for why (issue #152).
useCleanDatabase(import.meta.file);

const TOKEN = "s3cret-avatar-admin-token";
const PROD = { adminToken: TOKEN, allowInsecure: false };

// A tiny, genuinely-PNG-signed payload — content-type is what this endpoint
// validates, not decoded pixel data, but a real magic number keeps the fixture
// honest about what it claims to be.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

function avatarReq(
  memberId: string,
  opts: { token?: string; contentType?: string; bytes?: Uint8Array } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["X-Admin-Token"] = opts.token;
  if (opts.contentType !== undefined) headers["Content-Type"] = opts.contentType;
  return new Request(`http://x/api/swarm/admin/members/${memberId}/avatar`, {
    method: "POST",
    headers,
    body: (opts.bytes ?? PNG_BYTES) as BodyInit,
  });
}

const call = (r: Request, cfg = PROD) => handleSwarmAdmin(r, new URL(r.url), cfg);

// The public serving route lives in handleSwarm (routes/swarm.ts), not the
// admin dispatcher — a real <img src=avatarPath> is an unauthenticated GET.
async function fetchAvatar(avatarPath: string): Promise<Response> {
  const url = new URL(`http://x${avatarPath}`);
  const r = await handleSwarm(new Request(url), url);
  if (!(r instanceof Response)) throw new Error(`expected the avatar route to return a raw Response, got ${JSON.stringify(r)}`);
  return r;
}

async function seatMember(): Promise<string> {
  const { publicKeyB64 } = await generateKeyPair();
  const add = await call(
    new Request("http://x/api/swarm/admin/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": TOKEN },
      body: JSON.stringify({ name: "Avatar Test Member", publicKey: publicKeyB64 }),
    }),
  );
  if (add?.status !== 201) throw new Error(`seatMember(): manual add failed: ${JSON.stringify(add)}`);
  return (add.body as any).member.id as string;
}

const rowOf = async (id: string) => (await sql`SELECT * FROM swarm_members WHERE id = ${id}`)[0] as Record<string, any>;
const avatarRowOf = async (id: string) =>
  (await sql`SELECT content_type, byte_size FROM swarm_member_avatars WHERE member_id = ${id}`)[0] as
    | Record<string, any>
    | undefined;

// ── AC2 / test plan bullet 1: authentication is required ───────────────────

test("avatar upload: unauthenticated or wrong-token request is rejected before any write", async () => {
  const id = await seatMember();
  for (const token of [undefined, "nope"]) {
    const res = await call(avatarReq(id, { token, contentType: "image/png" }));
    expect(res?.status).toBe(403);
  }
  expect((await rowOf(id)).avatar).toBeNull();
  expect(await avatarRowOf(id)).toBeUndefined();
});

// ── AC1 / test plan bullet 2: a valid upload is stored and served back ─────

test("avatar upload: a valid image is stored in the database, the member row points at it, and it is served back byte-for-byte", async () => {
  const id = await seatMember();
  expect((await rowOf(id)).avatar).toBeNull();

  const res = await call(avatarReq(id, { token: TOKEN, contentType: "image/png", bytes: PNG_BYTES }));
  expect(res?.status).toBe(200);
  const avatar = (res!.body as any).avatar;
  expect(avatar.path).toMatch(new RegExp(`^/api/swarm/members/${id}/avatar\\?v=`));

  // The database row is the authority — not just the response envelope.
  const row = await rowOf(id);
  expect(row.avatar).toEqual(avatar);
  expect(Number(row.version)).toBe(2); // seatMember's add is version 1

  // Stored in swarm_member_avatars, exactly the bytes that were sent — no
  // encoding/truncation, and no file on disk to go stale on a redeploy.
  const avatarRow = await avatarRowOf(id);
  expect(avatarRow?.content_type).toBe("image/png");
  expect(Number(avatarRow?.byte_size)).toBe(PNG_BYTES.byteLength);

  // "served for that member": the SAME public route production traffic hits.
  const served = await fetchAvatar(avatar.path);
  expect(served.status).toBe(200);
  expect(served.headers.get("Content-Type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES);
});

// ── AC4 / test plan implicit: invalid uploads are rejected, no partial state ─

test("avatar upload: an unsupported content-type is rejected and writes nothing", async () => {
  const id = await seatMember();
  const res = await call(avatarReq(id, { token: TOKEN, contentType: "text/plain", bytes: PNG_BYTES }));
  expect(res?.status).toBe(400);
  expect((res!.body as any).error).toContain("content-type");
  expect((await rowOf(id)).avatar).toBeNull();
  expect(Number((await rowOf(id)).version)).toBe(1);
  expect(await avatarRowOf(id)).toBeUndefined();
});

test("avatar upload: an empty body is rejected and writes nothing", async () => {
  const id = await seatMember();
  const res = await call(avatarReq(id, { token: TOKEN, contentType: "image/png", bytes: new Uint8Array(0) }));
  expect(res?.status).toBe(400);
  expect((await rowOf(id)).avatar).toBeNull();
  expect(await avatarRowOf(id)).toBeUndefined();
});

test("avatar upload: an oversized body is rejected and writes nothing", async () => {
  const id = await seatMember();
  const oversized = new Uint8Array(AVATAR_MAX_BYTES + 1);
  const res = await call(avatarReq(id, { token: TOKEN, contentType: "image/png", bytes: oversized }));
  expect(res?.status).toBe(400);
  expect((res!.body as any).error).toContain("byte limit");
  expect((await rowOf(id)).avatar).toBeNull();
  expect(await avatarRowOf(id)).toBeUndefined();
});

test("avatar upload: an unknown member is rejected and writes nothing", async () => {
  const bogus = crypto.randomUUID();
  const res = await call(avatarReq(bogus, { token: TOKEN, contentType: "image/png" }));
  expect(res?.status).toBe(404);
  expect(await avatarRowOf(bogus)).toBeUndefined();
});

// Storage is DB-backed now (no filesystem path is ever built from memberId),
// so this is no longer a path-traversal closure — it is a fast, clear 404 for
// input that can never name a real member, since every real id is a
// crypto.randomUUID() shape (addMemberAdmin, applyMember).
test("avatar upload: a non-UUID member id is rejected as not-found, not passed to a query", async () => {
  const res = await call(avatarReq(encodeURIComponent("../../../../tmp/not-a-member"), { token: TOKEN, contentType: "image/png" }));
  expect(res?.status).toBe(404);
});

// ── The GET serving route: not-found and route/contract parity ─────────────

test("avatar GET route: a member with no upload 404s", async () => {
  const id = await seatMember();
  const res = await fetchAvatar(buildPath(ROUTES.swarm.memberAvatar, { id }));
  expect(res.status).toBe(404);
});

// ── AC3 / test plan bullet 3: precedence over the derived mark ─────────────

test("avatar upload: an uploaded avatar resolves successfully, which is exactly what makes it win over the derived mark", async () => {
  const id = await seatMember();
  // Before upload: no avatar.path at all. #625's memberAvatarMarkup has
  // nothing to try loading, so every render falls to the derived mark.
  expect((await rowOf(id)).avatar).toBeNull();

  const res = await call(avatarReq(id, { token: TOKEN, contentType: "image/jpeg", bytes: PNG_BYTES }));
  expect(res?.status).toBe(200);
  const avatarPath = (res!.body as any).avatar.path as string;

  // After upload: avatar.path is set AND it resolves (200, real bytes) rather
  // than 404ing — the roster-seed placeholders #625's own motivation cites
  // are exactly the 404 case that falls BACK to the derived mark. This one
  // cannot: an <img src=avatarPath> against this response can never fire the
  // x-on:error fallback, so #625's precedence renders the uploaded image, not
  // the mark, for this member everywhere avatars render.
  expect((await rowOf(id)).avatar.path).toBe(avatarPath);
  const served = await fetchAvatar(avatarPath);
  expect(served.status).toBe(200);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES);
});

// ── Route/contract parity ───────────────────────────────────────────────────

test("avatar upload: the route is the contract's swarm.admin.memberAvatar template", async () => {
  const id = await seatMember();
  const templatePath = buildPath(ROUTES.swarm.admin.memberAvatar, { id });
  expect(templatePath).toBe(`/api/swarm/admin/members/${id}/avatar`);
  const res = await call(
    new Request(`http://x${templatePath}`, {
      method: "POST",
      headers: { "X-Admin-Token": TOKEN, "Content-Type": "image/png" },
      body: PNG_BYTES as BodyInit,
    }),
  );
  expect(res?.status).toBe(200);
});

test("avatar GET: the route is the contract's swarm.memberAvatar template", async () => {
  const id = await seatMember();
  await call(avatarReq(id, { token: TOKEN, contentType: "image/png", bytes: PNG_BYTES }));
  const templatePath = buildPath(ROUTES.swarm.memberAvatar, { id });
  expect(templatePath).toBe(`/api/swarm/members/${id}/avatar`);
  const res = await fetchAvatar(templatePath);
  expect(res.status).toBe(200);
});
