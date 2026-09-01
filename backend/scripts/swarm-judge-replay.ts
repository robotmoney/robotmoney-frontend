#!/usr/bin/env bun
// Audit REAL sessions against the two properties the consensus receipt rests on
// (issue #752 §2.9; rebuilt by #766).
//
// Validate against history, not fixtures. A fixture contains what its author
// thought of; live history contains absences, thin quorums, superseded
// revisions, and members whose keys have rotated since they filed.
//
// IT WRITES NOTHING. No judgement row, no session update, no state transition,
// and — per D42 — no repair of a published row. That is what makes it safe to
// point at a production database with a read-only role, which is the only way
// "validated against real traffic" means anything.
//
// WHAT IT REPORTS, AND WHY THE HEADLINE CHANGED (issue #766). This script used
// to print one column: whether a session's weight vector "moved" across the
// judge call. That was a comparison of `swarm_recommendation.weights` against
// itself across a call that writes nothing — true by construction, and the only
// defect it could ever report was `judge()` starting to write. Three checks
// now, named separately:
//
//   REPRODUCIBILITY (fails the run). Does the session's STORED vector still
//   equal `meanTakeWeights()` over its CURRENT frozen take set? D4 puts the
//   signed number on that function, so this is the property "anyone holding the
//   take set can recompute the vector" — and nothing asserted it against real
//   history before. A `MISMATCH` line means a published number can no longer be
//   re-derived from the takes it claims to summarize.
//
//   JUDGE-WROTE-NOTHING (fails the run). Kept, and named for what it is: a
//   guard on THIS path, not evidence about history. A `WROTE` line means some
//   code on the replay path started writing the column.
//
//   RATIONALE / LADDER DRIFT (reports, does NOT fail the run). The enumeration
//   D42 promises: published sessions whose `stances` has two or more keys tied
//   at the maximum and whose stored rationale leads with a stance the fixed
//   deterministic ladder would not elect. These are HISTORY, filed under the
//   pre-fix tie-break and deliberately not rewritten — so they are printed for
//   an operator to read, and they do not turn the exit code red. A run that
//   went red on them would be permanently red on any deployment that has one,
//   which is how a report gets ignored.
//
//   bun run scripts/swarm-judge-replay.ts [--limit N] [--session <uuid>] [--json]
//
// `--limit` bounds the REPLAY window (the N most recently convened judgeable
// sessions). The D42 enumeration is not bounded by it: "the affected set" is
// not "the affected set among the ten most recent sessions", so it scans every
// published session. `--session` narrows the replay to one and skips the
// enumeration.
//
// A model is used only if `swarm_judge_config.model` is set AND OPENCODE_API_KEY
// is in the environment; otherwise every session replays through the template
// producers, which still exercises the whole seam.
import {
  listRationaleLadderDrift,
  recentJudgeableSessions,
  replaySessionJudge,
} from "../src/swarm/judge-replay.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const asJson = process.argv.includes("--json");
const only = arg("session");
const limit = Number(arg("limit") ?? 10);

const sessionIds = only ? [only] : await recentJudgeableSessions(Number.isFinite(limit) ? limit : 10);
if (sessionIds.length === 0) {
  console.error("no judgeable sessions found (need state aggregated | judged | published)");
  process.exit(1);
}

const results = [];
let mismatched = 0;
let wrote = 0;
for (const id of sessionIds) {
  const replay = await replaySessionJudge(id);
  if (!replay) {
    console.error(`${id}  NOT FOUND`);
    process.exit(1);
  }
  if (replay.weightsVerdict === "mismatch") mismatched++;
  if (!replay.judgeWroteNothing) wrote++;
  results.push({
    sessionId: replay.sessionId,
    date: replay.date,
    subjectId: replay.subjectId,
    subjectLabel: replay.subjectLabel,
    state: replay.state,
    takeCount: replay.takeCount,
    weightsVerdict: replay.weightsVerdict,
    weightsReproducible: replay.weightsReproducible,
    weightsStored: replay.weightsStored,
    weightsRederived: replay.weightsRederived,
    judgeWroteNothing: replay.judgeWroteNothing,
    rationaleDisagrees: replay.rationale.disagrees,
    tiedStances: replay.rationale.tiedStances,
    source: replay.outcome.source,
    fallbackReason: replay.outcome.fallbackReason ?? null,
    thinlySupported: replay.outcome.opinion.release_safety.thinly_supported,
    release: replay.outcome.opinion.release_safety.release,
    promptHash: replay.outcome.promptHash,
    inputsDigest: replay.outcome.inputsDigest,
  });
  if (!asJson) {
    const verdict = replay.weightsVerdict === "mismatch"
      ? "MISMATCH "
      : replay.weightsVerdict === "not_applicable"
      ? "n/a      "
      : "reproduced";
    console.log(
      [
        verdict,
        replay.sessionId,
        `state=${replay.state}`,
        `takes=${replay.takeCount}`,
        `judge=${replay.outcome.source}${replay.outcome.fallbackReason ? `(${replay.outcome.fallbackReason})` : ""}`,
        `release=${replay.outcome.opinion.release_safety.release}`,
        replay.outcome.opinion.release_safety.thinly_supported ? "THIN" : "",
        replay.judgeWroteNothing ? "" : "JUDGE-WROTE-THE-VECTOR",
      ].join("  ").trimEnd(),
    );
    if (replay.weightsVerdict === "mismatch") {
      console.log(`           stored:    ${JSON.stringify(replay.weightsStored)}`);
      console.log(`           rederived: ${JSON.stringify(replay.weightsRederived)}`);
    }
  }
}

// The D42 enumeration. Skipped for a single-session run — `--session` is an
// operator asking about one session, not for a deployment-wide census.
const drift = only ? null : await listRationaleLadderDrift();

if (asJson) {
  console.log(JSON.stringify({ sessions: results, mismatched, wrote, rationaleDrift: drift }, null, 2));
} else {
  console.log(
    `\n${results.length} session(s) replayed, ${mismatched} vector(s) no longer reproducible, ` +
      `${wrote} vector(s) written by the replay`,
  );
  if (drift) {
    console.log(
      `\nD42 tie-break report — published sessions whose stored rationale names a majority\n` +
        `the fixed ladder would not elect. Reported, NOT rewritten: append-only history stays\n` +
        `as it was filed (docs/decisions.md, D42).`,
    );
    // The denominators, so an empty list is legibly "nothing to report" rather
    // than indistinguishable from "this scan found nothing to look at".
    console.log(
      `  scanned ${drift.scanned} published session(s); ${drift.tied} with a tie at the maximum; ` +
        `${drift.templateShaped} of those still carrying the template rationale.`,
    );
    if (drift.drifted.length === 0) {
      console.log("  none — every tied published session's template rationale agrees with the ladder.");
    }
    for (const d of drift.drifted) {
      console.log(`\n  ${d.sessionId}  ${d.date}  ${d.subjectLabel} (${d.subjectId})`);
      console.log(`    tied at the maximum: ${d.tiedStances.join(", ")}`);
      console.log(`    stored    (names "${d.storedLeadStance}"): ${d.storedRationale}`);
      console.log(`    rederived (names "${d.rederivedLeadStance}"): ${d.rederivedRationale}`);
    }
    console.log(`\n${drift.drifted.length} published session(s) in the D42 affected set`);
  }
}

// Drift is deliberately NOT in the exit code — see the header.
process.exit(mismatched === 0 && wrote === 0 ? 0 : 1);
