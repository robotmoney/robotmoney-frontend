export interface EvalBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCostUsd?: number;
}

export interface EvalContext {
  suiteRunId: string;
  evalId: string;
  sampleId: string;
  sampleIndex: number;
  sampleCount: number;
  repoRoot: string;
  model: string;
}

export interface EvalScore {
  pass: boolean;
  summary: string;
  metrics?: Record<string, number>;
}

export interface EvalDefinition<Result> {
  id: string;
  title: string;
  tags: readonly string[];
  tier: "real-inference";
  samples: number;
  timeoutMs: number;
  budget?: EvalBudget;
  run(context: EvalContext): Promise<Result>;
  score(results: readonly Result[]): EvalScore;
}

export interface EvalSamplePlan {
  sampleId: string;
  sampleIndex: number;
}

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function validateEvalDefinition<Result>(definition: EvalDefinition<Result>): void {
  if (!ID.test(definition.id)) throw new Error(`Invalid eval id ${JSON.stringify(definition.id)}`);
  if (!definition.title.trim()) throw new Error(`Eval ${definition.id} must have a title`);
  if (definition.tier !== "real-inference") throw new Error(`Eval ${definition.id} must declare the real-inference tier`);
  if (!Number.isSafeInteger(definition.samples) || definition.samples <= 0) {
    throw new Error(`Eval ${definition.id} must execute at least one sample`);
  }
  if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0) {
    throw new Error(`Eval ${definition.id} must have a positive timeoutMs`);
  }
  if (new Set(definition.tags).size !== definition.tags.length || definition.tags.some((tag) => !ID.test(tag))) {
    throw new Error(`Eval ${definition.id} tags must be unique stable ids`);
  }
  for (const [name, value] of Object.entries(definition.budget ?? {})) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`Eval ${definition.id} budget ${name} must be positive`);
    }
  }
}

export function planEvalSamples(evalId: string, count: number): EvalSamplePlan[] {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`Eval ${evalId} planned zero samples`);
  const width = Math.max(2, String(count).length);
  return Array.from({ length: count }, (_, sampleIndex) => ({
    sampleIndex,
    sampleId: `sample-${String(sampleIndex + 1).padStart(width, "0")}`,
  }));
}

export function validateEvalScore(evalId: string, score: EvalScore): void {
  if (typeof score.pass !== "boolean" || !score.summary.trim()) {
    throw new Error(`Eval ${evalId} returned an invalid score`);
  }
}

export class EvalIdRegistry {
  private readonly ids = new Set<string>();

  add(id: string): void {
    if (this.ids.has(id)) throw new Error(`Duplicate eval id ${id}`);
    this.ids.add(id);
  }
}

export function scoreEvalResults<Result>(definition: EvalDefinition<Result>, results: readonly Result[]): EvalScore {
  if (results.length === 0) throw new Error(`Eval ${definition.id} executed zero samples`);
  if (results.length !== definition.samples) {
    throw new Error(`Eval ${definition.id} executed ${results.length}/${definition.samples} samples`);
  }
  const score = definition.score(results);
  validateEvalScore(definition.id, score);
  if (!score.pass) throw new Error(`Eval ${definition.id} scored red: ${score.summary}`);
  return score;
}
