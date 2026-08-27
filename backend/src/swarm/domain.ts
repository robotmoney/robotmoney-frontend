// Swarm domain/service layer — the single place the rules live (window
// enforcement, signature verification, aggregation). The REST handlers, the MCP
// server, the worker, and the dev driver all call these; they never diverge.
import { canonicalizeApplication, classifyRegime, SWARM_ROSTER_CAP, SWARM_TAKE_REVISION_CAP, path as routePath, ROUTES, STANCES } from "@robotmoney/contract";
import { config, resolveSwarmNotificationEmailFrom } from "../config.ts";
import { type DbHandle, jsonValue, sql } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import {
  fingerprintPublicKey,
  verifyApplicationSignature,
  verifyClaimChallengeSignature,
  verifySubmissionSignature,
} from "../lib/signing.ts";
// Issue #562: a new member's public handle comes from its name, not from the
// UUID applyMember minted for it. Leaf module — imports nothing from here, so
// admin.ts can call it on the manual-add path too without a cycle.
import { deriveMemberHandle, handleIsUnset } from "./handle.ts";
import { enqueueActivationNotification, enqueueApplicationReceivedNotification } from "./notifications.ts";
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

// ── Identity ──────────────────────────────────────────────────────────────
export async function memberIdForToken(token: string): Promise<string | null> {
  const rows = await sql<{ member_id: string }[]>`
    SELECT member_id FROM swarm_member_keys
    WHERE token_hash = ${hashKey(token)} AND active LIMIT 1`;
  return rows[0]?.member_id ?? null;
}

async function publicKeyFor(memberId: string): Promise<string | null> {
  const rows = await sql<{ public_key: string }[]>`
    SELECT public_key FROM swarm_member_keys
    WHERE member_id = ${memberId} AND active ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.public_key ?? null;
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

// THE STATES IN WHICH A TAKE MAY STILL BE AMENDED — an ALLOWLIST, and that is
// the whole point of it (issue #757 review).
//
// This was written as a denylist ("refuse when aggregated or published"), which
// was exhaustive of the post-aggregation states ON THE DAY IT WAS WRITTEN. #752
// then added `judged` between `aggregated` and `published`, and the denylist
// silently reopened the amendment window on a session whose weight vector and
// whose verbatim take prose had ALREADY been frozen by aggregateSession() and
// were about to be published unchanged (publishSession is an unconditional
// UPDATE that does not re-aggregate). The result would be a published session
// whose `weights` are not meanTakeWeights() over its own take set and whose
// `disagreements[].positions[].view` quotes a body the member has withdrawn —
// the exact defect the gate exists to prevent.
//
// As an allowlist, a state added to swarm_sessions later is FROZEN by default.
// Reopening the window for a new state is then a deliberate edit here, next to
// this paragraph, rather than an omission somewhere else.
//
// `scheduled` is included for completeness (no take can exist yet, so the
// amendment branch is unreachable from it); `window_closed` is included because
// #570 keeps the advertised deadline authoritative right up to its instant even
// after an early close.
export const TAKES_AMENDABLE_STATES: ReadonlySet<string> = new Set([
  "scheduled",
  "collecting",
  "window_closed",
]);

// ── Reads ─────────────────────────────────────────────────────────────────
export async function getMembers() {
  const rows = await sql`SELECT * FROM swarm_members WHERE status = 'active' ORDER BY id`;
  return rows.map(toMember);
}
export async function countActiveMembers(): Promise<number> {
  return countActiveMembersTx(sql);
}

export async function countActiveMembersTx(tx: DbHandle): Promise<number> {
  const rows = await tx<{ n: number }[]>`
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
const ROSTER_ADMISSION_LOCK = 0x1cc0de; // stable arbitrary key for the swarm roster
export async function assertRosterCapacity(
  tx: DbHandle,
  exemptMemberId?: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await tx`SELECT pg_advisory_xact_lock(${ROSTER_ADMISSION_LOCK})`;
  if (exemptMemberId) {
    const active = await tx`SELECT 1 FROM swarm_members WHERE id = ${exemptMemberId} AND status = 'active'`;
    if (active.length > 0) return { ok: true }; // idempotent no-op; slot already counted
  }
  const rows = await tx<{ n: number }[]>`
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
async function resolveMemberRow(ref: string) {
  return (await sql`
    SELECT * FROM swarm_members
    WHERE handle = ${ref} OR id = ${ref}
    ORDER BY (handle = ${ref}) DESC
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
export async function getMemberAvatarBytes(memberId: string): Promise<MemberAvatarBytes | null> {
  const rows = await sql<{ content_type: string; bytes: Buffer; uploaded_at: Date }[]>`
    SELECT content_type, bytes, uploaded_at FROM swarm_member_avatars WHERE member_id = ${memberId}`;
  const row = rows[0];
  return row ? { contentType: row.content_type, bytes: row.bytes, uploadedAt: row.uploaded_at } : null;
}
export async function getSubject(id: string) {
  const row = (await sql`SELECT * FROM swarm_subjects WHERE id = ${id}`)[0];
  return row ? toSubject(row) : null;
}

export async function getSubjectSnapshots(id: string) {
  const rows = await sql`SELECT id, subject_id, date, total_value_usd, positions, wallets, notable
                         FROM swarm_subject_snapshots WHERE subject_id = ${id} ORDER BY date DESC`;
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
function parseSessionsLimit(raw?: number): number {
  if (raw == null) return SESSIONS_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > SESSIONS_LIST_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${SESSIONS_LIST_MAX_LIMIT}`);
  }
  return raw;
}

export interface ListSessionsOptions {
  state?: string;
  limit?: number;
  cursor?: string | null;
  /** Reproduce the pre-#243 unpaginated, unprojected (every field, no state
   * filter applied unless also passed) response — the escape hatch the issue
   * asks to keep reachable for existing full-history consumers. */
  full?: boolean;
}

export async function listSessions(opts: ListSessionsOptions = {}) {
  if (opts.full) {
    const rows = await sql`SELECT * FROM swarm_sessions ORDER BY date DESC, generated_at DESC, id DESC`;
    return { sessions: rows.map(toSession), nextCursor: null as string | null };
  }

  const limit = parseSessionsLimit(opts.limit);
  const conds = [];
  if (opts.state) conds.push(sql`state = ${opts.state}`);
  const cur = decodeSessionsCursor(opts.cursor);
  // Bind the timestamp as text before casting on the server.  If postgres.js
  // infers a timestamptz parameter directly it serializes the string through a
  // JavaScript Date first, undoing the microsecond precision retained above.
  if (cur) conds.push(sql`(date, generated_at, id) < (${cur.d}::date, ${cur.g}::text::timestamptz, ${cur.i}::uuid)`);
  const where = conds.length ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;

  // Fetch one extra row to detect "is there a next page" without a second
  // COUNT query; the (date, generated_at, id) triple is both the ORDER BY and
  // the cursor's row-comparison predicate, so pages are stable even as new
  // sessions are inserted between requests.
  const rows = await sql`
    SELECT *, generated_at::text AS cursor_generated_at
    FROM swarm_sessions ${where}
    ORDER BY date DESC, generated_at DESC, id DESC
    LIMIT ${limit + 1}`;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    sessions: page.map(toSessionListItem),
    nextCursor: hasMore ? encodeSessionsCursor(page[page.length - 1]) : (null as string | null),
  };
}

// ── Member takes (issue #243B) ──────────────────────────────────────────────
// Collapses the member-profile page's "1 full session list + up to ~21 full
// session detail fetches" into one request: this member's own take in each of
// their most recent sessions (any state — collecting/window_closed/aggregated
// included, not just published, so the "this session" in-progress block keeps
// working), newest first.
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
  // LATEST-PER-SESSION (issue #573). Already scoped to one member, so the
  // latest-per-member rule collapses to "the highest revision in each session".
  // A member that amended twice must contribute ONE row to its own record page,
  // not three — and the LIMIT is a count of sessions, so without this it would
  // silently start returning fewer sessions than asked for.
  const rows = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (r.session_id)
             r.id, r.member_id, m.handle AS member_handle, m.name AS member_name,
             r.stance, r.confidence, r.body,
             r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
             s.date AS session_date, s.generated_at AS session_generated_at,
             s.subject_id, s.subject_name, s.state AS session_state,
             (SELECT k.public_key FROM swarm_member_keys k
              WHERE k.member_id = r.member_id AND k.active
              ORDER BY k.created_at DESC LIMIT 1) AS public_key
      FROM swarm_recommendations r
      JOIN swarm_sessions s ON s.id = r.session_id
      JOIN swarm_members m ON m.id = r.member_id
      -- One member, by the immutable id getMember resolved the caller's public
      -- reference to (handle OR legacy id — issue #593 keeps both addressable).
      WHERE r.member_id = ${member.id}
      ORDER BY r.session_id, r.revision DESC
    ) latest
    ORDER BY latest.session_date DESC, latest.session_generated_at DESC
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

export async function getOpenSession() {
  const r = await sql`SELECT id, date, subject_id, subject_name, state, window_closes_at
                      FROM swarm_sessions WHERE state = 'collecting'
                      ORDER BY generated_at DESC LIMIT 1`;
  return r[0] ? toSession(r[0]) : null;
}

export async function getSession(
  date: string,
  subjectId: string,
): Promise<{ session: ReturnType<typeof toSession>; takes: Awaited<ReturnType<typeof toVerifiedTake>>[] } | null> {
  // A date no longer identifies ONE session (migration 0022 — a subject may
  // convene several times a day), so this public route resolves to the LATEST
  // session that day. That keeps every existing link and the frontend's
  // (date, subject) fetches working, and is the answer a reader wants: the most
  // recent word on that subject for that day.
  const s = (await sql`SELECT * FROM swarm_sessions
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
export async function getSessionById(
  id: string,
): Promise<{ session: ReturnType<typeof toSession>; takes: Awaited<ReturnType<typeof toVerifiedTake>>[] } | null> {
  // `id` is a uuid column, so a non-uuid path segment would make Postgres throw
  // rather than miss. Treat anything unparseable as simply not found — this is a
  // public GET and a 404 is the honest answer for "no session with that handle".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const s = (await sql`SELECT * FROM swarm_sessions WHERE id = ${id}`)[0];
  if (!s) return null;
  return withTakes(s);
}

// The shared body of both lookups above: a session row plus its verified takes.
//
// LATEST-PER-MEMBER (issue #573). A member may now file several revisions in one
// session (migration 0028 relaxed `UNIQUE (session_id, member_id)`), each its own
// immutable signed row. This is a session's CURRENT reading, so it resolves to
// exactly one take per member — the highest revision. Without the `DISTINCT ON`
// the session page would render one card per revision, and its stance/confidence
// table would count one member several times.
//
// Superseded revisions are not lost and are not hidden: each keeps its own
// permalink and its own verification receipt (getTakeReceipt below), which is
// the whole point of the append-only model. They are simply not what "the
// session's takes" means.
async function withTakes(s: Record<string, unknown>) {
  const takes = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (r.member_id)
             r.id, r.member_id, m.handle AS member_handle, m.name AS member_name,
             r.stance, r.confidence, r.body,
             r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
             (SELECT k.public_key FROM swarm_member_keys k
              WHERE k.member_id = r.member_id AND k.active
              ORDER BY k.created_at DESC LIMIT 1) AS public_key
      FROM swarm_recommendations r
      JOIN swarm_members m ON m.id = r.member_id
      WHERE r.session_id = ${s.id as string}
      ORDER BY r.member_id, r.revision DESC
    ) latest ORDER BY latest.received_at`;
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

export async function getTakeReceipt(id: string) {
  const row = (await sql`
    SELECT r.id, r.session_id, r.member_id, m.handle AS member_handle, m.name AS member_name,
           r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at, r.nonce, r.revision,
           (SELECT k.public_key FROM swarm_member_keys k
            WHERE k.member_id = r.member_id AND k.active
            ORDER BY k.created_at DESC LIMIT 1) AS public_key
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
  const superseding = (await sql<{ id: string; revision: number; received_at: unknown }[]>`
    SELECT id, revision, received_at FROM swarm_recommendations
    WHERE session_id = ${row.session_id as string}
      AND member_id = ${row.member_id as string}
      AND revision > ${Number(row.revision ?? 1)}
    ORDER BY revision DESC LIMIT 1`)[0];

  const take = await toVerifiedTake(row);
  const memoId = hostedMemoId(take.memoUrl ?? null);
  return {
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
export async function getBriefBySession(sessionId: string) {
  // `session_id` is a uuid column, so a non-uuid handle would make Postgres
  // throw rather than return no rows; screen it here (mirrors getSessionById).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  const r = await sql`SELECT id, date, subject_id, session_id, body, created_at FROM swarm_briefs
                      WHERE session_id = ${sessionId} LIMIT 1`;
  return r[0] ? toBrief(r[0]) : null;
}

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
  const r = await sql`SELECT b.id, b.date, b.subject_id, b.session_id, b.body, b.created_at
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
  weights?: { bucket: string; weight: number }[]; signature: string;
}

export async function submitRecommendation(token: string, sub: SubmissionInput) {
  const memberId = await memberIdForToken(token);
  if (!memberId) return { ok: false, status: 401, error: "unknown member token" };
  if (memberId !== sub.memberId) return { ok: false, status: 403, error: "token/member mismatch" };

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
  const session = (await sql`SELECT * FROM swarm_sessions
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
  // Signed-date agreement. A stale agent that woke with yesterday's brief must
  // not have its take filed against today's session.
  if (sub.date && day(session.date) !== sub.date) {
    return {
      ok: false,
      status: 409,
      error: `signed date ${sub.date} does not match the open session for ${sub.subjectId} (${day(session.date)})`,
    };
  }
  if (session.window_closes_at && new Date(session.window_closes_at).getTime() < Date.now())
    return { ok: false, status: 409, error: "submission window closed" };

  // Roster gate (issue #152, AC6): sessions created through the admin surface
  // (swarm/admin.ts createSessionAdmin) carry a FROZEN expected roster in
  // the canonical swarm_session_members table (issue #150's migration),
  // snapshotted at creation time. When one exists, only a member with a
  // non-excused ('expected') row on it may submit — this is what makes the
  // roster authoritative rather than advisory. Sessions with NO roster rows
  // are the legacy/smoke path (swarm/domain.ts openSession, used by the
  // worker and the pre-#152 admin dispatcher) and are unaffected: this check
  // is a no-op for them, so existing behavior is preserved exactly.
  const rosterRows = await sql<{ status: string }[]>`
    SELECT status FROM swarm_session_members WHERE session_id = ${session.id}`;
  if (rosterRows.length > 0) {
    const mine = (await sql<{ status: string }[]>`
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
  const priorRow = (await sql<{ n: number; latest: number }[]>`
    SELECT count(*)::int AS n, coalesce(max(revision), 0)::int AS latest
    FROM swarm_recommendations
    WHERE session_id = ${session.id} AND member_id = ${memberId}`)[0];
  const priorCount = priorRow?.n ?? 0;
  const latestRevision = priorRow?.latest ?? 0;

  if (priorCount > 0) {
    // AMENDMENT-ONLY GATE — deliberately not applied to a first take. See
    // TAKES_AMENDABLE_STATES above for why this is an ALLOWLIST.
    //
    // `aggregateSession` copies take prose VERBATIM into
    // `swarm_recommendation.disagreements[].positions[].view` and is never
    // recomputed (`publishSession` is an unconditional UPDATE that does not
    // re-aggregate). So an amendment landing after aggregation yields a
    // published session quoting a body the member's current take no longer
    // carries. Confining amendment to the pre-aggregation window is what
    // avoids that without making aggregation re-entrant.
    //
    // It is amendment-only because #570 made the advertised deadline the whole
    // of the timing contract for a FIRST take: `closeWindow` may flip a
    // session to window_closed/aggregated before its advertised
    // `window_closes_at`, and a member promised that deadline still gets its
    // take in. That contract is unchanged here — pinned by
    // backend/tests/swarm-submission-window.test.ts ("closing the window EARLY
    // no longer rejects takes"). An amendment is the strictly newer ask, so it
    // is the one that yields.
    if (!TAKES_AMENDABLE_STATES.has(session.state)) {
      return {
        ok: false,
        status: 409,
        error: `amendment window closed (session already ${session.state}); the take on file stands`,
      };
    }
    if (priorCount >= SWARM_TAKE_REVISION_CAP) {
      return {
        ok: false,
        status: 409,
        error: `amendment cap reached (${SWARM_TAKE_REVISION_CAP} takes per member per session)`,
      };
    }
  }

  // Nonce replay, refused here rather than by the `UNIQUE (member_id, nonce)`
  // violation at the bottom. That constraint is untouched and still the
  // authority; this is the same answer, one indexed lookup earlier, and it is
  // now DISTINGUISHABLE from the amendment refusals above — the old text
  // ("already submitted (member/nonce or session/member)") named two causes
  // because one 409 covered both, and neither cause exists in that form now.
  const replayed = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM swarm_recommendations
    WHERE member_id = ${memberId} AND nonce = ${sub.nonce} LIMIT 1`;
  if (replayed.length > 0) {
    return { ok: false, status: 409, error: "nonce already used by this member (replay); mint a fresh nonce to amend" };
  }

  const pub = await publicKeyFor(memberId);
  if (!pub) return { ok: false, status: 403, error: "no registered key for member" };
  const verified = await verifySubmissionSignature(sub, sub.signature, pub);
  if (!verified) {
    // Agent-health surface (issue #208, scout #214): a rejected/tampered
    // signature was previously visible only in the submitting agent's own
    // stdout. Record it on the durable, queryable event log — AFTER the
    // session and member are already resolved above — with a bounded,
    // redacted detail (never the raw signature/public key/payload).
    await recordAgentHealthEvent("rejected_signature", session.id, memberId, {
      reason: "signature verification failed",
    });
    return { ok: false, status: 400, error: "signature verification failed" };
  }

  try {
    // Close the TOCTOU gap: re-check the window inside the same statement by
    // gating the INSERT on a SELECT of the session whose close time has not
    // passed. If the window closed between our check above and now, 0 rows
    // insert and we reject.
    //
    // The `s.state = 'collecting'` conjunct is gone with the state gate above
    // (issue #570) and had to be: leaving it here would have made deleting that
    // gate a no-op, turning `submission window not open (state=scheduled)` into
    // `submission window closed` for the same take. The window comparison is
    // kept, and it is the STRICTER of the two checks — this one runs against
    // Postgres `now()` while the guard above uses the api process's clock, so a
    // take that races the boundary is still rejected by the database itself.
    // REVISION IS COMPUTED IN SQL, not from the `latestRevision` read above, so
    // two racing submits cannot both file "revision 2" off the same stale read.
    // Under READ COMMITTED that is still not sufficient on its own — which is
    // exactly what `UNIQUE (session_id, member_id, revision)` (migration 0028)
    // is for: one of the two racers loses on the constraint and is answered
    // with a 409 in the catch below, and NO in-place edit of the winner's row
    // ever happens.
    //
    // The cap is re-checked here as a conjunct for the same reason — the count
    // above is a read, this is the write. `latestRevision` is used only to make
    // the two-statement path explainable in the audit row.
    const rows = await sql`
      INSERT INTO swarm_recommendations
        (session_id, member_id, subject_id, date, nonce, stance, confidence, body, memo_url, payload, signature, verified, revision)
      SELECT s.id, ${memberId}, ${sub.subjectId}, ${sub.date}, ${sub.nonce}, ${sub.stance},
             ${sub.confidence}, ${sub.body ?? null}, ${sub.memoUrl ?? null}, ${sql.json(sub as any)}, ${sub.signature}, true,
             (SELECT coalesce(max(r.revision), 0) + 1 FROM swarm_recommendations r
              WHERE r.session_id = s.id AND r.member_id = ${memberId})
      FROM swarm_sessions s
      WHERE s.id = ${session.id}
        AND (s.window_closes_at IS NULL OR s.window_closes_at > now())
        AND (SELECT count(*) FROM swarm_recommendations r
             WHERE r.session_id = s.id AND r.member_id = ${memberId}) < ${SWARM_TAKE_REVISION_CAP}
      RETURNING id, revision`;
    if (rows.length === 0) {
      // Two conjuncts can zero this out, and they are not the same answer to an
      // agent: one says "you are too late", the other says "stop". Re-read the
      // count to say which — only on the failure path, so the happy path stays
      // one statement.
      const after = (await sql<{ n: number }[]>`
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
    await sql`INSERT INTO audit_log (actor, action, scope) VALUES (${memberId}, ${revision > 1 ? "amend_recommendation" : "submit_recommendation"}, ${sql.json({ sessionId: session.id, revision, supersedes: revision > 1 ? latestRevision : null })})`;
    return { ok: true, status: 201, recommendationId: rows[0].id, verified: true, revision };
  } catch (e: any) {
    const message = String(e?.message ?? e);
    if (message.includes("duplicate") || e?.code === "23505") {
      // Which constraint lost tells the agent what to do next, and the two
      // answers are opposite: re-mint a nonce, or simply retry.
      const constraint = String(e?.constraint_name ?? e?.constraint ?? "") + " " + message;
      if (constraint.includes("member_id_nonce"))
        return { ok: false, status: 409, error: "nonce already used by this member (replay); mint a fresh nonce to amend" };
      return { ok: false, status: 409, error: "a concurrent submission from this member won the same revision; retry" };
    }
    throw e;
  }
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
    const existingKey = (await tx<{ member_id: string; status: string }[]>`
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
      await tx`
        UPDATE swarm_members
        SET name = ${input.name}, lens = ${input.lens ?? null}, contact_email = ${input.contact}, applied_at = now()
        WHERE id = ${memberId}`;
      await tx`
        UPDATE swarm_applications
        SET payload = ${tx.json(input as any)}, status = 'pending', reviewed_at = NULL
        WHERE member_id = ${memberId}`;
      await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('public:apply', 'apply_refresh', ${tx.json({ memberId })})`;
      // Re-apply gets the receipt too, and that is the case it matters most for:
      // the usual reason an operator runs the skill a second time with the same
      // key is that the first run's member id is gone from their terminal. See
      // enqueueApplicationReceivedNotification for how the re-send is armed
      // against the UNIQUE (kind, member_id) row that already exists.
      await sendApplicationReceipt(tx, memberId, input.name, input.contact);
      return { ok: true, status: 201, memberId, memberStatus: "applied" as const };
    }

    const memberId = crypto.randomUUID();
    await tx`INSERT INTO swarm_members (id, status, name, lens, contact_email, applied_at)
             VALUES (${memberId}, 'applied', ${input.name}, ${input.lens ?? null}, ${input.contact}, now())`;
    await tx`INSERT INTO swarm_member_keys (member_id, public_key, active) VALUES (${memberId}, ${input.publicKey}, false)`;
    await tx`INSERT INTO swarm_applications (member_id, payload, status) VALUES (${memberId}, ${tx.json(input as any)}, 'pending')`;
    // actor is the request source, NOT the self-asserted body identity.
    await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('public:apply', 'apply', ${tx.json({ memberId })})`;
    await sendApplicationReceipt(tx, memberId, input.name, input.contact);
    return { ok: true, status: 201, memberId, memberStatus: "applied" as const };
  });
}

// Queue the apply-time receipt carrying the status-page URL, on the same
// transaction as the application itself so the row can never exist without its
// email (or the email without the row). Delivery is the worker's problem: the
// outbox write is complete the moment this transaction commits, so an unreachable
// or unconfigured mail transport costs a retry, never an application.
//
// The one thing this will not do is fail the application. Every other caller of
// the notification module throws on an unset SWARM_NOTIFICATION_EMAIL_FROM,
// which is right for them: activate is an admin action and seat-open runs behind
// one, so a loud failure lands in front of someone who can fix the env. Apply is
// the public front door. Turning a sender misconfiguration into a 500 on every
// inbound application would cost us the applicants themselves, which is a strictly
// worse outcome than a missing receipt, so we check the sender first and skip
// rather than throw. The route already refuses applications without a contact
// email, so `recipient` is a real address by the time we get here.
//
// `memberName` comes straight off the application rather than being read back
// from the row we just wrote: it is the same value either way, and parseApply has
// already trimmed it and refused an empty one, so there is nothing a re-select
// would add except a query.
//
// Reads resolveSwarmNotificationEmailFrom() live rather than the frozen
// `config.swarmNotificationEmailFrom` singleton: config is computed once at
// module load and shared by the whole process, so a test-process value set
// before any import ever runs can never be observed as unset later. Reading the
// env at call time is what lets a test exercise this skip branch by clearing
// SWARM_NOTIFICATION_EMAIL_FROM around a single request, in-process, with no
// module reload — real deployments never mutate this env after boot, so the
// call-time read is behaviorally identical to the frozen one there.
async function sendApplicationReceipt(tx: DbHandle, memberId: string, memberName: string, recipient: string): Promise<void> {
  if (!resolveSwarmNotificationEmailFrom()) return;
  await enqueueApplicationReceivedNotification(tx, memberId, memberName, recipient);
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

export async function getApplicationStatus(memberId: string): Promise<ApplicationStatusResponse> {
  const row = (await sql<{ status: string }[]>`
    SELECT status FROM swarm_members WHERE id = ${memberId}`)[0];
  const raw = row?.status ?? null; // 'applied' | 'active' | 'inactive' | null
  const active = raw === "active";
  const claimed = active && (await sql`
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
  appliedAt: string | null;
  reviewedAt: string | null;
  claimedAt: string | null;
}

export async function getApplyStatus(memberId: string): Promise<ApplicationStatus | null> {
  const member = (await sql<{ status: string; applied_at: Date | null }[]>`
    SELECT status, applied_at FROM swarm_members WHERE id = ${memberId}`)[0];
  if (!member) return null;

  const application = (await sql<{ status: string; reviewed_at: Date | null }[]>`
    SELECT status, reviewed_at FROM swarm_applications
    WHERE member_id = ${memberId} ORDER BY created_at DESC LIMIT 1`)[0];
  const key = (await sql<{ token_hash: string | null }[]>`
    SELECT token_hash FROM swarm_member_keys
    WHERE member_id = ${memberId} AND active = true
    ORDER BY created_at DESC LIMIT 1`)[0];
  const challenge = (await sql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM swarm_claim_challenges WHERE member_id = ${memberId}`)[0];

  let state: ApplicationState;
  if (application?.status === "rejected") state = "rejected";
  else if (member.status === "applied") state = "applied";
  else if (member.status === "active") state = key?.token_hash ? "claimed" : "approved";
  else state = "inactive";

  return {
    id: memberId,
    state,
    appliedAt: member.applied_at ? new Date(member.applied_at).toISOString() : null,
    reviewedAt: application?.reviewed_at ? new Date(application.reviewed_at).toISOString() : null,
    claimedAt: key?.token_hash && challenge?.consumed_at ? new Date(challenge.consumed_at).toISOString() : null,
  };
}

// Admin-only. Transactional: locks the member + its pending key, preserves the
// roster-cap admission transaction, activates that exact key WITHOUT a bearer,
// approves the application, and enqueues the persisted activation email. The
// first successful key-proof claim below is the only public path that installs
// a token hash.
export async function activateMember(memberId: string) {
  try {
    return await activateMemberTx(memberId);
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

async function activateMemberTx(memberId: string) {
  return await sql.begin(async (tx) => {
    // `name` rides along on the row we are already locking, because the approval
    // email leads with it: an operator running several members recognises the name
    // they chose and nothing else, least of all a UUID. Adding the column here
    // beats a second select inside the notification module, which would have to
    // re-find a row this transaction is already holding. `handle` rides along
    // for the same reason (issue #562): the derivation below needs to know
    // whether anybody has already set one, and this row is already locked.
    const existing = (await tx`
      SELECT id, name, handle, contact_email FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0] as
      | { id: string; name: string; handle: string | null; contact_email: string | null }
      | undefined;
    if (!existing) return { ok: false, status: 404, error: "no such applicant" };
    const key = (await tx`SELECT id FROM swarm_member_keys WHERE member_id = ${memberId} AND active = false ORDER BY created_at DESC LIMIT 1 FOR UPDATE`)[0] as { id: number } | undefined;
    if (!key) return { ok: false, status: 409, error: "no pending key; member must apply first" };
    // Capacity gate: an 'applied' member is not yet active, so no exemption —
    // this admission must fit under SWARM_ROSTER_CAP or it's refused.
    const cap = await assertRosterCapacity(tx);
    if (!cap.ok) return cap;
    const upd = await tx`
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
    await tx`
      UPDATE swarm_members
      SET status = 'active', handle = ${handle}, activated_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${memberId}`;
    await tx`UPDATE swarm_applications SET status = 'approved', reviewed_at = now() WHERE member_id = ${memberId} AND status = 'pending'`;
    await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'activate_member', ${tx.json({ memberId, handle })})`;
    const notificationOutboxId = existing.contact_email
      ? await enqueueActivationNotification(tx, memberId, existing.name, existing.contact_email)
      : null;
    return {
      ok: true,
      status: 200,
      memberId,
      handle,
      claimRequired: true,
      notificationQueued: notificationOutboxId !== null,
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
export async function issueTokenClaimChallenge(memberId: string): Promise<TokenClaimChallenge> {
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = new Date(Date.now() + CLAIM_CHALLENGE_TTL_MS);
  await sql.begin(async (tx) => {
    // Serialize issue/claim for this opaque id. This closes the race where an
    // issuer could observe token_hash=NULL, wait behind a successful claim,
    // then replace its consumed row using the stale observation.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${memberId}, 205))`;
    const eligible = await tx`
      SELECT k.id
      FROM swarm_members m
      JOIN swarm_member_keys k ON k.id = (
        SELECT newest.id FROM swarm_member_keys newest
        WHERE newest.member_id = m.id AND newest.active = true
        ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
      )
      WHERE m.id = ${memberId} AND m.status = 'active' AND k.token_hash IS NULL`;
    if (eligible.length === 0) return;
    await tx`
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
export async function claimMemberToken(input: TokenClaimInput) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.memberId}, 205))`;
    const row = (await tx<{
      challenge: string;
      expires_at: Date;
      consumed_at: Date | null;
      key_id: number;
      public_key: string;
      token_hash: string | null;
    }[]>`
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
    const installed = await tx`
      UPDATE swarm_member_keys SET token_hash = ${hashKey(token)}
      WHERE id = ${row.key_id} AND active = true AND token_hash IS NULL
      RETURNING id`;
    if (installed.length === 0) {
      return { ok: false, status: 409, error: "bearer token already claimed; ask an administrator to rotate it if lost" };
    }
    await tx`
      UPDATE swarm_claim_challenges SET consumed_at = now()
      WHERE member_id = ${input.memberId} AND challenge = ${row.challenge} AND consumed_at IS NULL`;
    await tx`
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
      const seated = (await tx<{ id: string; handle: string | null }[]>`
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
        await tx`UPDATE swarm_members SET handle = ${handle} WHERE id = ${input.memberId}`;
      }
      await tx`DELETE FROM swarm_member_keys WHERE member_id = ${input.memberId}`;
      await tx`INSERT INTO swarm_member_keys (member_id, public_key, token_hash)
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

export async function ensureSubject(id: string, name: string) {
  await sql`INSERT INTO swarm_subjects (id, status, name, recommendation_type)
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
export async function backfillRegimeHistory(endDate: string, minPoints = 8): Promise<void> {
  if (config.env === "prod") return; // never write synthetic rows on the live deployment
  const existing = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM regime_snapshots`;
  if (Number(existing[0]?.n ?? 0) >= minPoints) return;
  const span = Math.max(minPoints, 14);
  const rng = seeded(`regime:${endDate}`);
  for (let i = span - 1; i >= 0; i--) {
    const date = shiftDay(endDate, -i);
    const t = (span - 1 - i) / (span - 1);
    const p = syntheticRegimePoint(date, t, rng);
    const macroReg = classifyRegime(p.macro), onchainReg = classifyRegime(p.onchain), factorReg = classifyRegime(p.factor);
    await sql`
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
export async function ensureSmokeSubjectFixtures(subjectId: string, name: string, date?: string) {
  const snapDate = date ?? new Date().toISOString().slice(0, 10);
  const recommendationType = "position_actions";
  const thesis = `${name}: treasury read through the 95/5/0/0 conservative allocation mandate — Conservative DeFi Yield anchors 95%, the Agent Tokens sleeve caps at 5%.`;
  await sql`INSERT INTO swarm_subjects (id, status, name, thesis_blurb, recommendation_type)
            VALUES (${subjectId}, 'active', ${name}, ${thesis}, ${recommendationType})
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              thesis_blurb = COALESCE(swarm_subjects.thesis_blurb, EXCLUDED.thesis_blurb),
              recommendation_type = EXCLUDED.recommendation_type`;

  const basket = subjectBasket(subjectId);
  await sql`INSERT INTO swarm_subject_snapshots (subject_id, date, total_value_usd, positions, wallets, notable)
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
 * session for this subject is returned as-is, so a retried `swarm.open_session`
 * job cannot convene a second one — but once that session publishes, the next
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
export async function openSession(subjectId: string) {
  const subject = await getSubject(subjectId);
  const existing = (await sql`
    SELECT id, date, convened_at, subject_id, subject_name, state
      FROM swarm_sessions
     WHERE subject_id = ${subjectId} AND state IN ('scheduled', 'collecting')
     ORDER BY convened_at DESC LIMIT 1`)[0];
  if (existing) return existing;
  const r = (await sql`
    INSERT INTO swarm_sessions (subject_id, subject_name, state)
    VALUES (${subjectId}, ${subject?.name ?? subjectId}, 'scheduled')
    RETURNING id, date, convened_at, subject_id, subject_name, state`)[0];
  return r;
}

export async function publishBrief(sessionId: string, windowMinutes = 60, prevOutcome?: string) {
  const s = (await sql`SELECT * FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  const regime = (await sql`SELECT date, composite, regime, macro_regime, onchain_regime FROM regime_snapshots ORDER BY date DESC LIMIT 1`)[0] ?? null;
  const recent = await sql`SELECT date, subject_id, state FROM swarm_sessions WHERE state = 'published' ORDER BY date DESC LIMIT 5`;
  const researchSignals = await sql`
    SELECT signal_key, date, payload FROM research_signals
    WHERE date = ${s.date} ORDER BY signal_key`;
  const previousSession = prevOutcome ? { outcome: prevOutcome } : undefined;
  const subject = await getSubject(s.subject_id);
  const closes = new Date(Date.now() + windowMinutes * 60_000);
  const windowClosesAt = closes.toISOString();
  const body = {
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
      weights: {
        type: "array",
        optional: true,
        items: {
          bucket: { type: "string" },
          weight: { type: "number", minimum: 0 },
        },
      },
    },
    windowClosesAt,
  };
  // Keyed on the SESSION (migration 0028), not the day. The old
  // `ON CONFLICT (date, subject_id)` made every session after the first of a
  // day overwrite its predecessor's brief — destroying the `windowClosesAt`
  // that session had already advertised to its members. Re-publishing the SAME
  // session still updates in place (the brief driver may retry), but a second
  // session on the same day now INSERTs its own row.
  await sql`INSERT INTO swarm_briefs (session_id, date, subject_id, body)
            VALUES (${sessionId}, ${s.date}, ${s.subject_id}, ${sql.json(jsonValue(body))})
            ON CONFLICT (session_id) DO UPDATE SET body = EXCLUDED.body`;
  await sql`UPDATE swarm_sessions SET state = 'collecting', window_closes_at = ${closes} WHERE id = ${sessionId}`;
  return { sessionId, state: "collecting", windowClosesAt };
}

// ── Agent health (issue #208, scout #214) ───────────────────────────────────
// Append-only, redacted event log for two things that were previously visible
// only in an agent's own stdout: a roster member missing its expected
// submission window, and a rejected/tampered submission signature. `detail`
// must stay bounded and redacted — never the raw signature/public key/payload.
async function recordAgentHealthEvent(
  eventType: "absent" | "rejected_signature",
  sessionId: string | null,
  memberId: string | null,
  detail: Record<string, unknown>,
  tx: DbHandle = sql,
): Promise<void> {
  await tx`
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
export async function getAgentHealthEvents(filter: AgentHealthFilter = {}) {
  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 500) : 100;
  const conds = [];
  if (filter.sessionId) conds.push(sql`session_id = ${filter.sessionId}`);
  if (filter.memberId) conds.push(sql`member_id = ${filter.memberId}`);
  if (filter.eventType) conds.push(sql`event_type = ${filter.eventType}`);
  const where = conds.length ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;
  const rows = await sql`
    SELECT id, event_type, session_id, member_id, detail, created_at
    FROM swarm_agent_health_events ${where}
    ORDER BY created_at DESC LIMIT ${limit}`;
  const countRows = await sql<{ event_type: string; n: number }[]>`
    SELECT event_type, count(*)::int AS n FROM swarm_agent_health_events ${where} GROUP BY event_type`;
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

export async function closeWindow(sessionId: string) {
  return await sql.begin(async (tx) => {
    const upd = await tx`
      UPDATE swarm_sessions SET state = 'window_closed'
      WHERE id = ${sessionId} AND state = 'collecting' RETURNING id`;
    if (upd.length > 0) {
      // Materialize absence events ONLY on a REAL collecting->window_closed
      // transition (a re-close of an already-closed session is a no-op, and
      // the unique partial index above makes this safe even if a retried job
      // races another). Only sessions with a FROZEN expected roster
      // (swarm_session_members — the admin-created path, issue #150) have
      // an authoritative absence denominator; the legacy/smoke openSession path
      // (no roster rows) is unaffected, matching submitRecommendation/
      // aggregateSession's existing roster-optional convention.
      const roster = await tx<{ member_id: string }[]>`
        SELECT member_id FROM swarm_session_members
        WHERE session_id = ${sessionId} AND status != 'excused'`;
      if (roster.length > 0) {
        const submitted = await tx<{ member_id: string }[]>`
          SELECT DISTINCT member_id FROM swarm_recommendations WHERE session_id = ${sessionId}`;
        const submittedSet = new Set(submitted.map((r) => r.member_id));
        for (const { member_id: memberId } of roster) {
          if (submittedSet.has(memberId)) continue;
          await recordAgentHealthEvent("absent", sessionId, memberId, { reason: "missed submission window" }, tx);
        }
      }
    }
    return { sessionId, state: "window_closed" };
  });
}

// Build the reference-shaped regime_summary object from the trailing regime
// snapshots (with deterministic IN-MEMORY padding so history.length >= 8). Kept
// separate so tests and aggregation share one code path.
//
// LIVE-PATH honesty (finding 009): this is the live aggregation path, so it
// never writes to regime_snapshots — stored labels are READ as-is (the
// classifier owns them) and classifyRegime is only a fallback for rows whose
// label is null. Sparse histories are padded in memory, not persisted; smoke
// deployments get their >= 8 persisted points from ensureSmokeSubjectFixtures.
export async function buildRegimeSummary(endDate: string, minPoints = 8) {
  const rows = await sql`
    SELECT date, composite, composite_percentile, regime,
           macro_regime, onchain_regime, factor_regime,
           macro_index, onchain_index, factor_index,
           macro_percentile, onchain_percentile, factor_percentile
    FROM regime_snapshots ORDER BY date DESC LIMIT 14`;
  const chrono = rows.slice().reverse(); // chronological
  const numOr = (v: unknown, fallback: number) => (v == null ? fallback : Number(v));
  // Percentile fallback: use stored percentile else the value itself clamped 0..1.
  const pct = (v: unknown, base: unknown) => {
    const p = v == null ? null : Number(v);
    if (p != null && Number.isFinite(p)) return round(Math.max(0, Math.min(1, p)));
    const b = base == null ? 0.5 : Number(base);
    return round(Math.max(0, Math.min(1, b)));
  };
  let history = chrono.map((r: any) => ({
    date: typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10),
    composite: numOr(r.composite, 0.5),
    regime: r.regime ?? classifyRegime(numOr(r.composite, 0.5)),
    macro: numOr(r.macro_index ?? r.macro_percentile, 0.6),
    onchain: numOr(r.onchain_index ?? r.onchain_percentile, 0.35),
    factor: numOr(r.factor_index ?? r.factor_percentile, 0.75),
  }));

  // Guarantee >= minPoints even if real rows exist but are sparse: prepend
  // deterministic synthetic leading points dated before the earliest real one.
  if (history.length < minPoints) {
    const need = minPoints - history.length;
    const anchor = history[0]?.date ?? endDate;
    const rng = seeded(`pad:${anchor}`);
    const pad = [];
    for (let i = need; i >= 1; i--) {
      const t = (need - i) / Math.max(1, need + history.length - 1);
      pad.push(syntheticRegimePoint(shiftDay(anchor, -i), t, rng));
    }
    history = [...pad, ...history];
  }

  const latest = chrono[chrono.length - 1] as any;
  const lc = latest ? numOr(latest.composite, 0.5) : history[history.length - 1].composite;
  return {
    composite: round(lc),
    composite_percentile: pct(latest?.composite_percentile, lc),
    regime: latest?.regime ?? classifyRegime(lc),
    macro_regime: latest?.macro_regime ?? classifyRegime(history[history.length - 1].macro),
    onchain_regime: latest?.onchain_regime ?? classifyRegime(history[history.length - 1].onchain),
    factor_regime: latest?.factor_regime ?? classifyRegime(history[history.length - 1].factor),
    macro_percentile: pct(latest?.macro_percentile, latest?.macro_index ?? history[history.length - 1].macro),
    onchain_percentile: pct(latest?.onchain_percentile, latest?.onchain_index ?? history[history.length - 1].onchain),
    factor_percentile: pct(latest?.factor_percentile, latest?.factor_index ?? history[history.length - 1].factor),
    history: history.map((h) => ({
      date: h.date,
      composite: round(h.composite),
      regime: h.regime,
      macro: round(h.macro),
      onchain: round(h.onchain),
      factor: round(h.factor),
    })),
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
// aggregation that wrote it. The judge's template fallback re-derives exactly
// that way, so "the fallback is byte-identical to today's prose" was true only
// until two stances tied.
//
// The tie-break is the same one stanceBreakdown() already sorts on — the
// canonical ascending STANCES ladder, lowest index first — so the two lines of
// prose can never disagree about which stance led.
function majorityStance(byStance: Record<string, number>): { stance: string; count: number } | null {
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
  regimeSummary: { composite_percentile?: number; regime?: string } | null,
): string[] {
  if (submitted === 0) return [];
  const points: string[] = [`${submitted} of ${active} members submitted (${Math.round(participation * 100)}% participation).`];
  const breakdown = stanceBreakdown(byStance);
  if (breakdown) points.push(`Stance split: ${breakdown}.`);
  if (meanConfidence != null) points.push(`Mean confidence ${meanConfidence.toFixed(2)} across submitted takes.`);
  if (regimeSummary?.composite_percentile != null) {
    points.push(`Regime composite at the ${Math.round(regimeSummary.composite_percentile * 100)}th percentile (${regimeSummary.regime ?? "unclassified"}).`);
  }
  return points;
}

// Recommendation-voiced "why": leads with the majority stance actually
// submitted. Deliberately a different shape from buildSynthesis() below so
// the two can never collide (cheap check: rationale !== synthesis).
export function buildRationale(
  subjectLabel: string, byStance: Record<string, number>, submitted: number,
  meanConfidence: number | null, regimeSummary: { composite_percentile?: number } | null,
): string {
  const majority = majorityStance(byStance);
  const parts: string[] = [];
  if (majority) parts.push(`Majority stance is ${majority.stance} (${majority.count} of ${submitted} submitted takes)`);
  if (meanConfidence != null) parts.push(`mean confidence ${meanConfidence.toFixed(2)}`);
  if (regimeSummary?.composite_percentile != null) parts.push(`regime composite at the ${Math.round(regimeSummary.composite_percentile * 100)}th percentile`);
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
// Exported since #752: this is one of the four template producers the judge
// falls back to when a model is unavailable or answers badly, and "falls back
// to the prose the templates produce today" is only checkable if the judge
// calls the same function the aggregator does.
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
// sets: `inputsDigest` on a judgement is a claim about "exactly the takes this
// opinion was formed over", and that claim is only worth anything if the set it
// digests is the same object the weight vector was derived from. One function,
// one query, both callers.
export interface FrozenTakeSet {
  session: Record<string, any>;
  takes: any[];
  activeMembers: { id: string }[];
  /** true when the session carries a roster snapshot (i.e. not the legacy/smoke path). */
  rosterFrozen: boolean;
}

export async function loadFrozenTakeSet(sessionId: string): Promise<FrozenTakeSet | null> {
  const s = (await sql`SELECT * FROM swarm_sessions WHERE id = ${sessionId}`)[0];
  if (!s) return null;
  // LATEST-PER-MEMBER (issue #573), for the same reason as withTakes above and
  // one more that is specific to this function: aggregation copies take prose
  // VERBATIM into `swarm_recommendation.disagreements[].positions[].view`. A
  // superseded body reaching that snapshot would publish, permanently, a
  // sentence the member has already withdrawn.
  // The outer `ORDER BY received_at` is the ordering this query has always had
  // and the tie-break the disagreement ladder below sorts on top of; only the
  // row SET changes here.
  const takeRows = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (r.member_id)
             r.member_id, r.stance, r.confidence, r.body, r.payload, r.revision,
             r.received_at, m.name AS member_name
      FROM swarm_recommendations r JOIN swarm_members m ON m.id = r.member_id
      WHERE r.session_id = ${sessionId}
      ORDER BY r.member_id, r.revision DESC
    ) latest ORDER BY latest.received_at`;
  // Denominator (issue #152, AC6): prefer the session's FROZEN roster
  // (swarm_session_members, non-excused rows) over live swarm_members
  // so a member added/removed AFTER the session was created never rewrites an
  // already-scheduled session's quorum math. Falls back to live active
  // members when the session has no roster snapshot at all (the legacy/smoke
  // openSession path) — this keeps the pre-#152 smoke/worker behavior
  // unchanged.
  const rosterRows = await sql<{ id: string }[]>`
    SELECT member_id AS id FROM swarm_session_members WHERE session_id = ${sessionId} AND status != 'excused'`;
  const activeMembers = rosterRows.length > 0
    ? rosterRows
    : (await sql`SELECT id FROM swarm_members WHERE status = 'active'`) as unknown as { id: string }[];
  const frozenRoster = new Set(activeMembers.map((member: any) => member.id));
  const takes = rosterRows.length > 0
    ? takeRows.filter((take: any) => frozenRoster.has(take.member_id))
    : takeRows;
  return { session: s as Record<string, any>, takes: takes as any[], activeMembers, rosterFrozen: rosterRows.length > 0 };
}

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
  let confSum = 0;
  for (const t of takes) {
    byStance[t.stance] = (byStance[t.stance] ?? 0) + 1;
    confSum += Number(t.confidence ?? 0);
  }
  const participation = activeMembers.length ? submittedCount / activeMembers.length : 0;
  const meanConfidence = submittedCount ? confSum / submittedCount : null;

  const sessionDate = typeof s.date === "string" ? s.date : new Date(s.date).toISOString().slice(0, 10);
  const regimeSummary = await buildRegimeSummary(sessionDate);

  // Latest subject snapshot total (drives the session header figure).
  const snapRow = (await sql`
    SELECT total_value_usd FROM swarm_subject_snapshots
    WHERE subject_id = ${s.subject_id} ORDER BY date DESC LIMIT 1`)[0] as { total_value_usd: unknown } | undefined;
  const subjectTotal = snapRow?.total_value_usd == null ? null : Number(snapRow.total_value_usd);

  // Rich recommendation: KEEP the deterministic rollup fields (the frontend reads
  // quorum/stances as a "rollup") AND add the reference rich fields so consensus /
  // disagreements / actions render. Type comes from the subject.
  const subjectRow = (await sql`SELECT recommendation_type FROM swarm_subjects WHERE id = ${s.subject_id}`)[0] as { recommendation_type?: string } | undefined;
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
  };
  if (rationale) rec.rationale = rationale;
  if (weights) rec.weights = weights;

  const synthesis = authoredTakes.length
    ? buildSynthesis(subjectLabel, activeMembers.length, submittedCount, participation, byStance, disagreements[0]?.topic)
    : null;

  await sql`UPDATE swarm_sessions SET
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

export async function publishSession(sessionId: string) {
  await sql`UPDATE swarm_sessions SET state = 'published', published_at = now() WHERE id = ${sessionId}`;
  return { sessionId, state: "published" };
}

// ── Memos ───────────────────────────────────────────────────────────────────
export async function postMemo(token: string, input: { sessionId: string; title?: string; body: string }) {
  const memberId = await memberIdForToken(token);
  if (!memberId) return { ok: false, status: 401, error: "unknown member token" };
  const rows = await sql`
    INSERT INTO swarm_memos (member_id, session_id, title, body)
    VALUES (${memberId}, ${input.sessionId}, ${input.title ?? ""}, ${input.body})
    RETURNING id`;
  const id = rows[0].id;
  return { ok: true, status: 201, id, url: routePath(ROUTES.swarm.memo, { id }) };
}

export async function getMemo(id: number) {
  const r = (await sql`SELECT id, member_id, session_id, title, body, created_at
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

  const merged = {
    tagline: patch.tagline !== undefined ? patch.tagline : row.tagline,
    mandate: patch.mandate !== undefined ? patch.mandate : row.mandate,
    biases: patch.biases !== undefined ? patch.biases : row.biases,
    voice_md: patch.voiceMd !== undefined ? patch.voiceMd : row.voice_md,
    mode: patch.mode !== undefined ? patch.mode : row.mode,
    operator: patch.operator !== undefined ? patch.operator : row.operator,
    avatar: patch.avatar !== undefined ? patch.avatar : row.avatar,
  };
  const updated = await sql`
    UPDATE swarm_members SET
      tagline = ${merged.tagline}, mandate = ${merged.mandate}, biases = ${sql.json(merged.biases as any)},
      voice_md = ${merged.voice_md}, mode = ${merged.mode}, operator = ${merged.operator},
      avatar = ${sql.json(merged.avatar as any)}, updated_at = now()
    WHERE id = ${memberId}
    RETURNING *`;
  await sql`INSERT INTO audit_log (actor, action, scope) VALUES (${memberId}, 'update_profile', ${sql.json({ memberId } as any)})`;
  return { ok: true, status: 200, member: toMember(updated[0]) };
}
