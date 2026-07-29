import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalDefinition, EvalScore } from "./definition.ts";

export interface EvalCaseSummary {
  evalId: string;
  title: string;
  model: string;
  sampleCount: number;
  executedSamples: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  domainResults: unknown[];
  score: EvalScore | null;
  runnerStatus: "passed" | "failed";
  error?: string;
}

interface SuiteSummary {
  version: 1;
  suiteRunId: string;
  updatedAt: string;
  evals: EvalCaseSummary[];
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function evalSuiteRunId(env: Record<string, string | undefined> = process.env): string {
  const supplied = env.EVAL_SUITE_RUN_ID?.trim();
  if (supplied) {
    if (!/^[A-Za-z0-9._-]+$/.test(supplied)) throw new Error("EVAL_SUITE_RUN_ID contains unsafe path characters");
    return supplied;
  }
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

export class EvalSuiteArtifacts {
  readonly directory: string;
  private readonly manifestPath: string;
  private readonly summaryPath: string;

  constructor(
    readonly repoRoot: string,
    readonly suiteRunId: string,
  ) {
    this.directory = join(repoRoot, ".agents", "evals", suiteRunId);
    this.manifestPath = join(this.directory, "manifest.json");
    this.summaryPath = join(this.directory, "summary.json");
  }

  begin<Result>(definition: EvalDefinition<Result>, model: string): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const current = existsSync(this.manifestPath)
      ? JSON.parse(readFileSync(this.manifestPath, "utf8")) as { version: 1; suiteRunId: string; startedAt: string; evals: unknown[] }
      : { version: 1 as const, suiteRunId: this.suiteRunId, startedAt: new Date().toISOString(), evals: [] };
    const entry = {
      id: definition.id,
      title: definition.title,
      tags: definition.tags,
      tier: definition.tier,
      samples: definition.samples,
      timeoutMs: definition.timeoutMs,
      budget: definition.budget ?? null,
      model,
    };
    current.evals = [...current.evals.filter((item) => (item as { id?: string }).id !== definition.id), entry];
    writeJsonAtomic(this.manifestPath, current);
    if (!existsSync(this.summaryPath)) {
      writeJsonAtomic(this.summaryPath, { version: 1, suiteRunId: this.suiteRunId, updatedAt: new Date().toISOString(), evals: [] });
    }
  }

  finish(summary: EvalCaseSummary): void {
    const current = JSON.parse(readFileSync(this.summaryPath, "utf8")) as SuiteSummary;
    current.updatedAt = new Date().toISOString();
    current.evals = [...current.evals.filter((item) => item.evalId !== summary.evalId), summary];
    writeJsonAtomic(this.summaryPath, current);
  }
}
