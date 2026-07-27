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
//
// ── Why `external_directory` is spelled out (2026-07-27) ────────────────────
// opencode's own default permission set contains
// `external_directory: { "*": "ask", <its tool-output dir>: "allow",
// /tmp/opencode/*: "allow" }` — confirmed with `opencode debug agent build`
// inside the pinned image. `--dangerously-skip-permissions` (the flag
// scripts/agent/member-agent.ts already passes; a hidden alias of `--auto` in
// the pinned binary) does NOT lift it: the 2026-07-27 layer-4 run passed that
// flag and opencode still rejected the calls, citing that exact rule. In a
// non-interactive `opencode run` an "ask" has nobody to ask, so it resolves to
// a REJECTION rather than a wait — the rejections came back in under a second
// each, which is also why they are not what burned the run's wall clock.
//
// The effect, observed live in the 2026-07-27 layer-4 sweep: an agent that
// discovers the committee-onboarding skill by cloning robotmoney-core into
// /tmp — a route this harness's own notes record as previously working — can
// `ls` its way to SKILL.md and then cannot read one byte of it. `cat`, `head`
// and friends are intercepted by opencode's shell tool, which asks for
// `external_directory` on the target path; `ls` and `git clone` are not, which
// is why the transcript shows some commands succeeding and others rejected.
// Everything outside `--dir /home/agent` is "external", so the agent was
// structurally unable to read the very document the eval measures it for.
//
// This line restores the intent the harness ALREADY declares by passing
// --dangerously-skip-permissions: inside a throwaway, network-isolated,
// single-use container there is no permission gate. Verified against the
// pinned opencode 1.18.1 with `opencode debug agent build`: adding it appends
// `external_directory * → allow` AFTER the default `external_directory * →
// ask`, and later rules win (the same mechanism by which the `* → deny` below
// overrides opencode's own default `* → allow`). Nothing else in the resolved
// rule set changes.
//
// It carries no onboarding knowledge: it names no path, host, repository, or
// step — only that this container does not stop to ask permission.
export function buildAgentOpencodeConfig(): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model: EVAL_MODEL,
    autoupdate: false,
    permission: { "*": "deny", bash: "allow", external_directory: "allow" },
  };
}
