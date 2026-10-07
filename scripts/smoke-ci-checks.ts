// The CI scenario checks, run against a `bun smoke` stack that is already up
// (issue #1026). They used to run inside the boot (scripts/lib/smoke-main.ts
// `runCiScenario`); a boot given a credential file stops at readiness now, so
// the e2e-*.yml workflows run them, one check per step, each domain on its own
// freshly booted stack:
//
//   bun --no-env-file scripts/smoke-ci-checks.ts [--check <name>[,<name>]] [--instance <name>]
//
// The checks (scripts/lib/smoke-ci-check-select.ts): `swarm-session` (two live
// sessions, the cross-role denials), `starter-agent` (with its two
// missing-credential guards), `frontend` (the core-surface checks), `browser`
// (the Playwright specs), `live-smoke` (the live steady-state assertions),
// `verify-live` (the product invariants, tier readonly), and `onboarding` (the
// real-inference admission sweep, §11 R8). With no `--check` every one runs in
// that order, `onboarding` only when ONBOARDING_REAL_EVAL=1. Every check exits
// non-zero on failure. The stack is left up: the caller ends with `bun
// smoke:down`.
//
// The instance is the one named by `--instance`, or the only one on this host.
// Its compose env is rebuilt from the stack record exactly as `smoke:down`
// does. The fixture participants the lifecycle e2e seated stay in place: the
// session driver registers its own simulation members beside them, and the
// starter agent and the sweep register their own.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostBackendUrl, instanceComposeEnv } from "./stack/config.ts";
import { buildSmokeLifecycleComposeEnv } from "./lib/smoke-lifecycle-env.ts";
import { instanceFlag, readStackState, selectExistingInstance, stateRoot } from "./lib/smoke-state.ts";
import { OPERATOR_TOKEN_FILE_ENV } from "./lib/operator-token.ts";
import { selectChecks, type CheckName } from "./lib/smoke-ci-check-select.ts";
import {
  admissionRecord,
  ADMISSION_RECORD_FILE,
  formatAdmissionRecords,
  resolveModelConfig,
  runOnboardingEvalWithRetry,
  type AdmissionRecord,
  type OnboardingEvalResult,
} from "./lib/onboarding-eval.ts";

const repoRoot = join(import.meta.dir, "..");
const paths = selectExistingInstance(stateRoot(process.env), instanceFlag(process.argv.slice(2)));
const stackRecord = readStackState(paths);
if (!stackRecord) throw new Error(`no stack record under ${paths.dir}: boot the instance first (bun smoke --local blank --migrate --seed)`);

const project = stackRecord.project;
const composeFiles = stackRecord.composeFiles;
const backendUrl = hostBackendUrl(stackRecord.webPort);
const operatorToken = readFileSync(paths.tokenFiles.operator, "utf8").trim();
const operatorTokenEnv: Record<string, string> = { [OPERATOR_TOKEN_FILE_ENV]: paths.tokenFiles.operator };

// The compose env the boot used, rebuilt from the record (never from the
// checkout's `.env`), plus what a member container's own `compose run` needs.
const spawnEnv: Record<string, string> = {
  ...buildSmokeLifecycleComposeEnv(stackRecord, process.env),
  ...instanceComposeEnv({ name: paths.dir.split("/").at(-1)!, stateDir: paths.dir }),
  RM_ENV: process.env.RM_ENV ?? "stage",
  WORKER_DATABASE_URL: stackRecord.databaseUrl,
};

const childEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  return { ...base, ...extra };
};

// `bun` children run with `--no-env-file`, as the boot's do: the checkout's
// `.env` never reaches a check.
const noEnvFile = (cmd: string[]): string[] => (cmd[0] === "bun" ? ["bun", "--no-env-file", ...cmd.slice(1)] : cmd);

async function run(cmd: string[], env: Record<string, string>, label: string): Promise<void> {
  const code = await Bun.spawn(noEnvFile(cmd), { cwd: repoRoot, env, stdout: "inherit", stderr: "inherit", stdin: "ignore" }).exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

async function expectRunFailure(cmd: string[], env: Record<string, string>, label: string): Promise<void> {
  const code = await Bun.spawn(noEnvFile(cmd), { cwd: repoRoot, env, stdout: "inherit", stderr: "inherit", stdin: "ignore" }).exited;
  if (code === 0) throw new Error(`${label} unexpectedly exited 0`);
}

// Each check is its own function so a workflow can run one per step (e2e-*.yml):
// the check that failed is then the step that is red, not a line in one log.

async function swarmSession(): Promise<void> {
  // No RM_ALLOW_INSECURE: the driver presents the operator's token for its admin
  // calls and asserts that a member token is REFUSED on the role-gated routes.
  // The stack's compose env + COMPOSE_FILE ride along because the driver
  // launches one member-agent container per present member.
  console.log("\n[ci-checks] running swarm session…");
  await run(["bun", "run", "scripts/lib/swarm/session.ts"],
    childEnv({ ...spawnEnv, COMPOSE_FILE: composeFiles, BACKEND_URL: backendUrl, ...operatorTokenEnv }), "swarm session");
}

async function starterAgent(): Promise<void> {
  // Issue #209: the repo-native single-member starter, with its two
  // missing-credential guards. (D21: REST is the only transport.)
  console.log("[ci-checks] running starter swarm agent (REST)…");
  const starterEnv = childEnv({ BACKEND_URL: backendUrl, ...operatorTokenEnv });
  const { BACKEND_URL: _missingBackend, ...withoutBackendUrl } = starterEnv;
  await expectRunFailure(["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"],
    withoutBackendUrl, "starter swarm agent missing BACKEND_URL guard");
  const { [OPERATOR_TOKEN_FILE_ENV]: _missingOperator, ...withoutOperatorToken } = starterEnv;
  await expectRunFailure(["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"],
    withoutOperatorToken, `starter swarm agent missing ${OPERATOR_TOKEN_FILE_ENV} guard`);
  await run(["bun", "run", "scripts/starter-swarm-agent.ts", "--transport=rest", "--e2e"], starterEnv, "starter swarm agent REST live-stack exercise");
}

async function frontend(): Promise<void> {
  console.log("[ci-checks] running frontend checks…");
  await run(["bun", "run", "scripts/smoke-frontend-check.ts"], childEnv({ BACKEND_URL: backendUrl }), "frontend checks");
}

async function browser(): Promise<void> {
  console.log("[ci-checks] running browser checks…");
  await run(["bun", "run", "test:browser"], childEnv({ BACKEND_URL: backendUrl, ...operatorTokenEnv }), "browser checks");
}

async function liveSmoke(): Promise<void> {
  // LIVE steady-state smoke (issue #128): published swarm sessions, a fresh
  // regime snapshot, wallet/vault provenance live, both research signals.
  console.log("[ci-checks] asserting LIVE steady state (smoke-live-smoke)…");
  await run(["bun", "run", "scripts/smoke-live-smoke.ts"], childEnv({ BACKEND_URL: backendUrl }), "live smoke assertions");
}

async function verifyLive(): Promise<void> {
  // PRODUCT invariants, via the same driver a cutover runs. tier=full is only
  // ever for a dump boot, and no judge runs on this roster: tier=readonly.
  console.log("[ci-checks] verifying product invariants (verify-live, tier=readonly)…");
  await run(["bun", "run", "scripts/verify-live.ts", "--base", backendUrl, "--tier", "readonly"], childEnv(), "live product verification");
}

async function onboarding(): Promise<void> {
  // REAL-INFERENCE onboarding admission sweep (§11 R8). Selected by name only
  // on e2e-onboarding.yml's runs that asked for it (the nightly `schedule`
  // mirror, a `real-eval`-labelled PR, or a real_eval dispatch: issue #289,
  // #373, #803); a full unnamed run gates it on ONBOARDING_REAL_EVAL=1 (see
  // lib/smoke-ci-check-select.ts). A failed or timed-out admission throws;
  // provider flake is retried inside runOnboardingEvalWithRetry.
  // ONBOARDING_SWEEP_MODELS and ONBOARDING_SWEEP_IDENTITIES_PER_MODEL widen it.
  {
    const sweepModels = (process.env.ONBOARDING_SWEEP_MODELS?.trim() || process.env.AGENT_MODEL || resolveModelConfig().model)
      .split(":")
      .map((m) => m.trim())
      .filter(Boolean);
    const identitiesPerModel = Math.max(1, Number.parseInt(process.env.ONBOARDING_SWEEP_IDENTITIES_PER_MODEL ?? "1", 10) || 1);
    console.log(
      `\n[ci-checks] running REAL-INFERENCE onboarding eval sweep (§11 R8): ${sweepModels.length * identitiesPerModel} admission(s) across ` +
        `${sweepModels.length} model(s) [${sweepModels.join(", ")}], ${identitiesPerModel} identit${identitiesPerModel === 1 ? "y" : "ies"} each…`,
    );
    const sweepResults: Array<{ model: string; result: OnboardingEvalResult }> = [];
    const records: AdmissionRecord[] = [];
    for (const model of sweepModels) {
      for (let i = 0; i < identitiesPerModel; i++) {
        const startedAt = Date.now();
        const result = await runOnboardingEvalWithRetry({
          repoRoot,
          composeProject: project,
          composeFiles: composeFiles.split(":"),
          backendUrl,
          automationToken: operatorToken,
          composeSpawnEnv: spawnEnv,
          env: { ...process.env, AGENT_MODEL: model },
          onEvent: (msg) => console.log(`[ci-checks] onboarding-real-eval[${model}]: ${msg}`),
        });
        sweepResults.push({ model, result });
        records.push(admissionRecord(model, result, Date.now() - startedAt));
      }
    }
    // Written BEFORE the throw below so a RED run records exactly as much as a
    // green one; e2e-onboarding.yml folds this file into $GITHUB_STEP_SUMMARY.
    writeFileSync(join(repoRoot, ADMISSION_RECORD_FILE), `${formatAdmissionRecords(records)}\n`);
    console.log(`[ci-checks] wrote onboarding admission record to ${ADMISSION_RECORD_FILE}`);
    const failed = sweepResults.filter((r) => !r.result.admitted);
    for (const f of failed) if (f.result.transcript) console.log(`[ci-checks] onboarding real-eval (${f.model}, ${f.result.identity.runId}) container transcript:\n${f.result.transcript}`);
    if (failed.length > 0) {
      throw new Error(
        `real-inference onboarding eval: ${failed.length}/${sweepResults.length} admission(s) did not reach the active roster (§11 R8) — ` +
          failed
            .map((f) => `${f.model}/${f.result.identity.runId}: ${f.result.timedOut ? "timed out" : `container exited (code ${f.result.containerExitCode})`}`)
            .join("; "),
      );
    }
    console.log(`[ci-checks] real-inference onboarding eval: ${sweepResults.length}/${sweepResults.length} admission(s) admitted (§11 R8) ✓`);
  }
}

const CHECKS: Record<CheckName, () => Promise<void>> = {
  "swarm-session": swarmSession,
  "starter-agent": starterAgent,
  frontend,
  browser,
  "live-smoke": liveSmoke,
  "verify-live": verifyLive,
  onboarding,
};

async function main(): Promise<void> {
  const selected = selectChecks(process.argv.slice(2), process.env);
  console.log(`[ci-checks] instance ${paths.dir.split("/").at(-1)}, project ${project}, ${backendUrl}`);
  console.log(`[ci-checks] checks: ${selected.join(", ")}`);
  for (const name of selected) await CHECKS[name]();
  console.log("\n[ci-checks] scenario assertions passed");
}

try {
  await main();
} catch (error) {
  console.error(`\n[ci-checks] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
