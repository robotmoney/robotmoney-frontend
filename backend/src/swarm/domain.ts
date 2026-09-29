// Swarm domain/service layer — the single place the rules live (window
// enforcement, signature verification, aggregation). The REST handlers, the MCP
// server, the worker, and the dev driver all call these; they never diverge.
import {
  canonicalizeApplication,
  canonicalizeJudgement,
  classifyRegime,
  RECEIPT_CANONICAL_BUCKET_ORDER,
  REGIME_METHOD,
  type RegimeLabel,
  type RegimeSummary,
  SWARM_ROSTER_CAP,
  SWARM_TAKE_REVISION_CAP,
  path as routePath,
  ROUTES,
  STANCES,
} from "@robotmoney/contract";
import { config } from "../config.ts";
import { type DbHandle, jsonValue, sql } from "../db/client.ts";
import { on, onStatement, registerQuery, registerStatement } from "../db/registry.ts";
import { hashKey } from "../lib/keys.ts";
// The epoch lifecycle and the stream's log live in ./epoch.ts, with every
// statement registered. Re-exported so callers of this module are unchanged.
// A cycle: epoch.ts imports helpers back from here, and touches them only in
// function bodies.
export * from "./epoch.ts";
import {
  eventsAbove,
  isUuid,
  readPresent,
  recordJudgingConsensusTx,
  resyncReasonFor,
  streamHeadSequence,
  type ResyncReason,
  type ServedStreamEvent,
} from "./epoch.ts";
import {
  fingerprintPublicKey,
  verifyApplicationSignature,
  verifyClaimChallengeSignature,
  verifyDetachedSignature,
  verifySubmissionSignature,
} from "../lib/signing.ts";
// The PURE half of the consensus judge: the parser every judgement passes
// through and the digest that pins what a judge read. judge.ts imports nothing
// from this module, so there is no cycle.
import {
  DIGEST_SCHEME,
  findWeightLikeKey,
  inputsDigest,
  JudgeResponseError,
  noDrops,
  parseJudgeResponse,
  type JudgeInput,
  type JudgeOpinion,
  type JudgeTake,
} from "./judge.ts";
// Pure canonicalization shared with the #977/#978 analytics ledgers — no DB
// import, so pulling it in here carries no cycle risk. Every brief revision's
// body is hashed the SAME way an analytics report/output snapshot is, so "the
// stored checksum recomputes clean from the retrieved bytes" is one proof
// technique across both ledgers.
import { canonicalStringify, sha256Hex } from "../analytics/run-ledger.ts";
// Issue #979: once cutover is armed, a brief-by-session read resolves the
// body from swarm_brief_revisions (never swarm_briefs) — see
// analytics/cutover/ledger-current.ts's header.
import { getAnalyticsReadMode } from "../analytics/cutover/read-mode.ts";
import { ledgerCurrentBriefBySession } from "../analytics/cutover/ledger-current.ts";
// Issue #562: a new member's public handle comes from its name, not from the
// UUID applyMember minted for it. Leaf module — imports nothing from here, so
// admin.ts can call it on the manual-add path too without a cycle.
import { deriveMemberHandle, handleIsUnset } from "./handle.ts";
import {
  day,
  instant,
  toBrief,
  toMember,
  toMemo,
  toSession,
  toSessionListItem,
  toSnapshot,
  toSubject,
  toVerifiedTake,
} from "./projections.ts";

// EVERY STATEMENT IN THIS FILE IS REGISTERED (smoke-production-spec.md §7.1). A
// statement goes through `on(...)` with a declaration of `(role, object,
// privilege)` and a probe that tests/db-registry-execution.test.ts runs as the
// declared role, held to the call site's exact statement. This module is not on
// the raw-statement allowlist. The api is the only program that reaches it, so
// every declaration is `rm_app`. Where one statement reads several relations,
// each relation is its own declaration and they share one probe.
//
// Entry modules (QueryDeclaration.callers): the public swarm routes, the
// member-facing onboarding and receipt routes, the admin routes, the judge's
// participant route and the stream.
const SWARM_ROUTE = "src/api/routes/swarm";
const ONBOARDING_ROUTE = "src/api/routes/swarm/onboarding";
const RECEIPTS_ROUTE = "src/api/routes/swarm/receipts";
const ADMIN_ROUTE = "src/api/routes/swarm-admin";
const JUDGE_ROUTE = "src/api/routes/swarm-judge-participant";
const STREAM_ROUTE = "src/api/routes/swarm-stream";
const OVERVIEW_ROUTE = "src/api/routes/admin";
/** A well-formed sample id for a probe's bound value. */
const SAMPLE_ID = "00000000-0000-0000-0000-000000000000";

// ── Identity ──────────────────────────────────────────────────────────────
// Issue #799: a key row's `active` flag and its member's `status` are
// independent — rotateMemberKeyAdmin() (admin.ts) mints a fresh active key
// against an INACTIVE member on purpose (it is the documented remedy for
// CARRIED_KEY_UNREGISTRABLE ahead of reactivation), and deactivateMemberAdmin
// revoking keys only covers the deactivation instant, not a rotation that
// happens afterward. Without this join, that fresh key authenticates as a
// live member token even though the member it belongs to cannot act.
//
// Fixed at THIS single choke point rather than in each downstream write path
// (submitRecommendation, postMemo, updateMemberProfile, the /verify-token
// route) because every one of those resolves identity by calling this
// function — joining status here makes "the token does not authenticate"
// the one true statement callers get, instead of "the token authenticates
// but is not authorized," which every future caller would have to remember
// to re-check. This is intentionally NOT a "join here AND check status again
// at every write path" belt-and-suspenders design: a second, independent
// status re-check downstream would silently diverge from this one the next
// time either changes, and #799 exists precisely because one of four
// call sites already had.
//
// This is safe for the reactivation flow it appears to interfere with: a key
// rotated while the member is still inactive simply cannot authenticate
// until the member is reactivated, and reactivateMemberAdmin ALWAYS revokes
// the current active key and mints a brand-new token in the same
// transaction that flips status back to 'active' — so the pre-reactivation
// token is superseded, never valid, at every point in time.
const TOKEN_PROBE = {
  statement: `SELECT k.member_id FROM swarm_member_keys k
    JOIN swarm_members m ON m.id = k.member_id AND m.status = 'active'
    WHERE k.token_hash = $1 AND k.active LIMIT 1`,
  params: ["0"],
} as const;
const TOKEN_CALLERS = [SWARM_ROUTE, ONBOARDING_ROUTE, ADMIN_ROUTE, JUDGE_ROUTE, STREAM_ROUTE];
const tokenKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:memberIdForToken.keys",
  purpose: "Resolve a bearer token's hash to the member whose active key it is.",
  callers: TOKEN_CALLERS,
  probe: TOKEN_PROBE,
});
const tokenMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:memberIdForToken.members",
  purpose: "Refuse a token whose member is not active (issue #799).",
  callers: TOKEN_CALLERS,
  probe: TOKEN_PROBE,
});
export async function memberIdForToken(token: string): Promise<string | null> {
  const rows = await on(sql, tokenKeys, tokenMembers)<{ member_id: string }>`
    SELECT k.member_id FROM swarm_member_keys k
    JOIN swarm_members m ON m.id = k.member_id AND m.status = 'active'
    WHERE k.token_hash = ${hashKey(token)} AND k.active LIMIT 1`;
  return rows[0]?.member_id ?? null;
}

// Issue #697: a take's public key must be resolved by the key that ACTUALLY
// SIGNED IT (`signing_key_id`, recorded on the row at submission time — see
// submitRecommendation), never by whichever key happens to be active NOW.
// The active key can rotate (or be re-registered) long after an already
// stored, append-only take was written, and re-resolving "currently active"
// at read time silently starts checking history against the wrong key.
//
// Rows written before `signing_key_id` existed have it NULL and fall back to
// that older "currently active key" lookup — a documented cutover point
// (migration 0049's header), not a claim that those older rows are correctly
// attributed. The lookup is written out in each statement that needs it (three
// below, every one with the recommendation row aliased as `r`), because a
// statement is registered as one piece of text and a fragment a helper returns
// is not part of it.
const SIGNING_KEY_PROBE = `COALESCE(
    (SELECT k.public_key FROM swarm_member_keys k WHERE k.id = r.signing_key_id),
    (SELECT k.public_key FROM swarm_member_keys k
     WHERE k.member_id = r.member_id AND k.active
     ORDER BY k.created_at DESC LIMIT 1)
  )`;

// Issue #697: callers need BOTH the key material (to verify against) and the
// key's own row id (to record, at write time, which exact key verified a
// take — see submitRecommendation's INSERT). A bare public_key string cannot
// answer "which row was this" once a member has rotated more than once.
// `id` is typed `string`, not `number` — swarm_member_keys.id is `bigserial`,
// and postgres.js returns bigint columns as strings to avoid silent precision
// loss (the same convention swarm_session_judgements.id is read under
// elsewhere in this codebase). It is never arithmetic here, only threaded
// through to another query parameter.
const activeKey = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:activeKeyFor",
  purpose: "Read a member's newest active key: the material a take is verified against and the row id recorded with it.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT id, public_key FROM swarm_member_keys
    WHERE member_id = $1 AND active ORDER BY created_at DESC LIMIT 1`,
    params: ["probe"],
  },
});
async function activeKeyFor(memberId: string): Promise<{ id: string; publicKey: string } | null> {
  const rows = await on(sql, activeKey)<{ id: string; public_key: string }>`
    SELECT id, public_key FROM swarm_member_keys
    WHERE member_id = ${memberId} AND active ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ? { id: rows[0].id, publicKey: rows[0].public_key } : null;
}

// Fixed maximum size for the standing swarm. HARD-ENFORCED at every
// transition-to-active in the domain/admin layer (activateMember, admin manual
// add, admin reactivate, and the smoke registerMember shortcut) via
// assertRosterCapacity below — an over-cap admission is refused with a 409, not
// merely warned about. (The onboarding smoke driver also self-throttles ahead of
// the write, but the write path is now the authoritative gate.) The CANONICAL
// value lives in @robotmoney/contract (contract/src/swarm.js) — the shared
// channel mcp/scripts can also import, retiring the comment-enforced
// e2e.SWARM_ROSTER_CAP mirror (finding 008). Re-exported under the same name
// so backend/tests/swarm-roster-cap.test.ts (which pins its assertions to
// this constant, never a literal) keeps reading it from the domain layer.
export { SWARM_ROSTER_CAP };

// Per-member-per-session take cap (issue #573). Re-exported from the domain
// layer for the same reason as SWARM_ROSTER_CAP above: the tests that pin it
// read it from here, never from a literal. Enforced in submitRecommendation,
// twice — once as a cheap refusal ahead of the Ed25519 verify, and once as a
// conjunct on the INSERT itself so a race cannot slip past the read.
export { SWARM_TAKE_REVISION_CAP };

// THE WINDOW IS WHAT FREEZES A TAKE (D51, scheduler spec §4.2).
//
// There used to be a state ALLOWLIST here, `TAKES_AMENDABLE_STATES`, deciding
// whether a member's SECOND take was accepted while a FIRST take was governed by
// the advertised instant alone. It encoded the pre-epoch lifecycle, where an
// admin `close` could move a session out of `collecting` before its advertised
// deadline and the two rules had to be told apart. The epoch model has no such
// close: a session is `collecting` from its first instant until turnover or
// deactivation. So D51's rule is one rule for every take, first or amendment: a
// take lands while its session is `collecting` AND the database clock is before
// `window_closes_at`, both read inside the accepting statement (the INSERT in
// submitRecommendation). A second list that could disagree with that statement
// was the defect, so it is gone rather than kept in step.

// THE ONE DEFAULT FOR A TAKE'S `revision` (D51, criterion 128).
//
// `revision` is hashed into the judge's `inputs_digest` and signed into the
// consensus receipt, so every path that reads a take must resolve an absent
// value to the SAME number, or one take set yields two digests. Migration 0028
// made the column `NOT NULL DEFAULT 1` and backfilled every row to 1, so 1 is
// the only value that agrees with the database; the judge input once used 0.
// Every reader goes through takeRevision(): judgeInputFromFrozen here, toTake
// in projections.ts, and the receipt assembler in consensus-receipt.ts.
export const TAKE_REVISION_DEFAULT = 1;

export function takeRevision(value: unknown): number {
  return value == null ? TAKE_REVISION_DEFAULT : Number(value);
}

// ── Reads ─────────────────────────────────────────────────────────────────
// Issue #782: `status: 'active'` on a member row means the SEAT is live, not
// that the agent is participating — the members table needs a real activity
// signal to tell a live swarm from a static roster. The lateral gives each
// member its own newest take instant without a second round trip per member
// or a GROUP BY over the whole roster; `received_at` (not the session's
// convened_at) because the question is when the agent acted, and max() over
// it already collapses revisions (`r.revision`) to the latest one.
// swarm_recommendations_member_received_idx (migration 0055) keeps this cheap
// as the take count grows.
const MEMBERS_PROBE = {
  statement: `SELECT m.*, t.last_take_at
      FROM swarm_members m
      LEFT JOIN LATERAL (
        SELECT max(received_at) AS last_take_at
          FROM swarm_recommendations
         WHERE member_id = m.id
      ) t ON true
     WHERE m.status = 'active'
     ORDER BY m.id`,
} as const;
const membersRows = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getMembers.members",
  purpose: "List the active roster.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE, OVERVIEW_ROUTE],
  probe: MEMBERS_PROBE,
});
const membersTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getMembers.takes",
  purpose: "Give each roster row its newest take instant, the participation signal (issue #782).",
  callers: [SWARM_ROUTE, ADMIN_ROUTE, OVERVIEW_ROUTE],
  probe: MEMBERS_PROBE,
});
export async function getMembers() {
  const rows = await on(sql, membersRows, membersTakes)<any>`
    SELECT m.*, t.last_take_at
      FROM swarm_members m
      LEFT JOIN LATERAL (
        SELECT max(received_at) AS last_take_at
          FROM swarm_recommendations
         WHERE member_id = m.id
      ) t ON true
     WHERE m.status = 'active'
     ORDER BY m.id`;
  return rows.map(toMember);
}
const countActive = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:countActiveMembersTx",
  purpose: "Count the active seats, for the capacity read and the admission gate's headroom check.",
  callers: [SWARM_ROUTE, ONBOARDING_ROUTE, ADMIN_ROUTE],
  probe: { statement: "SELECT count(*)::int AS n FROM swarm_members WHERE status = 'active'" },
});
export async function countActiveMembers(): Promise<number> {
  return countActiveMembersTx(sql);
}

export async function countActiveMembersTx(tx: DbHandle): Promise<number> {
  const rows = await on(tx, countActive)<{ n: number }>`
    SELECT count(*)::int AS n FROM swarm_members WHERE status = 'active'`;
  return Number(rows[0]?.n ?? 0);
}

export async function getRosterCapacity(): Promise<{ rosterCap: number; seatsFilled: number; seatsAvailable: number }> {
  const count = await countActiveMembers();
  return {
    rosterCap: SWARM_ROSTER_CAP,
    seatsFilled: count,
    seatsAvailable: Math.max(0, SWARM_ROSTER_CAP - count),
  };
}

/** Roster capacity and available seats surface (#236 / #238 contract seam). */
export async function getRosterCapacityStatus(tx: DbHandle = sql): Promise<{ active: number; cap: number; seatsAvailable: number }> {
  const active = await countActiveMembersTx(tx);
  const seatsAvailable = Math.max(0, SWARM_ROSTER_CAP - active);
  return { active, cap: SWARM_ROSTER_CAP, seatsAvailable };
}

// Serialize every roster-admission transaction on one advisory key. A bare
// count()-then-write is a TOCTOU race: two concurrent activations each read
// count=CAP-1 and both admit, blowing past SWARM_ROSTER_CAP. A txn-scoped
// advisory lock forces admissions one-at-a-time and auto-releases at commit.
// Call this FIRST inside any transaction that flips/creates a member to
// 'active', before the write. Pass the member id as `exemptMemberId` when the
// operation may target an already-active member (idempotent re-register) so a
// no-op re-activation doesn't spuriously trip the cap.
const ROSTER_ADMISSION_LOCK = "swarm_roster_admission"; // stable arbitrary key for the swarm roster
const rosterAdmissionLock = registerStatement({
  role: "rm_app",
  shape: "advisoryLockByText",
  site: "src/swarm/domain:assertRosterCapacity.lock",
  purpose: "Serialise every roster-admission transaction on one advisory key, so two admissions cannot both read the last free seat.",
  callers: [ONBOARDING_ROUTE, ADMIN_ROUTE],
});
const rosterSeatTaken = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:assertRosterCapacity.seat",
  purpose: "Tell an idempotent re-admission of an already-active member from a new admission.",
  callers: [ONBOARDING_ROUTE, ADMIN_ROUTE],
  probe: { statement: "SELECT 1 FROM swarm_members WHERE id = $1 AND status = 'active'", params: ["probe"] },
});
const rosterCount = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:assertRosterCapacity.count",
  purpose: "Count the active seats under the admission lock, to refuse an admission at the cap.",
  callers: [ONBOARDING_ROUTE, ADMIN_ROUTE],
  probe: { statement: "SELECT count(*)::int AS n FROM swarm_members WHERE status = 'active'" },
});
export async function assertRosterCapacity(
  tx: DbHandle,
  exemptMemberId?: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await onStatement(tx, rosterAdmissionLock)`SELECT pg_advisory_xact_lock(hashtextextended(${ROSTER_ADMISSION_LOCK}, 0))`;
  if (exemptMemberId) {
    const active = await on(tx, rosterSeatTaken)`SELECT 1 FROM swarm_members WHERE id = ${exemptMemberId} AND status = 'active'`;
    if (active.length > 0) return { ok: true }; // idempotent no-op; slot already counted
  }
  const rows = await on(tx, rosterCount)<{ n: number }>`
    SELECT count(*)::int AS n FROM swarm_members WHERE status = 'active'`;
  const n = Number(rows[0]?.n ?? 0);
  if (n >= SWARM_ROSTER_CAP)
    return { ok: false, status: 409, error: `swarm roster full (${n}/${SWARM_ROSTER_CAP})` };
  return { ok: true };
}
/**
 * Resolve a PUBLIC member reference — a handle or a legacy id (issue #593) —
 * to its raw row. THE ONLY implementation of that rule in this codebase; every
 * caller goes through here rather than re-spelling the predicate (issue #597:
 * two copies of a resolver are two answers to "who does this URL name", and the
 * bug that issue was filed about was exactly that disagreement). Callers that
 * need the projected member call getMember; callers that need columns the
 * projection drops (updateMemberProfile merges raw ones) take the row.
 *
 * Migration 0030 backfilled `handle = id`, so both names address the same row
 * for every member nobody has renamed, and a member renamed since then is still
 * reachable by the id its old links carry. The handle is preferred when both
 * match — which migration 0031's trigger now makes unreachable rather than
 * merely improbable — but ORDER BY makes the resolution deterministic
 * regardless of how the rows were seeded rather than leaving it to physical row
 * order.
 *
 * NOT the same question as swarm/admin.ts's create-path probe, which orders
 * `(id = $ref) DESC`: that one asks "is this proposed NAME already spoken for",
 * and it deliberately prefers the id namespace to tell the two 409s apart.
 */
// Issue #782 follow-up: this row feeds toMember() directly via getMember(),
// so it needs the same last_take_at lateral getMembers() joins — otherwise
// a single-member lookup silently reports lastTakeAt: null regardless of
// actual take history, indistinguishable from "never took a position".
const RESOLVE_MEMBER_PROBE = {
  statement: `SELECT m.*, t.last_take_at
      FROM swarm_members m
      LEFT JOIN LATERAL (
        SELECT max(received_at) AS last_take_at
          FROM swarm_recommendations
         WHERE member_id = m.id
      ) t ON true
     WHERE m.handle = $1 OR m.id = $2
     ORDER BY (m.handle = $3) DESC
     LIMIT 1`,
  params: ["probe", "probe", "probe"],
} as const;
const resolveMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:resolveMemberRow.members",
  purpose: "Resolve a public member reference (a handle or a legacy id) to its row, the one implementation of that rule.",
  callers: [SWARM_ROUTE, ONBOARDING_ROUTE, ADMIN_ROUTE],
  probe: RESOLVE_MEMBER_PROBE,
});
const resolveTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:resolveMemberRow.takes",
  purpose: "Give the resolved member row its newest take instant, as getMembers does.",
  callers: [SWARM_ROUTE, ONBOARDING_ROUTE, ADMIN_ROUTE],
  probe: RESOLVE_MEMBER_PROBE,
});
async function resolveMemberRow(ref: string) {
  return (await on(sql, resolveMembers, resolveTakes)<any>`
    SELECT m.*, t.last_take_at
      FROM swarm_members m
      LEFT JOIN LATERAL (
        SELECT max(received_at) AS last_take_at
          FROM swarm_recommendations
         WHERE member_id = m.id
      ) t ON true
     WHERE m.handle = ${ref} OR m.id = ${ref}
     ORDER BY (m.handle = ${ref}) DESC
     LIMIT 1`)[0];
}
export async function getMember(id: string) {
  const row = await resolveMemberRow(id);
  return row ? toMember(row) : null;
}

// Serves the bytes admin.ts's uploadMemberAvatarAdmin (issue #626) writes to
// swarm_member_avatars — the durable, redeploy-proof store avatar.path now
// points at (routes/swarm.ts's GET .../members/:id/avatar). No handle/id
// resolution here: avatar.path always names the member's real uuid directly,
// never a handle, so a plain equality lookup is enough.
export interface MemberAvatarBytes {
  contentType: string;
  bytes: Buffer;
  uploadedAt: Date;
}
const avatarBytes = registerQuery({
  role: "rm_app",
  object: "swarm_member_avatars",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getMemberAvatarBytes",
  purpose: "Serve a member's uploaded avatar bytes.",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT content_type, bytes, uploaded_at FROM swarm_member_avatars WHERE member_id = $1", params: ["probe"] },
});
export async function getMemberAvatarBytes(memberId: string): Promise<MemberAvatarBytes | null> {
  const rows = await on(sql, avatarBytes)<{ content_type: string; bytes: Buffer; uploaded_at: Date }>`
    SELECT content_type, bytes, uploaded_at FROM swarm_member_avatars WHERE member_id = ${memberId}`;
  const row = rows[0];
  return row ? { contentType: row.content_type, bytes: row.bytes, uploadedAt: row.uploaded_at } : null;
}
const subjectById = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getSubject",
  purpose: "Read one subject row.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE, STREAM_ROUTE, OVERVIEW_ROUTE],
  probe: { statement: "SELECT * FROM swarm_subjects WHERE id = $1", params: ["probe"] },
});
export async function getSubject(id: string, h: DbHandle = sql) {
  const row = (await on(h, subjectById)<any>`SELECT * FROM swarm_subjects WHERE id = ${id}`)[0];
  return row ? toSubject(row) : null;
}

// `limit`/`before` are OPT-IN (issue #869c): omitting both returns every
// snapshot, unchanged from before this existed. static-views.js's
// loadSnapshots (sorts the whole list for the subject chart) and
// pickSnapshotFor (scans the whole list for the newest one not after an
// arbitrary session date) both call this with neither param — a default
// LIMIT would silently blank both on any subject old enough to exceed it.
const SNAPSHOT_COLUMNS_BEFORE = `SELECT id, subject_id, date, total_value_usd, positions, wallets, notable
               FROM swarm_subject_snapshots WHERE subject_id = $1 AND date < $2
               ORDER BY date DESC LIMIT $3`;
const snapshotsBefore = registerQuery({
  role: "rm_app",
  object: "swarm_subject_snapshots",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getSubjectSnapshots.before",
  purpose: "Page a subject's snapshots older than a date, newest first.",
  callers: [SWARM_ROUTE],
  probe: { statement: SNAPSHOT_COLUMNS_BEFORE, params: ["probe", "2000-01-01", 1] },
});
const snapshotsAll = registerQuery({
  role: "rm_app",
  object: "swarm_subject_snapshots",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getSubjectSnapshots.all",
  purpose: "Read a subject's snapshots, newest first, optionally capped.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT id, subject_id, date, total_value_usd, positions, wallets, notable
               FROM swarm_subject_snapshots WHERE subject_id = $1
               ORDER BY date DESC LIMIT $2`,
    params: ["probe", 1],
  },
});
export async function getSubjectSnapshots(id: string, opts: { limit?: number; before?: string } = {}) {
  const { limit, before } = opts;
  const rows = before
    ? await on(sql, snapshotsBefore)<any>`SELECT id, subject_id, date, total_value_usd, positions, wallets, notable
               FROM swarm_subject_snapshots WHERE subject_id = ${id} AND date < ${before}
               ORDER BY date DESC LIMIT ${limit ?? null}`
    : await on(sql, snapshotsAll)<any>`SELECT id, subject_id, date, total_value_usd, positions, wallets, notable
               FROM swarm_subject_snapshots WHERE subject_id = ${id}
               ORDER BY date DESC LIMIT ${limit ?? null}`;
  return rows.map(toSnapshot);
}

// ── Sessions list: paginated + light-projected by default (issue #243) ──────
// The public directory page and the member-profile N+1 both used to pull
// EVERY session with its full payload (regimeSummary/synthesis/etc — measured
// at ~8.3MB on staging). Default response is now a light index row (see
// projections.toSessionListItem) plus an opaque nextCursor; ?full=1 keeps the
// pre-#243 unpaginated/unprojected shape reachable for callers (the admin
// sessions views) that still need every field. synthesis rejoined the light
// row in issue #358 (bounded, see projections.ts) once #323 made it a short
// sentence rather than a take-body dump; regimeSummary/
// subjectSnapshotTotalValueUsd stay full-only.
const SESSIONS_LIST_DEFAULT_LIMIT = 20;
const SESSIONS_LIST_MAX_LIMIT = 100;
// A search is a literal phrase, not a pattern, and a short one.
const SESSIONS_SEARCH_MAX_LENGTH = 200;

interface SessionsCursor { d: string; g: string; i: string }

// Opaque only in the sense that callers must treat it as a token — it's a
// base64url-encoded JSON tuple of (date, generatedAt, id), the exact tiebreak
// columns the query orders and filters by, so decoding never has to guess at
// a numeric offset that would drift as new sessions are inserted.
function encodeSessionsCursor(row: Record<string, any>): string {
  // postgres.js decodes timestamptz as a JavaScript Date, which truncates
  // PostgreSQL's microseconds to milliseconds.  The cursor must retain the
  // database's full ordering precision or same-date rows generated within one
  // millisecond can fall between pages.  The paginated query selects the exact
  // timestamp text for this purpose; keep the fallback for callers/tests that
  // provide a plain session row.
  const generatedAt = row.cursor_generated_at == null
    ? instant(row.generated_at) ?? ""
    : String(row.cursor_generated_at);
  const cursor: SessionsCursor = { d: day(row.date), g: generatedAt, i: String(row.id) };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
// Throws on a non-empty-but-malformed cursor (mirrors admin/cursor.ts's
// decodeCursor) — a foreign/corrupted opaque token is a 400 from the route
// handler, never a silent "start from the top" that would mask client bugs.
function decodeSessionsCursor(cursor?: string | null): SessionsCursor | null {
  if (cursor == null || cursor === "") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed cursor");
  }
  if (
    obj && typeof obj === "object" &&
    typeof (obj as SessionsCursor).d === "string" &&
    typeof (obj as SessionsCursor).g === "string" &&
    typeof (obj as SessionsCursor).i === "string"
  ) {
    return obj as SessionsCursor;
  }
  throw new Error("malformed cursor");
}

// Explicit-but-invalid limit is a 400 (thrown), not a silent clamp; an
// absent/empty param falls back to the default. Mirrors api/routes/admin.ts's
// parseLimit convention for the same reason (issue #155 AC).
export function parseSessionsLimit(raw?: number): number {
  if (raw == null) return SESSIONS_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > SESSIONS_LIST_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${SESSIONS_LIST_MAX_LIMIT}`);
  }
  return raw;
}

export interface ListSessionsOptions {
  state?: string;
  /** One subject's sessions (issue #991): a subject page pages its own
   * history instead of filtering the whole index in the browser. */
  subject?: string;
  /** Case-insensitive literal match on the date, the recommendation's
   * rationale or the synthesis. Not a pattern: `%` and `_` match themselves. */
  search?: string;
  limit?: number;
  cursor?: string | null;
  /** Reproduce the pre-#243 unpaginated, unprojected (every field, no state
   * filter applied unless also passed) response — the escape hatch the issue
   * asks to keep reachable for existing full-history consumers. */
  full?: boolean;
}

// When the next session opens — issue #783's field, answered from the EPOCH
// model (issue #1026 W4).
//
// WHAT IT USED TO READ. `SELECT next_run_at FROM job_schedules` for the
// session-opening kind: the cron slot the old scheduler would next fire at.
// Those rows are retired with the rest of the scheduled lifecycle, so
// the field needed a new source or it would have become permanently null on a
// published contract (scripts/lib/agent-endpoints.ts documents it to outside
// agents, and the /swarm view renders it).
//
// WHAT IT READS NOW, and why it is the same fact. Scheduler spec §2.1: epochs
// run "back to back ... When epoch N's submission window closes, epoch N+1's
// window opens in the same transaction. There is no gap between epochs". So the
// instant the current window closes IS the instant the next session opens —
// not an estimate of it, the same event. The EARLIEST such instant across every
// open window is the answer to "when does the next session open", because the
// question is about the swarm, not about one subject.
//
// NULL means what it always meant: no known next session. That is the honest
// answer while no subject has an open window at all — a fresh database before
// the scheduler's first rebuild, or every subject deactivated.
//
// NOT the successor's `window_closes_at`, which does not exist yet: the epoch
// after next is not scheduled anywhere, because nothing about the epoch model
// schedules anything.
export async function getNextSwarmSessionAt(): Promise<string | null> {
  return (await getNextSwarmSession())?.at ?? null;
}

/**
 * The same instant, with the open window it belongs to — for a reader (the
 * admin overview) that has to say WHICH session turns over next, not only
 * when. The earliest close across every open window; ties break on id so the
 * answer is stable.
 */
const nextSession = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getNextSwarmSession",
  purpose: "Find the open window that closes first, the instant the next turnover is due.",
  callers: [SWARM_ROUTE, OVERVIEW_ROUTE],
  probe: {
    statement: `SELECT id, subject_id, window_closes_at
      FROM swarm_sessions
     WHERE state = 'collecting' AND window_closes_at IS NOT NULL
     ORDER BY window_closes_at, id LIMIT 1`,
  },
});
export async function getNextSwarmSession(): Promise<{ sessionId: string; subjectId: string; at: string } | null> {
  const [row] = await on(sql, nextSession)<{ id: string; subject_id: string; window_closes_at: Date }>`
    SELECT id, subject_id, window_closes_at
      FROM swarm_sessions
     WHERE state = 'collecting' AND window_closes_at IS NOT NULL
     ORDER BY window_closes_at, id LIMIT 1`;
  return row ? { sessionId: String(row.id), subjectId: row.subject_id, at: instant(row.window_closes_at)! } : null;
}

const SESSIONS_PAGE_PROBE = {
  statement: `SELECT *, generated_at::text AS cursor_generated_at,
      (SELECT count(*)::int FROM swarm_recommendations r WHERE r.session_id = swarm_sessions.id AND r.final) AS take_count,
      (SELECT b.body->'allocation' FROM swarm_briefs b WHERE b.session_id = swarm_sessions.id) AS reference_allocation
    FROM swarm_sessions
    WHERE ($1::text IS NULL OR state = $2)
      AND ($3::text IS NULL OR subject_id = $4)
      AND ($5::text IS NULL OR strpos(lower(date::text || ' ' || COALESCE(swarm_recommendation->>'rationale', '') || ' ' || COALESCE(synthesis, '')), lower($6)) > 0)
      AND ($7::text IS NULL OR (date, generated_at, id) < ($8::date, $9::text::timestamptz, $10::uuid))
    ORDER BY date DESC, generated_at DESC, id DESC
    LIMIT $11`,
  params: [null, null, null, null, null, null, null, null, null, null, 1],
} as const;
const sessionsFull = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:listSessions.full",
  purpose: "Read every session with its full payload, for the admin views that still need every field.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE],
  probe: { statement: "SELECT * FROM swarm_sessions ORDER BY date DESC, generated_at DESC, id DESC" },
});
const sessionsPage = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:listSessions.page.sessions",
  purpose: "Read one page of the sessions index under the state, subject, search and cursor filters.",
  callers: [SWARM_ROUTE],
  probe: SESSIONS_PAGE_PROBE,
});
const sessionsPageTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:listSessions.page.takes",
  purpose: "Count the final takes of each session on the page, one per member (D51).",
  callers: [SWARM_ROUTE],
  probe: SESSIONS_PAGE_PROBE,
});
const sessionsPageBriefs = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["SELECT"],
  site: "src/swarm/domain:listSessions.page.briefs",
  purpose: "Read the target each session's own brief carried, for the history row (issue #991).",
  callers: [SWARM_ROUTE],
  probe: SESSIONS_PAGE_PROBE,
});
export async function listSessions(opts: ListSessionsOptions = {}) {
  const nextSessionAt = await getNextSwarmSessionAt();
  const search = opts.search?.trim() ?? "";
  // The filters page; full=1 is the unpaginated escape hatch, and combining
  // the two would quietly return an unbounded filtered list.
  if (opts.full && (opts.subject || search)) throw new Error("subject and search page the light index; drop full=1");
  if (search.length > SESSIONS_SEARCH_MAX_LENGTH) throw new Error(`search must be at most ${SESSIONS_SEARCH_MAX_LENGTH} characters`);
  if (opts.full) {
    const rows = await on(sql, sessionsFull)<any>`SELECT * FROM swarm_sessions ORDER BY date DESC, generated_at DESC, id DESC`;
    return { sessions: rows.map(toSession), nextCursor: null as string | null, nextSessionAt };
  }

  const limit = parseSessionsLimit(opts.limit);
  // Each filter is a NULL-guarded predicate of one fixed statement, not a
  // fragment spliced in: a statement is registered as one piece of text, and a
  // filter that is absent binds NULL and so passes every row.
  const state = opts.state || null;
  const subject = opts.subject || null;
  const phrase = search || null;
  const cur = decodeSessionsCursor(opts.cursor);
  // strpos, not LIKE: the phrase is matched literally, so a reader's `%` is a
  // percent sign rather than a wildcard over the whole history.
  // Bind the timestamp as text before casting on the server.  If postgres.js
  // infers a timestamptz parameter directly it serializes the string through a
  // JavaScript Date first, undoing the microsecond precision retained above.

  // Fetch one extra row to detect "is there a next page" without a second
  // COUNT query; the (date, generated_at, id) triple is both the ORDER BY and
  // the cursor's row-comparison predicate, so pages are stable even as new
  // sessions are inserted between requests.
  // Two per-row facts a history row needs without fetching each session
  // (issue #991): how many members filed (one final take per member, D51, not
  // revisions), and the target the session's own brief carried. Bounded by
  // LIMIT, so they run for at most one page of rows.
  const rows = await on(sql, sessionsPage, sessionsPageTakes, sessionsPageBriefs)<any>`
    SELECT *, generated_at::text AS cursor_generated_at,
      (SELECT count(*)::int FROM swarm_recommendations r WHERE r.session_id = swarm_sessions.id AND r.final) AS take_count,
      (SELECT b.body->'allocation' FROM swarm_briefs b WHERE b.session_id = swarm_sessions.id) AS reference_allocation
    FROM swarm_sessions
    WHERE (${state}::text IS NULL OR state = ${state})
      AND (${subject}::text IS NULL OR subject_id = ${subject})
      AND (${phrase}::text IS NULL OR strpos(lower(date::text || ' ' || COALESCE(swarm_recommendation->>'rationale', '') || ' ' || COALESCE(synthesis, '')), lower(${phrase})) > 0)
      AND (${cur?.d ?? null}::text IS NULL OR (date, generated_at, id) < (${cur?.d ?? null}::date, ${cur?.g ?? null}::text::timestamptz, ${cur?.i ?? null}::uuid))
    ORDER BY date DESC, generated_at DESC, id DESC
    LIMIT ${limit + 1}`;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    sessions: page.map(toSessionListItem),
    nextCursor: hasMore ? encodeSessionsCursor(page[page.length - 1]) : (null as string | null),
    nextSessionAt,
  };
}

// ── Member takes (issue #243B) ──────────────────────────────────────────────
// Collapses the member-profile page's "1 full session list + up to ~21 full
// session detail fetches" into one request: this member's own take in each of
// their most recent sessions (any state — collecting/window_closed/aggregated
// included, not just published, so the "this session" in-progress block keeps
// working), newest first.
const MEMBER_TAKES_PROBE = {
  statement: `SELECT r.id, r.member_id, m.handle AS member_handle, m.name AS member_name,
           r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
           s.date AS session_date, s.generated_at AS session_generated_at,
           s.subject_id, s.subject_name, s.state AS session_state,
           ${SIGNING_KEY_PROBE} AS public_key
      FROM swarm_recommendations r
      JOIN swarm_sessions s ON s.id = r.session_id
      JOIN swarm_members m ON m.id = r.member_id
     -- One member, by the immutable id getMember resolved the caller's public
     -- reference to (handle OR legacy id — issue #593 keeps both addressable).
     WHERE r.member_id = $1 AND r.final
     ORDER BY s.date DESC, s.generated_at DESC
     LIMIT $2`,
  params: ["probe", 1],
} as const;
const memberTakesTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getMemberTakes.takes",
  purpose: "Read one member's final take in each of their most recent sessions.",
  callers: [SWARM_ROUTE],
  probe: MEMBER_TAKES_PROBE,
});
const memberTakesSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getMemberTakes.sessions",
  purpose: "Join each take's session for its date, subject and state.",
  callers: [SWARM_ROUTE],
  probe: MEMBER_TAKES_PROBE,
});
const memberTakesMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getMemberTakes.members",
  purpose: "Join the member's handle and name onto each take.",
  callers: [SWARM_ROUTE],
  probe: MEMBER_TAKES_PROBE,
});
const memberTakesKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getMemberTakes.keys",
  purpose: "Resolve each take's public key by the key that signed it (issue #697).",
  callers: [SWARM_ROUTE],
  probe: MEMBER_TAKES_PROBE,
});
export async function getMemberTakes(memberId: string, limit?: number) {
  const cappedLimit = parseSessionsLimit(limit);
  // RESOLVE THE PUBLIC REFERENCE FIRST (issue #597). This used to match both
  // namespaces inside the takes join — `WHERE m.handle = $ref OR m.id = $ref` —
  // which is the SAME predicate getMember uses but WITHOUT its
  // `ORDER BY (handle = $ref) DESC LIMIT 1`. If a handle ever equalled another
  // member's id, the two read paths for one URL disagreed: getMember picked one
  // row, this query matched BOTH, and `DISTINCT ON (r.session_id) … ORDER BY
  // r.revision DESC` then chose a per-session winner across two different
  // members — so /swarm/members/:ref rendered one member's identity over
  // another member's signed take. Migration 0031 now refuses to create that
  // state, but a read path must not depend on a write path for its own
  // coherence: resolving through getMember here means every path that turns a
  // public reference into a member row goes through the ONE shared resolver,
  // resolveMemberRow — getMember, this function, and updateMemberProfile since
  // #597 — instead of re-spelling the predicate, and the takes query keys on the
  // immutable id, which is also what every child row's member_id holds.
  // (swarm/admin.ts's two probes ask a different question — "is this proposed
  // NAME already spoken for" — with a deliberately different namespace
  // preference; see resolveMemberRow's note.)
  const member = await getMember(memberId);
  if (!member) return { takes: [] };
  // THE FINAL TAKE PER SESSION (D51). Already scoped to one member, so "the
  // session's takes" collapses to this member's one final take in each session.
  // A member that amended twice must contribute ONE row to its own record page,
  // not three — and the LIMIT is a count of sessions, so without this it would
  // silently start returning fewer sessions than asked for. The flag, not
  // `ORDER BY revision`, says which row counts: the partial unique index
  // `swarm_recommendations_one_final_per_member` (migration 0075) makes it one.
  const rows = await on(sql, memberTakesTakes, memberTakesSessions, memberTakesMembers, memberTakesKeys)<any>`
    SELECT r.id, r.member_id, m.handle AS member_handle, m.name AS member_name,
           r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
           s.date AS session_date, s.generated_at AS session_generated_at,
           s.subject_id, s.subject_name, s.state AS session_state,
           COALESCE(
             (SELECT k.public_key FROM swarm_member_keys k WHERE k.id = r.signing_key_id),
             (SELECT k.public_key FROM swarm_member_keys k
              WHERE k.member_id = r.member_id AND k.active
              ORDER BY k.created_at DESC LIMIT 1)
           ) AS public_key
      FROM swarm_recommendations r
      JOIN swarm_sessions s ON s.id = r.session_id
      JOIN swarm_members m ON m.id = r.member_id
     -- One member, by the immutable id getMember resolved the caller's public
     -- reference to (handle OR legacy id — issue #593 keeps both addressable).
     WHERE r.member_id = ${member.id} AND r.final
     ORDER BY s.date DESC, s.generated_at DESC
     LIMIT ${cappedLimit}`;
  const takes = await Promise.all(rows.map(async (row) => ({
    sessionDate: day(row.session_date),
    subjectId: row.subject_id,
    subjectName: row.subject_name ?? null,
    sessionState: row.session_state,
    take: await toVerifiedTake(row),
  })));
  return { takes };
}

const openSessionRead = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getOpenSession",
  purpose: "Read the newest collecting session.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT id, date, subject_id, subject_name, state, window_closes_at
                      FROM swarm_sessions WHERE state = 'collecting'
                      ORDER BY generated_at DESC LIMIT 1`,
  },
});
export async function getOpenSession() {
  const r = await on(sql, openSessionRead)<any>`SELECT id, date, subject_id, subject_name, state, window_closes_at
                      FROM swarm_sessions WHERE state = 'collecting'
                      ORDER BY generated_at DESC LIMIT 1`;
  return r[0] ? toSession(r[0]) : null;
}

const sessionByDate = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getSession",
  purpose: "Resolve a (date, subject) to that day's latest session.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT * FROM swarm_sessions
                       WHERE date = $1 AND subject_id = $2
                       ORDER BY convened_at DESC LIMIT 1`,
    params: ["2000-01-01", "probe"],
  },
});
export async function getSession(
  date: string,
  subjectId: string,
): Promise<{ session: ReturnType<typeof toSession>; takes: Awaited<ReturnType<typeof toVerifiedTake>>[] } | null> {
  // A date no longer identifies ONE session (migration 0022 — a subject may
  // convene several times a day), so this public route resolves to the LATEST
  // session that day. That keeps every existing link and the frontend's
  // (date, subject) fetches working, and is the answer a reader wants: the most
  // recent word on that subject for that day.
  const s = (await on(sql, sessionByDate)<any>`SELECT * FROM swarm_sessions
                       WHERE date = ${date} AND subject_id = ${subjectId}
                       ORDER BY convened_at DESC LIMIT 1`)[0];
  if (!s) return null;
  return withTakes(s);
}

/**
 * One session BY ITS OWN ID — the unambiguous handle. `getSession(date, subject)`
 * can only ever return the latest session of a day, so every earlier session of a
 * multi-session day is unreachable through it; this is how a list row links to
 * the exact session it is describing.
 */
const sessionById = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getSessionById",
  purpose: "Read one session by its own id.",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT * FROM swarm_sessions WHERE id = $1", params: [SAMPLE_ID] },
});
export async function getSessionById(
  id: string,
): Promise<{ session: ReturnType<typeof toSession>; takes: Awaited<ReturnType<typeof toVerifiedTake>>[] } | null> {
  // `id` is a uuid column, so a non-uuid path segment would make Postgres throw
  // rather than miss. Treat anything unparseable as simply not found — this is a
  // public GET and a 404 is the honest answer for "no session with that handle".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const s = (await on(sql, sessionById)<any>`SELECT * FROM swarm_sessions WHERE id = ${id}`)[0];
  if (!s) return null;
  return withTakes(s);
}

// The shared body of both lookups above: a session row plus its verified takes.
//
// ONE FINAL TAKE PER MEMBER (D51). A member may file several takes in one
// session while its window is open (migration 0028 relaxed `UNIQUE (session_id,
// member_id)`), each its own immutable signed row. This is a session's CURRENT
// reading, so it selects the rows flagged final — exactly one per member, which
// the partial unique index `swarm_recommendations_one_final_per_member`
// (migration 0075) makes structural. Without the flag the session page would
// render one card per amendment, and its stance/confidence table would count
// one member several times.
//
// Superseded takes are not lost and are not hidden: each keeps its own
// permalink and its own verification receipt (getTakeReceipt below), which is
// the whole point of the append-only model. They are simply not what "the
// session's takes" means.
const WITH_TAKES_PROBE = {
  statement: `SELECT r.id, r.member_id, m.handle AS member_handle, m.name AS member_name,
           r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
           ${SIGNING_KEY_PROBE} AS public_key
      FROM swarm_recommendations r
      JOIN swarm_members m ON m.id = r.member_id
     WHERE r.session_id = $1 AND r.final
     ORDER BY r.received_at`,
  params: [SAMPLE_ID],
} as const;
const withTakesTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:withTakes.takes",
  purpose: "Read a session's final takes, one per member (D51).",
  callers: [SWARM_ROUTE],
  probe: WITH_TAKES_PROBE,
});
const withTakesMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:withTakes.members",
  purpose: "Join each take's member handle and name.",
  callers: [SWARM_ROUTE],
  probe: WITH_TAKES_PROBE,
});
const withTakesKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:withTakes.keys",
  purpose: "Resolve each take's public key by the key that signed it (issue #697).",
  callers: [SWARM_ROUTE],
  probe: WITH_TAKES_PROBE,
});
async function withTakes(s: Record<string, unknown>) {
  const takes = await on(sql, withTakesTakes, withTakesMembers, withTakesKeys)<any>`
    SELECT r.id, r.member_id, m.handle AS member_handle, m.name AS member_name,
           r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
           COALESCE(
             (SELECT k.public_key FROM swarm_member_keys k WHERE k.id = r.signing_key_id),
             (SELECT k.public_key FROM swarm_member_keys k
              WHERE k.member_id = r.member_id AND k.active
              ORDER BY k.created_at DESC LIMIT 1)
           ) AS public_key
      FROM swarm_recommendations r
      JOIN swarm_members m ON m.id = r.member_id
     WHERE r.session_id = ${s.id as string} AND r.final
     ORDER BY r.received_at`;
  return { session: toSession(s), takes: await Promise.all(takes.map(toVerifiedTake)) };
}

function hostedMemoId(memoUrl: string | null): number | null {
  if (!memoUrl) return null;
  try {
    const pathname = memoUrl.startsWith("/") ? memoUrl : new URL(memoUrl).pathname;
    const prefix = ROUTES.swarm.memo.replace(":id", "");
    const rawId = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
    return /^\d+$/.test(rawId) ? Number(rawId) : null;
  } catch {
    return null;
  }
}

const RECEIPT_PROBE = {
  statement: `SELECT r.id, r.session_id, r.member_id, m.handle AS member_handle, m.name AS member_name,
           r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
           ${SIGNING_KEY_PROBE} AS public_key
    FROM swarm_recommendations r
    JOIN swarm_members m ON m.id = r.member_id
    WHERE r.id = $1 LIMIT 1`,
  params: [SAMPLE_ID],
} as const;
const receiptTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getTakeReceipt.take",
  purpose: "Read one immutable signed take by its permalink id.",
  callers: [SWARM_ROUTE, RECEIPTS_ROUTE],
  probe: RECEIPT_PROBE,
});
const receiptMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getTakeReceipt.members",
  purpose: "Join the signer's handle and name.",
  callers: [SWARM_ROUTE, RECEIPTS_ROUTE],
  probe: RECEIPT_PROBE,
});
const receiptKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getTakeReceipt.keys",
  purpose: "Resolve the take's public key by the key that signed it (issue #697).",
  callers: [SWARM_ROUTE, RECEIPTS_ROUTE],
  probe: RECEIPT_PROBE,
});
const receiptSuperseding = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getTakeReceipt.superseding",
  purpose: "Find the member's final take in the session, the forward pointer from a superseded take.",
  callers: [SWARM_ROUTE, RECEIPTS_ROUTE],
  probe: {
    statement: `SELECT id, revision, received_at FROM swarm_recommendations
    WHERE session_id = $1
      AND member_id = $2
      AND final
      AND id <> $3
    LIMIT 1`,
    params: [SAMPLE_ID, "probe", SAMPLE_ID],
  },
});
export async function getTakeReceipt(id: string) {
  const row = (await on(sql, receiptTakes, receiptMembers, receiptKeys)<any>`
    SELECT r.id, r.session_id, r.member_id, m.handle AS member_handle, m.name AS member_name,
           r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
           COALESCE(
             (SELECT k.public_key FROM swarm_member_keys k WHERE k.id = r.signing_key_id),
             (SELECT k.public_key FROM swarm_member_keys k
              WHERE k.member_id = r.member_id AND k.active
              ORDER BY k.created_at DESC LIMIT 1)
           ) AS public_key
    FROM swarm_recommendations r
    JOIN swarm_members m ON m.id = r.member_id
    WHERE r.id = ${id} LIMIT 1`)[0];
  if (!row) return null;

  // THE PERMALINK NEVER MOVES AND NEVER SUBSTITUTES (issue #573, ADR D32).
  // `/swarm/takes/:id` addresses ONE immutable signed row. A member that amends
  // does not rewrite this row — it files a new one at a new URL — so a link
  // already shared as proof of participation (runbook.html: "share that
  // permalink as proof of participation") keeps resolving, keeps verifying, and
  // keeps showing the exact bytes that were signed at the time it says they
  // were filed. What it gains is a forward pointer: the reader is told a later
  // revision exists and can follow it. This is the alternative to the in-place
  // model, where the same URL would have silently started serving different
  // prose under an unchanged (or lying) `Filed <time>`.
  //
  // The pointer names the member's FINAL take in the session (D51), read off the
  // flag: a row that is not final has been superseded by the one that is, and a
  // final row points nowhere.
  const superseding = (await on(sql, receiptSuperseding)<{ id: string; revision: number; received_at: unknown }>`
    SELECT id, revision, received_at FROM swarm_recommendations
    WHERE session_id = ${row.session_id as string}
      AND member_id = ${row.member_id as string}
      AND final
      AND id <> ${row.id as string}
    LIMIT 1`)[0];

  const take = await toVerifiedTake(row);
  const memoId = hostedMemoId(take.memoUrl ?? null);
  return {
    // The session this take was filed in — a take carries no date/subject
    // handle that resolves to ONE session (migration 0022), so a receipt page
    // links back by id.
    sessionId: String(row.session_id),
    take,
    memo: memoId == null ? null : await getMemo(memoId),
    supersededBy: superseding
      ? { id: superseding.id, revision: Number(superseding.revision), receivedAt: instant(superseding.received_at) ?? "" }
      : null,
    signer: {
      // `id` is the SIGNING identity — the exact string the payload was signed
      // over — and never moves. `handle` is only where to link the reader.
      id: row.member_id,
      handle: (row.member_handle as string | null) ?? (row.member_id as string),
      name: row.member_name,
      publicKeyFingerprint: typeof row.public_key === "string"
        ? await fingerprintPublicKey(row.public_key)
        : null,
    },
  };
}

/**
 * One brief BY ITS SESSION — the unambiguous handle, exactly as
 * `getSessionById` is to `getSession(date, subject)`. Since migration 0028 a
 * brief is keyed on its session, so every session of a multi-session day has
 * its own brief (and its own advertised `windowClosesAt`) reachable here.
 */
const briefIdBySession = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getBriefBySession.ledgerRow",
  purpose: "In ledger mode, read the brief's opaque id and creation time; the body comes from the ledger.",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT id, created_at FROM swarm_briefs WHERE session_id = $1 LIMIT 1", params: [SAMPLE_ID] },
});
const briefBySession = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getBriefBySession.compat",
  purpose: "Read a session's brief straight from swarm_briefs, the compatibility read mode.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT id, date, subject_id, session_id, report_snapshot_id, body, created_at FROM swarm_briefs
                      WHERE session_id = $1 LIMIT 1`,
    params: [SAMPLE_ID],
  },
});
export async function getBriefBySession(sessionId: string) {
  // `session_id` is a uuid column, so a non-uuid handle would make Postgres
  // throw rather than return no rows; screen it here (mirrors getSessionById).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
// Issue #979: in ledger mode, `body` is read from swarm_brief_revisions
  // (the immutable ledger) instead of swarm_briefs.body directly — `id` still
  // comes from swarm_briefs because it is an opaque handle with no ledger
  // equivalent, not a fact the ledger vs. compatibility split is about (both
  // modes keep dual-writing swarm_briefs; only which table SUPPLIES the body
  // differs).
  if ((await getAnalyticsReadMode()) === "ledger") {
    const ledger = await ledgerCurrentBriefBySession(sessionId);
    if (!ledger) return null;
    const [row] = await on(sql, briefIdBySession)<any>`SELECT id, created_at FROM swarm_briefs WHERE session_id = ${sessionId} LIMIT 1`;
    return toBrief({
      id: row?.id ?? null,
      date: ledger.date,
      subject_id: ledger.subjectId,
      session_id: ledger.sessionId,
      report_snapshot_id: ledger.reportSnapshotId,
      body: ledger.body,
      created_at: row?.created_at ?? ledger.createdAt,
    });
  }
  const r = await on(sql, briefBySession)<any>`SELECT id, date, subject_id, session_id, report_snapshot_id, body, created_at FROM swarm_briefs
                      WHERE session_id = ${sessionId} LIMIT 1`;
  return r[0] ? toBrief(r[0]) : null;
}

const BRIEF_BY_DAY_PROBE = {
  statement: `SELECT b.id, b.date, b.subject_id, b.session_id, b.report_snapshot_id, b.body, b.created_at
                      FROM swarm_briefs b
                      LEFT JOIN swarm_sessions s ON s.id = b.session_id
                      WHERE b.date = $1 AND b.subject_id = $2
                      ORDER BY s.convened_at DESC NULLS LAST, b.created_at DESC LIMIT 1`,
  params: ["2000-01-01", "probe"],
} as const;
const briefByDayBriefs = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getBrief.briefs",
  purpose: "Read the newest published brief of a (date, subject).",
  callers: [SWARM_ROUTE],
  probe: BRIEF_BY_DAY_PROBE,
});
const briefByDaySessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getBrief.sessions",
  purpose: "Rank a brief by its session's convening, keeping sessionless legacy rows visible.",
  callers: [SWARM_ROUTE],
  probe: BRIEF_BY_DAY_PROBE,
});
export async function getBrief(date: string, subjectId: string) {
  // A date no longer identifies ONE brief. Since migration 0022 a subject may
  // convene several times a day, and since 0028 each of those sessions keeps
  // its OWN brief instead of overwriting its predecessor's. This day-scoped
  // route therefore resolves to the most recent session of that day THAT HAS
  // PUBLISHED A BRIEF, so every existing member client and doc keeps working
  // and gets the answer it wants: the current brief.
  //
  // "…that has published a brief" is not a hedge — it is the ordinary case.
  // openSession() convenes a session as 'scheduled' and the brief follows on a
  // separate cron, so for much of any day the newest session of a subject has
  // no brief row at all. This query selects FROM swarm_briefs, so such a
  // session simply is not a candidate; the caller gets the newest brief that
  // actually exists rather than a null. (Note the asymmetry with
  // getSession(date, subject), which CAN return that unbriefed newest session:
  // it selects from sessions. The two are not interchangeable, and since issue
  // #570 a take submitted now lands on the newest session — which may be newer
  // than the session whose brief this returns. `sessionId` on the response is
  // how a caller tells the difference.)
  //
  // The LEFT JOIN (not an inner one) keeps sessionless legacy rows visible:
  // 0028 deliberately preserved v0-archived briefs whose session was never
  // archived, and an inner join would silently hide them. `NULLS LAST` ranks a
  // real session's brief above such a row when both exist for a day.
  const r = await on(sql, briefByDayBriefs, briefByDaySessions)<any>`SELECT b.id, b.date, b.subject_id, b.session_id, b.report_snapshot_id, b.body, b.created_at
                      FROM swarm_briefs b
                      LEFT JOIN swarm_sessions s ON s.id = b.session_id
                      WHERE b.date = ${date} AND b.subject_id = ${subjectId}
                      ORDER BY s.convened_at DESC NULLS LAST, b.created_at DESC LIMIT 1`;
  return r[0] ? toBrief(r[0]) : null;
}

// ── Submit (verify identity + window + signature + nonce) ───────────────────
export interface SubmissionInput {
  memberId: string; date: string; subjectId: string; nonce: string;
  stance: string; confidence: number; body?: string; memoUrl?: string;
  // Issue #978 AC6: naming a reportSnapshotId signs schema 2.0
  // (canonicalizeSubmission) and binds the take to the exact analytics
  // report snapshot its author saw. Optional so a schema-1.0 (legacy)
  // submission still verifies unchanged; submitRecommendation below rejects
  // one that does not match the session's OWN brief.
  reportSnapshotId?: string;
  weights?: { bucket: string; weight: number }[];
  cites?: string[];
  signature: string;
}

/** A take already recorded under a member's nonce — the identity of a retry (D52). */
interface RecordedSubmission {
  id: string;
  signature: string;
  verified: boolean;
  revision: number;
  final: boolean;
}

const recordedByNonce = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:recordedSubmission",
  purpose: "Find a take already recorded under a member's nonce, the identity of a retry (D52).",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT id, signature, verified, revision, final FROM swarm_recommendations
     WHERE member_id = $1 AND nonce = $2 LIMIT 1`,
    params: ["probe", "probe"],
  },
});
async function recordedSubmission(memberId: string, nonce: string): Promise<RecordedSubmission | null> {
  const [row] = await on(sql, recordedByNonce)<{ id: string; signature: string; verified: boolean; revision: number; final: boolean }>`
    SELECT id, signature, verified, revision, final FROM swarm_recommendations
     WHERE member_id = ${memberId} AND nonce = ${nonce} LIMIT 1`;
  return row
    ? { id: String(row.id), signature: row.signature, verified: row.verified === true, revision: takeRevision(row.revision), final: row.final === true }
    : null;
}

/**
 * The answer to a retry: the EXISTING record, as success (smoke spec §6.2).
 *
 * 200, not 201 — nothing was created. `final` says whether this take is still
 * the member's counting take: a retry that arrives after the member amended
 * returns its own row, which is no longer final, and says so.
 */
function alreadySubmitted(row: RecordedSubmission) {
  return {
    ok: true as const,
    status: 200,
    alreadySubmitted: true,
    recommendationId: row.id,
    verified: row.verified,
    revision: row.revision,
    final: row.final,
  };
}

/**
 * Whether a signature the ACTIVE key refused verifies under one of the member's
 * superseded keys (smoke spec §6.4). Keys are deactivated, never deleted
 * (issue #697), so every key a member ever held is still on file to ask.
 */
const supersededKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:verifiesUnderSupersededKey",
  purpose: "Read a member's retired keys, to tell a superseded-key signature from a tampered one.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT DISTINCT public_key FROM swarm_member_keys
     WHERE member_id = $1 AND NOT active AND public_key <> $2`,
    params: ["probe", "probe"],
  },
});
async function verifiesUnderSupersededKey(
  memberId: string,
  activePublicKey: string,
  sub: SubmissionInput,
): Promise<boolean> {
  const keys = await on(sql, supersededKeys)<{ public_key: string }>`
    SELECT DISTINCT public_key FROM swarm_member_keys
     WHERE member_id = ${memberId} AND NOT active AND public_key <> ${activePublicKey}`;
  for (const k of keys) {
    if (await verifySubmissionSignature(sub, sub.signature, k.public_key)) return true;
  }
  return false;
}

/**
 * What a submission answers. `alreadySubmitted` is true on a retry (200, the
 * existing record) and false on an acceptance (201, a new row); `final` says
 * whether the returned take is the member's counting take right now.
 *
 * `error` and `verified` are readable on either branch (absent where they do
 * not apply), so a caller can assert on them without narrowing first; the rest
 * of the success fields narrow with `"recommendationId" in result`.
 */
export type SubmitTakeResult =
  | {
      ok: true;
      status: number;
      alreadySubmitted: boolean;
      recommendationId: string;
      verified: boolean;
      revision: number;
      final: boolean;
      error?: undefined;
    }
  | { ok: false; status: number; error: string; verified?: undefined };

const SUBMIT_INSERT_PROBE = {
  statement: `INSERT INTO swarm_recommendations
          (session_id, member_id, subject_id, date, nonce, stance, confidence, body, memo_url, payload, signature, verified, revision, signing_key_id, report_snapshot_id, received_at)
        SELECT s.id, $1, $2, $3::date, $4, $5, $6::numeric, $7, $8, $9::jsonb, $10, true,
               (SELECT coalesce(max(r.revision), 0) + 1 FROM swarm_recommendations r
                WHERE r.session_id = s.id AND r.member_id = $11),
               $12::bigint, $13::bigint, c.at
        FROM swarm_sessions s, (SELECT clock_timestamp() AS at) c
        WHERE s.id = $14
          AND s.state = 'collecting'
          AND (s.window_closes_at IS NULL OR s.window_closes_at > c.at)
          AND (SELECT count(*) FROM swarm_recommendations r
               WHERE r.session_id = s.id AND r.member_id = $15) < $16
        RETURNING id, revision, final`,
  params: ["probe", "probe", "2000-01-01", "probe", "probe", 0.5, null, null, "{}", "probe", "probe", "1", null, SAMPLE_ID, "probe", 1],
} as const;
const submitMemberRole = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.role",
  purpose: "Refuse a take from a judge: a judge's word is a judgement, not a take.",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT role FROM swarm_members WHERE id = $1", params: ["probe"] },
});
const submitSession = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.session",
  purpose: "Read the subject's newest session and whether its window has passed on the database clock.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT *,
                                    (window_closes_at IS NOT NULL AND window_closes_at <= clock_timestamp()) AS window_passed
                               FROM swarm_sessions
                              WHERE subject_id = $1
                              ORDER BY convened_at DESC LIMIT 1`,
    params: ["probe"],
  },
});
const submitBrief = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.brief",
  purpose: "Read the analytics report snapshot the session's brief is bound to (issue #978).",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT report_snapshot_id FROM swarm_briefs WHERE session_id = $1", params: [SAMPLE_ID] },
});
const submitRoster = registerQuery({
  role: "rm_app",
  object: "swarm_session_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.roster",
  purpose: "Read whether the session seated a roster at all.",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT status FROM swarm_session_members WHERE session_id = $1", params: [SAMPLE_ID] },
});
const submitSeat = registerQuery({
  role: "rm_app",
  object: "swarm_session_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.seat",
  purpose: "Read the member's own seat on the session, to refuse a member who is not expected or is excused.",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT status FROM swarm_session_members WHERE session_id = $1 AND member_id = $2", params: [SAMPLE_ID, "probe"] },
});
const submitPrior = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.prior",
  purpose: "Count the member's takes in the session and their newest revision, the cheap cap refusal ahead of the signature verify.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT count(*)::int AS n, coalesce(max(revision), 0)::int AS latest
    FROM swarm_recommendations
    WHERE session_id = $1 AND member_id = $2`,
    params: [SAMPLE_ID, "probe"],
  },
});
const submitSubject = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.subject",
  purpose: "Read the subject's recommendation type, so a bucket_weights take must carry its weight vector.",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT recommendation_type FROM swarm_subjects WHERE id = $1", params: ["probe"] },
});
const submitSessionLock = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:submitRecommendation.sessionShare",
  purpose: "Hold the session row FOR SHARE, so a take in flight and a turnover closing the epoch serialise.",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT id FROM swarm_sessions WHERE id = $1 FOR SHARE", params: [SAMPLE_ID] },
});
const submitTakeLock = registerStatement({
  role: "rm_app",
  shape: "advisoryLockByText",
  site: "src/swarm/domain:submitRecommendation.memberLock",
  purpose: "Serialise one member's takes in one session, so amendments are accepted in order.",
  callers: [SWARM_ROUTE],
});
const submitInsertTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/domain:submitRecommendation.insert.takes",
  purpose: "Accept a take: insert it while its session is collecting and the database clock is before the close, under the cap.",
  callers: [SWARM_ROUTE],
  probe: SUBMIT_INSERT_PROBE,
});
const submitInsertSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.insert.sessions",
  purpose: "Gate the take's INSERT on its session's state and close instant, inside the same statement.",
  callers: [SWARM_ROUTE],
  probe: SUBMIT_INSERT_PROBE,
});
const submitAfterCount = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitRecommendation.afterCount",
  purpose: "After a refused insert, count the member's takes to say whether the cap or the window refused it.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT count(*)::int AS n FROM swarm_recommendations
        WHERE session_id = $1 AND member_id = $2`,
    params: [SAMPLE_ID, "probe"],
  },
});
const submitAudit = registerQuery({
  role: "rm_app",
  object: "audit_log",
  privileges: ["INSERT"],
  site: "src/swarm/domain:submitRecommendation.audit",
  purpose: "Record an accepted take or amendment in the audit log.",
  callers: [SWARM_ROUTE],
  probe: { statement: "INSERT INTO audit_log (actor, action, scope) VALUES ($1, $2, $3::jsonb)", params: ["probe", "submit_recommendation", "{}"] },
});
export async function submitRecommendation(token: string, sub: SubmissionInput): Promise<SubmitTakeResult> {
  const memberId = await memberIdForToken(token);
  if (!memberId) return { ok: false, status: 401, error: "unknown member token" };
  if (memberId !== sub.memberId) return { ok: false, status: 403, error: "token/member mismatch" };
  const member = (await on(sql, submitMemberRole)<{ role: string }>`SELECT role FROM swarm_members WHERE id = ${memberId}`)[0];
  if (member?.role === "judge") return { ok: false, status: 403, error: "judge_role_cannot_submit_takes" };

  // ── A RETRY IS IDENTIFIED BY ITS SIGNED NONCE (D52, smoke spec §6.2) ────────
  //
  // "A resubmission whose nonce is already recorded for that member and session
  // is a retry: it returns the existing record and the participant treats it as
  // success." A participant writes its signed submission to its workspace BEFORE
  // sending it, so a crash-restart resends the SAME bytes — and that resend may
  // arrive after the window closed, after a turnover, or after the member
  // amended. None of those changes what the answer is: the take was accepted
  // once, and this is that take. So the lookup comes FIRST, ahead of every
  // window, state and cap check, and it answers 200 with the recorded row
  // rather than a 409 that names no record (the participant reads
  // `alreadySubmitted`, `recommendationId` and `verified` —
  // scripts/agent/participant/take-runner.ts).
  //
  // THE SAME BYTES, NOT MERELY THE SAME NONCE. Ed25519 signatures are
  // deterministic, and the signature covers the nonce, the subject, the date and
  // the content, so an equal signature is an equal submission. A recorded nonce
  // under DIFFERENT signed bytes is not a retry of anything: it is a replay of a
  // spent nonce, refused as it always was (the `UNIQUE (member_id, nonce)`
  // constraint stays the authority), and it is refused here, before the
  // Ed25519 verify, so a looping agent pays one indexed lookup for it.
  //
  // NOTHING IS WRITTEN on either branch: an identical retry adds no row, and a
  // replay adds no row (D51: "a retry of the same submission returns the
  // existing record rather than adding a row").
  const recorded = await recordedSubmission(memberId, sub.nonce);
  if (recorded) {
    if (recorded.signature === sub.signature) return alreadySubmitted(recorded);
    return {
      ok: false,
      status: 409,
      error: "nonce already used by this member for different signed bytes (replay); mint a fresh nonce to amend",
    };
  }

  // Resolve the session by WHICH ONE IS COLLECTING for this subject, not by the
  // date the member signed. Since migration 0022 a subject may convene several
  // times a day, so a date no longer identifies a session — but at most one of
  // them is ever open for submissions, which is what makes this unambiguous.
  //
  // The signed date is still CHECKED (below), so the payload members sign is
  // unchanged and a submission aimed at a different day is still refused; it
  // just is not the lookup key any more.
  // The subject's MOST RECENT session, whatever state it is in — not "the
  // collecting one". Filtering to collecting here would turn "you are too late,
  // the window closed" (409) into "no such session" (404), which tells an agent
  // to retry rather than to stop. openSession() will not convene a second
  // session while one is scheduled/collecting, so the newest row is the only
  // candidate and this stays unambiguous.
  //
  // `window_passed` is the cheap early answer to a late take, read off the
  // DATABASE clock (§4.2) rather than this process's: `clock_timestamp()` at
  // the read. It is not the authority — the INSERT below re-checks against its
  // own reading — but a late take is refused here, before the signature work,
  // exactly as it was when this was an application-clock comparison.
  const session = (await on(sql, submitSession)<Record<string, any>>`SELECT *,
                                    (window_closes_at IS NOT NULL AND window_closes_at <= clock_timestamp()) AS window_passed
                               FROM swarm_sessions
                              WHERE subject_id = ${sub.subjectId}
                              ORDER BY convened_at DESC LIMIT 1`)[0];
  if (!session) return { ok: false, status: 404, error: "no session for subject" };
  // THE DEADLINE IS THE TIMESTAMP, NOT THE STATE (issue #570). There used to be
  // a `session.state !== 'collecting'` gate here returning
  // `submission window not open (state=<state>)`. It was the dead zone: an agent
  // polling on its own schedule, which is what every external operator's agent
  // does, hit it whenever it arrived in the gap between the previous session's
  // close and the next brief being published — a refusal that had nothing to do
  // with the deadline it had been given. With the window now equal to one full
  // cadence interval, a subject always has a session whose advertised window has
  // not passed, so the two `window_closes_at` comparisons below (this one, and
  // the INSERT predicate that re-checks it inside the same statement) are the
  // whole of the timing contract. A take arriving after session N closed and
  // before session N+1 has published its brief lands on N+1 — the session it
  // belongs to — because N+1 is the newest row and carries no deadline yet.
  //
  // THE EPOCH MODEL (issue #1026) put a state conjunct back — on the INSERT,
  // not here, and with a different answer. The dead zone this paragraph
  // describes cannot recur: for an active subject, turnover opens N+1
  // `collecting` in the transaction that closes N, so the newest session is
  // always the collecting one; for an inactive one the boundary opens nothing,
  // and "too late" is the true answer. What the conjunct refuses is a take
  // into an epoch that turnover already closed (a deactivation closes nothing:
  // D55 (4), §4.5), and it answers `submission window closed` — the same "you
  // are too late" as the instant — never `not open`. The early check below
  // reads the same two facts (state and instant) so a late take is refused
  // before the signature work; the INSERT's conjuncts remain the authority.
  //
  // Signed-date agreement. A stale agent that woke with yesterday's brief must
  // not have its take filed against today's session.
  if (sub.date && day(session.date) !== sub.date) {
    return {
      ok: false,
      status: 409,
      error: `signed date ${sub.date} does not match the open session for ${sub.subjectId} (${day(session.date)})`,
    };
  }
  if (session.window_passed === true || session.state !== "collecting") {
    return { ok: false, status: 409, error: "submission window closed" };
  }

// Report-snapshot binding (issue #978 AC6). Once this session's brief is
  // bound to an analytics report snapshot, every take must name the SAME
  // one — a stale or mismatched reportSnapshotId is refused here, BEFORE the
  // Ed25519 verify (same "cheap refusals first" discipline as the checks
  // below): a genuinely tampered id is instead caught by the signature
  // itself failing to verify (schema 2.0's canonical bytes include it), so
  // this check exists for the HONEST-but-wrong case, not the forged one.
  // A brief with no bound report snapshot (report_snapshot_id NULL — no
  // analytics run has submitted a report for this session's date) names
  // NOTHING, so a schema-1.0 (legacy) submission with no reportSnapshotId
  // keeps working — but a submission that DOES name one is refused rather
  // than waved through. The skipped-when-unbound version of this check let a
  // take signed under schema 2.0 carry a cryptographically-signed binding to
  // an arbitrary report (another date's, say) that the brief never
  // referenced, straight into the consensus receipt.
  const brief = (await on(sql, submitBrief)<{ report_snapshot_id: string | null }>`
    SELECT report_snapshot_id FROM swarm_briefs WHERE session_id = ${session.id}`)[0];
  const boundReportSnapshotId = brief?.report_snapshot_id != null ? String(brief.report_snapshot_id) : null;
  if (boundReportSnapshotId === null) {
    if (sub.reportSnapshotId != null) {
      return {
        ok: false,
        status: 409,
        error: "this session's brief is bound to no analytics report snapshot; submit no reportSnapshotId",
      };
    }
  } else if (sub.reportSnapshotId !== boundReportSnapshotId) {
    return {
      ok: false,
      status: 409,
      error: `reportSnapshotId does not match this session's brief (expected ${boundReportSnapshotId})`,
    };
  }
  // Roster gate (issue #152, AC6). An epoch seats its expected roster in the
  // transaction that opens it (insertEpoch), and the roster is immutable from
  // then on: a member activated mid-epoch joins the next one (admin-surface.md
  // US-C3). When a session has roster rows, only a member with a non-excused
  // ('expected') row on it may submit — this is what makes the roster
  // authoritative rather than advisory, and it is the same set
  // loadFrozenTakeSet counts and recordAbsencesTx records absences against.
  //
  // THE BYPASS IS KEYED ON THE SESSION'S ORIGIN, NOT ON AN EMPTY ROSTER. The
  // legacy two-step fixture path (openSession, then publishBrief) seats no
  // roster, and publishBrief stamps `brief_opens_at` when it opens that
  // session's window — the "brief opens later" shape §4.1 retired. Only such a
  // row skips the gate. An epoch (insertEpoch) never has `brief_opens_at`, so
  // an epoch opened while no member was active has an EMPTY roster that still
  // gates: a member activated mid-epoch is refused here and is not offered the
  // session by pendingTakesFor. Keying on `rosterRows.length === 0` let that
  // member submit into an epoch it was never seated in.
  const legacyUnrostered = session.brief_opens_at != null;
  const rosterRows = await on(sql, submitRoster)<{ status: string }>`
    SELECT status FROM swarm_session_members WHERE session_id = ${session.id}`;
  if (rosterRows.length > 0 || !legacyUnrostered) {
    const mine = (await on(sql, submitSeat)<{ status: string }>`
      SELECT status FROM swarm_session_members WHERE session_id = ${session.id} AND member_id = ${memberId}`)[0];
    if (!mine) return { ok: false, status: 403, error: "member is not on this session's expected roster" };
    if (mine.status === "excused") return { ok: false, status: 403, error: "member is excused from this session" };
  }

  // ── CHEAP REFUSALS, BEFORE THE ED25519 VERIFY (issue #573) ───────────────
  //
  // THIS ORDERING IS A REQUIREMENT, NOT AN OPTIMISATION. Until #573 the only
  // refusal of a repeat submit was the `UNIQUE (session_id, member_id)`
  // violation raised by the INSERT at the very bottom of this function — so a
  // looping agent paid for a token lookup, a session lookup, two roster
  // queries, `publicKeyFor` AND a full signature verification on every single
  // rejected call. Relaxing that constraint (migration 0028) removes the only
  // server-side bound there was on a member's write volume, and the members
  // are unattended LLM-driven agents shipped with a `while :; do … done` poll
  // loop. Both checks below are single indexed lookups, and both sit ABOVE
  // `publicKeyFor` and `verifySubmissionSignature` so a runaway loop is cheap
  // to refuse. Anything added between here and the verify must stay cheap.
  //
  // Pinned by backend/tests/swarm-take-revisions.test.ts, which proves the
  // ordering behaviourally rather than by reading this comment: it submits an
  // INVALID signature over the cap and asserts the cap's 409 (not the
  // signature's 400) AND that no `rejected_signature` agent-health event — the
  // observable side effect of the verify branch below — was ever written.
  const priorRow = (await on(sql, submitPrior)<{ n: number; latest: number }>`
    SELECT count(*)::int AS n, coalesce(max(revision), 0)::int AS latest
    FROM swarm_recommendations
    WHERE session_id = ${session.id} AND member_id = ${memberId}`)[0];
  const priorCount = priorRow?.n ?? 0;
  const latestRevision = priorRow?.latest ?? 0;

  // An AMENDMENT is a new nonce inside the window (D51, D52), and it meets the
  // same window as a first take: the state and instant checked above and again
  // on the INSERT. No second, state-keyed amendment gate exists (see the note
  // where TAKES_AMENDABLE_STATES used to be). What an amendment still meets
  // that a first take cannot is the cap.
  if (priorCount >= SWARM_TAKE_REVISION_CAP) {
    return {
      ok: false,
      status: 409,
      error: `amendment cap reached (${SWARM_TAKE_REVISION_CAP} takes per member per session)`,
    };
  }

  // A replayed nonce never reaches this point: the retry lookup at the top of
  // this function answers it, one indexed lookup in, before the session is
  // even resolved.

  // ── THE ALLOCATION ASK IS ENFORCED WHERE IT IS STILL RECOVERABLE (T17/D4) ─
  //
  // A `bucket_weights` subject convenes the swarm to produce a NUMBER. Until
  // this gate existed the only refusal of a take that cannot support one was at
  // RECEIPT ASSEMBLY (consensus-receipt.ts gates 5 and 5b), and that refusal is
  // TERMINAL: `swarm_recommendations` is append-only, amendments are gated on
  // `window_closes_at > now()`, and neither `reopenSessionAdmin` nor
  // `publishConsensusReceiptAdmin` can reach a published session. So ONE keyed
  // member — or any rmpc/MCP/API client, which is never asked for a vector —
  // destroyed the receipt of every `bucket_weights` session it touched, by
  // behaving normally. Here the same fact is a 400 with the window still open,
  // which the member answers by amending its take.
  //
  // BREAKING, AND DELIBERATELY SO (D4): a member client that does not carry the
  // four-bucket vector for these sessions now fails loudly at submission
  // instead of silently stranding the session. The assembly gates STAY as
  // defence in depth — they are the only guard over takes already on file.
  //
  // ORDERED BELOW THE CHEAP REFUSALS AND ABOVE THE VERIFY: it is one indexed
  // lookup, so a looping agent is still refused without paying for an Ed25519
  // verification, and a take that is a replay or over the amendment cap is
  // answered by the more specific refusal above.
  //
  // THE TYPE IS READ OFF THE SUBJECT, not off the session's rollup: the rollup
  // does not exist yet while takes are being collected, and the subject is what
  // the brief was built from (`publishBrief`, takeSchema.weights.optional).
  const subjectRow = (await on(sql, submitSubject)<{ recommendation_type: string | null }>`
    SELECT recommendation_type FROM swarm_subjects WHERE id = ${sub.subjectId}`)[0];
  if (subjectRow?.recommendation_type === "bucket_weights") {
    const vector = sub.weights;
    if (vector == null || vector.length === 0) {
      return {
        ok: false,
        status: 400,
        error: `weights_required_for_bucket_weights_subject: ${sub.subjectId} convenes for an allocation, so a take must carry the four-bucket weight vector (${[...RECEIPT_CANONICAL_BUCKET_ORDER].join(", ")}). ` +
          "A weightless take cannot support the receipt this session must publish, and once the window closes the refusal is no longer recoverable — so it is refused now, while amending is still possible.",
      };
    }
    const named = new Set(vector.map((w) => w.bucket));
    if (named.size !== RECEIPT_CANONICAL_BUCKET_ORDER.length ||
        !RECEIPT_CANONICAL_BUCKET_ORDER.every((bucket) => named.has(bucket))) {
      return {
        ok: false,
        status: 400,
        error: `weights_not_canonical_four: this take names {${[...named].join(", ")}}, and a bucket_weights take must name exactly {${[...RECEIPT_CANONICAL_BUCKET_ORDER].join(", ")}} — one entry each. ` +
          "A partial vector is NOT padded with zeros: a bucket a member never named would otherwise be signed as that member's explicit 0.00 vote.",
      };
    }
  }

  const key = await activeKeyFor(memberId);
  if (!key) return { ok: false, status: 403, error: "no registered key for member" };
  const verified = await verifySubmissionSignature(sub, sub.signature, key.publicKey);
  if (!verified) {
    // Agent-health surface (issue #208, scout #214): a rejected/tampered
    // signature was previously visible only in the submitting agent's own
    // stdout. Record it on the durable, queryable event log — AFTER the
    // session and member are already resolved above — with a bounded,
    // redacted detail (never the raw signature/public key/payload).
    //
    // A SUPERSEDED KEY IS NAMED AS ONE (smoke spec §6.4, criterion 148). A key
    // rebind — rotateMemberKeyAdmin, registerMember's re-registration,
    // `--spoof-keys` — leaves an old container holding the old private key for
    // a while, and the spec's promise is that "the server rejects submissions
    // signed with a superseded key, so the worst case is a refused take". A
    // tampered payload and a superseded key are different facts with different
    // remedies (fix the bytes, versus restart on the current credential), so
    // the second is told apart: the signature is checked against the member's
    // inactive keys, and one that verifies answers 403 with no row written.
    // Only on this failure path, so the happy path pays for one verify.
    const superseded = await verifiesUnderSupersededKey(memberId, key.publicKey, sub);
    await recordAgentHealthEvent("rejected_signature", session.id, memberId, {
      reason: superseded ? "signed with a superseded key" : "signature verification failed",
    });
    if (superseded) {
      return {
        ok: false,
        status: 403,
        error: "signing_key_superseded: this take is signed with a key the member no longer holds active; sign with the current key",
      };
    }
    return { ok: false, status: 400, error: "signature verification failed" };
  }

  try {
    // Close the TOCTOU gap: re-check the window inside the same statement by
    // gating the INSERT on a SELECT of the session whose close time has not
    // passed. If the window closed between our check above and now, 0 rows
    // insert and we reject.
    //
    // THE EPOCH MUST STILL BE COLLECTING (scheduler spec §4.2: "While a
    // session is `collecting` and now is before its `window_closes_at`"). Issue
    // #570 dropped this conjunct because the old lifecycle had a `scheduled`
    // gap between sessions and a `closeWindow` that ran before the advertised
    // instant. The epoch model has neither: a session is born `collecting`
    // (§3), and the only way an epoch leaves `collecting` is turnover (§4.3):
    // a deactivation closes nothing, and the window of an inactive subject
    // runs to its close (§4.5, D55 (4)). Only `system-scheduler` turns an
    // epoch over (D55), but its timer runs on its own clock, not the
    // database's (§4.2), so the API can still see a turnover commit before N's
    // stored close. Turnover does not move `window_closes_at`, so without this
    // conjunct a take that read N just before such a turnover committed landed
    // in a CLOSED epoch whose stored close was still in the future: after its
    // absences were recorded, and after aggregation.
    // Under the `FOR SHARE` lock below, the state this reads is the committed
    // one, so the take either lands before the close or is refused after it.
    //
    // ONE CLOCK (scheduler spec §4.2). The comparison reads `clock_timestamp()`
    // — the database clock at the moment of the comparison — never `now()`,
    // which is when the TRANSACTION began and would let a slow transaction that
    // started before `window_closes_at` accept a take after it. The reading is
    // taken ONCE (the `c` subquery) and is also what `received_at` stores, so
    // the instant a take was accepted at and the instant absences are later
    // judged against (`recordAbsencesTx`: `received_at <= window_closes_at`)
    // are the same number and can never disagree.
    //
    // THE SESSION ROW IS HELD `FOR SHARE` FIRST, in the same transaction. A
    // turnover closing this epoch takes the row `FOR UPDATE`, so the two
    // serialise: a take in flight finishes (and is visible to the turnover's
    // absence query) before the window is closed, and a take that arrives
    // during a turnover waits for it and is then judged against the clock as
    // it reads AFTER the wait.
    //
    // ONE MEMBER'S TAKES IN ONE SESSION ARE ACCEPTED ONE AT A TIME (D51, §6.2).
    // Two submissions from one member can race: an old and a new container
    // overlapping across a roster change, each with its own token and nonce.
    // Both are intentional amendments and both are accepted, in order, so the
    // later one is final. A transaction-scoped advisory lock keyed on
    // (session, member) serialises them after the session's `FOR SHARE`: the
    // second waits, and its INSERT then reads the first's committed row. Takes
    // from DIFFERENT members never share a key, so they never wait on each
    // other, and nothing here waits on a turnover that is itself waiting on
    // this transaction.
    //
    // REVISION IS COMPUTED IN SQL, inside that lock, not from the
    // `latestRevision` read above, so a racer cannot file "revision 2" off a
    // stale read. `UNIQUE (session_id, member_id, revision)` (migration 0028)
    // stays the authority beneath the lock: a writer that skipped it would
    // lose on the constraint and be answered with a 409 in the catch below, and
    // NO in-place edit of the winner's content ever happens.
    //
    // THE FINAL FLAG IS SET BY THE DATABASE, not here. Migration 0075's
    // BEFORE INSERT trigger clears the member's previous final take and marks
    // the new row final when it is the newest revision — which, inside the
    // lock, it always is. One implementation of D51's acceptance rule, in the
    // statement that accepts the take; the partial unique index beneath it
    // makes two final takes impossible whatever races. This INSERT carries no
    // `ON CONFLICT` clause, and must never gain one: the trigger runs before
    // the conflict check, so a skipped row would leave the member with no
    // final take at all.
    //
    // The cap is re-checked here as a conjunct for the same reason — the count
    // above is a read, this is the write. `latestRevision` is used only to make
    // the two-statement path explainable in the audit row.
    const rows = await sql.begin(async (tx) => {
      await on(tx, submitSessionLock)`SELECT id FROM swarm_sessions WHERE id = ${session.id} FOR SHARE`;
      await onStatement(tx, submitTakeLock)`SELECT pg_advisory_xact_lock(hashtextextended(${`swarm_recommendations:${session.id}:${memberId}`}, 0))`;
      return await on(tx, submitInsertTakes, submitInsertSessions)`
        INSERT INTO swarm_recommendations
          (session_id, member_id, subject_id, date, nonce, stance, confidence, body, memo_url, payload, signature, verified, revision, signing_key_id, report_snapshot_id, received_at)
        SELECT s.id, ${memberId}, ${sub.subjectId}, ${sub.date}, ${sub.nonce}, ${sub.stance},
               ${sub.confidence}, ${sub.body ?? null}, ${sub.memoUrl ?? null}, ${tx.json(sub as any)}, ${sub.signature}, true,
               (SELECT coalesce(max(r.revision), 0) + 1 FROM swarm_recommendations r
                WHERE r.session_id = s.id AND r.member_id = ${memberId}),
               ${key.id}, ${sub.reportSnapshotId ?? null}::bigint, c.at
        FROM swarm_sessions s, (SELECT clock_timestamp() AS at) c
        WHERE s.id = ${session.id}
          AND s.state = 'collecting'
          AND (s.window_closes_at IS NULL OR s.window_closes_at > c.at)
          AND (SELECT count(*) FROM swarm_recommendations r
               WHERE r.session_id = s.id AND r.member_id = ${memberId}) < ${SWARM_TAKE_REVISION_CAP}
        RETURNING id, revision, final`;
    });
    if (rows.length === 0) {
      // Two kinds of conjunct can zero this out, and they are not the same
      // answer to an agent: the window (the epoch closed, or its instant
      // passed) says "you are too late", the cap says "stop". Re-read the
      // count to say which — only on the failure path, so the happy path stays
      // one statement.
      const after = (await on(sql, submitAfterCount)<{ n: number }>`
        SELECT count(*)::int AS n FROM swarm_recommendations
        WHERE session_id = ${session.id} AND member_id = ${memberId}`)[0];
      if ((after?.n ?? 0) >= SWARM_TAKE_REVISION_CAP) {
        return {
          ok: false,
          status: 409,
          error: `amendment cap reached (${SWARM_TAKE_REVISION_CAP} takes per member per session)`,
        };
      }
      return { ok: false, status: 409, error: "submission window closed" };
    }
    const revision = Number(rows[0].revision);
    await on(sql, submitAudit)`INSERT INTO audit_log (actor, action, scope) VALUES (${memberId}, ${revision > 1 ? "amend_recommendation" : "submit_recommendation"}, ${sql.json({ sessionId: session.id, revision, supersedes: revision > 1 ? latestRevision : null })})`;
    return {
      ok: true,
      status: 201,
      alreadySubmitted: false,
      recommendationId: String(rows[0].id),
      verified: true,
      revision,
      final: rows[0].final === true,
    };
  } catch (e: any) {
    const message = String(e?.message ?? e);
    // A reportSnapshotId naming a row that does not exist trips the FK on
    // swarm_recommendations.report_snapshot_id. That is a caller bug, not a
    // server fault, so it is a 400 — never the 500 an unhandled 23503 became.
    if (e?.code === "23503" && `${e?.constraint_name ?? e?.constraint ?? ""} ${message}`.includes("report_snapshot")) {
      return { ok: false, status: 400, error: "reportSnapshotId does not name an existing analytics report snapshot" };
    }
    if (message.includes("duplicate") || e?.code === "23505") {
      // Which constraint lost tells the agent what to do next, and the two
      // answers are opposite: re-mint a nonce, or simply retry.
      const constraint = String(e?.constraint_name ?? e?.constraint ?? "") + " " + message;
      if (constraint.includes("member_id_nonce")) {
        // Two copies of ONE signed submission raced past the lookup at the top
        // and this one lost: it is the same retry, answered the same way.
        const winner = await recordedSubmission(memberId, sub.nonce);
        if (winner && winner.signature === sub.signature) return alreadySubmitted(winner);
        return { ok: false, status: 409, error: "nonce already used by this member for different signed bytes (replay); mint a fresh nonce to amend" };
      }
      return { ok: false, status: 409, error: "a concurrent submission from this member won the same revision; retry" };
    }
    throw e;
  }
}

// ── Pending takes: what an agent participant polls (smoke spec §6.2) ────────
//
// "Agents poll. An agent polls the API for `collecting` sessions it has not yet
// taken, submits, and sleeps." This is that poll's answer, and it is the same
// set the take path would accept a FIRST take into — so an agent is never sent
// to author a take the API will refuse on arrival:
//
//   * the session is `collecting` and the database clock is before its
//     `window_closes_at` (§4.2), the two conjuncts of the take INSERT;
//   * the member may submit to it: the session has no roster (the legacy
//     fixture path), or the member holds an `expected` seat on it — the
//     roster gate of submitRecommendation;
//   * the member has no take in it yet. A member that wants to AMEND does so
//     on its own initiative; the queue offers each session once, which is what
//     keeps a polling loop from re-authoring the same session forever.
//
// Soonest close first, so the one take a participant has in flight (§6.2) is
// the one that would otherwise be lost first. An empty list is "no work", and
// it is a list, never null: scripts/agent/participant/main.ts reads
// `{ pending: PendingWork[] }` and refuses any other shape.
export interface PendingTake {
  sessionId: string;
  subjectId: string;
  date: string;
  windowClosesAt: string | null;
}

const PENDING_TAKES_PROBE = {
  statement: `SELECT s.id, s.subject_id, s.date, s.window_closes_at
      FROM swarm_sessions s
     WHERE s.state = 'collecting'
       AND (s.window_closes_at IS NULL OR s.window_closes_at > clock_timestamp())
       AND (
         (s.brief_opens_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM swarm_session_members x WHERE x.session_id = s.id))
         OR EXISTS (SELECT 1 FROM swarm_session_members sm
                     WHERE sm.session_id = s.id AND sm.member_id = $1 AND sm.status = 'expected')
       )
       AND NOT EXISTS (SELECT 1 FROM swarm_recommendations r
                        WHERE r.session_id = s.id AND r.member_id = $2)
     ORDER BY s.window_closes_at NULLS LAST, s.id`,
  params: ["probe", "probe"],
} as const;
const pendingSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:pendingTakesFor.sessions",
  purpose: "List the collecting sessions a member could still file a first take into, soonest close first.",
  callers: [SWARM_ROUTE],
  probe: PENDING_TAKES_PROBE,
});
const pendingRoster = registerQuery({
  role: "rm_app",
  object: "swarm_session_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:pendingTakesFor.roster",
  purpose: "Apply the take path's roster gate: an unrostered legacy session, or the member's expected seat.",
  callers: [SWARM_ROUTE],
  probe: PENDING_TAKES_PROBE,
});
const pendingTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:pendingTakesFor.takes",
  purpose: "Offer each session once: skip one the member already has a take in.",
  callers: [SWARM_ROUTE],
  probe: PENDING_TAKES_PROBE,
});
export async function pendingTakesFor(memberId: string): Promise<PendingTake[]> {
  const rows = await on(sql, pendingSessions, pendingRoster, pendingTakes)<{ id: string; subject_id: string; date: unknown; window_closes_at: unknown }>`
    SELECT s.id, s.subject_id, s.date, s.window_closes_at
      FROM swarm_sessions s
     WHERE s.state = 'collecting'
       AND (s.window_closes_at IS NULL OR s.window_closes_at > clock_timestamp())
       AND (
         -- Only the legacy two-step fixture path (brief_opens_at stamped by
         -- publishBrief) is unrostered. An epoch with an empty roster offers
         -- itself to nobody: the same rule as the take path's roster gate.
         (s.brief_opens_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM swarm_session_members x WHERE x.session_id = s.id))
         OR EXISTS (SELECT 1 FROM swarm_session_members sm
                     WHERE sm.session_id = s.id AND sm.member_id = ${memberId} AND sm.status = 'expected')
       )
       AND NOT EXISTS (SELECT 1 FROM swarm_recommendations r
                        WHERE r.session_id = s.id AND r.member_id = ${memberId})
     ORDER BY s.window_closes_at NULLS LAST, s.id`;
  return rows.map((r) => ({
    sessionId: String(r.id),
    subjectId: r.subject_id,
    date: day(r.date),
    windowClosesAt: instant(r.window_closes_at),
  }));
}

// ── Onboarding: apply (public, signed) → activate (admin) ───────────────────
// The real path (docs/architecture.md §11 R1-R6). A prospective member submits
// its PUBLIC key with `apply`, together with an rmpc signature over the
// canonical application payload (@robotmoney/contract). The server verifies
// that signature against the submitted key BEFORE recording anything — an
// invalid/mismatched/wrong-bytes signature writes NOTHING. On success the
// member stays status='applied' and the key is registered INACTIVE (no token,
// cannot submit); the server — never the client — mints the member id
// (crypto.randomUUID()) and returns it (R2). An admin then `activate`s the
// member and its key. Bearer plaintext is minted only after the member proves
// possession of the private key through the challenge flow below. RM never
// holds private keys.
export interface ApplyInput { name: string; lens?: string; publicKey: string; contact: string; signature: string }

const APPLY_EXISTING_PROBE = {
  statement: `SELECT k.member_id, m.status
      FROM swarm_member_keys k
      JOIN swarm_members m ON m.id = k.member_id
      WHERE k.public_key = $1
      ORDER BY k.created_at DESC LIMIT 1
      FOR UPDATE OF m`,
  params: ["probe"],
} as const;
const applyExistingKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:applyMember.existing.keys",
  purpose: "Find a pending applicant by the public key it applied with, to refresh rather than fork its identity.",
  callers: [ONBOARDING_ROUTE],
  probe: APPLY_EXISTING_PROBE,
});
const applyExistingMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:applyMember.existing.members",
  purpose: "Lock the applicant's member row while a re-apply is decided.",
  callers: [ONBOARDING_ROUTE],
  probe: APPLY_EXISTING_PROBE,
});
const applyRefreshMember = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:applyMember.refresh.member",
  purpose: "Refresh a re-applying applicant's name, lens and contact on its existing row.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `UPDATE swarm_members
        SET name = $1, lens = $2, contact_email = $3, applied_at = now()
        WHERE id = $4`,
    params: ["probe", null, "probe", "probe"],
  },
});
const applyRefreshApplication = registerQuery({
  role: "rm_app",
  object: "swarm_applications",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:applyMember.refresh.application",
  purpose: "Re-open a re-applying applicant's application as pending with the new payload.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `UPDATE swarm_applications
        SET payload = $1::jsonb, status = 'pending', reviewed_at = NULL
        WHERE member_id = $2`,
    params: ["{}", "probe"],
  },
});
const applyRefreshAudit = registerQuery({
  role: "rm_app",
  object: "audit_log",
  privileges: ["INSERT"],
  site: "src/swarm/domain:applyMember.refresh.audit",
  purpose: "Record a refreshed application in the audit log.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: "INSERT INTO audit_log (actor, action, scope) SELECT 'public:apply', 'apply_refresh', $1::jsonb WHERE false",
    params: ["{}"],
  },
});
const applyInsertMember = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["INSERT"],
  site: "src/swarm/domain:applyMember.insert.member",
  purpose: "Record a new applicant as an applied member.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_members (id, status, name, lens, contact_email, applied_at)
             SELECT $1, 'applied', $2, $3, $4, now() WHERE false`,
    params: ["probe", "probe", null, "probe"],
  },
});
const applyInsertKey = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["INSERT"],
  site: "src/swarm/domain:applyMember.insert.key",
  purpose: "Register the applicant's public key, inactive: no token, cannot submit.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: "INSERT INTO swarm_member_keys (member_id, public_key, active) SELECT $1, $2, false WHERE false",
    params: ["probe", "probe"],
  },
});
const applyInsertApplication = registerQuery({
  role: "rm_app",
  object: "swarm_applications",
  privileges: ["INSERT"],
  site: "src/swarm/domain:applyMember.insert.application",
  purpose: "Record the signed application payload as pending.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: "INSERT INTO swarm_applications (member_id, payload, status) SELECT $1, $2::jsonb, 'pending' WHERE false",
    params: ["probe", "{}"],
  },
});
const applyInsertAudit = registerQuery({
  role: "rm_app",
  object: "audit_log",
  privileges: ["INSERT"],
  site: "src/swarm/domain:applyMember.insert.audit",
  purpose: "Record a new application in the audit log.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: "INSERT INTO audit_log (actor, action, scope) SELECT 'public:apply', 'apply', $1::jsonb WHERE false",
    params: ["{}"],
  },
});
export async function applyMember(input: ApplyInput) {
  // Verify BEFORE opening a transaction: setup-gated apply (R6) means an
  // unsigned/badly-signed submission never touches storage, not even a
  // rolled-back write.
  const application = { name: input.name, contact: input.contact, lens: input.lens, publicKey: input.publicKey };
  if (!await verifyApplicationSignature(application, input.signature, input.publicKey)) {
    // Echo the EXACT bytes this application should have been signed over.
    // Every byte of it is a field the caller just sent us, so this reveals
    // nothing — and without it a headless applicant has no reachable source
    // for the layout at all: the canonicalizer lives in a private repo, and
    // `/docs/investment-swarm/participation` renders client-side, so a
    // non-browser client gets an empty shell. Measured live (§11.3 E7): a real
    // member-agent with a correct key and a working `rmpc` burned minutes
    // brute-forcing key order against this bare 400. "Setup-gated apply" (R6)
    // is only fair if a correct setup can tell WHY it was rejected.
    return {
      ok: false,
      status: 400,
      error: "invalid signature over the canonical application payload",
      expectedPayload: canonicalizeApplication(application),
    };
  }

  return await sql.begin(async (tx) => {
    // Re-apply-by-key semantics (pinned decision, since the id is no longer
    // client-supplied so it can't be the re-apply key): lock the newest key
    // row (if any) sharing this exact public key.
    //   - a PENDING application under that key is REFRESHED in place (same
    //     member id, updated name/contact/lens/payload, application re-opened
    //     as 'pending' if it had been reviewed) — the owner resubmitting after
    //     a typo or a stale prompt shouldn't fork a second identity;
    //   - an ACTIVE (or otherwise already-admitted) member's key can NEVER be
    //     overwritten by an unauthenticated apply — that stays an admin
    //     operation (key rotation), so this returns 409.
    const existingKey = (await on(tx, applyExistingKeys, applyExistingMembers)<{ member_id: string; status: string }>`
      SELECT k.member_id, m.status
      FROM swarm_member_keys k
      JOIN swarm_members m ON m.id = k.member_id
      WHERE k.public_key = ${input.publicKey}
      ORDER BY k.created_at DESC LIMIT 1
      FOR UPDATE OF m`)[0];

    if (existingKey && existingKey.status !== "applied") {
      return { ok: false, status: 409, error: "publicKey already belongs to an admitted member; re-apply is an admin operation" };
    }

    if (existingKey) {
      const memberId = existingKey.member_id;
      await on(tx, applyRefreshMember)`
        UPDATE swarm_members
        SET name = ${input.name}, lens = ${input.lens ?? null}, contact_email = ${input.contact}, applied_at = now()
        WHERE id = ${memberId}`;
      await on(tx, applyRefreshApplication)`
        UPDATE swarm_applications
        SET payload = ${tx.json(input as any)}, status = 'pending', reviewed_at = NULL
        WHERE member_id = ${memberId}`;
      await on(tx, applyRefreshAudit)`INSERT INTO audit_log (actor, action, scope) VALUES ('public:apply', 'apply_refresh', ${tx.json({ memberId })})`;
      // NO RECEIPT EMAIL. A re-apply used to queue a second copy of the
      // apply-time receipt so the operator could recover a member id they had
      // lost from their terminal; swarm email is removed (issue #1026 W5,
      // decision D50 reversing D30) and the member id is returned in this
      // response body, which is the one place the skill reads it from anyway.
      return { ok: true, status: 201, memberId, memberStatus: "applied" as const };
    }

    const memberId = crypto.randomUUID();
    await on(tx, applyInsertMember)`INSERT INTO swarm_members (id, status, name, lens, contact_email, applied_at)
             VALUES (${memberId}, 'applied', ${input.name}, ${input.lens ?? null}, ${input.contact}, now())`;
    await on(tx, applyInsertKey)`INSERT INTO swarm_member_keys (member_id, public_key, active) VALUES (${memberId}, ${input.publicKey}, false)`;
    await on(tx, applyInsertApplication)`INSERT INTO swarm_applications (member_id, payload, status) VALUES (${memberId}, ${tx.json(input as any)}, 'pending')`;
    // actor is the request source, NOT the self-asserted body identity.
    await on(tx, applyInsertAudit)`INSERT INTO audit_log (actor, action, scope) VALUES ('public:apply', 'apply', ${tx.json({ memberId })})`;
    return { ok: true, status: 201, memberId, memberStatus: "applied" as const };
  });
}

// Public, privacy-safe application-status projection (Issue #237).
// Returns ONLY { memberId, status, claimable, claimed } — no name, lens, contact,
// or credentials. Benign, PII-free, membership-indistinguishable for unknown IDs.
export interface ApplicationStatusResponse {
  memberId: string;
  status: "pending" | "active" | "unknown";
  claimable: boolean;
  claimed: boolean;
}

const statusMember = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getApplicationStatus.member",
  purpose: "Read the applicant's member status, for the public status route.",
  callers: [ONBOARDING_ROUTE],
  probe: { statement: "SELECT status FROM swarm_members WHERE id = $1", params: ["probe"] },
});
const statusClaimed = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getApplicationStatus.claimed",
  purpose: "Tell whether an active key already holds a token, i.e. the bearer was claimed.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `SELECT 1 FROM swarm_member_keys
    WHERE member_id = $1 AND active = true AND token_hash IS NOT NULL LIMIT 1`,
    params: ["probe"],
  },
});
export async function getApplicationStatus(memberId: string): Promise<ApplicationStatusResponse> {
  const row = (await on(sql, statusMember)<{ status: string }>`
    SELECT status FROM swarm_members WHERE id = ${memberId}`)[0];
  const raw = row?.status ?? null; // 'applied' | 'active' | 'inactive' | null
  const active = raw === "active";
  const claimed = active && (await on(sql, statusClaimed)`
    SELECT 1 FROM swarm_member_keys
    WHERE member_id = ${memberId} AND active = true AND token_hash IS NOT NULL LIMIT 1`).length > 0;
  const status = raw === "applied" ? "pending"
               : active ? "active"
               : raw ? "pending" // inactive/other → don't leak specifics
               : "unknown";
  return { memberId, status, claimable: active && !claimed, claimed };
}

// Public, redacted application-status projection (§11 R2, legacy applyStatus route).
export type ApplicationState = "applied" | "approved" | "claimed" | "rejected" | "inactive";
export interface ApplicationStatus {
  id: string;
  state: ApplicationState;
  role: "member" | "judge";
  appliedAt: string | null;
  reviewedAt: string | null;
  claimedAt: string | null;
}

const applyStatusMember = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getApplyStatus.member",
  purpose: "Read the member's status, role and application instant.",
  callers: [ONBOARDING_ROUTE],
  probe: { statement: "SELECT status, role, applied_at FROM swarm_members WHERE id = $1", params: ["probe"] },
});
const applyStatusApplication = registerQuery({
  role: "rm_app",
  object: "swarm_applications",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getApplyStatus.application",
  purpose: "Read the member's newest application status.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `SELECT status, reviewed_at FROM swarm_applications
    WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1`,
    params: ["probe"],
  },
});
const applyStatusKey = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getApplyStatus.key",
  purpose: "Read whether the member's newest active key holds a token.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `SELECT token_hash FROM swarm_member_keys
    WHERE member_id = $1 AND active = true
    ORDER BY created_at DESC LIMIT 1`,
    params: ["probe"],
  },
});
const applyStatusChallenge = registerQuery({
  role: "rm_app",
  object: "swarm_claim_challenges",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getApplyStatus.challenge",
  purpose: "Read when the member's claim challenge was consumed.",
  callers: [ONBOARDING_ROUTE],
  probe: { statement: "SELECT consumed_at FROM swarm_claim_challenges WHERE member_id = $1", params: ["probe"] },
});
export async function getApplyStatus(memberId: string): Promise<ApplicationStatus | null> {
  const member = (await on(sql, applyStatusMember)<{ status: string; role: "member" | "judge"; applied_at: Date | null }>`
    SELECT status, role, applied_at FROM swarm_members WHERE id = ${memberId}`)[0];
  if (!member) return null;

  const application = (await on(sql, applyStatusApplication)<{ status: string; reviewed_at: Date | null }>`
    SELECT status, reviewed_at FROM swarm_applications
    WHERE member_id = ${memberId} ORDER BY created_at DESC LIMIT 1`)[0];
  const key = (await on(sql, applyStatusKey)<{ token_hash: string | null }>`
    SELECT token_hash FROM swarm_member_keys
    WHERE member_id = ${memberId} AND active = true
    ORDER BY created_at DESC LIMIT 1`)[0];
  const challenge = (await on(sql, applyStatusChallenge)<{ consumed_at: Date | null }>`
    SELECT consumed_at FROM swarm_claim_challenges WHERE member_id = ${memberId}`)[0];

  let state: ApplicationState;
  if (application?.status === "rejected") state = "rejected";
  else if (member.status === "applied") state = "applied";
  else if (member.status === "active") state = key?.token_hash ? "claimed" : "approved";
  else state = "inactive";

  return {
    id: memberId,
    state,
    role: member.role,
    appliedAt: member.applied_at ? new Date(member.applied_at).toISOString() : null,
    reviewedAt: application?.reviewed_at ? new Date(application.reviewed_at).toISOString() : null,
    claimedAt: key?.token_hash && challenge?.consumed_at ? new Date(challenge.consumed_at).toISOString() : null,
  };
}

// Admin-only. Transactional: locks the member + its pending key, preserves the
// roster-cap admission transaction, activates that exact key WITHOUT a bearer,
// and approves the application. It sends nothing: there is no activation email
// (D50) — the applicant learns of its admission by polling its application
// status. The first successful key-proof claim below is the only public path
// that installs a token hash.
export async function activateMember(memberId: string, role: "member" | "judge" = "member") {
  try {
    return await activateMemberTx(memberId, role);
  } catch (e) {
    // THIS CATCH IS NEW WITH THE DERIVATION (issue #562), and it is the reason
    // the two sibling create paths have had one since #596 while this one did
    // not: until now activateMember never WROTE `handle`, so no constraint that
    // guards the public namespace could fire on it. It writes one now, and
    // migration 0031's trigger fires on UPDATE as well as INSERT, so a derived
    // handle that lost a race to a rename committed between the probe and the
    // UPDATE would raise 23505 on swarm_members_handle_namespace and escape the
    // admin approve route as a sanitized `500 internal error`. The loser of
    // that race gets the same actionable 409 every other handle collision on
    // this surface gets. Caught OUTSIDE sql.begin: the transaction is already
    // aborted and rolled back by the time we answer.
    if (isHandleUniqueViolation(e)) return { ok: false, status: 409, error: "handle already taken" };
    throw e;
  }
}

const activateLockMember = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:activateMember.lockMember",
  purpose: "Lock the applicant's member row for the admission, reading the name and handle it carries.",
  callers: [ADMIN_ROUTE, ONBOARDING_ROUTE],
  probe: { statement: "SELECT id, name, handle FROM swarm_members WHERE id = $1 FOR UPDATE", params: ["probe"] },
});
const activateLockKey = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:activateMember.lockKey",
  purpose: "Lock the applicant's newest pending (inactive) key.",
  callers: [ADMIN_ROUTE, ONBOARDING_ROUTE],
  probe: {
    statement: "SELECT id FROM swarm_member_keys WHERE member_id = $1 AND active = false ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    params: ["probe"],
  },
});
const activateKey = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:activateMember.key",
  purpose: "Activate the pending key with no token: the member proves possession before a bearer is minted.",
  callers: [ADMIN_ROUTE, ONBOARDING_ROUTE],
  probe: {
    statement: `UPDATE swarm_member_keys SET active = true, token_hash = NULL
      WHERE id = $1 AND active = false RETURNING id`,
    params: ["1"],
  },
});
const activateMemberRow = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:activateMember.member",
  purpose: "Flip the member to active with its role and handle.",
  callers: [ADMIN_ROUTE, ONBOARDING_ROUTE],
  probe: {
    statement: `UPDATE swarm_members
      SET status = 'active', role = $1, handle = $2, activated_at = now(), version = version + 1, updated_at = now()
      WHERE id = $3`,
    params: ["member", "probe", "probe"],
  },
});
const activateApplication = registerQuery({
  role: "rm_app",
  object: "swarm_applications",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:activateMember.application",
  purpose: "Mark the member's pending application approved.",
  callers: [ADMIN_ROUTE, ONBOARDING_ROUTE],
  probe: {
    statement: "UPDATE swarm_applications SET status = 'approved', reviewed_at = now() WHERE member_id = $1 AND status = 'pending'",
    params: ["probe"],
  },
});
const activateAudit = registerQuery({
  role: "rm_app",
  object: "audit_log",
  privileges: ["INSERT"],
  site: "src/swarm/domain:activateMember.audit",
  purpose: "Record an admission in the audit log.",
  callers: [ADMIN_ROUTE, ONBOARDING_ROUTE],
  probe: {
    statement: "INSERT INTO audit_log (actor, action, scope) SELECT 'admin', 'activate_member', $1::jsonb WHERE false",
    params: ["{}"],
  },
});
async function activateMemberTx(memberId: string, role: "member" | "judge") {
  return await sql.begin(async (tx) => {
    // `name` and `handle` ride along on the row we are already locking (issue
    // #562): the handle derivation below needs to know whether anybody has
    // already set one, and this row is already held.
    const existing = (await on(tx, activateLockMember)`
      SELECT id, name, handle FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0] as
      | { id: string; name: string; handle: string | null }
      | undefined;
    if (!existing) return { ok: false, status: 404, error: "no such applicant" };
    const key = (await on(tx, activateLockKey)`SELECT id FROM swarm_member_keys WHERE member_id = ${memberId} AND active = false ORDER BY created_at DESC LIMIT 1 FOR UPDATE`)[0] as { id: number } | undefined;
    if (!key) return { ok: false, status: 409, error: "no pending key; member must apply first" };
    // Capacity gate: an 'applied' member is not yet active, so no exemption —
    // this admission must fit under SWARM_ROSTER_CAP or it's refused.
    const cap = await assertRosterCapacity(tx);
    if (!cap.ok) return cap;
    const upd = await on(tx, activateKey)`
      UPDATE swarm_member_keys SET active = true, token_hash = NULL
      WHERE id = ${key.id} AND active = false RETURNING id`;
    if (upd.length === 0) return { ok: false, status: 409, error: "activation raced; retry" };
    // THE DERIVATION (issue #562), and note that it is an UPDATE. Acceptance is
    // not an INSERT — applyMember already wrote this row at apply time with
    // `id = crypto.randomUUID()`, and migration 0030's BEFORE INSERT trigger
    // stamped that UUID as the handle — so 0030 cannot carry this and the write
    // has to happen here, at the moment the member becomes public.
    //
    // Only from 0030's untouched default: an administrator may set a pending
    // applicant's handle before acceptance (updateMemberAdminTx is not
    // status-gated), and overwriting that would regress a shipped capability.
    // See swarm/handle.ts for both rules and why they are what they are.
    const handle = handleIsUnset(existing)
      ? await deriveMemberHandle(tx, { memberId, name: existing.name })
      : existing.handle;
    await on(tx, activateMemberRow)`
      UPDATE swarm_members
      SET status = 'active', role = ${role}, handle = ${handle}, activated_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${memberId}`;
    await on(tx, activateApplication)`UPDATE swarm_applications SET status = 'approved', reviewed_at = now() WHERE member_id = ${memberId} AND status = 'pending'`;
    await on(tx, activateAudit)`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'activate_member', ${tx.json({ memberId, handle })})`;
    return {
      ok: true,
      status: 200,
      memberId,
      handle,
      claimRequired: true,
    };
  });
}

const CLAIM_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface TokenClaimChallenge {
  memberId: string;
  challenge: string;
  expiresAt: string;
}

/**
 * Always returns the same opaque shape. Only an approved active member with an
 * active key gets the challenge persisted; unknown/pending ids receive a
 * throwaway challenge, so issuance does not disclose membership state.
 */
const claimLock = registerStatement({
  role: "rm_app",
  shape: "advisoryLockByText",
  site: "src/swarm/domain:claimChallenge.lock",
  purpose: "Serialise one member's token-claim challenge issuance and claim.",
  callers: [ONBOARDING_ROUTE],
});
const CLAIM_ELIGIBLE_PROBE = {
  statement: `SELECT k.id
      FROM swarm_members m
      JOIN swarm_member_keys k ON k.id = (
        SELECT newest.id FROM swarm_member_keys newest
        WHERE newest.member_id = m.id AND newest.active = true
        ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
      )
      WHERE m.id = $1 AND m.status = 'active' AND k.token_hash IS NULL`,
  params: ["probe"],
} as const;
const claimEligibleMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:issueTokenClaimChallenge.eligible.members",
  purpose: "Find an active member whose newest active key holds no token yet: the only one a challenge is persisted for.",
  callers: [ONBOARDING_ROUTE],
  probe: CLAIM_ELIGIBLE_PROBE,
});
const claimEligibleKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT"],
  site: "src/swarm/domain:issueTokenClaimChallenge.eligible.keys",
  purpose: "Join the member's newest active key.",
  callers: [ONBOARDING_ROUTE],
  probe: CLAIM_ELIGIBLE_PROBE,
});
const claimChallengeUpsert = registerQuery({
  role: "rm_app",
  object: "swarm_claim_challenges",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/swarm/domain:issueTokenClaimChallenge.upsert",
  purpose: "Persist the member's one claim challenge, replacing any earlier one.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_claim_challenges (member_id, challenge, issued_at, expires_at, consumed_at)
      SELECT $1, $2, now(), $3, NULL WHERE false
      ON CONFLICT (member_id) DO UPDATE SET
        challenge = EXCLUDED.challenge,
        issued_at = EXCLUDED.issued_at,
        expires_at = EXCLUDED.expires_at,
        consumed_at = NULL`,
    params: ["probe", "probe", "2000-01-01 00:00:00+00"],
  },
});
export async function issueTokenClaimChallenge(memberId: string): Promise<TokenClaimChallenge> {
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = new Date(Date.now() + CLAIM_CHALLENGE_TTL_MS);
  await sql.begin(async (tx) => {
    // Serialize issue/claim for this opaque id. This closes the race where an
    // issuer could observe token_hash=NULL, wait behind a successful claim,
    // then replace its consumed row using the stale observation.
    await onStatement(tx, claimLock)`SELECT pg_advisory_xact_lock(hashtextextended(${`token_claim:${memberId}`}, 0))`;
    const eligible = await on(tx, claimEligibleMembers, claimEligibleKeys)`
      SELECT k.id
      FROM swarm_members m
      JOIN swarm_member_keys k ON k.id = (
        SELECT newest.id FROM swarm_member_keys newest
        WHERE newest.member_id = m.id AND newest.active = true
        ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
      )
      WHERE m.id = ${memberId} AND m.status = 'active' AND k.token_hash IS NULL`;
    if (eligible.length === 0) return;
    await on(tx, claimChallengeUpsert)`
      INSERT INTO swarm_claim_challenges (member_id, challenge, issued_at, expires_at, consumed_at)
      VALUES (${memberId}, ${challenge}, now(), ${expiresAt}, NULL)
      ON CONFLICT (member_id) DO UPDATE SET
        challenge = EXCLUDED.challenge,
        issued_at = EXCLUDED.issued_at,
        expires_at = EXCLUDED.expires_at,
        consumed_at = NULL`;
  });
  return { memberId, challenge, expiresAt: expiresAt.toISOString() };
}

export interface TokenClaimInput extends TokenClaimChallenge {
  signature: string;
}

/**
 * Consume a valid signed challenge and install the first token hash atomically.
 * Wrong/expired/unknown proofs are indistinguishable 400s. A valid proof after
 * the first successful claim is the documented 409 and never rotates a token.
 */
const CLAIM_ROW_PROBE = {
  statement: `SELECT c.challenge, c.expires_at, c.consumed_at,
             k.id AS key_id, k.public_key, k.token_hash
      FROM swarm_claim_challenges c
      JOIN swarm_members m ON m.id = c.member_id AND m.status = 'active'
      JOIN swarm_member_keys k ON k.id = (
        SELECT newest.id FROM swarm_member_keys newest
        WHERE newest.member_id = c.member_id AND newest.active = true
        ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
      )
      WHERE c.member_id = $1
      FOR UPDATE OF c, k`,
  params: ["probe"],
} as const;
const claimRowChallenges = registerQuery({
  role: "rm_app",
  object: "swarm_claim_challenges",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:claimMemberToken.row.challenges",
  purpose: "Lock the member's claim challenge while the signed proof is checked.",
  callers: [ONBOARDING_ROUTE],
  probe: CLAIM_ROW_PROBE,
});
const claimRowMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:claimMemberToken.row.members",
  purpose: "Require the claiming member to be active.",
  callers: [ONBOARDING_ROUTE],
  probe: CLAIM_ROW_PROBE,
});
const claimRowKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:claimMemberToken.row.keys",
  purpose: "Lock the member's newest active key, the one the token is installed on.",
  callers: [ONBOARDING_ROUTE],
  probe: CLAIM_ROW_PROBE,
});
const claimInstall = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:claimMemberToken.install",
  purpose: "Install the first token hash on the key, once.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `UPDATE swarm_member_keys SET token_hash = $1
      WHERE id = $2 AND active = true AND token_hash IS NULL
      RETURNING id`,
    params: ["probe", "1"],
  },
});
const claimConsume = registerQuery({
  role: "rm_app",
  object: "swarm_claim_challenges",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:claimMemberToken.consume",
  purpose: "Consume the challenge so the proof cannot be replayed.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `UPDATE swarm_claim_challenges SET consumed_at = now()
      WHERE member_id = $1 AND challenge = $2 AND consumed_at IS NULL`,
    params: ["probe", "probe"],
  },
});
const claimAudit = registerQuery({
  role: "rm_app",
  object: "audit_log",
  privileges: ["INSERT"],
  site: "src/swarm/domain:claimMemberToken.audit",
  purpose: "Record a token claim in the audit log.",
  callers: [ONBOARDING_ROUTE],
  probe: {
    statement: `INSERT INTO audit_log (actor, action, scope)
      SELECT $1, 'claim_member_token', $2::jsonb WHERE false`,
    params: ["probe", "{}"],
  },
});
export async function claimMemberToken(input: TokenClaimInput) {
  return sql.begin(async (tx) => {
    await onStatement(tx, claimLock)`SELECT pg_advisory_xact_lock(hashtextextended(${`token_claim:${input.memberId}`}, 0))`;
    const row = (await on(tx, claimRowChallenges, claimRowMembers, claimRowKeys)<{
      challenge: string;
      expires_at: Date;
      consumed_at: Date | null;
      key_id: number;
      public_key: string;
      token_hash: string | null;
    }>`
      SELECT c.challenge, c.expires_at, c.consumed_at,
             k.id AS key_id, k.public_key, k.token_hash
      FROM swarm_claim_challenges c
      JOIN swarm_members m ON m.id = c.member_id AND m.status = 'active'
      JOIN swarm_member_keys k ON k.id = (
        SELECT newest.id FROM swarm_member_keys newest
        WHERE newest.member_id = c.member_id AND newest.active = true
        ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
      )
      WHERE c.member_id = ${input.memberId}
      FOR UPDATE OF c, k`)[0];
    const invalid = { ok: false, status: 400, error: "invalid or expired token-claim proof" };
    if (!row) return invalid;
    const expiresAt = new Date(row.expires_at).toISOString();
    if (
      row.challenge !== input.challenge ||
      expiresAt !== input.expiresAt ||
      new Date(row.expires_at).getTime() <= Date.now()
    ) return invalid;

    const proof = { memberId: input.memberId, challenge: row.challenge, expiresAt };
    if (!await verifyClaimChallengeSignature(proof, input.signature, row.public_key)) return invalid;
    if (row.token_hash || row.consumed_at) {
      return { ok: false, status: 409, error: "bearer token already claimed; ask an administrator to rotate it if lost" };
    }

    const token = `tok_${input.memberId}_${crypto.randomUUID()}`;
    const installed = await on(tx, claimInstall)`
      UPDATE swarm_member_keys SET token_hash = ${hashKey(token)}
      WHERE id = ${row.key_id} AND active = true AND token_hash IS NULL
      RETURNING id`;
    if (installed.length === 0) {
      return { ok: false, status: 409, error: "bearer token already claimed; ask an administrator to rotate it if lost" };
    }
    await on(tx, claimConsume)`
      UPDATE swarm_claim_challenges SET consumed_at = now()
      WHERE member_id = ${input.memberId} AND challenge = ${row.challenge} AND consumed_at IS NULL`;
    await on(tx, claimAudit)`
      INSERT INTO audit_log (actor, action, scope)
      VALUES (${input.memberId}, 'claim_member_token', ${tx.json({ memberId: input.memberId })})`;
    return { ok: true, status: 200, memberId: input.memberId, token };
  });
}

// ── Handle-namespace conflicts on the CREATE paths (issue #596) ─────────────
// Migration 0030's BEFORE INSERT trigger defaults `handle := id`, so creating a
// member whose id is already held as ANOTHER member's handle raises SQLSTATE
// 23505 on `swarm_members_handle_key` from inside the admission transaction —
// and an escaped exception is sanitized to `500 internal error` by
// api/index.ts, which tells the operator nothing. Both create paths
// (addMemberAdmin, registerMember) answer that conflict with this 409, which is
// the same actionable shape updateMemberAdmin already returns for the rename.
export const HANDLE_NAMESPACE_CONFLICT =
  "memberId already in use as another member's public handle";

// Keyed on the constraints that guard the public handle namespace, never on
// "any unique violation": swarm_members_pkey and swarm_member_keys' indexes
// raise 23505 too, and answering those with a handle message would describe the
// wrong conflict and hide a real bug behind a plausible sentence.
//
//   swarm_members_handle_key        — 0030's unique index, handle vs handle.
//   swarm_members_handle_namespace  — 0031's trigger, handle vs another
//                                     member's id and vice versa (issue #597).
//                                     Raised as 23505 WITH a constraint name
//                                     precisely so it lands here.
//
// Both mean the same thing to a caller — the public name it asked for already
// addresses somebody else — so both map to the same 409.
const HANDLE_NAMESPACE_CONSTRAINTS = new Set([
  "swarm_members_handle_key",
  "swarm_members_handle_namespace",
]);
export function isHandleUniqueViolation(e: unknown): boolean {
  const pg = e as { code?: string; constraint_name?: string; constraint?: string } | null;
  if (pg?.code !== "23505") return false;
  return HANDLE_NAMESPACE_CONSTRAINTS.has(String(pg.constraint_name ?? pg.constraint ?? ""));
}

// ── Demo onboarding ─────────────────────────────────────────────────────────
// A member generates its own keypair and registers its PUBLIC key here, getting
// a bearer token in one shot. This is the PRIVILEGED admin shortcut (apply +
// activate combined) used by the smoke/E2E harness; the public path is
// applyMember → activateMember. Private keys never leave the member.
const registerSeat = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/swarm/domain:registerMember.seat",
  purpose: "Seat a member as active, idempotently on its id (the smoke registration shortcut).",
  callers: [SWARM_ROUTE, ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_members (id, status, name, lens)
        SELECT $1, 'active', $2, $3 WHERE false
        ON CONFLICT (id) DO UPDATE SET status = 'active', name = EXCLUDED.name, lens = EXCLUDED.lens
        RETURNING id, handle`,
    params: ["probe", "probe", null],
  },
});
const registerHandle = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:registerMember.handle",
  purpose: "Stamp the derived public handle on a member that has none.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE],
  probe: { statement: "UPDATE swarm_members SET handle = $1 WHERE id = $2", params: ["probe", "probe"] },
});
const registerRetireKeys = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:registerMember.retireKeys",
  purpose: "Retire the member's active keys: a re-registration rebinds the identity.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE],
  probe: { statement: "UPDATE swarm_member_keys SET active = false WHERE member_id = $1 AND active = true", params: ["probe"] },
});
const registerInsertKey = registerQuery({
  role: "rm_app",
  object: "swarm_member_keys",
  privileges: ["INSERT"],
  site: "src/swarm/domain:registerMember.insertKey",
  purpose: "Register the member's new active key with its token hash.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_member_keys (member_id, public_key, token_hash)
               SELECT $1, $2, $3 WHERE false`,
    params: ["probe", "probe", "probe"],
  },
});
export async function registerMember(input: { memberId: string; name: string; lens?: string; publicKey: string }) {
  const token = `tok_${input.memberId}_${crypto.randomUUID()}`;
  // Transactional so the capacity gate and the writes are one atomic admission.
  // Exempt this id: re-registering an ALREADY-active member is idempotent
  // (ON CONFLICT DO UPDATE, same slot) and must not trip the cap; only a NET-NEW
  // active member counts against SWARM_ROSTER_CAP.
  try {
    return await sql.begin(async (tx) => {
      const cap = await assertRosterCapacity(tx, input.memberId);
      if (!cap.ok) return cap;
      // The upsert still names NO handle — 0030's trigger stamps `handle := id`
      // on a true insert and the conflict branch leaves the existing handle
      // alone — for the same reason addMemberAdmin does: `handle = id` is what
      // puts this create inside swarm_members_handle_key, which is the only
      // thing that physically blocks it against a concurrent, uncommitted
      // rename to this id (issue #596). The derivation is the UPDATE below.
      const seated = (await on(tx, registerSeat)<{ id: string; handle: string | null }>`
        INSERT INTO swarm_members (id, status, name, lens)
        VALUES (${input.memberId}, 'active', ${input.name}, ${input.lens ?? null})
        ON CONFLICT (id) DO UPDATE SET status = 'active', name = EXCLUDED.name, lens = EXCLUDED.lens
        RETURNING id, handle`)[0]!;
      // Issue #562: this path admits an ACTIVE member in one shot, so it is its
      // own derivation point — there is no later acceptance for activateMember
      // to derive at. Guarded by the same "nobody has set this" test acceptance
      // uses, which is what makes the idempotent RE-registration this upsert
      // exists for a no-op on the handle: a member an administrator has renamed
      // keeps that name however many times the smoke harness re-runs.
      if (handleIsUnset(seated)) {
        const handle = await deriveMemberHandle(tx, { memberId: input.memberId, name: input.name });
        await on(tx, registerHandle)`UPDATE swarm_members SET handle = ${handle} WHERE id = ${input.memberId}`;
      }
      // DEACTIVATE, never delete (issue #697) — matching every admin rotation
      // path (deactivateMemberAdmin, reactivateMemberAdmin, rotateMemberKeyAdmin
      // in swarm/admin.ts), all of which retain the prior row as
      // `active = false` rather than removing it. This used to be a hard
      // DELETE, which is exactly what made a re-registered member's PAST takes
      // stop being verifiable: their `public_key` resolves through a lookup
      // scoped to this member's key rows, and a deleted row is gone for that
      // lookup no matter what a take's `signing_key_id` points at.
      // `swarm_member_keys` now also carries its own append-only guard
      // (migration 0050), so a stray DELETE here would be refused at the
      // database regardless — this UPDATE is the correct operation, not a
      // workaround for the guard.
      await on(tx, registerRetireKeys)`UPDATE swarm_member_keys SET active = false WHERE member_id = ${input.memberId} AND active = true`;
      await on(tx, registerInsertKey)`INSERT INTO swarm_member_keys (member_id, public_key, token_hash)
               VALUES (${input.memberId}, ${input.publicKey}, ${hashKey(token)})`;
      return { memberId: input.memberId, token };
    });
  } catch (e) {
    // `ON CONFLICT (id)` arbitrates the PRIMARY KEY index and nothing else — it
    // does not cover swarm_members_handle_key, so the idempotent re-register it
    // exists for is untouched by this catch while the handle collision it never
    // saw stops escaping as a 500. Caught OUTSIDE sql.begin on purpose: the
    // transaction is already aborted and rolled back by the time we answer.
    if (isHandleUniqueViolation(e)) return { ok: false, status: 409, error: HANDLE_NAMESPACE_CONFLICT };
    throw e;
  }
}

// resetSessions() is REMOVED. It was a dev-only
// `TRUNCATE swarm_recommendations, swarm_briefs, swarm_sessions
//  RESTART IDENTITY CASCADE`
// so a smoke could re-run today's subject on a throwaway database. Two things
// made it indefensible once a stack could point at a persistent server: CASCADE
// took every published memo with it, and RESTART IDENTITY handed the reused ids
// to different memos, so an external link to /api/swarm/memos/5 silently
// resolved to someone else's text. Nothing wipes rows any more; an ephemeral
// database is dropped or inspected as a whole.

const ensureSubjectUpsert = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/swarm/domain:ensureSubject",
  purpose: "Create a subject or rename it, idempotently on its id.",
  callers: [ADMIN_ROUTE, SWARM_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_subjects (id, status, name, recommendation_type)
            SELECT $1, 'active', $2, 'bucket_weights' WHERE false
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    params: ["probe", "probe"],
  },
});
export async function ensureSubject(id: string, name: string) {
  await on(sql, ensureSubjectUpsert)`INSERT INTO swarm_subjects (id, status, name, recommendation_type)
            VALUES (${id}, 'active', ${name}, 'bucket_weights')
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  return { id, name };
}

// ── Deterministic reference-shaped fixtures & regime backfill (NO LLM) ────────
// The live swarm path must render the SAME rich memo/charts as the committed
// archive fixture (frontend/public/data/swarm/sessions/2026-06-25-woon.json).
// These helpers seed the subject snapshot the portfolio donut reads and backfill a
// trailing regime history so the sparkline always has >= 8 points, all from
// deterministic templates until real inference/portfolio ingestion is wired.

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const shiftDay = (date: string, deltaDays: number): string =>
  isoDay(new Date(new Date(`${date}T00:00:00Z`).getTime() + deltaDays * DAY_MS));
const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

// Small deterministic hash → seeded generator so synthetic values are stable for a
// given (subject/date) seed across runs (no Math.random).
function seeded(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  let s = h >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Regime labels come from the canonical shared classifier (@robotmoney/contract,
// canon = backend/src/analytics/analyze/regime.ts's 0.33/0.67 rule). This module
// previously carried its own diverged 0.45/0.55 rule (maintainability finding 002);
// never reintroduce a local threshold here.

// A single synthetic regime point on `date` at position `t` (0=oldest,1=newest)
// of the window. Gently decays composite (mirrors the reference sparkline) with a
// deterministic jitter so the line reads organic but reproducible.
function syntheticRegimePoint(date: string, t: number, rng: () => number) {
  const j = (amp: number) => (rng() - 0.5) * amp;
  const composite = round(0.58 - 0.045 * t + j(0.02));
  const macro = round(0.62 - 0.05 * t + j(0.03));
  const onchain = round(0.36 - 0.03 * t + j(0.03));
  const factor = round(0.78 - 0.06 * t + j(0.03));
  return { date, composite, regime: classifyRegime(composite), macro, onchain, factor };
}

// Idempotently backfill a trailing daily regime_snapshots history ending at
// `endDate` so downstream sparklines always have enough points. ON CONFLICT DO
// NOTHING preserves any REAL analytics rows — this only fills gaps.
//
// DEMO-ONLY synthesis (finding 009): regime_snapshots is owned by the analytics
// classifier; synthetic rows may be seeded only for smoke fixtures, never on a
// live/prod deployment. Gated on RM_ENV: a prod backend refuses to write
// synthetic rows (a sparse prod table stays sparse and visibly so). The live
// aggregation path (buildRegimeSummary) no longer calls this at all — only the
// smoke fixture seeding path (ensureSmokeSubjectFixtures) does.
const backfillCount = registerQuery({
  role: "rm_app",
  object: "regime_snapshots",
  privileges: ["SELECT"],
  site: "src/swarm/domain:backfillRegimeHistory.count",
  purpose: "Count the regime snapshots, to backfill only a database with too few (never on prod).",
  callers: [ADMIN_ROUTE, SWARM_ROUTE],
  probe: { statement: "SELECT count(*)::int AS n FROM regime_snapshots" },
});
const backfillInsert = registerQuery({
  role: "rm_app",
  object: "regime_snapshots",
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/domain:backfillRegimeHistory.insert",
  purpose: "Write one synthetic regime point for a smoke database, leaving any existing date alone.",
  callers: [ADMIN_ROUTE, SWARM_ROUTE],
  probe: {
    statement: `INSERT INTO regime_snapshots
        (date, composite, composite_percentile, regime,
         macro_regime, onchain_regime, factor_regime,
         macro_index, onchain_index, factor_index,
         macro_percentile, onchain_percentile, factor_percentile,
         percentiles, indicators)
      SELECT $1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb WHERE false
      ON CONFLICT (date) DO NOTHING`,
    params: ["2000-01-01", 0.5, 0.5, "neutral", "neutral", "neutral", "neutral", 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, "{}", "[]"],
  },
});
export async function backfillRegimeHistory(endDate: string, minPoints = 8): Promise<void> {
  if (config.env === "prod") return; // never write synthetic rows on the live deployment
  const existing = await on(sql, backfillCount)<{ n: number }>`SELECT count(*)::int AS n FROM regime_snapshots`;
  if (Number(existing[0]?.n ?? 0) >= minPoints) return;
  const span = Math.max(minPoints, 14);
  const rng = seeded(`regime:${endDate}`);
  for (let i = span - 1; i >= 0; i--) {
    const date = shiftDay(endDate, -i);
    const t = (span - 1 - i) / (span - 1);
    const p = syntheticRegimePoint(date, t, rng);
    const macroReg = classifyRegime(p.macro), onchainReg = classifyRegime(p.onchain), factorReg = classifyRegime(p.factor);
    await on(sql, backfillInsert)`
      INSERT INTO regime_snapshots
        (date, composite, composite_percentile, regime,
         macro_regime, onchain_regime, factor_regime,
         macro_index, onchain_index, factor_index,
         macro_percentile, onchain_percentile, factor_percentile,
         percentiles, indicators)
      VALUES
        (${date}, ${p.composite}, ${round(p.composite)}, ${p.regime},
         ${macroReg}, ${onchainReg}, ${factorReg},
         ${p.macro}, ${p.onchain}, ${p.factor},
         ${round(p.macro)}, ${round(p.onchain)}, ${round(p.factor)},
         ${sql.json({ macro: round(p.macro), onchain: round(p.onchain), factor: round(p.factor) })}, ${sql.json([])})
      ON CONFLICT (date) DO NOTHING`;
  }
}

// Reference-faithful subject baskets. woon mirrors the archive snapshot (WOON/
// PEAQ/USDC/ROBOTMONEY/rmUSDC ≈ $44,167.40); other subjects get a plausible
// deterministic parallel basket so the donut/table always render.
interface Position { token: string; chain: string; value_usd: number }
interface Basket { positions: Position[]; total: number; notable: string[] }

function subjectBasket(subjectId: string): Basket {
  if (subjectId === "woon") {
    const positions: Position[] = [
      { token: "WOON", chain: "peaq", value_usd: 24645.0 },
      { token: "PEAQ", chain: "peaq", value_usd: 15812.4 },
      { token: "USDC", chain: "base", value_usd: 2915.0 },
      { token: "rmUSDC", chain: "base", value_usd: 530.0 },
      { token: "ROBOTMONEY", chain: "base", value_usd: 265.0 },
    ];
    return {
      positions,
      total: round(positions.reduce((a, p) => a + p.value_usd, 0), 2),
      notable: [
        "WOON 55.8% + PEAQ 35.8% = 91.6% of book on a single peaq engagement revenue stream.",
        "Agent Tokens sleeve (ROBOTMONEY + rmUSDC) at 1.7% — below the 5% mandate floor.",
        "USDC 6.6% is unallocated stable cushion, not vault receipt exposure.",
      ],
    };
  }
  if (subjectId === "mav") {
    const positions: Position[] = [
      { token: "MAV", chain: "base", value_usd: 19760.0 },
      { token: "ETH", chain: "base", value_usd: 11400.0 },
      { token: "USDC", chain: "base", value_usd: 4940.0 },
      { token: "rmUSDC", chain: "base", value_usd: 1140.0 },
      { token: "ROBOTMONEY", chain: "base", value_usd: 760.0 },
    ];
    return {
      positions,
      total: round(positions.reduce((a, p) => a + p.value_usd, 0), 2),
      notable: [
        "MAV 52% is the anchor position; ETH 30% is the liquid beta sleeve.",
        "Agent Tokens sleeve (ROBOTMONEY + rmUSDC) at 5.0% — exactly at the mandate floor.",
        "USDC 13% stable buffer carries the next rebalancing tranche.",
      ],
    };
  }
  // Generic deterministic parallel basket for any other subject.
  const rng = seeded(`basket:${subjectId}`);
  const total = round(30000 + rng() * 20000, 2);
  const shares = [0.5, 0.28, 0.14, 0.05, 0.03];
  const tokens = [subjectId.slice(0, 5).toUpperCase() || "CORE", "ETH", "USDC", "rmUSDC", "ROBOTMONEY"];
  const positions: Position[] = shares.map((sh, i) => ({
    token: tokens[i], chain: i === 0 ? "base" : "base", value_usd: round(total * sh, 2),
  }));
  return {
    positions,
    total: round(positions.reduce((a, p) => a + p.value_usd, 0), 2),
    notable: [
      `${tokens[0]} ${Math.round(shares[0] * 100)}% is the anchor position.`,
      "Agent Tokens sleeve (ROBOTMONEY + rmUSDC) at 8% — above the 5% mandate floor.",
    ],
  };
}

// Idempotently seed the fixtures the LIVE swarm session path needs to render
// reference-shaped charts: the subject row (with thesis + recommendation type),
// a subject snapshot (positions/total/notable the portfolio donut reads), and a
// trailing regime history for the sparkline. Called from an admin action before a
// smoke session opens. `date` defaults to today; the snapshot is dated on-or-before
// the session date so the frontend snapshot picker selects it.
const smokeSubjectRead = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/domain:ensureSmokeSubjectFixtures.read",
  purpose: "Read the subject's source, to leave a framework subject alone.",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT id, source FROM swarm_subjects WHERE id = $1", params: ["probe"] },
});
const smokeSubjectUpsert = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/swarm/domain:ensureSmokeSubjectFixtures.subject",
  purpose: "Create the smoke subject, or fill only the fields it lacks.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_subjects (id, status, name, thesis_blurb, recommendation_type)
            SELECT $1, 'active', $2, $3, $4 WHERE false
            ON CONFLICT (id) DO UPDATE SET
              name = COALESCE(swarm_subjects.name, EXCLUDED.name),
              thesis_blurb = COALESCE(swarm_subjects.thesis_blurb, EXCLUDED.thesis_blurb),
              recommendation_type = COALESCE(swarm_subjects.recommendation_type, EXCLUDED.recommendation_type)`,
    params: ["probe", "probe", "probe", "position_actions"],
  },
});
const smokeSnapshotUpsert = registerQuery({
  role: "rm_app",
  object: "swarm_subject_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/swarm/domain:ensureSmokeSubjectFixtures.snapshot",
  purpose: "Write the smoke subject's snapshot for the date, replacing that date's values.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_subject_snapshots (subject_id, date, total_value_usd, positions, wallets, notable)
            SELECT $1, $2::date, $3, $4::jsonb, $5::jsonb, $6::jsonb WHERE false
            ON CONFLICT (subject_id, date) DO UPDATE SET
              total_value_usd = EXCLUDED.total_value_usd,
              positions = EXCLUDED.positions,
              notable = EXCLUDED.notable`,
    params: ["probe", "2000-01-01", 1, "[]", "[]", "[]"],
  },
});
export async function ensureSmokeSubjectFixtures(subjectId: string, name: string, date?: string) {
  const existing = (await on(sql, smokeSubjectRead)<{ id: string; source: any }>`
    SELECT id, source FROM swarm_subjects WHERE id = ${subjectId}
  `)[0];
  const sourceType = typeof existing?.source === "string"
    ? JSON.parse(existing.source)?.type
    : existing?.source?.type;
  if (sourceType === "framework") {
    return { skipped: true, reason: "framework_subject", subjectId, name };
  }

  const snapDate = date ?? new Date().toISOString().slice(0, 10);
  const recommendationType = "position_actions";
  const thesis = `${name}: treasury read through the 95/5/0/0 conservative allocation mandate — Conservative DeFi Yield anchors 95%, the Agent Tokens sleeve caps at 5%.`;
  await on(sql, smokeSubjectUpsert)`INSERT INTO swarm_subjects (id, status, name, thesis_blurb, recommendation_type)
            VALUES (${subjectId}, 'active', ${name}, ${thesis}, ${recommendationType})
            ON CONFLICT (id) DO UPDATE SET
              name = COALESCE(swarm_subjects.name, EXCLUDED.name),
              thesis_blurb = COALESCE(swarm_subjects.thesis_blurb, EXCLUDED.thesis_blurb),
              recommendation_type = COALESCE(swarm_subjects.recommendation_type, EXCLUDED.recommendation_type)`;

  const basket = subjectBasket(subjectId);
  await on(sql, smokeSnapshotUpsert)`INSERT INTO swarm_subject_snapshots (subject_id, date, total_value_usd, positions, wallets, notable)
            VALUES (${subjectId}, ${snapDate}, ${basket.total},
                    ${sql.json(basket.positions as any)}, ${sql.json([])}, ${sql.json(basket.notable as any)})
            ON CONFLICT (subject_id, date) DO UPDATE SET
              total_value_usd = EXCLUDED.total_value_usd,
              positions = EXCLUDED.positions,
              notable = EXCLUDED.notable`;

  await backfillRegimeHistory(snapDate);
  return { subjectId, name, snapshotDate: snapDate, totalValueUsd: basket.total, recommendationType };
}

// ── Lifecycle (also callable by worker handlers + dev driver) ───────────────
/**
 * Convene a session for a subject. THE DATABASE decides when it happened: the
 * caller passes no date, `convened_at` defaults to now(), and `date` is derived
 * from it (migration 0022). A client-supplied date is what let the smoke invent
 * synthetic future days and then TRUNCATE history to reuse them.
 *
 * Idempotent per OPEN session, not per day. An already-scheduled/collecting
 * session for this subject is returned as-is, so a re-delivered open request
 * cannot convene a second one — but once that session publishes, the next
 * call correctly convenes a new one, however soon after. That is what allows a
 * cadence faster than daily without a session ever overwriting another.
 *
 * THIS REFUSAL IS KEPT UNDER THE ONE-INTERVAL WINDOW (issue #570), deliberately.
 * Now that a session's advertised window is a whole cadence interval, its
 * `collecting` state lasts the whole epoch, so "there is already an open session
 * for this subject" is the normal steady state rather than a brief transient.
 * The refusal is what keeps `submitRecommendation`'s "newest session for this
 * subject" lookup unambiguous — exactly one session per subject can be accepting
 * takes — so relaxing it (say, letting an elapsed-but-unclosed session be
 * overtaken) would orphan that session un-aggregated AND give a subject two rows
 * that both look open. The reconciliation therefore lives on the CALLER side:
 * scripts/lib/swarm/session.ts adopts the returned open session instead of
 * demanding a freshly `scheduled` one, and does not republish a brief over it,
 * so an advertised deadline is never moved.
 */
const openSessionExisting = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:openSession.existing",
  purpose: "Find the subject's open (scheduled or collecting) session, so a re-delivered open request convenes no second one.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `SELECT id, date, convened_at, subject_id, subject_name, state
      FROM swarm_sessions
     WHERE subject_id = $1 AND state IN ('scheduled', 'collecting')
     ORDER BY convened_at DESC LIMIT 1`,
    params: ["probe"],
  },
});
const openSessionInsert = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/domain:openSession.insert",
  purpose: "Convene a session for the subject, scheduled; the database stamps when.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_sessions (subject_id, subject_name, state)
    SELECT $1, $2, 'scheduled' WHERE false
    RETURNING id, date, convened_at, subject_id, subject_name, state`,
    params: ["probe", "probe"],
  },
});
export async function openSession(subjectId: string) {
  const subject = await getSubject(subjectId);
  const existing = (await on(sql, openSessionExisting)<any>`
    SELECT id, date, convened_at, subject_id, subject_name, state
      FROM swarm_sessions
     WHERE subject_id = ${subjectId} AND state IN ('scheduled', 'collecting')
     ORDER BY convened_at DESC LIMIT 1`)[0];
  if (existing) return existing;
  const r = (await on(sql, openSessionInsert)<any>`
    INSERT INTO swarm_sessions (subject_id, subject_name, state)
    VALUES (${subjectId}, ${subject?.name ?? subjectId}, 'scheduled')
    RETURNING id, date, convened_at, subject_id, subject_name, state`)[0];
  return r;
}

// Append one immutable brief revision — never edits a prior one. Exported on
// its own (issue #978), same reason output-snapshot-store.ts exports
// insertOutputSnapshots/insertReportSnapshot/applyCurrentProjections
// separately: a test can compose this with a deliberately injected failure
// in its OWN sql.begin to prove the whole publish rolls back atomically,
// using the exact production code path rather than a duplicated copy of it.
const briefRevisionLock = registerStatement({
  role: "rm_app",
  shape: "advisoryLockByText",
  site: "src/swarm/domain:appendBriefRevision.lock",
  purpose: "Serialise revision numbering of one session's brief.",
  callers: [ADMIN_ROUTE, STREAM_ROUTE],
});
const briefRevisionNext = registerQuery({
  role: "rm_app",
  object: "swarm_brief_revisions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:appendBriefRevision.next",
  purpose: "Read the session's highest brief revision, to number the next.",
  callers: [ADMIN_ROUTE, STREAM_ROUTE],
  probe: { statement: "SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM swarm_brief_revisions WHERE session_id = $1", params: [SAMPLE_ID] },
});
const briefRevisionInsert = registerQuery({
  role: "rm_app",
  object: "swarm_brief_revisions",
  privileges: ["INSERT"],
  site: "src/swarm/domain:appendBriefRevision.insert",
  purpose: "Append an immutable brief revision with its checksum.",
  callers: [ADMIN_ROUTE, STREAM_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_brief_revisions (session_id, revision, body_bytes, checksum, report_snapshot_id)
    SELECT $1, $2, $3, $4, $5::bigint WHERE false`,
    params: [SAMPLE_ID, 1, "probe", "probe", null],
  },
});
export async function appendBriefRevision(
  sessionId: string,
  body: Record<string, unknown>,
  reportSnapshotId: string | null,
  tx: DbHandle,
): Promise<{ revision: number; checksum: string }> {
  const bodyBytes = Buffer.from(canonicalStringify(body), "utf8");
  const checksum = sha256Hex(bodyBytes);
  await onStatement(tx, briefRevisionLock)`SELECT pg_advisory_xact_lock(hashtextextended(${`swarm_brief_revisions:${sessionId}`}, 0))`;
  const [{ next }] = await on(tx, briefRevisionNext)<any>`
    SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM swarm_brief_revisions WHERE session_id = ${sessionId}`;
  await on(tx, briefRevisionInsert)`
    INSERT INTO swarm_brief_revisions (session_id, revision, body_bytes, checksum, report_snapshot_id)
    VALUES (${sessionId}, ${next}, ${bodyBytes}, ${checksum}, ${reportSnapshotId}::bigint)`;
  return { revision: Number(next), checksum };
}

/**
 * Build a session's brief BODY — everything the brief says, with no write of
 * any kind.
 *
 * EXTRACTED FROM `publishBrief` (issue #1026 W4.2) rather than copied. The
 * epoch model opens a session, publishes its brief and sets its
 * `window_closes_at` in ONE transaction (scheduler spec §4.1), which the old
 * two-call shape — `openSession()` then `publishBrief()` — cannot express: a
 * failure between them left a session with no brief and no advertised
 * deadline, which is exactly the `scheduled` limbo §4.1 abolishes. So the
 * epoch path needs the body-building, and it needs it against ITS transaction
 * handle. Duplicating it would give the two paths briefs that drift apart,
 * which is the one thing a signed take must never depend on.
 *
 * Every statement here is a READ, so running it inside the caller's
 * transaction costs correctness nothing and buys atomicity.
 */
const REPORT_SNAPSHOT_PROBE = {
    statement: `SELECT rs.id FROM analytics_report_snapshots rs
        JOIN analytics_output_snapshots os
          ON os.run_id = rs.run_id
         AND os.artifact_kind = 'regime_snapshots'
         AND os.payload_bytes <> convert_to('[]', 'UTF8')
        WHERE rs.asof = $1::date
        ORDER BY rs.id DESC LIMIT 1`,
    params: ["2000-01-01"],
  } as const;
const briefRegime = registerQuery({
  role: "rm_app",
  object: "regime_snapshots",
  privileges: ["SELECT"],
  site: "src/swarm/domain:buildBriefBody.regime",
  purpose: "Read the newest regime snapshot the brief carries.",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT date, composite, regime, macro_regime, onchain_regime FROM regime_snapshots ORDER BY date DESC LIMIT 1" },
});
const briefRecent = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:buildBriefBody.recent",
  purpose: "Read the subject's five most recent published sessions for the brief.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `SELECT id, date, convened_at, subject_id, state FROM swarm_sessions
                           WHERE state = 'published' AND subject_id = $1
                           ORDER BY convened_at DESC, id DESC LIMIT 5`,
    params: ["probe"],
  },
});
const briefSignals = registerQuery({
  role: "rm_app",
  object: "research_signals",
  privileges: ["SELECT"],
  site: "src/swarm/domain:buildBriefBody.signals",
  purpose: "Read the research signals of the session's date for the brief.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `SELECT signal_key, date, payload FROM research_signals
    WHERE date = $1 ORDER BY signal_key`,
    params: ["2000-01-01"],
  },
});
const briefFramework = registerQuery({
  role: "rm_app",
  object: "allocation_framework",
  privileges: ["SELECT"],
  site: "src/swarm/domain:buildBriefBody.framework",
  purpose: "Read the allocation framework a framework subject's brief carries.",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT asof, buckets FROM allocation_framework WHERE id = 1" },
});
const briefExisting = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["SELECT"],
  site: "src/swarm/domain:buildBriefBody.existing",
  purpose: "Read the session's existing brief body, whose allocation survives a rebuild.",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT body FROM swarm_briefs WHERE session_id = $1", params: [SAMPLE_ID] },
});
const briefReportSnapshots = registerQuery({
  role: "rm_app",
  object: "analytics_report_snapshots",
  privileges: ["SELECT"],
  site: "src/swarm/domain:buildBriefBody.report.snapshots",
  purpose: "Find the analytics report snapshot of the regime date, to bind the brief to it (issue #978).",
  callers: [ADMIN_ROUTE],
  probe: REPORT_SNAPSHOT_PROBE,
});
const briefReportOutputs = registerQuery({
  role: "rm_app",
  object: "analytics_output_snapshots",
  privileges: ["SELECT"],
  site: "src/swarm/domain:buildBriefBody.report.outputs",
  purpose: "Require that snapshot's run to have frozen a non-empty regime artifact.",
  callers: [ADMIN_ROUTE],
  probe: REPORT_SNAPSHOT_PROBE,
});
export async function buildBriefBody(
  s: Record<string, any>,
  windowClosesAt: string,
  prevOutcome: string | undefined,
  h: DbHandle,
): Promise<{ body: Record<string, unknown>; reportSnapshotId: string | null }> {
  const sql = h;
  const sessionId = String(s.id);
  const regimeRow = (await on(sql, briefRegime)<{ date: string | Date; composite: unknown; regime: unknown; macro_regime: unknown; onchain_regime: unknown }>`SELECT date, composite, regime, macro_regime, onchain_regime FROM regime_snapshots ORDER BY date DESC LIMIT 1`)[0] ?? null;
  const regime = regimeRow ? { ...regimeRow, method: REGIME_METHOD.id } : null;
  // Each ref carries its session id (issue #965): a subject may convene more
  // than once a day, so date and subject alone cannot reach an earlier session
  // of that day. Ordered by convened_at, the order getSession() uses to pick a
  // day's latest, so same-day refs come back newest first.
  const recent = await on(sql, briefRecent)<any>`SELECT id, date, convened_at, subject_id, state FROM swarm_sessions
                           WHERE state = 'published' AND subject_id = ${s.subject_id}
                           ORDER BY convened_at DESC, id DESC LIMIT 5`;

  const researchSignals = await on(sql, briefSignals)<any>`
    SELECT signal_key, date, payload FROM research_signals
    WHERE date = ${s.date} ORDER BY signal_key`;
  const previousSession = prevOutcome ? { outcome: prevOutcome } : undefined;
  // ON THE CALLER'S HANDLE, like every other read here. This read used to take
  // a second connection from the pool while the caller's transaction held its
  // own and the subject's row lock (turnover, openEpoch). With the pool full of
  // turnovers queued on that same lock — a scheduler catching up after a
  // database outage — no connection ever came back: every transaction waited
  // for the pool, every pooled query waited for the lock, and the api stopped
  // answering (found by scripts/tests/integration/scheduler-api-runtime.test.ts's
  // frozen-database case, which then could not restart the scheduler).
  const subject = await getSubject(s.subject_id, h);
  // The ONE read of the subject's recommendation type on this path — the same
  // value `aggregateSession()` normalizes, so the ask published to the swarm and
  // the derivation applied to its answers come from one column.
  const recommendationType = subject?.recommendationType === "bucket_weights" ? "bucket_weights" : "position_actions";
  const framework =
    (subject?.source as { type?: string } | null)?.type === "framework"
      ? (await on(sql, briefFramework)<{ asof: Date | string; buckets: unknown[] }>`SELECT asof, buckets FROM allocation_framework WHERE id = 1`)[0]
      : null;
  const existing = (await on(sql, briefExisting)<{ body?: { allocation?: unknown } }>`SELECT body FROM swarm_briefs WHERE session_id = ${sessionId}`)[0];
  const allocation = existing
    ? existing.body?.allocation ?? null
    : framework
      ? { asof: day(framework.asof), buckets: framework.buckets }
      : null;
  const body = {
    ...(allocation ? { allocation } : {}),
    regime,
    subject,
    recentSessions: recent,
    previousSession,
    researchSignals,
    prompt: {
      system: "You are an investment swarm member. Author only your own analysis and do not attribute invented statements to other members.",
      user: `Review the supplied swarm context for ${subject?.name ?? s.subject_id} on ${typeof s.date === "string" ? s.date : new Date(s.date).toISOString().slice(0, 10)} and return one take matching takeSchema.`,
    },
    takeSchema: {
      stance: { type: "string", enum: [...STANCES] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      body: { type: "string" },
      // WHAT THIS SESSION ACTUALLY ASKS FOR. `optional` used to be an
      // unconditional `true`, which said — truthfully, and uselessly — that the
      // API accepts a take with no vector. It never said that a
      // `bucket_weights` subject NEEDS one, so the brief an analyst reasons
      // from could not distinguish "an allocation is wanted" from "prose is
      // wanted", and v0.5.0-rc.1 published `bucket_weights` receipts carrying
      // no allocation at all. `buckets` is the canonical four, from the
      // contract, so the brief and the receipt schema can never disagree about
      // which vaults exist.
      weights: {
        type: "array",
        optional: recommendationType !== "bucket_weights",
        buckets: [...RECEIPT_CANONICAL_BUCKET_ORDER],
        items: {
          bucket: { type: "string", enum: [...RECEIPT_CANONICAL_BUCKET_ORDER] },
          weight: { type: "number", minimum: 0 },
        },
      },
      cites: {
        type: "array",
        optional: true,
        items: { type: "string" },
      },
    },
    windowClosesAt,
  };
// Issue #978 AC5/AC6: bind this brief to the exact, immutable analytics
  // report snapshot that produced the regime numbers this brief BODY shows —
  // derived from the embedded `regime` row above, NOT from the session's own
  // market date.
  //
  // NOT the newest snapshot for the date. The producer arms TWO runs per
  // `asof` — regime (22:30) and research (23:00, RESEARCH_TOOL_GROUP) — and
  // each freezes its own report snapshot, so a plain `ORDER BY id DESC`
  // always won the research run, whose report bytes contain no regime data at
  // all. Hence the join: only a run that froze a NON-EMPTY `regime_snapshots`
  // output artifact is a candidate. Since issue #978 that artifact and the
  // current-view projection are written by one transaction
  // (applyCurrentProjections), so "froze regime rows" and "published the
  // regime rows the brief reads" are the same run.
  //
  // NOT `rs.asof = s.date` either, which the old daily session cadence made
  // permanently unsatisfiable: a session convened 06:00 and published its
  // brief 07:00 UTC on day D, but day D's regime run does not fire until 22:30 UTC
  // (PRODUCER_REGIME_CRON) — 15.5 hours after the session is over. Keying on
  // the session date bound every real brief to NULL, and NULL is
  // indistinguishable from the legitimate "this subject has no analytics
  // report" case, so nothing went red while every schema-2.0 take was 409'd.
  //
  // Keying on `regime.date` is correct under ANY schedule because it is a
  // derivation rather than a guess: `buildDateAxis(BACKFILL_START, asof)`
  // (analytics/index.ts) always ends the published row set exactly at the
  // run's own `asof`, so the MAX-dated row in `regime_snapshots` — the one
  // line 1700 reads into the body — is by construction the newest
  // regime-bearing run's `asof`. Looking that date up in
  // `analytics_report_snapshots.asof` therefore names that run's report, the
  // one whose bytes contain the exact numbers displayed. `ORDER BY rs.id
  // DESC` breaks a same-date re-run tie toward the last writer, which is the
  // run whose rows actually won the upsert.
  //
  // A brief with no regime row at all to show (a fresh database, a
  // smoke/legacy subject), or one whose newest regime row predates the
  // snapshot layer / was seeded outside it (import-regime-eq.ts), gets
  // `report_snapshot_id = NULL` — the same documented cutover shape as
  // migration 0049's signing_key_id, and honest: there is no frozen report
  // holding those numbers.
  const regimeDate: string | null = regime
    ? regime.date instanceof Date
      ? regime.date.toISOString().slice(0, 10)
      : String(regime.date).slice(0, 10)
    : null;
  const [report] = regimeDate === null
    ? []
    : await on(sql, briefReportSnapshots, briefReportOutputs)<any>`
        SELECT rs.id FROM analytics_report_snapshots rs
        JOIN analytics_output_snapshots os
          ON os.run_id = rs.run_id
         AND os.artifact_kind = 'regime_snapshots'
         AND os.payload_bytes <> convert_to('[]', 'UTF8')
        WHERE rs.asof = ${regimeDate}::date
        ORDER BY rs.id DESC LIMIT 1`;
  const reportSnapshotId: string | null = report ? String(report.id) : null;
  return { body, reportSnapshotId };
}

const publishSessionRead = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:publishBrief.session",
  purpose: "Read the session and the close instant a window of the given length ends at, on the database clock.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `SELECT *, clock_timestamp() + make_interval(secs => $1) AS closes
                         FROM swarm_sessions WHERE id = $2`,
    params: [3600, SAMPLE_ID],
  },
});
const publishBriefUpsert = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/swarm/domain:publishBrief.upsert",
  purpose: "Write the session's brief, keeping an allocation an earlier body already carried.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_briefs (session_id, date, subject_id, body, report_snapshot_id)
              SELECT $1, $2::date, $3, $4::jsonb, $5::bigint WHERE false
              ON CONFLICT (session_id) DO UPDATE SET
                body = (EXCLUDED.body - 'allocation') || CASE WHEN swarm_briefs.body ? 'allocation' THEN jsonb_build_object('allocation', swarm_briefs.body->'allocation') ELSE '{}'::jsonb END,
                report_snapshot_id = EXCLUDED.report_snapshot_id`,
    params: [SAMPLE_ID, "2000-01-01", "probe", "{}", null],
  },
});
const publishOpenWindow = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:publishBrief.openWindow",
  purpose: "Open the session's window: collecting, with its advertised close and the instant the brief opened.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `UPDATE swarm_sessions SET state = 'collecting', window_closes_at = $1,
                    brief_opens_at = COALESCE(brief_opens_at, clock_timestamp())
              WHERE id = $2`,
    params: ["2000-01-01 00:00:00+00", SAMPLE_ID],
  },
});
export async function publishBrief(sessionId: string, windowMinutes = 60, prevOutcome?: string) {
  // The window's close is an instant the API stores, so it comes from the
  // database clock (scheduler spec §4.2: "The instants the API stores come from
  // the same clock"), never from this process's `Date.now()` — the take path
  // compares against it with `clock_timestamp()`, and two clocks would let the
  // advertised deadline and the enforced one disagree by the host's skew.
  const s = (await on(sql, publishSessionRead)<any>`SELECT *, clock_timestamp() + make_interval(secs => ${windowMinutes * 60}) AS closes
                         FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  const closes = new Date(s.closes);
  const windowClosesAt = closes.toISOString();
  const { body, reportSnapshotId } = await buildBriefBody(s, windowClosesAt, prevOutcome, sql);
  // Keyed on the SESSION (migration 0028), not the day. The old
  // `ON CONFLICT (date, subject_id)` made every session after the first of a
  // day overwrite its predecessor's brief — destroying the `windowClosesAt`
  // that session had already advertised to its members. Re-publishing the SAME
  // session still updates swarm_briefs (the current-view projection) in place
  // (the brief driver may retry), but a second session on the same day now
  // INSERTs its own row.
  //
  // ISSUE #978: every publish call also APPENDS a new, immutable
  // swarm_brief_revisions row via appendBriefRevision — never edits a prior
  // one — in the SAME transaction as the current-view update, so a failure
  // partway (see appendBriefRevision's header) leaves neither side changed.
  await sql.begin(async (tx) => {
    await appendBriefRevision(sessionId, body, reportSnapshotId, tx);
    await on(tx, publishBriefUpsert)`INSERT INTO swarm_briefs (session_id, date, subject_id, body, report_snapshot_id)
              VALUES (${sessionId}, ${s.date}, ${s.subject_id}, ${tx.json(jsonValue(body))}, ${reportSnapshotId}::bigint)
              ON CONFLICT (session_id) DO UPDATE SET
                body = (EXCLUDED.body - 'allocation') || CASE WHEN swarm_briefs.body ? 'allocation' THEN jsonb_build_object('allocation', swarm_briefs.body->'allocation') ELSE '{}'::jsonb END,
                report_snapshot_id = EXCLUDED.report_snapshot_id`;
    // `brief_opens_at` records that this session's brief opened AFTER it was
    // convened — the legacy two-step shape. The take path's roster gate and
    // pendingTakesFor treat only such a row as unrostered; an epoch never has
    // it (insertEpoch opens the window in the transaction that convenes).
    await on(tx, publishOpenWindow)`UPDATE swarm_sessions SET state = 'collecting', window_closes_at = ${closes},
                    brief_opens_at = COALESCE(brief_opens_at, clock_timestamp())
              WHERE id = ${sessionId}`;
  });
  return { sessionId, state: "collecting", windowClosesAt };
}

// ── Agent health (issue #208, scout #214) ───────────────────────────────────
// Append-only, redacted event log for two things that were previously visible
// only in an agent's own stdout: a roster member missing its expected
// submission window, and a rejected/tampered submission signature. `detail`
// must stay bounded and redacted — never the raw signature/public key/payload.
const healthRecord = registerQuery({
  role: "rm_app",
  object: "swarm_agent_health_events",
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/domain:recordAgentHealthEvent",
  purpose: "Record an agent-health event, once per (session, member) for an absence.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_agent_health_events (event_type, session_id, member_id, detail)
    SELECT $1, $2, $3, $4::jsonb WHERE false
    ON CONFLICT (session_id, member_id) WHERE event_type = 'absent' DO NOTHING`,
    params: ["absent", SAMPLE_ID, "probe", "{}"],
  },
});
async function recordAgentHealthEvent(
  eventType: "absent" | "rejected_signature",
  sessionId: string | null,
  memberId: string | null,
  detail: Record<string, unknown>,
  tx: DbHandle = sql,
): Promise<void> {
  await on(tx, healthRecord)`
    INSERT INTO swarm_agent_health_events (event_type, session_id, member_id, detail)
    VALUES (${eventType}, ${sessionId}, ${memberId}, ${tx.json(detail as any)})
    ON CONFLICT (session_id, member_id) WHERE event_type = 'absent' DO NOTHING`;
}

export interface AgentHealthFilter {
  sessionId?: string;
  memberId?: string;
  eventType?: "absent" | "rejected_signature";
  limit?: number;
}

// Admin-only projection (GET /api/swarm/admin/agent-health): raw event
// history plus per-type counts, with NO automatic dead-agent threshold — an
// operator reads the history and decides, nothing here pages/dead-letters an
// agent on its own.
const healthEvents = registerQuery({
  role: "rm_app",
  object: "swarm_agent_health_events",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getAgentHealthEvents.events",
  purpose: "List agent-health events under the session, member and type filters, newest first.",
  callers: [ADMIN_ROUTE, OVERVIEW_ROUTE],
  probe: {
    statement: `SELECT id, event_type, session_id, member_id, detail, created_at
    FROM swarm_agent_health_events
    WHERE ($1::text IS NULL OR session_id = $2)
      AND ($3::text IS NULL OR member_id = $4)
      AND ($5::text IS NULL OR event_type = $6)
    ORDER BY created_at DESC LIMIT $7`,
    params: [null, null, null, null, null, null, 1],
  },
});
const healthCounts = registerQuery({
  role: "rm_app",
  object: "swarm_agent_health_events",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getAgentHealthEvents.counts",
  purpose: "Count agent-health events by type under the same filters.",
  callers: [ADMIN_ROUTE, OVERVIEW_ROUTE],
  probe: {
    statement: `SELECT event_type, count(*)::int AS n FROM swarm_agent_health_events
    WHERE ($1::text IS NULL OR session_id = $2)
      AND ($3::text IS NULL OR member_id = $4)
      AND ($5::text IS NULL OR event_type = $6)
    GROUP BY event_type`,
    params: [null, null, null, null, null, null],
  },
});
export async function getAgentHealthEvents(filter: AgentHealthFilter = {}) {
  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 500) : 100;
  // Each filter is a NULL-guarded predicate of one fixed statement: an absent
  // filter binds NULL and passes every row.
  const sessionId = filter.sessionId || null;
  const memberId = filter.memberId || null;
  const eventType = filter.eventType || null;
  const rows = await on(sql, healthEvents)<any>`
    SELECT id, event_type, session_id, member_id, detail, created_at
    FROM swarm_agent_health_events
    WHERE (${sessionId}::text IS NULL OR session_id = ${sessionId})
      AND (${memberId}::text IS NULL OR member_id = ${memberId})
      AND (${eventType}::text IS NULL OR event_type = ${eventType})
    ORDER BY created_at DESC LIMIT ${limit}`;
  const countRows = await on(sql, healthCounts)<{ event_type: string; n: number }>`
    SELECT event_type, count(*)::int AS n FROM swarm_agent_health_events
    WHERE (${sessionId}::text IS NULL OR session_id = ${sessionId})
      AND (${memberId}::text IS NULL OR member_id = ${memberId})
      AND (${eventType}::text IS NULL OR event_type = ${eventType})
    GROUP BY event_type`;
  return {
    events: rows.map((r: any) => ({
      id: Number(r.id),
      eventType: r.event_type,
      sessionId: r.session_id,
      memberId: r.member_id,
      detail: r.detail,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    counts: Object.fromEntries(countRows.map((c) => [c.event_type, c.n])),
  };
}

const CLOSE_WINDOW_PROBE = {
    statement: `UPDATE swarm_sessions s
       SET state = 'window_closed',
           judge_mode = COALESCE((SELECT CASE WHEN c.mode = 'enforce' THEN 'enforce' ELSE 'off' END
                                    FROM swarm_judge_config c WHERE c.id = 1), 'off'),
           judging_duration_seconds = t.judging_duration_seconds
      FROM swarm_subjects t
     WHERE s.id = $1 AND s.state = 'collecting' AND t.id = s.subject_id
    RETURNING s.id`,
    params: [SAMPLE_ID],
  } as const;
const closeSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:closeWindow.sessions",
  purpose: "Close a collecting session's window, capturing the judge mode and judging duration onto it.",
  callers: [ADMIN_ROUTE],
  probe: CLOSE_WINDOW_PROBE,
});
const closeSubjects = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/domain:closeWindow.subjects",
  purpose: "Read the subject's judging duration to capture onto the closing session.",
  callers: [ADMIN_ROUTE],
  probe: CLOSE_WINDOW_PROBE,
});
const closeJudgeConfig = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  privileges: ["SELECT"],
  site: "src/swarm/domain:closeWindow.judgeConfig",
  purpose: "Read the judge mode to capture onto the closing session.",
  callers: [ADMIN_ROUTE],
  probe: CLOSE_WINDOW_PROBE,
});
export async function closeWindow(
  sessionId: string,
): Promise<{ sessionId: string; state: "window_closed"; telemetryWarnings?: string[] }> {
  // THE TRANSITION IS ITS OWN STATEMENT, NOT ONE TRANSACTION WITH THE
  // ABSENCE RECORD. It used to be `sql.begin` around both, which made a
  // failure in the telemetry inserts ROLL BACK the state change: the window
  // stayed open, the worker retried, and once the job exhausted its attempts
  // the session was stuck `collecting` forever — blocking every later
  // lifecycle step and every submission for its subject. The close is the
  // load-bearing write; the absence record is telemetry, and telemetry must
  // never be able to keep a window open. They are therefore decoupled: the
  // UPDATE below commits alone, and recordAbsenceEvents() runs afterwards,
  // its failures collected into the return value rather than thrown.
  //
  // THE CLOSE CAPTURES WHAT SETTLEMENT RUNS ON (§4.4, issue #1026). Turnover
  // (of an active or an inactive subject's window) stores the judge mode and judging duration in force as an
  // epoch closes; this close does the same, in the same statement, so no path
  // left in the code closes a session with nothing captured. Settlement
  // refuses an uncaptured session (`judging_not_captured`) rather than reading
  // the subject's live column later, when an admin may have changed it.
  const upd = await on(sql, closeSessions, closeSubjects, closeJudgeConfig)`
    UPDATE swarm_sessions s
       SET state = 'window_closed',
           -- currentJudgeMode()'s reduction, in SQL: anything but enforce is off.
           judge_mode = COALESCE((SELECT CASE WHEN c.mode = 'enforce' THEN 'enforce' ELSE 'off' END
                                    FROM swarm_judge_config c WHERE c.id = 1), 'off'),
           judging_duration_seconds = t.judging_duration_seconds
      FROM swarm_subjects t
     WHERE s.id = ${sessionId} AND s.state = 'collecting' AND t.id = s.subject_id
    RETURNING s.id`;
  if (upd.length === 0) return { sessionId, state: "window_closed" };
  const telemetryWarnings = await recordAbsenceEvents(sessionId);
  return telemetryWarnings.length
    ? { sessionId, state: "window_closed", telemetryWarnings }
    : { sessionId, state: "window_closed" };
}

// Materialize absence events for a session that JUST closed. Runs ONLY on a
// REAL collecting->window_closed transition (a re-close of an already-closed
// session is a no-op, and the unique partial index makes this safe even if a
// retried job races another). Only sessions with a FROZEN expected roster
// (swarm_session_members — the admin-created path, issue #150) have an
// authoritative absence denominator; the legacy/smoke openSession path (no
// roster rows) is unaffected, matching submitRecommendation/aggregateSession's
// existing roster-optional convention.
//
// NEVER THROWS. The close is already committed when this runs, so a failure
// here must not resurface as a failed/retried close_window job — that would
// re-run the transition UPDATE (a 0-row no-op) and settle the job `dead` for
// a session that is actually closed. Each member's event is recorded
// independently so one bad row cannot lose the rest; failures are returned as
// warnings and surfaced in the job's output by the worker handler.
/**
 * Record absences INSIDE the caller's transaction, judged against the session's
 * own `window_closes_at`.
 *
 * WHY THIS EXISTS BESIDE `recordAbsenceEvents` (issue #1026 W4.2/W4.3).
 * Scheduler spec §4.3 puts the absence record in the turnover TRANSACTION:
 * "closes it (`collecting → window_closed`, recording an `absent` event for
 * each seated member with no take received before `window_closes_at`)". The
 * function below deliberately does the opposite — it runs after the close has
 * committed and swallows its own failures — because on the cron-driven path a
 * telemetry failure that rolled back the close left a window open forever.
 *
 * That reasoning does not carry over, which is why the spec could reverse it.
 * A turnover is epoch-bound and state-guarded: if this throws, nothing
 * committed, the scheduler retries the whole call, and the retry either turns
 * over cleanly or replays. There is no stuck state to reach, so the stronger
 * guarantee — accepted takes and recorded absences can never disagree, spec
 * §4.2 — is available for free.
 *
 * THE INSTANT, NOT THE ROW'S EXISTENCE. A take is "received" only if its
 * `received_at` is at or before the advertised instant. Today the API refuses a
 * later submission outright (§4.2), so the two agree; asserting it here as well
 * means they cannot come apart if that ever changes.
 */
const ABSENCE_SUBMITTED_PROBE = {
    statement: `SELECT DISTINCT r.member_id
      FROM swarm_recommendations r
      JOIN swarm_sessions s ON s.id = r.session_id
     WHERE r.session_id = $1
       AND (s.window_closes_at IS NULL OR r.received_at <= s.window_closes_at)`,
    params: [SAMPLE_ID],
  } as const;
const absenceRoster = registerQuery({
  role: "rm_app",
  object: "swarm_session_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:recordAbsences.roster",
  purpose: "Read the session's roster, excluding the excused, to find who owed a take.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `SELECT member_id FROM swarm_session_members
     WHERE session_id = $1 AND status != 'excused'`,
    params: [SAMPLE_ID],
  },
});
const absenceTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:recordAbsences.submitted.takes",
  purpose: "Read who filed a take by the window's close.",
  callers: [ADMIN_ROUTE],
  probe: ABSENCE_SUBMITTED_PROBE,
});
const absenceSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:recordAbsences.submitted.sessions",
  purpose: "Read the session's close instant to judge each take against.",
  callers: [ADMIN_ROUTE],
  probe: ABSENCE_SUBMITTED_PROBE,
});
const absenceInsert = registerQuery({
  role: "rm_app",
  object: "swarm_agent_health_events",
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/domain:recordAbsencesTx.insert",
  purpose: "Record one absence event for a rostered member who filed nothing, once per (session, member).",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_agent_health_events (event_type, session_id, member_id, detail)
      SELECT 'absent', $1, $2, $3::jsonb WHERE false
      ON CONFLICT (session_id, member_id) WHERE event_type = 'absent' DO NOTHING`,
    params: [SAMPLE_ID, "probe", "{}"],
  },
});
export async function recordAbsencesTx(sessionId: string, tx: DbHandle): Promise<string[]> {
  const roster = await on(tx, absenceRoster)<{ member_id: string }>`
    SELECT member_id FROM swarm_session_members
     WHERE session_id = ${sessionId} AND status != 'excused'`;
  if (roster.length === 0) return [];
  const submitted = await on(tx, absenceTakes, absenceSessions)<{ member_id: string }>`
    SELECT DISTINCT r.member_id
      FROM swarm_recommendations r
      JOIN swarm_sessions s ON s.id = r.session_id
     WHERE r.session_id = ${sessionId}
       AND (s.window_closes_at IS NULL OR r.received_at <= s.window_closes_at)`;
  const submittedSet = new Set(submitted.map((r) => r.member_id));
  const absent = roster.map((r) => r.member_id).filter((id) => !submittedSet.has(id));
  for (const memberId of absent) {
    await on(tx, absenceInsert)`
      INSERT INTO swarm_agent_health_events (event_type, session_id, member_id, detail)
      VALUES ('absent', ${sessionId}, ${memberId}, ${tx.json({ reason: "missed submission window" } as any)})
      ON CONFLICT (session_id, member_id) WHERE event_type = 'absent' DO NOTHING`;
  }
  return absent;
}

async function recordAbsenceEvents(sessionId: string): Promise<string[]> {
  const warnings: string[] = [];
  let roster: { member_id: string }[];
  try {
    roster = await on(sql, absenceRoster)<{ member_id: string }>`
      SELECT member_id FROM swarm_session_members
      WHERE session_id = ${sessionId} AND status != 'excused'`;
  } catch (err) {
    return [`roster read failed after close: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (roster.length === 0) return warnings;
  let submitted: { member_id: string }[];
  try {
    submitted = await on(sql, absenceTakes, absenceSessions)<{ member_id: string }>`
      SELECT DISTINCT r.member_id
        FROM swarm_recommendations r
        JOIN swarm_sessions s ON s.id = r.session_id
       WHERE r.session_id = ${sessionId}
         AND (s.window_closes_at IS NULL OR r.received_at <= s.window_closes_at)`;
  } catch (err) {
    return [`submitted-take read failed after close: ${err instanceof Error ? err.message : String(err)}`];
  }
  const submittedSet = new Set(submitted.map((r) => r.member_id));
  for (const { member_id: memberId } of roster) {
    if (submittedSet.has(memberId)) continue;
    try {
      await recordAgentHealthEvent("absent", sessionId, memberId, { reason: "missed submission window" });
    } catch (err) {
      warnings.push(
        `absence event for ${memberId} not recorded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return warnings;
}

// Build the reference-shaped regime_summary object from the trailing regime
// snapshots. Kept separate so tests and aggregation share one code path.
//
// LIVE-PATH honesty (finding 009): this is the live aggregation path, so it
// never writes to regime_snapshots — stored labels are READ as-is (the
// classifier owns them) and classifyRegime is only a fallback for rows whose
// label is null. History is unpadded and emits only real points.
const regimeSummaryRead = registerQuery({
  role: "rm_app",
  object: "regime_snapshots",
  privileges: ["SELECT"],
  site: "src/swarm/domain:buildRegimeSummary",
  purpose: "Read the fourteen regime snapshots up to a date for a session's summary.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE],
  probe: {
    statement: `SELECT date, composite, composite_percentile, regime,
           macro_regime, onchain_regime, factor_regime,
           macro_index, onchain_index, factor_index,
           macro_percentile, onchain_percentile, factor_percentile
    FROM regime_snapshots
    WHERE date <= $1
    ORDER BY date DESC
    LIMIT 14`,
    params: ["2000-01-01"],
  },
});
export async function buildRegimeSummary(endDate: string, minPoints = 8): Promise<RegimeSummary> {
  const rows = await on(sql, regimeSummaryRead)<any>`
    SELECT date, composite, composite_percentile, regime,
           macro_regime, onchain_regime, factor_regime,
           macro_index, onchain_index, factor_index,
           macro_percentile, onchain_percentile, factor_percentile
    FROM regime_snapshots
    WHERE date <= ${endDate}
    ORDER BY date DESC
    LIMIT 14`;
  const chrono = rows.slice().reverse(); // chronological
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return typeof n === "number" && Number.isFinite(n) ? round(n) : null;
  };
  const history: RegimeSummary["history"] = chrono.map((r: any) => {
    const c = num(r.composite);
    return {
      date: typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10),
      composite: c,
      composite_percentile: num(r.composite_percentile),
      regime: (r.regime ?? (c != null ? classifyRegime(c) : "neutral")) as RegimeLabel,
      macro_percentile: num(r.macro_percentile),
      onchain_percentile: num(r.onchain_percentile),
      factor_percentile: num(r.factor_percentile),
    };
  });

  const latest = chrono[chrono.length - 1] as any;
  const lc = latest ? num(latest.composite) ?? 0.5 : 0.5;
  return {
    composite: round(lc),
    composite_percentile: num(latest?.composite_percentile),
    regime: (latest?.regime ?? classifyRegime(lc)) as RegimeLabel,
    macro_regime: (latest?.macro_regime ?? (num(latest?.macro_percentile ?? latest?.macro_index) != null ? classifyRegime(num(latest?.macro_percentile ?? latest?.macro_index)!) : "neutral")) as RegimeLabel,
    onchain_regime: (latest?.onchain_regime ?? (num(latest?.onchain_percentile ?? latest?.onchain_index) != null ? classifyRegime(num(latest?.onchain_percentile ?? latest?.onchain_index)!) : "neutral")) as RegimeLabel,
    factor_regime: (latest?.factor_regime ?? (num(latest?.factor_percentile ?? latest?.factor_index) != null ? classifyRegime(num(latest?.factor_percentile ?? latest?.factor_index)!) : "neutral")) as RegimeLabel,
    macro_percentile: num(latest?.macro_percentile),
    onchain_percentile: num(latest?.onchain_percentile),
    factor_percentile: num(latest?.factor_percentile),
    history,
    method: REGIME_METHOD.id,
  };
}


// Deterministic rollup over the takes ACTUALLY posted, ENRICHED into the
// reference session shape (regime_summary + rich swarm_recommendation +
// prose synthesis + subject snapshot total). Members with no take are recorded as
// absent — never fabricated. All enrichment is templated (NO LLM).
export function normalizedTakeWeights(value: unknown): { bucket: string; weight: number }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const entries: { bucket: string; weight: number }[] = [];
  let total = 0;
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const bucket = (candidate as { bucket?: unknown }).bucket;
    const weight = (candidate as { weight?: unknown }).weight;
    if (typeof bucket !== "string" || bucket.trim() === "" || seen.has(bucket) ||
        typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) return null;
    seen.add(bucket);
    entries.push({ bucket, weight });
    total += weight;
  }
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return entries.map(({ bucket, weight }) => ({ bucket, weight: weight / total }));
}

// THE derivation (issue #752). Project Fusion's rule is that MATH DECIDES AND
// THE JUDGE EXPLAINS: this function is the only thing in the system allowed to
// author a bucket weight. Nothing else may compute one, and no model may
// suggest one — see swarm/judge.ts, which rejects a model response carrying a
// weight-like field rather than merging it.
//
// That makes the published vector reproducible by anyone holding the frozen
// take set, which is the strongest property available for an artifact
// governance acts on. Its properties are pinned by
// backend/tests/swarm-consensus-weights.test.ts (per-member vectors are
// normalized before averaging; the result always sums to exactly 1, including
// single-member and near-tie cases), and its uniqueness by that file's
// no-reimplementation guard.
export function meanTakeWeights(takes: any[]): { bucket: string; weight: number }[] | undefined {
  const normalized = takes
    .map((take) => normalizedTakeWeights(take.payload?.weights))
    .filter((weights): weights is { bucket: string; weight: number }[] => weights !== null);
  if (normalized.length === 0) return undefined;

  const totals = new Map<string, number>();
  for (const weights of normalized) {
    for (const { bucket, weight } of weights) totals.set(bucket, (totals.get(bucket) ?? 0) + weight);
  }
  const averaged = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, total]) => ({ bucket, weight: total / normalized.length }));
  const averageTotal = averaged.reduce((sum, entry) => sum + entry.weight, 0);
  const result = averaged.map(({ bucket, weight }) => ({ bucket, weight: round(weight / averageTotal, 8) }));
  const finalIndex = result.length - 1;
  const prefixTotal = result.slice(0, finalIndex).reduce((sum, entry) => sum + entry.weight, 0);
  result[finalIndex].weight = round(1 - prefixTotal, 8);
  return result;
}

// ── Deterministic aggregation prose (issue #323, NO LLM) ────────────────────
// rationale / synthesis / consensus / disagreement topic+what_settles must each
// carry genuinely distinct content. Pre-#323 they were built by concatenating
// or re-quoting member take bodies, which made rationale and synthesis
// byte-identical and blew consensus/disagreement entries out to full take
// bodies — the frontend's synthesisIsEcho()/consensusItems()/isEcho() exist
// only to hide that duplication. The functions below never read a take's
// `body` string; they derive short, true statements from the takes'
// STRUCTURED data (stance, confidence, quorum, regime), so nothing here can
// echo a take and nothing here invents a fact the data doesn't support.
function stanceBreakdown(byStance: Record<string, number>): string {
  return Object.entries(byStance)
    .sort((a, b) => b[1] - a[1] || (STANCES as readonly string[]).indexOf(a[0]) - (STANCES as readonly string[]).indexOf(b[0]))
    .map(([stance, count]) => `${count} ${stance}`)
    .join(", ");
}

// TIES BREAK ON THE LADDER, NOT ON KEY ORDER (issue #752). This used to be a
// plain `reduce` over Object.entries(), which on a tie returned whichever stance
// happened to come FIRST in the object — i.e. the order takes were received in.
// That made the rationale a function of arrival order, and worse, of the
// ROUND TRIP: postgres reorders jsonb keys, so re-deriving prose from a stored
// `swarm_recommendation.stances` could name a different majority than the
// aggregation that wrote it. The judge's template fallback — deleted since
// (D-A7, and outright by D53) — re-derived exactly that way, so "the fallback
// is byte-identical to today's prose" was true only until two stances tied.
// Historical `source='fallback'` judgement rows were written under that rule,
// which is why the ladder audit below still has something to find.
//
// The tie-break is the same one stanceBreakdown() already sorts on — the
// canonical ascending STANCES ladder, lowest index first — so the two lines of
// prose can never disagree about which stance led.
//
// Exported since #766: `listRationaleLadderDrift()` in judge-replay.ts has to
// re-elect the majority for an ALREADY-PUBLISHED session to enumerate the set
// D42 promises to report. Re-implementing the ladder there would give the
// enumeration its own chance to disagree with the rule it is auditing against.
export function ordinal(n: number): string {
  const v = Math.abs(Math.round(n)) % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (v % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function majorityStance(byStance: Record<string, number>): { stance: string; count: number } | null {
  const entries = Object.entries(byStance);
  if (!entries.length) return null;
  const rank = (stance: string) => {
    const i = (STANCES as readonly string[]).indexOf(stance);
    return i < 0 ? STANCES.length : i;
  };
  const [stance, count] = entries.reduce((best, cur) =>
    cur[1] > best[1] || (cur[1] === best[1] && rank(cur[0]) < rank(best[0])) ? cur : best);
  return { stance, count };
}

// Discrete, one-line points of agreement: quorum, stance split, mean
// confidence, and (when available) the regime backdrop. Always true of the
// data actually submitted; never exceeds a sentence, never a take body.
export function buildConsensus(
  active: number, submitted: number, participation: number,
  byStance: Record<string, number>, meanConfidence: number | null,
  regimeSummary: { composite_percentile?: number | null; regime?: string } | null,
): string[] {
  if (submitted === 0) return [];
  const points: string[] = [`${submitted} of ${active} members submitted (${Math.round(participation * 100)}% participation).`];
  const breakdown = stanceBreakdown(byStance);
  if (breakdown) points.push(`Stance split: ${breakdown}.`);
  if (meanConfidence != null) points.push(`Mean confidence ${meanConfidence.toFixed(2)} across submitted takes.`);
  if (regimeSummary?.composite_percentile != null) {
    points.push(`Regime composite at the ${ordinal(Math.round(regimeSummary.composite_percentile * 100))} percentile (${regimeSummary.regime ?? "unclassified"}).`);
  }
  return points;
}

// Recommendation-voiced "why": leads with the majority stance actually
// submitted. Deliberately a different shape from buildSynthesis() below so
// the two can never collide (cheap check: rationale !== synthesis).
export function buildRationale(
  subjectLabel: string, byStance: Record<string, number>, submitted: number,
  meanConfidence: number | null, regimeSummary: { composite_percentile?: number | null } | null,
): string {
  const majority = majorityStance(byStance);
  const parts: string[] = [];
  if (majority) parts.push(`Majority stance is ${majority.stance} (${majority.count} of ${submitted} submitted takes)`);
  if (meanConfidence != null) parts.push(`mean confidence ${meanConfidence.toFixed(2)}`);
  if (regimeSummary?.composite_percentile != null) parts.push(`regime composite at the ${ordinal(Math.round(regimeSummary.composite_percentile * 100))} percentile`);
  return `${parts.length ? parts.join(", ") : "No stance data available"} on ${subjectLabel}.`;
}

// Session-voiced narrative: participation + stance shape + whether a
// disagreement was recorded, so it reads as an overview rather than a
// restatement of buildRationale()'s recommendation-specific reasoning.
export function buildSynthesis(
  subjectLabel: string, active: number, submitted: number, participation: number,
  byStance: Record<string, number>, disagreementTopic?: string,
): string {
  const breakdown = stanceBreakdown(byStance);
  const tail = disagreementTopic
    ? ` The swarm is split: ${disagreementTopic}.`
    : " No material disagreement was recorded among submitted takes.";
  return `${submitted} of ${active} members (${Math.round(participation * 100)}% participation) reviewed ${subjectLabel}. Stance split: ${breakdown}.${tail}`;
}

// Disagreements: synthesize from the stance spread. When at least two distinct
// stances were submitted, contrast the most- and least-constructive members.
// The ascending ladder is the canonical contract vocabulary (finding 027).
// `topic` names the actual stances in conflict (not a generic placeholder)
// and `what_settles` is an objective, trackable test rather than "" (#323).
//
// Exported since #752, when this was one of the four template producers the
// judge fell back to when a model was unavailable or answered badly. That
// fallback is deleted (D53 point 4): the judge refuses instead, and this is
// now only the aggregator's own deterministic prose.
export function buildDisagreements(subjectLabel: string, authoredTakes: any[]): any[] {
  const rank = (st: string) => { const i = (STANCES as readonly string[]).indexOf(st); return i < 0 ? 2 : i; };
  const sortedTakes = authoredTakes.slice().sort((a: any, b: any) => rank(a.stance) - rank(b.stance));
  const disagreements: any[] = [];
  if (sortedTakes.length >= 2 && new Set(sortedTakes.map((t: any) => t.stance)).size >= 2) {
    const low = sortedTakes[0], high = sortedTakes[sortedTakes.length - 1];
    disagreements.push({
      topic: `${high.stance} vs ${low.stance} stance on ${subjectLabel}`,
      positions: [
        { member_id: high.member_id, view: high.body },
        { member_id: low.member_id, view: low.body },
      ],
      what_settles: `Whether the next regime snapshot's composite percentile moves toward the ${high.stance} or the ${low.stance} read for ${subjectLabel}.`,
    });
  }
  return disagreements;
}

// THE frozen take set (issue #752). Extracted verbatim out of
// aggregateSession() so the judge and the aggregator cannot read two different
// sets: `inputsDigest` on a judgement is a claim about "exactly what this
// opinion was derived from" (issue #765), and that claim is only worth anything
// if the take set it digests is the same object the weight vector was derived
// from. One function, one query, both callers.
export interface FrozenTakeSet {
  session: Record<string, any>;
  takes: any[];
  activeMembers: { id: string }[];
  /** true when the session carries a roster snapshot (i.e. not the legacy/smoke path). */
  rosterFrozen: boolean;
}

const FROZEN_TAKES_PROBE = {
    statement: `SELECT r.member_id, r.stance, r.confidence, r.body, r.payload, r.revision,
           r.signature, r.nonce,
           r.received_at, COALESCE(sm.member_name, m.name) AS member_name
      FROM swarm_recommendations r
      JOIN swarm_members m ON m.id = r.member_id
      LEFT JOIN swarm_session_members sm
        ON sm.session_id = r.session_id AND sm.member_id = r.member_id
     WHERE r.session_id = $1 AND r.final
     ORDER BY r.received_at`,
    params: [SAMPLE_ID],
  } as const;
const frozenSession = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:loadFrozenTakeSet.session",
  purpose: "Read the session whose takes are frozen for aggregation or judging.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE, SWARM_ROUTE],
  probe: { statement: "SELECT * FROM swarm_sessions WHERE id = $1", params: [SAMPLE_ID] },
});
const frozenTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:loadFrozenTakeSet.takes.takes",
  purpose: "Read the session's final takes, one per member (D51).",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE, SWARM_ROUTE],
  probe: FROZEN_TAKES_PROBE,
});
const frozenTakeMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:loadFrozenTakeSet.takes.members",
  purpose: "Require each take's member and read its current name.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE, SWARM_ROUTE],
  probe: FROZEN_TAKES_PROBE,
});
const frozenTakeSeats = registerQuery({
  role: "rm_app",
  object: "swarm_session_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:loadFrozenTakeSet.takes.seats",
  purpose: "Prefer the name the member's seat froze onto the session.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE, SWARM_ROUTE],
  probe: FROZEN_TAKES_PROBE,
});
const frozenRosterRead = registerQuery({
  role: "rm_app",
  object: "swarm_session_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:loadFrozenTakeSet.roster",
  purpose: "Read the session's frozen roster, excluding the excused.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE, SWARM_ROUTE],
  probe: {
    statement: "SELECT member_id AS id FROM swarm_session_members WHERE session_id = $1 AND status != 'excused'",
    params: [SAMPLE_ID],
  },
});
const frozenActive = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:loadFrozenTakeSet.active",
  purpose: "For a session with no roster, count every active member as expected.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE, SWARM_ROUTE],
  probe: { statement: "SELECT id FROM swarm_members WHERE status = 'active'" },
});
export async function loadFrozenTakeSet(sessionId: string, h: DbHandle = sql): Promise<FrozenTakeSet | null> {
  const s = (await on(h, frozenSession)<any>`SELECT * FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  if (!s) return null;
  // THE FINAL TAKE PER MEMBER (D51), for the same reason as withTakes above
  // and one more that is specific to this function: aggregation copies take
  // prose VERBATIM into `swarm_recommendation.disagreements[].positions[].view`.
  // A superseded body reaching that snapshot would publish, permanently, a
  // sentence the member has already withdrawn. The set is selected on the
  // flag, never by ordering on `revision`: the flag is what the accepting
  // transaction set, and migration 0075's partial unique index makes it one row
  // per member, so the aggregator, the judge's digest and the receipt all read
  // the one take per member that counts.
  // The outer `ORDER BY received_at` is the ordering this query has always had
  // and the tie-break the disagreement ladder below sorts on top of; only the
  // row SET changes here.
  // THE NAME IS THE FROZEN ONE, NOT THE LIVE ONE (issue #765). `member_name`
  // rides into the judge's `inputs_digest`, and migration 0032's header names a
  // handle/name correction as normal permitted operation — so reading
  // `swarm_members.name` live meant a rename MOVED the digest of an unchanged
  // take set, which is a digest binding a fact the opinion was not derived
  // from. `swarm_session_members.member_name` is the snapshot insertEpoch
  // froze at seating time and is `NOT NULL`,
  // so the COALESCE falls through only for a session with NO roster snapshot at
  // all — the legacy/smoke `openSession` path, whose behaviour is unchanged,
  // exactly as the `rosterRows.length > 0` fallback below leaves it.
  //
  // SIGNATURE AND NONCE ride along for issue #754, and it is the SAME argument
  // #765 makes, pointed the other way. The consensus receipt embeds each
  // contributing analyst's signature and the exact bytes it covers, and it must
  // do so over THE SAME frozen set the judge and the aggregator read — a second
  // query for the signatures would be a second take set, and the judgement's
  // inputs_digest would then attest to one while the receipt carried the other.
  // #765 makes the name inside that one set frozen; this makes the signature
  // part of it. Both are needed: a receipt whose signatures came from a
  // different read, or a digest that moves when nobody amended a take, breaks
  // the same binding from opposite ends.
  //
  // THESE TWO COLUMNS CANNOT FAN THE RESULT OUT. Both are plain columns of
  // `swarm_recommendations r` — the table the `r.final` filter already drives,
  // one row per member — so they add no join and no row. The cardinality argument is
  // entirely #765's `LEFT JOIN`, which matches at most once because
  // `swarm_session_members` is `PRIMARY KEY (session_id, member_id)` and the
  // join pins both halves of that key.
  const takeRows = await on(h, frozenTakes, frozenTakeMembers, frozenTakeSeats)<any>`
    SELECT r.member_id, r.stance, r.confidence, r.body, r.payload, r.revision,
           r.signature, r.nonce,
           r.received_at, COALESCE(sm.member_name, m.name) AS member_name
      FROM swarm_recommendations r
      JOIN swarm_members m ON m.id = r.member_id
      LEFT JOIN swarm_session_members sm
        ON sm.session_id = r.session_id AND sm.member_id = r.member_id
     WHERE r.session_id = ${sessionId} AND r.final
     ORDER BY r.received_at`;
  // Denominator (issue #152, AC6): prefer the session's FROZEN roster
  // (swarm_session_members, non-excused rows) over live swarm_members
  // so a member added/removed AFTER the session was created never rewrites an
  // already-scheduled session's quorum math. Falls back to live active
  // members when the session has no roster snapshot at all (the legacy/smoke
  // openSession path) — this keeps the pre-#152 smoke/worker behavior
  // unchanged.
  const rosterRows = await on(h, frozenRosterRead)<{ id: string }>`
    SELECT member_id AS id FROM swarm_session_members WHERE session_id = ${sessionId} AND status != 'excused'`;
  const activeMembers = rosterRows.length > 0
    ? rosterRows
    : (await on(h, frozenActive)`SELECT id FROM swarm_members WHERE status = 'active'`) as unknown as { id: string }[];
  const frozenRoster = new Set(activeMembers.map((member: any) => member.id));
  const takes = rosterRows.length > 0
    ? takeRows.filter((take: any) => frozenRoster.has(take.member_id))
    : takeRows;
  return { session: s as Record<string, any>, takes: takes as any[], activeMembers, rosterFrozen: rosterRows.length > 0 };
}

/**
 * The judge's input, built from a frozen take set the CALLER already loaded.
 *
 * Every NUMBER on it comes off the session row the aggregator already wrote.
 * Nothing here recomputes a rollup: if the judge and the aggregator could
 * disagree about the quorum, the prose would describe a session that does not
 * exist.
 *
 * ONE LOAD, EVERY USE. The judge subscription serves this object to the judge
 * (`pendingJudgingFor`), `submitJudgement` rebuilds it to check the digest the
 * judge signed, the consensus receipt (issue #754) rebuilds it over the exact
 * set it is about to embed, and `judge-replay.ts` (issue #766) over the set it
 * re-derives the vector from. Each passes the set it loaded, because a second
 * `loadFrozenTakeSet` would digest whatever that one returned — a different set
 * whenever a take lands between the two reads, which is exactly the divergence
 * those comparisons exist to detect.
 *
 * Lives here, beside `loadFrozenTakeSet`, since the inline judge's session
 * module was deleted (issue #1026, D53).
 */
const judgeInputBrief = registerQuery({
  role: "rm_app",
  object: "swarm_briefs",
  privileges: ["SELECT"],
  site: "src/swarm/domain:judgeInputFromFrozen.brief",
  purpose: "Read the session's brief body the judge is shown.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE],
  probe: { statement: "SELECT body FROM swarm_briefs WHERE session_id = $1", params: [SAMPLE_ID] },
});
export async function judgeInputFromFrozen(
  frozen: FrozenTakeSet,
  minTakes: number,
  h: DbHandle = sql,
): Promise<JudgeInput> {
  const s = frozen.session;
  const sessionId = String(s.id);
  const [briefRow] = await on(h, judgeInputBrief)<{ body: unknown }>`SELECT body FROM swarm_briefs WHERE session_id = ${sessionId}`;
  const rec = (s.swarm_recommendation ?? {}) as Record<string, unknown>;
  const takes: JudgeTake[] = frozen.takes.map((t: any) => ({
    member_id: String(t.member_id),
    member_name: t.member_name == null ? null : String(t.member_name),
    revision: takeRevision(t.revision),
    stance: String(t.stance ?? ""),
    confidence: t.confidence == null ? null : Number(t.confidence),
    body: typeof t.body === "string" ? t.body : "",
    // The member's own proposed weights, off their take payload — evidence of
    // what that member meant, never the session's answer.
    ["weights"]: Array.isArray(t.payload?.["weights"]) ? t.payload["weights"] : null,
  }));
  const date = s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);
  return {
    sessionId,
    date,
    subjectId: String(s.subject_id),
    subjectLabel: s.subject_name ?? String(s.subject_id),
    brief: briefRow?.body ?? null,
    takes,
    minTakes,
    byStance: (rec.stances as Record<string, number>) ?? {},
    meanConfidence: typeof rec.meanConfidence === "number" ? rec.meanConfidence : null,
    regimeSummary: (s.regime_summary as { composite_percentile?: number } | null) ?? null,
  };
}

// THE ROLLUP, AND NO STATE OPINION (issue #806). This function REPLACES
// `swarm_recommendation` wholesale — the judge's `rationale`, `disagreements`,
// `release_safety` and `judge` fingerprint do not survive it — and it deliberately
// does not decide whether that is allowed. Its two callers own that:
// `aggregateSessionAdmin` (and therefore the admin dispatcher and the epoch
// settlement chain, which both go through it) puts it behind `guardedTransition`,
// so `judged -> aggregated` and anything out of a terminal state are refused.
// Do NOT call it from a new site without a guard in front of it.
//
// The SANCTIONED re-aggregation of a judged session — `judged -> window_closed
// -> aggregated`, two deliberate admin actions — still drops the judge's prose,
// by design: the aggregator owns the recommendation. That loss is not silent;
// `getSessionJudgementsAdmin` reconciles every judgement row against
// `swarm_recommendation->'judge'` and reports the opinion as SUPERSEDED rather
// than "applied to the session".
const aggSnapshot = registerQuery({
  role: "rm_app",
  object: "swarm_subject_snapshots",
  privileges: ["SELECT"],
  site: "src/swarm/domain:aggregateSession.snapshot",
  purpose: "Read the subject's newest snapshot total to stamp on the aggregated session.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE],
  probe: {
    statement: `SELECT total_value_usd FROM swarm_subject_snapshots
    WHERE subject_id = $1 ORDER BY date DESC LIMIT 1`,
    params: ["probe"],
  },
});
const aggSubject = registerQuery({
  role: "rm_app",
  object: "swarm_subjects",
  privileges: ["SELECT"],
  site: "src/swarm/domain:aggregateSession.subject",
  purpose: "Read the subject's recommendation type, which decides whether weights are averaged.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE],
  probe: { statement: "SELECT recommendation_type FROM swarm_subjects WHERE id = $1", params: ["probe"] },
});
const aggUpdate = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:aggregateSession.update",
  purpose: "Write the aggregated recommendation onto the session and move it to aggregated.",
  callers: [ADMIN_ROUTE, JUDGE_ROUTE],
  probe: {
    statement: `UPDATE swarm_sessions SET
      state = 'aggregated',
      swarm_recommendation = $1::jsonb,
      synthesis = $2,
      regime_summary = $3::jsonb,
      subject_snapshot_total_value_usd = $4
    WHERE id = $5`,
    params: ["{}", null, "{}", null, SAMPLE_ID],
  },
});
export async function aggregateSession(sessionId: string) {
  const frozen = await loadFrozenTakeSet(sessionId);
  if (!frozen) throw new Error(`aggregateSession: no such session ${sessionId}`);
  const { session: s, takes, activeMembers } = frozen;
  const submitted = new Set(takes.map((t: any) => t.member_id));
  const absent = activeMembers.map((m: any) => m.id).filter((id: string) => !submitted.has(id));
  // QUORUM COUNTS MEMBERS, NOT ROWS (issue #573). Every figure below that used
  // to read `takes.length` now reads `submittedCount`. The query above already
  // returns one row per member, so today the two are equal — and that is
  // precisely why this must be written in terms of DISTINCT MEMBERS rather than
  // rows: `takes.length` was only ever correct because a schema constraint made
  // it so, and migration 0028 removed that constraint. A latest-per-member
  // regression anywhere upstream would otherwise reappear here as a
  // participation figure above 100%, published, in the session snapshot.
  // Pinned by backend/tests/swarm-take-revisions.test.ts.
  const submittedCount = submitted.size;

  const byStance: Record<string, number> = {};
  const citedSignals: Record<string, number> = {};
  let confSum = 0;
  for (const t of takes) {
    byStance[t.stance] = (byStance[t.stance] ?? 0) + 1;
    confSum += Number(t.confidence ?? 0);
    const cites = t.payload?.cites;
    if (Array.isArray(cites)) {
      for (const cite of cites) {
        if (typeof cite === "string") {
          citedSignals[cite] = (citedSignals[cite] ?? 0) + 1;
        }
      }
    }
  }
  const participation = activeMembers.length ? submittedCount / activeMembers.length : 0;
  const meanConfidence = submittedCount ? confSum / submittedCount : null;

  const sessionDate = typeof s.date === "string" ? s.date : new Date(s.date).toISOString().slice(0, 10);
  const regimeSummary = await buildRegimeSummary(sessionDate);

  // Latest subject snapshot total (drives the session header figure).
  const snapRow = (await on(sql, aggSnapshot)<any>`
    SELECT total_value_usd FROM swarm_subject_snapshots
    WHERE subject_id = ${s.subject_id} ORDER BY date DESC LIMIT 1`)[0] as { total_value_usd: unknown } | undefined;
  const subjectTotal = snapRow?.total_value_usd == null ? null : Number(snapRow.total_value_usd);

  // Rich recommendation: KEEP the deterministic rollup fields (the frontend reads
  // quorum/stances as a "rollup") AND add the reference rich fields so consensus /
  // disagreements / actions render. Type comes from the subject.
  const subjectRow = (await on(sql, aggSubject)`SELECT recommendation_type FROM swarm_subjects WHERE id = ${s.subject_id}`)[0] as { recommendation_type?: string } | undefined;
  const recType = subjectRow?.recommendation_type === "bucket_weights" ? "bucket_weights" : "position_actions";

  const authoredTakes = takes.filter((take: any) => typeof take.body === "string" && take.body.trim().length > 0);
  const subjectLabel = s.subject_name ?? s.subject_id;

  // Consensus: discrete one-line points derived from quorum/stance/confidence/
  // regime data — never a take body (issue #323).
  const consensus = buildConsensus(activeMembers.length, submittedCount, participation, byStance, meanConfidence, regimeSummary);

  // Disagreements: synthesize from the stance spread (see buildDisagreements).
  const disagreements: any[] = buildDisagreements(subjectLabel, authoredTakes);

  // rationale (recommendation-voiced "why") and synthesis (session-voiced
  // narrative) are built by two different functions so they can never be
  // byte-identical (#323 cheap check). Both stay absent/null when no member
  // authored a body — same gate as before, no editorial prose is invented
  // when there is nothing to report on.
  const rationale = authoredTakes.length
    ? buildRationale(subjectLabel, byStance, submittedCount, meanConfidence, regimeSummary)
    : undefined;
  // NO HARDCODED ACTIONS (issue #752). Until #745 this branch emitted two
  // literal USDC/rmUSDC entries — a rotate and an add, with rationales naming a
  // 5% floor — that were derived from NO member input whatsoever. They rendered
  // as though the swarm had recommended them, and they were on course to be
  // signed into a consensus receipt as though the swarm had recommended them.
  // A `position_actions` session now emits no `actions` array at all rather
  // than a fabricated one; when real per-token actions exist they will be
  // derived from the takes, like the weight vector is.
  // Pinned by backend/tests/swarm-judge.test.ts.
  const weights = recType === "bucket_weights" ? meanTakeWeights(takes) : undefined;

  const quorum = { active: activeMembers.length, submitted: submittedCount, absent: absent.length, participation };
  const rec: Record<string, unknown> = {
    quorum,
    stances: byStance,
    meanConfidence,
    absent,
    type: recType,
    consensus,
    disagreements,
    citedSignals,
  };
  if (rationale) rec.rationale = rationale;
  if (weights) rec.weights = weights;

  const synthesis = authoredTakes.length
    ? buildSynthesis(subjectLabel, activeMembers.length, submittedCount, participation, byStance, disagreements[0]?.topic)
    : null;

  await on(sql, aggUpdate)`UPDATE swarm_sessions SET
      state = 'aggregated',
      swarm_recommendation = ${sql.json(rec as any)},
      synthesis = ${synthesis},
      regime_summary = ${sql.json(regimeSummary as any)},
      subject_snapshot_total_value_usd = ${subjectTotal}
    WHERE id = ${sessionId}`;
  // Named rollup fields (quorum/stances/meanConfidence/absent) are kept explicit
  // on the return so existing consumers (src/smoke/e2e.ts) stay typed; the rich
  // fields ride along too.
  return {
    sessionId, state: "aggregated",
    quorum, stances: byStance, meanConfidence, absent,
    regimeSummary, subjectSnapshotTotalValueUsd: subjectTotal,
    type: recType, rationale, consensus, disagreements, weights,
  };
}

/**
 * Publish a session — GUARDED (T21), like the admin path it sits beside.
 *
 * WHAT IT WAS. A bare `UPDATE … SET state='published', published_at=now()
 * WHERE id=$1`, with no state guard and no `published_at IS NULL` guard, while
 * `publishSessionAdmin` has both plus a `guardedTransition` that refuses
 * terminal states and writes session-event and audit rows. Two consequences,
 * both reachable from an ordinary retry of the publish step:
 *
 *   * every retry RE-STAMPED `published_at`, so the recorded publication
 *     instant drifted and `swarm/receipt-gap.ts`'s alert named a time the
 *     session did not publish at;
 *   * an operator who CANCELLED a session inside the retry window had it
 *     silently flipped back to `published` — no transition, no event row, no
 *     audit row, from a state the lifecycle calls terminal.
 *
 * WHAT IT IS NOW. The same single statement, with the admin path's two guards:
 * it fires only from a publishable state and stamps `published_at` once. It
 * stays a single statement rather than becoming `guardedTransition` because the
 * direct publish route (api/routes/swarm.ts) and the audited admin transition
 * are kept separate, as they were when the retired swarm queue handler was
 * this function's caller, and it reports whether it actually transitioned
 * so a caller can tell an effective publish from a no-op instead of reading
 * "published" either way.
 */
const PUBLISHABLE_STATES = ["aggregated", "judged"] as const;

const publishTransition = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:publishSession.transition",
  purpose: "Publish a session that is aggregated or judged, once.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `UPDATE swarm_sessions
       SET state = 'published',
           published_at = COALESCE(published_at, now()),
           version = version + 1
     WHERE id = $1
       AND state = ANY($2::text[])
    RETURNING id, state`,
    params: [SAMPLE_ID, "{aggregated,judged}"],
  },
});
const publishCurrent = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:publishSession.current",
  purpose: "Read the session's state to answer a publish that did not transition.",
  callers: [ADMIN_ROUTE],
  probe: { statement: "SELECT state FROM swarm_sessions WHERE id = $1", params: [SAMPLE_ID] },
});
export async function publishSession(sessionId: string) {
  const rows = await on(sql, publishTransition)<any>`
    UPDATE swarm_sessions
       SET state = 'published',
           published_at = COALESCE(published_at, now()),
           version = version + 1
     WHERE id = ${sessionId}
       AND state = ANY(${[...PUBLISHABLE_STATES]})
    RETURNING id, state`;
  if (rows.length > 0) return { sessionId, state: "published", transitioned: true };
  // Nothing transitioned: either the session is ALREADY published (an ordinary
  // job redelivery — idempotent success, and `published_at` is untouched) or it
  // is somewhere this call may not publish from, which is reported as the
  // state it is actually in rather than as a publication that did not happen.
  const current = (await on(sql, publishCurrent)`SELECT state FROM swarm_sessions WHERE id = ${sessionId}`)[0] as
    | { state: string }
    | undefined;
  return { sessionId, state: current?.state ?? "unknown", transitioned: false };
}

// ── Memos ───────────────────────────────────────────────────────────────────
const memoInsert = registerQuery({
  role: "rm_app",
  object: "swarm_memos",
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/domain:postMemo",
  purpose: "File a memo from a member against a session.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_memos (member_id, session_id, title, body)
    SELECT $1, $2, $3, $4 WHERE false
    RETURNING id`,
    params: ["probe", SAMPLE_ID, "probe", "probe"],
  },
});
export async function postMemo(token: string, input: { sessionId: string; title?: string; body: string }) {
  const memberId = await memberIdForToken(token);
  if (!memberId) return { ok: false, status: 401, error: "unknown member token" };
  const rows = await on(sql, memoInsert)<any>`
    INSERT INTO swarm_memos (member_id, session_id, title, body)
    VALUES (${memberId}, ${input.sessionId}, ${input.title ?? ""}, ${input.body})
    RETURNING id`;
  const id = rows[0].id;
  return { ok: true, status: 201, id, url: routePath(ROUTES.swarm.memo, { id }) };
}

const memoRead = registerQuery({
  role: "rm_app",
  object: "swarm_memos",
  privileges: ["SELECT"],
  site: "src/swarm/domain:getMemo",
  purpose: "Read one memo by id.",
  callers: [SWARM_ROUTE, RECEIPTS_ROUTE],
  probe: {
    statement: `SELECT id, member_id, session_id, title, body, created_at
                       FROM swarm_memos WHERE id = $1`,
    params: [1],
  },
});
export async function getMemo(id: number) {
  const r = (await on(sql, memoRead)<any>`SELECT id, member_id, session_id, title, body, created_at
                       FROM swarm_memos WHERE id = ${id}`)[0] ?? null;
  if (!r) return null;
  return toMemo(r);
}

// ── Self-service profile (issue #325) ───────────────────────────────────────
// The apply payload (§11 R6, D21) is deliberately minimal —
// {name, contact, lens?, publicKey} — so an API-created member is admitted
// with no tagline/mandate/biases/voice/mode/operator/avatar and no route ever
// gives it one; only the three manifest-seeded members carry real values for
// these. This is the fill-in-after-admission route the issue recommends
// (option B over extending apply): the same actor as submitRecommendation/
// postMemo (bearer-token authenticated, so only a member that has completed
// apply → activate → claim can call it), writing its OWN row only — the path
// :id must match the token's member id, exactly like submitRecommendation's
// memberId/token check. Partial: only fields present in `patch` are changed;
// omitted fields are left untouched (not nulled).
export interface MemberProfilePatch {
  tagline?: string;
  mandate?: string;
  biases?: string[];
  voiceMd?: string;
  mode?: string;
  operator?: string;
  avatar?: unknown;
}

const PROFILE_PROBE = {
    statement: `UPDATE swarm_members m SET
      tagline = $1, mandate = $2, biases = $3::jsonb,
      voice_md = $4, mode = $5, operator = $6,
      avatar = $7::jsonb, updated_at = now()
    FROM (
      SELECT max(received_at) AS last_take_at
        FROM swarm_recommendations
       WHERE member_id = $8
    ) t
    WHERE m.id = $9
    RETURNING m.*, t.last_take_at`,
    params: [null, null, "[]", null, null, null, "{}", "probe", "probe"],
  } as const;
const profileMember = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:updateMemberProfile.member",
  purpose: "Update the member's own profile fields.",
  callers: [SWARM_ROUTE],
  probe: PROFILE_PROBE,
});
const profileTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:updateMemberProfile.takes",
  purpose: "Return the member's newest take instant with the updated row.",
  callers: [SWARM_ROUTE],
  probe: PROFILE_PROBE,
});
const profileAudit = registerQuery({
  role: "rm_app",
  object: "audit_log",
  privileges: ["INSERT"],
  site: "src/swarm/domain:updateMemberProfile.audit",
  purpose: "Record a profile update in the audit log.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: "INSERT INTO audit_log (actor, action, scope) SELECT $1, 'update_profile', $2::jsonb WHERE false",
    params: ["probe", "{}"],
  },
});
export async function updateMemberProfile(token: string, memberRef: string, patch: MemberProfilePatch) {
  const tokenMemberId = await memberIdForToken(token);
  if (!tokenMemberId) return { ok: false, status: 401, error: "unknown member token" };

  // The path segment is a PUBLIC reference (issue #593): a member that reads
  // its own handle off /api/swarm/members must be able to post its profile back
  // to the same URL. Resolve it to the immutable id FIRST, then compare — the
  // token still authorises exactly one row, so this widens what a member may
  // call itself, never whose profile it may write.
  //
  // Through the SHARED resolver (issue #597), not a second inline copy of the
  // same predicate. The raw row is what this needs: the merge below reads
  // tagline/mandate/biases/voice_md/mode/operator/avatar off it, which the
  // SwarmMember projection renames and partly drops. Authorization is unchanged
  // — it still compares the token against `row.id`, the immutable key.
  const row = await resolveMemberRow(memberRef);
  if (!row) return { ok: false, status: 404, error: "member not found" };
  const memberId = row.id as string;
  if (tokenMemberId !== memberId) return { ok: false, status: 403, error: "token/member mismatch" };

  // THE IN-HOUSE OPERATOR IS RESERVED, HERE AND NOT ONLY IN THE ROUTE (D52,
  // issue #925). The judge's third-party gate is keyed on `operator`
  // (`submitJudgement`, smoke-production-spec.md §6.2), so a member that could
  // write `robotmoney` into its own row could judge while third-party judging
  // is off — the #925 forgery. The route's validator refuses the literal too,
  // but this function is the writer, and a rule that lives only in one caller
  // is one new caller away from gone. Only admin paths and the in-house roster
  // seed may set it.
  if (patch.operator !== undefined && typeof patch.operator === "string" &&
      patch.operator.trim().toLowerCase() === IN_HOUSE_OPERATOR) {
    return { ok: false, status: 403, error: "operator_reserved: 'robotmoney' is set only by an admin" };
  }

  const merged = {
    tagline: patch.tagline !== undefined ? patch.tagline : row.tagline,
    mandate: patch.mandate !== undefined ? patch.mandate : row.mandate,
    biases: patch.biases !== undefined ? patch.biases : row.biases,
    voice_md: patch.voiceMd !== undefined ? patch.voiceMd : row.voice_md,
    mode: patch.mode !== undefined ? patch.mode : row.mode,
    operator: patch.operator !== undefined ? patch.operator : row.operator,
    avatar: patch.avatar !== undefined ? patch.avatar : row.avatar,
  };
  // Issue #782 follow-up: RETURNING * only ever sees swarm_members columns, so
  // without this FROM-subquery join the response's lastTakeAt was silently
  // always null (see resolveMemberRow's note above — this RETURNING row, not
  // that resolver's, is what toMember() below actually serializes).
  const updated = await on(sql, profileMember, profileTakes)<any>`
    UPDATE swarm_members m SET
      tagline = ${merged.tagline}, mandate = ${merged.mandate}, biases = ${sql.json(merged.biases as any)},
      voice_md = ${merged.voice_md}, mode = ${merged.mode}, operator = ${merged.operator},
      avatar = ${sql.json(merged.avatar as any)}, updated_at = now()
    FROM (
      SELECT max(received_at) AS last_take_at
        FROM swarm_recommendations
       WHERE member_id = ${memberId}
    ) t
    WHERE m.id = ${memberId}
    RETURNING m.*, t.last_take_at`;
  // Issue #925: name the changed fields, matching admin.ts's updateMemberAdminTx
  // audit style. Previously this logged only `{ memberId }` — an admin
  // investigating a suspected self-service forgery after the fact had no
  // record of which field, if any, had ever held a different value.
  await on(sql, profileAudit)`INSERT INTO audit_log (actor, action, scope) VALUES (${memberId}, 'update_profile', ${sql.json({ memberId, fields: Object.keys(patch) } as any)})`;
  return { ok: true, status: 200, member: toMember(updated[0]) };
}

// The event log, the epoch lifecycle and the scheduler's full read are in
// ./epoch.ts, where every statement is registered (D55 (13), spec §7.1). They
// are re-exported here, so a caller that imports them from this module is
// unchanged. What follows serves that log to a subscriber, and the judge's
// subscription; its own statements are still raw (this module is on the
// allowlist in tests/db-registry.test.ts until they are converted).

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — the subscription itself
// ─────────────────────────────────────────────────────────────────────────────
//
// THERE ARE NO JOB PUSHES. §6.3 as amended on 2026-09-24 (D52): "The stream
// carries change events only. Every piece of work the scheduler does follows
// from an event or a timer; there is no ad-hoc job kind for the API to push,
// ack or redeliver." The job ledger, its push/ack functions, the `job` frame
// and the ack route were deleted with migration 0079, which drops the table.

/**
 * How a connection behaves. Every value is a default a test may shorten; NONE
 * of them is a scheduling parameter, and none is read from the environment.
 */
export interface StreamOptions {
  /**
   * How often a keepalive goes out when nothing else has (§6.3's "The
   * keepalive carries the head sequence"), and how often the token is
   * re-authorized against the store, busy or quiet. The keepalive is the only
   * thing that can reveal the loss of the last event before a quiet period.
   */
  keepaliveMs?: number;
  /**
   * How often this CONNECTION looks for events above what it has sent.
   *
   * This is the API serving an open subscription, which §6.3 names as one of
   * the API's "only stream duties". Nothing runs when nobody is connected, and
   * the SCHEDULER's no-polling rule (§9) is about the scheduler, which makes no
   * call at all while this loop runs.
   */
  pollMs?: number;
  /**
   * The bound on this socket's outbound backlog, in bytes (D55 (11): "The API
   * watches the socket's outbound buffered amount. When a subscriber stops
   * reading and that backlog passes its bound, the API sends one `resync`
   * frame and closes the socket. It never drops an event to make room.").
   *
   * Checked before every frame, against what the socket itself reports as
   * queued and not yet written. The sink also reports backpressure on the send
   * that crosses the server's own limit; either one ends the connection the
   * same way. Unlike the SSE body this replaced, which `Bun.serve` drained into
   * its own unbounded buffer whatever the peer did, a WebSocket reports its
   * backlog, so a stalled subscriber is told why before it is closed.
   */
  bufferBytes?: number;
  /**
   * Re-checked every `keepaliveMs` whatever the connection is sending — events
   * do not postpone it. Resolving false (or failing) closes the socket with
   * `SCHEDULER_STREAM_CLOSE.tokenRevoked`: a bearer that was rotated or revoked
   * after the connection opened must not keep reading the stream for the life
   * of the socket, and a busy stream must not keep it reading either.
   */
  stillAuthorized?: () => Promise<boolean>;
  /**
   * Called exactly once, when the connection's loop has stopped, with why it
   * stopped: a resync reason, `unauthorized`, or `cancelled` (the peer or the
   * server closed the socket). For tests and diagnostics; it decides nothing.
   */
  onEnd?: (why: ResyncReason | "unauthorized" | "cancelled") => void;
}

/**
 * The keepalive interval. The WebSocket's own ping/pong is the transport
 * keepalive (§6.3 "Silent failure detection"); this frame is the application's
 * and carries the head, which a ping cannot.
 */
const STREAM_DEFAULTS = { keepaliveMs: 5_000, pollMs: 500, bufferBytes: 1024 * 1024 } as const;

/**
 * The close codes the scheduler stream ends with (D55 (11): "an explicit close
 * code"). Private-use codes (4000-4999, RFC 6455 §7.4.2), declared again,
 * field for field, in scripts/lib/system-scheduler/types.ts;
 * scripts/tests/unit/system-scheduler-wire-parity.test.ts holds the two to
 * each other. Every one of them means the same thing to the scheduler — the
 * copy is no longer provably current, so full read and rebuild (§3.1) — and
 * the code says why, so an operator reading a log can tell a stalled reader
 * from a rotated token.
 */
export const SCHEDULER_STREAM_CLOSE = {
  /** Sent after the one `resync` frame: the API cannot serve from where the subscriber stands. */
  resync: 4000,
  /** The token was revoked or rotated while the socket was open; no frame precedes it. */
  tokenRevoked: 4001,
} as const;

/** One frame on the socket, as JSON text. The `type` field is the discriminant the scheduler reads. */
export type StreamServeFrame =
  | ({ type: "event" } & ServedStreamEvent)
  | { type: "keepalive"; head: number }
  | { type: "resync"; reason: ResyncReason; head: number | null };

/**
 * What the serving loop writes to: one WebSocket, seen through the three
 * things the loop needs from it. backend/src/api/routes/swarm-stream.ts adapts
 * Bun's ServerWebSocket to this; a test may hand in its own.
 */
export interface StreamSink {
  /**
   * Send one text frame. `sent` — written or queued within the server's
   * limit; `backpressure` — queued, but the socket's backlog is past the
   * server's limit (Bun's `send` returning -1); `closed` — dropped because the
   * connection is gone (Bun's 0).
   */
  send(text: string): "sent" | "backpressure" | "closed";
  /** Bytes queued on this socket and not yet written to the peer. */
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

/** A running subscription. `stop` is what the socket's close handler calls. */
export interface SchedulerStreamHandle {
  stop(): void;
  /** Resolves when the loop has ended, whoever ended it. */
  readonly done: Promise<void>;
}

/**
 * Serve the §6.3 stream from `cursor` onto one socket.
 *
 * The shape of the connection, in order:
 *
 *   1. If the cursor cannot be served (above the head, below the retained
 *      floor, or the database cannot say), ONE resync frame and a close. Not an
 *      empty stream, and not a skip forward to the head.
 *   2. Events above the cursor, in order, for as long as the socket lives.
 *      Each served event must be the one after the last sent; an event missing
 *      from the middle (pruned while the socket was open) is a resync and a
 *      close, never a jump.
 *   3. A keepalive carrying the head sequence whenever the keepalive interval
 *      passes with nothing else sent.
 *   4. The token re-checked every keepalive interval, busy or quiet; a token
 *      that no longer authorizes ends the socket with its own close code.
 *   5. Before every frame, the socket's outbound backlog against
 *      `bufferBytes`; past it — or on a send the server itself reports as
 *      backpressured — one resync frame (`buffer_overflow`) and a close. The
 *      frames already queued stay queued, so the subscriber reads a gapless
 *      prefix, then the reason, then the close: nothing is dropped from the
 *      middle to make room.
 *
 * NO STATE IS EVER CLAIMED FROM A FAILED READ. A database error while reading
 * events or the head ends the socket with `resync: unavailable`; it never reads
 * as "no new events" or as a stale head, either of which would tell the
 * subscriber it is current when nothing proves it.
 *
 * THE LOOP DIES WITH THE SOCKET. `stop` flips the flag the loop reads, so a
 * disconnected subscriber leaves nothing running — which is the difference
 * between serving a connection and being a background process.
 */
export function serveSchedulerStream(cursor: number, sink: StreamSink, opts: StreamOptions = {}): SchedulerStreamHandle {
  const keepaliveMs = opts.keepaliveMs ?? STREAM_DEFAULTS.keepaliveMs;
  const pollMs = opts.pollMs ?? STREAM_DEFAULTS.pollMs;
  const bufferBytes = opts.bufferBytes ?? STREAM_DEFAULTS.bufferBytes;
  let live = true;
  // Why the connection stopped, reported once through `onEnd`. The first
  // cause recorded wins: a resync closes the socket, whose close handler then
  // calls `stop`.
  let endedBy: ResyncReason | "unauthorized" | "cancelled" | null = null;
  const ended = (why: ResyncReason | "unauthorized" | "cancelled"): void => {
    endedBy ??= why;
  };
  const close = (code: number, reason: string): void => {
    live = false;
    try {
      sink.close(code, reason);
    } catch {
      /* already closed by the peer */
    }
  };
  const write = (f: StreamServeFrame): "sent" | "backpressure" | "closed" => {
    try {
      return sink.send(JSON.stringify(f));
    } catch {
      return "closed";
    }
  };
  // The last frame a connection ever sends: the reason, then the close.
  const resyncAndClose = (reason: ResyncReason, head: number | null): void => {
    ended(reason);
    if (live) write({ type: "resync", reason, head });
    close(SCHEDULER_STREAM_CLOSE.resync, `resync: ${reason}`);
  };
  const headOrNull = async (): Promise<number | null> => {
    try {
      return await streamHeadSequence();
    } catch {
      return null;
    }
  };
  /**
   * Send one frame, or end the connection when the socket's backlog is past
   * its bound. The resync that replaces the frame is the ONLY thing written
   * past the bound.
   */
  const send = async (f: StreamServeFrame): Promise<boolean> => {
    if (!live) return false;
    if (sink.bufferedAmount() > bufferBytes) {
      resyncAndClose("buffer_overflow", await headOrNull());
      return false;
    }
    const r = write(f);
    if (r === "closed") {
      ended("cancelled");
      live = false;
      return false;
    }
    if (r === "backpressure") {
      // The frame was queued, so it is not lost; nothing may follow it but
      // the reason.
      resyncAndClose("buffer_overflow", await headOrNull());
      return false;
    }
    return live;
  };

  const run = async (): Promise<void> => {
    let reason: ResyncReason | null;
    try {
      reason = await resyncReasonFor(cursor);
    } catch {
      resyncAndClose("unavailable", null);
      return;
    }
    if (reason) {
      resyncAndClose(reason, await headOrNull());
      return;
    }

    let sent = cursor;
    let lastFrameAt = Date.now();
    let lastAuthAt = Date.now();
    while (live) {
      // The token is re-checked on its own clock. It used to ride the
      // keepalive, which only goes out when a poll finds nothing, so a rotated
      // token kept reading for as long as events kept flowing.
      if (opts.stillAuthorized && Date.now() - lastAuthAt >= keepaliveMs) {
        if (!(await opts.stillAuthorized().catch(() => false))) {
          ended("unauthorized");
          close(SCHEDULER_STREAM_CLOSE.tokenRevoked, "token revoked or rotated");
          break;
        }
        lastAuthAt = Date.now();
      }
      if (!live) break;
      let events: ServedStreamEvent[];
      try {
        events = await eventsAbove(sent);
      } catch {
        resyncAndClose("unavailable", null);
        break;
      }
      for (const e of events) {
        if (e.seq !== sent + 1) {
          // The next number this subscriber needs is not in the log any
          // more: pruned between two polls. Serving `e` would skip it.
          resyncAndClose("log_truncated", await headOrNull());
          break;
        }
        if (!(await send({ type: "event", ...e }))) break;
        sent = e.seq;
      }
      if (!live) break;
      if (events.length > 0) lastFrameAt = Date.now();
      else if (Date.now() - lastFrameAt >= keepaliveMs) {
        // §6.3: "Each keepalive from the API includes the sequence number of
        // the last event it committed." The HEAD of the log, not `sent` —
        // the whole point is that a subscriber behind the head can tell. A
        // head that cannot be read is not replaced by a guess.
        const head = await headOrNull();
        if (head === null) {
          resyncAndClose("unavailable", null);
          break;
        }
        if (!(await send({ type: "keepalive", head }))) break;
        lastFrameAt = Date.now();
      }
      if (!live) break;
      await Bun.sleep(pollMs);
    }
  };

  const done = run()
    .catch(() => {
      if (live) resyncAndClose("unavailable", null);
    })
    .finally(() => {
      live = false;
      try {
        opts.onEnd?.(endedBy ?? "cancelled");
      } catch {
        /* a diagnostic hook never breaks the connection */
      }
    });

  return {
    stop() {
      ended("cancelled");
      live = false;
    },
    done,
  };
}


/** One outstanding judging request, as served to the judge that owes it. */
export interface PendingJudging {
  sessionId: string;
  subjectId: string;
  date: string;
  /** The API's STORED deadline. Informational for the judge: it finalizes nothing (§6.2). */
  judgingDeadlineAt: string;
  judgingRequestedAt: string | null;
  /**
   * EXACTLY what the judge is to read: the session's frozen take set, its
   * brief and its rollup facts, as `judgeInputFromFrozen` builds them.
   *
   * Served rather than left for the judge to assemble from the public read
   * API, because the judgement's `inputsDigest` is a claim about this object
   * and the API recomputes it at submission. A judge that rebuilt its input
   * from some other read would sign a digest over a set nobody else can
   * reproduce, and its judgement would be refused as stale.
   */
  input: JudgeInput;
}

/**
 * Every session in `judging` this judge has not submitted for, and may.
 *
 * "on every connect or reconnect the API serves every session in `judging`
 * for which this judge has not yet submitted, so a judge that was down when
 * the request was created still obtains it if it returns before the deadline"
 * (§6.2).
 *
 * THE FILTER IS PER JUDGE, not per session. `swarm_session_judgements`
 * carries `judged_by_member_id` (migration 0043), so one judge submitting does
 * not clear the work of another.
 *
 * A SESSION THIS JUDGE HAS A TAKE IN IS NOT ITS WORK. Scheduler spec §4.4: an
 * eligible judgement is signed by a judge "that has no take in that session".
 * Serving it would only hand the judge a model call whose answer is refused.
 *
 * THE DEADLINE IS NOT FILTERED ON. A session past its deadline that the
 * scheduler has not finalized yet is still in `judging`; a judgement that lands
 * in that window is kept as evidence (`after_deadline`) and decides nothing,
 * by the STORED instants alone (§4.4). Hiding it here would be this module
 * deciding an outcome, which is exactly what §6.2 says the judge never does.
 *
 * THE THIRD-PARTY GATE IS APPLIED HERE TOO (§6.2, D52). While
 * `third_party_enabled` is false, a judge whose member operator is not the
 * in-house literal is served NOTHING: its submission would be refused with
 * `third_party_judging_disabled`, so serving it work would only buy a paid
 * model call whose answer cannot land. The predicate is the one
 * `submitJudgement` applies inside its transaction and the judge-of-record
 * query uses; that later check stays authoritative, because the flag can flip
 * while the model is thinking.
 */
const PENDING_JUDGING_PROBE = {
    statement: `SELECT s.id, s.subject_id, s.date, s.judging_deadline_at, s.judging_requested_at
      FROM swarm_sessions s
     WHERE s.state = 'judging'
       AND EXISTS (
         SELECT 1 FROM swarm_members m
          WHERE m.id = $1
            AND (m.operator = $2
                 OR COALESCE((SELECT c.third_party_enabled FROM swarm_judge_config c WHERE c.id = 1), false)))
       AND NOT EXISTS (
         SELECT 1 FROM swarm_session_judgements j
          WHERE j.session_id = s.id AND j.judged_by_member_id = $3)
       AND NOT EXISTS (
         SELECT 1 FROM swarm_recommendations r
          WHERE r.session_id = s.id AND r.member_id = $4)
     ORDER BY s.judging_deadline_at`,
    params: ["probe", "robotmoney", "probe", "probe"],
  } as const;
const pendingJudgingSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:pendingJudgingFor.sessions",
  purpose: "List the sessions in judging that a judge member has not yet judged.",
  callers: [JUDGE_ROUTE],
  probe: PENDING_JUDGING_PROBE,
});
const pendingJudgingMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:pendingJudgingFor.members",
  purpose: "Apply the third-party gate to the polling member: in-house, or third-party judging enabled.",
  callers: [JUDGE_ROUTE],
  probe: PENDING_JUDGING_PROBE,
});
const pendingJudgingConfig = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  privileges: ["SELECT"],
  site: "src/swarm/domain:pendingJudgingFor.config",
  purpose: "Read whether third-party judging is enabled.",
  callers: [JUDGE_ROUTE],
  probe: PENDING_JUDGING_PROBE,
});
const pendingJudgingJudgements = registerQuery({
  role: "rm_app",
  object: "swarm_session_judgements",
  privileges: ["SELECT"],
  site: "src/swarm/domain:pendingJudgingFor.judgements",
  purpose: "Skip a session the member already judged.",
  callers: [JUDGE_ROUTE],
  probe: PENDING_JUDGING_PROBE,
});
const pendingJudgingTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:pendingJudgingFor.takes",
  purpose: "Skip a session the member took a position in: a judge cannot judge its own take.",
  callers: [JUDGE_ROUTE],
  probe: PENDING_JUDGING_PROBE,
});
export async function pendingJudgingFor(memberId: string): Promise<PendingJudging[]> {
  const rows = await on(sql, pendingJudgingSessions, pendingJudgingMembers, pendingJudgingConfig, pendingJudgingJudgements, pendingJudgingTakes)<
    { id: string; subject_id: string; date: Date | string; judging_deadline_at: Date; judging_requested_at: Date | null }
  >`
    SELECT s.id, s.subject_id, s.date, s.judging_deadline_at, s.judging_requested_at
      FROM swarm_sessions s
     WHERE s.state = 'judging'
       AND EXISTS (
         SELECT 1 FROM swarm_members m
          WHERE m.id = ${memberId}
            AND (m.operator = ${IN_HOUSE_OPERATOR}
                 OR COALESCE((SELECT c.third_party_enabled FROM swarm_judge_config c WHERE c.id = 1), false)))
       AND NOT EXISTS (
         SELECT 1 FROM swarm_session_judgements j
          WHERE j.session_id = s.id AND j.judged_by_member_id = ${memberId})
       AND NOT EXISTS (
         SELECT 1 FROM swarm_recommendations r
          WHERE r.session_id = s.id AND r.member_id = ${memberId})
     ORDER BY s.judging_deadline_at`;
  const minTakes = await judgeMinTakes(sql);
  const pending: PendingJudging[] = [];
  for (const r of rows) {
    const frozen = await loadFrozenTakeSet(String(r.id));
    if (!frozen) continue;
    pending.push({
      sessionId: String(r.id),
      subjectId: r.subject_id,
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      judgingDeadlineAt: new Date(r.judging_deadline_at).toISOString(),
      judgingRequestedAt: r.judging_requested_at ? new Date(r.judging_requested_at).toISOString() : null,
      input: await judgeInputFromFrozen(frozen, minTakes),
    });
  }
  return pending;
}

/**
 * The release-safety threshold a judgement is formed against.
 *
 * Read off the config row in the caller's handle, so the submission path reads
 * it inside the same transaction as the third-party flag beside it.
 */
const judgeMinTakesRead = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  privileges: ["SELECT"],
  site: "src/swarm/domain:judgeMinTakes",
  purpose: "Read the release-safety threshold a judgement is formed against.",
  callers: [JUDGE_ROUTE, ADMIN_ROUTE],
  probe: { statement: "SELECT min_takes FROM swarm_judge_config WHERE id = 1" },
});
async function judgeMinTakes(h: DbHandle): Promise<number> {
  const [cfg] = await on(h, judgeMinTakesRead)<{ min_takes: number }>`SELECT min_takes FROM swarm_judge_config WHERE id = 1`;
  return Number(cfg?.min_takes ?? 3);
}

/**
 * A judge's submission, as it arrives over the participant route.
 *
 * Every field but `sessionId` is covered by `signature`, over the bytes
 * `canonicalizeJudgement` (@robotmoney/contract) produces with the member's
 * id added. `opinion` is the model's RAW answer text; the API parses it.
 */
export interface JudgementSubmission {
  sessionId: string;
  opinion: unknown;
  model?: unknown;
  promptHash?: unknown;
  inputsDigest?: unknown;
  nonce?: unknown;
  signature?: unknown;
  /**
   * What the model call cost, as the participant measured it (D55 decision 3,
   * R19): `{ inputTokens?, outputTokens?, totalTokens?, costUsd? }`. Optional;
   * absent stores NULL in every spend column. NOT covered by `signature`: it is
   * spend accounting about the call, not part of what the judge attests.
   */
  usage?: unknown;
}

/** A judgement's validated spend, one field per `usage_*` column (migration 0059). */
export interface JudgementUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

// THE BOUNDS ARE SANITY, NOT BUDGET. The token columns are `integer`, and no
// single judging call comes near ten million tokens; the cost column is
// `numeric(18, 8)`, and no single call costs ten thousand dollars. A value past
// either is a participant bug or a hostile client, and it is refused rather
// than stored as the session's spend.
const USAGE_MAX_TOKENS = 10_000_000;
const USAGE_MAX_COST_USD = 10_000;
const USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const;

/**
 * Validate a judgement's `usage` block (D55 decision 3).
 *
 * Absent (`undefined` or `null`) is valid and means "not reported": every
 * column stays NULL, never 0, because a zero would claim the call was free.
 * Present, it must be an object naming only the four fields; each field is
 * absent/null or a finite, non-negative, bounded number, and the token counts
 * are whole. Anything else refuses the WHOLE judgement with
 * `usage_malformed:<field>` — a judgement is one record, and storing it with
 * its spend silently dropped would make R19's total quietly wrong.
 */
export function parseJudgementUsage(
  raw: unknown,
): { ok: true; usage: JudgementUsage | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, usage: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "usage_malformed:not_an_object" };
  const record = raw as Record<string, unknown>;
  const unknownField = Object.keys(record).find((k) => !(USAGE_FIELDS as readonly string[]).includes(k));
  if (unknownField) return { ok: false, error: `usage_malformed:unknown_field:${unknownField.slice(0, 40)}` };
  const usage: JudgementUsage = { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null };
  for (const field of USAGE_FIELDS) {
    const v = record[field];
    if (v === undefined || v === null) continue;
    const isTokens = field !== "costUsd";
    const max = isTokens ? USAGE_MAX_TOKENS : USAGE_MAX_COST_USD;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max || (isTokens && !Number.isInteger(v))) {
      return { ok: false, error: `usage_malformed:${field}` };
    }
    usage[field] = v;
  }
  return { ok: true, usage };
}

export type SubmitJudgementResult =
  | {
      ok: true;
      status: number;
      sessionId: string;
      judgementId: number;
      state: string;
      recordedAt: string;
      /** The judgement landed after the session was published: kept, decides nothing (§4.4). */
      lateEvidence: boolean;
      /** This judge had already submitted for this session; the original row is returned. */
      duplicate: boolean;
      /** This judge is the session's judge of record, so its judgement is the consensus (§4.4). */
      judgeOfRecord: boolean;
      /** The opinion reached the session's own record, which is what a receipt embeds. */
      applied: boolean;
    }
  | { ok: false; status: number; error: string };

const refuseSubmission = (status: number, error: string): SubmitJudgementResult => ({ ok: false, status, error });

/** The operator literal that marks an in-house member (smoke-production-spec.md §6.2). */
export const IN_HOUSE_OPERATOR = "robotmoney";

/** The raw answer a judge may submit. Far above any real answer; a bound, not a budget. */
const MAX_JUDGEMENT_CHARS = 100_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const boundedText = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null;

/**
 * Is this member an ACTIVE judge?
 *
 * The participant router's coarse gate before it opens a subscription or
 * parses a judgement: a member that is not an active judge has nothing to be
 * served and nothing it may submit. It is not the eligibility decision — that
 * is `judgeOfRecordTx`, inside the transaction that writes, because a judge can
 * be revoked while its model is thinking.
 *
 * Exported so the participant router holds no statement of its own: §7.1 wants
 * database access in one place, and a role check spelled out in a route file is
 * a second place it can drift.
 */
const judgeMemberRole = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:isJudgeMember",
  purpose: "Read a member's role and status, to check it is an active judge.",
  callers: [JUDGE_ROUTE],
  probe: { statement: "SELECT role, status FROM swarm_members WHERE id = $1", params: ["probe"] },
});
export async function isJudgeMember(memberId: string): Promise<boolean> {
  const [member] = await on(sql, judgeMemberRole)<{ role: string; status: string }>`
    SELECT role, status FROM swarm_members WHERE id = ${memberId}`;
  return member?.role === "judge" && member.status === "active";
}

/**
 * The session's judge of record, by member id (§4.4), or null when no judge is
 * eligible.
 *
 * Eligible means: an ACTIVE member holding the `judge` role, with NO take in
 * this session, that passes the third-party gate of smoke-production-spec.md
 * §6.2 (its operator is the in-house literal, or `third_party_enabled` is on).
 * Among the eligible, the lowest member id — never the first to answer, so no
 * judgement is selected by being fastest.
 *
 * THE ONE DEFINITION. `submitJudgement` decides whether a judgement is applied
 * with it, and `recordJudgingConsensusTx` refuses any consensus not authored by
 * it. Two copies of this query would be two chances to disagree about which
 * judgement is the session's consensus.
 */
const JUDGE_OF_RECORD_PROBE = {
    statement: `SELECT m.id FROM swarm_members m
     WHERE m.role = 'judge' AND m.status = 'active'
       AND (m.operator = $1
            OR COALESCE((SELECT c.third_party_enabled FROM swarm_judge_config c WHERE c.id = 1), false))
       AND NOT EXISTS (SELECT 1 FROM swarm_recommendations r
                        WHERE r.session_id = $2 AND r.member_id = m.id)
     ORDER BY m.id LIMIT 1`,
    params: ["robotmoney", SAMPLE_ID],
  } as const;
const judgeOfRecordMembers = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/swarm/domain:judgeOfRecordTx.members",
  purpose: "Find the eligible judges: active, role judge, passing the third-party gate.",
  callers: [JUDGE_ROUTE, ADMIN_ROUTE],
  probe: JUDGE_OF_RECORD_PROBE,
});
const judgeOfRecordConfig = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  privileges: ["SELECT"],
  site: "src/swarm/domain:judgeOfRecordTx.config",
  purpose: "Read whether third-party judging is enabled.",
  callers: [JUDGE_ROUTE, ADMIN_ROUTE],
  probe: JUDGE_OF_RECORD_PROBE,
});
const judgeOfRecordTakes = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:judgeOfRecordTx.takes",
  purpose: "Exclude a judge that took a position in the session.",
  callers: [JUDGE_ROUTE, ADMIN_ROUTE],
  probe: JUDGE_OF_RECORD_PROBE,
});
export async function judgeOfRecordTx(tx: DbHandle, sessionId: string): Promise<string | null> {
  const [row] = await on(tx, judgeOfRecordMembers, judgeOfRecordConfig, judgeOfRecordTakes)<{ id: string }>`
    SELECT m.id FROM swarm_members m
     WHERE m.role = 'judge' AND m.status = 'active'
       AND (m.operator = ${IN_HOUSE_OPERATOR}
            OR COALESCE((SELECT c.third_party_enabled FROM swarm_judge_config c WHERE c.id = 1), false))
       AND NOT EXISTS (SELECT 1 FROM swarm_recommendations r
                        WHERE r.session_id = ${sessionId} AND r.member_id = m.id)
     ORDER BY m.id LIMIT 1`;
  return row?.id ?? null;
}

/**
 * A judge participant submitting its judgement, signed with its own key.
 *
 * AUTHORITY: smoke-production-spec.md §6.2 ("The judge is a participant exactly
 * like an agent", "Third-party gate"), system-scheduler-spec.md §4.4 ("The
 * judge of record", "A consensus that lands after the session is already
 * `published` is recorded as late evidence").
 *
 * THE ORDER IS THE CONTRACT. Refusals first, cheapest first, and every one of
 * them BEFORE any row is written:
 *
 *   1. The bearer is an active member's (`memberIdForToken`), and that member
 *      is a judge.
 *   2. The submission is well-formed, and its Ed25519 signature verifies
 *      against the member's ACTIVE key over the canonical judgement bytes —
 *      the same key lookup and the same fail-closed verification a take gets.
 *   3. Inside one transaction, holding the session row: judging was actually
 *      requested for this session (`session_not_judging` otherwise — a
 *      `collecting` or `aggregated` session, or one published under `off`,
 *      never had a judge to hear from); the judge is still active and still a
 *      judge; it passes the third-party gate, keyed on its member `operator`;
 *      it has no take in the session.
 *   4. The frozen take set it claims to have read is the one on file
 *      (`inputs_digest_mismatch` otherwise), and there is something in it to
 *      judge.
 *   5. The model's answer parses — `parseJudgeResponse`, which rejects a
 *      weight-like field anywhere in it WHOLE, refuses a dissenter who took no
 *      part, and fills every quoted view from the member's own body.
 *
 * Only then is the row written, and in the SAME transaction: if this judge is
 * the session's judge of record, the session is still `judging` and its
 * deadline has not passed by the database clock, its opinion is applied to the
 * session's record and the consensus is recorded with its acceptance instant
 * (`recordJudgingConsensusTx`). Any other eligible judgement is recorded as
 * evidence and changes no outcome: a second seated judge's, one that lands
 * after the deadline but before finalize (`after_deadline`), or one that lands
 * after publication (`lateEvidence`).
 *
 * THE JUDGE OF RECORD IS CHOSEN BY MEMBER ID, never by arrival (§4.4): the
 * lowest id among the active judges that pass the gate and hold no take in the
 * session. Today one judge is seated, so it is that judge.
 *
 * NOTHING HERE CAN SUPPLY AN OPINION. A refusal writes nothing and substitutes
 * nothing; the session then reaches its deadline and publishes `no_consensus`.
 */
const sessionForJudgement = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:submitJudgement.session",
  purpose: "Lock the session the judgement is filed against, reading its state, mode and deadline.",
  callers: [JUDGE_ROUTE],
  probe: {
    statement: `SELECT id, state, judge_mode, judging_deadline_at, consensus_recorded_at
        FROM swarm_sessions WHERE id = $1 FOR UPDATE`,
    params: [SAMPLE_ID],
  },
});
const judgeExisting = registerQuery({
  role: "rm_app",
  object: "swarm_session_judgements",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitJudgement.existing",
  purpose: "Find the judgement this member already filed for the session, so a retry returns it.",
  callers: [JUDGE_ROUTE],
  probe: {
    statement: `SELECT id, applied, applied_skipped_reason, created_at FROM swarm_session_judgements
       WHERE session_id = $1 AND judged_by_member_id = $2
       ORDER BY id LIMIT 1`,
    params: [SAMPLE_ID, "probe"],
  },
});
const judgeMember = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:submitJudgement.member",
  purpose: "Hold the judge's member row FOR SHARE while its status, role and operator are checked.",
  callers: [JUDGE_ROUTE],
  probe: { statement: "SELECT status, role, operator FROM swarm_members WHERE id = $1 FOR SHARE", params: ["probe"] },
});
const judgeConfig = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitJudgement.config",
  purpose: "Read the third-party flag and the release-safety threshold inside the submission transaction.",
  callers: [JUDGE_ROUTE],
  probe: { statement: "SELECT third_party_enabled, min_takes FROM swarm_judge_config WHERE id = 1" },
});
const judgeTake = registerQuery({
  role: "rm_app",
  object: "swarm_recommendations",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitJudgement.take",
  purpose: "Refuse a judge that has a take in the session.",
  callers: [JUDGE_ROUTE],
  probe: { statement: "SELECT 1 AS one FROM swarm_recommendations WHERE session_id = $1 AND member_id = $2 LIMIT 1", params: [SAMPLE_ID, "probe"] },
});
const judgeClock = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitJudgement.clock",
  purpose: "Compare the transaction's one present with the session's judging deadline.",
  callers: [JUDGE_ROUTE],
  probe: {
    statement: `SELECT (judging_deadline_at IS NOT NULL AND $1::text::timestamptz > judging_deadline_at) AS past_deadline
        FROM swarm_sessions WHERE id = $2`,
    params: ["2000-01-01 00:00:00+00", SAMPLE_ID],
  },
});
const judgeInsert = registerQuery({
  role: "rm_app",
  object: "swarm_session_judgements",
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/domain:submitJudgement.insert",
  purpose: "Record the judgement, applied or with the reason it was not.",
  callers: [JUDGE_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_session_judgements
        (session_id, mode, source, model, prompt_hash, inputs_digest, digest_scheme, take_count, min_takes,
         applied, applied_skipped_reason, dropped_positions, dropped_disagreements,
         judged_by, judged_by_member_id, opinion,
         usage_input_tokens, usage_output_tokens, usage_total_tokens, usage_cost_usd)
      SELECT $1, 'enforce', 'model', $2, $3, $4, $5,
              $6, $7, $8, $9,
              $10, $11,
              $12, $13, $14::jsonb,
              $15, $16,
              $17, $18 WHERE false
      RETURNING id`,
    params: [SAMPLE_ID, "probe", "probe", "probe", "probe", 1, 1, false, null, 0, 0, "probe", "probe", "{}", null, null, null, null],
  },
});
const judgeAudit = registerQuery({
  role: "rm_app",
  object: "audit_log",
  privileges: ["INSERT"],
  site: "src/swarm/domain:submitJudgement.audit",
  purpose: "Record a judgement submission in the audit log.",
  callers: [JUDGE_ROUTE],
  probe: {
    statement: "INSERT INTO audit_log (actor, action, scope) SELECT $1, 'submit_judgement', $2::jsonb WHERE false",
    params: ["probe", "{}"],
  },
});
const judgeCreated = registerQuery({
  role: "rm_app",
  object: "swarm_session_judgements",
  privileges: ["SELECT"],
  site: "src/swarm/domain:submitJudgement.created",
  purpose: "Read back the recorded judgement's creation instant.",
  callers: [JUDGE_ROUTE],
  probe: { statement: "SELECT created_at FROM swarm_session_judgements WHERE id = $1", params: [1] },
});
export async function submitJudgement(
  token: string,
  input: JudgementSubmission,
): Promise<SubmitJudgementResult> {
  const memberId = await memberIdForToken(token);
  if (!memberId) return refuseSubmission(401, "invalid_token");
  if (!(await isJudgeMember(memberId))) return refuseSubmission(403, "judge_role_required");

  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (!sessionId) return refuseSubmission(400, "session_required");
  if (!isUuid(sessionId)) return refuseSubmission(404, "session_not_found");
  // No opinion, no judgement. This is the refusal that keeps "a judge refuses
  // rather than fakes" true at the boundary: there is no branch below that
  // could supply one.
  if (input.opinion === undefined || input.opinion === null || input.opinion === "") {
    return refuseSubmission(400, "opinion_required");
  }
  const opinion = boundedText(input.opinion, MAX_JUDGEMENT_CHARS);
  if (opinion === null) return refuseSubmission(400, "opinion_must_be_the_raw_model_answer_text");
  const model = boundedText(input.model, 200);
  if (model === null) return refuseSubmission(400, "model_required");
  const promptHash = typeof input.promptHash === "string" && SHA256_HEX.test(input.promptHash) ? input.promptHash : null;
  if (promptHash === null) return refuseSubmission(400, "prompt_hash_malformed");
  const claimedDigest = typeof input.inputsDigest === "string" && SHA256_HEX.test(input.inputsDigest)
    ? input.inputsDigest
    : null;
  if (claimedDigest === null) return refuseSubmission(400, "inputs_digest_malformed");
  const nonce = boundedText(input.nonce, 200);
  if (nonce === null) return refuseSubmission(400, "nonce_required");
  const signature = boundedText(input.signature, 200);
  if (signature === null) return refuseSubmission(400, "signature_required");
  // Spend is validated with the rest of the body, before the verify and before
  // any row: a malformed block refuses the judgement and writes nothing.
  const usageCheck = parseJudgementUsage(input.usage);
  if (!usageCheck.ok) return refuseSubmission(400, usageCheck.error);
  const usage = usageCheck.usage;

  // ── SIGNED BY THIS MEMBER'S ACTIVE KEY ─────────────────────────────────────
  // The same key resolution a take uses (`activeKeyFor`) and the same
  // fail-closed verifier: an unparseable key or signature is `false`, never a
  // throw. The member id is not sent by the judge; it is the token's, and it is
  // inside the signed bytes, so a judgement signed for one member cannot be
  // replayed under another member's bearer.
  const key = await activeKeyFor(memberId);
  if (!key) return refuseSubmission(403, "no_registered_key");
  const canonical = canonicalizeJudgement({
    memberId, sessionId, nonce, model, promptHash, inputsDigest: claimedDigest, opinion,
  });
  if (!(await verifyDetachedSignature(canonical, signature, key.publicKey))) {
    return refuseSubmission(400, "signature_invalid");
  }

  return sql.begin(async (tx) => {
    const [session] = await on(tx, sessionForJudgement)<Record<string, any>>`
      SELECT id, state, judge_mode, judging_deadline_at, consensus_recorded_at
        FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`;
    if (!session) return refuseSubmission(404, "session_not_found");
    // JUDGING WAS REQUESTED, OR THERE IS NOTHING TO SUBMIT INTO. Checked on the
    // locked row, before anything is written. `published` passes only when it
    // was reached through judging, which is the late-evidence case §4.4 keeps.
    //
    // THE SAME MODE TEST requestJudging AND finalizeEpoch APPLY: only `off`
    // refuses. A session whose mode was never captured (NULL — one that reached
    // `aggregated` without a turnover) is judged exactly as those two treat it:
    // requestJudging accepts it and finalize decides it on the enforce branch.
    // Refusing it here alone would force its `no_consensus` while the other two
    // transitions went on waiting for a judgement this one could never take.
    // The stored deadline is the real proof that judging was requested.
    if (session.judge_mode === "off" || !session.judging_deadline_at ||
        !["judging", "judged", "published"].includes(String(session.state))) {
      return refuseSubmission(409, "session_not_judging");
    }

    const [existing] = await on(tx, judgeExisting)<{ id: string; applied: boolean; applied_skipped_reason: string | null; created_at: Date }>`
      SELECT id, applied, applied_skipped_reason, created_at FROM swarm_session_judgements
       WHERE session_id = ${sessionId} AND judged_by_member_id = ${memberId}
       ORDER BY id LIMIT 1`;
    if (existing) {
      // A redelivery, or a crash-restart resending. One judgement per judge per
      // session: the row on file is the answer, and nothing about the session
      // moves — the consensus, if this row formed it, was recorded with it.
      return {
        ok: true as const,
        status: 200,
        sessionId,
        judgementId: Number(existing.id),
        state: String(session.state),
        recordedAt: new Date(existing.applied && session.consensus_recorded_at
          ? session.consensus_recorded_at
          : existing.created_at).toISOString(),
        lateEvidence: existing.applied_skipped_reason === "late_evidence",
        duplicate: true,
        judgeOfRecord: existing.applied === true,
        applied: existing.applied === true,
      };
    }

    // ── ELIGIBILITY, read inside the write transaction ──────────────────────
    // An admin revoking the judge, or turning third-party judging off, while
    // its model was thinking is observed before any row can land.
    const [member] = await on(tx, judgeMember)<{ status: string; role: string; operator: string | null }>`
      SELECT status, role, operator FROM swarm_members WHERE id = ${memberId} FOR SHARE`;
    if (!member || member.status !== "active") return refuseSubmission(403, "judge_member_inactive");
    if (member.role !== "judge") return refuseSubmission(403, "judge_role_required");
    const [cfg] = await on(tx, judgeConfig)<{ third_party_enabled: boolean; min_takes: number }>`
      SELECT third_party_enabled, min_takes FROM swarm_judge_config WHERE id = 1`;
    const thirdPartyEnabled = cfg?.third_party_enabled === true;
    // THE THIRD-PARTY GATE, KEYED ON OPERATOR (§6.2, D52). `operator` is only
    // trustworthy because no non-admin writer may set it to the in-house
    // literal: `updateMemberProfile` refuses it (the #925 forgery), and apply
    // and registration never write the column at all.
    if (member.operator !== IN_HOUSE_OPERATOR && !thirdPartyEnabled) {
      return refuseSubmission(403, "third_party_judging_disabled");
    }
    const [take] = await on(tx, judgeTake)`
      SELECT 1 AS one FROM swarm_recommendations WHERE session_id = ${sessionId} AND member_id = ${memberId} LIMIT 1`;
    if (take) return refuseSubmission(409, "judge_member_has_take_in_session");

    // ── WHAT IT READ IS WHAT IS ON FILE ──────────────────────────────────────
    const frozen = await loadFrozenTakeSet(sessionId, tx);
    if (!frozen) return refuseSubmission(404, "session_not_found");
    const judged = await judgeInputFromFrozen(frozen, Number(cfg?.min_takes ?? 3), tx);
    if (judged.takes.length === 0) return refuseSubmission(409, "nothing_to_judge:no_takes");
    if (!judged.takes.some((t) => t.body.trim() !== "")) return refuseSubmission(409, "nothing_to_judge:no_take_bodies");
    if (inputsDigest(judged) !== claimedDigest) return refuseSubmission(409, "inputs_digest_mismatch");

    // ── THE ANSWER PARSES, OR THERE IS NO JUDGEMENT ─────────────────────────
    const drops = noDrops();
    let parsed: JudgeOpinion;
    try {
      parsed = parseJudgeResponse(opinion, judged, drops);
    } catch (err) {
      if (err instanceof JudgeResponseError) return refuseSubmission(422, `judgement_refused:${err.reason}`);
      throw err;
    }
    // The STORED object is scanned too. parseJudgeResponse rejected a
    // weight-like key in what the model wrote; this is the same rule asked of
    // what is about to be written, in front of the row's own no-weights CHECK.
    const weightPath = findWeightLikeKey(parsed);
    if (weightPath) return refuseSubmission(422, `judgement_refused:weight_like_field:${weightPath}`);

    // ── THE JUDGE OF RECORD, BY MEMBER ID ────────────────────────────────────
    const judgeOfRecord = (await judgeOfRecordTx(tx, sessionId)) === memberId;

    // ONE READING OF THE DATABASE CLOCK decides this judgement (§4.2, "One
    // clock"): `clock_timestamp()`, never the transaction's `now()` and never
    // the application's clock, read here — after the row locks above, so not
    // before a lock wait — and reused both for the deadline test below and as
    // the consensus acceptance instant `recordJudgingConsensusTx` stores. Two
    // readings could straddle the deadline and apply an opinion whose recorded
    // instant then makes it ineligible. The deadline itself is inclusive (§4.4:
    // a consensus recorded AT it is eligible).
    const present = await readPresent(tx);
    const [clock] = await on(tx, judgeClock)<{ past_deadline: boolean }>`
      SELECT (judging_deadline_at IS NOT NULL AND ${present}::text::timestamptz > judging_deadline_at) AS past_deadline
        FROM swarm_sessions WHERE id = ${sessionId}`;
    session.past_deadline = clock?.past_deadline === true;

    let applied = false;
    let skipped: string | null = null;
    if (session.state === "published") {
      skipped = "late_evidence";
    } else if (!judgeOfRecord) {
      skipped = "not_judge_of_record";
    } else if (session.state !== "judging" || session.consensus_recorded_at) {
      skipped = "consensus_already_recorded";
    } else if (session.past_deadline === true) {
      // AFTER THE DEADLINE, BEFORE FINALIZE. The session is still `judging`
      // only because the scheduler has not finalized it yet, and finalize will
      // decide `no_consensus` from the stored deadline whatever lands now
      // (§4.4: "A consensus recorded after the deadline is kept as a record but
      // does not change a `no_consensus` outcome"). So the row is kept as
      // evidence and the opinion does NOT reach the session: were it applied,
      // the published `no_consensus` session would carry a judge block, and a
      // receipt could be assembled over an opinion that decided nothing.
      skipped = "after_deadline";
    } else {
      const attempt = await applyOpinion(tx, sessionId, {
        opinion: parsed, model, promptHash, inputsDigest: claimedDigest, judgedByMemberId: memberId,
      });
      applied = attempt.applied;
      skipped = attempt.applied ? null : attempt.reason;
    }

    const [row] = await on(tx, judgeInsert)<{ id: string }>`
      INSERT INTO swarm_session_judgements
        (session_id, mode, source, model, prompt_hash, inputs_digest, digest_scheme, take_count, min_takes,
         applied, applied_skipped_reason, dropped_positions, dropped_disagreements,
         judged_by, judged_by_member_id, opinion,
         usage_input_tokens, usage_output_tokens, usage_total_tokens, usage_cost_usd)
      VALUES (${sessionId}, 'enforce', 'model', ${model}, ${promptHash}, ${claimedDigest}, ${DIGEST_SCHEME},
              ${judged.takes.length}, ${judged.minTakes}, ${applied}, ${skipped},
              ${drops.positions}, ${drops.disagreements},
              ${memberId}, ${memberId}, ${sql.json(parsed as any)},
              ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null},
              ${usage?.totalTokens ?? null}, ${usage?.costUsd ?? null})
      RETURNING id`;
    const judgementId = Number(row.id);
    // The signature is kept beside the row it authorizes, so "which key signed
    // this judgement, over which nonce" is answerable after the fact.
    await on(tx, judgeAudit)`INSERT INTO audit_log (actor, action, scope) VALUES (${memberId}, 'submit_judgement', ${sql.json({
      sessionId, judgementId, nonce, signature, signingKeyId: key.id, judgeOfRecord, applied,
    } as any)})`;

    if (applied) {
      const recorded = await recordJudgingConsensusTx(tx, sessionId, judgementId, present);
      // Unreachable while the session row is locked in `judging` above, and a
      // throw rather than a return so the row and the applied opinion roll back
      // with it: they are one fact.
      if (!recorded.ok) throw new Error(`consensus refused after the judgement was written: ${recorded.error}`);
      return {
        ok: true as const,
        status: 200,
        sessionId,
        judgementId,
        state: recorded.state,
        recordedAt: recorded.recordedAt,
        lateEvidence: false,
        duplicate: false,
        judgeOfRecord,
        applied,
      };
    }
    const [created] = await on(tx, judgeCreated)<{ created_at: Date }>`
      SELECT created_at FROM swarm_session_judgements WHERE id = ${judgementId}`;
    return {
      ok: true as const,
      status: 200,
      sessionId,
      judgementId,
      state: String(session.state),
      recordedAt: new Date(created.created_at).toISOString(),
      lateEvidence: skipped === "late_evidence",
      duplicate: false,
      judgeOfRecord,
      applied,
    };
  }) as Promise<SubmitJudgementResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The judgement on the session's own record
// ─────────────────────────────────────────────────────────────────────────────

/** The states in which an opinion may still reach a session: never a terminal one. */
const OPINION_WRITABLE_STATES = ["scheduled", "collecting", "window_closed", "aggregated", "judging", "judged"];

/** The outcome of trying to put an opinion onto its session. */
type ApplyOutcome = { applied: true; reason: null } | { applied: false; reason: string };

/**
 * Merge a judgement's three fields into the recommendation, and name its judge.
 *
 * Read-modify-write in JS rather than a jsonb operator so the merge is one
 * obvious list of keys: rationale, disagreements, release_safety, the `judge`
 * fingerprint, and NOTHING ELSE. `weights`, `quorum`, `stances`,
 * `meanConfidence`, `absent` and `type` are untouched by construction — judging
 * a session cannot change its vector.
 *
 * THE ANSWER IS A READ-BACK, NOT A ROW COUNT (issue #806). `applied` claims the
 * session now carries this opinion, and the admin panel renders that claim
 * verbatim, so the fact is established the way the read path establishes it:
 * `swarm_recommendation->'judge'` is read straight back and compared against
 * this judgement's `prompt_hash`/`inputs_digest`.
 *
 * Takes a `tx` because the read and the write are a read-modify-write, inside
 * the submission's transaction and under its lock on the session row.
 */
const opinionLock = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/domain:applyOpinion.lock",
  purpose: "Lock the session and read its state and recommendation before the opinion is merged in.",
  callers: [JUDGE_ROUTE],
  probe: { statement: "SELECT state, swarm_recommendation FROM swarm_sessions WHERE id = $1 FOR UPDATE", params: [SAMPLE_ID] },
});
const opinionWrite = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/domain:applyOpinion.write",
  purpose: "Write the judge's opinion into the session's recommendation while the session is still writable.",
  callers: [JUDGE_ROUTE],
  probe: {
    statement: `UPDATE swarm_sessions SET swarm_recommendation = $1::jsonb
    WHERE id = $2 AND state = ANY($3::text[])
    RETURNING id`,
    params: ["{}", SAMPLE_ID, "{scheduled,collecting,window_closed,aggregated,judging,judged}"],
  },
});
async function applyOpinion(
  tx: DbHandle,
  sessionId: string,
  j: { opinion: JudgeOpinion; model: string; promptHash: string; inputsDigest: string; judgedByMemberId: string },
): Promise<ApplyOutcome> {
  const [row] = await on(tx, opinionLock)<{ state: string; swarm_recommendation: Record<string, unknown> | null }>`
    SELECT state, swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`;
  if (!row || !OPINION_WRITABLE_STATES.includes(String(row.state))) {
    return { applied: false, reason: "session_no_longer_writable" };
  }
  const rec = { ...(row.swarm_recommendation ?? {}) } as Record<string, unknown>;
  rec.rationale = j.opinion.rationale;
  rec.disagreements = j.opinion.disagreements;
  rec.release_safety = j.opinion.release_safety;
  rec.judge = {
    source: "model",
    model: j.model,
    prompt_hash: j.promptHash,
    inputs_digest: j.inputsDigest,
    judged_by: j.judgedByMemberId,
    judged_by_member_id: j.judgedByMemberId,
  };
  const upd = await on(tx, opinionWrite)`
    UPDATE swarm_sessions SET swarm_recommendation = ${sql.json(rec as any)}
    WHERE id = ${sessionId} AND state = ANY(${OPINION_WRITABLE_STATES}::text[])
    RETURNING id`;
  if (upd.length === 0) return { applied: false, reason: "session_no_longer_writable" };
  const carried = await sessionJudgeFingerprint(tx, sessionId);
  if (carried && carried.inputsDigest === j.inputsDigest && carried.promptHash === j.promptHash &&
      carried.judgedByMemberId === j.judgedByMemberId) {
    return { applied: true, reason: null };
  }
  return { applied: false, reason: "session_does_not_carry_opinion" };
}

/**
 * What `swarm_sessions.swarm_recommendation` says the judge left on it, or null.
 *
 * ONE definition, read by the writer (above, to establish `applied`) and by the
 * admin read path (`getSessionJudgementsAdmin`, to decide whether the opinion it
 * calls IN FORCE is still the one the session carries). Two copies of this
 * comparison would be two chances to disagree about the very fact the pair
 * exists to keep honest.
 *
 * THE JUDGE IS PART OF THE FINGERPRINT. Two judges given the same prompt over
 * the same take set share `prompt_hash` and `inputs_digest`, so the digests
 * alone cannot say whose judgement the session carries once several judges are
 * seated. `judgedByMemberId` is null on a historical in-house judgement, which
 * named no member.
 */
const judgeFingerprint = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/domain:sessionJudgeFingerprint",
  purpose: "Read the judge fingerprint (prompt hash, inputs digest, judge) a session's recommendation carries.",
  callers: [JUDGE_ROUTE, ADMIN_ROUTE, SWARM_ROUTE],
  probe: {
    statement: `SELECT swarm_recommendation->'judge'->>'prompt_hash'         AS prompt_hash,
           swarm_recommendation->'judge'->>'inputs_digest'       AS inputs_digest,
           swarm_recommendation->'judge'->>'judged_by_member_id' AS judged_by_member_id
      FROM swarm_sessions WHERE id = $1`,
    params: [SAMPLE_ID],
  },
});
export async function sessionJudgeFingerprint(
  handle: DbHandle = sql,
  sessionId: string,
): Promise<{ promptHash: string; inputsDigest: string; judgedByMemberId: string | null } | null> {
  const [row] = await on(handle, judgeFingerprint)<{ prompt_hash: string | null; inputs_digest: string | null; judged_by_member_id: string | null }>`
    SELECT swarm_recommendation->'judge'->>'prompt_hash'         AS prompt_hash,
           swarm_recommendation->'judge'->>'inputs_digest'       AS inputs_digest,
           swarm_recommendation->'judge'->>'judged_by_member_id' AS judged_by_member_id
      FROM swarm_sessions WHERE id = ${sessionId}`;
  if (!row || row.prompt_hash == null || row.inputs_digest == null) return null;
  return {
    promptHash: String(row.prompt_hash),
    inputsDigest: String(row.inputs_digest),
    judgedByMemberId: row.judged_by_member_id ?? null,
  };
}

// ORDER BY id, NOT created_at. `created_at` defaults to `now()`, which is the
// TRANSACTION START time, so of two judgements written in overlapping
// transactions the one that committed second can carry the earlier timestamp.
// `id` is a bigserial drawn at INSERT, so it is the only ordering that agrees
// with the order the rows were actually written in.
const judgementsList = registerQuery({
  role: "rm_app",
  object: "swarm_session_judgements",
  privileges: ["SELECT"],
  site: "src/swarm/domain:listJudgements",
  purpose: "List a session's judgements, newest first.",
  callers: [SWARM_ROUTE, ADMIN_ROUTE, JUDGE_ROUTE],
  probe: {
    statement: `SELECT id, session_id, mode, source, fallback_reason, model, prompt_hash, inputs_digest, digest_scheme,
           take_count, min_takes, applied, applied_skipped_reason,
           dropped_positions, dropped_disagreements, judged_by, judged_by_member_id, opinion, created_at
    FROM swarm_session_judgements WHERE session_id = $1
    ORDER BY id DESC LIMIT $2`,
    params: [SAMPLE_ID, 1],
  },
});
export async function listJudgements(sessionId: string, limit = 50, db: DbHandle = sql) {
  const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  return (await on(db, judgementsList)<any>`
    SELECT id, session_id, mode, source, fallback_reason, model, prompt_hash, inputs_digest, digest_scheme,
           take_count, min_takes, applied, applied_skipped_reason,
           dropped_positions, dropped_disagreements, judged_by, judged_by_member_id, opinion, created_at
    FROM swarm_session_judgements WHERE session_id = ${sessionId}
    ORDER BY id DESC LIMIT ${bounded}`) as Record<string, unknown>[];
}

/** The newest judgement on file, by the ordering argued above. */
export async function latestJudgement(sessionId: string, db: DbHandle = sql) {
  return (await listJudgements(sessionId, 1, db))[0] ?? null;
}
// ─────────────────────────────────────────────────────────────────────────────
// The connection
// ─────────────────────────────────────────────────────────────────────────────

export interface JudgeStreamOptions {
  /** How often a keepalive goes out when the pending set has not changed. */
  keepaliveMs?: number;
  /** How often this connection recomputes the judge's pending set. */
  refreshMs?: number;
}

// Under `Bun.serve`'s 10-second default idle timeout: a quiet SSE connection
// has to write something first, or the server cuts it. The
// keepalive threshold sits under the refresh interval, so an unchanged pending
// set still writes a keepalive on every refresh — at most five seconds apart.
const JUDGE_STREAM_DEFAULTS = { keepaliveMs: 4_000, refreshMs: 5_000 } as const;

/**
 * Hold a judge's subscription open, serving its pending set.
 *
 * ON EVERY CONNECT, the first frame is the whole pending set — not a delta, not
 * a resumption. That single property is the contract (§6.2): a judge that
 * crashed, redeployed or was never up gets its work by connecting, with nothing
 * to replay and nothing to have missed.
 *
 * While the connection lives, the set is recomputed and re-sent whenever it
 * CHANGES — a new request appears, or this judge's own submission clears one.
 * Resending an unchanged set would be noise, and sending nothing at all would
 * make a judge that connected a second before a request wait for its own
 * reconnect.
 *
 * Like the scheduler's stream, everything here belongs to the open connection
 * and stops with it. Nothing runs when no judge is connected.
 */
export function openJudgeStream(memberId: string, opts: JudgeStreamOptions = {}): Response {
  const keepaliveMs = opts.keepaliveMs ?? JUDGE_STREAM_DEFAULTS.keepaliveMs;
  const refreshMs = opts.refreshMs ?? JUDGE_STREAM_DEFAULTS.refreshMs;
  let live = true;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown): void => {
        if (!live) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          live = false;
        }
      };

      let lastServed = "";
      let lastFrameAt = 0;
      void (async () => {
        while (live) {
          const pending = await pendingJudgingFor(memberId).catch(() => null);
          if (pending) {
            const fingerprint = JSON.stringify(pending.map((p) => p.sessionId));
            if (fingerprint !== lastServed) {
              lastServed = fingerprint;
              send("pending", { pending });
              lastFrameAt = Date.now();
            } else if (Date.now() - lastFrameAt >= keepaliveMs) {
              send("keepalive", {});
              lastFrameAt = Date.now();
            }
          }
          if (!live) break;
          await Bun.sleep(refreshMs);
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      })();
    },
    cancel() {
      live = false;
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
