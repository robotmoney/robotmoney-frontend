import { runCommitteeAuthoringEvalCase } from "../../scripts/committee-eval-local.ts";
import { registerEval } from "../support/register.ts";

registerEval({
  id: "committee.authoring",
  title: "Committee members author live takes in session",
  tags: ["committee", "authoring"],
  tier: "real-inference",
  samples: 1,
  timeoutMs: 15 * 60_000,
  budget: { maxCostUsd: 2 },
  async run(context) {
    const run = await runCommitteeAuthoringEvalCase({
      repoRoot: context.repoRoot,
      suiteRunId: context.suiteRunId,
      evalId: context.evalId,
      sampleId: context.sampleId,
    });
    return {
      sampleId: context.sampleId,
      passed: run.passed,
      authoredCount: run.authoredCount,
      durationMs: run.durationMs,
      artifactDirectory: run.artifactDirectory,
      sessionState: run.sessionState,
    };
  },
  score(results) {
    const passedCount = results.filter((result) => result.passed).length;
    const rate = passedCount / results.length;
    return {
      pass: passedCount === results.length,
      summary: `${passedCount}/${results.length} committee authoring sessions completed live takes`,
      metrics: { passRate: rate },
    };
  },
});
