// WHICH MODEL THE JUDGE IS ALLOWED TO BE POINTED AT (AC-MODEL-01).
//
// AC-MODEL-01 covers BOTH agent roles — "proposers/analysts and
// validators/judges alike" — and the analyst half got its refusal in
// scripts/lib/onboarding-eval.ts's resolveModelConfig(). The judge's model does
// not come from AGENT_MODEL at all: it comes from the `swarm_judge_config.model`
// column, and until this file existed the ONLY thing asserted about that column
// was that it is non-empty (migration 0056's CHECK, and setJudgeConfig()'s own
// length test). So `setJudgeConfig({ mode: "enforce", model:
// "nemotron-3-ultra-free" })` was accepted, stored, and posted verbatim to Zen
// by resolveJudgeTransport — a keyless free-tier judge passing every gate the
// 0.5.0 rollout adds, and disqualifying the whole run under AC-MODEL-01's "a run
// in which any agent used a free-tier model is not evidence".
//
// TWO RULES, DELIBERATELY DIFFERENT IN STRENGTH.
//
//   1. THE FREE FAMILY IS REFUSED EVERYWHERE. A keyless model needs no
//      credential, which is exactly why it degrades silently instead of failing
//      closed: it is the one selection that can look healthy while producing
//      nothing usable. No environment has a reason to judge on one, so this rule
//      has no environment clause.
//
//   2. ON THE ACCEPTANCE PATH, ONLY THE PINNED MODEL. The acceptance path is
//      every stack whose judgements are evidence, and no environment value
//      decides it (backend/src/acceptance-path.ts, D69 (6)): the api and the
//      participant judge apply the pin on every deployed stack. Only the armed
//      test harness keeps every id, because its judgements are not evidence and
//      its fixtures legitimately use stub ids like `test/judge-model`.
//
// WHY THE IDS ARE DUPLICATED HERE. backend/Dockerfile copies `backend/` and
// `contract/` and nothing else, so `scripts/lib/model-registry.ts` — the pinned
// registry — does not exist inside the api or worker image; importing it would
// break the container build, not the type check. The duplication is therefore
// deliberate, and it is kept honest by a test that reads BOTH files and fails
// when they disagree (scripts/tests/unit/judge-model-policy-matches-registry.test.ts).
// One list in source with a cross-check beats one list in source and one in an
// operator's memory.

import { isAcceptancePath, resolveInferencePath, type InferencePathOptions } from "../acceptance-path.ts";

/** The wire id AC-MODEL-01 pins, without the `opencode/` prefix Zen's REST endpoint rejects. */
export const PINNED_JUDGE_MODEL = "deepseek-v4.1-flash";

// MODEL CUTOFF DATES (issue 1742). A model asked to act as of a date before its
// training cutoff already knows what happened next, so a session dated before the
// configured judge model's cutoff is refused (model-cutoff.ts). No provider's
// published cutoff is recorded here: each value is the date the registry first
// verified the model (2026-07-28), a safe upper bound. A model absent from this
// table has no declared cutoff and is refused for any date before today. Kept in
// lockstep with `cutoff` in scripts/lib/model-registry.ts by
// scripts/tests/unit/judge-model-policy-matches-registry.test.ts.
const VERIFIED_ON = "2026-07-28";
export const MODEL_CUTOFF_DATES: Readonly<Record<string, string>> = Object.freeze({
  "deepseek-v4.1-flash": VERIFIED_ON,
  "deepseek-v4-pro": VERIFIED_ON,
  "kimi-k2.7-code": VERIFIED_ON,
  "kimi-k2.6": VERIFIED_ON,
  "kimi-k2.5": VERIFIED_ON,
  "kimi-k3": VERIFIED_ON,
  "claude-sonnet-5": VERIFIED_ON,
  "claude-haiku-4-5": VERIFIED_ON,
  "claude-opus-5": VERIFIED_ON,
  "claude-fable-5": VERIFIED_ON,
  "gpt-5.4": VERIFIED_ON,
  "gpt-5.4-mini": VERIFIED_ON,
  "gpt-5.4-nano": VERIFIED_ON,
  "gpt-5.5": VERIFIED_ON,
  "gpt-5-codex": VERIFIED_ON,
  "gpt-5.3-codex": VERIFIED_ON,
  "glm-5.2": VERIFIED_ON,
  "glm-5.1": VERIFIED_ON,
  "glm-5": VERIFIED_ON,
  "minimax-m3": VERIFIED_ON,
  "minimax-m2.7": VERIFIED_ON,
  "minimax-m2.5": VERIFIED_ON,
  "qwen3.6-plus": VERIFIED_ON,
  "qwen3.5-plus": VERIFIED_ON,
  "grok-4.5": VERIFIED_ON,
  "grok-build-0.1": VERIFIED_ON,
  "gemini-3-flash": VERIFIED_ON,
  "gemini-3.6-flash": VERIFIED_ON,
  "gemini-3.1-pro": VERIFIED_ON,
  "nemotron-3-ultra-free": VERIFIED_ON,
  "ling-3.0-flash-free": VERIFIED_ON,
  "north-mini-code-free": VERIFIED_ON,
  "big-pickle": VERIFIED_ON,
});

/**
 * Zen's keyless family, mirrored from scripts/lib/model-registry.ts's `free`
 * family. Note `big-pickle`: the registry's own comment records that it is the
 * one keyless id with no `-free` suffix, which is exactly why a suffix rule
 * alone would not have caught it.
 */
export const FREE_FAMILY_JUDGE_MODELS: readonly string[] = Object.freeze([
  "nemotron-3-ultra-free",
  "ling-3.0-flash-free",
  "north-mini-code-free",
  "big-pickle",
]);

/** True when this id is served by Zen's no-credential free tier. */
export function isKeylessJudgeModel(model: string): boolean {
  const id = model.trim().replace(/^opencode\//, "").toLowerCase();
  return FREE_FAMILY_JUDGE_MODELS.includes(id) || id.endsWith("-free");
}

// The acceptance predicate is NOT defined here. It is one rule, owned by
// backend/src/acceptance-path.ts and shared with the scripts half.

/**
 * Refuse a judge model this environment may not use. Throws with the reason an
 * operator can act on; returns silently otherwise.
 *
 * Called from setJudgeConfig() on the ACCEPTANCE path of the write — i.e. before
 * the row is stored — so a disqualified model never reaches the column that
 * resolveJudgeTransport() posts verbatim.
 */
export function assertJudgeModelAllowed(
  model: string,
  opts: InferencePathOptions = {},
): void {
  const id = model.trim();
  const path = resolveInferencePath(opts);
  if (isKeylessJudgeModel(id)) {
    throw new Error(
      `judge model "${id}" is in OpenCode Zen's keyless free family, which is DISQUALIFIED for acceptance ` +
        `(AC-MODEL-01: "a run in which any agent used a free-tier model is not evidence"). A keyless model needs ` +
        `no credential, so it degrades silently instead of failing closed. Use "${PINNED_JUDGE_MODEL}".`,
    );
  }
  if (isAcceptancePath(path) && id !== PINNED_JUDGE_MODEL) {
    throw new Error(
      `judge model "${id}" is not the pinned acceptance model. This process is on the ${path} ` +
        `acceptance path, where AC-MODEL-01 requires every swarm agent — analysts and judge alike — to run ` +
        `exactly "${PINNED_JUDGE_MODEL}" on paid OpenCode Zen inference. Set that id (no "opencode/" prefix: ` +
        "Zen's REST endpoint answers the prefixed selector with 401 ModelError). Every deployed stack " +
        "applies this pin; only the armed test harness keeps a stub judge model.",
    );
  }
}
