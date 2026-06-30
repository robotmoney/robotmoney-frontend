// Committee domain/service layer — the single place the rules live (window
// enforcement, signature verification, aggregation). The REST handlers, the MCP
// server, the worker, and the dev driver all call these; they never diverge.
import { sql } from "../db/client.ts";
import { hashKey } from "../lib/keys.ts";
import { verifySubmissionSignature } from "../lib/signing.ts";

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

// ── Reads ─────────────────────────────────────────────────────────────────
export async function getMembers() {
  return sql`SELECT id, status, name, tagline, lens, mandate, operator
             FROM committee_members WHERE status = 'active' ORDER BY id`;
}
export async function getMember(id: string) {
  const r = await sql`SELECT id, status, name, tagline, lens, mandate, operator FROM committee_members WHERE id = ${id}`;
  return r[0] ?? null;
}
export async function getSubject(id: string) {
  const r = await sql`SELECT id, status, name, operator, thesis_blurb, wallets, recommendation_type FROM committee_subjects WHERE id = ${id}`;
  return r[0] ?? null;
}

// Calendar date → 'YYYY-MM-DD' (postgres.js returns `date` columns as Date objects).
const day = (d: unknown) => (d == null ? null : typeof d === "string" ? d.slice(0, 10) : new Date(d as any).toISOString().slice(0, 10));

export async function getSubjectSnapshots(id: string) {
  const rows = await sql`SELECT id, subject_id, date, total_value_usd, positions, wallets, notable
                         FROM committee_subject_snapshots WHERE subject_id = ${id} ORDER BY date DESC`;
  return rows.map((r: any) => ({ ...r, date: day(r.date) }));
}

export async function listSessions() {
  const rows = await sql`SELECT id, date, subject_id, subject_name, state, window_closes_at, published_at, generated_at
             FROM committee_sessions ORDER BY date DESC, generated_at DESC`;
  return rows.map((r: any) => ({ ...r, date: day(r.date) }));
}

export async function getOpenSession() {
  const r = await sql`SELECT id, date, subject_id, subject_name, state, window_closes_at
                      FROM committee_sessions WHERE state = 'collecting'
                      ORDER BY generated_at DESC LIMIT 1`;
  return r[0] ?? null;
}

export async function getSession(date: string, subjectId: string) {
  const s = (await sql`SELECT * FROM committee_sessions WHERE date = ${date} AND subject_id = ${subjectId}`)[0];
  if (!s) return null;
  const takes = await sql`
    SELECT r.id, r.member_id, m.name AS member_name, r.stance, r.confidence, r.body,
           r.memo_url, r.verified, r.received_at
    FROM committee_recommendations r
    JOIN committee_members m ON m.id = r.member_id
    WHERE r.session_id = ${s.id} ORDER BY r.received_at`;
  return { session: { ...s, date: day(s.date) }, takes };
}

export async function getBrief(date: string, subjectId: string) {
  const r = await sql`SELECT id, date, subject_id, body, created_at FROM committee_briefs
                      WHERE date = ${date} AND subject_id = ${subjectId} ORDER BY created_at DESC LIMIT 1`;
  return r[0] ?? null;
}

// ── Submit (verify identity + window + signature + nonce) ───────────────────
export interface SubmissionInput {
  memberId: string; date: string; subjectId: string; nonce: string;
  stance: string; confidence: number; body?: string; memoUrl?: string; signature: string;
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
    return { ok: true, status: 201, recommendationId: rows[0].id, verified: true };
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
export interface ApplyInput { memberId: string; name: string; lens?: string; publicKey: string; contact?: string }

export async function applyMember(input: ApplyInput) {
  // CREATE-ONLY: a memberId is first-come. If it already exists (in ANY state),
  // refuse — re-apply and key rotation are privileged admin operations. This
  // prevents an unauthenticated caller from overwriting a pending applicant's
  // key/identity (which the admin would then activate).
  const existing = (await sql`SELECT id FROM committee_members WHERE id = ${input.memberId}`)[0] as { id: string } | undefined;
  if (existing) return { ok: false, status: 409, error: "memberId already registered; re-apply or key rotation requires admin" };

  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO committee_members (id, status, name, lens, contact_email, applied_at)
               VALUES (${input.memberId}, 'applied', ${input.name}, ${input.lens ?? null}, ${input.contact ?? null}, now())`;
      await tx`INSERT INTO committee_member_keys (member_id, public_key, active) VALUES (${input.memberId}, ${input.publicKey}, false)`;
      await tx`INSERT INTO committee_applications (member_id, payload, status) VALUES (${input.memberId}, ${tx.json(input as any)}, 'pending')`;
      // actor is the request source, NOT the self-asserted body identity.
      await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('public:apply', 'apply', ${tx.json({ memberId: input.memberId })})`;
    });
  } catch (e: any) {
    if (String(e?.message ?? e).includes("duplicate") || e?.code === "23505")
      return { ok: false, status: 409, error: "memberId already registered" };
    throw e;
  }
  return { ok: true, status: 201, memberStatus: "applied" as const };
}

// Admin-only. Transactional: locks the member + its pending key, activates that
// exact key, binds an unguessable bearer (only its hash stored), and only then
// flips the member active — so a concurrent /apply cannot strand activation.
export async function activateMember(memberId: string) {
  return await sql.begin(async (tx) => {
    const existing = (await tx`SELECT id FROM committee_members WHERE id = ${memberId} FOR UPDATE`)[0] as { id: string } | undefined;
    if (!existing) return { ok: false, status: 404, error: "no such applicant" };
    const key = (await tx`SELECT id FROM committee_member_keys WHERE member_id = ${memberId} AND active = false ORDER BY created_at DESC LIMIT 1 FOR UPDATE`)[0] as { id: number } | undefined;
    if (!key) return { ok: false, status: 409, error: "no pending key; member must apply first" };
    const token = `tok_${memberId}_${crypto.randomUUID()}`;
    const upd = await tx`UPDATE committee_member_keys SET active = true, token_hash = ${hashKey(token)} WHERE id = ${key.id} AND active = false RETURNING id`;
    if (upd.length === 0) return { ok: false, status: 409, error: "activation raced; retry" };
    await tx`UPDATE committee_members SET status = 'active', activated_at = now() WHERE id = ${memberId}`;
    await tx`UPDATE committee_applications SET status = 'approved', reviewed_at = now() WHERE member_id = ${memberId} AND status = 'pending'`;
    await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'activate_member', ${tx.json({ memberId })})`;
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
  await sql`INSERT INTO committee_members (id, status, name, lens)
            VALUES (${input.memberId}, 'active', ${input.name}, ${input.lens ?? null})
            ON CONFLICT (id) DO UPDATE SET status = 'active', name = EXCLUDED.name, lens = EXCLUDED.lens`;
  await sql`DELETE FROM committee_member_keys WHERE member_id = ${input.memberId}`;
  await sql`INSERT INTO committee_member_keys (member_id, public_key, token_hash)
            VALUES (${input.memberId}, ${input.publicKey}, ${hashKey(token)})`;
  return { memberId: input.memberId, token };
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
  const body = { regime, subject: await getSubject(s.subject_id), recentSessions: recent, previousSession, researchSignals };
  await sql`INSERT INTO committee_briefs (date, subject_id, body) VALUES (${s.date}, ${s.subject_id}, ${sql.json(body)})
            ON CONFLICT (date, subject_id) DO UPDATE SET body = EXCLUDED.body`;
  const closes = new Date(Date.now() + windowMinutes * 60_000);
  await sql`UPDATE committee_sessions SET state = 'collecting', window_closes_at = ${closes} WHERE id = ${sessionId}`;
  return { sessionId, state: "collecting", windowClosesAt: closes.toISOString() };
}

export async function closeWindow(sessionId: string) {
  await sql`UPDATE committee_sessions SET state = 'window_closed' WHERE id = ${sessionId} AND state = 'collecting'`;
  return { sessionId, state: "window_closed" };
}

// Deterministic rollup over the takes ACTUALLY posted. Members with no take are
// recorded as absent — never fabricated.
export async function aggregateSession(sessionId: string) {
  const s = (await sql`SELECT * FROM committee_sessions WHERE id = ${sessionId}`)[0];
  const takes = await sql`SELECT member_id, stance, confidence FROM committee_recommendations WHERE session_id = ${sessionId}`;
  const activeMembers = await sql`SELECT id FROM committee_members WHERE status = 'active'`;
  const submitted = new Set(takes.map((t: any) => t.member_id));
  const absent = activeMembers.map((m: any) => m.id).filter((id: string) => !submitted.has(id));

  const byStance: Record<string, number> = {};
  let confSum = 0;
  for (const t of takes) {
    byStance[t.stance] = (byStance[t.stance] ?? 0) + 1;
    confSum += Number(t.confidence ?? 0);
  }
  const participation = activeMembers.length ? takes.length / activeMembers.length : 0;
  const rec = {
    quorum: { active: activeMembers.length, submitted: takes.length, absent: absent.length, participation },
    stances: byStance,
    meanConfidence: takes.length ? confSum / takes.length : null,
    absent,
  };
  const synthesis = `Committee session for ${s.subject_name}: ${takes.length}/${activeMembers.length} members submitted. ` +
    Object.entries(byStance).map(([k, v]) => `${v} ${k}`).join(", ") + (absent.length ? `; ${absent.length} absent.` : ".");
  await sql`UPDATE committee_sessions SET state = 'aggregated', committee_recommendation = ${sql.json(rec)}, synthesis = ${synthesis} WHERE id = ${sessionId}`;
  return { sessionId, state: "aggregated", ...rec };
}

export async function publishSession(sessionId: string) {
  await sql`UPDATE committee_sessions SET state = 'published', published_at = now() WHERE id = ${sessionId}`;
  return { sessionId, state: "published" };
}

// ── Memos ───────────────────────────────────────────────────────────────────
export async function postMemo(token: string, input: { sessionId: number; title?: string; body: string }) {
  const memberId = await memberIdForToken(token);
  if (!memberId) return { ok: false, status: 401, error: "unknown member token" };
  const rows = await sql`
    INSERT INTO committee_memos (member_id, session_id, title, body)
    VALUES (${memberId}, ${input.sessionId}, ${input.title ?? ""}, ${input.body})
    RETURNING id`;
  const id = rows[0].id;
  return { ok: true, status: 201, id, url: `/api/committee/memos/${id}` };
}

export async function getMemo(id: number) {
  const r = (await sql`SELECT id, member_id, session_id, title, body, created_at
                       FROM committee_memos WHERE id = ${id}`)[0] ?? null;
  if (!r) return null;
  return { ...r, created_at: r.created_at?.toISOString?.() ?? r.created_at };
}
