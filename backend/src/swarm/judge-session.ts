// The judge's session seam (issue #752): read a session, form an opinion,
// record it, and — only in `enforce` — let it reach the session.
//
// SHADOW BY DEFAULT, BECAUSE THE SWARM IS LIVE. This is a change to running
// production behaviour, not greenfield work: real members are submitting real
// takes on a cadence and those sessions publish. So the switch is a DATABASE
// row, not an environment variable — an operator must be able to pull the judge
// off published sessions without restarting the api and the swarm lane, and
// must be able to leave it computing in `shadow` for as long as it takes to
// trust it. `off` is the shipped default and is today's behaviour to the byte.
//
// WHAT NEVER MOVES. `swarm_recommendation.weights` is not read, not written and
// not recomputed anywhere in this file. Judging a session cannot change its
// vector; that is the property replaySessionJudge() below exists to demonstrate
// against real history rather than against a fixture.
import { sql, type DbHandle } from "../db/client.ts";
import { loadFrozenTakeSet } from "./domain.ts";
import { judge, type JudgeInput, type JudgeOptions, type JudgeOutcome, type JudgeTake } from "./judge.ts";

export type JudgeMode = "off" | "shadow" | "enforce";

export interface JudgeConfig {
  mode: JudgeMode;
  minTakes: number;
  /** The model the judge reaches, or null — see migration 0039 on why this is a row. */
  model: string | null;
  updatedAt: string | null;
}

const DEFAULT_CONFIG: JudgeConfig = { mode: "off", minTakes: 3, model: null, updatedAt: null };

export async function getJudgeConfig(): Promise<JudgeConfig> {
  const row = (await sql`SELECT mode, min_takes, model, updated_at FROM swarm_judge_config WHERE id = 1`)[0] as
    | { mode: string; min_takes: number; model: string | null; updated_at: Date | string }
    | undefined;
  if (!row) return DEFAULT_CONFIG;
  return {
    mode: row.mode as JudgeMode,
    minTakes: Number(row.min_takes),
    model: row.model == null || String(row.model).trim() === "" ? null : String(row.model),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function setJudgeConfig(
  patch: { mode?: JudgeMode; minTakes?: number; model?: string | null },
): Promise<JudgeConfig> {
  if (patch.mode !== undefined && !["off", "shadow", "enforce"].includes(patch.mode)) {
    throw new Error(`invalid judge mode "${patch.mode}" — expected off | shadow | enforce`);
  }
  if (patch.minTakes !== undefined && (!Number.isInteger(patch.minTakes) || patch.minTakes < 1)) {
    throw new Error(`invalid judge minTakes "${patch.minTakes}" — expected a positive integer`);
  }
  if (patch.model !== undefined && patch.model !== null && (typeof patch.model !== "string" || patch.model.trim() === "" || patch.model.length > 200)) {
    throw new Error("invalid judge model — expected a non-empty model id, or null to unset it");
  }
  // `model: null` UNSETS deliberately, which is why it is passed through
  // separately from the COALESCE-on-undefined the other two fields get: taking
  // the model away is how an operator stops model prose without stopping the
  // judge recording template opinions.
  const clearModel = patch.model === null;
  await sql`
    INSERT INTO swarm_judge_config (id, mode, min_takes, model, updated_at)
    VALUES (1, ${patch.mode ?? DEFAULT_CONFIG.mode}, ${patch.minTakes ?? DEFAULT_CONFIG.minTakes},
            ${patch.model ? patch.model.trim() : null}, now())
    ON CONFLICT (id) DO UPDATE SET
      mode = COALESCE(${patch.mode ?? null}, swarm_judge_config.mode),
      min_takes = COALESCE(${patch.minTakes ?? null}::integer, swarm_judge_config.min_takes),
      model = CASE WHEN ${clearModel} THEN NULL
                   ELSE COALESCE(${patch.model ? patch.model.trim() : null}, swarm_judge_config.model) END,
      updated_at = now()`;
  return getJudgeConfig();
}

// ── Building the judged input from stored state ─────────────────────────────
// Every NUMBER on the input comes off the session row the aggregator already
// wrote. Nothing here recomputes a rollup: if the judge and the aggregator
// could disagree about the quorum, the prose would be describing a session that
// does not exist.
export async function buildJudgeInput(sessionId: string, minTakes: number): Promise<JudgeInput | null> {
  const frozen = await loadFrozenTakeSet(sessionId);
  if (!frozen) return null;
  const s = frozen.session;
  const briefRow = (await sql`SELECT body FROM swarm_briefs WHERE session_id = ${sessionId}`)[0] as
    | { body: unknown }
    | undefined;
  const rec = (s.swarm_recommendation ?? {}) as Record<string, unknown>;
  const takes: JudgeTake[] = frozen.takes.map((t: any) => ({
    member_id: String(t.member_id),
    member_name: t.member_name == null ? null : String(t.member_name),
    revision: Number(t.revision ?? 0),
    stance: String(t.stance ?? ""),
    confidence: t.confidence == null ? null : Number(t.confidence),
    body: typeof t.body === "string" ? t.body : "",
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

// ── Running the judge over a session ────────────────────────────────────────

export interface JudgeSessionResult {
  ok: boolean;
  status: number;
  error?: string;
  sessionId: string;
  mode: JudgeMode;
  judgementId?: string;
  applied?: boolean;
  /** Set iff `enforce` recorded an opinion that did NOT reach the session, and why. */
  appliedSkippedReason?: string;
  outcome?: JudgeOutcome;
}

export interface JudgeSessionOptions extends JudgeOptions {
  /**
   * The mode/threshold/model, read ONCE by the caller and passed down. Without
   * this the config is read twice — by the caller's gate and again here — and
   * an operator flipping the switch between the two reads gets a session
   * advanced to `judged` and a 409 in the same call.
   */
  config?: JudgeConfig;
  /**
   * Run inside this function's transaction, after its advisory lock and before
   * the judgement row is written. `judgeSessionAdmin` uses it to put the
   * `aggregated -> judged` transition in the SAME transaction as the row that
   * justifies it. A `{ ok: false }` return rolls the whole transaction back and
   * becomes this call's result.
   */
  beforeRecord?: (tx: DbHandle) => Promise<{ ok: boolean; status: number; error?: string }>;
}

/**
 * Judge one session. The caller owns the state transition; this owns the
 * opinion, its record, and — in `enforce` only — its effect.
 *
 * ONE JUDGE AT A TIME, PER SESSION. Everything after the model call runs inside
 * a single transaction that first takes `pg_advisory_xact_lock` on the session
 * id. Concurrent callers are real — the admin POST runs in the api process
 * while a `swarm.judge` job runs in worker-swarm, and a reaped/retried job
 * re-enters the same way — and `guardedTransition` does NOT stop the second one
 * (re-requesting the current state is idempotent by design). Unserialized, the
 * read-modify-write in applyOpinion() interleaves as insert(A), insert(B),
 * update(B), update(A): latestJudgement() returns B while the session carries
 * A's prose, so the append-only record and the session disagree about which
 * opinion is in force — the exact attribution prompt_hash/inputs_digest exists
 * to establish.
 *
 * THE MODEL CALL IS OUTSIDE THE TRANSACTION, deliberately: it takes up to 60s
 * and no row lock or pooled connection may be held across it.
 */
export async function judgeSession(sessionId: string, opts: JudgeSessionOptions = {}): Promise<JudgeSessionResult> {
  const { config: passedConfig, beforeRecord, ...judgeOpts } = opts;
  const config = passedConfig ?? (await getJudgeConfig());
  if (config.mode === "off") {
    return { ok: false, status: 409, error: "judge_disabled", sessionId, mode: config.mode };
  }
  const input = await buildJudgeInput(sessionId, config.minTakes);
  if (!input) return { ok: false, status: 404, error: "session not found", sessionId, mode: config.mode };

  const outcome = await judge(input, { model: config.model, ...judgeOpts });

  let refusal: { ok: boolean; status: number; error?: string } | undefined;
  let recorded: { id: string | number; applied: boolean; skipped?: string } | undefined;
  const run = async (tx: DbHandle) => {
    // Serialize on the session id. hashtextextended() is Postgres's own hash of
    // the uuid text, so the lock key is derived and needs no side table; the
    // `_xact_` form releases at COMMIT/ROLLBACK, so a crashed judge cannot leave
    // a session locked.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`;
    if (beforeRecord) {
      const gate = await beforeRecord(tx);
      if (!gate.ok) {
        refusal = gate;
        // Roll the transaction back — the transition, if it wrote one, must not
        // survive a judging that is being refused.
        throw new JudgeRollback();
      }
    }
    // APPLY FIRST, THEN RECORD (issue #767). Both are in this one transaction
    // under this one advisory lock, so the pair still commits together or not
    // at all — the ordering changes nothing about atomicity and everything
    // about what the row can say. Recording after the attempt lets `applied` be
    // a fact about this row rather than an inference from the mode — and keeps
    // the table strictly append-only, which an UPDATE-after-INSERT would not.
    //
    // A REFUSED ENFORCE JUDGING LEAVES NO ROW AT ALL (issue #806). It is worth
    // being exact about this, because docs/decisions.md said the opposite until
    // #806 corrected it. `beforeRecord` above IS the refusal for a session that
    // moved: `judgeSessionAdmin` passes `transitionWithin(…, "judged", …)`,
    // whose admitted set `{aggregated, judged}` is a strict SUBSET of
    // OPINION_WRITABLE_STATES, and it holds the row `FOR UPDATE` from there to
    // COMMIT. So a session that published while the model was thinking is
    // refused by the GATE — rollback, no transition, no judgement row, nothing
    // recorded — and `applyOpinion` never sees a state it would refuse.
    //
    // SHADOW NEVER APPLIES. That is the whole point of the mode, and migration
    // 0041's CHECK refuses a shadow row that claims otherwise.
    const attempt = config.mode === "enforce"
      ? await applyOpinion(tx, sessionId, outcome)
      : { applied: false as const, reason: null };
    const applied = attempt.applied;
    const appliedSkippedReason = applied ? null : attempt.reason;

    const inserted = (await tx`
      INSERT INTO swarm_session_judgements
        (session_id, mode, source, fallback_reason, model, prompt_hash, inputs_digest, take_count, min_takes,
         applied, applied_skipped_reason, dropped_positions, dropped_disagreements, opinion)
      VALUES (
        ${sessionId}, ${config.mode}, ${outcome.source}, ${outcome.fallbackReason ?? null}, ${outcome.model},
        ${outcome.promptHash}, ${outcome.inputsDigest}, ${outcome.takeCount}, ${outcome.minTakes},
        ${applied}, ${appliedSkippedReason},
        ${outcome.drops?.positions ?? 0}, ${outcome.drops?.disagreements ?? 0},
        ${sql.json(outcome.opinion as any)}
      ) RETURNING id`)[0] as { id: string | number };

    recorded = { id: inserted.id, applied, ...(appliedSkippedReason ? { skipped: appliedSkippedReason } : {}) };
  };

  try {
    await sql.begin(run);
  } catch (e) {
    if (!(e instanceof JudgeRollback)) throw e;
    recorded = undefined;
  }

  if (!recorded) {
    return {
      ok: false, status: refusal?.status ?? 409,
      error: refusal?.error ?? "judge refused", sessionId, mode: config.mode,
    };
  }
  return {
    ok: true, status: 200, sessionId, mode: config.mode,
    judgementId: String(recorded.id), applied: recorded.applied,
    ...(recorded.skipped ? { appliedSkippedReason: recorded.skipped } : {}),
    outcome,
  };
}

/** Sentinel: rolls the judge's transaction back without becoming a 500. */
class JudgeRollback extends Error {
  constructor() {
    super("judge_rollback");
    this.name = "JudgeRollback";
  }
}

// The states in which an opinion may still reach a session. NOT an equality
// check on `judged`: judgeSession() is also the direct entry point for an
// `aggregated` session that was never transitioned (that is what shadow-then-
// enforce on a live session looks like, and what the tests drive). What it must
// refuse is writing onto a session that is already TERMINAL.
const OPINION_WRITABLE_STATES = ["scheduled", "collecting", "window_closed", "aggregated", "judged"];

/** The outcome of trying to put an opinion onto its session. */
type ApplyOutcome = { applied: true; reason: null } | { applied: false; reason: string };

// Merge the judge's three fields into the recommendation. Read-modify-write in
// JS rather than a jsonb operator so the merge is one obvious list of keys:
// rationale, disagreements, release_safety, and NOTHING ELSE. `weights`,
// `quorum`, `stances`, `meanConfidence`, `absent` and `type` are untouched by
// construction.
//
// CONDITIONAL, AND THE CONDITION IS LOAD-BEARING. `publishSession` is an
// unconditional `UPDATE ... SET state='published'` in a different process, and
// the window between forming an opinion and writing it is a model call. An
// operator pressing Judge at 09:59:30 against a 10:00 publish job used to have
// the judge's prose land on an ALREADY-PUBLISHED, terminal session.
//
// THE ANSWER IS A READ-BACK, NOT A ROW COUNT (issue #806). The UPDATE's row
// count says "a row matched my WHERE clause"; `applied` claims something
// stronger, and the admin panel renders that stronger claim verbatim as
// "applied to the session". So the fact is established the way the read path
// establishes it: SELECT `swarm_recommendation->'judge'` straight back and
// compare it against THIS outcome's `prompt_hash`/`inputs_digest`. Nothing else
// makes the column mean what it is read to mean.
//
// This matters because the row count could never answer it on the production
// entry point at all. `judgeSessionAdmin` gates every judging behind
// `transitionWithin(…, "judged", …)`, whose admitted set `{aggregated, judged}`
// is a strict SUBSET of OPINION_WRITABLE_STATES and which holds the session row
// `FOR UPDATE` until COMMIT — so the state check below can never fail there,
// `applied` restated `mode`, and `applied_skipped_reason` was unreachable. The
// state check is still here because `judgeSession()` is also a direct entry
// point (replay, and shadow-then-enforce on a live `aggregated` session), and
// there it is real.
//
// Takes a `tx` because the read and the write are a read-modify-write and must
// be one transaction, under the caller's advisory lock.
async function applyOpinion(tx: DbHandle, sessionId: string, outcome: JudgeOutcome): Promise<ApplyOutcome> {
  const row = (await tx`
    SELECT state, swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`)[0] as
    | { state: string; swarm_recommendation: Record<string, unknown> | null }
    | undefined;
  if (!row || !OPINION_WRITABLE_STATES.includes(String(row.state))) {
    return { applied: false, reason: "session_no_longer_writable" };
  }
  const rec = { ...(row?.swarm_recommendation ?? {}) } as Record<string, unknown>;
  rec.rationale = outcome.opinion.rationale;
  rec.disagreements = outcome.opinion.disagreements;
  rec.release_safety = outcome.opinion.release_safety;
  rec.judge = {
    source: outcome.source,
    model: outcome.model,
    prompt_hash: outcome.promptHash,
    inputs_digest: outcome.inputsDigest,
    ...(outcome.fallbackReason ? { fallback_reason: outcome.fallbackReason } : {}),
  };
  const upd = await tx`
    UPDATE swarm_sessions SET swarm_recommendation = ${sql.json(rec as any)}
    WHERE id = ${sessionId} AND state = ANY(${OPINION_WRITABLE_STATES}::text[])
    RETURNING id`;
  if (upd.length === 0) return { applied: false, reason: "session_no_longer_writable" };
  // The read-back. Same transaction and same advisory lock as the write, so
  // this reads OUR row and nobody else's interleaved one.
  const carried = await sessionJudgeFingerprint(tx, sessionId);
  if (carried && carried.inputsDigest === outcome.inputsDigest && carried.promptHash === outcome.promptHash) {
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
 */
export async function sessionJudgeFingerprint(
  handle: DbHandle,
  sessionId: string,
): Promise<{ promptHash: string; inputsDigest: string } | null> {
  const row = (await handle`
    SELECT swarm_recommendation->'judge'->>'prompt_hash'   AS prompt_hash,
           swarm_recommendation->'judge'->>'inputs_digest' AS inputs_digest
      FROM swarm_sessions WHERE id = ${sessionId}`)[0] as
    | { prompt_hash: string | null; inputs_digest: string | null }
    | undefined;
  if (!row || row.prompt_hash == null || row.inputs_digest == null) return null;
  return { promptHash: String(row.prompt_hash), inputsDigest: String(row.inputs_digest) };
}

// ORDER BY id, NOT created_at. `created_at` defaults to `now()`, which is the
// TRANSACTION START time — so of two judges serialized by the advisory lock
// above, the one that committed second can carry the earlier timestamp (both
// transactions opened before either got the lock). `id` is a bigserial drawn at
// INSERT, inside the lock, so it is the only ordering that agrees with the
// order the session was actually written in. Getting this wrong means
// latestJudgement() names a different opinion than the one on the session,
// which is exactly the disagreement prompt_hash/inputs_digest exists to rule
// out.
export async function listJudgements(sessionId: string, limit = 50) {
  const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  return (await sql`
    SELECT id, session_id, mode, source, fallback_reason, model, prompt_hash, inputs_digest,
           take_count, min_takes, applied, applied_skipped_reason,
           dropped_positions, dropped_disagreements, opinion, created_at
    FROM swarm_session_judgements WHERE session_id = ${sessionId}
    ORDER BY id DESC LIMIT ${bounded}`) as Record<string, unknown>[];
}

/** The opinion IN FORCE — the newest row, by the ordering argued above. */
export async function latestJudgement(sessionId: string) {
  return (await listJudgements(sessionId, 1))[0] ?? null;
}

// ── Replay (issue #752, 2.9) ────────────────────────────────────────────────
// Validate against real history, not fixtures. This runs the judge over a
// session that has ALREADY published and reports whether its weight vector
// moved. It writes nothing: no judgement row, no session update. The answer it
// is built to produce is "unchanged", on real sessions carrying real absences,
// thin quorums, superseded revisions and rotated keys — the things a fixture
// does not contain.

export interface JudgeReplayResult {
  sessionId: string;
  state: string;
  takeCount: number;
  weightsBefore: unknown;
  weightsAfter: unknown;
  weightsUnchanged: boolean;
  outcome: JudgeOutcome;
}

export async function replaySessionJudge(
  sessionId: string,
  opts: JudgeOptions = {},
  minTakesOverride?: number,
): Promise<JudgeReplayResult | null> {
  const config = await getJudgeConfig();
  const minTakes = minTakesOverride ?? config.minTakes;
  const input = await buildJudgeInput(sessionId, minTakes);
  if (!input) return null;
  const before = (await sql`SELECT state, swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as
    | { state: string; swarm_recommendation: Record<string, unknown> | null }
    | undefined;
  const weightsBefore = before?.swarm_recommendation?.weights ?? null;
  const outcome = await judge(input, { model: config.model, ...opts });
  const after = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as
    | { swarm_recommendation: Record<string, unknown> | null }
    | undefined;
  const weightsAfter = after?.swarm_recommendation?.weights ?? null;
  return {
    sessionId,
    state: before?.state ?? "unknown",
    takeCount: input.takes.length,
    weightsBefore,
    weightsAfter,
    // BYTE-IDENTICAL, not "equivalent": the canonical JSON of the two vectors
    // must match exactly, so a rounding change would fail this as loudly as a
    // reordering would.
    weightsUnchanged: JSON.stringify(weightsBefore) === JSON.stringify(weightsAfter),
    outcome,
  };
}

/** The N most recently convened sessions that have something to judge. */
export async function recentJudgeableSessions(limit = 10): Promise<string[]> {
  const rows = (await sql`
    SELECT id FROM swarm_sessions
    WHERE state IN ('aggregated', 'judged', 'published')
    ORDER BY convened_at DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`) as unknown as { id: string }[];
  return rows.map((r) => String(r.id));
}
