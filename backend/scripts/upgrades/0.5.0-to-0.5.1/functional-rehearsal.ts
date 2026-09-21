// The four functional acceptance criteria for v0.5.1, graded against the
// smoke-twin while it is still up.
//
// WHY THIS EXISTS, AND WHY POSTFLIGHT CANNOT ANSWER IT. v0.5.1 changes no
// schema, so every schema check it has is necessarily green before the release
// does anything. What the release actually claims is BEHAVIOURAL: sessions stop
// wedging, the ones that were wedged close, the scheduler starts convening
// again, and a full session can complete end to end. None of that is a fact
// about a row's existence — it is a fact about the system's movement over time,
// which is only observable by watching a live stack for a while. That is what
// the driver's `onReady` window is for (rollout-procedure.md G5/G8).
//
// THE BOUNDARY BETWEEN "RESTORED" AND "NEW" IS pg_postmaster_start_time().
// The twin's Postgres is created fresh per run and the dump is restored into
// it, so every production row predates the postmaster and every row this
// rehearsal produced follows it. That is exact, needs no snapshot taken at the
// right instant, and cannot be fooled by the driver having already driven the
// product (it runs `verify-live --tier full` BEFORE this hook) — those rows are
// correctly counted as new, because they are.
//
// EVERY CRITERION IS EVALUATED BY POLLING, AND A DEADLINE IS A FAILURE. G1: a
// check that cannot bound its own wait must say so rather than hold a metered
// stack open.

import type { Checker } from "../../lib/checks.ts";
import type { Db } from "../../lib/postflight-utils.ts";

/** Terminal session states. `swarm_sessions_state_check` (0039) allows
 *  scheduled/collecting/window_closed/aggregated/judged/published/cancelled;
 *  only the last two are ends. Everything else is a session still in flight —
 *  which is fine until its window has closed. */
const TERMINAL = ["published", "cancelled"] as const;

// THERE IS NO GRACE PERIOD, AND THAT IS THE POINT.
//
// An earlier revision of this file allowed a session 30 minutes past
// window_closes_at before counting it wedged, on the reasoning that the publish
// lane legitimately takes a few minutes. That reasoning smuggles the defect in:
// a grace period makes "closed late" indistinguishable from "never closed", and
// a wedge is exactly a session that is late forever. The window IS the
// prescribed time -- it is a timestamp the system chose for itself -- so the
// assertion is simply that every session past it is closed, compared against
// now() with nothing added.
//
// What absorbs a genuinely in-flight publish is the OBSERVATION WINDOW, not the
// assertion: the loop below re-evaluates until the condition holds or the
// deadline expires, so a session mid-publish just has to finish. A session that
// has not closed by the deadline has not "run a bit long" -- it is the wedge.

/** A schedule whose next_run_at is this far in the past is not merely late —
 *  it is the wedge shape #614's CLAMP exists to drain (see the scheduler-wedge
 *  history in rollout-procedure.md §9.2). */
const SCHEDULE_STALL_MINUTES = 30;

export interface FunctionalOptions {
  /** Ceiling on the whole observation. Must be < the driver's checkDeadlineMs. */
  deadlineMs: number;
  pollMs?: number;
  log: (m: string) => void;
}

interface Snapshot {
  bootAt: Date;
  /** Restored sessions whose window had already closed and were not terminal. */
  wedged: { id: string; state: string; subject: string }[];
  restoredOpen: number;
  newSessions: number;
}

async function readState(db: Db): Promise<{
  bootAt: Date;
  restoredWedged: { id: string; state: string; subject: string }[];
  overdue: { id: string; state: string; window_closes_at: Date; is_new: boolean; minutes_overdue: number }[];
  windowless: { id: string; state: string }[];
  restoredTotal: number;
  newSessions: { id: string; state: string; convened_at: Date }[];
  completed: { id: string; takes: number; judged_by: string | null; mode: string | null; source: string | null }[];
  stalledSchedules: { kind: string; next_run_at: Date | null }[];
  jobBacklog: number;
  deadJobs: number;
}> {
  const [{ boot_at: bootAt }] = (await db`
    SELECT pg_postmaster_start_time() AS boot_at
  `) as unknown as { boot_at: Date }[];

  // RESTORED = convened before the twin's postmaster existed.
  const restoredWedged = (await db`
    SELECT s.id::text AS id, s.state, coalesce(s.subject_name, s.subject_id) AS subject
      FROM swarm_sessions s
     WHERE s.convened_at < ${bootAt}
       AND s.state <> ALL(${[...TERMINAL]})
       AND s.window_closes_at IS NOT NULL
       AND s.window_closes_at < ${bootAt}
     ORDER BY s.convened_at
  `) as unknown as { id: string; state: string; subject: string }[];

  // EVERY session past its own prescribed close time, restored or new. No
  // grace, no exemption for rows this rehearsal created: the criterion is
  // "longer than the prescribed time ⇒ closed", and a session convened two
  // minutes ago whose window has already shut is as overdue as one from March.
  const overdue = (await db`
    SELECT s.id::text AS id, s.state, s.window_closes_at,
           (s.convened_at >= ${bootAt}) AS is_new,
           round(extract(epoch FROM (now() - s.window_closes_at)) / 60)::int AS minutes_overdue
      FROM swarm_sessions s
     WHERE s.state <> ALL(${[...TERMINAL]})
       AND s.window_closes_at IS NOT NULL
       AND s.window_closes_at < now()
     ORDER BY s.window_closes_at
  `) as unknown as { id: string; state: string; window_closes_at: Date; is_new: boolean; minutes_overdue: number }[];

  // A session with NO window has no prescribed time to be past, so it cannot be
  // graded by the rule above. Reported separately rather than silently dropped
  // from the population -- an unbounded session is its own question.
  const windowless = (await db`
    SELECT s.id::text AS id, s.state
      FROM swarm_sessions s
     WHERE s.state <> ALL(${[...TERMINAL]}) AND s.window_closes_at IS NULL
  `) as unknown as { id: string; state: string }[];

  const [{ count: restoredTotal }] = (await db`
    SELECT count(*)::int AS count FROM swarm_sessions WHERE convened_at < ${bootAt}
  `) as unknown as { count: number }[];

  const newSessions = (await db`
    SELECT id::text AS id, state, convened_at
      FROM swarm_sessions WHERE convened_at >= ${bootAt} ORDER BY convened_at
  `) as unknown as { id: string; state: string; convened_at: Date }[];

  // A session is COMPLETE, in this release's sense, when proposers submitted
  // verified takes for it AND a judge authored a judgement naming itself.
  // `verified` is the signature check (0004); `judged_by` is the judge identity
  // 0043 made non-null, so a row always names its author.
  const completed = (await db`
    SELECT s.id::text AS id,
           (SELECT count(*)::int FROM swarm_recommendations r
             WHERE r.session_id = s.id AND r.verified) AS takes,
           j.judged_by, j.mode, j.source
      FROM swarm_sessions s
      LEFT JOIN LATERAL (
        SELECT judged_by, mode, source FROM swarm_session_judgements
         WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1
      ) j ON true
     WHERE s.convened_at >= ${bootAt}
     ORDER BY s.convened_at
  `) as unknown as { id: string; takes: number; judged_by: string | null; mode: string | null; source: string | null }[];

  const stalledSchedules = (await db`
    SELECT kind, next_run_at FROM job_schedules
     WHERE enabled
       AND next_run_at IS NOT NULL
       AND next_run_at < now() - (${SCHEDULE_STALL_MINUTES} || ' minutes')::interval
     ORDER BY next_run_at
  `) as unknown as { kind: string; next_run_at: Date | null }[];

  const [{ count: jobBacklog }] = (await db`
    SELECT count(*)::int AS count FROM jobs
     WHERE status = 'pending' AND run_after < now() - interval '30 minutes'
  `) as unknown as { count: number }[];

  const [{ count: deadJobs }] = (await db`
    SELECT count(*)::int AS count FROM jobs
     WHERE status = 'dead' AND updated_at >= ${bootAt}
  `) as unknown as { count: number }[];

  return { bootAt, restoredWedged, overdue, windowless, restoredTotal, newSessions, completed, stalledSchedules, jobBacklog, deadJobs };
}

/**
 * Observe the booted twin until all four criteria hold, or the deadline.
 * Records one check per criterion. Returns nothing — the caller's `printVerdict`
 * decides the exit code, exactly as postflight does.
 */
export async function runFunctionalRehearsal(db: Db, { record }: Checker, opts: FunctionalOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 30_000;
  const startedAt = Date.now();

  const first = await readState(db);
  const snapshot: Snapshot = {
    bootAt: first.bootAt,
    wedged: first.restoredWedged,
    restoredOpen: first.overdue.filter((o) => !o.is_new).length,
    newSessions: first.newSessions.length,
  };
  opts.log(
    `baseline — twin postmaster ${snapshot.bootAt.toISOString()}; ${first.restoredTotal} restored session(s), ` +
      `${snapshot.wedged.length} of them past their close time and still open at boot; ` +
      `${snapshot.newSessions} session(s) already convened by this boot`,
  );
  for (const w of snapshot.wedged.slice(0, 10)) opts.log(`  wedged at baseline: ${w.id} state=${w.state} subject=${w.subject}`);

  let last = first;
  let met = false;
  for (;;) {
    last = await readState(db);
    const healed = snapshot.wedged.filter((w) => !last.overdue.some((o) => o.id === w.id)).length;
    const schedulersOk = last.stalledSchedules.length === 0 && last.jobBacklog === 0;
    const cAB = last.overdue.length === 0 && schedulersOk;
    const cC = last.newSessions.length > 0;
    const cD = last.completed.some((c) => c.takes > 0 && c.judged_by !== null);
    opts.log(
      `t+${Math.round((Date.now() - startedAt) / 1000)}s — healed ${healed}/${snapshot.wedged.length}; ` +
        `overdue-and-open: ${last.overdue.length} (${last.overdue.filter((o) => o.is_new).length} of them new); ` +
        `new sessions: ${last.newSessions.length}; judged: ${last.completed.filter((c) => c.judged_by).length}; ` +
        `stalled schedules: ${last.stalledSchedules.length}; job backlog: ${last.jobBacklog}`,
    );
    if (cAB && cC && cD) { met = true; break; }
    if (Date.now() - startedAt + pollMs >= opts.deadlineMs) break;
    await Bun.sleep(pollMs);
  }

  const healedCount = snapshot.wedged.filter((w) => !last.overdue.some((o) => o.id === w.id)).length;
  const overdueLines = last.overdue
    .slice(0, 15)
    .map((o) => `  ${o.id} state=${o.state} closed ${o.window_closes_at.toISOString()} (${o.minutes_overdue}m overdue${o.is_new ? ", convened by THIS boot" : ""})`);

  // ── (a) wedged sessions and schedulers self-healed ────────────────────────
  const schedulerLines = [
    ...last.stalledSchedules.map((s) => `schedule ${s.kind} next_run_at ${s.next_run_at?.toISOString() ?? "null"} is >${SCHEDULE_STALL_MINUTES}m overdue`),
    ...(last.jobBacklog ? [`${last.jobBacklog} job(s) pending and >30m past run_after — the queue is not draining`] : []),
  ];
  const aOk = last.overdue.length === 0 && schedulerLines.length === 0;
  record(
    "a-self-healed",
    aOk ? "PASS" : "FAIL",
    aOk
      ? [
          snapshot.wedged.length
            ? `all ${snapshot.wedged.length} session(s) past their close time at boot reached a terminal state under v0.5.1`
            : "the restored database carried no session past its close time — there was nothing to heal, and nothing regressed",
          `no enabled schedule is >${SCHEDULE_STALL_MINUTES}m overdue, and no job is stuck pending past its run_after`,
        ]
      : [
          `${healedCount}/${snapshot.wedged.length} baseline wedges healed, but ${last.overdue.length} session(s) are past their close time and still open:`,
          ...overdueLines,
          ...schedulerLines,
        ],
    "This is the defect v0.5.1 exists to fix. There is no grace period: a session past window_closes_at must be closed, and the observation window above is what allows an in-flight publish to finish.",
  );

  // ── (b) expired or failed sessions are CLOSED ─────────────────────────────
  const bOk = last.overdue.length === 0;
  const cancelled = last.newSessions.filter((s) => s.state === "cancelled").length;
  const published = last.newSessions.filter((s) => s.state === "published").length;
  record(
    "b-expired-sessions-closed",
    bOk ? "PASS" : "FAIL",
    bOk
      ? `every session past its prescribed close time is terminal (${TERMINAL.join(" or ")}); of this boot's sessions ${published} published and ${cancelled} closed as cancelled rather than lingering`
      : [`${last.overdue.length} session(s) past their close time are neither published nor cancelled:`, ...overdueLines],
    "A session that expires or fails must still close. Lingering in window_closed/aggregated/judged is the wedge under a different name.",
  );

  // A session with no window has no prescribed time and cannot be graded by the
  // rule above. Surfaced as a WARN so the population stays fully accounted for.
  if (last.windowless.length) {
    record(
      "b-windowless-sessions",
      "WARN",
      `${last.windowless.length} non-terminal session(s) have no window_closes_at, so no close time applies: ` +
        last.windowless.slice(0, 10).map((w) => `${w.id}=${w.state}`).join(", "),
      "Not graded by criterion (b) — an unbounded session is a separate question from a late one. Confirm each is genuinely still in its collecting phase.",
    );
  }

  // ── (c) new sessions opened ───────────────────────────────────────────────
  const cOk = last.newSessions.length > 0;
  record(
    "c-new-sessions-opened",
    cOk ? "PASS" : "FAIL",
    cOk
      ? `${last.newSessions.length} session(s) convened after the twin's postmaster started (${snapshot.bootAt.toISOString()}) — the system is opening new work, not only draining old work`
      : `no session convened after ${snapshot.bootAt.toISOString()} in ${Math.round((Date.now() - startedAt) / 60000)}m of observation`,
    "Healing the old wedges is only half the claim. Note the smoke stack pins SWARM_SCHEDULES_ENABLED=0, so this exercises the steady-state session loop rather than cron.",
  );

  // ── (d) a full session: proposers submitted, a judge judged ───────────────
  const full = last.completed.filter((c) => c.takes > 0 && c.judged_by !== null);
  const dOk = full.length > 0;
  record(
    "d-full-session-judged",
    dOk ? "PASS" : "FAIL",
    dOk
      ? full.slice(0, 5).map((c) => `session ${c.id}: ${c.takes} verified take(s) from proposers, judged by ${c.judged_by} (mode=${c.mode}, source=${c.source})`)
      : [
          "no session convened this boot has BOTH verified takes and a judgement:",
          ...last.completed.slice(0, 10).map((c) => `  ${c.id}: verified takes=${c.takes} judged_by=${c.judged_by ?? "(none)"}`),
        ],
    "The end-to-end claim: proposers authored signed takes and a judge authored a judgement naming itself. `verified` is the signature check, `judged_by` the judge identity 0043 made non-null.",
  );

  // Informational, never a gate: a fallback judgement is a real row, but it is
  // not a model's opinion, and this release ships on the premise that the
  // in-house judge runs real inference rather than faking one.
  const fallbacks = full.filter((c) => c.source === "fallback");
  if (fallbacks.length) {
    record(
      "d-judge-source",
      "WARN",
      `${fallbacks.length} of ${full.length} judged session(s) recorded source='fallback', not a model`,
      "Read the fallback_reason. A rehearsal in which the judge only ever falls back has not exercised the judge.",
    );
  }

  if (!met) {
    opts.log(`deadline reached after ${Math.round((Date.now() - startedAt) / 60000)}m — the records above are the state at that moment, not a partial run`);
  }
}
