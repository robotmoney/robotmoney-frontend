// AC-FE-10 — "an eligible session that fails to produce a receipt cannot
// disappear silently", asked as a question about SESSIONS rather than about the
// judge lane.
//
// WHY THIS MODULE EXISTS. v0.5.0-rc.1 monitored `swarm.judge` (admin/overview.ts
// JUDGE_KIND), and that alert is correct and worth keeping: while the lane is
// broken it says so. It just cannot answer the criterion, because it is an
// alert about the LANE. The staging run of 1.13 N5 demonstrated the whole gap
// in nine minutes:
//
//   * the credential was removed, `swarm.judge` degraded three times, and the
//     lane alert fired;
//   * session 157777c9 (3 verified takes, eligible) reached `aggregated` with
//     no judgement;
//   * `worker/loop.ts` settles a job `succeeded` once its retries are
//     exhausted, so the session's judge job ended SUCCEEDED carrying
//     last_error `judge_unavailable`;
//   * `publishConsensusReceiptAdmin` then refused with `not_judged`, which is
//     the FIRST entry in EXPECTED_RECEIPT_REFUSALS (because the shipped `off`
//     default must not paint every publish red), so the publish job also ended
//     successful;
//   * the credential was restored, the next session judged fine, and the lane
//     alert CLEARED — leaving one published, receiptless session, 404 at its
//     public URL, named by nothing.
//
// Grepping the whole backend at that commit, the only read of
// `swarm_consensus_receipts` outside its writer was the single-session lookup
// in consensus-receipt.ts. No query anywhere asked which PUBLISHED, ELIGIBLE
// sessions have no receipt. This is that query.
//
// DURABLE BY CONSTRUCTION, not by writing a row. The signal is DERIVED from
// state that persists — the session, its takes, and the absence of a receipt —
// so it survives a restart, a lane recovery and a later healthy run, and it
// clears exactly when the criterion says it should ("a later successful
// publication resolves it"): the moment the receipt row exists, the session
// stops matching. An event row would need a migration, a writer at every
// refusal site, and its own resolution path — three more places to be wrong
// about the same fact.
import { sql as defaultSql, type DbHandle } from "../db/client.ts";

/**
 * How far back to look. A published session that has been receiptless for a
 * week is a historical fact an operator has already seen or decided to ignore;
 * the alert is for the ones still worth acting on, and an unbounded scan would
 * make every pre-Fusion session permanently red the day the judge is turned on.
 */
export const MISSING_RECEIPT_LOOKBACK_DAYS = 7;

/** How many sessions the report names individually before it just counts. */
export const MISSING_RECEIPT_REPORT_LIMIT = 20;

export type MissingReceiptTrigger = "eligible_take_count" | "judge_lane_failure";

export interface MissingReceiptSession {
  sessionId: string;
  subjectId: string;
  publishedAt: string;
  /** Verified takes on file — the number compared against `minTakesApplied`. */
  takeCount: number;
  /**
   * The threshold and mode THAT APPLIED TO THIS SESSION, not today's.
   *
   * Read off the session's own `swarm_session_judgements` row when it has one
   * (it records both, at the moment the judging happened), and off the live
   * config only for a session that was never judged. See the eligibility
   * comment on `detectMissingReceiptSessions` for why a live-config-only test
   * hands an operator a lever that retracts the alert.
   */
  minTakesApplied: number;
  judgeModeApplied: string;
  /** Which clause named this session — the take count, or its own judge failure. */
  trigger: MissingReceiptTrigger;
  /**
   * The session's OWN `swarm.judge` job outcome, which is how "the judge is
   * off, as configured" is told apart from "the judge was on, was asked N
   * times, and never answered". `worker/loop.ts` settles an exhausted degrade
   * `succeeded`, so the status alone cannot say it — `last_error` can.
   */
  judgeJobStatus: string | null;
  judgeJobAttempts: number | null;
  judgeLastError: string | null;
}

export interface MissingReceiptReport {
  /** The judge mode as CONFIGURED NOW — context for the reader, not the test. */
  judgeMode: string;
  /** The configured minimum take count NOW — likewise context, not the test. */
  minTakes: number;
  lookbackDays: number;
  sessions: MissingReceiptSession[];
  /** Total matches, which may exceed `sessions.length` (see the limit above). */
  count: number;
}

/**
 * Published sessions that lost a consensus receipt they could have had.
 *
 * THE ELIGIBILITY TEST IS THE CRITERION'S OWN. AC-FE-10 requires that "no
 * scheduled work" be distinguished from "missing/failed publication", and
 * `swarm_judge_config.min_takes` is where the product draws that line: the
 * receipt's own `release_safety.min_takes` records it. A zero-take session is
 * correctly NOT reported — it is the `nothing_to_judge` case, and the N5
 * staging run had one (b1d5242d, robotmoney-allocation, zero takes) sitting
 * beside the real failure as a live control.
 *
 * BUT THE TEST MUST NOT BE TODAY'S CONFIG, and that is the RC2 correction.
 * v0.5.0-rc.2's first cut read `mode` and `min_takes` LIVE and compared every
 * session against them. Because the signal is derived rather than recorded,
 * that made two ordinary operator actions into silent retractions of an alert
 * about a permanent loss:
 *
 *   * raising `min_takes` (the same admin patch path the release runbook uses)
 *     dropped a session that is still receiptless, with nothing left behind;
 *   * setting `mode: off` did the same, wholesale.
 *
 * "Cannot disappear silently" has to survive an unrelated config change, so
 * the question is asked of the session, three ways:
 *
 *   1. THE APPLIED THRESHOLD, NOT THE CURRENT ONE. A session that was judged
 *      carries the mode and the `min_takes` that applied to it in its own
 *      `swarm_session_judgements` row. That row is append-only, so it cannot
 *      be moved by a later patch. The live config is consulted only for a
 *      session that has no judgement at all.
 *   2. ITS OWN JUDGE FAILURE IS DURABLE EVIDENCE IN ITS OWN RIGHT. A session
 *      whose `swarm.judge` job recorded a `last_error` was ASKED and never
 *      answered — that is the 1.13 N5 loss exactly, and it has no judgement
 *      row to carry a threshold. It is named whatever the take count is
 *      against today's `min_takes`, so raising the threshold cannot retract
 *      it. `worker/loop.ts` settles an exhausted degrade `succeeded`, so the
 *      job STATUS says nothing and `last_error` is the fact that survives.
 *   3. TODAY'S CONFIG MAY ONLY VOUCH FOR A SESSION IT PREDATES. When
 *      `swarm_judge_config.updated_at` is LATER than the session's
 *      `published_at`, the mode on file is not the mode that applied, and it
 *      is trusted in NEITHER direction for a never-judged session: it may not
 *      silence one that carries its own judge failure, and it may not flag one
 *      that carries none. That closes the `mode: off` lever without inventing
 *      a row — an operator turning the judge off after a loss moves
 *      `updated_at`, and the loss keeps its name — while also keeping the
 *      opposite case quiet: turning the judge ON does not retro-flag every
 *      session published while it was off.
 *
 * RESIDUAL, RECORDED RATHER THAN HIDDEN. A never-judged session with NO judge
 * failure of its own stops being named if the config is touched after it
 * published. There is no durable record anywhere of the mode that applied to
 * such a session, and it is unreachable in practice: a session that lost a
 * receipt under `enforce` has either a judgement row (clause 1, immune) or a
 * failed judge job (clause 2, immune). Closing it completely needs a written
 * row at the moment of loss — a migration, a writer at every refusal site, and
 * its own resolution path — which is the trade this module's header declines.
 *
 * A JUDGE IN `off` OR `shadow` REPORTS NOTHING, and `shadow` is the other RC2
 * correction. The first cut suppressed only `off`, which made every eligible
 * session in `shadow` permanently red — in `shadow` a judgement is withheld
 * from the session BY DESIGN (`judge-session.ts`: "SHADOW NEVER APPLIES"), so
 * `publishConsensusReceiptAdmin` refuses with `judgement_not_adopted`, which
 * `worker/handlers/swarm.ts` lists as a benign refusal for exactly that
 * reason. A receipt is unreachable in `off` and in `shadow` alike, and an
 * alert that fires on a control working as designed buries the ones that mean
 * something — this module's own rule, applied to the mode it missed.
 */
export async function detectMissingReceiptSessions(
  db: DbHandle = defaultSql,
  now: Date = new Date(),
  lookbackDays: number = MISSING_RECEIPT_LOOKBACK_DAYS,
): Promise<MissingReceiptReport> {
  const cfg = (await db`SELECT mode, min_takes, updated_at FROM swarm_judge_config WHERE id = 1`)[0] as
    | { mode: string; min_takes: number; updated_at: Date | string | null }
    | undefined;
  const judgeMode = cfg?.mode ?? "off";
  const minTakes = Number(cfg?.min_takes ?? 3);

  const since = new Date(now.getTime() - lookbackDays * 86_400_000);
  const rows = (await db`
    WITH cfg AS (SELECT mode, min_takes, updated_at FROM swarm_judge_config WHERE id = 1),
    candidate AS (
      SELECT s.id, s.subject_id, s.published_at, t.take_count,
             j.status AS judge_status, j.attempts AS judge_attempts, j.last_error AS judge_last_error,
             COALESCE(g.mode, c.mode) AS mode_applied,
             COALESCE(g.min_takes, c.min_takes)::int AS min_takes_applied,
             -- The session carries its OWN record of what applied to it.
             (g.mode IS NOT NULL) AS was_judged,
             -- Durable, per-session evidence that the judge was asked and never
             -- answered. worker/loop.ts settles an exhausted degrade succeeded,
             -- so the STATUS says nothing and last_error is what survives.
             (j.last_error IS NOT NULL AND btrim(j.last_error) <> '') AS judge_failed,
             -- Today's config may only speak for a session it predates.
             (COALESCE(c.updated_at, to_timestamp(0)) <= s.published_at) AS config_predates
        FROM swarm_sessions s
        CROSS JOIN cfg c
        JOIN LATERAL (
          SELECT count(DISTINCT r.member_id)::int AS take_count
            FROM swarm_recommendations r
           WHERE r.session_id = s.id AND r.verified
        ) t ON true
        LEFT JOIN LATERAL (
          SELECT status, attempts, last_error FROM jobs
           WHERE kind = 'swarm.judge' AND scope_type = 'swarm_session' AND scope_id = s.id::text
           ORDER BY id DESC LIMIT 1
        ) j ON true
        -- THE SESSION'S OWN RECORD OF WHAT APPLIED TO IT. An enforce row is
        -- preferred over a later shadow one: enforce is the mode under which a
        -- receipt was reachable, and a session judged both ways (shadow soak,
        -- then enforce) really did lose a receipt it could have had.
        LEFT JOIN LATERAL (
          SELECT mode, min_takes FROM swarm_session_judgements
           WHERE session_id = s.id
           ORDER BY (mode = 'enforce') DESC, id DESC LIMIT 1
        ) g ON true
       WHERE s.state = 'published'
         AND s.published_at IS NOT NULL
         AND s.published_at >= ${since}
         -- A zero-take session is the criterion's own "no scheduled work"
         -- control and is never reported.
         AND t.take_count >= 1
         AND NOT EXISTS (SELECT 1 FROM swarm_consensus_receipts rc WHERE rc.session_id = s.id)
    )
    SELECT *,
           (mode_applied = 'enforce' AND take_count >= min_takes_applied
            AND (was_judged OR config_predates)) AS elig_takes
      FROM candidate
     WHERE
       -- (1) THE MODE AND THRESHOLD THAT APPLIED made a receipt reachable and
       --     this session met it. Off a judgement row those are the session's
       --     own recorded values and no later patch can move them; without one
       --     the live config decides, and only for a session it predates.
       (mode_applied = 'enforce' AND take_count >= min_takes_applied
        AND (was_judged OR config_predates))
       -- (2) OR its own judge job recorded a failure — evidence in its own
       --     right, independent of any threshold. Silenced only by a mode
       --     entitled to speak for this session, i.e. one already in force when
       --     it published. This is what keeps a loss named after min_takes is
       --     raised or the judge is switched off.
       OR (judge_failed AND (mode_applied = 'enforce' OR NOT config_predates))
     ORDER BY published_at DESC`) as unknown as {
      id: string; subject_id: string; published_at: Date | string; take_count: number;
      judge_status: string | null; judge_attempts: number | null; judge_last_error: string | null;
      mode_applied: string; min_takes_applied: number; elig_takes: boolean;
    }[];

  return {
    judgeMode,
    minTakes,
    lookbackDays,
    count: rows.length,
    sessions: rows.slice(0, MISSING_RECEIPT_REPORT_LIMIT).map((r) => ({
      sessionId: String(r.id),
      subjectId: String(r.subject_id),
      publishedAt: r.published_at instanceof Date ? r.published_at.toISOString() : String(r.published_at),
      takeCount: Number(r.take_count),
      minTakesApplied: Number(r.min_takes_applied),
      judgeModeApplied: String(r.mode_applied),
      // Which clause named it. The take-count clause is the ordinary one; the
      // judge-failure clause is the one that keeps a loss named after an
      // unrelated config change, so an operator can see which is speaking.
      trigger: r.elig_takes ? "eligible_take_count" : "judge_lane_failure",
      judgeJobStatus: r.judge_status ?? null,
      judgeJobAttempts: r.judge_attempts == null ? null : Number(r.judge_attempts),
      judgeLastError: r.judge_last_error ?? null,
    })),
  };
}

/**
 * One line per unreceipted session, for the alert feed. SESSION-SCOPED on
 * purpose: an operator reading "swarm.judge last run: degraded" learns that the
 * lane is unwell and nothing about which artifact was lost, and that line is
 * gone the moment the next session succeeds. This one names the session, stays
 * for as long as the receipt is missing, and carries the judge job's own
 * `last_error` so "the judge was asked and never answered" is distinguishable
 * from "the judge was never asked".
 */
export function describeMissingReceipt(s: MissingReceiptSession): string {
  const judged = s.judgeLastError
    ? `its swarm.judge job ended ${s.judgeJobStatus ?? "?"} after ${s.judgeJobAttempts ?? "?"} attempt(s) with last_error ${JSON.stringify(s.judgeLastError)}`
    : s.judgeJobStatus
      ? `its swarm.judge job ended ${s.judgeJobStatus} with no recorded error`
      : "it has no swarm.judge job on file";
  return `session ${s.sessionId} (${s.subjectId}) published ${s.publishedAt} with ${s.takeCount} verified take(s) ` +
    `(judge ${s.judgeModeApplied}, min_takes ${s.minTakesApplied} as applied to this session) and NO consensus receipt — ${judged}`;
}

/**
 * The session's OWN judge job, when it was ASKED and failed — the fact that
 * tells `not_judged because the judge is off` apart from `not_judged after the
 * judge lane exhausted its retries on this session`.
 *
 * Returns the recorded `last_error`, or null when the judge was never asked (no
 * job), was asked and succeeded, or is still to run. `worker/loop.ts` settles a
 * job `succeeded` once `max_attempts` is spent, so the STATUS cannot carry this
 * and the error column has to: in the 1.13 N5 run the session's judge job read
 * `SUCCEEDED, attempts 5, last_error judge_unavailable`, and every surface
 * downstream read the word "succeeded".
 *
 * No new state: this is the row `worker/loop.ts` already writes.
 */
export async function judgeLaneFailureFor(sessionId: string, db: DbHandle = defaultSql): Promise<string | null> {
  const row = (await db`
    SELECT last_error FROM jobs
     WHERE kind = 'swarm.judge' AND scope_type = 'swarm_session' AND scope_id = ${sessionId}
     ORDER BY id DESC LIMIT 1`)[0] as { last_error: string | null } | undefined;
  const lastError = row?.last_error == null ? "" : String(row.last_error).trim();
  return lastError === "" ? null : lastError;
}
