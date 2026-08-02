import { runSwarmAuthoringEvalCase } from "../../scripts/swarm-eval-local.ts";
import { registerEval } from "../support/register.ts";

registerEval({
  id: "swarm.authoring",
  title: "Swarm members author live takes in session",
  tags: ["swarm", "authoring"],
  tier: "real-inference",
  samples: 1,
  timeoutMs: 15 * 60_000,
  budget: { maxCostUsd: 2 },
  async run(context) {
    const run = await runSwarmAuthoringEvalCase({
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
      summary: `${passedCount}/${results.length} swarm authoring sessions completed live takes`,
      metrics: { passRate: rate },
    };
  },
});
