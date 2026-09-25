// Public judgement records: a judgement is its own public record with its own
// page, like a take, and a session judged by several judges shows each judge's
// opinion (operators who run a judge want to find theirs).
//
// READ ONLY, AND NO MIGRATION. Everything here reads `swarm_session_judgements`
// (migrations 0039/0040/0041/0043) as it already stands. The privileged
// `GET /api/swarm/admin/sessions/:id/judgements` (admin.ts) stays the full
// record; this module serves the subset that is public.
//
// WHAT IS PUBLIC — ONE RULE, spelled once below and used by all three reads:
//
//   1. `mode = 'enforce'`. A `shadow` opinion is model-authored prose about
//      named members that the mode exists to keep off public surfaces
//      (docs/decisions.md D42, "A soak nobody can read is not a soak"). Serving
//      it here would publish, through the read path, what the mode withholds.
//   2. `applied`. The opinion actually reached the session (issue #767). An
//      `enforce` row that lost the race to a publish never did, so it is no
//      more public than a shadow one. (Migration 0041's CHECK already refuses
//      a shadow row that claims `applied`, so (2) implies (1) today; (1) is
//      still spelled out because it is the rule, not a consequence of one.)
//   3. The session is `published`. Before that the swarm has not spoken, and a
//      judgement of an unpublished session is an opinion about work in progress.
//   4. The NEWEST such row per judging party (`judged_by`). A party that was
//      re-judged before publication (`force`) replaced its own opinion; the
//      earlier one never stood on a published session.
//
// Once a session is published no new row can satisfy (2): applyOpinion()
// refuses a terminal session and the INSERT records `applied = false`. So the
// public set of a published session is fixed, and a judgement permalink that
// answers once keeps answering.
import type { SwarmJudgement } from "@robotmoney/contract";
import { sql } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";
import { getMember, parseSessionsLimit } from "./domain.ts";
import { toPublicJudgement } from "./projections.ts";

// Registered queries (smoke-production-spec.md §7.1), all reads, all reached
// only through the public swarm routes. The public-set read joins the
// session, so it declares both relations.
const SWARM_ROUTE = "src/api/routes/swarm";
const SAMPLE_SESSION = "00000000-0000-0000-0000-000000000000";

const publicJudgementRows = registerQuery({
  role: "rm_app",
  object: "swarm_session_judgements",
  privileges: ["SELECT"],
  site: "src/swarm/judgements:publicJudgements.judgements",
  purpose: "Read the newest applied enforce judgement per (session, judging party), for the public judgement reads.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT DISTINCT ON (j.session_id, j.judged_by)
             j.id, j.session_id, j.judged_by, j.judged_by_member_id, j.source, j.model,
             j.prompt_hash, j.inputs_digest, j.opinion, j.created_at
      FROM swarm_session_judgements j
      WHERE j.mode = 'enforce' AND j.applied AND j.session_id = $1::uuid
      ORDER BY j.session_id, j.judged_by, j.id DESC`,
    params: [SAMPLE_SESSION],
  },
});

const publicJudgementSessions = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/judgements:publicJudgements.sessions",
  purpose: "Join each judgement's published session, its subject and whether its recommendation weights.",
  callers: [SWARM_ROUTE],
  probe: {
    statement: `SELECT s.id, s.subject_id, s.date, s.swarm_recommendation FROM swarm_sessions s
      WHERE s.id = $1::uuid AND s.state = 'published'`,
    params: [SAMPLE_SESSION],
  },
});

const sessionExists = registerQuery({
  role: "rm_app",
  object: "swarm_sessions",
  privileges: ["SELECT"],
  site: "src/swarm/judgements:getSessionJudgements.session",
  purpose: "Tell a missing session (404) from one with no public judgement yet (an empty list).",
  callers: [SWARM_ROUTE],
  probe: { statement: "SELECT 1 FROM swarm_sessions WHERE id = $1::uuid", params: [SAMPLE_SESSION] },
});

/** Which whole (session, party) groups a public read covers. */
type JudgementScope =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "judgement"; readonly id: string }
  | { readonly kind: "member"; readonly memberId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `id` is a bigserial. Capped at 18 digits so a pasted over-long id is a 404,
// not a bigint-range error surfacing as a 500.
const JUDGEMENT_ID_RE = /^\d{1,18}$/;

/**
 * The public rule above, narrowed by `scope` BEFORE the one-per-party cut. Every
 * `scope` below is a subset of whole (session, party) groups — one session, one
 * party, or one row's own (session, party) — so narrowing first cannot change
 * which row wins a group. Newest first, by `id`: the bigserial is drawn inside
 * the judge's advisory lock, so it is the order the rows were written in
 * (domain.ts's listJudgements makes the same argument against
 * `created_at`).
 */
async function publicJudgements(scope: JudgementScope, limit?: number): Promise<SwarmJudgement[]> {
  // The scope is written INLINE, one fragment per kind, so the whole
  // statement — every relation it reads included — is the one registered
  // statement above rather than a template assembled elsewhere.
  const rows = await on(sql, publicJudgementRows, publicJudgementSessions)`
    SELECT * FROM (
      SELECT DISTINCT ON (j.session_id, j.judged_by)
             j.id, j.session_id, j.judged_by, j.judged_by_member_id, j.source, j.model,
             j.prompt_hash, j.inputs_digest, j.opinion, j.created_at,
             s.subject_id, s.date AS session_date,
             -- Whether the session's recommendation set weights: only then has
             -- the judge's call a target to update (a session that published
             -- none, or a portfolio review, has nothing to update). A live
             -- aggregate stores its averaged vector as an array, a v0 session
             -- as an object; CASE, because AND does not fix evaluation order
             -- and jsonb_array_length throws on an object.
             COALESCE(s.swarm_recommendation->>'type' = 'bucket_weights', false)
               AND CASE jsonb_typeof(s.swarm_recommendation->'weights')
                     WHEN 'array' THEN jsonb_array_length(s.swarm_recommendation->'weights') > 0
                     WHEN 'object' THEN s.swarm_recommendation->'weights' <> '{}'::jsonb
                     ELSE false
                   END AS recommends_weights
        FROM swarm_session_judgements j
        JOIN swarm_sessions s ON s.id = j.session_id
       WHERE j.mode = 'enforce' AND j.applied AND s.state = 'published'
         AND ${scope.kind === "session"
           ? sql`j.session_id = ${scope.sessionId}`
           : scope.kind === "member"
             ? sql`j.judged_by = ${scope.memberId}`
             : sql`(j.session_id, j.judged_by) = (SELECT session_id, judged_by FROM swarm_session_judgements WHERE id = ${scope.id})`}
       ORDER BY j.session_id, j.judged_by, j.id DESC
    ) public_judgements
    ORDER BY id DESC
    ${limit == null ? sql`` : sql`LIMIT ${limit}`}`;
  return rows.map(toPublicJudgement);
}

/**
 * GET /api/swarm/sessions/:id/judgements. `null` (404) only when there is no
 * such session; an unpublished session answers an empty list, because the
 * session itself is public at every state and its judgements are not yet.
 */
export async function getSessionJudgements(sessionId: string): Promise<{ judgements: SwarmJudgement[] } | null> {
  // uuid column: a non-uuid handle would make Postgres throw rather than miss
  // (same screen as getSessionById).
  if (!UUID_RE.test(sessionId)) return null;
  const [session] = await on(sql, sessionExists)`SELECT 1 FROM swarm_sessions WHERE id = ${sessionId}`;
  if (!session) return null;
  return { judgements: await publicJudgements({ kind: "session", sessionId }) };
}

/**
 * GET /api/swarm/judgements/:id. `null` (404) unless the session route above
 * would serve this exact row — a shadow row, an unapplied row, a row on an
 * unpublished session and a row its own party later replaced all 404 alike, so
 * the response never says which of them an id is.
 */
export async function getPublicJudgement(id: string): Promise<SwarmJudgement | null> {
  if (!JUDGEMENT_ID_RE.test(id)) return null;
  // Scoped to this row's own (session, party) group, then the winner must BE
  // this row.
  const [winner] = await publicJudgements({ kind: "judgement", id });
  return winner && winner.id === id ? winner : null;
}

/**
 * GET /api/swarm/members/:id/judgements. Mirrors getMemberTakes(): the public
 * reference (handle or legacy id) resolves through the one shared resolver, an
 * unknown member is an empty list rather than a 404, and `limit` is the same
 * explicit-or-default, 1..100, 400-on-invalid convention (parseSessionsLimit).
 * Keyed on `judged_by`, which holds the immutable member id for every
 * member-authored row (migration 0043's CHECK pins it equal to
 * `judged_by_member_id`).
 */
export async function getMemberJudgements(memberRef: string, limit?: number): Promise<{ judgements: SwarmJudgement[] }> {
  const capped = parseSessionsLimit(limit);
  const member = await getMember(memberRef);
  if (!member) return { judgements: [] };
  return { judgements: await publicJudgements({ kind: "member", memberId: member.id }, capped) };
}
