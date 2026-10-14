// WHICH ENVIRONMENT IS ASKING — ONE MODULE, ONE ANSWER (AC-MODEL-01, D69).
//
// AC-MODEL-01 refuses a keyless model and anything but the pinned judge model
// on the ACCEPTANCE path: every stack whose sessions are evidence. This module
// is the one place that answers "is this the acceptance path?", for the judge
// half (backend/src/swarm/judge-model-policy.ts) and the analyst half
// (scripts/lib/onboarding-eval.ts's resolveModelConfig()) alike.
//
// NO ENVIRONMENT VALUE DECIDES IT (issue 1326, D69 (6)). The answer used to be
// read from `RM_ENV`, which buildComposeEnv() emitted into every container.
// D69 retired `RM_ENV` as a runtime class, and this was its last container
// reader. The answer now comes only from what the caller KNOWS:
//
//   * a caller that knows outright says so with `path` — the armed test
//     harness says `development` (backend/src/swarm/judge-config.ts, through
//     backend/src/test-seam.ts);
//   * `bun smoke` knows which kind of boot it is performing: `standingStack:
//     true` is the `--static-port` boot a tunnel points at (staging), and
//     `standingStack: false` is the operator's own boot (development);
//   * everything else — the api and the participant judge in a container, a
//     host driver handed no flag — knows nothing, and gets the acceptance path.
//     Fail-closed: a forgotten flag is refused, never silently unpinned.
//
// So the judge model pin holds on every deployed stack, and a stub judge model
// is reachable only through the armed seam.
//
// WHY THIS FILE LIVES UNDER backend/src/. backend/Dockerfile copies `backend/`
// and `contract/` and nothing else, so a module under `scripts/` cannot be
// imported by the api or worker image. `scripts/` runs on the host and can
// import this file by relative path. One direction works; the other does not.

/** The environment classes an inference/judge policy distinguishes. */
export type InferencePath = "development" | "staging" | "production";

export interface InferencePathOptions {
  /**
   * Stated outright by a caller that knows which environment it is booting.
   * Wins over every other signal.
   */
  path?: InferencePath;
  /**
   * The kind of `bun smoke` boot, stated by the boot itself: `true` is the
   * STANDING stack (`--static-port`, the boot a tunnel points at: staging),
   * `false` is the operator's own boot (development). Absent means the caller
   * does not know, which is the acceptance path.
   */
  standingStack?: boolean;
}

/**
 * Which environment is asking.
 *
 * THE ONE RULE, and every caller gets this one:
 *   1. an explicit `path` wins;
 *   2. the standing stack is `staging`;
 *   3. a boot that says it is not the standing stack is `development`;
 *   4. a caller that says nothing is `production`.
 */
export function resolveInferencePath(opts: InferencePathOptions = {}): InferencePath {
  if (opts.path) return opts.path;
  if (opts.standingStack === true) return "staging";
  if (opts.standingStack === false) return "development";
  return "production";
}

/** True where AC-MODEL-01's refusals apply: everything that is not a dev box. */
export function isAcceptancePath(path: InferencePath): boolean {
  return path !== "development";
}
