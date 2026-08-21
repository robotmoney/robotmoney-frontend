// Admin per-member avatar upload (issue #626): the real thing behind
// updateMemberAdmin's metadata-only avatar patch (which merely lets an admin
// point avatar.path at an arbitrary URL string). This route stores actual
// image bytes under `staticDir` — the SAME directory backend/src/api/
// static.ts serves STATIC_DIR from — and points avatar.path at them.
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
// set AND resolves — served back byte-for-byte through the same
// serveStatic() the production static.ts uses — so a real <img> pointed at
// it can never hit that onerror fallback. That is the whole condition
// #625's precedence check depends on; there is no separate flag to assert.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "../../src/lib/signing.ts";
import { handleSwarmAdmin } from "../../src/api/routes/swarm-admin.ts";
import { serveStatic } from "../../src/api/static.ts";
import { AVATAR_MAX_BYTES } from "../../src/swarm/admin.ts";
import { sql } from "../../src/db/client.ts";
import { ROUTES, path as buildPath } from "@robotmoney/contract";
import { useCleanDatabase } from "../support/clean-db.ts";

// Own database per file — see admin-swarm.test.ts for why (issue #152).
useCleanDatabase(import.meta.file);

let storageDir: string;
beforeAll(() => {
  storageDir = mkdtempSync(join(tmpdir(), "avatar-upload-test-"));
});
afterAll(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

const TOKEN = "s3cret-avatar-admin-token";
const PROD = () => ({ adminToken: TOKEN, allowInsecure: false, staticDir: storageDir });
const NO_STORAGE = { adminToken: TOKEN, allowInsecure: false, staticDir: null } as const;

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

const call = (r: Request, cfg: ReturnType<typeof PROD> | typeof NO_STORAGE = PROD()) =>
  handleSwarmAdmin(r, new URL(r.url), cfg);

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

// Files this member's uploads could ever land under, across every allowed
// extension AND the dotted temp-file naming — so "nothing partial was left
// behind" is checked against every name the implementation could have written,
// not just the one extension a given test happens to upload.
function storedFilesFor(memberId: string): string[] {
  const dir = join(storageDir, "avatars", "uploads");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(memberId));
}

// ── AC2 / test plan bullet 1: authentication is required ───────────────────

test("avatar upload: unauthenticated or wrong-token request is rejected before any write", async () => {
  const id = await seatMember();
  for (const token of [undefined, "nope"]) {
    const res = await call(avatarReq(id, { token, contentType: "image/png" }));
    expect(res?.status).toBe(403);
  }
  expect((await rowOf(id)).avatar).toBeNull();
  expect(storedFilesFor(id)).toEqual([]);
});

// ── AC1 / test plan bullet 2: a valid upload is stored and served back ─────

test("avatar upload: a valid image is stored, the member row points at it, and it is served back byte-for-byte", async () => {
  const id = await seatMember();
  expect((await rowOf(id)).avatar).toBeNull();

  const res = await call(avatarReq(id, { token: TOKEN, contentType: "image/png", bytes: PNG_BYTES }));
  expect(res?.status).toBe(200);
  const avatar = (res!.body as any).avatar;
  expect(avatar.path).toMatch(new RegExp(`^/avatars/uploads/${id}\\.png\\?v=`));

  // The database row is the authority — not just the response envelope.
  const row = await rowOf(id);
  expect(row.avatar).toEqual(avatar);
  expect(Number(row.version)).toBe(2); // seatMember's add is version 1

  // Stored on disk, exactly the bytes that were sent — no encoding/truncation.
  const onDisk = join(storageDir, "avatars", "uploads", `${id}.png`);
  expect(existsSync(onDisk)).toBe(true);
  expect(new Uint8Array(readFileSync(onDisk))).toEqual(PNG_BYTES);
  // No leftover temp file once the upload has succeeded.
  expect(storedFilesFor(id)).toEqual([`${id}.png`]);

  // "served for that member": the SAME static.ts serveStatic() production
  // uses over STATIC_DIR answers the path this route wrote to avatar.path.
  const pathname = new URL(`http://x${avatar.path}`).pathname;
  const served = await serveStatic(pathname, storageDir);
  expect(served).not.toBeNull();
  expect(served!.status).toBe(200);
  expect(new Uint8Array(await served!.arrayBuffer())).toEqual(PNG_BYTES);
});

// ── AC4 / test plan implicit: invalid uploads are rejected, no partial state ─

test("avatar upload: an unsupported content-type is rejected and leaves no file behind", async () => {
  const id = await seatMember();
  const res = await call(avatarReq(id, { token: TOKEN, contentType: "text/plain", bytes: PNG_BYTES }));
  expect(res?.status).toBe(400);
  expect((res!.body as any).error).toContain("content-type");
  expect((await rowOf(id)).avatar).toBeNull();
  expect(Number((await rowOf(id)).version)).toBe(1);
  expect(storedFilesFor(id)).toEqual([]);
});

test("avatar upload: an empty body is rejected and leaves no file behind", async () => {
  const id = await seatMember();
  const res = await call(avatarReq(id, { token: TOKEN, contentType: "image/png", bytes: new Uint8Array(0) }));
  expect(res?.status).toBe(400);
  expect((await rowOf(id)).avatar).toBeNull();
  expect(storedFilesFor(id)).toEqual([]);
});

test("avatar upload: an oversized body is rejected and leaves no file behind", async () => {
  const id = await seatMember();
  const oversized = new Uint8Array(AVATAR_MAX_BYTES + 1);
  const res = await call(avatarReq(id, { token: TOKEN, contentType: "image/png", bytes: oversized }));
  expect(res?.status).toBe(400);
  expect((res!.body as any).error).toContain("byte limit");
  expect((await rowOf(id)).avatar).toBeNull();
  expect(storedFilesFor(id)).toEqual([]);
});

test("avatar upload: an unknown member is rejected and leaves no file behind", async () => {
  const bogus = crypto.randomUUID();
  const res = await call(avatarReq(bogus, { token: TOKEN, contentType: "image/png" }));
  expect(res?.status).toBe(404);
  expect(storedFilesFor(bogus)).toEqual([]);
});

// memberId is interpolated into a filesystem path (never SQL). Every real
// member id is a crypto.randomUUID() shape, so a non-UUID id is rejected
// BEFORE any path is built — proving this closed matters more than the 404
// itself: a memberId of "../../../../tmp/evil" would otherwise resolve
// path.join("<dir>/avatars/uploads", "../../../../tmp/evil") straight outside
// the upload directory.
test("avatar upload: a path-traversal member id is rejected and writes nothing outside the upload directory", async () => {
  const traversal = "../../../../tmp/rm-avatar-traversal-poc";
  const res = await call(avatarReq(encodeURIComponent(traversal), { token: TOKEN, contentType: "image/png" }));
  expect(res?.status).toBe(404);
  expect(existsSync("/tmp/rm-avatar-traversal-poc")).toBe(false);
  expect(existsSync("/tmp/rm-avatar-traversal-poc.png")).toBe(false);
});

test("avatar upload: STATIC_DIR unconfigured is a clear 500, not a silent no-op", async () => {
  const id = await seatMember();
  const res = await call(avatarReq(id, { token: TOKEN, contentType: "image/png" }), NO_STORAGE);
  expect(res?.status).toBe(500);
  expect((await rowOf(id)).avatar).toBeNull();
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
  const pathname = new URL(`http://x${avatarPath}`).pathname;
  const served = await serveStatic(pathname, storageDir);
  expect(served?.status).toBe(200);
  expect(new Uint8Array(await served!.arrayBuffer())).toEqual(PNG_BYTES);
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
