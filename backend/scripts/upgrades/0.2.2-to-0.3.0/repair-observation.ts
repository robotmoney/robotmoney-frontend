// §7.1 — watch `ops.repair_gaps` actually DISPATCH, on the twin, inside the
// rehearsal's window.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// §7 has always required the twin to prove that, with the RPC budget unset,
// `ops.repair_gaps` fires and dispatches — that `job_runs` names the days it
// enqueued and the days it deferred, that matching `wallet.backfill_day` jobs
// exist, and that at least one completed day writes rows carrying
// `provenance='backfilled'`.
//
// Nothing proved any of it. postflight's `repair-schedule` check reads the
// `job_schedules` ROW — kind, cron, enabled, next_run_at — and nothing else. It
// cannot distinguish a schedule that dispatches from one that is seeded and
// inert, which is the exact distinction the release turns on (§0.3: the whole
// point of v0.3.0 is that this stopped being opt-in).
//
// And it was not merely unimplemented, it was unreachable: the rehearsal tore
// the twin down the instant `onReady` returned — a 42-second window measured on
// 2026-08-22 — while the seeded schedule's first fire was the next wall-clock
// `:25`, eleven minutes later. Requiring an observation that the apparatus made
// impossible is how a runbook acquires a bullet nobody has ever ticked.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT DOES NOT WAIT FOR THE WALL CLOCK
// ─────────────────────────────────────────────────────────────────────────────
//
// Waiting for the real `:25` would make the rehearsal's duration depend on what
// time somebody started it — up to a full cadence of dead air, and unbounded in
// the operator's mind even where it is bounded in code. Instead this backdates
// `next_run_at` past a slot that has already gone by, and the scheduler's
// ordinary 30s tick does the rest. What is observed is the real scheduler, the
// real handler and the real chain reads; only the clock is hurried.
//
// ⚠ THE BACKDATE MUST LAND ON A PAST SLOT, AND `now()` IS NOT ONE.
// `tickScheduler` anchors its cron iterator at `next_run_at - 1s` and breaks on
// the first slot strictly after `now()`. So `SET next_run_at = now()` enqueues
// NOTHING — it just rewrites the row to the next future slot. (That is also why
// the remediation string printed by preflight and postflight for a wedged
// schedule un-wedges without firing; the wording was corrected alongside this.)
// Backdating by exactly ONE cadence — computed from the row's own `next_run_at`,
// which the scheduler has already aligned to a real slot — lands on the
// immediately preceding real slot, so the loop enqueues exactly one job and
// then breaks on the original value. Cadence-agnostic on purpose: a future
// change to NEW_SCHEDULE_CRON must not silently start enqueuing four.
//
// ─────────────────────────────────────────────────────────────────────────────
// ORDERING: THIS RUNS AFTER POSTFLIGHT, NEVER BEFORE
// ─────────────────────────────────────────────────────────────────────────────
//
// postflight's `new-tables` check asserts `chain_day_blocks` and
// `wallet_backfill_state` are present AND EMPTY. A dispatch observation
// populates both. Run this first and postflight's PASS becomes a WARN, with the
// two checks fighting over the same rows and neither wrong. The sequence in
// stage-rehearsal.ts encodes the order; this note is here because it is exactly
// the kind of constraint a later refactor reorders innocently.

import parser from "cron-parser";
import type { Db } from "../../lib/postflight-utils.ts";
import { BACKFILL_WINDOW_JOB_KIND, BACKFILL_PROVENANCE, NEW_SCHEDULE_CRON, NEW_SCHEDULE_KIND } from "./release.ts";

export interface ObservationResult {
  status: "PASS" | "WARN" | "FAIL";
  detail: string[];
  remediation?: string;
}

/** The scheduler ticks every 30s (worker/runtime.ts, SCHEDULER_TICK_MS — not
 *  plumbed through compose, so 30s is what a twin actually runs). Everything
 *  below is expressed in multiples of it rather than in bare seconds, so the
 *  budgets stay legible as "N ticks of headroom". */
const TICK_MS = 30_000;
const POLL_MS = 5_000;

/** Up to 3 ticks for the row to gain a next_run_at. seed() inserts it NULL and
 *  the first tick seeds it to the next FUTURE occurrence without firing a stale
 *  slot, so on a fresh twin there is a genuine wait here — and surviving it is
 *  itself proof the scheduler loop is alive. */
const SEED_BUDGET_MS = 3 * TICK_MS;

/** 10 ticks for the dispatcher to claim and finish. It does DB-only work
 *  (detectAllGaps + planWalletBackfill + inserts), so this is generous. */
const DISPATCH_BUDGET_MS = 10 * TICK_MS;

async function poll<T>(
  budgetMs: number,
  progress: (msg: string) => void,
  label: string,
  attempt: () => Promise<T | null>,
): Promise<T | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < budgetMs) {
    const hit = await attempt();
    if (hit !== null) return hit;
    const waited = Math.round((Date.now() - startedAt) / 1000);
    progress(`${label} — ${waited}s elapsed, ${Math.round(budgetMs / 1000) - waited}s left`);
    await Bun.sleep(POLL_MS);
  }
  return null;
}

/** One cadence of NEW_SCHEDULE_CRON, in milliseconds. */
function cadenceMs(): number {
  const it = parser.parseExpression(NEW_SCHEDULE_CRON, { tz: "UTC", currentDate: new Date() });
  const a = it.next().toDate().getTime();
  return it.next().toDate().getTime() - a;
}

/**
 * §7.1's hard half: the dispatcher runs and reports what it enqueued and what
 * it deferred, and the jobs it claims to have enqueued actually exist.
 */
export async function observeRepairDispatch(
  db: Db,
  log: (m: string) => void,
): Promise<ObservationResult> {
  // ── Preconditions ─────────────────────────────────────────────────────────
  const rows = (await db`
    SELECT id, kind, cron, enabled, timezone, catchup_policy, next_run_at
      FROM job_schedules WHERE kind = ${NEW_SCHEDULE_KIND}
  `) as unknown as {
    id: number;
    cron: string;
    enabled: boolean;
    catchup_policy: string;
    next_run_at: string | null;
  }[];

  const enabled = rows.filter((r) => r.enabled);
  if (enabled.length !== 1) {
    return {
      status: "FAIL",
      detail: [
        `expected exactly 1 enabled ${NEW_SCHEDULE_KIND} row, found ${enabled.length} (${rows.length} total):`,
        ...rows.map((r) => `  cron=${r.cron} enabled=${r.enabled}`),
      ],
      remediation:
        "seed()'s ON CONFLICT key is (kind, cron), so a cadence change leaves the old row behind. Retire it before rehearsing — two enabled rows dispatch the same backfill twice against a metered RPC budget.",
    };
  }
  const s = enabled[0]!;

  if (s.cron !== NEW_SCHEDULE_CRON) {
    return {
      status: "FAIL",
      detail: [`${NEW_SCHEDULE_KIND} is on cron '${s.cron}', but this release ships '${NEW_SCHEDULE_CRON}'`],
      remediation: "This twin is not running the cadence this release ships. Re-seed, or fix release.ts.",
    };
  }
  if (s.catchup_policy !== "all") {
    // Under collapse-per-bucket the one-cadence backdate no longer yields
    // exactly one slot, and the assertion below stops meaning what it says.
    return {
      status: "FAIL",
      detail: [`${NEW_SCHEDULE_KIND} has catchup_policy='${s.catchup_policy}', expected 'all'`],
      remediation: "0034 should set collapse-per-bucket on the two wallet samplers ONLY. Check postflight's catchup-policy.",
    };
  }

  // A fresh twin's row is NULL until the first tick seeds it.
  let nextRunAt = s.next_run_at;
  if (nextRunAt === null) {
    log(`  ${NEW_SCHEDULE_KIND}.next_run_at is NULL (freshly seeded) — waiting for the scheduler's first tick`);
    const seeded = await poll(SEED_BUDGET_MS, (m) => log(`  ${m}`), "waiting for next_run_at", async () => {
      const [r] = (await db`
        SELECT next_run_at FROM job_schedules WHERE id = ${s.id} AND next_run_at IS NOT NULL
      `) as unknown as { next_run_at: string }[];
      return r?.next_run_at ?? null;
    });
    if (!seeded) {
      return {
        status: "FAIL",
        detail: [`next_run_at was still NULL after ${Math.round(SEED_BUDGET_MS / 1000)}s (${SEED_BUDGET_MS / TICK_MS} scheduler ticks)`],
        remediation:
          "The scheduler loop is not running in any worker lane, or no lane can claim this kind. Check the analytics lane is up (worker/lanes.ts).",
      };
    }
    nextRunAt = seeded;
  }

  // ── Baselines, taken BEFORE the backdate ──────────────────────────────────
  const [base] = (await db`
    SELECT coalesce(max(id), 0)::bigint AS max_run_id FROM job_runs
  `) as unknown as { max_run_id: string }[];
  const baselineRunId = base?.max_run_id ?? "0";

  // ── Force exactly one past slot ───────────────────────────────────────────
  const cadence = cadenceMs();
  const [moved] = (await db`
    UPDATE job_schedules
       SET next_run_at = next_run_at - make_interval(secs => ${cadence / 1000})
     WHERE id = ${s.id}
    RETURNING next_run_at
  `) as unknown as { next_run_at: string }[];
  log(
    `  backdated ${NEW_SCHEDULE_KIND} by one cadence (${Math.round(cadence / 1000)}s): ${nextRunAt} → ${moved?.next_run_at} — one past slot, so the next tick enqueues exactly one run`,
  );

  // ── Watch it dispatch ─────────────────────────────────────────────────────
  const run = await poll(DISPATCH_BUDGET_MS, (m) => log(`  ${m}`), `waiting for a ${NEW_SCHEDULE_KIND} run`, async () => {
    const [r] = (await db`
      SELECT id, status, error, output
        FROM job_runs
       WHERE kind = ${NEW_SCHEDULE_KIND} AND id > ${baselineRunId} AND finished_at IS NOT NULL
       ORDER BY id DESC LIMIT 1
    `) as unknown as { id: string; status: string; error: string | null; output: Record<string, unknown> | null }[];
    return r ?? null;
  });

  if (!run) {
    return {
      status: "FAIL",
      detail: [
        `no ${NEW_SCHEDULE_KIND} run finished within ${Math.round(DISPATCH_BUDGET_MS / 1000)}s of the backdate`,
        `(${DISPATCH_BUDGET_MS / TICK_MS} scheduler ticks — the dispatcher does DB-only work, so this is generous)`,
      ],
      remediation:
        "The schedule is seeded but the work never ran. Check the analytics lane is up and claiming: worker/lanes.ts routes ops.* to it.",
    };
  }

  const out = (run.output ?? {}) as Record<string, unknown>;

  // The inert path this release exists to eliminate. On a twin with the budget
  // unset it must not appear — if it does, the release ships its headline
  // feature switched off, which is precisely the bug §0.3 records fixing.
  if (out.status === "skipped") {
    return {
      status: "FAIL",
      detail: [
        `${NEW_SCHEDULE_KIND} ran and DECLINED to dispatch: ${String(out.reason ?? "no reason given")}`,
        "With BASE_RPC_MAX_CALLS_PER_SEC unset the built-in 0.25 calls/s default should apply and the backfill should dispatch (§5.2).",
      ],
      remediation: "Something set BASE_RPC_MAX_CALLS_PER_SEC=0 for this boot. That is the opt-OUT, and this twin took it.",
    };
  }
  if (run.status !== "succeeded") {
    return {
      status: "FAIL",
      detail: [`${NEW_SCHEDULE_KIND} run ${run.id} finished status='${run.status}': ${run.error ?? "no error recorded"}`],
    };
  }

  const dispatched = (out.dispatched ?? {}) as { classC?: string[]; enqueued?: number };
  const days = dispatched.classC ?? [];
  const detail = [
    `${NEW_SCHEDULE_KIND} run ${run.id} succeeded and dispatched`,
    `  totalMissingDays: ${String(out.totalMissingDays ?? "?")}   perRunCap: ${String(out.perRunCap ?? "?")}`,
    `  enqueued: ${String(dispatched.enqueued ?? 0)} ${BACKFILL_WINDOW_JOB_KIND} job(s) covering ${days.length} day(s)${days.length ? ` — ${days.join(", ")}` : ""}`,
    `  deferred: ${JSON.stringify(out.deferredDays ?? [])}`,
    `  retrying: ${JSON.stringify(out.retryingDays ?? [])}   exhausted: ${JSON.stringify(out.exhaustedDays ?? [])}`,
    `  dirtySeries: ${JSON.stringify(out.dirtySeries ?? [])}`,
  ];

  // A clean twin has nothing to repair. That is a legitimate outcome and NOT a
  // silent pass: the dispatch half is proven, the completion half was never
  // exercised, and saying so is the difference between evidence and a green
  // tick that graded nothing.
  if (Number(out.totalMissingDays ?? 0) === 0) {
    return {
      status: "WARN",
      detail: [
        ...detail,
        "",
        "This twin had NO wallet gaps, so the dispatcher correctly enqueued nothing.",
        "The DISPATCH half of §7's bullet is proven; the COMPLETION half was not exercised here.",
      ],
      remediation:
        "Not a defect. If you need the completion evidence too, rehearse against a dump taken before the gaps closed.",
    };
  }

  // The run must not claim days it did not enqueue — the assertion
  // tests/repair-gaps-dispatch.test.ts makes in-process, made here against a
  // real boot and a real scheduler.
  //
  // Since #739 the dispatcher enqueues ONE `wallet.backfill_window` carrying
  // `{dates: [...]}`, so a day is "enqueued" when some window job's dates array
  // CONTAINS it — jsonb `@>`, not `payload->>'asof' =`. Graded against the
  // window kind alone, deliberately: a dispatcher that reverted to one job per
  // day would leave every reported day uncovered here and fail, which is the
  // point. `wallet.backfill_day` is still a registered handler for draining
  // pre-upgrade rows, and draining is not dispatching.
  const missing: string[] = [];
  for (const day of days) {
    const [j] = (await db`
      SELECT id FROM jobs
       WHERE kind = ${BACKFILL_WINDOW_JOB_KIND}
         AND payload->'dates' @> ${JSON.stringify([day])}::jsonb
       LIMIT 1
    `) as unknown as { id: string }[];
    if (!j) missing.push(day);
  }
  if (missing.length > 0) {
    return {
      status: "FAIL",
      detail: [
        ...detail,
        "",
        `but ${missing.length} reported day(s) are in NO ${BACKFILL_WINDOW_JOB_KIND} job: ${missing.join(", ")}`,
      ],
      remediation: "The dispatcher's report and the queue disagree. Do not carry this into a cutover.",
    };
  }

  return {
    status: "PASS",
    detail: [...detail, `  every reported day is covered by a ${BACKFILL_WINDOW_JOB_KIND} job`],
  };
}

/**
 * §7.1's soft half: one dispatched day completes and writes rows that carry
 * `provenance='backfilled'`.
 *
 * ⚠ WARN, NEVER FAIL — deliberately. Completing a day means real reads against
 * mainnet.base.org, paced at the built-in 0.25 calls/s and sharing that bucket
 * with the two per-minute wallet samplers, plus historical prices from a
 * third-party free tier. Making the release's gate FAIL on those makes whether
 * v0.3.0 ships depend on a provider's mood on rehearsal day. The code path this
 * release CHANGED is the dispatch, and observeRepairDispatch() grades that
 * hard. This is corroboration of the write, and a WARN carrying the provider's
 * own error text tells an operator everything a FAIL would.
 *
 * One day, not ten. `WALLET_BACKFILL_MAX_DAYS_PER_RUN` is 10, and at 0.25
 * calls/s a day costs roughly 1–3 minutes wall-clock; ten with retries
 * (`WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY` is 3) can consume any budget you give
 * it. One completed day proves the write shape, which is what §7 asks for.
 */
export async function observeRepairCompletion(
  db: Db,
  log: (m: string) => void,
  budgetMs: number,
): Promise<ObservationResult> {
  // Look for a day that actually WROTE, not merely the first day to finish.
  //
  // Observed on the 2026-08-22 rehearsal: the first day to complete was
  // 2026-03-18, which resolved a block and returned `status=filled`,
  // `detail=already populated: wallet_balance_samples`. That is the executor
  // behaving correctly — it never overwrites a non-empty day — but it writes no
  // `provenance='backfilled'` row, so grading it proves nothing about the write
  // path. §7 asks for a day whose WRITTEN ROWS carry the provenance, and a
  // dispatch of ten days will usually contain both kinds. So poll for the
  // former and fall back to reporting what the latter did.
  const startedAt = Date.now();
  const finished = new Map<string, { status: string; last_error: string | null; state: string; detail: string | null }>();

  while (Date.now() - startedAt < budgetMs) {
    // One window job carries many days, so expand `payload->'dates'` and grade
    // per DAY — the unit §7 asks about is a repaired day, not a queue row. Every
    // day of one window shares that window's terminal status, which is exactly
    // the "ONE JOB IS NOT ONE OUTCOME" caveat `repair.ts` documents: a window
    // that repaired nine days and lost one surfaces as a failed run, so a
    // per-day `written` count is the only honest read of what landed.
    const rows = (await db`
      SELECT d.asof AS asof, j.status, j.last_error,
             coalesce(w.status, 'absent') AS state, w.detail,
             (SELECT count(*)::int FROM wallet_balance_samples b
               WHERE b.sample_date = d.asof::date
                 AND b.provenance = ${BACKFILL_PROVENANCE}) AS written
        FROM jobs j
        CROSS JOIN LATERAL jsonb_array_elements_text(j.payload->'dates') AS d(asof)
        LEFT JOIN wallet_backfill_state w ON w.sample_date = d.asof::date
       WHERE j.kind = ${BACKFILL_WINDOW_JOB_KIND} AND j.status IN ('succeeded', 'failed', 'dead')
       ORDER BY j.id, d.asof
    `) as unknown as {
      asof: string;
      status: string;
      last_error: string | null;
      state: string;
      detail: string | null;
      written: number;
    }[];

    for (const r of rows) finished.set(r.asof, { status: r.status, last_error: r.last_error, state: r.state, detail: r.detail });

    const wrote = rows.find((r) => r.status === "succeeded" && r.written > 0);
    if (wrote) {
      return {
        status: "PASS",
        detail: [
          `${BACKFILL_WINDOW_JOB_KIND} day ${wrote.asof} succeeded and WROTE`,
          `  ${wrote.written} wallet_balance_samples row(s) carry provenance='${BACKFILL_PROVENANCE}'`,
          `  wallet_backfill_state: status=${wrote.state} detail=${wrote.detail ?? "none"}`,
          `  after ${Math.round((Date.now() - startedAt) / 1000)}s, ${finished.size} day(s) finished`,
        ],
      };
    }

    const waited = Math.round((Date.now() - startedAt) / 1000);
    log(
      `  waiting for a ${BACKFILL_WINDOW_JOB_KIND} day that WRITES — ${finished.size} day(s) finished so far, ${waited}s elapsed, ${Math.round(budgetMs / 1000) - waited}s left`,
    );
    await Bun.sleep(POLL_MS);
  }

  if (finished.size === 0) {
    return {
      status: "WARN",
      detail: [`no ${BACKFILL_WINDOW_JOB_KIND} reached a terminal status within ${Math.round(budgetMs / 60000)}m`],
      remediation:
        "Paced chain reads are slow by design (0.25 calls/s, shared with the per-minute samplers). Not blocking: the DISPATCH half is what this release changed and check 2 grades it hard.",
    };
  }

  // Days finished, none wrote. Say WHICH reason, per day — the two are very
  // different and only one of them is interesting.
  const populated = [...finished].filter(([, v]) => (v.detail ?? "").includes("already populated"));
  const failed = [...finished].filter(([, v]) => v.status !== "succeeded");
  return {
    status: "WARN",
    detail: [
      `${finished.size} day(s) finished within ${Math.round(budgetMs / 60000)}m, none of them WROTE a provenance='${BACKFILL_PROVENANCE}' row:`,
      ...[...finished].map(([asof, v]) => `  ${asof} job=${v.status} state=${v.state} detail=${v.detail ?? "none"}`),
      "",
      populated.length > 0
        ? `${populated.length} were 'already populated' — the executor never overwrites a non-empty day, so those were false gaps and declining was CORRECT.`
        : "",
      failed.length > 0 ? `${failed.length} did not succeed — read last_error before assuming a code defect.` : "",
    ].filter((l) => l !== ""),
    remediation:
      "Not blocking. If every dispatched day was 'already populated', the gap detector and the executor disagree about what a gap is — worth an issue, but not a cutover blocker.",
  };
}
