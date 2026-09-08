// The judge REPLAY — an offline, read-only audit of published history
// (issue #752 §2.9; rebuilt by #766, which folded in #769).
//
// ITS OWN MODULE, AND THAT IS THE POINT. This is the one place in the swarm
// tree outside `domain.ts` permitted to CALL `meanTakeWeights()`, and
// `backend/tests/swarm-consensus-weights.test.ts` allowlists exactly this file
// for it. Keeping it out of `judge-session.ts` is what lets that guard stay
// absolutely strict about the production seam: the judging path still may not
// reach the derivation, may not author a `weights` field, and is still pinned
// by the same test. An auditor that reads the derivation and a writer that must
// never touch it do not belong in one file.
//
// NOTHING HERE WRITES. No judgement row, no session update, no state
// transition, and — per D42 — no repair of a published row. That is what makes
// it safe to point at a production database with a read-only role, which is the
// only way "validated against real traffic" means anything. The guard test
// asserts the absence of INSERT/UPDATE/DELETE in this file rather than trusting
// this paragraph.
import { STANCES } from "@robotmoney/contract";
import { sql } from "../db/client.ts";
import { buildRationale, loadFrozenTakeSet, majorityStance, meanTakeWeights } from "./domain.ts";
import { DIGEST_SCHEME, inputsDigest, judge, type JudgeOptions, type JudgeOutcome } from "./judge.ts";
import { getJudgeConfig, judgeInputFromFrozen, latestJudgement } from "./judge-session.ts";

// WHAT IT USED TO CHECK, AND WHY THAT WAS WORTHLESS (issue #766). The original
// version read `swarm_recommendation.weights`, called `judge()` — which writes
// nothing, as judge-session.ts's header says — then re-read the SAME COLUMN and
// compared the two. A comparison of a value against itself across a call that
// cannot write is true by construction: the only defect it could ever report is
// `judge()` starting to write. docs/architecture.md presented that as the
// evidence that judging never moves a vector against real history. It was not
// evidence of anything.
//
// WHAT IT CHECKS NOW. Four assertions, named separately, because they fail for
// different reasons and only one of them is the headline:
//
//   1. REPRODUCIBILITY (the headline). The session's STORED `weights` still
//      equal `meanTakeWeights()` over its CURRENT frozen take set. D4 puts the
//      signed number on `meanTakeWeights`, so "anyone holding the take set can
//      recompute the vector" is the property the whole receipt rests on — and
//      until #766 nothing asserted it against real history. It is the check
//      that would have surfaced the `judged`-state amendment defect PR #757
//      fixed: an amendment landing after aggregation moves the derivation while
//      the stored vector stays where it was.
//   2. THE JUDGE WROTE NOTHING (kept, demoted). Still worth having — it is the
//      guard that a future `applyOpinion` call sneaking into the replay path
//      would trip — but it is a property of THIS FUNCTION, not of history, so
//      it is named `judgeWroteNothing` rather than dressed up as the answer.
//   3. RATIONALE / LADDER AGREEMENT, per session — see
//      `listRationaleLadderDrift()` below for the deployment-wide enumeration
//      D42 promises.
//   4. inputs_digest REPRODUCIBILITY (issue #829, third instance of the shape
//      #766 fixed — this script used to print the freshly recomputed digest
//      on every row and never compare it against
//      `swarm_session_judgements.inputs_digest` at all). #808 widened what the
//      digest commits to, which made a divergence EXPECTED for any row
//      written before that change and unremarkable for one written after —
//      and the tool could not tell an operator which they were looking at.
//      `digest_scheme` (migration 0051) is the discriminator: a row stamped
//      with the scheme this code implements NOW that fails to reproduce is a
//      real finding (`mismatch`, fails the run); a row stamped with anything
//      else is expected history (`historical_divergence`, reports and exits
//      0) — see D44 (docs/decisions.md) for the decision and judge.ts's
//      `DIGEST_SCHEME` for the constant both sides compare against.

/** Which of the three verdicts the weight-reproducibility check reached. */
export type WeightsVerdict =
  /** Stored vector equals `meanTakeWeights()` over the current frozen take set. */
  | "reproduced"
  /** It does NOT — the published number can no longer be re-derived from the takes. */
  | "mismatch"
  /** Not a `bucket_weights` session and carrying no vector: nothing to reproduce. */
  | "not_applicable";

/**
 * Which of the FOUR outcomes the `inputs_digest` reproducibility check
 * reached (issue #829, D44). Unlike `WeightsVerdict`, a bare "reproduced" /
 * "mismatch" split is not enough here: `#808` changed what the digest
 * commits to, so a row stamped under an older scheme is EXPECTED to diverge
 * from a recomputation under today's rule, and reporting that as a fault
 * would make the tool cry wolf on exactly the history #808's own gate
 * accepted as non-recomputable.
 */
export type DigestVerdict =
  /** The row's OWN stamped `digest_scheme` reproduces exactly. */
  | "reproduced"
  /** Differs, and the row is stamped with the scheme this code implements NOW — a real finding. */
  | "mismatch"
  /** Differs, and the row is stamped with an older (or absent) scheme — expected, not a fault. */
  | "historical_divergence"
  /** No judgement is on file for this session at all: nothing to compare. */
  | "not_applicable";

export interface JudgeReplayResult {
  sessionId: string;
  date: string;
  subjectId: string;
  subjectLabel: string;
  state: string;
  takeCount: number;

  // ── 1. Reproducibility: stored vs re-derived. THE headline.
  /** `swarm_recommendation.weights` as published. */
  weightsStored: { bucket: string; weight: number }[] | null;
  /** `meanTakeWeights()` recomputed now, over the session's current frozen take set. */
  weightsRederived: { bucket: string; weight: number }[] | null;
  weightsVerdict: WeightsVerdict;
  /** Convenience: `weightsVerdict !== "mismatch"`. */
  weightsReproducible: boolean;

  // ── 2. The kept, explicitly-named "judge wrote nothing" assertion.
  weightsBefore: unknown;
  weightsAfter: unknown;
  /** The stored column is byte-identical either side of the `judge()` call. */
  judgeWroteNothing: boolean;

  // ── 3. Per-session rationale/ladder agreement (the D42 half, one session).
  rationale: RationaleLadderCheck;

  // ── 4. inputs_digest reproducibility (issue #829). The digest ON FILE for
  // this session's most recent judgement, compared against a fresh
  // recomputation over the frozen set just loaded — reported as a
  // COMPARISON, not printed as a bare value.
  /** `swarm_session_judgements.inputs_digest` for the session's latest judgement, or null if never judged. */
  digestStored: string | null;
  /** `inputsDigest()` recomputed now, over the same frozen set, under that row's own recorded `min_takes`. */
  digestRederived: string | null;
  /** The scheme the stored row was stamped with (`swarm_session_judgements.digest_scheme`), or null if never judged. */
  digestScheme: string | null;
  digestVerdict: DigestVerdict;
  /** Convenience: true unless `digestVerdict === "mismatch"` — a historical divergence is not a fault. */
  digestReproducible: boolean;

  outcome: JudgeOutcome;
}

/**
 * COMPARE THE VECTORS CANONICALLY, NOT BYTEWISE.
 *
 * The stored side comes back through `jsonb`, which does NOT preserve the key
 * order it was written with (it sorts by key length, then bytewise), and the
 * re-derived side is a fresh JS object. A `JSON.stringify` equality over the
 * two would therefore be asserting a Postgres storage detail alongside the
 * property we actually care about. Sorting by bucket and comparing
 * `[bucket, weight]` pairs asserts exactly the property: same buckets, same
 * numbers. The NUMBERS are still compared exactly — both sides are
 * `round(_, 8)` out of `meanTakeWeights`, so a rounding change must fail here
 * as loudly as a missing bucket would.
 */
function canonicalWeights(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const pairs: [string, number][] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const bucket = (entry as { bucket?: unknown }).bucket;
    const weight = (entry as { weight?: unknown }).weight;
    if (typeof bucket !== "string" || typeof weight !== "number") return null;
    pairs.push([bucket, weight]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(pairs);
}

export async function replaySessionJudge(
  sessionId: string,
  opts: JudgeOptions = {},
  minTakesOverride?: number,
): Promise<JudgeReplayResult | null> {
  const config = await getJudgeConfig();
  const minTakes = minTakesOverride ?? config.minTakes;
  // ONE load of the frozen set, used for BOTH the judged input and the
  // re-derivation — see judgeInputFromFrozen's note on why the set must not be
  // read twice around a comparison that is about that set.
  const frozen = await loadFrozenTakeSet(sessionId);
  if (!frozen) return null;
  const input = await judgeInputFromFrozen(frozen, minTakes);

  const before = (await sql`SELECT state, swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as
    | { state: string; swarm_recommendation: Record<string, unknown> | null }
    | undefined;
  const rec = (before?.swarm_recommendation ?? {}) as Record<string, unknown>;
  const weightsBefore = rec.weights ?? null;

  // ── 1. Reproducibility. The stored vector against the derivation, NOW.
  const rederived = meanTakeWeights(frozen.takes) ?? null;
  const storedCanonical = canonicalWeights(weightsBefore);
  const rederivedCanonical = canonicalWeights(rederived);
  // WHEN THERE IS NOTHING TO REPRODUCE, SAY SO — do not report it as a defect.
  // Two sessions carry no vector legitimately, and calling either a mismatch
  // would make the tool cry wolf on a large share of production history:
  //
  //   * a `position_actions` session, for which `aggregateSession` never writes
  //     `weights` at all — even though its takes may carry them, which is why
  //     the type is consulted rather than just the derivation; and
  //   * a `bucket_weights` session in which no member filed a vector, so both
  //     the stored side and the derivation are legitimately absent.
  //
  // Everything else IS compared, including the asymmetric cases: a stored
  // vector whose takes no longer derive one, and takes that now derive one the
  // session never stored, are both real mismatches.
  const nothingToReproduce = storedCanonical === null &&
    (rec.type !== "bucket_weights" || rederivedCanonical === null);
  const weightsVerdict: WeightsVerdict = nothingToReproduce
    ? "not_applicable"
    : storedCanonical !== null && storedCanonical === rederivedCanonical
    ? "reproduced"
    : "mismatch";

  const outcome = await judge(input, { model: config.model, ...opts });

  // ── 2. The kept assertion, under its own name.
  const after = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${sessionId}`)[0] as
    | { swarm_recommendation: Record<string, unknown> | null }
    | undefined;
  const weightsAfter = after?.swarm_recommendation?.weights ?? null;

  // ── 4. inputs_digest reproducibility (issue #829, D44). The digest ON FILE
  // for this session's latest judgement, recomputed over the SAME frozen set
  // already loaded above, and reported as a comparison rather than printed
  // as a bare value.
  const judgement = await latestJudgement(sessionId) as
    | { inputs_digest: unknown; min_takes: unknown; digest_scheme: unknown }
    | null;
  let digestStored: string | null = null;
  let digestRederived: string | null = null;
  let digestScheme: string | null = null;
  let digestVerdict: DigestVerdict;
  if (!judgement) {
    // Never judged: nothing on file to compare against.
    digestVerdict = "not_applicable";
  } else {
    digestStored = String(judgement.inputs_digest);
    digestScheme = judgement.digest_scheme == null ? null : String(judgement.digest_scheme);
    // THAT ROW'S OWN recorded `min_takes`, not the caller's current config —
    // `inputsDigest()` covers `minTakes` (issue #765), so recomputing under
    // today's threshold would report an operator changing the config as a
    // digest mismatch, which is a different fact than "this opinion can no
    // longer be re-derived from what produced it".
    const digestInput = await judgeInputFromFrozen(frozen, Number(judgement.min_takes));
    digestRederived = inputsDigest(digestInput);
    const matches = digestRederived === digestStored;
    // THE DISCRIMINATOR (D44): a mismatch is a real finding only when the row
    // claims to be stamped with the scheme this code implements right now.
    // Any other stamped value (an older scheme, or one this deployment has
    // never seen) means the row was written under a DIFFERENT canonical
    // form, so failing to reproduce it under today's formula is expected —
    // it is history, not a fault, and reported rather than failed exactly as
    // D42's tie-break drift is (see the file header).
    digestVerdict = matches
      ? "reproduced"
      : digestScheme === DIGEST_SCHEME
      ? "mismatch"
      : "historical_divergence";
  }

  const date = frozen.session.date instanceof Date
    ? frozen.session.date.toISOString().slice(0, 10)
    : String(frozen.session.date).slice(0, 10);
  const subjectLabel = String(frozen.session.subject_name ?? frozen.session.subject_id);

  return {
    sessionId,
    date,
    subjectId: String(frozen.session.subject_id),
    subjectLabel,
    state: before?.state ?? "unknown",
    takeCount: input.takes.length,
    weightsStored: (weightsBefore as { bucket: string; weight: number }[] | null) ?? null,
    weightsRederived: rederived,
    weightsVerdict,
    weightsReproducible: weightsVerdict !== "mismatch",
    weightsBefore,
    weightsAfter,
    // BYTE-IDENTICAL is right HERE, unlike above: both sides are the same
    // column read twice through the same driver, so a difference in the bytes
    // is a difference in the row.
    judgeWroteNothing: JSON.stringify(weightsBefore) === JSON.stringify(weightsAfter),
    rationale: checkRationaleLadder(rec, subjectLabel, frozen.session.regime_summary ?? null),
    digestStored,
    digestRederived,
    digestScheme,
    digestVerdict,
    digestReproducible: digestVerdict !== "mismatch",
    outcome,
  };
}

// ── The D42 enumeration (issue #766, folded from #769) ──────────────────────
// D42 says the published sessions affected by the `majorityStance()` tie-break
// fix are "identified and reported" rather than rewritten. NOT REWRITING THEM
// IS THE RIGHT CALL and is not revisited here: append-only history stays as it
// was filed. The operator-facing half of that sentence — the reporting — did
// not exist until this function.
//
// THE AFFECTED SET, exactly as D42 describes it: a published session whose
// `stances` has two or more keys TIED AT THE MAXIMUM, and whose stored
// `rationale` leads with a stance the fixed ladder would not elect. Before the
// fix, `majorityStance()` reduced over `Object.entries()` and named whichever
// tied stance arrived first — and postgres reorders `jsonb` keys, so the same
// stored `stances` could re-derive a different majority than the aggregation
// that wrote it. After the fix, ties break on the canonical ascending STANCES
// ladder. A session filed under the old rule whose arrival order disagreed with
// the ladder is exactly a session in this set.
//
// ONLY A TEMPLATE-SHAPED RATIONALE IS IN SCOPE, and that is a narrowing on
// purpose rather than a convenience. D42's defect lives in `buildRationale()`,
// which opens `Majority stance is <stance> (<n> of <m> submitted takes)`. The
// JUDGE never calls `majorityStance()` at all, so a model-authored rationale
// cannot carry the defect — and scoring it by "which stance word appears
// first" would list every `enforce` session whose prose happens to say
// "constructive" before it says anything else. That is a report an operator
// learns to ignore, which is the same failure as no report. A session whose
// template prose was REPLACED by an enforce judging no longer carries the
// mis-elected sentence anyway; there is nothing left to identify on it.
//
// The counts are reported alongside the list for the same reason: a tool that
// prints nothing on healthy data must be distinguishable from one that cannot
// print. `scanned` / `tied` / `templateShaped` / the list say which it is.

export interface RationaleLadderCheck {
  /** Stances tied at the maximum count. Fewer than two means the ladder never arbitrated. */
  tiedStances: string[];
  /** The stored `swarm_recommendation.rationale`, verbatim, or null. */
  storedRationale: string | null;
  /**
   * `template` when the stored rationale is `buildRationale()`'s sentence (the
   * only prose D42's defect could have produced), `authored` when a judging
   * replaced it, `absent` when the session carries none.
   */
  storedRationaleShape: "template" | "authored" | "absent";
  /** The stance the stored TEMPLATE rationale names as the majority, or null. */
  storedLeadStance: string | null;
  /** `buildRationale()` re-derived now, under the fixed ladder. */
  rederivedRationale: string | null;
  /** The stance the fixed ladder elects. */
  rederivedLeadStance: string | null;
  /**
   * TRUE only for the set D42 promises: a real tie, a template-shaped stored
   * rationale, and the two elections disagreeing.
   */
  disagrees: boolean;
}

/**
 * The majority `buildRationale()` named, when the stored prose is still its.
 *
 * Anchored at the start of the string, because that sentence is the ONLY thing
 * this can read without guessing: `buildRationale()` emits
 * `Majority stance is <stance> (<n> of <m> submitted takes)…`, or
 * `No stance data available on <subject>.` when there is no stance data at all.
 * Anything else is authored prose and out of scope — see the note above.
 */
const TEMPLATE_RATIONALE_LEAD = /^Majority stance is ([a-z]+) \(\d+ of \d+ submitted takes\)/;

function templateLeadStance(rationale: string): string | null {
  const named = TEMPLATE_RATIONALE_LEAD.exec(rationale)?.[1];
  return named && (STANCES as readonly string[]).includes(named) ? named : null;
}

/** One session's rationale/ladder check, over its stored recommendation. */
export function checkRationaleLadder(
  rec: Record<string, unknown>,
  subjectLabel: string,
  regimeSummary: unknown,
): RationaleLadderCheck {
  const byStance = (rec.stances && typeof rec.stances === "object" && !Array.isArray(rec.stances)
    ? rec.stances
    : {}) as Record<string, number>;
  const counts = Object.values(byStance).filter((n): n is number => typeof n === "number");
  const max = counts.length ? Math.max(...counts) : 0;
  const tiedStances = max > 0 ? Object.keys(byStance).filter((k) => byStance[k] === max).sort() : [];

  const storedRationale = typeof rec.rationale === "string" ? rec.rationale : null;
  const storedLeadStance = storedRationale === null ? null : templateLeadStance(storedRationale);
  const storedRationaleShape = storedRationale === null
    ? "absent" as const
    : storedLeadStance === null
    ? "authored" as const
    : "template" as const;

  const elected = majorityStance(byStance);
  const quorum = (rec.quorum ?? {}) as { submitted?: unknown };
  const submitted = typeof quorum.submitted === "number" ? quorum.submitted : counts.reduce((a, b) => a + b, 0);
  const rederivedRationale = elected
    ? buildRationale(
      subjectLabel,
      byStance,
      submitted,
      typeof rec.meanConfidence === "number" ? rec.meanConfidence : null,
      (regimeSummary as { composite_percentile?: number } | null) ?? null,
    )
    : null;

  return {
    tiedStances,
    storedRationale,
    storedRationaleShape,
    storedLeadStance,
    rederivedRationale,
    rederivedLeadStance: elected?.stance ?? null,
    disagrees: tiedStances.length >= 2 && storedLeadStance !== null && elected !== null &&
      storedLeadStance !== elected.stance,
  };
}

export interface RationaleLadderDrift extends RationaleLadderCheck {
  sessionId: string;
  date: string;
  subjectId: string;
  subjectLabel: string;
  disagrees: true;
}

export interface RationaleLadderReport {
  /** Published sessions carrying a `stances` object and a `rationale` string. */
  scanned: number;
  /** …of those, how many had two or more stances tied at the maximum. */
  tied: number;
  /** …of THOSE, how many still carry `buildRationale()`'s sentence rather than authored prose. */
  templateShaped: number;
  /** The affected set D42 promises to report. */
  drifted: RationaleLadderDrift[];
}

/**
 * Every PUBLISHED session in the set D42 promises to report.
 *
 * READ ONLY, per D42 — this SELECTs and returns; nothing here writes a
 * published row, and nothing should be added that does. The remedy for a listed
 * session is an operator reading the two strings, not a rewrite.
 *
 * It scans the whole published table rather than the replay's `--limit N`
 * window, because "the affected set" is not "the affected set among the ten
 * most recent sessions".
 */
export async function listRationaleLadderDrift(limit = 5000): Promise<RationaleLadderReport> {
  const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20000) : 5000;
  const rows = (await sql`
    SELECT id, date, subject_id, subject_name, swarm_recommendation, regime_summary
      FROM swarm_sessions
     WHERE state = 'published'
       AND jsonb_typeof(swarm_recommendation -> 'stances') = 'object'
       AND jsonb_typeof(swarm_recommendation -> 'rationale') = 'string'
     ORDER BY date DESC, id
     LIMIT ${bounded}`) as unknown as {
      id: string;
      date: Date | string;
      subject_id: string;
      subject_name: string | null;
      swarm_recommendation: Record<string, unknown> | null;
      regime_summary: unknown;
    }[];

  const report: RationaleLadderReport = { scanned: rows.length, tied: 0, templateShaped: 0, drifted: [] };
  for (const row of rows) {
    const subjectLabel = String(row.subject_name ?? row.subject_id);
    const check = checkRationaleLadder(row.swarm_recommendation ?? {}, subjectLabel, row.regime_summary ?? null);
    if (check.tiedStances.length < 2) continue;
    report.tied++;
    if (check.storedRationaleShape === "template") report.templateShaped++;
    if (!check.disagrees) continue;
    report.drifted.push({
      ...check,
      disagrees: true,
      sessionId: String(row.id),
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
      subjectId: String(row.subject_id),
      subjectLabel,
    });
  }
  return report;
}

/** The N most recently convened sessions that have something to judge. */
export async function recentJudgeableSessions(limit = 10): Promise<string[]> {
  const rows = (await sql`
    SELECT id FROM swarm_sessions
    WHERE state IN ('aggregated', 'judged', 'published')
    ORDER BY convened_at DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`) as unknown as { id: string }[];
  return rows.map((r) => String(r.id));
}
