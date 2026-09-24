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
//   * `worker/loop.ts` settled a job `succeeded` once its retries were
//     exhausted, so the session's judge job ended SUCCEEDED carrying
//     last_error `judge_unavailable` (R16 has since made an exhausted degrade
//     settle `failed`; `last_error` is still the fact this module reads,
//     because it is the one that is true on BOTH sides of that change and on
//     every database written before it);
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
//
// NO QUEUE JOB IS READ ANY MORE (issue #1026). This module used to find a
// session's `swarm.judge` job to tell "the judge is off" apart from "the judge
// was asked and never answered". There is no such job now: the judge is a
// participant that subscribes over HTTP (smoke-production-spec.md §6.2), and
// the session itself records the answer. `judge_mode` is captured at turnover
// and `judging_outcome` is decided once by finalize (system-scheduler-spec.md
// §4.4), so a session published `no_consensus` is the durable, per-session
// record that its judge was asked and did not answer in time. A session that
// reached judging with no captured mode is read as `enforce` from its stored
// deadline, the same rule the three judging transitions apply.
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

export type MissingReceiptTrigger = "eligible_take_count" | "no_consensus";

export interface MissingReceiptSession {
  sessionId: string;
  subjectId: string;
  publishedAt: string;
  /** Verified takes on file — the number compared against `minTakesApplied`. */
  takeCount: number;
  /**
   * The threshold and mode THAT APPLIED TO THIS SESSION, not today's.
   *
   * The mode is read off the session's own record — a judgement row when it
   * has one, else the `judge_mode` it captured at turnover — and the threshold
   * off its judgement row. The live config is consulted only for what the
   * session never recorded. See the eligibility comment on
   * `detectMissingReceiptSessions` for why a live-config-only test hands an
   * operator a lever that retracts the alert.
   */
  minTakesApplied: number;
  judgeModeApplied: string;
  /** Which clause named this session — the take count, or its own `no_consensus` outcome. */
  trigger: MissingReceiptTrigger;
  /**
   * The judging outcome finalize recorded on the session (`judged`,
   * `no_consensus`, `not_judged`), or null for a session published outside the
   * epoch lifecycle. This is how "the judge is off" is told apart from "the
   * judge was asked and never answered".
   */
  judgingOutcome: string | null;
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
 * correctly NOT reported — it is the `nothing_to_judge` case.
 *
 * BUT THE TEST MUST NOT BE TODAY'S CONFIG, and that is the RC2 correction.
 * v0.5.0-rc.2's first cut read `mode` and `min_takes` LIVE and compared every
 * session against them, which made two ordinary operator actions — raising
 * `min_takes`, and setting `mode: off` — into silent retractions of an alert
 * about a permanent loss. "Cannot disappear silently" has to survive an
 * unrelated config change, so the question is asked of the session, three
 * ways:
 *
 *   1. THE APPLIED MODE AND THRESHOLD, NOT THE CURRENT ONES. A judged session
 *      carries both in its `swarm_session_judgements` row, and every epoch
 *      session carries the `judge_mode` it captured at turnover. Neither can be
 *      moved by a later patch. The live config is consulted only for what the
 *      session never recorded.
 *   2. ITS OWN `no_consensus` IS DURABLE EVIDENCE IN ITS OWN RIGHT. A session
 *      finalized `no_consensus` under `enforce` was ASKED to be judged and got
 *      no eligible consensus by its deadline. It is named whatever the take
 *      count is against today's `min_takes`, so raising the threshold cannot
 *      retract it.
 *   3. TODAY'S CONFIG MAY ONLY VOUCH FOR A SESSION IT PREDATES. When the
 *      policy stamp (`policy_updated_at`) is LATER than the session's
 *      `published_at` and the session recorded no mode of its own, the mode on
 *      file is not the mode that applied, and it is trusted in NEITHER
 *      direction: it may not silence a session carrying its own `no_consensus`,
 *      and it may not flag one carrying nothing. Turning the judge ON does not
 *      retro-flag every session published while it was off.
 *
 * A JUDGE IN `off` REPORTS NOTHING: a receipt is unreachable by construction,
 * and an alert that fires on a control working as designed buries the ones that
 * mean something.
 */
export async function detectMissingReceiptSessions(
  db: DbHandle = defaultSql,
  now: Date = new Date(),
  lookbackDays: number = MISSING_RECEIPT_LOOKBACK_DAYS,
): Promise<MissingReceiptReport> {
  const cfg = (await db`SELECT mode, min_takes, updated_at FROM swarm_judge_config WHERE id = 1`)[0] as
    | { mode: string; min_takes: number; updated_at: Date | string | null }
    | undefined;
  // A legacy `shadow` is `off` for every purpose (D53).
  const judgeMode = cfg?.mode === "enforce" ? "enforce" : "off";
  const minTakes = Number(cfg?.min_takes ?? 3);

  const since = new Date(now.getTime() - lookbackDays * 86_400_000);
  const rows = (await db`
    WITH cfg AS (SELECT mode, min_takes, policy_updated_at FROM swarm_judge_config WHERE id = 1),
    candidate AS (
      SELECT s.id, s.subject_id, s.published_at, s.judging_outcome, t.take_count,
             -- A STORED DEADLINE IS A RECORD OF THE MODE. requestJudging writes
             -- it only for a session not captured as off, so a session that
             -- reached judging without a turnover (judge_mode NULL, the
             -- legacy close route) was judged under enforce by the same rule
             -- requestJudging, submitJudgement and finalizeEpoch all apply.
             COALESCE(g.mode, s.judge_mode,
                      CASE WHEN s.judging_deadline_at IS NOT NULL THEN 'enforce' END,
                      c.mode) AS mode_applied,
             COALESCE(g.min_takes, c.min_takes)::int AS min_takes_applied,
             -- The session carries its OWN record of the mode that applied.
             (g.mode IS NOT NULL OR s.judge_mode IS NOT NULL OR s.judging_deadline_at IS NOT NULL) AS carries_mode,
             -- Durable, per-session evidence that the judge was asked and gave
             -- no eligible consensus: finalize's own recorded outcome. Finalize
             -- decides no_consensus only on the non-off branch, so the
             -- outcome alone is the evidence; the mode test only keeps an
             -- explicitly off row out.
             (s.judge_mode IS DISTINCT FROM 'off' AND s.judging_outcome = 'no_consensus') AS judge_failed,
             -- Today's config may only speak for a session it predates, and
             -- "today's config" means the POLICY — mode and min_takes.
             -- policy_updated_at (migration 0057) moves only when one of those
             -- two columns actually changed value.
             (COALESCE(c.policy_updated_at, to_timestamp(0)) <= s.published_at) AS config_predates
        FROM swarm_sessions s
        CROSS JOIN cfg c
        JOIN LATERAL (
          SELECT count(DISTINCT r.member_id)::int AS take_count
            FROM swarm_recommendations r
           WHERE r.session_id = s.id AND r.verified
        ) t ON true
        -- THE SESSION'S OWN JUDGEMENT RECORD. An enforce row is preferred over
        -- a historical shadow one: enforce is the mode under which a receipt
        -- was reachable.
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
    ),
    -- (1) THE MODE AND THRESHOLD THAT APPLIED made a receipt reachable and this
    --     session met it. COMPUTED ONCE: this predicate is both a filter and
    --     the reported trigger, so it is one CTE column read by both.
    scored AS (
      SELECT *,
             (mode_applied = 'enforce' AND take_count >= min_takes_applied
              AND (carries_mode OR config_predates)) AS elig_takes
        FROM candidate
    )
    SELECT * FROM scored
     WHERE elig_takes
       -- (2) OR its own no_consensus under enforce — evidence in its own
       --     right, independent of any threshold, and recorded on the session
       --     so no later config change can move it.
       OR judge_failed
     ORDER BY published_at DESC`) as unknown as {
      id: string; subject_id: string; published_at: Date | string; take_count: number;
      judging_outcome: string | null; mode_applied: string; min_takes_applied: number; elig_takes: boolean;
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
      // `no_consensus` clause is the one that keeps a loss named after an
      // unrelated config change, so an operator can see which is speaking.
      trigger: r.elig_takes ? "eligible_take_count" : "no_consensus",
      judgingOutcome: r.judging_outcome ?? null,
    })),
  };
}

/**
 * One line per unreceipted session, for the alert feed. SESSION-SCOPED on
 * purpose: it names the session, stays for as long as the receipt is missing,
 * and carries the session's own judging outcome so "the judge was asked and
 * never answered" is distinguishable from "a consensus was recorded and the
 * receipt still did not publish".
 */
export function describeMissingReceipt(s: MissingReceiptSession): string {
  const judged = s.judgingOutcome === "no_consensus"
    ? "its judge was asked and no eligible consensus was recorded by the judging deadline (published no_consensus)"
    : s.judgingOutcome
      ? `its judging outcome was ${s.judgingOutcome}`
      : "it was published outside the epoch lifecycle, with no judging outcome recorded";
  return `session ${s.sessionId} (${s.subjectId}) published ${s.publishedAt} with ${s.takeCount} verified take(s) ` +
    `(judge ${s.judgeModeApplied}, min_takes ${s.minTakesApplied} as applied to this session) and NO consensus receipt — ${judged}`;
}