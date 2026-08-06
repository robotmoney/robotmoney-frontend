// The one OpenCode invocation contract shared by direct member-agent runs and
// in-container swarm-session inference. Process/container lifecycle remains in
// those callers; model selection, timeout parsing, config, environment
// isolation, and the CLI's pinned-v1.18.1 argv shape live here.
//
// Prompts are deliberately NOT part of ResolvedOpenCodeRun. They are accepted
// only by buildOpenCodeRunArgs(), at the final execution boundary, so runtime
// metadata and telemetry can be serialized without accidentally persisting the
// exact prompt. Callers that retain argv must continue to apply their existing
// exact-prompt redaction before logging it.
import { providerOf } from "./inference-failure.ts";
import { resolveAgentModel } from "../lib/model-registry.ts";
import { ZEN_KEY_ENV } from "../lib/opencode-key.ts";

export const DEFAULT_OPENCODE_TIMEOUT_MS = 120_000;
export const DEFAULT_OPENCODE_EXECUTABLE = "opencode";
export const OPENCODE_LOG_LEVEL = "DEBUG";

export interface ResolveOpenCodeRunOptions {
  /** Explicitly resolved model; omit only when AGENT_MODEL should be read. */
  model?: string;
  /** Stable, non-secret title scope. The resolved model is appended to it. */
  titleScope: string;
  env?: Record<string, string | undefined>;
  executable?: string;
}

/** Safe-to-record metadata for one OpenCode run. It contains no prompt or key. */
export interface ResolvedOpenCodeRun {
  executable: string;
  model: string;
  provider: string;
  title: string;
  timeoutMs: number;
}

export function resolveOpenCodeTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.OPENCODE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_OPENCODE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `OPENCODE_TIMEOUT_MS must be a positive integer number of milliseconds; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function titlePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function deterministicOpenCodeTitle(scope: string, model: string): string {
  const safeScope = titlePart(scope);
  const safeModel = titlePart(model);
  if (!safeScope) throw new Error("OpenCode title scope must contain at least one safe character");
  if (!safeModel) throw new Error("OpenCode model must contain at least one safe character");
  return `${safeScope}-${safeModel}`;
}

export function resolveOpenCodeRun(options: ResolveOpenCodeRunOptions): ResolvedOpenCodeRun {
  const env = options.env ?? process.env;
  const model = options.model ?? resolveAgentModel(env);
  if (!model) throw new Error("OpenCode model is required");
  const executable = options.executable?.trim() || env.OPENCODE_BIN?.trim() || DEFAULT_OPENCODE_EXECUTABLE;
  return {
    executable,
    model,
    provider: providerOf(model),
    title: deterministicOpenCodeTitle(options.titleScope, model),
    timeoutMs: resolveOpenCodeTimeoutMs(env),
  };
}

/**
 * OpenCode 1.18.1 `run` arguments, excluding the executable.
 *
 * The prompt is always the final positional argument. Supplying --title is
 * load-bearing: it prevents OpenCode from starting an auxiliary GPT title
 * agent. --print-logs + DEBUG are supported by the pinned CLI and make a
 * pre-stream stall diagnosable.
 */
export function buildOpenCodeRunArgs(
  run: ResolvedOpenCodeRun,
  prompt: string,
  options: { directory?: string } = {},
): string[] {
  return [
    "run",
    "--model", run.model,
    "--format", "json",
    "--auto",
    "--title", run.title,
    "--print-logs",
    "--log-level", OPENCODE_LOG_LEVEL,
    ...(options.directory ? ["--dir", options.directory] : []),
    prompt,
  ];
}

/** Vanilla, non-interactive config mounted into direct member-agent runs. */
export function buildOpenCodeConfig(model: string): Record<string, unknown> {
  if (!model) throw new Error("OpenCode config model is required");
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    autoupdate: false,
    permission: { "*": "allow" },
  };
}

/**
 * Exact host environment allowed into an OpenCode subprocess. Product/admin
 * and member credentials never cross this boundary; only the Zen model key is
 * admitted, and only when present.
 */
export function buildOpenCodeSpawnEnv(
  hostEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TERM"]) {
    const value = hostEnv[key];
    if (value !== undefined) out[key] = value;
  }
  const modelKey = hostEnv[ZEN_KEY_ENV];
  if (modelKey) out[ZEN_KEY_ENV] = modelKey;
  return out;
}
