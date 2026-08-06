// Environment-scoped names and labels for EVERY container this repo starts —
// pure, side-effect free at import, and (like the rest of scripts/stack/) it
// never reads the process environment itself: the caller hands its own env in.
//
// Why this exists at all. Four independent families spawn containers on the
// SAME host — the standing demo (scripts/lib/demo-main.ts), the local
// onboarding eval (scripts/onboarding-eval-local.ts), the inference-off rails
// check (scripts/tests/integration/onboarding-eval-infra.test.ts), and the
// backend test harness's ephemeral postgres (backend/tests/preload.ts) — and
// that host is simultaneously the self-hosted GitHub Actions runner AND the box
// serving stage.robotmoney-labs.dev. Each family used to mint its own name
// shape (`rmdemo_<hex>`, `rmeval_local_<hex>`, `rm_onboarding_infra_<hex>`,
// `rmtest_pg_<hex>`), which meant a leaked container could be attributed to a
// family but NOT to an environment: nothing on a stray container said whether
// it belonged to CI run 42, CI run 43, or the operator's own shell. Reaping
// safely was therefore impossible — every candidate filter risked killing the
// standing demo.
//
// The scheme is deliberately TWO-CHANNEL:
//
//   1. NAME  — `<prefix>_<role>_<hash>`, so `docker ps` is readable by a human
//      and a compose project scopes cleanly.
//   2. LABELS — the same facts as first-class metadata, so a future reaper
//      selects with `--filter label=robotmoney.env=ci` rather than by parsing
//      a name substring. Name parsing is the fragile channel; it exists for
//      eyes, the labels exist for tools.
//
// The hash identifies the ENVIRONMENT, not the run's contents:
//
//   - Under GitHub Actions it is derived from the workflow/run/attempt/job
//     quadruple, so it is STABLE for every container started anywhere inside
//     one job (the boot step and its `always()` teardown step agree without
//     passing anything between them) and DISTINCT across runs, re-attempts,
//     parallel jobs, and other workflows.
//   - Locally there is no such identity — an operator's shell is not a job — so
//     it is drawn from a per-boot random seed. That also gives the local case
//     its collision-freedom for free: two `bun demo` invocations get two
//     different hashes.
import { createHash } from "node:crypto";

// ── Environment class ───────────────────────────────────────────────────────
export type EnvironmentClass = "ci" | "local";

// Name prefixes. `rm_ci` vs `rm_demo` is the FIRST thing a reaper (or a human
// staring at `docker ps` at 2am) needs to know, so it leads the name. Both are
// valid compose project names (`[a-z0-9][a-z0-9_-]*`).
export const CI_PROJECT_PREFIX = "rm_ci";
export const LOCAL_PROJECT_PREFIX = "rm_demo";

// The label keys. `robotmoney.demo.project` predates this module
// (docker-compose.demo.yml has always stamped it on the pgdata volume, which is
// how `demo:clean` finds volumes by label instead of by name); the two env
// labels are its generalisation to the environment.
export const PROJECT_LABEL = "robotmoney.demo.project";
export const ENV_CLASS_LABEL = "robotmoney.env";
export const ENV_HASH_LABEL = "robotmoney.env.hash";
// Applied only to the Compose default network. Unlike Compose's own project
// label, this is an explicit ownership assertion: the demo reaper may enumerate
// the network without first finding one of its containers.
export const MANAGED_NETWORK_LABEL = "robotmoney.demo.network";

// The compose interpolation variable names the two env labels are threaded
// through (scripts/stack/config.ts's buildComposeEnv sets both;
// docker-compose.demo.yml reads both). Named RM_STACK_* rather than RM_ENV_* so
// they can never be confused with `RM_ENV` (ephemeral|demo|prod), which is a
// BACKEND runtime mode and an entirely different axis.
export const ENV_CLASS_COMPOSE_VAR = "RM_STACK_ENV_CLASS";
export const ENV_HASH_COMPOSE_VAR = "RM_STACK_ENV_HASH";

// The four GitHub Actions variables that together identify one JOB EXECUTION.
// Order is part of the hash input, so it is fixed here rather than left to a
// call site: changing it silently re-keys every CI container name.
export const CI_IDENTITY_VARS = [
  "GITHUB_WORKFLOW",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_JOB",
] as const;

// Which family started the container. Part of the name (not just a label)
// because the five families can legitimately co-exist inside ONE CI job, where
// the env hash is by design identical for all of them — e.g. `bun run eval`
// runs the onboarding eval and the swarm eval as two Bun test files in the
// same process/job, so `eval` and `eval-swarm` MUST resolve to different
// project names or one's `stack.down()` would tear down the other's containers
// mid-run.
//
//   stack          — the demo / any full or core compose bring-up (demo-main.ts)
//   eval           — the local real-inference onboarding eval (onboarding-eval-local.ts)
//   eval-swarm — the local real-inference swarm-authoring eval (swarm-eval-local.ts)
//   infra          — the inference-off rails check (onboarding-eval-infra.test.ts)
//   pgtest         — the backend suite's ephemeral postgres (backend/tests/preload.ts)
export type StackRole = "stack" | "eval" | "eval-swarm" | "infra" | "pgtest";

export interface StackEnvironment {
  /** Which kind of environment started this stack. */
  class: EnvironmentClass;
  /** Short stable digest of that environment's identity (10 lowercase hex). */
  hash: string;
}

// `GITHUB_ACTIONS` is set to the literal string "true" by the Actions runner
// (and by nothing else). Compared exactly — a truthy-but-not-"true" value means
// something is impersonating the runner and must NOT silently take the CI path.
export function isGithubActions(env: Record<string, string | undefined>): boolean {
  return env.GITHUB_ACTIONS === "true";
}

// SHA-256, truncated. Short enough to read in `docker ps`, wide enough that a
// collision across concurrent environments is not a practical concern. sha256
// (not a hand-rolled FNV) because it is already in the runtime and because a
// name that turns out to be attacker-influenced should not also be trivially
// forgeable.
const HASH_LENGTH = 10;
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, HASH_LENGTH);
}

/**
 * Resolve the environment a stack is being started in.
 *
 * `opts.seed` is honoured ONLY on the local path, where it exists so tests can
 * assert determinism; under Actions the identity is the job's, and a seed can
 * never override it (an override there would break the stable-within-a-job
 * property the teardown step depends on).
 */
export function resolveStackEnvironment(
  env: Record<string, string | undefined>,
  opts: { seed?: string } = {},
): StackEnvironment {
  if (isGithubActions(env)) {
    const identity = CI_IDENTITY_VARS.map((k) => `${k}=${env[k] ?? ""}`).join("\n");
    return { class: "ci", hash: shortHash(identity) };
  }
  // No workflow identity exists outside Actions, so the local component is
  // random PER BOOT. Callers resolve once at startup and reuse the result;
  // calling this twice deliberately yields two different environments.
  return { class: "local", hash: shortHash(opts.seed ?? crypto.randomUUID()) };
}

export function projectPrefix(environment: StackEnvironment): string {
  return environment.class === "ci" ? CI_PROJECT_PREFIX : LOCAL_PROJECT_PREFIX;
}

/**
 * The compose project name / container-name prefix for one family in one
 * environment, e.g. `rm_ci_stack_9f2a1c4b7d` or `rm_demo_pgtest_0114ac93de`.
 */
export function stackProjectName(role: StackRole, environment: StackEnvironment): string {
  return `${projectPrefix(environment)}_${role}_${environment.hash}`;
}

/**
 * Every label a container/volume this repo starts must carry. The project label
 * keeps working exactly as before (demo:clean scopes deletes by it); the two
 * env labels are what lets a reaper say "everything from CI job X" or
 * "everything NOT from this operator's current shell" without touching names.
 */
export function stackLabels(environment: StackEnvironment, project: string): Record<string, string> {
  return {
    [PROJECT_LABEL]: project,
    [ENV_CLASS_LABEL]: environment.class,
    [ENV_HASH_LABEL]: environment.hash,
  };
}

/**
 * The same labels as `docker run --label` argv. Needed because ONE spawner —
 * backend/tests/preload.ts — is a raw `docker run`, not compose, so it cannot
 * pick labels up from a compose file and must pass them explicitly.
 * Deterministically ordered so an argv assertion is stable.
 */
export function dockerLabelFlags(labels: Record<string, string>): string[] {
  return Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([k, v]) => ["--label", `${k}=${v}`]);
}
