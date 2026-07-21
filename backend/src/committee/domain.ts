// Committee domain/service layer — the single place the rules live (window
// enforcement, signature verification, aggregation). The REST handlers, the MCP
// server, the worker, and the dev driver all call these; they never diverge.
import { applicationProofMessage, classifyRegime, COMMITTEE_ROSTER_CAP, path as routePath, ROUTES, SITE_PATHS, STANCES } from "@robotmoney/contract";
import { config } from "../config.ts";
import { type DbHandle, jsonValue, sql } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import { verifyMessageSignature, verifySubmissionSignature } from "../lib/signing.ts";
import { ALLOCATION_FRAMEWORK_SEED } from "../chain/allocation-framework.ts";
import { toBrief, toMember, toMemo, toSession, toSnapshot, toSubject, toTake } from "./projections.ts";

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

interface SessionCursor { generatedAt: string; id: string }
function encodeSessionCursor(row: any): string {
  return Buffer.from(JSON.stringify({ generatedAt: new Date(row.generated_at).toISOString(), id: String(row.id) })).toString("base64url");
}
function decodeSessionCursor(cursor?: string | null): SessionCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed.generatedAt === "string" && typeof parsed.id === "string" ? parsed : null;
  } catch { return null; }
}

export async function listSessions(opts: { limit?: number; cursor?: string | null } = {}) {
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 50)));
  const cursor = decodeSessionCursor(opts.cursor);
  const rows = cursor
    ? await sql`SELECT * FROM committee_sessions
                WHERE (generated_at, id) < (${cursor.generatedAt}::timestamptz, ${cursor.id}::uuid)
                ORDER BY generated_at DESC, id DESC LIMIT ${limit + 1}`
    : await sql`SELECT * FROM committee_sessions ORDER BY generated_at DESC, id DESC LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  return {
    sessions: page.map(toSession),
    nextCursor: rows.length > limit && page.length ? encodeSessionCursor(page[page.length - 1]) : null,
  };
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
): Promise<{ session: ReturnType<typeof toSession>; takes: ReturnType<typeof toTake>[] } | null> {
  const s = (await sql`SELECT * FROM committee_sessions WHERE date = ${date} AND subject_id = ${subjectId}`)[0];
  if (!s) return null;
  const takes = await sql`
    SELECT r.id, r.member_id, m.name AS member_name, r.stance, r.confidence, r.body,
           r.memo_url, r.payload, r.verified, r.received_at
    FROM committee_recommendations r
    JOIN committee_members m ON m.id = r.member_id
    WHERE r.session_id = ${s.id} ORDER BY r.received_at`;
  return { session: toSession(s), takes: takes.map(toTake) };
}

async function allocationBucketIds(): Promise<string[]> {
  const row = (await sql<{ buckets: Array<{ id?: string }> }[]>`SELECT buckets FROM allocation_framework WHERE id = 1`)[0];
  const buckets = Array.isArray(row?.buckets) && row.buckets.length ? row.buckets : ALLOCATION_FRAMEWORK_SEED.buckets;
  return buckets.map((bucket) => String(bucket.id ?? "")).filter(Boolean);
}

export async function getBrief(date: string, subjectId: string, memberId?: string | null) {
  const r = await sql`SELECT id, date, subject_id, body, created_at FROM committee_briefs
                      WHERE date = ${date} AND subject_id = ${subjectId} ORDER BY created_at DESC LIMIT 1`;
  if (!r[0]) return null;
  const session = (await sql`SELECT id, window_closes_at FROM committee_sessions WHERE date = ${date} AND subject_id = ${subjectId}`)[0];
  const alreadySubmitted = Boolean(memberId && session && (await sql`
    SELECT 1 FROM committee_recommendations WHERE session_id = ${session.id} AND member_id = ${memberId} LIMIT 1`).length);
  return {
    ...toBrief(r[0]),
    deadline: session?.window_closes_at ? new Date(session.window_closes_at).toISOString() : null,
    responseSchema: {
      stance: [...STANCES],
      confidence: { minimum: 0, maximum: 1 },
      proposedWeights: { optional: true as const, buckets: await allocationBucketIds(), sum: 1 },
    },
    promptGuidance: [
      "REGIME: state the regime read and the evidence that matters.",
      "ALLOCATION: explain the portfolio implication and optionally propose bucket weights.",
      "SUBJECT: address the named subject, its concentration, risks, and next action.",
    ],
    alreadySubmitted,
  };
}

// ── Submit (verify identity + window + signature + nonce) ───────────────────
export interface SubmissionInput {
  memberId: string; date: string; subjectId: string; nonce: string;
  stance: string; confidence: number; body?: string; memoUrl?: string; signature: string;
  proposedWeights?: Record<string, number>;
}

async function validateProposedWeights(weights?: Record<string, number>): Promise<string | null> {
  if (weights == null) return null;
  const entries = Object.entries(weights);
  if (!entries.length) return "proposedWeights must contain at least one bucket";
  const allowed = new Set(await allocationBucketIds());
  for (const [bucket, weight] of entries) {
    if (!allowed.has(bucket)) return `unknown allocation bucket: ${bucket}`;
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) return `weight for ${bucket} must be between 0 and 1`;
  }
  const sum = entries.reduce((total, [, weight]) => total + weight, 0);
  return Math.abs(sum - 1) <= 0.001 ? null : `proposedWeights must sum to 1 (received ${sum})`;
}

export async function submitRecommendation(token: string, sub: SubmissionInput) {
  const memberId = await memberIdForToken(token);
  if (!memberId) return { ok: false, status: 401, error: "unknown member token" };
  if (memberId !== sub.memberId) return { ok: false, status: 403, error: "token/member mismatch" };
  const weightsError = await validateProposedWeights(sub.proposedWeights);
  if (weightsError) return { ok: false, status: 400, error: weightsError };

  const session = (await sql`SELECT * FROM committee_sessions
                             WHERE date = ${sub.date} AND subject_id = ${sub.subjectId}`)[0];
  if (!session) return { ok: false, status: 404, error: "no session for date/subject" };
  if (session.state !== "collecting") return { ok: false, status: 409, error: `submission window not open (state=${session.state})` };
  if (session.window_closes_at && new Date(session.window_closes_at).getTime() < Date.now())
    return { ok: false, status: 409, error: "submission window closed" };

  // The session's frozen roster is authoritative: daily-cron and admin-created
  // sessions both snapshot active membership when they open. A zero-member
  // session has no roster rows and remains usable for isolated legacy fixtures.
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
  if (!verified) return { ok: false, status: 400, error: "signature verification failed" };

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
    return {
      ok: true, status: 201, recommendationId: rows[0].id, verified: true,
      url: routePath(SITE_PATHS.committeeReceipt, { date: sub.date, subject: sub.subjectId, member: memberId }),
    };
  } catch (e: any) {
    if (String(e?.message ?? e).includes("duplicate") || e?.code === "23505")
      return { ok: false, status: 409, error: "already submitted (member/nonce or session/member)" };
    throw e;
  }
}

// ── Onboarding: apply (public) → activate (admin) ───────────────────────────
// The real path. A prospective member submits its PUBLIC key with `apply`; the
// member stays status='applied' and the key is registered INACTIVE (no token,
// cannot submit). An admin then `activate`s the member, which flips it active,
// activates the key, and mints a bearer token. RM never holds private keys.
export interface ApplyInput {
  memberId: string;
  name: string;
  lens?: string;
  publicKey: string;
  contact?: string;
  operator?: string;
  thesis?: string;
  mandate?: string;
  biases?: string[];
  voiceMd?: string;
  wallets?: string[];
  avatar?: string;
  keyProofSignature?: string;
}

export async function applyMember(input: ApplyInput) {
  // CREATE-ONLY: a memberId is first-come. If it already exists (in ANY state),
  // refuse — re-apply and key rotation are privileged admin operations. This
  // prevents an unauthenticated caller from overwriting a pending applicant's
  // key/identity (which the admin would then activate).
  const existing = (await sql`SELECT id FROM committee_members WHERE id = ${input.memberId}`)[0] as { id: string } | undefined;
  if (existing) return { ok: false, status: 409, error: "memberId already registered; re-apply or key rotation requires admin" };
  if (!input.keyProofSignature || !await verifyMessageSignature(
    applicationProofMessage(input.memberId, input.publicKey),
    input.keyProofSignature,
    input.publicKey,
  )) return { ok: false, status: 400, error: "public key proof failed" };

  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO committee_members
               (id, status, name, tagline, lens, mandate, biases, voice_md, operator, avatar, contact_email, applied_at)
               VALUES (${input.memberId}, 'applied', ${input.name}, ${input.thesis ?? null}, ${input.lens ?? null},
                       ${input.mandate ?? null}, ${tx.json((input.biases ?? null) as any)}, ${input.voiceMd ?? null},
                       ${input.operator ?? null}, ${tx.json((input.avatar ? { url: input.avatar } : null) as any)},
                       ${input.contact ?? null}, now())`;
      await tx`INSERT INTO committee_member_keys (member_id, public_key, active) VALUES (${input.memberId}, ${input.publicKey}, false)`;
      const { keyProofSignature: _, ...application } = input;
      await tx`INSERT INTO committee_applications (member_id, payload, status) VALUES (${input.memberId}, ${tx.json(application as any)}, 'pending')`;
      // actor is the request source, NOT the self-asserted body identity.
      await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('public:apply', 'apply', ${tx.json({ memberId: input.memberId })})`;
    });
  } catch (e: any) {
    if (String(e?.message ?? e).includes("duplicate") || e?.code === "23505")
      return { ok: false, status: 409, error: "memberId already registered" };
    throw e;
  }
  return {
    ok: true,
    status: 201,
    memberId: input.memberId,
    memberStatus: "applied" as const,
    statusUrl: routePath(SITE_PATHS.committeeApplication, { member: input.memberId }),
  };
}

// Admin-only. Approval activates the exact pending public key but deliberately
// does not mint or reveal a bearer credential. The member claims that separately
// by signing a short-lived challenge with its private Ed25519 key.
export async function activateMember(memberId: string) {
  return await sql.begin(async (tx) => {
    const existing = (await tx`SELECT id FROM committee_members WHERE id = ${memberId} FOR UPDATE`)[0] as { id: string } | undefined;
    if (!existing) return { ok: false, status: 404, error: "no such applicant" };
    const key = (await tx`SELECT id FROM committee_member_keys WHERE member_id = ${memberId} AND active = false ORDER BY created_at DESC LIMIT 1 FOR UPDATE`)[0] as { id: number } | undefined;
    if (!key) return { ok: false, status: 409, error: "no pending key; member must apply first" };
    // Capacity gate: an 'applied' member is not yet active, so no exemption —
    // this admission must fit under COMMITTEE_ROSTER_CAP or it's refused.
    const cap = await assertRosterCapacity(tx);
    if (!cap.ok) return cap;
    const upd = await tx`UPDATE committee_member_keys
                         SET active = true, token_hash = NULL, token_claimed_at = NULL
                         WHERE id = ${key.id} AND active = false RETURNING id`;
    if (upd.length === 0) return { ok: false, status: 409, error: "activation raced; retry" };
    await tx`UPDATE committee_members SET status = 'active', activated_at = now() WHERE id = ${memberId}`;
    await tx`UPDATE committee_applications SET status = 'approved', reviewed_at = now() WHERE member_id = ${memberId} AND status = 'pending'`;
    const contact = (await tx`SELECT contact_email FROM committee_members WHERE id = ${memberId}`)[0]?.contact_email as string | null;
    let activationEmailQueued = false;
    if (contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
      const queued = await tx`
        INSERT INTO jobs (kind, payload, dedupe_key)
        VALUES ('committee.activation_email', ${tx.json({ memberId } as any)}, ${`committee:activation-email:${memberId}`})
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id`;
      activationEmailQueued = queued.length > 0;
    }
    await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'activate_member', ${tx.json({ memberId })})`;
    return {
      ok: true,
      status: 200,
      memberId,
      claimRequired: true,
      activationEmailQueued,
      statusUrl: routePath(SITE_PATHS.committeeApplication, { member: memberId }),
    };
  });
}

export async function applicationStatus(memberId: string) {
  const row = (await sql`
    SELECT m.id, m.status, m.applied_at, m.activated_at,
           a.status AS application_status, k.active AS key_active,
           k.token_hash, k.token_claimed_at
    FROM committee_members m
    LEFT JOIN LATERAL (
      SELECT status FROM committee_applications WHERE member_id = m.id ORDER BY created_at DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT active, token_hash, token_claimed_at FROM committee_member_keys WHERE member_id = m.id ORDER BY created_at DESC LIMIT 1
    ) k ON true
    WHERE m.id = ${memberId}`)[0] as any;
  if (!row) return null;
  return {
    memberId: row.id,
    memberStatus: row.status,
    applicationStatus: row.application_status ?? null,
    appliedAt: row.applied_at ?? null,
    activatedAt: row.activated_at ?? null,
    claimable: row.status === "active" && row.key_active === true && row.token_hash == null && row.token_claimed_at == null,
    claimed: row.token_hash != null || row.token_claimed_at != null,
  };
}

export async function createTokenClaimChallenge(memberId: string) {
  return sql.begin(async (tx) => {
    const key = (await tx`
      SELECT id, token_hash, token_claimed_at FROM committee_member_keys
      WHERE member_id = ${memberId} AND active = true
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`)[0] as { id: number; token_hash: string | null; token_claimed_at: Date | null } | undefined;
    if (!key) return { ok: false, status: 409, error: "application is not approved" };
    if (key.token_hash || key.token_claimed_at) return { ok: false, status: 409, error: "credential already claimed" };
    await tx`UPDATE committee_token_claims SET used_at = now() WHERE member_id = ${memberId} AND used_at IS NULL`;
    const challenge = `robotmoney:claim:${memberId}:${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await tx`INSERT INTO committee_token_claims (member_id, key_id, challenge, expires_at)
             VALUES (${memberId}, ${key.id}, ${challenge}, ${expiresAt})`;
    return { ok: true, status: 201, memberId, challenge, expiresAt: expiresAt.toISOString() };
  });
}

export async function claimMemberToken(memberId: string, challenge: string, signature: string) {
  return sql.begin(async (tx) => {
    const row = (await tx`
      SELECT c.id, c.challenge, c.expires_at, c.used_at, k.id AS key_id,
             k.public_key, k.token_hash, k.token_claimed_at
      FROM committee_token_claims c
      JOIN committee_member_keys k ON k.id = c.key_id
      WHERE c.member_id = ${memberId} AND c.challenge = ${challenge} AND k.active = true
      FOR UPDATE OF c, k`)[0] as any;
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now())
      return { ok: false, status: 409, error: "challenge is invalid, expired, or already used" };
    if (row.token_hash || row.token_claimed_at)
      return { ok: false, status: 409, error: "credential already claimed" };
    if (!await verifyMessageSignature(challenge, signature, row.public_key))
      return { ok: false, status: 400, error: "invalid signature" };

    const token = `tok_${memberId}_${crypto.randomUUID()}`;
    const updated = await tx`
      UPDATE committee_member_keys
      SET token_hash = ${hashKey(token)}, token_claimed_at = now()
      WHERE id = ${row.key_id} AND token_hash IS NULL AND token_claimed_at IS NULL
      RETURNING id`;
    if (updated.length === 0) return { ok: false, status: 409, error: "credential already claimed" };
    await tx`UPDATE committee_token_claims SET used_at = now() WHERE id = ${row.id}`;
    await tx`INSERT INTO audit_log (actor, action, scope)
             VALUES (${memberId}, 'claim_member_token', ${tx.json({ memberId })})`;
    return { ok: true, status: 200, memberId, token };
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
         macro_percentile, onchain_percentile, factor_percentile, synthetic,
         percentiles, indicators)
      VALUES
        (${date}, ${p.composite}, ${round(p.composite)}, ${p.regime},
         ${macroReg}, ${onchainReg}, ${factorReg},
         ${p.macro}, ${p.onchain}, ${p.factor},
         ${round(p.macro)}, ${round(p.onchain)}, ${round(p.factor)}, true,
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
  return sql.begin(async (tx) => {
    const r = (await tx`
      INSERT INTO committee_sessions (date, subject_id, subject_name, state)
      VALUES (${date}, ${subjectId}, ${subject?.name ?? subjectId}, 'scheduled')
      ON CONFLICT (date, subject_id) DO UPDATE SET subject_name = EXCLUDED.subject_name
      RETURNING id, date, subject_id, subject_name, state`)[0];
    await tx`
      INSERT INTO committee_session_members (session_id, member_id, member_name, member_lens, status)
      SELECT ${r.id}, id, name, lens, 'expected' FROM committee_members WHERE status = 'active'
      ON CONFLICT (session_id, member_id) DO NOTHING`;
    return r;
  });
}

export async function subjectForDailySession(date: string): Promise<string | null> {
  const subjects = await sql<{ id: string }[]>`SELECT id FROM committee_subjects WHERE status = 'active' ORDER BY id`;
  if (!subjects.length) return null;
  const day = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / DAY_MS);
  return subjects[((day % subjects.length) + subjects.length) % subjects.length]?.id ?? null;
}

export async function sessionIdForState(state: string): Promise<string | null> {
  const row = (await sql<{ id: string }[]>`
    SELECT id FROM committee_sessions WHERE state = ${state}
    ORDER BY date DESC, generated_at DESC LIMIT 1`)[0];
  return row?.id ?? null;
}

export async function publishBrief(sessionId: string, windowMinutes = 60, prevOutcome?: string) {
  const s = (await sql`SELECT * FROM committee_sessions WHERE id = ${sessionId}`)[0];
  const regime = (await sql`SELECT date, composite, regime, macro_regime, onchain_regime FROM regime_snapshots ORDER BY date DESC LIMIT 1`)[0] ?? null;
  const recent = await sql`SELECT date, subject_id, state FROM committee_sessions WHERE state = 'published' ORDER BY date DESC LIMIT 5`;
  const researchSignals = await sql`
    SELECT signal_key, date, payload FROM research_signals
    WHERE date = ${s.date} ORDER BY signal_key`;
  const previousSession = prevOutcome ? { outcome: prevOutcome } : undefined;
  const closes = new Date(Date.now() + windowMinutes * 60_000);
  const body = {
    regime, subject: await getSubject(s.subject_id), recentSessions: recent, previousSession, researchSignals,
    deadline: closes.toISOString(),
    responseSchema: {
      stance: [...STANCES], confidence: { minimum: 0, maximum: 1 },
      proposedWeights: { optional: true, buckets: await allocationBucketIds(), sum: 1 },
    },
    promptGuidance: [
      "REGIME: state the regime read and the evidence that matters.",
      "ALLOCATION: explain the portfolio implication and optionally propose bucket weights.",
      "SUBJECT: address the named subject, its concentration, risks, and next action.",
    ],
  };
  await sql`INSERT INTO committee_briefs (date, subject_id, body) VALUES (${s.date}, ${s.subject_id}, ${sql.json(jsonValue(body))})
            ON CONFLICT (date, subject_id) DO UPDATE SET body = EXCLUDED.body`;
  await sql`UPDATE committee_sessions SET state = 'collecting', window_closes_at = ${closes} WHERE id = ${sessionId}`;
  return { sessionId, state: "collecting", windowClosesAt: closes.toISOString() };
}

export async function closeWindow(sessionId: string) {
  await sql`UPDATE committee_sessions SET state = 'window_closed' WHERE id = ${sessionId} AND state = 'collecting'`;
  return { sessionId, state: "window_closed" };
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
           macro_percentile, onchain_percentile, factor_percentile, synthetic
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
    synthetic: Boolean(r.synthetic),
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
      pad.push({ ...syntheticRegimePoint(shiftDay(anchor, -i), t, rng), synthetic: true });
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
    synthetic: history.some((h) => h.synthetic),
    history: history.map((h) => ({
      date: h.date,
      composite: round(h.composite),
      regime: h.regime,
      macro: round(h.macro),
      onchain: round(h.onchain),
      factor: round(h.factor),
      synthetic: Boolean(h.synthetic),
    })),
  };
}

// Deterministic rollup over the takes ACTUALLY posted, ENRICHED into the
// reference session shape (regime_summary + rich committee_recommendation +
// prose synthesis + subject snapshot total). Members with no take are recorded as
// absent — never fabricated. All enrichment is templated (NO LLM).
export async function aggregateSession(sessionId: string) {
  const s = (await sql`SELECT * FROM committee_sessions WHERE id = ${sessionId}`)[0];
  const takes = await sql`
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
  const composite = regimeSummary.composite;
  const compPctInt = Math.round(regimeSummary.composite_percentile * 100);
  const regimeLbl = String(regimeSummary.regime).replace(/_/g, "-");

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

  const stanceParts = Object.entries(byStance).map(([k, v]) => `${v} ${k}`);
  const consensus = [
    `Regime composite ${composite.toFixed(3)} is at the ${compPctInt}th percentile (${regimeLbl}).`,
    `${takes.length}/${activeMembers.length} members submitted (${stanceParts.join(", ") || "no stances"}).`,
  ];
  if (meanConfidence != null) consensus.push(`Mean submitted confidence is ${(meanConfidence * 100).toFixed(0)}%.`);

  // Disagreements: synthesize from the stance spread. When at least two distinct
  // stances were submitted, contrast the most- and least-constructive members.
  // The ascending ladder is the canonical contract vocabulary (finding 027).
  const rank = (st: string) => { const i = (STANCES as readonly string[]).indexOf(st); return i < 0 ? 2 : i; };
  const sortedTakes = takes.slice().sort((a: any, b: any) => rank(a.stance) - rank(b.stance));
  const extractQuote = (body: unknown, stance: unknown): string | null => {
    if (typeof body !== "string" || !body.trim()) return null;
    const lines = body.split(/\n+/).map((line) => line.trim().replace(/^[-*]\s+/, "")).filter((line) => line && !/^\*\*[A-Z ]+\*\*$/.test(line));
    const keyword = String(stance ?? "").toLowerCase();
    return lines.find((line) => keyword && line.toLowerCase().includes(keyword)) ?? lines[0] ?? null;
  };
  const disagreements: any[] = [];
  if (sortedTakes.length >= 2 && new Set(sortedTakes.map((t: any) => t.stance)).size >= 2) {
    const low = sortedTakes[0], high = sortedTakes[sortedTakes.length - 1];
    const highQuote = extractQuote(high.body, high.stance);
    const lowQuote = extractQuote(low.body, low.stance);
    if (highQuote && lowQuote) disagreements.push({
      topic: "Stance spread",
      positions: [
        { member_id: high.member_id, view: highQuote },
        { member_id: low.member_id, view: lowQuote },
      ],
    });
  }

  const proposals = takes
    .map((take: any) => ({ take, weights: take.payload?.proposedWeights }))
    .filter((row: any) => row.weights && typeof row.weights === "object");
  let weights: Array<{ bucket: string; weight: number }> | undefined;
  if (proposals.length) {
    const confidenceTotal = proposals.reduce((sum: number, row: any) => sum + Math.max(0, Number(row.take.confidence ?? 0)), 0);
    const denominator = confidenceTotal > 0 ? confidenceTotal : proposals.length;
    const buckets = await allocationBucketIds();
    weights = buckets.map((bucket) => ({
      bucket,
      weight: round(proposals.reduce((sum: number, row: any) => {
        const confidence = confidenceTotal > 0 ? Math.max(0, Number(row.take.confidence ?? 0)) : 1;
        return sum + Number(row.weights[bucket] ?? 0) * confidence;
      }, 0) / denominator),
    }));
  }
  const rationale = weights ? `Confidence-weighted mean of ${proposals.length} submitted allocation proposal${proposals.length === 1 ? "" : "s"}.` : undefined;

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
  if (weights) rec.weights = weights;

  // Prose synthesis (2–4 sentences): composite + stance distribution + mandate.
  const stanceSummary = stanceParts.length ? stanceParts.join(", ") : "no stances on record";
  const quoteSummary = disagreements[0]?.positions?.map((position: any) => `${position.member_id}: “${position.view}”`).join(" ") ?? "";
  const synthesis =
    `Composite ${composite.toFixed(3)} is at the ${compPctInt}th percentile (${regimeLbl}). ` +
    `${takes.length}/${activeMembers.length} members submitted; the stance distribution is ${stanceSummary}` +
    (meanConfidence != null ? ` at ${(meanConfidence * 100).toFixed(0)}% mean confidence` : "") +
    (absent.length ? `, with ${absent.length} absent` : "") + "." +
    (quoteSummary ? ` Verbatim member views: ${quoteSummary}` : "");

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
    type: recType, rationale, consensus, disagreements, weights,
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
