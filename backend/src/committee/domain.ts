// Committee domain/service layer — the single place the rules live (window
// enforcement, signature verification, aggregation). The REST handlers, the MCP
// server, the worker, and the dev driver all call these; they never diverge.
import { classifyRegime, COMMITTEE_ROSTER_CAP, path as routePath, ROUTES, STANCES } from "@robotmoney/contract";
import { config } from "../config.ts";
import { type DbHandle, jsonValue, sql } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import {
  fingerprintPublicKey,
  verifyApplicationSignature,
  verifyClaimChallengeSignature,
  verifySubmissionSignature,
} from "../lib/signing.ts";
import { enqueueActivationNotification } from "./notifications.ts";
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
    SELECT member_id FROM committee_member_keys
    WHERE token_hash = ${hashKey(token)} AND active LIMIT 1`;
  return rows[0]?.member_id ?? null;
}

async function publicKeyFor(memberId: string): Promise<string | null> {
  const rows = await sql<{ public_key: string }[]>`
    SELECT public_key FROM committee_member_keys
    WHERE member_id = ${memberId} AND active ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.public_key ?? null;
}

// Fixed maximum size for the standing committee. HARD-ENFORCED at every
// transition-to-active in the domain/admin layer (activateMember, admin manual
// add, admin reactivate, and the demo registerMember shortcut) via
// assertRosterCapacity below — an over-cap admission is refused with a 409, not
// merely warned about. (The onboarding demo driver also self-throttles ahead of
// the write, but the write path is now the authoritative gate.) The CANONICAL
// value lives in @robotmoney/contract (contract/src/committee.js) — the shared
// channel mcp/scripts can also import, retiring the comment-enforced
// e2e.COMMITTEE_ROSTER_CAP mirror (finding 008). Re-exported under the same name
// so backend/tests/committee-roster-cap.test.ts (which pins its assertions to
// this constant, never a literal) keeps reading it from the domain layer.
export { COMMITTEE_ROSTER_CAP };

// ── Reads ─────────────────────────────────────────────────────────────────
export async function getMembers() {
  const rows = await sql`SELECT * FROM committee_members WHERE status = 'active' ORDER BY id`;
  return rows.map(toMember);
}
// Read-side count of currently active committee members — the gate the onboarding
// path checks against COMMITTEE_ROSTER_CAP before admitting a newcomer.
export async function countActiveMembers(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM committee_members WHERE status = 'active'`;
  return Number(rows[0]?.n ?? 0);
}

// Serialize every roster-admission transaction on one advisory key. A bare
// count()-then-write is a TOCTOU race: two concurrent activations each read
// count=CAP-1 and both admit, blowing past COMMITTEE_ROSTER_CAP. A txn-scoped
// advisory lock forces admissions one-at-a-time and auto-releases at commit.
// Call this FIRST inside any transaction that flips/creates a member to
// 'active', before the write. Pass the member id as `exemptMemberId` when the
// operation may target an already-active member (idempotent re-register) so a
// no-op re-activation doesn't spuriously trip the cap.
const ROSTER_ADMISSION_LOCK = 0x1cc0de; // stable arbitrary key for the committee roster
export async function assertRosterCapacity(
  tx: DbHandle,
  exemptMemberId?: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  await tx`SELECT pg_advisory_xact_lock(${ROSTER_ADMISSION_LOCK})`;
  if (exemptMemberId) {
    const active = await tx`SELECT 1 FROM committee_members WHERE id = ${exemptMemberId} AND status = 'active'`;
    if (active.length > 0) return { ok: true }; // idempotent no-op; slot already counted
  }
  const rows = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM committee_members WHERE status = 'active'`;
  const n = Number(rows[0]?.n ?? 0);
  if (n >= COMMITTEE_ROSTER_CAP)
    return { ok: false, status: 409, error: `committee roster full (${n}/${COMMITTEE_ROSTER_CAP})` };
  return { ok: true };
}
export async function getMember(id: string) {
  const row = (await sql`SELECT * FROM committee_members WHERE id = ${id}`)[0];
  return row ? toMember(row) : null;
}
export async function getSubject(id: string) {
  const row = (await sql`SELECT * FROM committee_subjects WHERE id = ${id}`)[0];
  return row ? toSubject(row) : null;
}

export async function getSubjectSnapshots(id: string) {
  const rows = await sql`SELECT id, subject_id, date, total_value_usd, positions, wallets, notable
                         FROM committee_subject_snapshots WHERE subject_id = ${id} ORDER BY date DESC`;
  return rows.map(toSnapshot);
}

// ── Sessions list: paginated + light-projected by default (issue #243) ──────
// The public directory page and the member-profile N+1 both used to pull
// EVERY session with its full payload (regimeSummary/synthesis/etc — measured
// at ~8.3MB on staging). Default response is now a light index row (see
// projections.toSessionListItem) plus an opaque nextCursor; ?full=1 keeps the
// pre-#243 unpaginated/unprojected shape reachable for callers (the admin
// sessions views) that still need every field.
const SESSIONS_LIST_DEFAULT_LIMIT = 20;
const SESSIONS_LIST_MAX_LIMIT = 100;

interface SessionsCursor { d: string; g: string; i: string }

// Opaque only in the sense that callers must treat it as a token — it's a
// base64url-encoded JSON tuple of (date, generatedAt, id), the exact tiebreak
// columns the query orders and filters by, so decoding never has to guess at
// a numeric offset that would drift as new sessions are inserted.
function encodeSessionsCursor(row: Record<string, any>): string {
  const cursor: SessionsCursor = { d: day(row.date), g: instant(row.generated_at) ?? "", i: String(row.id) };
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
    const rows = await sql`SELECT * FROM committee_sessions ORDER BY date DESC, generated_at DESC, id DESC`;
    return { sessions: rows.map(toSession), nextCursor: null as string | null };
  }

  const limit = parseSessionsLimit(opts.limit);
  const conds = [];
  if (opts.state) conds.push(sql`state = ${opts.state}`);
  const cur = decodeSessionsCursor(opts.cursor);
  if (cur) conds.push(sql`(date, generated_at, id) < (${cur.d}::date, ${cur.g}::timestamptz, ${cur.i}::uuid)`);
  const where = conds.length ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;

  // Fetch one extra row to detect "is there a next page" without a second
  // COUNT query; the (date, generated_at, id) triple is both the ORDER BY and
  // the cursor's row-comparison predicate, so pages are stable even as new
  // sessions are inserted between requests.
  const rows = await sql`
    SELECT * FROM committee_sessions ${where}
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
  const rows = await sql`
    SELECT r.id, r.member_id, m.name AS member_name, r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at,
           s.date AS session_date, s.subject_id, s.subject_name, s.state AS session_state,
           (SELECT k.public_key FROM committee_member_keys k
            WHERE k.member_id = r.member_id AND k.active
            ORDER BY k.created_at DESC LIMIT 1) AS public_key
    FROM committee_recommendations r
    JOIN committee_sessions s ON s.id = r.session_id
    JOIN committee_members m ON m.id = r.member_id
    WHERE r.member_id = ${memberId}
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

export async function getOpenSession() {
  const r = await sql`SELECT id, date, subject_id, subject_name, state, window_closes_at
                      FROM committee_sessions WHERE state = 'collecting'
                      ORDER BY generated_at DESC LIMIT 1`;
  return r[0] ? toSession(r[0]) : null;
}

export async function getSession(
  date: string,
  subjectId: string,
): Promise<{ session: ReturnType<typeof toSession>; takes: Awaited<ReturnType<typeof toVerifiedTake>>[] } | null> {
  const s = (await sql`SELECT * FROM committee_sessions WHERE date = ${date} AND subject_id = ${subjectId}`)[0];
  if (!s) return null;
  const takes = await sql`
    SELECT r.id, r.member_id, m.name AS member_name, r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at,
           (SELECT k.public_key FROM committee_member_keys k
            WHERE k.member_id = r.member_id AND k.active
            ORDER BY k.created_at DESC LIMIT 1) AS public_key
    FROM committee_recommendations r
    JOIN committee_members m ON m.id = r.member_id
    WHERE r.session_id = ${s.id} ORDER BY r.received_at`;
  return { session: toSession(s), takes: await Promise.all(takes.map(toVerifiedTake)) };
}

function hostedMemoId(memoUrl: string | null): number | null {
  if (!memoUrl) return null;
  try {
    const pathname = memoUrl.startsWith("/") ? memoUrl : new URL(memoUrl).pathname;
    const prefix = ROUTES.committee.memo.replace(":id", "");
    const rawId = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
    return /^\d+$/.test(rawId) ? Number(rawId) : null;
  } catch {
    return null;
  }
}

export async function getTakeReceipt(id: string) {
  const row = (await sql`
    SELECT r.id, r.member_id, m.name AS member_name, r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.signature, r.received_at,
           (SELECT k.public_key FROM committee_member_keys k
            WHERE k.member_id = r.member_id AND k.active
            ORDER BY k.created_at DESC LIMIT 1) AS public_key
    FROM committee_recommendations r
    JOIN committee_members m ON m.id = r.member_id
    WHERE r.id = ${id} LIMIT 1`)[0];
  if (!row) return null;

  const take = await toVerifiedTake(row);
  const memoId = hostedMemoId(take.memoUrl ?? null);
  return {
    take,
    memo: memoId == null ? null : await getMemo(memoId),
    signer: {
      id: row.member_id,
      name: row.member_name,
      publicKeyFingerprint: typeof row.public_key === "string"
        ? await fingerprintPublicKey(row.public_key)
        : null,
    },
  };
}

export async function getBrief(date: string, subjectId: string) {
  const r = await sql`SELECT id, date, subject_id, body, created_at FROM committee_briefs
                      WHERE date = ${date} AND subject_id = ${subjectId} ORDER BY created_at DESC LIMIT 1`;
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

  const session = (await sql`SELECT * FROM committee_sessions
                             WHERE date = ${sub.date} AND subject_id = ${sub.subjectId}`)[0];
  if (!session) return { ok: false, status: 404, error: "no session for date/subject" };
  if (session.state !== "collecting") return { ok: false, status: 409, error: `submission window not open (state=${session.state})` };
  if (session.window_closes_at && new Date(session.window_closes_at).getTime() < Date.now())
    return { ok: false, status: 409, error: "submission window closed" };

  // Roster gate (issue #152, AC6): sessions created through the admin surface
  // (committee/admin.ts createSessionAdmin) carry a FROZEN expected roster in
  // the canonical committee_session_members table (issue #150's migration),
  // snapshotted at creation time. When one exists, only a member with a
  // non-excused ('expected') row on it may submit — this is what makes the
  // roster authoritative rather than advisory. Sessions with NO roster rows
  // are the legacy/demo path (committee/domain.ts openSession, used by the
  // worker and the pre-#152 admin dispatcher) and are unaffected: this check
  // is a no-op for them, so existing behavior is preserved exactly.
  const rosterRows = await sql<{ status: string }[]>`
    SELECT status FROM committee_session_members WHERE session_id = ${session.id}`;
  if (rosterRows.length > 0) {
    const mine = (await sql<{ status: string }[]>`
      SELECT status FROM committee_session_members WHERE session_id = ${session.id} AND member_id = ${memberId}`)[0];
    if (!mine) return { ok: false, status: 403, error: "member is not on this session's expected roster" };
    if (mine.status === "excused") return { ok: false, status: 403, error: "member is excused from this session" };
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
    // gating the INSERT on a SELECT of the session that is still collecting and
    // not past its close time. If the window closed between our check above and
    // now, 0 rows insert and we reject.
    const rows = await sql`
      INSERT INTO committee_recommendations
        (session_id, member_id, subject_id, date, nonce, stance, confidence, body, memo_url, payload, signature, verified)
      SELECT s.id, ${memberId}, ${sub.subjectId}, ${sub.date}, ${sub.nonce}, ${sub.stance},
             ${sub.confidence}, ${sub.body ?? null}, ${sub.memoUrl ?? null}, ${sql.json(sub as any)}, ${sub.signature}, true
      FROM committee_sessions s
      WHERE s.id = ${session.id} AND s.state = 'collecting'
        AND (s.window_closes_at IS NULL OR s.window_closes_at > now())
      RETURNING id`;
    if (rows.length === 0) return { ok: false, status: 409, error: "submission window closed" };
    await sql`INSERT INTO audit_log (actor, action, scope) VALUES (${memberId}, 'submit_recommendation', ${sql.json({ sessionId: session.id })})`;
    return { ok: true, status: 201, recommendationId: rows[0].id, verified: true };
  } catch (e: any) {
    if (String(e?.message ?? e).includes("duplicate") || e?.code === "23505")
      return { ok: false, status: 409, error: "already submitted (member/nonce or session/member)" };
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
    return { ok: false, status: 400, error: "invalid signature over the canonical application payload" };
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
      FROM committee_member_keys k
      JOIN committee_members m ON m.id = k.member_id
      WHERE k.public_key = ${input.publicKey}
      ORDER BY k.created_at DESC LIMIT 1
      FOR UPDATE OF m`)[0];

    if (existingKey && existingKey.status !== "applied") {
      return { ok: false, status: 409, error: "publicKey already belongs to an admitted member; re-apply is an admin operation" };
    }

    if (existingKey) {
      const memberId = existingKey.member_id;
      await tx`
        UPDATE committee_members
        SET name = ${input.name}, lens = ${input.lens ?? null}, contact_email = ${input.contact}, applied_at = now()
        WHERE id = ${memberId}`;
      await tx`
        UPDATE committee_applications
        SET payload = ${tx.json(input as any)}, status = 'pending', reviewed_at = NULL
        WHERE member_id = ${memberId}`;
      await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('public:apply', 'apply_refresh', ${tx.json({ memberId })})`;
      return { ok: true, status: 201, memberId, memberStatus: "applied" as const };
    }

    const memberId = crypto.randomUUID();
    await tx`INSERT INTO committee_members (id, status, name, lens, contact_email, applied_at)
             VALUES (${memberId}, 'applied', ${input.name}, ${input.lens ?? null}, ${input.contact}, now())`;
    await tx`INSERT INTO committee_member_keys (member_id, public_key, active) VALUES (${memberId}, ${input.publicKey}, false)`;
    await tx`INSERT INTO committee_applications (member_id, payload, status) VALUES (${memberId}, ${tx.json(input as any)}, 'pending')`;
    // actor is the request source, NOT the self-asserted body identity.
    await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('public:apply', 'apply', ${tx.json({ memberId })})`;
    return { ok: true, status: 201, memberId, memberStatus: "applied" as const };
  });
}

// Public, redacted application-status projection (§11 R2, applyStatus route).
// Deliberately excludes name/contact/publicKey — only the derived lifecycle
// state and timestamps are exposed. An unknown id and a never-issued id are
// indistinguishable: both return null, which the route folds to a plain 404.
export type ApplicationState = "applied" | "approved" | "claimed" | "rejected" | "inactive";
export interface ApplicationStatus {
  id: string;
  state: ApplicationState;
  appliedAt: string | null;
  reviewedAt: string | null;
  claimedAt: string | null;
}

export async function getApplicationStatus(memberId: string): Promise<ApplicationStatus | null> {
  const member = (await sql<{ status: string; applied_at: Date | null }[]>`
    SELECT status, applied_at FROM committee_members WHERE id = ${memberId}`)[0];
  if (!member) return null;

  const application = (await sql<{ status: string; reviewed_at: Date | null }[]>`
    SELECT status, reviewed_at FROM committee_applications
    WHERE member_id = ${memberId} ORDER BY created_at DESC LIMIT 1`)[0];
  const key = (await sql<{ token_hash: string | null }[]>`
    SELECT token_hash FROM committee_member_keys
    WHERE member_id = ${memberId} AND active = true
    ORDER BY created_at DESC LIMIT 1`)[0];
  const challenge = (await sql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM committee_claim_challenges WHERE member_id = ${memberId}`)[0];

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
  return await sql.begin(async (tx) => {
    const existing = (await tx`
      SELECT id, contact_email FROM committee_members WHERE id = ${memberId} FOR UPDATE`)[0] as
      | { id: string; contact_email: string | null }
      | undefined;
    if (!existing) return { ok: false, status: 404, error: "no such applicant" };
    const key = (await tx`SELECT id FROM committee_member_keys WHERE member_id = ${memberId} AND active = false ORDER BY created_at DESC LIMIT 1 FOR UPDATE`)[0] as { id: number } | undefined;
    if (!key) return { ok: false, status: 409, error: "no pending key; member must apply first" };
    // Capacity gate: an 'applied' member is not yet active, so no exemption —
    // this admission must fit under COMMITTEE_ROSTER_CAP or it's refused.
    const cap = await assertRosterCapacity(tx);
    if (!cap.ok) return cap;
    const upd = await tx`
      UPDATE committee_member_keys SET active = true, token_hash = NULL
      WHERE id = ${key.id} AND active = false RETURNING id`;
    if (upd.length === 0) return { ok: false, status: 409, error: "activation raced; retry" };
    await tx`
      UPDATE committee_members
      SET status = 'active', activated_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${memberId}`;
    await tx`UPDATE committee_applications SET status = 'approved', reviewed_at = now() WHERE member_id = ${memberId} AND status = 'pending'`;
    await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'activate_member', ${tx.json({ memberId })})`;
    const notificationOutboxId = existing.contact_email
      ? await enqueueActivationNotification(tx, memberId, existing.contact_email)
      : null;
    return {
      ok: true,
      status: 200,
      memberId,
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
      FROM committee_members m
      JOIN committee_member_keys k ON k.id = (
        SELECT newest.id FROM committee_member_keys newest
        WHERE newest.member_id = m.id AND newest.active = true
        ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
      )
      WHERE m.id = ${memberId} AND m.status = 'active' AND k.token_hash IS NULL`;
    if (eligible.length === 0) return;
    await tx`
      INSERT INTO committee_claim_challenges (member_id, challenge, issued_at, expires_at, consumed_at)
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
      FROM committee_claim_challenges c
      JOIN committee_members m ON m.id = c.member_id AND m.status = 'active'
      JOIN committee_member_keys k ON k.id = (
        SELECT newest.id FROM committee_member_keys newest
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
      UPDATE committee_member_keys SET token_hash = ${hashKey(token)}
      WHERE id = ${row.key_id} AND active = true AND token_hash IS NULL
      RETURNING id`;
    if (installed.length === 0) {
      return { ok: false, status: 409, error: "bearer token already claimed; ask an administrator to rotate it if lost" };
    }
    await tx`
      UPDATE committee_claim_challenges SET consumed_at = now()
      WHERE member_id = ${input.memberId} AND challenge = ${row.challenge} AND consumed_at IS NULL`;
    await tx`
      INSERT INTO audit_log (actor, action, scope)
      VALUES (${input.memberId}, 'claim_member_token', ${tx.json({ memberId: input.memberId })})`;
    return { ok: true, status: 200, memberId: input.memberId, token };
  });
}

// ── Demo onboarding ─────────────────────────────────────────────────────────
// A member generates its own keypair and registers its PUBLIC key here, getting
// a bearer token in one shot. This is the PRIVILEGED admin shortcut (apply +
// activate combined) used by the demo/E2E harness; the public path is
// applyMember → activateMember. Private keys never leave the member.
export async function registerMember(input: { memberId: string; name: string; lens?: string; publicKey: string }) {
  const token = `tok_${input.memberId}_${crypto.randomUUID()}`;
  // Transactional so the capacity gate and the writes are one atomic admission.
  // Exempt this id: re-registering an ALREADY-active member is idempotent
  // (ON CONFLICT DO UPDATE, same slot) and must not trip the cap; only a NET-NEW
  // active member counts against COMMITTEE_ROSTER_CAP.
  return await sql.begin(async (tx) => {
    const cap = await assertRosterCapacity(tx, input.memberId);
    if (!cap.ok) return cap;
    await tx`INSERT INTO committee_members (id, status, name, lens)
             VALUES (${input.memberId}, 'active', ${input.name}, ${input.lens ?? null})
             ON CONFLICT (id) DO UPDATE SET status = 'active', name = EXCLUDED.name, lens = EXCLUDED.lens`;
    await tx`DELETE FROM committee_member_keys WHERE member_id = ${input.memberId}`;
    await tx`INSERT INTO committee_member_keys (member_id, public_key, token_hash)
             VALUES (${input.memberId}, ${input.publicKey}, ${hashKey(token)})`;
    return { memberId: input.memberId, token };
  });
}

// Dev-only: wipe session data so a demo can be re-run for today's subject.
export async function resetSessions() {
  await sql`TRUNCATE committee_recommendations, committee_briefs, committee_sessions RESTART IDENTITY CASCADE`;
  return { reset: true };
}

export async function ensureSubject(id: string, name: string) {
  await sql`INSERT INTO committee_subjects (id, status, name, recommendation_type)
            VALUES (${id}, 'active', ${name}, 'bucket_weights')
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  return { id, name };
}

// ── Deterministic reference-shaped fixtures & regime backfill (NO LLM) ────────
// The live committee path must render the SAME rich memo/charts as the committed
// archive fixture (frontend/public/data/committee/sessions/2026-06-25-woon.json).
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
// classifier; synthetic rows may be seeded only for demo fixtures, never on a
// live/prod deployment. Gated on RM_ENV: a prod backend refuses to write
// synthetic rows (a sparse prod table stays sparse and visibly so). The live
// aggregation path (buildRegimeSummary) no longer calls this at all — only the
// demo fixture seeding path (ensureDemoSubjectFixtures) does.
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

// Idempotently seed the fixtures the LIVE committee session path needs to render
// reference-shaped charts: the subject row (with thesis + recommendation type),
// a subject snapshot (positions/total/notable the portfolio donut reads), and a
// trailing regime history for the sparkline. Called from an admin action before a
// demo session opens. `date` defaults to today; the snapshot is dated on-or-before
// the session date so the frontend snapshot picker selects it.
export async function ensureDemoSubjectFixtures(subjectId: string, name: string, date?: string) {
  const snapDate = date ?? new Date().toISOString().slice(0, 10);
  const recommendationType = "position_actions";
  const thesis = `${name}: treasury read through the 95/5/0/0 conservative allocation mandate — Conservative DeFi Yield anchors 95%, the Agent Tokens sleeve caps at 5%.`;
  await sql`INSERT INTO committee_subjects (id, status, name, thesis_blurb, recommendation_type)
            VALUES (${subjectId}, 'active', ${name}, ${thesis}, ${recommendationType})
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              thesis_blurb = COALESCE(committee_subjects.thesis_blurb, EXCLUDED.thesis_blurb),
              recommendation_type = EXCLUDED.recommendation_type`;

  const basket = subjectBasket(subjectId);
  await sql`INSERT INTO committee_subject_snapshots (subject_id, date, total_value_usd, positions, wallets, notable)
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
export async function openSession(date: string, subjectId: string) {
  const subject = await getSubject(subjectId);
  const r = (await sql`
    INSERT INTO committee_sessions (date, subject_id, subject_name, state)
    VALUES (${date}, ${subjectId}, ${subject?.name ?? subjectId}, 'scheduled')
    ON CONFLICT (date, subject_id) DO UPDATE SET state = 'scheduled'
    RETURNING id, date, subject_id, subject_name, state`)[0];
  return r;
}

export async function publishBrief(sessionId: string, windowMinutes = 60, prevOutcome?: string) {
  const s = (await sql`SELECT * FROM committee_sessions WHERE id = ${sessionId}`)[0];
  const regime = (await sql`SELECT date, composite, regime, macro_regime, onchain_regime FROM regime_snapshots ORDER BY date DESC LIMIT 1`)[0] ?? null;
  const recent = await sql`SELECT date, subject_id, state FROM committee_sessions WHERE state = 'published' ORDER BY date DESC LIMIT 5`;
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
      system: "You are an investment committee member. Author only your own analysis and do not attribute invented statements to other members.",
      user: `Review the supplied committee context for ${subject?.name ?? s.subject_id} on ${typeof s.date === "string" ? s.date : new Date(s.date).toISOString().slice(0, 10)} and return one take matching takeSchema.`,
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
  await sql`INSERT INTO committee_briefs (date, subject_id, body) VALUES (${s.date}, ${s.subject_id}, ${sql.json(jsonValue(body))})
            ON CONFLICT (date, subject_id) DO UPDATE SET body = EXCLUDED.body`;
  await sql`UPDATE committee_sessions SET state = 'collecting', window_closes_at = ${closes} WHERE id = ${sessionId}`;
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
    INSERT INTO committee_agent_health_events (event_type, session_id, member_id, detail)
    VALUES (${eventType}, ${sessionId}, ${memberId}, ${tx.json(detail as any)})
    ON CONFLICT (session_id, member_id) WHERE event_type = 'absent' DO NOTHING`;
}

export interface AgentHealthFilter {
  sessionId?: string;
  memberId?: string;
  eventType?: "absent" | "rejected_signature";
  limit?: number;
}

// Admin-only projection (GET /api/committee/admin/agent-health): raw event
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
    FROM committee_agent_health_events ${where}
    ORDER BY created_at DESC LIMIT ${limit}`;
  const countRows = await sql<{ event_type: string; n: number }[]>`
    SELECT event_type, count(*)::int AS n FROM committee_agent_health_events ${where} GROUP BY event_type`;
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
      UPDATE committee_sessions SET state = 'window_closed'
      WHERE id = ${sessionId} AND state = 'collecting' RETURNING id`;
    if (upd.length > 0) {
      // Materialize absence events ONLY on a REAL collecting->window_closed
      // transition (a re-close of an already-closed session is a no-op, and
      // the unique partial index above makes this safe even if a retried job
      // races another). Only sessions with a FROZEN expected roster
      // (committee_session_members — the admin-created path, issue #150) have
      // an authoritative absence denominator; the legacy/demo openSession path
      // (no roster rows) is unaffected, matching submitRecommendation/
      // aggregateSession's existing roster-optional convention.
      const roster = await tx<{ member_id: string }[]>`
        SELECT member_id FROM committee_session_members
        WHERE session_id = ${sessionId} AND status != 'excused'`;
      if (roster.length > 0) {
        const submitted = await tx<{ member_id: string }[]>`
          SELECT DISTINCT member_id FROM committee_recommendations WHERE session_id = ${sessionId}`;
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
// label is null. Sparse histories are padded in memory, not persisted; demo
// deployments get their >= 8 persisted points from ensureDemoSubjectFixtures.
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
// reference session shape (regime_summary + rich committee_recommendation +
// prose synthesis + subject snapshot total). Members with no take are recorded as
// absent — never fabricated. All enrichment is templated (NO LLM).
function normalizedTakeWeights(value: unknown): { bucket: string; weight: number }[] | null {
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

function meanTakeWeights(takes: any[]): { bucket: string; weight: number }[] | undefined {
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

export async function aggregateSession(sessionId: string) {
  const s = (await sql`SELECT * FROM committee_sessions WHERE id = ${sessionId}`)[0];
  const takeRows = await sql`
    SELECT r.member_id, r.stance, r.confidence, r.body, r.payload, m.name AS member_name
    FROM committee_recommendations r JOIN committee_members m ON m.id = r.member_id
    WHERE r.session_id = ${sessionId} ORDER BY r.received_at`;
  // Denominator (issue #152, AC6): prefer the session's FROZEN roster
  // (committee_session_members, non-excused rows) over live committee_members
  // so a member added/removed AFTER the session was created never rewrites an
  // already-scheduled session's quorum math. Falls back to live active
  // members when the session has no roster snapshot at all (the legacy/demo
  // openSession path) — this keeps the pre-#152 demo/worker behavior
  // unchanged.
  const rosterRows = await sql<{ id: string }[]>`
    SELECT member_id AS id FROM committee_session_members WHERE session_id = ${sessionId} AND status != 'excused'`;
  const activeMembers = rosterRows.length > 0
    ? rosterRows
    : await sql`SELECT id FROM committee_members WHERE status = 'active'`;
  const frozenRoster = new Set(activeMembers.map((member: any) => member.id));
  const takes = rosterRows.length > 0
    ? takeRows.filter((take: any) => frozenRoster.has(take.member_id))
    : takeRows;
  const submitted = new Set(takes.map((t: any) => t.member_id));
  const absent = activeMembers.map((m: any) => m.id).filter((id: string) => !submitted.has(id));

  const byStance: Record<string, number> = {};
  let confSum = 0;
  for (const t of takes) {
    byStance[t.stance] = (byStance[t.stance] ?? 0) + 1;
    confSum += Number(t.confidence ?? 0);
  }
  const participation = activeMembers.length ? takes.length / activeMembers.length : 0;
  const meanConfidence = takes.length ? confSum / takes.length : null;

  const sessionDate = typeof s.date === "string" ? s.date : new Date(s.date).toISOString().slice(0, 10);
  const regimeSummary = await buildRegimeSummary(sessionDate);

  // Latest subject snapshot total (drives the session header figure).
  const snapRow = (await sql`
    SELECT total_value_usd FROM committee_subject_snapshots
    WHERE subject_id = ${s.subject_id} ORDER BY date DESC LIMIT 1`)[0] as { total_value_usd: unknown } | undefined;
  const subjectTotal = snapRow?.total_value_usd == null ? null : Number(snapRow.total_value_usd);

  // Rich recommendation: KEEP the deterministic rollup fields (the frontend reads
  // quorum/stances as a "rollup") AND add the reference rich fields so consensus /
  // disagreements / actions render. Type comes from the subject.
  const subjectRow = (await sql`SELECT recommendation_type FROM committee_subjects WHERE id = ${s.subject_id}`)[0] as { recommendation_type?: string } | undefined;
  const recType = subjectRow?.recommendation_type === "bucket_weights" ? "bucket_weights" : "position_actions";

  const authoredTakes = takes.filter((take: any) => typeof take.body === "string" && take.body.trim().length > 0);
  const consensus = authoredTakes.map((take: any) => take.body as string);

  // Disagreements: synthesize from the stance spread. When at least two distinct
  // stances were submitted, contrast the most- and least-constructive members.
  // The ascending ladder is the canonical contract vocabulary (finding 027).
  const rank = (st: string) => { const i = (STANCES as readonly string[]).indexOf(st); return i < 0 ? 2 : i; };
  const sortedTakes = authoredTakes.slice().sort((a: any, b: any) => rank(a.stance) - rank(b.stance));
  const disagreements: any[] = [];
  if (sortedTakes.length >= 2 && new Set(sortedTakes.map((t: any) => t.stance)).size >= 2) {
    const low = sortedTakes[0], high = sortedTakes[sortedTakes.length - 1];
    disagreements.push({
      topic: `Submitted views on ${s.subject_name ?? s.subject_id}`,
      positions: [
        { member_id: high.member_id, view: high.body },
        { member_id: low.member_id, view: low.body },
      ],
      what_settles: "",
    });
  }

  const rationale = authoredTakes.length ? authoredTakes.map((take: any) => take.body as string).join("\n\n") : undefined;
  const actions = recType === "position_actions" ? [
    { token: "USDC", action: "rotate", rationale: "Route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor." },
    { token: "rmUSDC", action: "add", rationale: "Vault receipt is the Agent Tokens exposure — top up to the mandated 5% floor." },
  ] : undefined;
  const weights = recType === "bucket_weights" ? meanTakeWeights(takes) : undefined;

  const quorum = { active: activeMembers.length, submitted: takes.length, absent: absent.length, participation };
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
  if (actions) rec.actions = actions;
  if (weights) rec.weights = weights;

  // Never invent editorial prose: synthesis is composed only of the exact
  // stored member-authored bodies, and is absent when every submitted body is empty.
  const synthesis = authoredTakes.length
    ? authoredTakes.map((take: any) => take.body as string).join("\n\n")
    : null;

  await sql`UPDATE committee_sessions SET
      state = 'aggregated',
      committee_recommendation = ${sql.json(rec as any)},
      synthesis = ${synthesis},
      regime_summary = ${sql.json(regimeSummary as any)},
      subject_snapshot_total_value_usd = ${subjectTotal}
    WHERE id = ${sessionId}`;
  // Named rollup fields (quorum/stances/meanConfidence/absent) are kept explicit
  // on the return so existing consumers (src/demo/e2e.ts) stay typed; the rich
  // fields ride along too.
  return {
    sessionId, state: "aggregated",
    quorum, stances: byStance, meanConfidence, absent,
    regimeSummary, subjectSnapshotTotalValueUsd: subjectTotal,
    type: recType, rationale, consensus, disagreements, actions, weights,
  };
}

export async function publishSession(sessionId: string) {
  await sql`UPDATE committee_sessions SET state = 'published', published_at = now() WHERE id = ${sessionId}`;
  return { sessionId, state: "published" };
}

// ── Memos ───────────────────────────────────────────────────────────────────
export async function postMemo(token: string, input: { sessionId: string; title?: string; body: string }) {
  const memberId = await memberIdForToken(token);
  if (!memberId) return { ok: false, status: 401, error: "unknown member token" };
  const rows = await sql`
    INSERT INTO committee_memos (member_id, session_id, title, body)
    VALUES (${memberId}, ${input.sessionId}, ${input.title ?? ""}, ${input.body})
    RETURNING id`;
  const id = rows[0].id;
  return { ok: true, status: 201, id, url: routePath(ROUTES.committee.memo, { id }) };
}

export async function getMemo(id: number) {
  const r = (await sql`SELECT id, member_id, session_id, title, body, created_at
                       FROM committee_memos WHERE id = ${id}`)[0] ?? null;
  if (!r) return null;
  return toMemo(r);
}
