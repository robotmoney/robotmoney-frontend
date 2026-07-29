import { runAdmissionEvalCase } from "../../scripts/onboarding-eval-local.ts";
import { registerEval } from "../support/register.ts";

registerEval({
  id: "onboarding.admission",
  title: "A prospective committee agent completes admission",
  tags: ["onboarding", "admission"],
  tier: "real-inference",
  samples: 1,
  timeoutMs: 35 * 60_000,
  budget: { maxCostUsd: 2 },
  async run(context) {
    const run = await runAdmissionEvalCase({
      repoRoot: context.repoRoot,
      suiteRunId: context.suiteRunId,
      evalId: context.evalId,
      sampleId: context.sampleId,
    });
    return {
      sampleId: context.sampleId,
      admitted: run.admitted,
      outcome: run.outcome,
      durationMs: run.durationMs,
      artifactDirectory: run.artifactDirectory,
    };
  },
  score(results) {
    const admitted = results.filter((result) => result.admitted).length;
    const rate = admitted / results.length;
    return {
      pass: admitted === results.length,
      summary: `${admitted}/${results.length} agents completed claimed admission`,
      metrics: { admissionRate: rate },
    };
  },
});
