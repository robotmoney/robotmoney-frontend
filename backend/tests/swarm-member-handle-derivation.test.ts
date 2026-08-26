// Derive a member's public handle from its name (issue #562).
//
// WHAT THIS FILE PROTECTS. #593 gave every member a `handle` and defaulted it
// to the member's own id, which was right for the seeded roster and useless for
// anybody who applies: `applyMember` mints `id = crypto.randomUUID()`, so an
// accepted applicant was published at /swarm/members/8f3c1e0a-… forever. This
// file asserts the derivation that fixes it, over the REAL acceptance path —
// signed apply over HTTP, then the admin approve route — because acceptance is
// not an INSERT and the whole mechanism turns on that: the row already exists
// with a UUID handle by the time anybody approves it, so migration 0030's
// BEFORE INSERT trigger cannot carry this and the write has to be an UPDATE in
// activateMember.
//
// The three decisions #562 asked for, each asserted here rather than described:
//
//   1. DERIVE ONLY FROM 0030's UNTOUCHED DEFAULT (`handle = id`). An
//      administrator can already set a pending applicant's handle before
//      acceptance — updateMemberAdminTx is not status-gated — and an
//      unconditional derivation at approval would silently overwrite it.
//   2. COLLISIONS TAKE A DETERMINISTIC NUMERIC SUFFIX, never a refusal, and the
//      probe covers BOTH public namespaces (handle AND id), because 0031's
//      trigger refuses a handle equal to another member's id and that refusal
//      would reach the operator as a sanitized 500 on the approve button.
//   3. A NAME THAT SLUGIFIES TO EMPTY FALLS BACK TO A READABLE STEM, never to
//      the id — on the apply path the id IS the UUID this issue exists to keep
//      out of URLs.
//
// Shares the one ephemeral Postgres every other swarm test file uses
// (tests/preload.ts). A missing Docker/Postgres fails that preload loudly;
// nothing here skips.
import { test, expect } from "bun:test";
import { canonicalizeApplication, ROUTES, path as routePath } from "@robotmoney/contract";
import * as ic from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { slugifyMemberName, DEGENERATE_NAME_STEM } from "../src/swarm/handle.ts";
import { MEMBER_HANDLE_RE } from "../src/api/validation.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { sql } from "../src/db/client.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

const ADMIN_CFG = { adminToken: "s3cret-swarm-admin-token", allowInsecure: false } as const;
const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// Own database per TEST, cloned from the migrated template. Per-test, not
// per-file: countActiveMembers() is global and SWARM_ROSTER_CAP is enforced on
// every transition-to-active, so members seated by one test would make the
// next test's admission a spurious 409. Unique ids cannot fix that; a clean
// database can.
useCleanDatabasePerTest(import.meta.file);

async function callSwarm(req: Request): Promise<{ status: number; body: any }> {
  // api/index.ts sanitizes ANY escaped exception into `500 {"error":"internal
  // error"}`. Reproduce that mapping here so an escaped 23505 reads as
  // `expected 409, received 500` — the operator-visible failure — instead of
  // blowing the test up with a stack trace.
  try {
    return (await handleSwarm(req, new URL(req.url))) ?? { status: 404, body: null };
  } catch {
    return { status: 500, body: { error: "internal error" } };
  }
}

async function callAdmin(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_CFG.adminToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    return (await handleSwarmAdmin(req, new URL(req.url), ADMIN_CFG)) ?? { status: 404, body: null };
  } catch {
    return { status: 500, body: { error: "internal error" } };
  }
}

/** The public, signed apply — exactly the bytes an rmpc-equipped agent sends. */
async function applyAs(name: string): Promise<string> {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const application = { name, contact: `${rid("c")}@example.test`, publicKey: publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), privateKey);
  const res = await callSwarm(
    new Request(`http://localhost${ROUTES.swarm.apply}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...application, signature }),
    }),
  );
  if (res.status !== 201) throw new Error(`applyAs(${name}) failed: ${JSON.stringify(res)}`);
  return res.body.memberId as string;
}

const approve = (memberId: string) =>
  callAdmin("POST", routePath(ROUTES.swarm.admin.memberReview, { id: memberId }), { decision: "approve" });

const handleOf = async (memberId: string): Promise<string> => {
  const [row] = await sql<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE id = ${memberId}`;
  if (!row) throw new Error(`handleOf(): no member ${memberId}`);
  return row.handle;
};

const versionOf = async (memberId: string): Promise<number> => {
  const [row] = await sql<{ version: number }[]>`SELECT version FROM swarm_members WHERE id = ${memberId}`;
  if (!row) throw new Error(`versionOf(): no member ${memberId}`);
  return Number(row.version);
};

const getMemberRoute = (ref: string) => {
  const p = routePath(ROUTES.swarm.member, { id: ref });
  return callSwarm(new Request(`http://localhost${p}`));
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── 1. The acceptance path, end to end ──────────────────────────────────────

test("an applicant named 'Noop Analyst' is accepted as noop-analyst and is addressable at that URL — not at its UUID id", async () => {
  const memberId = await applyAs("Noop Analyst");
  // The row exists BEFORE acceptance, already carrying 0030's default — which
  // is the whole reason the derivation cannot live in an INSERT trigger.
  expect(memberId).toMatch(UUID_RE);
  expect(await handleOf(memberId)).toBe(memberId);

  const approved = await approve(memberId);
  expect(approved.status).toBe(200);

  expect(await handleOf(memberId)).toBe("noop-analyst");

  // The public route serves it under the new name…
  const byHandle = await getMemberRoute("noop-analyst");
  expect(byHandle.status).toBe(200);
  expect(byHandle.body.id).toBe(memberId);
  expect(byHandle.body.handle).toBe("noop-analyst");

  // …and the UUID still resolves, because it was published on the status page
  // the applicant was given at apply time and nothing may break it.
  const byId = await getMemberRoute(memberId);
  expect(byId.status).toBe(200);
  expect(byId.body.handle).toBe("noop-analyst");
});

// ── 2. Collisions: a deterministic numeric suffix, in BOTH namespaces ───────

test("a derived handle already held as another member's HANDLE takes the next numeric suffix, and acceptance is never blocked", async () => {
  const first = await applyAs("Noop Analyst");
  expect((await approve(first)).status).toBe(200);
  expect(await handleOf(first)).toBe("noop-analyst");

  const second = await applyAs("Noop Analyst");
  const approved = await approve(second);
  // NOT a 409. Refusing would block one applicant's onboarding on an unrelated
  // member's name, with nothing the approving administrator could do about it.
  expect(approved.status).toBe(200);
  expect(await handleOf(second)).toBe("noop-analyst-2");

  const third = await applyAs("Noop  Analyst!");
  expect((await approve(third)).status).toBe(200);
  expect(await handleOf(third)).toBe("noop-analyst-3");

  // Three distinct members, three distinct public names, all resolving to the
  // right row — a suffix rule that produced a duplicate would be worse than a
  // refusal, so this is asserted rather than assumed.
  for (const [ref, id] of [["noop-analyst", first], ["noop-analyst-2", second], ["noop-analyst-3", third]] as const) {
    expect((await getMemberRoute(ref)).body.id).toBe(id);
  }
});

test("a derived handle equal to another member's ID takes the suffix too — the probe covers both namespaces, so 0031's trigger never fires", async () => {
  // THE DEFECT THIS COVERS. `id` is a public URL segment as well (getMember
  // resolves `handle = $ref OR id = $ref`), so migration 0031's trigger refuses
  // a handle equal to another member's id with SQLSTATE 23505 — on an UPDATE as
  // well as an INSERT. A collision probe that searched `handle` alone would
  // pass here and then die in the trigger, and until this issue activateMember
  // had no isHandleUniqueViolation catch at all, so it would have escaped the
  // admin approve route as a sanitized 500.
  //
  // A raw insert, because this is the seeded-roster shape: a member whose id is
  // a readable word and whose handle is that same word (0030's default).
  await sql`INSERT INTO swarm_members (id, status, name) VALUES ('noop-analyst', 'active', 'The Incumbent')`;

  const memberId = await applyAs("Noop Analyst");
  const approved = await approve(memberId);
  expect(approved.status).toBe(200); // NOT 500, and not 409
  expect(await handleOf(memberId)).toBe("noop-analyst-2");

  // The incumbent is untouched: #562 declined renaming existing members, and
  // nothing in the derivation reads or rewrites another member's handle.
  expect(await handleOf("noop-analyst")).toBe("noop-analyst");
  expect((await getMemberRoute("noop-analyst")).body.id).toBe("noop-analyst");
});

test("the id namespace ALONE is enough to push the suffix — a member whose id is the slug but whose handle is not", async () => {
  // The narrower case the `handle = $h OR id = $h` predicate exists for: the
  // incumbent's HANDLE is something else entirely, so a handle-only probe finds
  // nothing free-standing wrong and hands back the contended name.
  await sql`INSERT INTO swarm_members (id, status, name, handle) VALUES ('macro-desk', 'active', 'Incumbent', 'renamed-desk')`;

  const memberId = await applyAs("Macro Desk");
  expect((await approve(memberId)).status).toBe(200);
  expect(await handleOf(memberId)).toBe("macro-desk-2");
  // /swarm/members/macro-desk still names the incumbent, by its legacy id.
  expect((await getMemberRoute("macro-desk")).body.id).toBe("macro-desk");
});

// ── 3. Degenerate names ─────────────────────────────────────────────────────

test("a name that slugifies to nothing gets a readable stem, NOT the UUID this issue exists to eliminate", async () => {
  const memberId = await applyAs("!!! ??? ***");
  expect((await approve(memberId)).status).toBe(200);

  const handle = await handleOf(memberId);
  expect(handle).toBe(DEGENERATE_NAME_STEM);
  expect(handle).not.toBe(memberId);
  expect(handle).not.toMatch(UUID_RE);
  expect(MEMBER_HANDLE_RE.test(handle)).toBe(true);
  expect((await getMemberRoute(DEGENERATE_NAME_STEM)).body.id).toBe(memberId);

  // Two degenerate names do not collide: the fallback reuses the same numeric
  // suffix rule rather than needing one of its own.
  const second = await applyAs("。。。");
  expect((await approve(second)).status).toBe(200);
  expect(await handleOf(second)).toBe(`${DEGENERATE_NAME_STEM}-2`);
});

// ── 4. Derive only from 0030's untouched default ────────────────────────────

test("a handle an administrator set BEFORE acceptance survives acceptance untouched", async () => {
  const memberId = await applyAs("Noop Analyst");
  // updateMemberAdminTx is not status-gated, so this already works today and an
  // unconditional derivation at approval would silently undo it.
  const preset = await admin.updateMemberAdmin(memberId, await versionOf(memberId), { handle: "chosen-by-hand" });
  expect(preset.status).toBe(200);

  expect((await approve(memberId)).status).toBe(200);
  expect(await handleOf(memberId)).toBe("chosen-by-hand");
  // …and the name-derived handle was never taken by anybody. #687: an
  // unresolvable ref is a deliberate 404, not a 200 with a null body.
  expect((await getMemberRoute("noop-analyst")).status).toBe(404);
});

test("a post-acceptance NAME edit moves neither the handle nor the public URL", async () => {
  const memberId = await applyAs("Noop Analyst");
  expect((await approve(memberId)).status).toBe(200);
  expect(await handleOf(memberId)).toBe("noop-analyst");

  const renamed = await admin.updateMemberAdmin(memberId, await versionOf(memberId), { name: "Macro Desk" });
  expect(renamed.status).toBe(200);
  expect((renamed as any).member.name).toBe("Macro Desk");

  // THE ASSERTION. A handle is a published URL; repointing it every time an
  // operator corrects a display name would break every link already shared, so
  // changing it stays a separate, audited act.
  expect(await handleOf(memberId)).toBe("noop-analyst");
  expect((await getMemberRoute("noop-analyst")).body.id).toBe(memberId);
  // #687: a ref that resolves to nothing is a deliberate 404, not a 200 with
  // a null body.
  expect((await getMemberRoute("macro-desk")).status).toBe(404);

  // An administrator can still move it at any time — that capability is what
  // the automatic derivation must not replace.
  const moved = await admin.updateMemberAdmin(memberId, await versionOf(memberId), { handle: "macro-desk" });
  expect(moved.status).toBe(200);
  expect(await handleOf(memberId)).toBe("macro-desk");
});

// ── 5. The other two create paths derive as well ────────────────────────────

test("registerMember derives on creation and NEVER on the idempotent re-registration", async () => {
  const id = rid("reg");
  const { publicKeyB64 } = await generateKeyPair();
  const first = await ic.registerMember({ memberId: id, name: "Helios Liquidity", publicKey: publicKeyB64 });
  expect("token" in first).toBe(true);
  expect(await handleOf(id)).toBe("helios-liquidity");

  // An administrator renames the member; the smoke harness then re-runs.
  expect((await admin.updateMemberAdmin(id, await versionOf(id), { handle: "helios" })).status).toBe(200);
  const again = await ic.registerMember({ memberId: id, name: "Helios Liquidity", publicKey: publicKeyB64 });
  expect("token" in again).toBe(true);
  // The rename survived: re-registering must not move a published URL back.
  expect(await handleOf(id)).toBe("helios");
});

test("the admin manual add derives from the name, and the MINTED memberId still resolves", async () => {
  const { publicKeyB64 } = await generateKeyPair();
  // No memberId in the body since issue #690 — the route mints one and refuses
  // a body that names one. The derivation rule under test is unchanged: the
  // handle is the slug of the DISPLAY NAME, never the id.
  const added = await callAdmin("POST", ROUTES.swarm.admin.members, {
    name: "Noop Analyst",
    publicKey: publicKeyB64,
  });
  expect(added.status).toBe(201);
  expect(added.body.member.handle).toBe("noop-analyst");
  const memberId = added.body.member.id as string;
  expect(memberId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await handleOf(memberId)).toBe("noop-analyst");
  // The id is still a public reference: getMember resolves handle OR id, which
  // is what keeps a link published under the id alive after any later rename.
  expect((await getMemberRoute(memberId)).body.id).toBe(memberId);
});

// ── 6. Nothing backfills or rewrites an existing member's handle ────────────

test("seating new members leaves every existing member's handle exactly where it was", async () => {
  // The seeded roster's shape: raw inserts naming no handle, so 0030's default
  // publishes each of them under its own id. #562 declined renaming them.
  for (const seeded of ["woon", "athena", "robotmoney"]) {
    await sql`INSERT INTO swarm_members (id, status, name) VALUES (${seeded}, 'active', ${seeded})`;
  }
  const before = await sql<{ id: string; handle: string }[]>`
    SELECT id, handle FROM swarm_members ORDER BY id`;

  const applicant = await applyAs("Woon");
  expect((await approve(applicant)).status).toBe(200);
  // The new member takes the suffix; the incumbent keeps the bare name.
  expect(await handleOf(applicant)).toBe("woon-2");

  const after = await sql<{ id: string; handle: string }[]>`
    SELECT id, handle FROM swarm_members WHERE id IN ('woon', 'athena', 'robotmoney') ORDER BY id`;
  expect(after).toEqual(before);
});

// ── 7. The slug is TOTAL over the shape the validator accepts ──────────────

test("slugifyMemberName always produces something MEMBER_HANDLE_RE accepts", async () => {
  const corpus = [
    "Noop Analyst", "  leading and trailing  ", "UPPER CASE", "Renée Muñoz", "Ǆungla",
    "hyphen--collapse", "-edges-", "punctuation!@#$%^&*()name", "digits 123 456",
    "", "!!!", "。。。", "—", "​", "ß", "Ω",
    "a".repeat(300), `${"b".repeat(71)} c`, "x".repeat(72) + "-y",
  ];
  for (const name of corpus) {
    const slug = slugifyMemberName(name);
    expect(MEMBER_HANDLE_RE.test(slug)).toBe(true);
    // 80 is the admin route's `requiredString(body, "handle", 80)` budget: a
    // handle the system derives must be one an operator can re-type.
    expect(slug.length).toBeLessThanOrEqual(80);
  }
  // Same input, same answer — the suffix rule's determinism starts here.
  expect(slugifyMemberName("Noop Analyst")).toBe(slugifyMemberName("noop   analyst"));
  expect(slugifyMemberName("Renée Muñoz")).toBe("renee-munoz");
});

// ── 8. The race a probe cannot close is a 409, never a 500 ─────────────────

// Block until a statement matching `fragment` is genuinely waiting on a lock,
// which is the only proof the write passed its probe and reached the index.
// Times out LOUDLY: a silent give-up would turn a race test into a test of the
// probe, which every test above already covers.
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

test("a rename committing between the derivation probe and the acceptance UPDATE is a 409 on approve, never a 500", async () => {
  // THE BRANCH NO OTHER TEST REACHES. Before #562 activateMember never wrote
  // `handle`, so it had no isHandleUniqueViolation catch — unlike its two
  // sibling create paths, which grew one in #596. It writes a handle now, and
  // its probe is a READ COMMITTED SELECT that cannot see an uncommitted rename,
  // so without the catch this lost race leaves the admin approve route
  // answering `500 internal error` for an ordinary naming collision.
  const incumbentId = rid("incumbent");
  await sql`INSERT INTO swarm_members (id, status, name) VALUES (${incumbentId}, 'active', 'Incumbent')`;
  const applicantId = await applyAs("Noop Analyst");

  // Administrator 1's rename to the contended name, applied but UNCOMMITTED.
  let renameApplied!: () => void;
  let commitRename!: () => void;
  const renameLanded = new Promise<void>((resolve) => { renameApplied = resolve; });
  const renameHeld = new Promise<void>((resolve) => { commitRename = resolve; });
  const renamer = sql.begin(async (tx) => {
    await tx`UPDATE swarm_members SET handle = 'noop-analyst' WHERE id = ${incumbentId}`;
    renameApplied();
    await renameHeld;
  });
  await renameLanded;

  // Administrator 2 approves the applicant. Its probe legitimately finds
  // `noop-analyst` free, and the UPDATE then parks on swarm_members_handle_key.
  const approving = approve(applicantId);
  await waitUntilBlockedOn("UPDATE swarm_members", "the derivation probe→UPDATE race at acceptance");
  commitRename();
  await renamer;

  const raced = await approving;
  // THE ASSERTION. `500` here is what an escaped 23505 is sanitized to, and it
  // is what this route did before the catch existed.
  expect(raced.status).toBe(409);
  expect(raced.body.error).toBe("handle already taken");

  // The loser wrote NOTHING — the whole activation transaction rolled back, so
  // the applicant is still an applicant and can simply be approved again.
  const [row] = await sql<{ status: string; handle: string }[]>`
    SELECT status, handle FROM swarm_members WHERE id = ${applicantId}`;
  expect(row!.status).toBe("applied");
  expect(row!.handle).toBe(applicantId);

  // …and the retry succeeds, taking the suffix the winner left free.
  expect((await approve(applicantId)).status).toBe(200);
  expect(await handleOf(applicantId)).toBe("noop-analyst-2");
});
