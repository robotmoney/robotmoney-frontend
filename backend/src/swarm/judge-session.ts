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
import { sql } from "../db/client.ts";
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
  outcome?: JudgeOutcome;
}

/**
 * Judge one session. The caller owns the state transition; this owns the
 * opinion, its record, and — in `enforce` only — its effect.
 */
export async function judgeSession(sessionId: string, opts: JudgeOptions = {}): Promise<JudgeSessionResult> {
  const config = await getJudgeConfig();
  if (config.mode === "off") {
    return { ok: false, status: 409, error: "judge_disabled", sessionId, mode: config.mode };
  }
  const input = await buildJudgeInput(sessionId, config.minTakes);
  if (!input) return { ok: false, status: 404, error: "session not found", sessionId, mode: config.mode };

  const outcome = await judge(input, { model: config.model, ...opts });
  const inserted = (await sql`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, fallback_reason, model, prompt_hash, inputs_digest, take_count, min_takes, opinion)
    VALUES (
      ${sessionId}, ${config.mode}, ${outcome.source}, ${outcome.fallbackReason ?? null}, ${outcome.model},
      ${outcome.promptHash}, ${outcome.inputsDigest}, ${outcome.takeCount}, ${outcome.minTakes},
      ${sql.json(outcome.opinion as any)}
    ) RETURNING id`)[0] as { id: string | number };

  // SHADOW STOPS HERE. The opinion is on file and nothing about the session has
  // changed — that is the whole point of the mode.
  let applied = false;
  if (config.mode === "enforce") {
    await applyOpinion(sessionId, outcome);
    applied = true;
  }
  return {
    ok: true, status: 200, sessionId, mode: config.mode,
    judgementId: String(inserted.id), applied, outcome,
  };
}

// Merge the judge's three fields into the recommendation. Read-modify-write in
// JS rather than a jsonb operator so the merge is one obvious list of keys:
// rationale, disagreements, release_safety, and NOTHING ELSE. `weights`,
// `quorum`, `stances`, `meanConfidence`, `absent` and `type` are untouched by
// construction.
async function applyOpinion(sessionId: string, outcome: JudgeOutcome): Promise<void> {
  const row = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as
    | { swarm_recommendation: Record<string, unknown> | null }
    | undefined;
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
  await sql`UPDATE swarm_sessions SET swarm_recommendation = ${sql.json(rec as any)} WHERE id = ${sessionId}`;
}

export async function latestJudgement(sessionId: string) {
  return (await sql`
    SELECT id, session_id, mode, source, fallback_reason, model, prompt_hash, inputs_digest,
           take_count, min_takes, opinion, created_at
    FROM swarm_session_judgements WHERE session_id = ${sessionId}
    ORDER BY created_at DESC, id DESC LIMIT 1`)[0] ?? null;
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
