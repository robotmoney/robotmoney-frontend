// Swarm ADMIN domain layer (issue #152): topic/member CRUD with optimistic
// concurrency, member lifecycle + one-time credential issuance, session
// scheduling with a frozen roster snapshot, roster add/excuse/restore, guarded
// session lifecycle transitions, and audit-log filtering.
//
// Kept as a SEPARATE module from swarm/domain.ts (the member/public-facing
// surface) so the existing apply/activate/submit/open/publish/aggregate paths —
// used by the smoke, the worker, and their tests — are untouched by this admin
// surface. Where this module's session lifecycle overlaps with domain.ts (e.g.
// aggregateSessionGuarded still calls domain.aggregateSession for the rich
// rollup), it composes those functions rather than duplicating them.
import { sql, type DbHandle } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import {
  activateMember,
  aggregateSession as domainAggregateSession,
  assertRosterCapacity,
  isHandleUniqueViolation,
  SWARM_ROSTER_CAP,
  countActiveMembersTx,
} from "./domain.ts";
// Issue #562 — the one implementation of "what handle does this name get".
import { deriveMemberHandle } from "./handle.ts";
import { enqueueSeatOpenNotifications } from "./notifications.ts";
// The published shape of this module's member projection. Imported for the
// `: AdminMember` return annotation on toMemberAdmin() below — see the comment
// there (issue #572).
import type { AdminMember } from "@robotmoney/contract";

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

// Every editable column is projected (issue #567): the admin edit form cannot
// prefill — and the admin page cannot diff — what this does not return. Still
// no key material: key_hash/token_hash/public_key are never projected here.
//
// The `: AdminMember` annotation is load-bearing (issue #572). Without it,
// #571 widened this literal by five fields while contract/src/admin.d.ts kept
// declaring twelve, and nothing anywhere went red — the contract is a `.d.ts`,
// which `skipLibCheck: true` excuses from every typecheck in the repo. With it,
// the returned object literal is contextually typed, so TypeScript's
// excess-property check fails backend.yml's typecheck on the next undeclared
// field. That check is path-gated on `backend/**` and is a typecheck rather
// than a test, so it is the SECOND line only; the enforcing guard is
// scripts/tests/unit/admin-member-contract-parity.test.ts, which runs
// unconditionally on every PR.
function toMemberAdmin(row: Record<string, any>): AdminMember {
  return {
    // Both names, always (issue #593): `id` is what every child row and every
    // signature is keyed on and is NOT editable here; `handle` is the public
    // one the form below may rewrite. An admin page that showed only one of
    // them could not tell an operator which is which.
    id: row.id,
    handle: row.handle ?? row.id,
    status: row.status,
    version: Number(row.version),
    name: row.name,
    tagline: row.tagline ?? null,
    lens: row.lens ?? null,
    mandate: row.mandate ?? null,
    biases: row.biases ?? null,
    voiceMd: row.voice_md ?? null,
    mode: row.mode ?? null,
    operator: row.operator ?? null,
    avatar: row.avatar ?? null,
    contactEmail: row.contact_email ?? null,
    appliedAt: row.applied_at ?? null,
    activatedAt: row.activated_at ?? null,
    updatedAt: row.updated_at,
  };
}

// ── Topics (swarm_subjects) ─────────────────────────────────────────────
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
  const rows = await sql`SELECT * FROM swarm_subjects ORDER BY id`;
  return rows.map(toSubjectAdmin);
}

export async function createSubjectAdmin(input: SubjectInput, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  const existing = (await sql`SELECT id FROM swarm_subjects WHERE id = ${input.id}`)[0];
  if (existing) return err(409, "subject id already exists");
  const rows = await sql`
    INSERT INTO swarm_subjects
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
    const row = (await tx`SELECT * FROM swarm_subjects WHERE id = ${id} FOR UPDATE`)[0];
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
      UPDATE swarm_subjects SET
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
    const row = (await tx`SELECT * FROM swarm_subjects WHERE id = ${id} FOR UPDATE`)[0];
    if (!row) return err(404, "subject not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const upd = await tx`
      UPDATE swarm_subjects SET status = 'inactive', version = version + 1, updated_at = now()
      WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await audit(actor, "subject_deactivate", { subjectId: id }, tx);
    return { ok: true, status: 200, subject: toSubjectAdmin(upd[0]) };
  });
}

// ── Members ─────────────────────────────────────────────────────────────────
export async function listMembersAdmin() {
  const rows = await sql`SELECT * FROM swarm_members ORDER BY id`;
  return rows.map(toMemberAdmin);
}

// ── Silence flags (issue #563) ──────────────────────────────────────────────
// A member can complete onboarding, go `active`, and then never submit a
// take — or submit for a while and then go quiet — while every liveness
// signal (status='active', no swarm_agent_health_events row) still reads
// healthy. Computed on read from the same eligibility record closeWindow()'s
// absence bookkeeping already trusts (domain.ts): swarm_session_members is
// what makes a session count toward N at all — a session the member was
// never seated in is not silence, it never happened for them (issue #563,
// "distinguish silence from exclusion") — and an EXCUSED row is dropped from
// the count for the same reason closeWindow() drops it from its own absence
// tally: an excusal is the roster saying this member was not expected, not
// the member saying nothing.
//
// N is how many such eligible sessions must pass before this fires — the
// issue leaves N uncalibrated ("Suggested starting shape" names it only as
// `$1`). Chosen here, not inline, so it is one place to tune:
export const SWARM_SILENCE_THRESHOLD_SESSIONS = 5;
// Five is deliberately more than one: "do not fire on single-session
// absence" is an explicit constraint, and a single miss is not evidence of
// anything — an agent restarting, a slow first boot, a brief's window
// closing early (#570) are all ordinary. Five misses in a row is not
// ordinary, and at the swarm's roughly-daily cadence it still surfaces the
// problem within about a week rather than the ~19-session gap that is what
// this issue was actually filed over (#558) — an operator finds out from the
// admin list, not from reading a transcript months later.

export type MemberSilenceFlagType = "never_submitted" | "gone_quiet";

export interface MemberSilenceFlag {
  type: MemberSilenceFlagType;
  /** Eligible (seated, non-excused) sessions since the reference point:
   * activation for `never_submitted`, the member's own latest take for
   * `gone_quiet`. Always >= SWARM_SILENCE_THRESHOLD_SESSIONS. */
  sessionsSinceReference: number;
}

// Two DISJOINT queries, both gated on SWARM_SILENCE_THRESHOLD_SESSIONS:
//   - never_submitted: the issue's core, required scope — the #558 case.
//     Reuses the issue's own suggested shape almost verbatim, with `s.created_at`
//     read as `s.convened_at` (swarm_sessions has no created_at; convened_at is
//     "the real identity, set when the session actually convenes" — migration
//     0022) and an added `sm.status != 'excused'` filter (see header comment).
//   - gone_quiet: the issue's "Worth extending" note — an established member
//     (>= 1 take on file) with nothing in the N eligible sessions since its
//     OWN latest one. The window is anchored to the member's last take rather
//     than to `now`, so it fires on N consecutive misses at any point in a
//     long history, not only on the N most recent sessions system-wide.
// A member can only ever match one: gone_quiet requires a prior take to
// measure "since"; never_submitted requires there to be none. Callers key the
// result by member_id, so listMembersAdmin() and this can run in parallel and
// merge without either wondering whether the other assigned the same member
// two answers.
export async function getMemberSilenceFlags(tx: DbHandle = sql): Promise<Record<string, MemberSilenceFlag>> {
  const neverSubmitted = await tx<{ member_id: string; sessions_seen: number }[]>`
    WITH eligible AS (
      SELECT sm.member_id, count(*)::int AS sessions_seen
      FROM swarm_session_members sm
      JOIN swarm_sessions s ON s.id = sm.session_id
      JOIN swarm_members m  ON m.id = sm.member_id
      WHERE m.status = 'active'
        AND sm.status != 'excused'
        AND s.convened_at > m.activated_at
      GROUP BY sm.member_id
    )
    SELECT e.member_id, e.sessions_seen
    FROM eligible e
    WHERE e.sessions_seen >= ${SWARM_SILENCE_THRESHOLD_SESSIONS}
      AND NOT EXISTS (SELECT 1 FROM swarm_recommendations r WHERE r.member_id = e.member_id)`;

  const goneQuiet = await tx<{ member_id: string; sessions_seen: number }[]>`
    WITH last_take AS (
      SELECT r.member_id, max(s.convened_at) AS last_take_at
      FROM swarm_recommendations r
      JOIN swarm_sessions s ON s.id = r.session_id
      GROUP BY r.member_id
    )
    SELECT sm.member_id, count(*)::int AS sessions_seen
    FROM swarm_session_members sm
    JOIN swarm_sessions s ON s.id = sm.session_id
    JOIN swarm_members m  ON m.id = sm.member_id
    JOIN last_take lt      ON lt.member_id = sm.member_id
    WHERE m.status = 'active'
      AND sm.status != 'excused'
      AND s.convened_at > lt.last_take_at
    GROUP BY sm.member_id
    HAVING count(*) >= ${SWARM_SILENCE_THRESHOLD_SESSIONS}`;

  const flags: Record<string, MemberSilenceFlag> = {};
  for (const row of neverSubmitted) {
    flags[row.member_id] = { type: "never_submitted", sessionsSinceReference: Number(row.sessions_seen) };
  }
  for (const row of goneQuiet) {
    flags[row.member_id] = { type: "gone_quiet", sessionsSinceReference: Number(row.sessions_seen) };
  }
  return flags;
}

export async function listApplicationsAdmin(status?: string) {
  const rows = status
    ? await sql`SELECT id, member_id, status, created_at, reviewed_at FROM swarm_applications WHERE status = ${status} ORDER BY created_at DESC`
    : await sql`SELECT id, member_id, status, created_at, reviewed_at FROM swarm_applications ORDER BY created_at DESC`;
  return rows;
}

// NO `memberId` (issue #690). The id is minted by addMemberAdmin below, exactly
// as applyMember mints it for the public front door, and there is no way to ask
// for a particular one. The route's parser (parseManualMember) REFUSES a body
// that still carries the field rather than dropping it, so no client is told
// "201 created" about an id it did not get back.
export interface ManualMemberInput {
  name: string;
  publicKey: string;
  lens?: string;
  contact?: string;
}

// The 409 this path answers a duplicate credential with (issue #690). See the
// probe below for why the public key is what "duplicate" now means here.
export const MANUAL_MEMBER_KEY_CONFLICT =
  "publicKey already belongs to a member; rotate that member's key instead of adding a second one";

// Admin manual add: creates an ACTIVE member + ACTIVE key + one-time bearer
// token in a single transaction, bypassing the public apply/activate flow.
// The token is returned ONLY in this response — never persisted or re-readable.
export async function addMemberAdmin(input: ManualMemberInput, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  // THE ID IS MINTED HERE (issue #690), never supplied. Until #690 this route
  // INSERTed a caller-supplied string as the primary key, which is how members
  // whose id is a human slug came to exist — and a slug id is not cosmetic:
  // migration 0031 refuses a handle equal to ANOTHER member's id (so an id of
  // `woon` bars the member actually named Woon from ever holding `woon`), and
  // migration 0030's `handle = id` sentinel makes such a member read as
  // "handle unset" forever, re-derived at every acceptance. `crypto.randomUUID()`
  // is the same mint applyMember uses (domain.ts), so both admission paths now
  // produce ids of one shape and the public `handle` is the only readable name.
  const memberId = crypto.randomUUID();
  // UNIQUENESS. The old probe asked whether the caller's chosen id was already
  // taken as an id or a handle. With a freshly minted UUID neither question has
  // an answer worth asking, so duplicate detection moves to the one thing the
  // caller still names that IS an identity: the public key. Two members sharing
  // a key make every signed take ambiguous about who produced it, and the same
  // refusal already guards the public path (applyMember). It is also what keeps
  // the realistic accident — an operator submitting the add form twice — a 409
  // rather than two members with one credential between them.
  const existingKey = (await sql<{ member_id: string }[]>`
    SELECT member_id FROM swarm_member_keys WHERE public_key = ${input.publicKey} LIMIT 1`)[0];
  if (existingKey) return err(409, MANUAL_MEMBER_KEY_CONFLICT);
  const token = `tok_${memberId}_${crypto.randomUUID()}`;
  try {
    return await sql.begin(async (tx) => {
      // Capacity gate: a brand-new active member must fit under SWARM_ROSTER_CAP.
      const cap = await assertRosterCapacity(tx);
      if (!cap.ok) return err(cap.status, cap.error);
      // The INSERT names NO handle, so migration 0030's trigger stamps
      // `handle := id` — the UUID — and the UPDATE two statements below moves it
      // to the name-derived handle. Before #690 that two-step also served as a
      // physical guard: `handle = id` put the create inside
      // swarm_members_handle_key against a concurrent uncommitted rename TO the
      // caller's chosen id (#596). That guard is now moot, because nobody
      // renames a member to a freshly minted UUID — the only handle this create
      // can contend for is the DERIVED one, and it contends for it in the
      // UPDATE, which is where the catch below picks the loser up.
      await tx`
        INSERT INTO swarm_members (id, status, name, lens, contact_email, applied_at, activated_at)
        VALUES (${memberId}, 'active', ${input.name}, ${input.lens ?? null}, ${input.contact ?? null}, now(), now())`;
      // Issue #562: the manual add seats an ACTIVE member in one shot, so it is
      // its own derivation point — nothing accepts this member later. Unchanged
      // by #690: the id it derives FOR is now a UUID rather than an operator's
      // string, but the handle is still `slugifyMemberName(name)` plus the
      // lowest free numeric suffix, and the id remains the immutable identity
      // that keeps resolving as a public reference (getMember reads both names).
      const handle = await deriveMemberHandle(tx, { memberId, name: input.name });
      const derived = await tx`
        UPDATE swarm_members SET handle = ${handle} WHERE id = ${memberId} RETURNING *`;
      await tx`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash)
               VALUES (${memberId}, ${input.publicKey}, true, ${hashKey(token)})`;
      await audit(actor, "member_manual_add", { memberId, handle }, tx);
      return { ok: true, status: 201, member: toMemberAdmin(derived[0]), token };
    });
  } catch (e) {
    // deriveMemberHandle's probe is a READ COMMITTED snapshot, so it cannot see
    // a rename that commits between it and the UPDATE above. The loser of that
    // race is refused by swarm_members_handle_key (or 0031's trigger) and gets
    // the SAME sentence the rename path's lost race gets, because it is the
    // same situation from the other side: the public name is gone, try again
    // (a retry re-derives and takes the next free suffix). Anything else
    // rethrows untouched rather than being described as a naming conflict.
    if (isHandleUniqueViolation(e)) return err(409, "handle already taken");
    throw e;
  }
}

export async function reviewApplicationAdmin(
  memberId: string,
  decision: "approve" | "reject",
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  if (decision === "approve") {
    // Reuse the SAME activation transaction the public path uses. Approval
    // activates the pending key, queues the email, and flips status active;
    // bearer plaintext is minted only by the member's first signed claim.
    const res = await activateMember(memberId);
    if (!res.ok) return res as AdminResult;
    return {
      ok: true,
      status: 200,
      memberId,
      memberStatus: "active",
      claimRequired: true,
      notificationQueued: res.notificationQueued,
    };
  }
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT id, status FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "no such applicant");
    if (row.status !== "applied") return err(409, `cannot reject a member in status=${row.status}`);
    // swarm_members.status has no 'rejected' value (CHECK constraint from
    // #150's migration 0017_admin_surface.sql only allows applied/active/
    // inactive) — the rejection itself is recorded on the APPLICATION; the
    // member row folds to 'inactive', its key stays inactive (never issued).
    await tx`UPDATE swarm_members SET status = 'inactive', version = version + 1, updated_at = now() WHERE id = ${memberId}`;
    await tx`UPDATE swarm_applications SET status = 'rejected', reviewed_at = now() WHERE member_id = ${memberId} AND status = 'pending'`;
    await audit(actor, "member_reject", { memberId }, tx);
    return { ok: true, status: 200, memberId, memberStatus: "inactive", applicationStatus: "rejected" };
  });
}

// The admin-editable member surface. `undefined` means "absent, leave it
// alone"; an explicit `null` means "CLEAR this column". `name` has no null —
// swarm_members.name is NOT NULL. Validated by validateMemberAdminPatch in
// api/validation.ts, which is the only thing allowed to construct one of these
// from an untrusted body.
export interface MemberAdminPatch {
  /** Public URL segment (issue #593). Never null — a member always has one. */
  handle?: string;
  name?: string;
  lens?: string | null;
  contactEmail?: string | null;
  tagline?: string | null;
  mandate?: string | null;
  biases?: string[] | null;
  voiceMd?: string | null;
  mode?: string | null;
  operator?: string | null;
  avatar?: Record<string, unknown> | null;
}

// The member counterpart to updateSubjectAdmin: same optimistic-concurrency
// contract (FOR UPDATE, expectedVersion, 409 stale_version), same audit row.
//
// This is the ONLY write path that can correct name/lens/contact_email on a
// seated member — the self-service profile route (#325) deliberately refuses
// all three, which is right for the member and useless to the operator who has
// to fix what an agent submitted at apply time.
//
// Deliberately NOT here: no status change (deactivate/reactivate own that), no
// key or credential change (rotate-key owns that).
export async function updateMemberAdmin(
  memberId: string,
  expectedVersion: number,
  patch: MemberAdminPatch,
  actor: Actor = ADMIN_ACTOR,
  reason?: string,
): Promise<AdminResult> {
  try {
    return await updateMemberAdminTx(memberId, expectedVersion, patch, actor, reason);
  } catch (e) {
    // The probe inside the transaction is a READ COMMITTED snapshot, so it
    // cannot see a rename that commits between it and the UPDATE. Since #597
    // the database refuses that write too (0030's unique index for handle vs
    // handle, 0031's trigger for handle vs another member's id), and the loser
    // of the race deserves the same actionable answer the probe gives rather
    // than the `500 internal error` an escaped exception is sanitized to.
    if (isHandleUniqueViolation(e)) return err(409, "handle already taken");
    throw e;
  }
}

async function updateMemberAdminTx(
  memberId: string,
  expectedVersion: number,
  patch: MemberAdminPatch,
  actor: Actor,
  reason?: string,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT * FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");

    // UNIQUENESS, and it is deliberately checked against BOTH names of every
    // other member (issue #593). A handle equal to another member's `handle` is
    // the obvious collision — swarm_members_handle_key would raise a 500 out of
    // the UPDATE below rather than an answer an operator can act on. A handle
    // equal to another member's legacy `id` is the subtle one: no index forbids
    // it, and it would make /swarm/members/:ref ambiguous, quietly stealing a
    // URL that has been published for someone else. Both are refused with the
    // same 409 the rest of this surface uses for a lost race.
    if (patch.handle !== undefined && patch.handle !== row.handle) {
      const taken = (await tx`
        SELECT 1 FROM swarm_members
        WHERE (handle = ${patch.handle} OR id = ${patch.handle}) AND id <> ${memberId}
        LIMIT 1`)[0];
      if (taken) return err(409, "handle already taken");
    }

    // `!== undefined`, NOT `??`. An explicit null is a CLEAR, and `??` reads it
    // as "absent" and keeps the old value while returning 200 — a success the
    // database did not perform. updateSubjectAdmin still has exactly that bug
    // on linkedMemberId; it is filed as a separate one-line follow-up so this
    // change does not also move the topic form's client-side guard.
    const keep = <T>(next: T | undefined, current: T): T => (next !== undefined ? next : current);
    const merged = {
      handle: keep(patch.handle, row.handle ?? row.id),
      name: keep(patch.name, row.name),
      lens: keep(patch.lens, row.lens),
      contact_email: keep(patch.contactEmail, row.contact_email),
      tagline: keep(patch.tagline, row.tagline),
      mandate: keep(patch.mandate, row.mandate),
      biases: keep(patch.biases, row.biases),
      voice_md: keep(patch.voiceMd, row.voice_md),
      mode: keep(patch.mode, row.mode),
      operator: keep(patch.operator, row.operator),
      avatar: keep(patch.avatar, row.avatar),
    };

    const upd = await tx`
      UPDATE swarm_members SET
        handle = ${merged.handle}, name = ${merged.name}, lens = ${merged.lens},
        contact_email = ${merged.contact_email}, tagline = ${merged.tagline},
        mandate = ${merged.mandate}, biases = ${tx.json(merged.biases as any)},
        voice_md = ${merged.voice_md}, mode = ${merged.mode}, operator = ${merged.operator},
        avatar = ${tx.json(merged.avatar as any)},
        version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");

    // `reason` is PERSISTED here rather than discarded (#561's closing note).
    // The scope also names the fields that changed, so the trail says what was
    // edited and not only that an edit happened.
    // A handle change is the one edit here that moves a PUBLIC URL, so the
    // trail records the old and new value, not just the field name: "handle was
    // in the fields list" cannot answer "what was this member called when that
    // link was shared?" months later.
    await audit(actor, "member_update", {
      memberId,
      fields: Object.keys(patch),
      ...(patch.handle !== undefined
        ? { handleFrom: (row.handle ?? row.id) as string, handleTo: patch.handle }
        : {}),
      ...(reason ? { reason } : {}),
    }, tx);
    return { ok: true, status: 200, member: toMemberAdmin(upd[0]) };
  });
}

export async function deactivateMemberAdmin(
  memberId: string,
  expectedVersion: number,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT * FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const wasActive = row.status === "active";
    const upd = await tx`
      UPDATE swarm_members SET status = 'inactive', version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await tx`UPDATE swarm_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    if (wasActive) {
      const activeCount = await countActiveMembersTx(tx);
      if (activeCount < SWARM_ROSTER_CAP) {
        await enqueueSeatOpenNotifications(tx);
      }
    }
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
    const row = (await tx`SELECT * FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const lastKey = (await tx`SELECT public_key FROM swarm_member_keys WHERE member_id = ${memberId} ORDER BY created_at DESC LIMIT 1`)[0] as
      | { public_key: string }
      | undefined;
    if (!lastKey) return err(409, "member has no on-file public key; use rotate-key with a new one");
    // Capacity gate: reactivation raises the active count, so the member (which
    // is currently 'inactive') must fit under SWARM_ROSTER_CAP — no exemption.
    const cap = await assertRosterCapacity(tx);
    if (!cap.ok) return err(cap.status, cap.error);
    const upd = await tx`
      UPDATE swarm_members SET status = 'active', version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await tx`UPDATE swarm_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    const token = `tok_${memberId}_${crypto.randomUUID()}`;
    await tx`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash) VALUES (${memberId}, ${lastKey.public_key}, true, ${hashKey(token)})`;
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
    const member = (await tx`SELECT id, version FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!member) return err(404, "member not found");
    const priorActive = (await tx`SELECT public_key FROM swarm_member_keys WHERE member_id = ${memberId} AND active = true ORDER BY created_at DESC LIMIT 1`)[0] as
      | { public_key: string }
      | undefined;
    const publicKey = opts.publicKey ?? priorActive?.public_key;
    if (!publicKey) return err(409, "no on-file public key; supply publicKey to rotate");
    await tx`UPDATE swarm_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    const token = `tok_${memberId}_${crypto.randomUUID()}`;
    await tx`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash) VALUES (${memberId}, ${publicKey}, true, ${hashKey(token)})`;
    await tx`UPDATE swarm_members SET version = version + 1, updated_at = now() WHERE id = ${memberId}`;
    await audit(actor, "member_rotate_key", { memberId }, tx);
    return { ok: true, status: 200, memberId, token };
  });
}

// ── Admin avatar upload (issue #626) ────────────────────────────────────────
// The real thing: swarm/admin.ts's updateMemberAdmin already lets an admin
// point avatar.path at an arbitrary URL string (metadata-only, no bytes
// stored). This is the endpoint that stores actual image bytes and points
// avatar.path at them, so it flows through the SAME precedence chain issue
// #625 built in frontend/assets/js/app/lib/member-mark.js: memberAvatarMarkup
// treats any avatar.path that loads as taking precedence over the derived
// mark, so a stored, servable file at the path this writes is all "uploaded
// wins" requires — no separate precedence flag.
//
// STORED IN POSTGRES, NOT STATIC_DIR. The first cut of this wrote bytes to
// STATIC_DIR/avatars/uploads/. That directory does not survive a redeploy:
// scripts/static-assembly.sh wipes and re-copies STATIC_DIR's contents on
// every `docker compose up`, so an uploaded avatar would silently vanish on
// the next release. swarm_member_avatars (migration 0035) is the durable
// store instead; avatar.path now points at a route
// (routes/swarm.ts's GET .../members/:id/avatar) that reads the bytes back
// out of that table, not a file on disk.
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB: generous for a profile photo.
export const AVATAR_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface AvatarUploadInput {
  contentType: string | null;
  bytes: Uint8Array;
}

// Storage is DB-backed now, so there is no filesystem path to traverse — the
// UPDATE/INSERT below are parameterized like every other query here, so an
// arbitrary string in memberId cannot reach SQL as anything but a bind value.
// This check stays anyway: every real member id is minted by
// crypto.randomUUID() (addMemberAdmin, applyMember) and never anything else,
// so a non-UUID-shaped id can never name a real member — rejecting it here is
// a fast, clear 404 instead of a round trip to prove the same thing.
const MEMBER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validation (type, size, id shape) runs BEFORE any database write, so a
// rejected upload leaves nothing behind. The bytes row and the member's
// avatar pointer are written in ONE transaction — a not-found member or a
// failed commit leaves neither half written; there is no temp-file/rename
// dance to get wrong because there is no file.
export async function uploadMemberAvatarAdmin(
  memberId: string,
  input: AvatarUploadInput,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  const type = (input.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = AVATAR_CONTENT_TYPES[type];
  if (!ext) {
    return err(400, `unsupported avatar content-type "${input.contentType ?? ""}"; allowed: ${Object.keys(AVATAR_CONTENT_TYPES).join(", ")}`);
  }
  if (input.bytes.byteLength === 0) return err(400, "empty upload");
  if (input.bytes.byteLength > AVATAR_MAX_BYTES) return err(400, `avatar exceeds ${AVATAR_MAX_BYTES}-byte limit`);
  if (!MEMBER_ID_RE.test(memberId)) return err(404, "member not found");

  // Cache-bust token decided up front (not derived from the row's version),
  // so the query string is stable across the write and does not depend on
  // whether the later UPDATE succeeds.
  const cacheBust = crypto.randomUUID().slice(0, 8);
  const avatarPath = `/api/swarm/members/${memberId}/avatar?v=${cacheBust}`;
  const avatar = { path: avatarPath, source_url: null, credit: "Uploaded by admin" };

  return sql.begin(async (tx) => {
    const upd = await tx`
      UPDATE swarm_members SET avatar = ${tx.json(avatar as any)}, version = version + 1, updated_at = now()
      WHERE id = ${memberId}
      RETURNING id`;
    if (upd.length === 0) return err(404, "member not found");
    await tx`
      INSERT INTO swarm_member_avatars (member_id, content_type, bytes, byte_size)
      VALUES (${memberId}, ${type}, ${Buffer.from(input.bytes)}, ${input.bytes.byteLength})
      ON CONFLICT (member_id) DO UPDATE
        SET content_type = EXCLUDED.content_type,
            bytes = EXCLUDED.bytes,
            byte_size = EXCLUDED.byte_size,
            uploaded_at = now()`;
    await audit(actor, "member_avatar_upload", { memberId, path: avatarPath, contentType: type, byteSize: input.bytes.byteLength }, tx);
    return { ok: true, status: 200, memberId, avatar };
  });
}

// ── Sessions: creation with a frozen roster snapshot ────────────────────────
// Field/validation shape matches docs/architecture.md §6.3
// SessionCreateRequest: three explicit ISO instants, ordering
// briefOpensAt < windowClosesAt < publishAt, and `date` must equal the UTC
// date of briefOpensAt.
export interface SessionCreateInput {
  date: string; // YYYY-MM-DD, UTC calendar date
  subjectId: string;
  briefOpensAt: string; // ISO instant
  windowClosesAt: string; // ISO instant
  publishAt: string; // ISO instant
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidUtcDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

// Job kinds + their canonical scoped dedupe key, per docs §4 US-C3/§6.3:
// `swarm:<session-id>:<action>`.
const SESSION_JOB_KINDS = ["swarm.publish_brief", "swarm.close_window", "swarm.aggregate", "swarm.publish"] as const;
const JOB_ACTION: Record<(typeof SESSION_JOB_KINDS)[number], string> = {
  "swarm.publish_brief": "publish_brief",
  "swarm.close_window": "close_window",
  "swarm.aggregate": "aggregate",
  "swarm.publish": "publish",
};

export async function createSessionAdmin(input: SessionCreateInput, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  if (!isValidUtcDate(input.date)) return err(400, "date must be a valid UTC calendar date (YYYY-MM-DD)");
  const briefOpensAt = new Date(input.briefOpensAt);
  const windowClosesAt = new Date(input.windowClosesAt);
  const publishAt = new Date(input.publishAt);
  if ([briefOpensAt, windowClosesAt, publishAt].some((d) => Number.isNaN(d.getTime())))
    return err(400, "briefOpensAt, windowClosesAt, and publishAt must be valid ISO timestamps");
  if (briefOpensAt.toISOString().slice(0, 10) !== input.date)
    return err(400, "briefOpensAt date does not match date (date mismatch)");
  if (!(briefOpensAt.getTime() < windowClosesAt.getTime() && windowClosesAt.getTime() < publishAt.getTime()))
    return err(400, "invalid timestamp ordering: briefOpensAt < windowClosesAt < publishAt required");

  const subject = (await sql`SELECT id, status, name FROM swarm_subjects WHERE id = ${input.subjectId}`)[0] as
    | { id: string; status: string; name: string }
    | undefined;
  if (!subject) return err(404, "subject not found");
  if (subject.status !== "active") return err(409, "topic is not active");

  // Newest first: a subject may now have several sessions on one date
  // (migration 0022 dropped UNIQUE(date, subject_id)), and it is the most recent
  // one that decides whether this create is a re-schedule or a conflict.
  const existing = (await sql`SELECT id, state FROM swarm_sessions
                              WHERE date = ${input.date} AND subject_id = ${input.subjectId}
                              ORDER BY convened_at DESC LIMIT 1`)[0] as
    | { id: string; state: string }
    | undefined;
  if (existing && existing.state !== "scheduled") return err(409, "a session already exists for this date/topic");

  return sql.begin(async (tx) => {
    const rows = existing
      ? await tx`
          UPDATE swarm_sessions SET
            brief_opens_at = ${briefOpensAt}, window_closes_at = ${windowClosesAt}, publish_at = ${publishAt}, version = version + 1
          WHERE id = ${existing.id}
          RETURNING id, date, subject_id, subject_name, state, version`
      : await tx`
          -- No date column here: since migration 0022 it is generated from
          -- convened_at. An admin-scheduled session convenes at briefOpensAt, so
          -- that instant IS its convened_at, and the derived date necessarily
          -- equals the input.date already validated to agree with it above.
          -- The admin still chooses WHEN a session sits; nobody chooses a date
          -- that disagrees with when it sat.
          INSERT INTO swarm_sessions (convened_at, subject_id, subject_name, state, brief_opens_at, window_closes_at, publish_at)
          VALUES (${briefOpensAt}, ${input.subjectId}, ${subject.name}, 'scheduled', ${briefOpensAt}, ${windowClosesAt}, ${publishAt})
          RETURNING id, date, subject_id, subject_name, state, version`;
    const session = rows[0];
    const sessionId = session.id as string;

    // Frozen roster: snapshot every currently-active member (name/lens
    // denormalized at snapshot time) into the CANONICAL swarm_session_members
    // table (docs §5.3 / issue #150's migration). Later member activation/
    // deactivation NEVER rewrites this list — roster add/excuse are the only
    // sanctioned edits, and only before collecting begins.
    const activeMembers = await tx<{ id: string; name: string; lens: string | null }[]>`
      SELECT id, name, lens FROM swarm_members WHERE status = 'active'`;
    for (const m of activeMembers) {
      await tx`
        INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
        VALUES (${sessionId}, ${m.id}, ${m.name}, ${m.lens}, 'expected')
        ON CONFLICT (session_id, member_id) DO NOTHING`;
    }

    // Exactly four deduplicated, session-scoped jobs (docs §4 US-C3): dedupe
    // key `swarm:<session-id>:<action>` so re-creating a still-scheduled
    // session never double-enqueues.
    const jobTimes: Record<(typeof SESSION_JOB_KINDS)[number], Date> = {
      "swarm.publish_brief": briefOpensAt,
      "swarm.close_window": windowClosesAt,
      "swarm.aggregate": new Date(windowClosesAt.getTime() + 1_000),
      "swarm.publish": publishAt,
    };
    const jobIds: number[] = [];
    for (const kind of SESSION_JOB_KINDS) {
      const dedupeKey = `swarm:${sessionId}:${JOB_ACTION[kind]}`;
      const r = await tx`
        INSERT INTO jobs (kind, payload, run_after, dedupe_key, scope_type, scope_id, requested_by)
        VALUES (${kind}, ${tx.json({ sessionId } as any)}, ${jobTimes[kind]}, ${dedupeKey}, 'swarm_session', ${sessionId}, ${actor})
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
// Backed by the CANONICAL swarm_session_members table (issue #150). Status
// vocabulary is 'expected' | 'excused' (not 'active'); there is no separate
// "restored" marker — restoring simply flips status back to 'expected'.
async function requireRosterEditable(tx: DbHandle, sessionId: string) {
  const s = (await tx`SELECT id, state FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`)[0] as
    | { id: string; state: string }
    | undefined;
  if (!s) return { ok: false as const, status: 404, error: "session not found" };
  if (s.state !== "scheduled") return { ok: false as const, status: 409, error: `roster is locked once collection begins (state=${s.state})` };
  return { ok: true as const };
}

export async function getSessionRoster(sessionId: string) {
  return sql`
    SELECT member_id, member_name, member_lens, status, included_at, excused_at, reason
    FROM swarm_session_members WHERE session_id = ${sessionId} ORDER BY member_id`;
}

export async function rosterAddAdmin(sessionId: string, memberId: string, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const gate = await requireRosterEditable(tx, sessionId);
    if (!gate.ok) return err(gate.status, gate.error);
    const member = (await tx<{ id: string; name: string; lens: string | null }[]>`SELECT id, name, lens FROM swarm_members WHERE id = ${memberId}`)[0];
    if (!member) return err(404, "member not found");
    await tx`
      INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
      VALUES (${sessionId}, ${memberId}, ${member.name}, ${member.lens}, 'expected')
      ON CONFLICT (session_id, member_id) DO UPDATE SET status = 'expected', excused_at = NULL`;
    await audit(actor, "roster_add", { sessionId, memberId }, tx);
    return { ok: true, status: 200, sessionId, memberId, memberStatus: "expected" };
  });
}

export async function rosterExcuseAdmin(sessionId: string, memberId: string, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const gate = await requireRosterEditable(tx, sessionId);
    if (!gate.ok) return err(gate.status, gate.error);
    const upd = await tx`UPDATE swarm_session_members SET status = 'excused', excused_at = now() WHERE session_id = ${sessionId} AND member_id = ${memberId} RETURNING member_id`;
    if (upd.length === 0) return err(404, "member is not on this session's roster");
    await audit(actor, "roster_excuse", { sessionId, memberId }, tx);
    return { ok: true, status: 200, sessionId, memberId };
  });
}

export async function rosterRestoreAdmin(sessionId: string, memberId: string, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const gate = await requireRosterEditable(tx, sessionId);
    if (!gate.ok) return err(gate.status, gate.error);
    const upd = await tx`UPDATE swarm_session_members SET status = 'expected', excused_at = NULL WHERE session_id = ${sessionId} AND member_id = ${memberId} RETURNING member_id`;
    if (upd.length === 0) return err(404, "member is not on this session's roster");
    await audit(actor, "roster_restore", { sessionId, memberId }, tx);
    return { ok: true, status: 200, sessionId, memberId };
  });
}

// ── Guarded lifecycle transitions ───────────────────────────────────────────
// Session states: scheduled → collecting → window_closed → aggregated →
// published, with `cancelled` reachable from any non-terminal state and
// `window_closed` reopenable back to `collecting`. published/cancelled are
// terminal — no further transition is ever legal. Action names and the legal
// matrix match docs/architecture.md §4 US-C4 exactly.
const TERMINAL = new Set(["published", "cancelled"]);
const TRANSITIONS: Record<string, readonly string[]> = {
  scheduled: ["collecting", "cancelled"],
  collecting: ["window_closed", "cancelled"],
  window_closed: ["collecting", "aggregated", "cancelled"],
  aggregated: ["window_closed", "published"],
  published: [],
  cancelled: [],
};
const ACTION_FOR_TO_STATE: Record<string, string> = {
  collecting: "publish_brief", // scheduled -> collecting; window_closed -> collecting is "reopen" (passed explicitly)
  window_closed: "close_window",
  aggregated: "aggregate",
  published: "publish",
  cancelled: "cancel",
};

export interface GuardedTransitionResult extends AdminResult {
  session?: { id: string; state: string; version: number };
  idempotent?: boolean;
}

// Advances swarm_sessions.state under an optimistic-concurrency + legal-
// transition guard, and writes exactly one swarm_session_events row
// (with the NOT NULL `action` column the canonical schema requires) and one
// audit_log row for every REAL transition, transactionally. Re-requesting the
// CURRENT state is idempotent (200, no version bump, no new event/audit row);
// requesting a transition out of a terminal state, or one not in the legal
// table, is 409.
export async function guardedTransition(
  sessionId: string,
  toState: string,
  actor: Actor,
  opts: { expectedVersion?: number; action?: string; reason?: string } = {},
): Promise<GuardedTransitionResult> {
  const action = opts.action ?? ACTION_FOR_TO_STATE[toState] ?? toState;
  return sql.begin(async (tx) => {
    const row = (await tx`SELECT id, state, version FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`)[0] as
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
    const upd = await tx`UPDATE swarm_sessions SET state = ${toState}, version = version + 1 WHERE id = ${sessionId} RETURNING id, state, version`;
    await tx`
      INSERT INTO swarm_session_events (session_id, from_state, to_state, action, actor, reason)
      VALUES (${sessionId}, ${row.state}, ${toState}, ${action}, ${actor}, ${opts.reason ?? null})`;
    await audit(actor, "session_transition", { sessionId, from: row.state, to: toState, action }, tx);
    return { ok: true, status: 200, session: { id: upd[0].id, state: upd[0].state, version: Number(upd[0].version) } };
  });
}

export async function cancelSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR, reason?: string) {
  return guardedTransition(sessionId, "cancelled", actor, { expectedVersion, reason });
}

export async function closeSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR, reason?: string) {
  return guardedTransition(sessionId, "window_closed", actor, { expectedVersion, reason });
}

export async function reopenSessionAdmin(sessionId: string, expectedVersion: number | undefined, actor: Actor = ADMIN_ACTOR, reason?: string) {
  return guardedTransition(sessionId, "collecting", actor, { expectedVersion, action: "reopen", reason });
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
  await sql`UPDATE swarm_sessions SET published_at = now() WHERE id = ${sessionId} AND published_at IS NULL`;
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
