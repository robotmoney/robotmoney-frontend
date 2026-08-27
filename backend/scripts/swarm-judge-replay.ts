#!/usr/bin/env bun
// Replay recent REAL sessions through the consensus judge (issue #752, 2.9).
//
// Validate against history, not fixtures. A fixture contains what its author
// thought of; live history contains absences, thin quorums, superseded
// revisions, and members whose keys have rotated since they filed. This script
// runs the judge over sessions that have already published and reports, per
// session, whether its weight vector moved.
//
// IT WRITES NOTHING. No judgement row, no session update, no state transition —
// replaySessionJudge() reads and reports. That is what makes it safe to point at
// a production database with a read-only role, which is the only way "validated
// against real traffic" means anything.
//
// The expected answer is that EVERY vector is unchanged, because judging cannot
// touch a vector by construction. A single `MOVED` line is a defect report, and
// this exits non-zero on one.
//
//   bun run scripts/swarm-judge-replay.ts [--limit N] [--session <uuid>] [--json]
//
// A model is used only if `swarm_judge_config.model` is set AND OPENCODE_API_KEY
// is in the environment; otherwise every session replays through the template
// producers, which still exercises the whole seam.
import { recentJudgeableSessions, replaySessionJudge } from "../src/swarm/judge-session.ts";

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
let moved = 0;
for (const id of sessionIds) {
  const replay = await replaySessionJudge(id);
  if (!replay) {
    console.error(`${id}  NOT FOUND`);
    process.exit(1);
  }
  if (!replay.weightsUnchanged) moved++;
  results.push({
    sessionId: replay.sessionId,
    state: replay.state,
    takeCount: replay.takeCount,
    weightsUnchanged: replay.weightsUnchanged,
    source: replay.outcome.source,
    fallbackReason: replay.outcome.fallbackReason ?? null,
    thinlySupported: replay.outcome.opinion.release_safety.thinly_supported,
    release: replay.outcome.opinion.release_safety.release,
    promptHash: replay.outcome.promptHash,
    inputsDigest: replay.outcome.inputsDigest,
  });
  if (!asJson) {
    console.log(
      [
        replay.weightsUnchanged ? "unchanged" : "MOVED    ",
        replay.sessionId,
        `state=${replay.state}`,
        `takes=${replay.takeCount}`,
        `judge=${replay.outcome.source}${replay.outcome.fallbackReason ? `(${replay.outcome.fallbackReason})` : ""}`,
        `release=${replay.outcome.opinion.release_safety.release}`,
        replay.outcome.opinion.release_safety.thinly_supported ? "THIN" : "",
      ].join("  ").trimEnd(),
    );
  }
}

if (asJson) console.log(JSON.stringify({ sessions: results, moved }, null, 2));
else console.log(`\n${results.length} session(s) replayed, ${moved} weight vector(s) moved`);
process.exit(moved === 0 ? 0 : 1);
