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
//
// Counts are read from the archive manifest rather than hard-coded, so
// regenerating the artifact (scripts/v0-seed-regenerate.ts) against a newer
// v0-archive commit does not turn this file red for the wrong reason. The
// per-dataset ASSERTIONS are still exact — "everything in the archive landed",
// not "some rows landed".
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runV0SeedBootstrap } from "../scripts/v0-seed-bootstrap.ts";
import { loadV0Archive } from "../src/swarm/v0-archive.ts";
import { verifyStoredSubmissionSignature } from "../src/lib/signing.ts";

const MEMBER_IDS = ["athena", "robotmoney", "woon"];
const SUBJECT_IDS = ["robotmoney-allocation", "robotmoney-treasury", "robotmoney-vault", "woon"];

// A throwaway archival key for the suite. Generated once per process, so both
// runs inside the idempotency test sign identically (Ed25519 is deterministic)
// and the second run is a true no-op rather than a signature churn.
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  process.env.V0_ARCHIVE_SIGNING_KEY = Buffer.from(pkcs8).toString("base64");
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
  await sql`DELETE FROM swarm_members WHERE id = ANY(${MEMBER_IDS})`;
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

  expect(await count("swarm_members", "id", MEMBER_IDS)).toBe(manifest.counts.members);
  expect(await count("swarm_subjects", "id", SUBJECT_IDS)).toBe(manifest.counts.subjects);
  expect(await count("swarm_sessions", "subject_id", SUBJECT_IDS)).toBe(manifest.counts.sessions);
  expect(await count("swarm_recommendations", "subject_id", SUBJECT_IDS)).toBe(expectedTakes);
  expect(await count("swarm_subject_snapshots", "subject_id", SUBJECT_IDS)).toBe(manifest.counts.snapshots);
  expect(await count("swarm_briefs", "subject_id", SUBJECT_IDS)).toBe(manifest.counts.briefs);
});

test("takes land in swarm_recommendations, signed but NOT verifiable as a member submission", async () => {
  await runV0SeedBootstrap();

  const rows = await sql<{ member_id: string; nonce: string; signature: string; payload: Record<string, unknown>; body: string }[]>`
    SELECT member_id, nonce, signature, payload, body FROM swarm_recommendations
    WHERE subject_id = ANY(${SUBJECT_IDS}) ORDER BY date, member_id LIMIT 5`;
  expect(rows.length).toBe(5);

  for (const r of rows) {
    // A REAL signature, not a placeholder: non-empty, base64, 64 raw bytes.
    expect(Buffer.from(r.signature, "base64").length).toBe(64);
    // Deterministic, reconstructible nonce — what makes the import idempotent.
    expect(r.nonce.startsWith("v0-archive-")).toBe(true);
    // The payload is the canonical submission shape a live member signs.
    expect(r.payload.memberId).toBe(r.member_id);
    expect(r.payload.body).toBe(r.body);
  }

  // The archival key is deliberately NOT registered in swarm_member_keys, so
  // the read path cannot verify these against a member and must not claim to.
  const keyRows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM swarm_member_keys WHERE member_id = ANY(${MEMBER_IDS}) AND active`;
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
  await sql`UPDATE swarm_members SET tagline = ${mutatedTagline} WHERE id = 'athena'`;

  const result = await runV0SeedBootstrap();

  expect(result.members).toEqual({ inserted: 0, unchanged: 2, drifted: 1, total: 3 });
  expect(result.drifts).toEqual([
    {
      entity: "swarm_members",
      naturalKey: "id=athena",
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
