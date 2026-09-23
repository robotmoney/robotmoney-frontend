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
//   2. ON THE ACCEPTANCE PATH, ONLY THE PINNED MODEL. RM_ENV=prod is what
//      staging and production run (docs/technical/stack-orchestrator.md §16;
//      RM_ENV has no "staging" value and backend/src/config.ts refuses one), and
//      there AC-MODEL-01 names exactly one model. Development and the ephemeral
//      test database keep every id, because their judgements are not evidence
//      and their fixtures legitimately use stub ids like `test/judge-model`.
//
// WHY THE IDS ARE DUPLICATED HERE. backend/Dockerfile copies `backend/` and
// `contract/` and nothing else, so `scripts/lib/model-registry.ts` — the pinned
// registry — does not exist inside the api or worker image; importing it would
// break the container build, not the type check. The duplication is therefore
// deliberate, and it is kept honest by a test that reads BOTH files and fails
// when they disagree (scripts/tests/unit/judge-model-policy-matches-registry.test.ts).
// One list in source with a cross-check beats one list in source and one in an
// operator's memory.

import { isAcceptanceJudgeEnv, type InferencePathOptions } from "../acceptance-path.ts";

/** The wire id AC-MODEL-01 pins, without the `opencode/` prefix Zen's REST endpoint rejects. */
export const PINNED_JUDGE_MODEL = "deepseek-v4-flash";

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
// backend/src/acceptance-path.ts and shared with the scripts half — this file
// re-exports it so its own callers (postflight, setJudgeConfig) keep importing
// the judge-flavoured name, and so there is no second definition to drift.
export { isAcceptanceJudgeEnv } from "../acceptance-path.ts";

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
  env: Record<string, string | undefined> = process.env,
  opts: InferencePathOptions = {},
): void {
  const id = model.trim();
  if (isKeylessJudgeModel(id)) {
    throw new Error(
      `judge model "${id}" is in OpenCode Zen's keyless free family, which is DISQUALIFIED for acceptance ` +
        `(AC-MODEL-01: "a run in which any agent used a free-tier model is not evidence"). A keyless model needs ` +
        `no credential, so it degrades silently instead of failing closed. Use "${PINNED_JUDGE_MODEL}".`,
    );
  }
  if (isAcceptanceJudgeEnv(env, opts) && id !== PINNED_JUDGE_MODEL) {
    throw new Error(
      `judge model "${id}" is not the pinned acceptance model. RM_ENV=${(env.RM_ENV ?? "<unset>").trim() || "<unset>"} is an ` +
        `acceptance path, where AC-MODEL-01 requires every swarm agent — analysts and judge alike — to run ` +
        `exactly "${PINNED_JUDGE_MODEL}" on paid OpenCode Zen inference. Set that id (no "opencode/" prefix: ` +
        "Zen's REST endpoint answers the prefixed selector with 401 ModelError), or run this configuration on a " +
        "development environment where its judgements are not evidence.",
    );
  }
}
