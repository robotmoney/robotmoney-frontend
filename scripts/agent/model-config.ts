// Model configuration for the vanilla member-agent container.
//
// Moved verbatim out of scripts/lib/onboarding-eval.ts (docs/architecture.md §3
// L2/L3, docs/decisions.md D23 rule 2): scripts/agent/member-agent.ts needs the
// ModelConfig type, and importing it back from scripts/lib/ would invert the
// shared → runtime dependency direction. Zero logic change; this is the single
// file D22 rule 1's keyless work will later edit.

// ── Model configuration (real inference is the default, not opt-in — and it
//    needs no secret: the default model is the same free, no-credential
//    OpenCode Zen tier scripts/lib/committee/inference.ts already uses) ───────
export const MODEL_API_KEY_ENV_CANDIDATES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

// Free, no-credential OpenCode Zen model (mirrors scripts/lib/committee/inference.ts's
// DEFAULT_INFERENCE_MODEL exactly — same pin, same rationale: real inference,
// no secret required). Pinned for determinism; override via OPENCODE_MODEL.
export const DEFAULT_INFERENCE_MODEL = "opencode/big-pickle";

export interface ModelConfig {
  model: string;
  apiKeyEnv: (typeof MODEL_API_KEY_ENV_CANDIDATES)[number] | null;
  apiKey: string | null;
}

// Resolves to the free keyless default UNLESS an operator explicitly opts
// into a different model via OPENCODE_MODEL — in which case a matching
// provider key is required and its absence THROWS loudly (never falls back
// to a different model than the one explicitly requested; never falls back
// to a scripted path either way — see scripts/lib/onboarding-eval.ts's
// module doc comment).
export function resolveModelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
  const model = env.OPENCODE_MODEL?.trim() || DEFAULT_INFERENCE_MODEL;

  if (model === DEFAULT_INFERENCE_MODEL) {
    // No key needed or passed through — even if one happens to be set in the
    // environment for an unrelated reason, the keyless default never uses it.
    return { model, apiKeyEnv: null, apiKey: null };
  }

  const apiKeyEnv = MODEL_API_KEY_ENV_CANDIDATES.find((name) => env[name]?.trim());
  if (!apiKeyEnv) {
    throw new Error(
      `OPENCODE_MODEL=${model} was explicitly requested but no provider key is configured ` +
        `(checked ${MODEL_API_KEY_ENV_CANDIDATES.join(", ")}). Refusing to silently fall back to a ` +
        `different model — either configure the matching key, or unset OPENCODE_MODEL to use the ` +
        `default free keyless tier (${DEFAULT_INFERENCE_MODEL}).`,
    );
  }
  return { model, apiKeyEnv, apiKey: env[apiKeyEnv]!.trim() };
}

// opencode.json written per-run, mounted read-only into the container (never
// baked into the image). Carries NO onboarding-specific knowledge and no
// Robot Money connectivity config — the agent reaches the committee REST API
// with plain HTTP (bash), using the base URL carried in the prompt's harness
// note (D21: the MCP transport is retired, so there is no MCP client to wire).
export function buildAgentOpencodeConfig(model: string): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    autoupdate: false,
    permission: { "*": "deny", bash: "allow" },
  };
}
