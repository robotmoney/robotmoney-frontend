import { test } from "bun:test";
import { redactTelemetryText } from "../../scripts/lib/onboarding-telemetry.ts";
import { resolveAgentModel } from "../../scripts/lib/model-registry.ts";
import { resolveAdmissionEvalModelConfig } from "../../scripts/onboarding-eval-local.ts";
import { EvalSuiteArtifacts, evalSuiteRunId, type EvalCaseSummary } from "./artifacts.ts";
import {
  planEvalSamples,
  validateEvalDefinition,
  validateEvalScore,
  EvalIdRegistry,
  type EvalDefinition,
  type EvalScore,
} from "./definition.ts";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const suiteRunId = evalSuiteRunId();
const registeredIds = new EvalIdRegistry();

export function registerEval<Result>(definition: EvalDefinition<Result>): void {
  validateEvalDefinition(definition);
  registeredIds.add(definition.id);

  test(
    `${definition.id}: ${definition.title} [${definition.tags.join(",")}]`,
    async () => {
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const artifacts = new EvalSuiteArtifacts(repoRoot, suiteRunId);
      let model = "unresolved";
      artifacts.begin(definition, model);
      const results: Result[] = [];
      let score: EvalScore | null = null;
      let error: unknown = null;
      try {
        model = resolveAgentModel(process.env);
        artifacts.begin(definition, model);
        resolveAdmissionEvalModelConfig(process.env);
        for (const sample of planEvalSamples(definition.id, definition.samples)) {
          results.push(await definition.run({
            suiteRunId,
            evalId: definition.id,
            sampleId: sample.sampleId,
            sampleIndex: sample.sampleIndex,
            sampleCount: definition.samples,
            repoRoot,
            model,
          }));
        }
        if (results.length === 0) throw new Error(`Eval ${definition.id} executed zero samples`);
        if (results.length !== definition.samples) {
          throw new Error(`Eval ${definition.id} executed ${results.length}/${definition.samples} samples`);
        }
        score = definition.score(results);
        validateEvalScore(definition.id, score);
        if (!score.pass) throw new Error(`Eval ${definition.id} scored red: ${score.summary}`);
      } catch (caught) {
        error = caught;
        throw caught;
      } finally {
        const summary: EvalCaseSummary = {
          evalId: definition.id,
          title: definition.title,
          model,
          sampleCount: definition.samples,
          executedSamples: results.length,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          domainResults: results,
          score,
          runnerStatus: error || !score?.pass ? "failed" : "passed",
          ...(error ? { error: redactTelemetryText(error instanceof Error ? error.message : String(error)) } : {}),
        };
        artifacts.finish(summary);
        console.log(`[eval] suite=${suiteRunId} id=${definition.id} artifacts=${artifacts.directory}`);
      }
    },
    definition.timeoutMs,
  );
}

export type { EvalBudget, EvalContext, EvalDefinition, EvalScore } from "./definition.ts";
