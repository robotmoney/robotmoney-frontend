// Integration coverage for the v0 Investment Committee archive bootstrap
// (issue #467), against the SAME ephemeral Postgres the rest of the suite
// uses. Runs the REAL committed archive (seed-data/v0-committee-archive.json.gz)
// through the REAL runV0SeedBootstrap() core against a clean schema and proves
// the contractual behaviors:
//   • cold DB: every dataset in the archive lands — members, subjects,
//     sessions, takes, snapshots, briefs — at exactly the manifest's counts
//   • takes go to swarm_recommendations (NOT a legacy column) and report
//     verified=false, because the archival signing key is not a member key
//   • idempotent: a second run against the now-seeded DB is a clean no-op
//   • drift-detection: a deliberate mutation of an existing row is reported
//     field-by-field and NEVER silently overwritten
//   • PROVENANCE: every take is filed at the timestamp v0 recorded, never at
//     the bootstrap run's clock, and is signed by the published archival key —
//     with drift detection over both (review-data-integrity F1 and F3)
//   • the read boundary reports these rows as ARCHIVAL, which is not the same
//     statement as a failed signature check (F2)
//   • CONVERGENCE with src/swarm/roster-seed.ts's seedLiveRoster(), the other
//     writer of the two members they share: either ordering leaves zero member
//     drift (issue #540)
//
// Counts are read from the archive manifest rather than hard-coded, so
// regenerating the artifact (scripts/v0-seed-regenerate.ts) against a newer
// v0-archive commit does not turn this file red for the wrong reason. The
// per-dataset ASSERTIONS are still exact — "everything in the archive landed",
// not "some rows landed".
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { runV0SeedBootstrap } from "../scripts/v0-seed-bootstrap.ts";
import { loadV0Archive, V0_ARCHIVE_PUBLIC_KEY_B64 } from "../src/swarm/v0-archive.ts";
import { verifyStoredSubmissionSignature } from "../src/lib/signing.ts";
import { getMemberTakes, getSession, getTakeReceipt } from "../src/swarm/domain.ts";
import { LIVE_ROSTER_HANDLES, seedLiveRoster } from "../src/swarm/roster-seed.ts";

// The archive's member ids are HANDLES in the database (issue #685): the
// importer resolves them to whatever id this deployment holds, so no test can
// name a member id. Address members by handle and let SQL resolve the id.
const MEMBER_HANDLES = ["athena", "robot-money", "noop-analyst"];
/** Sub-select every test uses instead of a literal id list. */
const MEMBER_IDS_SQL = sql`SELECT id FROM swarm_members WHERE handle = ANY(${MEMBER_HANDLES})`;
const SUBJECT_IDS = ["robotmoney-allocation", "robotmoney-treasury", "robotmoney-vault", "woon"];

// No key is set: the importer uses the PUBLISHED archival key
// (v0-archive.ts). Any ambient V0_ARCHIVE_SIGNING_KEY is cleared so the
// signature assertions below are about the key this repo actually ships with,
// not whatever happens to be exported in the runner's environment.
beforeAll(() => {
  delete process.env.V0_ARCHIVE_SIGNING_KEY;
});

async function cleanArchiveRows(): Promise<void> {
  // Reverse dependency order. swarm_recommendations cascades from sessions,
  // but delete it explicitly so a failure here is about this table rather than
  // a surprise about cascade behavior.
  await sql`DELETE FROM swarm_recommendations WHERE subject_id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_briefs WHERE subject_id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_subject_snapshots WHERE subject_id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_sessions WHERE subject_id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_subjects WHERE id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_members WHERE handle = ANY(${MEMBER_HANDLES})`;
}

beforeEach(cleanArchiveRows);
afterEach(cleanArchiveRows);

test("cold DB: every dataset in the archive is inserted at its manifest count", async () => {
  const { payload, manifest } = await loadV0Archive();
  const expectedTakes = payload.sessions.reduce((n, s) => n + (s.takes?.length ?? 0), 0);
  expect(expectedTakes).toBeGreaterThan(0); // the archive must actually carry takes

  const result = await runV0SeedBootstrap();

  expect(result.members).toEqual({ inserted: manifest.counts.members, unchanged: 0, drifted: 0, total: manifest.counts.members });
  expect(result.subjects).toEqual({ inserted: manifest.counts.subjects, unchanged: 0, drifted: 0, total: manifest.counts.subjects });
  expect(result.sessions).toEqual({ inserted: manifest.counts.sessions, unchanged: 0, drifted: 0, total: manifest.counts.sessions });
  expect(result.takes).toEqual({ inserted: expectedTakes, unchanged: 0, drifted: 0, total: expectedTakes });
  expect(result.snapshots).toEqual({ inserted: manifest.counts.snapshots, unchanged: 0, drifted: 0, total: manifest.counts.snapshots });
  expect(result.briefs).toEqual({ inserted: manifest.counts.briefs, unchanged: 0, drifted: 0, total: manifest.counts.briefs });
  expect(result.drifts).toEqual([]);

  const count = async (table: string, col: string, ids: string[]) =>
    (await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE ${sql(col)} = ANY(${ids})`)[0].n;

  expect(await count("swarm_members", "handle", MEMBER_HANDLES)).toBe(manifest.counts.members);
  expect(await count("swarm_subjects", "id", SUBJECT_IDS)).toBe(manifest.counts.subjects);
  expect(await count("swarm_sessions", "subject_id", SUBJECT_IDS)).toBe(manifest.counts.sessions);
  expect(await count("swarm_recommendations", "subject_id", SUBJECT_IDS)).toBe(expectedTakes);
  expect(await count("swarm_subject_snapshots", "subject_id", SUBJECT_IDS)).toBe(manifest.counts.snapshots);
  expect(await count("swarm_briefs", "subject_id", SUBJECT_IDS)).toBe(manifest.counts.briefs);
});

test("takes land in swarm_recommendations, signed but NOT verifiable as a member submission", async () => {
  await runV0SeedBootstrap();

  const rows = await sql<{ member_handle: string; nonce: string; signature: string; payload: Record<string, unknown>; body: string }[]>`
    SELECT m.handle AS member_handle, r.nonce, r.signature, r.payload, r.body
    FROM swarm_recommendations r JOIN swarm_members m ON m.id = r.member_id
    WHERE r.subject_id = ANY(${SUBJECT_IDS}) ORDER BY r.date, m.handle LIMIT 5`;
  expect(rows.length).toBe(5);

  for (const r of rows) {
    // A REAL signature, not a placeholder: non-empty, base64, 64 raw bytes.
    expect(Buffer.from(r.signature, "base64").length).toBe(64);
    // Deterministic, reconstructible nonce — what makes the import idempotent.
    expect(r.nonce.startsWith("v0-archive-")).toBe(true);
    // The payload is the canonical submission shape a live member signs — and
    // its memberId is the ARCHIVE's signer slug, deliberately NOT the FK
    // (issue #685): the FK is this deployment's generated id, while the signed
    // bytes must keep naming who authored the take. Asserting they are equal
    // is what welded the archive to a slug-id namespace.
    expect(r.payload.memberId).toBe(r.member_handle);
    expect(r.payload.body).toBe(r.body);
  }

  // The archival key is deliberately NOT registered in swarm_member_keys, so
  // the read path cannot verify these against a member and must not claim to.
  const keyRows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_member_keys WHERE member_id IN (${MEMBER_IDS_SQL}) AND active`;
  expect(keyRows[0].n).toBe(0);

  // Stored verified flag is false, and re-verification against any member key
  // would fail too — belt and braces, since toVerifiedTake() recomputes it.
  const [{ n: verifiedCount }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_recommendations WHERE subject_id = ANY(${SUBJECT_IDS}) AND verified`;
  expect(verifiedCount).toBe(0);

  const someone = rows[0];
  const bogus = await verifyStoredSubmissionSignature({
    submission: someone.payload as never,
    signatureB64: someone.signature,
    publicKeyB64: Buffer.alloc(32).toString("base64"),
  });
  expect(bogus).toBe(false);
});

test("idempotent: a second run against the now-seeded DB is a clean no-op", async () => {
  const { payload, manifest } = await loadV0Archive();
  const expectedTakes = payload.sessions.reduce((n, s) => n + (s.takes?.length ?? 0), 0);

  const first = await runV0SeedBootstrap();
  expect(first.drifts).toEqual([]);
  expect(first.sessions.inserted).toBe(manifest.counts.sessions);
  expect(first.takes.inserted).toBe(expectedTakes);

  const second = await runV0SeedBootstrap();
  expect(second.members.inserted).toBe(0);
  expect(second.subjects.inserted).toBe(0);
  expect(second.sessions).toEqual({ inserted: 0, unchanged: manifest.counts.sessions, drifted: 0, total: manifest.counts.sessions });
  expect(second.takes).toEqual({ inserted: 0, unchanged: expectedTakes, drifted: 0, total: expectedTakes });
  expect(second.snapshots).toEqual({ inserted: 0, unchanged: manifest.counts.snapshots, drifted: 0, total: manifest.counts.snapshots });
  expect(second.briefs).toEqual({ inserted: 0, unchanged: manifest.counts.briefs, drifted: 0, total: manifest.counts.briefs });
  expect(second.drifts).toEqual([]);

  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_recommendations WHERE subject_id = ANY(${SUBJECT_IDS})`;
  expect(n).toBe(expectedTakes);
});

test("drift: a mutated existing member field is reported field-by-field and never silently overwritten", async () => {
  await runV0SeedBootstrap();

  const { payload } = await loadV0Archive();
  const athena = payload.members.find((m) => m.id === "athena")!;
  const mutatedTagline = "MUTATED — this should never be overwritten by the archive";
  await sql`UPDATE swarm_members SET tagline = ${mutatedTagline} WHERE handle = 'athena'`;

  const result = await runV0SeedBootstrap();

  expect(result.members).toEqual({ inserted: 0, unchanged: 2, drifted: 1, total: 3 });
  expect(result.drifts).toEqual([
    {
      entity: "swarm_members",
      naturalKey: "handle=athena",
      field: "tagline",
      oldValue: mutatedTagline,
      newValue: athena.tagline,
    },
  ]);

  const [{ tagline }] = await sql<{ tagline: string }[]>`SELECT tagline FROM swarm_members WHERE id = 'athena'`;
  expect(tagline).toBe(mutatedTagline);
});

test("drift: a mutated take body is reported and never silently overwritten", async () => {
  await runV0SeedBootstrap();

  const [target] = await sql<{ id: string; member_id: string; body: string }[]>`
    SELECT id, member_id, body FROM swarm_recommendations
    WHERE subject_id = 'woon' ORDER BY date, member_id LIMIT 1`;
  const tampered = "TAMPERED — a take body that the archive must not overwrite";
  await sql`UPDATE swarm_recommendations SET body = ${tampered} WHERE id = ${target.id}`;

  const result = await runV0SeedBootstrap();

  expect(result.takes.inserted).toBe(0);
  expect(result.takes.drifted).toBe(1);

  const drift = result.drifts.find((d) => d.entity === "swarm_recommendations" && d.field === "body");
  expect(drift).toBeDefined();
  expect(drift!.oldValue).toBe(tampered);
  expect(drift!.newValue).toBe(target.body);

  const [{ body }] = await sql<{ body: string }[]>`SELECT body FROM swarm_recommendations WHERE id = ${target.id}`;
  expect(body).toBe(tampered);
});

test("snapshots and briefs carry real content, not empty rows", async () => {
  await runV0SeedBootstrap();

  const [snap] = await sql<{ positions: unknown[]; total_value_usd: string | null }[]>`
    SELECT positions, total_value_usd FROM swarm_subject_snapshots
    WHERE subject_id = ANY(${SUBJECT_IDS}) AND jsonb_array_length(positions) > 0 LIMIT 1`;
  expect(snap).toBeDefined();
  expect(Array.isArray(snap.positions)).toBe(true);
  expect(snap.positions.length).toBeGreaterThan(0);

  const [brief] = await sql<{ body: Record<string, unknown> }[]>`
    SELECT body FROM swarm_briefs WHERE subject_id = ANY(${SUBJECT_IDS}) LIMIT 1`;
  expect(brief).toBeDefined();
  expect(Object.keys(brief.body).length).toBeGreaterThan(0);
});

// ── Briefs land on their SESSION (issue #574, migration 0028) ───────────────
//
// The importer's brief natural key was `(date, subject_id)` — the same day key
// 0028 removed from the schema — and this script is replayed on EVERY
// production boot via prod-bootstrap. It has to write session_id or the archive
// re-imports as 73 sessionless rows on a database whose briefs are keyed on the
// session, and the second boot's drift check has nothing stable to match.
//
// v0 kept a brief for some days whose session it never exported, so a subset of
// the archive genuinely has no session to attach to. Those import with
// session_id NULL rather than being dropped — 0028 allows exactly that — and
// the import must stay idempotent for them too.
test("v0 briefs attach to their own archived session, and sessionless archive days import as NULL rather than being dropped", async () => {
  const { payload, manifest } = await loadV0Archive();
  const sessionDays = new Set(payload.sessions.map((s) => `${s.subject_id}/${s.date}`));
  const expectedAttached = payload.briefs.filter((b) => sessionDays.has(`${b.subject_id}/${b.date}`)).length;
  const expectedSessionless = payload.briefs.length - expectedAttached;
  // The archive must actually carry BOTH shapes or this test proves nothing.
  expect(expectedAttached).toBeGreaterThan(0);
  expect(expectedSessionless).toBeGreaterThan(0);

  await runV0SeedBootstrap();

  const rows = await sql<{ session_id: string | null; date: Date; subject_id: string }[]>`
    SELECT b.session_id, b.date, b.subject_id FROM swarm_briefs b
    WHERE b.subject_id = ANY(${SUBJECT_IDS})`;
  expect(rows.length).toBe(manifest.counts.briefs);
  expect(rows.filter((r) => r.session_id !== null).length).toBe(expectedAttached);
  expect(rows.filter((r) => r.session_id === null).length).toBe(expectedSessionless);

  // Every attached brief points at the session of its OWN subject and day —
  // never at some other day's session that happened to be handy.
  const [{ n: mismatched }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_briefs b
    JOIN swarm_sessions s ON s.id = b.session_id
    WHERE b.subject_id = ANY(${SUBJECT_IDS}) AND (s.subject_id <> b.subject_id OR s.date <> b.date)`;
  expect(mismatched).toBe(0);

  // Replay (what prod-bootstrap does on every boot): all 73 read as unchanged,
  // both shapes, with nothing inserted twice and no drift reported.
  const second = await runV0SeedBootstrap();
  expect(second.briefs).toEqual({ inserted: 0, unchanged: manifest.counts.briefs, drifted: 0, total: manifest.counts.briefs });
  expect(second.drifts).toEqual([]);
  const [{ n: after }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_briefs WHERE subject_id = ANY(${SUBJECT_IDS})`;
  expect(after).toBe(manifest.counts.briefs);
});

// ── Provenance (review-data-integrity F1) ───────────────────────────────────
//
// swarm_recommendations.received_at is NOT NULL DEFAULT now(), so an INSERT
// that omits it does not leave the column empty — it stamps the bootstrap
// run's wall clock on all 216 archive takes and calls that their filing time.
// /swarm/takes/<id> renders exactly that value as "Filed <date> <HH:MM> UTC",
// and the table is append-only, so the correction after a bad import is a
// DELETE rather than a rerun.
//
// RED CONTROL. Dropping `received_at` from the INSERT and from the drift field
// list in processTake() — i.e. reverting to the reviewed head — makes both
// tests below fail: the first on the very first take (received_at is the run
// clock, not 2026-05-25T01:33:30.430Z), the second because the mutation is
// never reported. The "run start" assertion is the half that cannot be
// satisfied by any constant: it fails for anything derived from now().
test("every imported take is filed at the artifact's generated_at, never at the run clock", async () => {
  const runStart = new Date();
  await runV0SeedBootstrap();

  const { payload } = await loadV0Archive();
  const expected = new Map<string, string>();
  for (const sess of payload.sessions) {
    for (const take of sess.takes ?? []) {
      expected.set(`${sess.subject_id}|${sess.date}|${take.member_id}`, (take.generated_at ?? sess.generated_at)!);
    }
  }
  expect(expected.size).toBeGreaterThan(0);

  const rows = await sql<{ subject_id: string; date: string; member_handle: string; received_at: Date }[]>`
    SELECT r.subject_id, to_char(r.date, 'YYYY-MM-DD') AS date, m.handle AS member_handle, r.received_at
    FROM swarm_recommendations r JOIN swarm_members m ON m.id = r.member_id
    WHERE r.subject_id = ANY(${SUBJECT_IDS})`;
  expect(rows.length).toBe(expected.size);

  for (const r of rows) {
    const key = `${r.subject_id}|${r.date}|${r.member_handle}`;
    const want = expected.get(key);
    expect(want).toBeDefined();
    expect(new Date(r.received_at).toISOString()).toBe(new Date(want!).toISOString());
    // The property no constant can fake: v0 filed these before this process
    // existed, so not one of them may carry a timestamp from this run.
    expect(new Date(r.received_at).getTime()).toBeLessThan(runStart.getTime());
  }
});

test("drift: a mutated received_at is reported and never silently overwritten", async () => {
  await runV0SeedBootstrap();

  const [target] = await sql<{ id: string; received_at: Date }[]>`
    SELECT id, received_at FROM swarm_recommendations
    WHERE subject_id = 'woon' ORDER BY date, member_id LIMIT 1`;
  const tampered = "2020-01-01T00:00:00.000Z";
  await sql`UPDATE swarm_recommendations SET received_at = ${tampered} WHERE id = ${target.id}`;

  const result = await runV0SeedBootstrap();

  expect(result.takes.inserted).toBe(0);
  expect(result.takes.drifted).toBe(1);
  const drift = result.drifts.find((d) => d.entity === "swarm_recommendations" && d.field === "received_at");
  expect(drift).toBeDefined();
  expect(new Date(drift!.oldValue as string).toISOString()).toBe(tampered);
  expect(new Date(drift!.newValue as string).toISOString()).toBe(new Date(target.received_at).toISOString());

  const [{ received_at }] = await sql<{ received_at: Date }[]>`
    SELECT received_at FROM swarm_recommendations WHERE id = ${target.id}`;
  expect(new Date(received_at).toISOString()).toBe(tampered);
});

// ── Attributable signatures (F3) ────────────────────────────────────────────
//
// The archival key used to be minted per run and discarded, so nobody —
// including us — could say which key signed a given archive row, and an import
// interrupted under one key and resumed under another was undetectable
// (`signature` was not drift-checked). The key is now published and the column
// is drift-checked, which is what these two assert.
test("every imported take verifies against the PUBLISHED archival key, and only that key", async () => {
  await runV0SeedBootstrap();

  const rows = await sql<{ signature: string; payload: Record<string, unknown> }[]>`
    SELECT signature, payload FROM swarm_recommendations WHERE subject_id = ANY(${SUBJECT_IDS})`;
  expect(rows.length).toBeGreaterThan(0);

  for (const r of rows) {
    const ok = await verifyStoredSubmissionSignature({
      submission: r.payload as never,
      signatureB64: r.signature,
      publicKeyB64: V0_ARCHIVE_PUBLIC_KEY_B64,
    });
    expect(ok).toBe(true);
  }

  // Attributable is not the same as authoritative: the archival key is still
  // deliberately absent from swarm_member_keys, so no read path can ever
  // report one of these as a verified member submission.
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_member_keys WHERE member_id IN (${MEMBER_IDS_SQL}) AND active`;
  expect(n).toBe(0);
});

test("drift: a take signed by a different key is reported rather than read as unchanged", async () => {
  await runV0SeedBootstrap();

  const [target] = await sql<{ id: string; signature: string }[]>`
    SELECT id, signature FROM swarm_recommendations
    WHERE subject_id = 'woon' ORDER BY date, member_id LIMIT 1`;
  // What a resumed import under a second archival key leaves behind: a valid
  // 64-byte Ed25519 signature over the same payload, made by someone else.
  const foreign = Buffer.alloc(64, 7).toString("base64");
  await sql`UPDATE swarm_recommendations SET signature = ${foreign} WHERE id = ${target.id}`;

  const result = await runV0SeedBootstrap();

  expect(result.takes.drifted).toBe(1);
  const drift = result.drifts.find((d) => d.entity === "swarm_recommendations" && d.field === "signature");
  expect(drift).toBeDefined();
  expect(drift!.oldValue).toBe(foreign);
  expect(drift!.newValue).toBe(target.signature);
});

// ── The read boundary tells archival from failed-verification (F2) ──────────
//
// verified:false answers "did this member's signature check out". For these
// rows nothing was ever checked — they predate member key registration — and
// the public surfaces rendered the false case as "this take's signature did
// not check out. Treat it as unattributed." The projection now carries the
// distinction, on all three read paths that serve takes.
test("all three read paths report imported takes as archival, not as failed verification", async () => {
  await runV0SeedBootstrap();

  const detail = await getSession("2026-06-25", "woon");
  expect(detail).not.toBeNull();
  expect(detail!.takes.length).toBeGreaterThan(0);
  for (const t of detail!.takes) {
    expect(t.archival).toBe(true);
    expect(t.verified).toBe(false);
    // The filing time the receipt page renders, straight off the read path.
    expect(t.receivedAt.startsWith("2026-06-25")).toBe(true);
  }

  const record = await getMemberTakes("woon", 50);
  expect(record.takes.length).toBeGreaterThan(0);
  expect(record.takes.every((r) => r.take.archival === true)).toBe(true);

  const receipt = await getTakeReceipt(detail!.takes[0].id);
  expect(receipt).not.toBeNull();
  expect(receipt!.take.archival).toBe(true);
  expect(receipt!.take.verified).toBe(false);
  // No member key is registered for an archival take, so the receipt cannot
  // offer a fingerprint to check it against — and must not invent one.
  expect(receipt!.signer.publicKeyFingerprint).toBeNull();
});

// ── Convergence with the live-roster seeder (issue #540) ────────────────────
//
// Two pipelines write the SAME swarm_members rows for athena and robotmoney:
// this backfill (v0's history) and src/swarm/roster-seed.ts's seedLiveRoster()
// (who is seated now, from the committed manifests). They disagreed on two
// things, and whichever ran second reported the disagreement as member drift —
// which prod-bootstrap.ts turns into a non-zero exit, blocking the production
// bootstrap path for rows nobody had edited:
//   • the jsonb `avatar` column's `.path` — v0 published /avatars/committee/,
//     the manifests publish /avatars/swarm/ (there is no `avatar_url` column);
//   • voice_md and submit, which the seeder does not own and leaves NULL.
//
// Both orderings are covered below, because BOTH happen: an existing
// deployment ran the backfill first, and a cold `bun run prod-bootstrap` runs
// the seeder first (step 1's migrate() calls seed()).
//
// RED CONTROL, both halves measured against the reviewed head:
//   • dropping canonicalizeAvatar()'s call in scripts/v0-seed-bootstrap.ts
//     turns 4 of the 4 tests below red on `avatar`;
//   • emptying its fill-empty-columns list turns 2 red — ordering B, on
//     voice_md and submit, and the never-overwrite test, whose drifted count
//     goes 1 -> 2.
// Neither half can be satisfied by a constant: the expected avatar object is
// read from the committed manifest on disk, and the expected voice_md/submit
// are read from the archive artifact.
const MANIFEST_DIR = join(import.meta.dir, "..", "..", "frontend", "public", "data", "swarm", "manifests", "members");

function manifestAvatar(id: string): unknown {
  return JSON.parse(readFileSync(join(MANIFEST_DIR, `${id}.json`), "utf8")).avatar;
}

test("v0's pre-rename avatar paths land canonicalized, byte-identical to the committed manifests", async () => {
  // The ARTIFACT is untouched: the rewrite belongs to the importer, never to
  // seed-data/. If this half ever goes green by editing the archive instead,
  // it is this assertion that turns red.
  const { payload } = await loadV0Archive();
  expect(payload.members.length).toBe(3);
  for (const m of payload.members) {
    expect((m.avatar as { path: string }).path).toBe(`/avatars/committee/${m.id}.jpg`);
  }

  await runV0SeedBootstrap();

  const rows = await sql<{ id: string; avatar: Record<string, unknown> }[]>`
    SELECT handle, avatar FROM swarm_members WHERE handle = ANY(${MEMBER_HANDLES}) ORDER BY handle`;
  expect(rows.length).toBe(3);
  for (const r of rows) {
    expect(r.avatar.path).toBe(`/avatars/swarm/${r.handle}.jpg`);
    // Not merely "starts with /avatars/swarm/": the whole avatar object must
    // equal what the site publishes for that member, credit and source_url
    // included.
    expect(r.avatar).toEqual(manifestAvatar(r.handle) as Record<string, unknown>);
  }
});

test("ordering A — backfill, then seedLiveRoster: a following bootstrap comparison reports zero member drift", async () => {
  await runV0SeedBootstrap();
  expect(await seedLiveRoster()).toBe(LIVE_ROSTER_HANDLES.length);

  const result = await runV0SeedBootstrap();
  expect(result.members).toEqual({ inserted: 0, unchanged: 3, drifted: 0, total: 3 });
  expect(result.drifts).toEqual([]);

  // The seeder rewrote `avatar` from the manifests; the archive agrees with it.
  const rows = await sql<{ id: string; avatar: Record<string, unknown> }[]>`
    SELECT handle, avatar FROM swarm_members WHERE handle = ANY(${MEMBER_HANDLES}) ORDER BY handle`;
  for (const r of rows) expect(r.avatar.path).toBe(`/avatars/swarm/${r.handle}.jpg`);
});

test("ordering B — seedLiveRoster, then backfill (what prod-bootstrap itself produces): also zero member drift", async () => {
  expect(await seedLiveRoster()).toBe(LIVE_ROSTER_HANDLES.length);

  // The seeder owns only the manifests' profile columns, so the two rows it
  // seats carry no voice_md and no submit — the state the backfill must
  // complete rather than call drift.
  const before = await sql<{ id: string; voice_md: string | null; submit: unknown }[]>`
    SELECT handle, voice_md, submit FROM swarm_members WHERE handle = ANY(${[...LIVE_ROSTER_HANDLES]}) ORDER BY handle`;
  expect(before.length).toBe(LIVE_ROSTER_HANDLES.length);
  for (const r of before) {
    expect(r.voice_md).toBeNull();
    expect(r.submit).toBeNull();
  }

  const result = await runV0SeedBootstrap();
  // Only woon is genuinely new; the two seeded rows are completed in place.
  expect(result.members).toEqual({ inserted: 1, unchanged: 2, drifted: 0, total: 3 });
  expect(result.drifts).toEqual([]);

  const { payload } = await loadV0Archive();
  const after = await sql<{ id: string; voice_md: string | null; submit: unknown; avatar: Record<string, unknown> }[]>`
    SELECT handle, voice_md, submit, avatar FROM swarm_members WHERE handle = ANY(${MEMBER_HANDLES}) ORDER BY handle`;
  expect(after.length).toBe(3);
  for (const r of after) {
    const archived = payload.members.find((m) => m.id === r.id)!;
    expect(r.voice_md).toBe(archived.voice_md as string);
    expect(r.voice_md!.length).toBeGreaterThan(0);
    expect(r.submit ?? null).toEqual((archived.submit ?? null) as never);
    expect(r.avatar.path).toBe(`/avatars/swarm/${r.handle}.jpg`);
  }
  // robotmoney is the member whose archive `submit` is a real object, so the
  // fill above is not vacuously true for every row.
  expect(after.find((r) => r.id === "robotmoney")!.submit).not.toBeNull();

  // Convergence, not oscillation: a third pass writes nothing more.
  const third = await runV0SeedBootstrap();
  expect(third.members).toEqual({ inserted: 0, unchanged: 3, drifted: 0, total: 3 });
  expect(third.drifts).toEqual([]);
});

test("the reconciliation still never overwrites a non-empty column, and touches no credential or lifecycle timestamp", async () => {
  await seedLiveRoster();
  const applied = "2026-01-02T03:04:05.000Z";
  const activated = "2026-01-03T04:05:06.000Z";
  await sql`
    UPDATE swarm_members
       SET applied_at = ${applied}, activated_at = ${activated},
           key_hash = 'hash_540', public_key = 'pk_540',
           tagline = 'OPERATOR EDIT — must survive the backfill'
     WHERE handle = 'athena'`;

  const result = await runV0SeedBootstrap();

  // A non-empty column that differs is still reported, never overwritten.
  expect(result.members.drifted).toBe(1);
  const drift = result.drifts.find((d) => d.entity === "swarm_members" && d.field === "tagline");
  expect(drift).toBeDefined();
  expect(drift!.oldValue).toBe("OPERATOR EDIT — must survive the backfill");

  const [row] = await sql<
    { tagline: string; applied_at: Date | null; activated_at: Date | null; key_hash: string | null; public_key: string | null }[]
  >`SELECT tagline, applied_at, activated_at, key_hash, public_key FROM swarm_members WHERE id = 'athena'`;
  expect(row.tagline).toBe("OPERATOR EDIT — must survive the backfill");
  expect(new Date(row.applied_at!).toISOString()).toBe(applied);
  expect(new Date(row.activated_at!).toISOString()).toBe(activated);
  expect(row.key_hash).toBe("hash_540");
  expect(row.public_key).toBe("pk_540");
});
