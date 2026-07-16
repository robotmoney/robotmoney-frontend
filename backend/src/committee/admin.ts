// Committee ADMIN domain layer (issue #152): topic/member CRUD with optimistic
// concurrency, member lifecycle + one-time credential issuance, session
// scheduling with a frozen roster snapshot, roster add/excuse/restore, guarded
// session lifecycle transitions, and audit-log filtering.
//
// Kept as a SEPARATE module from committee/domain.ts (the member/public-facing
// surface) so the existing apply/activate/submit/open/publish/aggregate paths —
// used by the demo, the worker, and their tests — are untouched by this admin
// surface. Where this module's session lifecycle overlaps with domain.ts (e.g.
// aggregateSessionGuarded still calls domain.aggregateSession for the rich
// rollup), it composes those functions rather than duplicating them.
import { sql, type DbHandle } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import { activateMember, aggregateSession as domainAggregateSession } from "./domain.ts";

type Actor = string;
export const ADMIN_ACTOR = "admin";

// ── Shared result shape ──────────────────────────────────────────────────
export interface AdminResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  error?: string;
  [key: string]: unknown;
}

function err(status: number, error: string): AdminResult {
  return { ok: false, status, error };
}

async function audit(actor: Actor, action: string, scope: Record<string, unknown>, tx: DbHandle = sql) {
  await tx`INSERT INTO audit_log (actor, action, scope) VALUES (${actor}, ${action}, ${tx.json(scope as any)})`;
}

// ── Redacted projections (never expose key_hash/token_hash/public_key) ────
function toSubjectAdmin(row: Record<string, any>) {
  return {
    id: row.id,
    status: row.status,
    version: Number(row.version),
    name: row.name,
    operator: row.operator ?? null,
    homepage: row.homepage ?? null,
    xHandle: row.x_handle ?? null,
    thesisBlurb: row.thesis_blurb ?? null,
    wallets: row.wallets ?? null,
    nftContracts: row.nft_contracts ?? null,
    source: row.source ?? null,
    recommendationType: row.recommendation_type ?? null,
    linkedMemberId: row.linked_member_id ?? null,
    structuralNotes: row.structural_notes ?? null,
    lastReviewed: row.last_reviewed ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMemberAdmin(row: Record<string, any>) {
  return {
    id: row.id,
    status: row.status,
    version: Number(row.version),
    name: row.name,
    tagline: row.tagline ?? null,
    lens: row.lens ?? null,
    mandate: row.mandate ?? null,
    contactEmail: row.contact_email ?? null,
    appliedAt: row.applied_at ?? null,
    activatedAt: row.activated_at ?? null,
    deactivatedAt: row.deactivated_at ?? null,
    rejectedAt: row.rejected_at ?? null,
    updatedAt: row.updated_at,
  };
}

// ── Topics (committee_subjects) ─────────────────────────────────────────────
export interface SubjectInput {
  id: string;
  name: string;
  operator?: string;
  homepage?: string;
  xHandle?: string;
  thesisBlurb?: string;
  wallets?: unknown;
  nftContracts?: unknown;
  source?: unknown;
  recommendationType?: string;
  linkedMemberId?: string;
  structuralNotes?: unknown;
  lastReviewed?: string;
}

export async function listSubjectsAdmin() {
  const rows = await sql`SELECT * FROM committee_subjects ORDER BY id`;
  return rows.map(toSubjectAdmin);
}

export async function createSubjectAdmin(input: SubjectInput, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  const existing = (await sql`SELECT id FROM committee_subjects WHERE id = ${input.id}`)[0];
  if (existing) return err(409, "subject id already exists");
  const rows = await sql`
    INSERT INTO committee_subjects
      (id, status, name, operator, homepage, x_handle, thesis_blurb, wallets, nft_contracts,
       source, recommendation_type, linked_member_id, structural_notes, last_reviewed)
    VALUES
      (${input.id}, 'active', ${input.name}, ${input.operator ?? null}, ${input.homepage ?? null},
       ${input.xHandle ?? null}, ${input.thesisBlurb ?? null}, ${sql.json((input.wallets ?? null) as any)},
       ${sql.json((input.nftContracts ?? null) as any)}, ${sql.json((input.source ?? null) as any)},
       ${input.recommendationType ?? null}, ${input.linkedMemberId ?? null},
       ${sql.json((input.structuralNotes ?? null) as any)}, ${input.lastReviewed ?? null})
    RETURNING *`;
  await audit(actor, "subject_create", { subjectId: input.id });
  return { ok: true, status: 201, subject: toSubjectAdmin(rows[0]) };
}

export type SubjectPatch = Partial<Omit<SubjectInput, "id">>;

export async function updateSubjectAdmin(
  id: string,
  expectedVersion: number,
  patch: SubjectPatch,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT * FROM committee_subjects WHERE id = ${id} FOR UPDATE`)[0];
    if (!row) return err(404, "subject not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const merged = {
      name: patch.name ?? row.name,
      operator: patch.operator ?? row.operator,
      homepage: patch.homepage ?? row.homepage,
      x_handle: patch.xHandle ?? row.x_handle,
      thesis_blurb: patch.thesisBlurb ?? row.thesis_blurb,
      wallets: patch.wallets !== undefined ? patch.wallets : row.wallets,
      nft_contracts: patch.nftContracts !== undefined ? patch.nftContracts : row.nft_contracts,
      source: patch.source !== undefined ? patch.source : row.source,
      recommendation_type: patch.recommendationType ?? row.recommendation_type,
      linked_member_id: patch.linkedMemberId ?? row.linked_member_id,
      structural_notes: patch.structuralNotes !== undefined ? patch.structuralNotes : row.structural_notes,
      last_reviewed: patch.lastReviewed ?? row.last_reviewed,
    };
    const upd = await tx`
      UPDATE committee_subjects SET
        name = ${merged.name}, operator = ${merged.operator}, homepage = ${merged.homepage},
        x_handle = ${merged.x_handle}, thesis_blurb = ${merged.thesis_blurb},
        wallets = ${tx.json(merged.wallets as any)}, nft_contracts = ${tx.json(merged.nft_contracts as any)},
        source = ${tx.json(merged.source as any)}, recommendation_type = ${merged.recommendation_type},
        linked_member_id = ${merged.linked_member_id}, structural_notes = ${tx.json(merged.structural_notes as any)},
        last_reviewed = ${merged.last_reviewed}, version = version + 1, updated_at = now()
      WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await audit(actor, "subject_update", { subjectId: id }, tx);
    return { ok: true, status: 200, subject: toSubjectAdmin(upd[0]) };
  });
}

export async function deactivateSubjectAdmin(
  id: string,
  expectedVersion: number,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT * FROM committee_subjects WHERE id = ${id} FOR UPDATE`)[0];
    if (!row) return err(404, "subject not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const upd = await tx`
      UPDATE committee_subjects SET status = 'inactive', version = version + 1, updated_at = now()
      WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await audit(actor, "subject_deactivate", { subjectId: id }, tx);
    return { ok: true, status: 200, subject: toSubjectAdmin(upd[0]) };
  });
}

// ── Members ─────────────────────────────────────────────────────────────────
export async function listMembersAdmin() {
  const rows = await sql`SELECT * FROM committee_members ORDER BY id`;
  return rows.map(toMemberAdmin);
}

export async function listApplicationsAdmin(status?: string) {
  const rows = status
    ? await sql`SELECT id, member_id, status, created_at, reviewed_at FROM committee_applications WHERE status = ${status} ORDER BY created_at DESC`
    : await sql`SELECT id, member_id, status, created_at, reviewed_at FROM committee_applications ORDER BY created_at DESC`;
  return rows;
}

export interface ManualMemberInput {
  memberId: string;
  name: string;
  publicKey: string;
  lens?: string;
  contact?: string;
}

// Admin manual add: creates an ACTIVE member + ACTIVE key + one-time bearer
// token in a single transaction, bypassing the public apply/activate flow.
// The token is returned ONLY in this response — never persisted or re-readable.
export async function addMemberAdmin(input: ManualMemberInput, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  const existing = (await sql`SELECT id FROM committee_members WHERE id = ${input.memberId}`)[0];
  if (existing) return err(409, "memberId already registered");
  const token = `tok_${input.memberId}_${crypto.randomUUID()}`;
  return sql.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO committee_members (id, status, name, lens, contact_email, applied_at, activated_at)
      VALUES (${input.memberId}, 'active', ${input.name}, ${input.lens ?? null}, ${input.contact ?? null}, now(), now())
      RETURNING *`;
    await tx`INSERT INTO committee_member_keys (member_id, public_key, active, token_hash)
             VALUES (${input.memberId}, ${input.publicKey}, true, ${hashKey(token)})`;
    await audit(actor, "member_manual_add", { memberId: input.memberId }, tx);
    return { ok: true, status: 201, member: toMemberAdmin(rows[0]), token };
  });
}

export async function reviewApplicationAdmin(
  memberId: string,
  decision: "approve" | "reject",
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  if (decision === "approve") {
    // Reuse the SAME activation transaction the public path uses (activates
    // the pending key, mints a token, flips status active) — never duplicate
    // that credential-issuance logic here.
    const res = await activateMember(memberId);
    if (!res.ok) return res as AdminResult;
    return { ok: true, status: 200, memberId, memberStatus: "active", token: (res as any).token };
  }
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT id, status FROM committee_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "no such applicant");
    if (row.status !== "applied") return err(409, `cannot reject a member in status=${row.status}`);
    await tx`UPDATE committee_members SET status = 'rejected', rejected_at = now(), version = version + 1, updated_at = now() WHERE id = ${memberId}`;
    await tx`UPDATE committee_applications SET status = 'rejected', reviewed_at = now() WHERE member_id = ${memberId} AND status = 'pending'`;
    await audit(actor, "member_reject", { memberId }, tx);
    return { ok: true, status: 200, memberId, memberStatus: "rejected" };
  });
}

export async function deactivateMemberAdmin(
  memberId: string,
  expectedVersion: number,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT * FROM committee_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const upd = await tx`
      UPDATE committee_members SET status = 'inactive', deactivated_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await tx`UPDATE committee_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    await audit(actor, "member_deactivate", { memberId }, tx);
    return { ok: true, status: 200, member: toMemberAdmin(upd[0]) };
  });
}

// Reactivation mints a FRESH credential (the prior key/token is never
// silently trusted again) — matches the "revoke prior keys, credential only
// in the response" rule that governs rotation and manual add.
export async function reactivateMemberAdmin(
  memberId: string,
  expectedVersion: number,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT * FROM committee_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const lastKey = (await tx`SELECT public_key FROM committee_member_keys WHERE member_id = ${memberId} ORDER BY created_at DESC LIMIT 1`)[0] as
      | { public_key: string }
      | undefined;
    if (!lastKey) return err(409, "member has no on-file public key; use rotate-key with a new one");
    const upd = await tx`
      UPDATE committee_members SET status = 'active', version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await tx`UPDATE committee_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    const token = `tok_${memberId}_${crypto.randomUUID()}`;
    await tx`INSERT INTO committee_member_keys (member_id, public_key, active, token_hash) VALUES (${memberId}, ${lastKey.public_key}, true, ${hashKey(token)})`;
    await audit(actor, "member_reactivate", { memberId }, tx);
    return { ok: true, status: 200, member: toMemberAdmin(upd[0]), token };
  });
}

// Key rotation: revoke ALL currently active keys for the member (transactional)
// and mint exactly one new active key + bearer token. `publicKey` is optional —
// omit to rotate only the credential (bearer token) against the member's
// existing on-file public key; supply a new one when the member generated a
// fresh keypair out-of-band.
export async function rotateMemberKeyAdmin(
  memberId: string,
  opts: { publicKey?: string } = {},
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const member = (await tx`SELECT id, version FROM committee_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!member) return err(404, "member not found");
    const priorActive = (await tx`SELECT public_key FROM committee_member_keys WHERE member_id = ${memberId} AND active = true ORDER BY created_at DESC LIMIT 1`)[0] as
      | { public_key: string }
      | undefined;
    const publicKey = opts.publicKey ?? priorActive?.public_key;
    if (!publicKey) return err(409, "no on-file public key; supply publicKey to rotate");
    await tx`UPDATE committee_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    const token = `tok_${memberId}_${crypto.randomUUID()}`;
    await tx`INSERT INTO committee_member_keys (member_id, public_key, active, token_hash) VALUES (${memberId}, ${publicKey}, true, ${hashKey(token)})`;
    await tx`UPDATE committee_members SET version = version + 1, updated_at = now() WHERE id = ${memberId}`;
    await audit(actor, "member_rotate_key", { memberId }, tx);
    return { ok: true, status: 200, memberId, token };
  });
}

// ── Sessions: creation with a frozen roster snapshot ────────────────────────
export interface SessionCreateInput {
  date: string; // YYYY-MM-DD, UTC calendar date
  subjectId: string;
  scheduledAt?: string; // ISO instant; its UTC date must equal `date`
  windowMinutes?: number; // default 60, used to schedule the close job
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidUtcDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const SESSION_JOB_KINDS = ["committee.publish_brief", "committee.close_window", "committee.aggregate", "committee.publish"] as const;

export async function createSessionAdmin(input: SessionCreateInput, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  if (!isValidUtcDate(input.date)) return err(400, "date must be a valid UTC calendar date (YYYY-MM-DD)");
  let scheduled: Date | null = null;
  if (input.scheduledAt !== undefined) {
    scheduled = new Date(input.scheduledAt);
    if (Number.isNaN(scheduled.getTime())) return err(400, "scheduledAt must be a valid ISO timestamp");
    if (scheduled.toISOString().slice(0, 10) !== input.date) return err(400, "scheduledAt date does not match date (date mismatch)");
  }
  const windowMinutes = Number.isFinite(input.windowMinutes) && (input.windowMinutes as number) > 0 ? (input.windowMinutes as number) : 60;
  const closesAt = new Date((scheduled ?? new Date()).getTime() + windowMinutes * 60_000);
  if (scheduled && closesAt.getTime() <= scheduled.getTime()) return err(400, "invalid timestamp ordering: window must close after it opens");

  const subject = (await sql`SELECT id, status, name FROM committee_subjects WHERE id = ${input.subjectId}`)[0] as
    | { id: string; status: string; name: string }
    | undefined;
  if (!subject) return err(404, "subject not found");
  if (subject.status !== "active") return err(409, "topic is not active");

  const existing = (await sql`SELECT id, state FROM committee_sessions WHERE date = ${input.date} AND subject_id = ${input.subjectId}`)[0] as
    | { id: string; state: string }
    | undefined;
  if (existing && existing.state !== "scheduled") return err(409, "a session already exists for this date/topic");

  return sql.begin(async (tx) => {
    const rows = existing
      ? await tx`UPDATE committee_sessions SET version = version + 1 WHERE id = ${existing.id} RETURNING id, date, subject_id, subject_name, state, version`
      : await tx`
          INSERT INTO committee_sessions (date, subject_id, subject_name, state)
          VALUES (${input.date}, ${input.subjectId}, ${subject.name}, 'scheduled')
          RETURNING id, date, subject_id, subject_name, state, version`;
    const session = rows[0];
    const sessionId = session.id as string;

    // Frozen roster: snapshot every currently-active member. Later member
    // activation/deactivation NEVER rewrites this list (roster add/excuse/
    // restore are the only sanctioned edits, and only before collecting).
    const activeMembers = await tx`SELECT id FROM committee_members WHERE status = 'active'`;
    for (const m of activeMembers) {
      await tx`INSERT INTO committee_session_roster (session_id, member_id, status) VALUES (${sessionId}, ${m.id}, 'active')
                ON CONFLICT (session_id, member_id) DO NOTHING`;
    }

    // Exactly four deduplicated, session-scoped jobs — dedupe_key includes the
    // sessionId so re-creating a still-scheduled session never double-enqueues.
    const jobTimes: Record<(typeof SESSION_JOB_KINDS)[number], Date> = {
      "committee.publish_brief": scheduled ?? new Date(),
      "committee.close_window": closesAt,
      "committee.aggregate": new Date(closesAt.getTime() + 1_000),
      "committee.publish": new Date(closesAt.getTime() + 2_000),
    };
    const jobIds: number[] = [];
    for (const kind of SESSION_JOB_KINDS) {
      const dedupeKey = `${kind}:${sessionId}`;
      const r = await tx`
        INSERT INTO jobs (kind, payload, run_after, dedupe_key)
        VALUES (${kind}, ${tx.json({ sessionId, windowMinutes } as any)}, ${jobTimes[kind]}, ${dedupeKey})
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id`;
      if (r[0]) jobIds.push(Number(r[0].id));
    }

    await audit(actor, "session_create", { sessionId, date: input.date, subjectId: input.subjectId }, tx);
    return {
      ok: true,
      status: existing ? 200 : 201,
      session: { id: sessionId, date: session.date, subjectId: session.subject_id, subjectName: session.subject_name, state: session.state, version: Number(session.version) },
      rosterSize: activeMembers.length,
      jobIds,
    };
  });
}

// ── Roster add/excuse/restore (only before collecting begins) ──────────────
async function requireRosterEditable(tx: DbHandle, sessionId: string) {
  const s = (await tx`SELECT id, state FROM committee_sessions WHERE id = ${sessionId} FOR UPDATE`)[0] as
    | { id: string; state: string }
    | undefined;
  if (!s) return { ok: false as const, status: 404, error: "session not found" };
  if (s.state !== "scheduled") return { ok: false as const, status: 409, error: `roster is locked once collection begins (state=${s.state})` };
  return { ok: true as const };
}

export async function getSessionRoster(sessionId: string) {
  return sql`SELECT member_id, status, snapshotted_at, excused_at, restored_at FROM committee_session_roster WHERE session_id = ${sessionId} ORDER BY member_id`;
}

export async function rosterAddAdmin(sessionId: string, memberId: string, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const gate = await requireRosterEditable(tx, sessionId);
    if (!gate.ok) return err(gate.status, gate.error);
    const member = (await tx`SELECT id FROM committee_members WHERE id = ${memberId}`)[0];
    if (!member) return err(404, "member not found");
    await tx`INSERT INTO committee_session_roster (session_id, member_id, status) VALUES (${sessionId}, ${memberId}, 'active')
              ON CONFLICT (session_id, member_id) DO UPDATE SET status = 'active', restored_at = now()`;
    await audit(actor, "roster_add", { sessionId, memberId }, tx);
    return { ok: true, status: 200, sessionId, memberId, status_: "active" };
  });
}

export async function rosterExcuseAdmin(sessionId: string, memberId: string, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const gate = await requireRosterEditable(tx, sessionId);
    if (!gate.ok) return err(gate.status, gate.error);
    const upd = await tx`UPDATE committee_session_roster SET status = 'excused', excused_at = now() WHERE session_id = ${sessionId} AND member_id = ${memberId} RETURNING member_id`;
    if (upd.length === 0) return err(404, "member is not on this session's roster");
    await audit(actor, "roster_excuse", { sessionId, memberId }, tx);
    return { ok: true, status: 200, sessionId, memberId };
  });
}

export async function rosterRestoreAdmin(sessionId: string, memberId: string, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const gate = await requireRosterEditable(tx, sessionId);
    if (!gate.ok) return err(gate.status, gate.error);
    const upd = await tx`UPDATE committee_session_roster SET status = 'active', restored_at = now() WHERE session_id = ${sessionId} AND member_id = ${memberId} RETURNING member_id`;
    if (upd.length === 0) return err(404, "member is not on this session's roster");
    await audit(actor, "roster_restore", { sessionId, memberId }, tx);
    return { ok: true, status: 200, sessionId, memberId };
  });
}

// ── Guarded lifecycle transitions ───────────────────────────────────────────
// Session states: scheduled → collecting → window_closed → aggregated →
// published, with `cancelled` reachable from any non-terminal state and
// `window_closed` reopenable back to `collecting`. published/cancelled are
// terminal — no further transition is ever legal.
const TERMINAL = new Set(["published", "cancelled"]);
const TRANSITIONS: Record<string, readonly string[]> = {
  scheduled: ["collecting", "cancelled"],
  collecting: ["window_closed", "cancelled"],
  window_closed: ["collecting", "aggregated", "cancelled"],
  aggregated: ["window_closed", "published"],
  published: [],
  cancelled: [],
};

export interface GuardedTransitionResult extends AdminResult {
  session?: { id: string; state: string; version: number };
  idempotent?: boolean;
}

// Advances committee_sessions.state under an optimistic-concurrency + legal-
// transition guard, and writes exactly one committee_session_events row and
// one audit_log row for every REAL transition, transactionally. Re-requesting
// the CURRENT state is idempotent (200, no version bump, no new event/audit
// row); requesting a transition out of a terminal state, or one not in the
// legal table, is 409.
export async function guardedTransition(
  sessionId: string,
  toState: string,
  actor: Actor,
  opts: { expectedVersion?: number } = {},
): Promise<GuardedTransitionResult> {
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT id, state, version FROM committee_sessions WHERE id = ${sessionId} FOR UPDATE`)[0] as
      | { id: string; state: string; version: number }
      | undefined;
    if (!row) return err(404, "session not found");
    if (opts.expectedVersion != null && Number(row.version) !== opts.expectedVersion) return err(409, "stale_version");
    if (row.state === toState) {
      return { ok: true, status: 200, idempotent: true, session: { id: row.id, state: row.state, version: Number(row.version) } };
    }
    if (TERMINAL.has(row.state)) return err(409, `terminal_state:${row.state}`);
    const legal = TRANSITIONS[row.state] ?? [];
    if (!legal.includes(toState)) return err(409, `illegal_transition:${row.state}->${toState}`);
    const upd = await tx`UPDATE committee_sessions SET state = ${toState}, version = version + 1 WHERE id = ${sessionId} RETURNING id, state, version`;
    await tx`INSERT INTO committee_session_events (session_id, from_state, to_state, actor) VALUES (${sessionId}, ${row.state}, ${toState}, ${actor})`;
    await audit(actor, "session_transition", { sessionId, from: row.state, to: toState }, tx);
    return { ok: true, status: 200, session: { id: upd[0].id, state: upd[0].state, version: Number(upd[0].version) } };
  });
}

export async function cancelSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR) {
  return guardedTransition(sessionId, "cancelled", actor, { expectedVersion });
}

export async function closeSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR) {
  return guardedTransition(sessionId, "window_closed", actor, { expectedVersion });
}

export async function reopenSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR) {
  return guardedTransition(sessionId, "collecting", actor, { expectedVersion });
}

export async function aggregateSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR) {
  const t = await guardedTransition(sessionId, "aggregated", actor, { expectedVersion });
  if (!t.ok) return t;
  const rollup = await domainAggregateSession(sessionId);
  return { ...t, ...rollup, status: t.status };
}

export async function publishSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR) {
  const t = await guardedTransition(sessionId, "published", actor, { expectedVersion });
  if (!t.ok) return t;
  await sql`UPDATE committee_sessions SET published_at = now() WHERE id = ${sessionId} AND published_at IS NULL`;
  return t;
}

// ── Audit log (redacted; scope never carries credential material) ──────────
export interface AuditFilter {
  actor?: string;
  action?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export async function listAuditLog(filter: AuditFilter = {}) {
  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 500) : 100;
  const conds = [];
  if (filter.actor) conds.push(sql`actor = ${filter.actor}`);
  if (filter.action) conds.push(sql`action = ${filter.action}`);
  if (filter.since) conds.push(sql`at >= ${filter.since}`);
  if (filter.until) conds.push(sql`at <= ${filter.until}`);
  const where = conds.length ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;
  return sql`SELECT id, actor, action, scope, at FROM audit_log ${where} ORDER BY at DESC LIMIT ${limit}`;
}
