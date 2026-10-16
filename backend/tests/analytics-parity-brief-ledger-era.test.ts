// checkSwarmBriefsParity() must compare only the LEDGER ERA, in both directions.
//
// WHY THIS FILE EXISTS. 0059 creates swarm_brief_revisions and deliberately does
// NOT backfill it — the v0.5.0 runbook says so outright ("no backfill — same
// documented cutover shape as 0049"). The parity check compared ALL of
// swarm_briefs against that ledger, so every brief written before 0059 landed
// reported as "present in compatibility table, missing from ledger" on every
// sweep, forever. Because analytics_parity_observations is append-only and the
// gate requires an unbroken run of matched=true, that made the §6.1 cutover
// gate UNPASSABLE on any database carrying pre-0059 briefs — production being
// exactly that database.
//
// Measured on a smoke-twin restored from production before the fix: legacy 226
// rows vs ledger 1, matched=false. The same failure mode the file's own
// provenanceComparableFromMs() already guards for 0061's column ("comparing
// those rows would park the gate permanently red on history alone") — it was
// simply never applied here.
//
// Asserted in BOTH directions, because an exemption that silences history can
// just as easily silence a regression:
//   * pre-0059 brief with no ledger row  -> excluded, still matched
//   * post-0059 brief with no ledger row -> IN SCOPE, must mismatch
//   * pre-0059 brief revised after 0059  -> excluded from BOTH sides, so the
//     exclusion cannot manufacture a divergence in the opposite direction
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { checkSwarmBriefsParity } from "../src/analytics/cutover/parity.ts";
import { ensureSubject, openSession } from "../src/swarm/domain.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const MIGRATION = "0059_analytics_output_and_report_snapshots.sql";

/** 0059's applied_at is the boundary the check scopes on. */
async function ledgerAppliedAt(): Promise<Date> {
  const [r] = (await sql`SELECT applied_at FROM schema_migrations WHERE name = ${MIGRATION}`) as unknown as { applied_at: Date }[];
  if (!r) throw new Error(`${MIGRATION} not recorded — the fixture cannot place rows relative to it`);
  return r.applied_at;
}

async function makeBrief(opts: { createdAt: Date; withRevision: boolean; body?: unknown }): Promise<string> {
  // swarm_briefs carries FKs to BOTH swarm_subjects and swarm_sessions, so the
  // fixture builds a real subject + session rather than a bare uuid. Each brief
  // gets its own subject, which also keeps the unique (date, subject_id)
  // sessionless key from colliding across cases.
  const tag = crypto.randomUUID().slice(0, 8);
  const subjectId = `parity-subject-${tag}`;
  await ensureSubject(subjectId, `Parity Subject ${tag}`);
  const session = (await openSession(subjectId)) as { id: string };
  const sessionId = session.id;
  // sql.json(), NOT `${JSON.stringify(body)}::jsonb`: the latter stores a JSON
  // *string scalar* rather than an object, and the parity check then compares a
  // string against the ledger's parsed object and reports a mismatch that the
  // product never produces. The production writers all use sql.json().
  const body = opts.body ?? { note: `brief ${sessionId}` };
  await sql`
    INSERT INTO swarm_briefs (date, subject_id, body, created_at, session_id)
    VALUES (current_date, ${subjectId}, ${sql.json(body as never)}, ${opts.createdAt}, ${sessionId})`;
  if (opts.withRevision) {
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    // 0059 enforces `encode(digest(body_bytes,'sha256'),'hex') = checksum` at
    // the table level, so the fixture computes the real digest rather than a
    // placeholder — the constraint is doing its job and rejects anything else.
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await sql`
      INSERT INTO swarm_brief_revisions (session_id, revision, body_bytes, checksum)
      VALUES (${sessionId}, 1, ${bytes}, ${checksum})`;
  }
  return sessionId;
}

describe("swarm_briefs parity is scoped to the ledger era", () => {
  test("a pre-0059 brief with no ledger row does NOT break parity (the bug)", async () => {
    const boundary = await ledgerAppliedAt();
    await makeBrief({ createdAt: new Date(boundary.getTime() - 86_400_000), withRevision: false });
    const r = await checkSwarmBriefsParity();
    // Before the fix this was matched:false with a "missing from ledger"
    // mismatch, on a row 0059 was never going to populate.
    expect({ matched: r.matched, mismatches: r.mismatches }).toEqual({ matched: true, mismatches: [] });
    expect(r.legacyRowCount).toBe(0);
  });

  test("a post-0059 brief WITH its ledger row matches and is counted", async () => {
    const boundary = await ledgerAppliedAt();
    await makeBrief({ createdAt: new Date(boundary.getTime() + 1000), withRevision: true });
    const r = await checkSwarmBriefsParity();
    expect({ matched: r.matched, legacy: r.legacyRowCount, ledger: r.ledgerRowCount }).toEqual({ matched: true, legacy: 1, ledger: 1 });
  });

  test("a post-0059 brief MISSING its ledger row still mismatches — the exemption is not a blanket pass", async () => {
    const boundary = await ledgerAppliedAt();
    const sessionId = await makeBrief({ createdAt: new Date(boundary.getTime() + 1000), withRevision: false });
    const r = await checkSwarmBriefsParity();
    expect(r.matched).toBe(false);
    expect(r.mismatches.map((m) => m.naturalKey)).toContain(sessionId);
  });

  test("a pre-0059 brief revised AFTER the cutover is excluded from BOTH sides", async () => {
    // The asymmetry trap: filtering only the legacy side would leave this
    // session in the ledger map and report the opposite false mismatch,
    // "present in ledger, missing from compatibility".
    const boundary = await ledgerAppliedAt();
    await makeBrief({ createdAt: new Date(boundary.getTime() - 86_400_000), withRevision: true });
    const r = await checkSwarmBriefsParity();
    expect({ matched: r.matched, legacy: r.legacyRowCount, ledger: r.ledgerRowCount }).toEqual({ matched: true, legacy: 0, ledger: 0 });
  });

  test("history does not drown a real divergence: one bad post-0059 row among many old ones still fails", async () => {
    const boundary = await ledgerAppliedAt();
    for (let i = 0; i < 5; i++) {
      await makeBrief({ createdAt: new Date(boundary.getTime() - (i + 1) * 3_600_000), withRevision: false });
    }
    const good = await makeBrief({ createdAt: new Date(boundary.getTime() + 1000), withRevision: true });
    const bad = await makeBrief({ createdAt: new Date(boundary.getTime() + 2000), withRevision: false });
    const r = await checkSwarmBriefsParity();
    expect(r.matched).toBe(false);
    const keys = r.mismatches.map((m) => m.naturalKey);
    expect(keys).toContain(bad);
    expect(keys).not.toContain(good);
  });
});
