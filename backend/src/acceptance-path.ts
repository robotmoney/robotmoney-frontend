// WHICH ENVIRONMENT IS ASKING — ONE MODULE, ONE ANSWER (AC-MODEL-01, D13).
//
// Two halves of the same control used to decide "is this an acceptance path?"
// independently, and they disagreed about the case that actually occurred on a
// host: an UNSET `RM_ENV`.
//
//   * backend/src/swarm/judge-model-policy.ts's isAcceptanceJudgeEnv() read
//     `RM_ENV ?? "prod"` — unset meant STRICT.
//   * scripts/lib/onboarding-eval.ts's resolveInferencePath() returned
//     `development` for an unset value — unset meant PERMISSIVE.
//
// Both were green, each pinned by its own test, and between them a staging
// stack could refuse a judge model while accepting a keyless analyst model, or
// the reverse, depending on which half was consulted. D13 settles it: AN UNSET
// `RM_ENV` IS THE ACCEPTANCE PATH. That is backend/src/config.ts's own stated
// convention ("fail-closed: default to prod when RM_ENV is unset", :700-705),
// and it is the only default that is safe to be wrong about — a developer who
// wants the permissive path types it; an operator who forgets gets refused
// rather than silently unpinned.
//
// AND THE SECOND HALF OF D13, which is what makes the default a backstop rather
// than a daily behaviour: `RM_ENV` is a property of the STACK CONFIG, not of the
// operator's shell. scripts/stack/config.ts's buildComposeEnv() emits it
// explicitly for every service, and docker-compose.yml's interpolation default
// is `prod` — so "unset inside a container" stops occurring, and if it ever
// does occur it fails closed. The 2026-09-13 incident (rm-frontend-stage-1 found
// running `RM_ENV=smoke`, every judgement it produced worthless as evidence) is
// the cost of the previous arrangement, where the value came from whatever the
// operator last typed.
//
// WHY THIS FILE LIVES UNDER backend/src/. backend/Dockerfile copies `backend/`
// and `contract/` and nothing else, so a module under `scripts/` cannot be
// imported by the api or worker image. `scripts/` runs on the host and can
// import this file by relative path. One direction works; the other does not.

/** The backend's runtime modes (backend/src/config.ts's VALID_ENVS). */
export const RM_ENV_VALUES = ["ephemeral", "smoke", "prod"] as const;
export type RmEnv = (typeof RM_ENV_VALUES)[number];

/** The environment classes an inference/judge policy distinguishes. */
export type InferencePath = "development" | "staging" | "production";

export interface InferencePathOptions {
  /**
   * Stated outright by a caller that knows which environment it is booting.
   * Wins over every derived signal — nothing about this decision should have to
   * be inferred when the caller already knows. This is ALSO the backend half's
   * escape hatch, which it previously did not have.
   */
  path?: InferencePath;
  /**
   * The STANDING stack: `bun smoke --static-port`, the boot a
   * tunnel points at. That is the staging deployment whatever `RM_ENV` says, so
   * it can only ever TIGHTEN the answer, never loosen it.
   */
  standingStack?: boolean;
}

/** `ephemeral | smoke | prod`, or null for anything else (including unset). */
export function parseRmEnv(raw: string | undefined | null): RmEnv | null {
  const v = (raw ?? "").trim();
  return (RM_ENV_VALUES as readonly string[]).includes(v) ? (v as RmEnv) : null;
}

/**
 * Which environment is asking.
 *
 * THE ONE RULE, and every caller gets this one:
 *   1. an explicit `path` wins;
 *   2. `RM_ENV=smoke` / `RM_ENV=ephemeral` is `development` — an operator's own
 *      boot, unless (3) says otherwise;
 *   3. the standing stack is `staging` whatever else is true;
 *   4. everything else — `RM_ENV=prod`, an unset value, a blank value, or a
 *      value that is not one of the three — is `production`.
 *
 * Note that (4) covers an INVALID value too. backend/src/config.ts refuses to
 * start on one, but this predicate is also called from host-side scripts that
 * have no such guard, and a typo must not read as "development".
 */
export function resolveInferencePath(
  env: Record<string, string | undefined> = process.env,
  opts: InferencePathOptions = {},
): InferencePath {
  if (opts.path) return opts.path;
  const rm = parseRmEnv(env.RM_ENV);
  if (rm === "smoke" || rm === "ephemeral") {
    return opts.standingStack === true ? "staging" : "development";
  }
  if (rm === null && opts.standingStack === true) return "staging";
  return "production";
}

/** True where AC-MODEL-01's refusals apply: everything that is not a dev box. */
export function isAcceptancePath(path: InferencePath): boolean {
  return path !== "development";
}

/**
 * The judge half, expressed as the SAME predicate rather than as a second rule:
 * `isAcceptanceJudgeEnv(e) === isAcceptancePath(resolveInferencePath(e))` for
 * every env, by construction. Pinned by a table test in
 * scripts/tests/unit/judge-model-policy-matches-registry.test.ts.
 */
export function isAcceptanceJudgeEnv(
  env: Record<string, string | undefined> = process.env,
  opts: InferencePathOptions = {},
): boolean {
  return isAcceptancePath(resolveInferencePath(env, opts));
}

/**
 * WHICH `RM_ENV` THE STACK ITSELF DECLARES — the value buildComposeEnv() emits.
 *
 * `declared` is what the operator's shell carried. It is not authoritative and
 * cannot loosen the answer:
 *
 *   * a `--static-port` boot IS the staging deployment, so it is `prod`, and a
 *     `declared` value that says otherwise is REFUSED rather than silently
 *     overridden — the operator believes something false and must be told;
 *   * any other boot of the smoke stack is that operator's own development
 *     stack, so it declares `smoke` unless they asked for something else. This
 *     is NOT the "unset means development" rule coming back: the value is
 *     derived from the KIND OF BOOT the orchestrator knows it is performing,
 *     and it is written into the containers' environment explicitly, which is
 *     precisely what stops any reader from having to guess.
 */
export function resolveStackRmEnv(opts: { standingStack: boolean; declared?: string | undefined }): RmEnv {
  const raw = (opts.declared ?? "").trim();
  const parsed = parseRmEnv(raw);
  if (raw !== "" && parsed === null) {
    throw new Error(
      `invalid RM_ENV "${raw}" — expected one of ${RM_ENV_VALUES.join(" | ")}. ` +
        "The stack emits RM_ENV into every container; a value the backend would refuse to start on " +
        "is refused here instead, before anything is created.",
    );
  }
  if (opts.standingStack) {
    if (parsed !== null && parsed !== "prod") {
      throw new Error(
        `--static-port is the STANDING stack — the deployment a tunnel points at — and it runs RM_ENV=prod ` +
          `by rule (docs/technical/stack-orchestrator.md §16). This boot carries RM_ENV=${parsed}, which is a ` +
          "development path: AC-MODEL-01's refusals would be disabled for the analyst containers, the swarm " +
          "worker and the judge, and every session it produced would be unusable as evidence — the exact state " +
          "rm-frontend-stage-1 was found in on 2026-09-13. Unset RM_ENV (the stack emits prod itself) or set " +
          "RM_ENV=prod. Drop --static-port to boot a development stack on a Docker-assigned port.",
      );
    }
    return "prod";
  }
  return parsed ?? "smoke";
}
