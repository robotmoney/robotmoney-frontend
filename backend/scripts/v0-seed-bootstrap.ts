// One-time historical backfill of v0 (robotmoney-site) pre-launch Investment
// Committee content: the three swarm member personas (Athena, Robot Money,
// Woon), the four subjects they cover, and the full history of each
// subject's per-agent narrative "takes" across all 32 past sessions.
//
// Direct-SQL pattern (like src/db/seed.ts's backfillWalletHistory()), NOT the
// HTTP-API pattern of edgar-seed-bootstrap.ts: that pattern exists because
// EDGAR ingestion must flow through the live analytics gap-fill API, and
// there is no equivalent generic ingest endpoint for
// swarm_members/subjects/sessions. This is a one-time historical backfill,
// not live ingestion, so it talks to Postgres directly via db/client.ts.
//
// Processes in DEPENDENCY ORDER — members -> subjects -> sessions (sessions
// FK to subjects) — and for every entity:
//   * natural key not found  -> INSERT (append-only: fills in what's missing)
//   * natural key found, content matches (every mapped column, not just a
//     hash) -> silent no-op
//   * natural key found, content differs -> NEVER overwrite. Log the entity,
//     natural key, and every differing field (old vs incoming), and count it
//     as an "inconsistency". Every entity is still attempted even after a
//     drift is found (so later genuinely-new rows still get inserted); the
//     script exits non-zero at the very end if any inconsistency was found.
//
// Sessions additionally get:
//   * legacy_takes         = v0's `takes` array verbatim (migration
//     0026_swarm_sessions_legacy_takes.sql) — NEVER swarm_recommendations,
//     which is a newer cryptographically-signed table; fabricating a
//     signature for unsigned v0 narrative content would misrepresent it as
//     verified.
//   * swarm_recommendation = v0's `committee_recommendation` verbatim
//   * state = 'published', published_at = generated_at
//   * every `legacy_takes[].member_id` is checked against swarm_members —
//     a missing reference is WARNED about, never a crash.
//
// Usage: DATABASE_URL=... bun run scripts/v0-seed-bootstrap.ts
// (wired as `bun run v0-seed:bootstrap` in package.json)
import { sql, closeDb, jsonValue } from "../src/db/client.ts";
import { loadV0Archive, type V0Member, type V0Subject, type V0Session } from "../src/swarm/v0-archive.ts";

type FieldKind = "text" | "json" | "numeric" | "date" | "timestamp";

interface FieldSpec {
  column: string;
  kind: FieldKind;
  expected: unknown;
}

interface Drift {
  entity: string;
  naturalKey: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

// Order/key-order-independent structural equality for parsed jsonb values.
// `undefined`-valued keys are treated as absent, matching how `JSON.parse`
// (never produces undefined) and Postgres's jsonb (drops nothing but also
// never carries an explicit "undefined") both behave.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
    const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

// Kind-aware equality between an incoming (archive) value and the value read
// back from Postgres. `numeric`/`date`/`timestamp` need normalization because
// postgres.js round-trips those types through string/Date representations
// that are not byte-identical to the archive's plain JS number/ISO string
// even when the underlying value is unchanged.
function fieldsEqual(kind: FieldKind, expected: unknown, actual: unknown): boolean {
  const e = expected ?? null;
  const act = actual ?? null;
  if (e === null || act === null) return e === act;
  switch (kind) {
    case "text":
      return e === act;
    case "json":
      return deepEqual(e, act);
    case "numeric":
      return Number(e) === Number(act);
    case "date": {
      const de = typeof e === "string" ? e.slice(0, 10) : new Date(e as string).toISOString().slice(0, 10);
      const da = typeof act === "string" ? act.slice(0, 10) : new Date(act as string).toISOString().slice(0, 10);
      return de === da;
    }
    case "timestamp":
      return new Date(e as string).toISOString() === new Date(act as string).toISOString();
  }
}

function diffRow(entity: string, naturalKey: string, fields: FieldSpec[], actualRow: Record<string, unknown>): Drift[] {
  const drifts: Drift[] = [];
  for (const f of fields) {
    const actual = actualRow[f.column];
    if (!fieldsEqual(f.kind, f.expected, actual)) {
      drifts.push({ entity, naturalKey, field: f.column, oldValue: actual, newValue: f.expected });
    }
  }
  return drifts;
}

type RowOutcome = "inserted" | "unchanged" | "drift";

async function processMember(m: V0Member, drifts: Drift[]): Promise<RowOutcome> {
  const existing = (
    await sql`
      SELECT status, name, tagline, lens, mandate, biases, voice_md, mode, submit, operator, avatar
      FROM swarm_members WHERE id = ${m.id}
    `
  )[0] as Record<string, unknown> | undefined;

  const fields: FieldSpec[] = [
    { column: "status", kind: "text", expected: m.status },
    { column: "name", kind: "text", expected: m.name },
    { column: "tagline", kind: "text", expected: m.tagline },
    { column: "lens", kind: "text", expected: m.lens },
    { column: "mandate", kind: "text", expected: m.mandate },
    { column: "biases", kind: "json", expected: m.biases },
    { column: "voice_md", kind: "text", expected: m.voice_md },
    { column: "mode", kind: "text", expected: m.mode },
    { column: "submit", kind: "json", expected: m.submit },
    { column: "operator", kind: "text", expected: m.operator },
    { column: "avatar", kind: "json", expected: m.avatar },
  ];

  if (!existing) {
    await sql`
      INSERT INTO swarm_members (id, status, name, tagline, lens, mandate, biases, voice_md, mode, submit, operator, avatar)
      VALUES (
        ${m.id}, ${m.status}, ${m.name}, ${m.tagline}, ${m.lens}, ${m.mandate},
        ${sql.json(jsonValue(m.biases ?? null))}, ${m.voice_md}, ${m.mode},
        ${sql.json(jsonValue(m.submit ?? null))}, ${m.operator}, ${sql.json(jsonValue(m.avatar ?? null))}
      )
    `;
    return "inserted";
  }

  const rowDrifts = diffRow("swarm_members", `id=${m.id}`, fields, existing);
  if (rowDrifts.length === 0) return "unchanged";
  drifts.push(...rowDrifts);
  return "drift";
}

async function processSubject(s: V0Subject, drifts: Drift[]): Promise<RowOutcome> {
  const existing = (
    await sql`
      SELECT status, name, operator, homepage, x_handle, thesis_blurb, wallets, nft_contracts, source,
             recommendation_type, linked_member_id, structural_notes, last_reviewed
      FROM swarm_subjects WHERE id = ${s.id}
    `
  )[0] as Record<string, unknown> | undefined;

  const fields: FieldSpec[] = [
    { column: "status", kind: "text", expected: s.status },
    { column: "name", kind: "text", expected: s.name },
    { column: "operator", kind: "text", expected: s.operator },
    { column: "homepage", kind: "text", expected: s.homepage },
    { column: "x_handle", kind: "text", expected: s.x_handle },
    { column: "thesis_blurb", kind: "text", expected: s.thesis_blurb },
    { column: "wallets", kind: "json", expected: s.wallets },
    { column: "nft_contracts", kind: "json", expected: s.nft_contracts },
    { column: "source", kind: "json", expected: s.source },
    { column: "recommendation_type", kind: "text", expected: s.recommendation_type },
    { column: "linked_member_id", kind: "text", expected: s.linked_member_id },
    { column: "structural_notes", kind: "json", expected: s.structural_notes },
    { column: "last_reviewed", kind: "date", expected: s.last_reviewed },
  ];

  if (!existing) {
    await sql`
      INSERT INTO swarm_subjects (
        id, status, name, operator, homepage, x_handle, thesis_blurb,
        wallets, nft_contracts, source, recommendation_type, linked_member_id, structural_notes, last_reviewed
      )
      VALUES (
        ${s.id}, ${s.status}, ${s.name}, ${s.operator}, ${s.homepage}, ${s.x_handle}, ${s.thesis_blurb},
        ${sql.json(jsonValue(s.wallets ?? null))}, ${sql.json(jsonValue(s.nft_contracts ?? null))},
        ${sql.json(jsonValue(s.source ?? null))}, ${s.recommendation_type}, ${s.linked_member_id},
        ${sql.json(jsonValue(s.structural_notes ?? null))}, ${s.last_reviewed}
      )
    `;
    return "inserted";
  }

  const rowDrifts = diffRow("swarm_subjects", `id=${s.id}`, fields, existing);
  if (rowDrifts.length === 0) return "unchanged";
  drifts.push(...rowDrifts);
  return "drift";
}

// The v0 `date` field (e.g. "2026-06-23") interpreted as UTC midnight — the
// same conversion migration 0022_committee_session_convened_at.sql used to
// backfill convened_at from the old `date` column (`date::timestamptz`,
// which for a bare date is UTC midnight), so this is the idiomatic
// date->convened_at conversion in this codebase.
function convenedAtFromDate(date: string): string {
  return `${date}T00:00:00Z`;
}

async function processSession(sess: V0Session, drifts: Drift[]): Promise<RowOutcome> {
  const convenedAt = convenedAtFromDate(sess.date);
  const publishedAt = sess.generated_at;

  const existing = (
    await sql`
      SELECT subject_name, regime_summary, subject_snapshot_total_value_usd, synthesis, swarm_recommendation,
             social_draft_id, generated_at, legacy_takes, state, published_at
      FROM swarm_sessions
      WHERE subject_id = ${sess.subject_id} AND convened_at = ${convenedAt}
    `
  )[0] as Record<string, unknown> | undefined;

  const fields: FieldSpec[] = [
    { column: "subject_name", kind: "text", expected: sess.subject_name },
    { column: "regime_summary", kind: "json", expected: sess.regime_summary },
    { column: "subject_snapshot_total_value_usd", kind: "numeric", expected: sess.subject_snapshot_total_value_usd },
    { column: "synthesis", kind: "text", expected: sess.synthesis },
    { column: "swarm_recommendation", kind: "json", expected: sess.committee_recommendation },
    { column: "social_draft_id", kind: "text", expected: sess.social_draft_id },
    { column: "generated_at", kind: "timestamp", expected: sess.generated_at },
    { column: "legacy_takes", kind: "json", expected: sess.takes },
    { column: "state", kind: "text", expected: "published" },
    { column: "published_at", kind: "timestamp", expected: publishedAt },
  ];

  const naturalKey = `subject_id=${sess.subject_id}, convened_at=${convenedAt}`;

  if (!existing) {
    await sql`
      INSERT INTO swarm_sessions (
        subject_id, convened_at, subject_name, regime_summary, subject_snapshot_total_value_usd,
        synthesis, swarm_recommendation, social_draft_id, generated_at, legacy_takes, state, published_at
      )
      VALUES (
        ${sess.subject_id}, ${convenedAt}, ${sess.subject_name}, ${sql.json(jsonValue(sess.regime_summary ?? null))},
        ${sess.subject_snapshot_total_value_usd}, ${sess.synthesis},
        ${sql.json(jsonValue(sess.committee_recommendation ?? null))}, ${sess.social_draft_id}, ${sess.generated_at},
        ${sql.json(jsonValue(sess.takes ?? null))}, 'published', ${publishedAt}
      )
    `;
    return "inserted";
  }

  const rowDrifts = diffRow("swarm_sessions", naturalKey, fields, existing);
  if (rowDrifts.length === 0) return "unchanged";
  drifts.push(...rowDrifts);
  return "drift";
}

export async function main(): Promise<void> {
  const { payload, manifest } = await loadV0Archive();
  console.log(
    `[v0-seed-bootstrap] loaded archive: sourceRepo=${manifest.sourceRepo} sourceCommit=${manifest.sourceCommit} ` +
      `extractedAt=${manifest.extractedAt} members=${manifest.counts.members} subjects=${manifest.counts.subjects} sessions=${manifest.counts.sessions}`,
  );

  const drifts: Drift[] = [];

  // ── 1. Members ────────────────────────────────────────────────────────
  let membersInserted = 0;
  let membersUnchanged = 0;
  let membersDrifted = 0;
  for (const m of payload.members) {
    const outcome = await processMember(m, drifts);
    if (outcome === "inserted") membersInserted++;
    else if (outcome === "unchanged") membersUnchanged++;
    else membersDrifted++;
  }
  console.log(
    `[v0-seed-bootstrap] members: inserted=${membersInserted} unchanged=${membersUnchanged} drifted=${membersDrifted} (of ${payload.members.length})`,
  );

  // ── 2. Subjects (depend on nothing new here; FK from sessions below) ───
  let subjectsInserted = 0;
  let subjectsUnchanged = 0;
  let subjectsDrifted = 0;
  for (const s of payload.subjects) {
    const outcome = await processSubject(s, drifts);
    if (outcome === "inserted") subjectsInserted++;
    else if (outcome === "unchanged") subjectsUnchanged++;
    else subjectsDrifted++;
  }
  console.log(
    `[v0-seed-bootstrap] subjects: inserted=${subjectsInserted} unchanged=${subjectsUnchanged} drifted=${subjectsDrifted} (of ${payload.subjects.length})`,
  );

  // Current live roster (post member-processing above) — used to validate
  // every legacy_takes[].member_id below without crashing on a dangling
  // reference (warn only).
  const knownMemberIds = new Set((await sql<{ id: string }[]>`SELECT id FROM swarm_members`).map((r) => r.id));

  // ── 3. Sessions (FK to subjects, so this runs last) ─────────────────────
  let sessionsInserted = 0;
  let sessionsUnchanged = 0;
  let sessionsDrifted = 0;
  for (const sess of payload.sessions) {
    for (const take of sess.takes ?? []) {
      if (take.member_id && !knownMemberIds.has(take.member_id)) {
        console.warn(
          `[v0-seed-bootstrap] WARNING: session ${sess.subject_id}/${sess.date} legacy_takes references unknown member_id=${JSON.stringify(take.member_id)} (not in swarm_members)`,
        );
      }
    }
    const outcome = await processSession(sess, drifts);
    if (outcome === "inserted") sessionsInserted++;
    else if (outcome === "unchanged") sessionsUnchanged++;
    else sessionsDrifted++;
  }
  console.log(
    `[v0-seed-bootstrap] sessions: inserted=${sessionsInserted} unchanged=${sessionsUnchanged} drifted=${sessionsDrifted} (of ${payload.sessions.length})`,
  );

  // ── Summary — attempted every entity above BEFORE deciding the exit code,
  // so a drift earlier in the run never suppresses inserts that come after it.
  if (drifts.length > 0) {
    console.error(
      `[v0-seed-bootstrap] ${drifts.length} inconsistenc${drifts.length === 1 ? "y" : "ies"} detected — existing row(s) differ ` +
        `from the archive and were NOT overwritten:`,
    );
    for (const d of drifts) {
      console.error(
        `  - ${d.entity} (${d.naturalKey}) field "${d.field}": existing=${JSON.stringify(d.oldValue)} incoming=${JSON.stringify(d.newValue)}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log("[v0-seed-bootstrap] no inconsistencies detected — bootstrap complete.");
  }
}

// Run directly: `bun run scripts/v0-seed-bootstrap.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(closeDb)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
