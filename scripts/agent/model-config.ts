// Model configuration for the vanilla member-agent container.
//
// KEYLESS, NO EXCEPTIONS (docs/decisions.md D22 rule 1, docs/architecture.md
// §11.3 E1). The model id is an IN-CODE CONSTANT. This module reads no
// environment variable, holds no provider key, and exposes no resolver — there
// is deliberately no configuration surface through which a keyed or paid model
// could be selected on an eval path. A contributor with a fresh checkout,
// Docker, and network egress runs the identical eval CI runs.
//
// (scripts/lib/committee/inference.ts is a DIFFERENT surface — real committee
// TAKE authoring, gated behind COMMITTEE_REAL_INFERENCE — and keeps its own
// model resolution. This module is the onboarding eval's, and only that.)

// ── Model (in-code constant — E1: no env, no key, no opt-in) ────────────────
// Free, no-credential OpenCode Zen model. That is genuinely real inference — a
// real model call against a real provider tier, not a template or a mock —
// which is exactly why keyless is the ONLY mode: an eval measures whether a
// VANILLA agent can navigate this product unaided, and a keyed model would
// change the subject under test.
export const EVAL_MODEL = "opencode/big-pickle";

// opencode.json written per-run, mounted read-only into the container (never
// baked into the image). Carries NO onboarding-specific knowledge and no
// Robot Money connectivity config — the agent reaches the committee REST API
// with plain HTTP (bash), using the base URL carried in the prompt's harness
// note (D21: the MCP transport is retired, so there is no MCP client to wire).
//
// Takes no model parameter BY DESIGN: a parameter would be the last remaining
// way a caller could inject a model id into the container's config (E1).
export function buildAgentOpencodeConfig(): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model: EVAL_MODEL,
    autoupdate: false,
    permission: { "*": "deny", bash: "allow" },
  };
}
