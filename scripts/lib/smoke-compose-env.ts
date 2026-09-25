// WHAT REACHES THE STACK'S COMPOSE ENVIRONMENT, AND WHERE IT CAME FROM.
//
// Three halves of one question, kept together because they are the same
// argument seen from different ends: which RM_ENV this boot declares (never the
// operator's shell), which operator knobs the shell may still contribute, and
// which stack-owned values it may NOT contribute even though it set them.
//
// WHICH RM_ENV THIS BOOT DECLARES (D13).
//
// `RM_ENV` used to reach the containers from whatever the operator's shell last
// exported — or, far more often, from docker-compose.yml's `${RM_ENV:-smoke}`
// interpolation default, because nothing in the repository set it at all. That
// is how rm-frontend-stage-1 came to be running `RM_ENV=smoke` on 2026-09-13
// with every AC-MODEL-01 refusal disabled in the api, the worker and the judge.
//
// It is now a StackConfig field (`rmEnv`), derived HERE from the §4.3 policy the
// boot resolved (backend/src/deploy-policy.ts, which is what refuses `smoke`,
// `ephemeral` and any typo in the operator's shell) and the kind of boot, and
// emitted into every service by buildComposeEnv(). The rule itself lives in
// backend/src/acceptance-path.ts with the shared acceptance predicate.
import { resolveStackRmEnv, type RmEnv } from "../../backend/src/acceptance-path.ts";
import { DEMO_COMPOSE_PASSTHROUGH as LEAF_COMPOSE_PASSTHROUGH } from "./smoke-compose-passthrough.ts";

/** The containers' `RM_ENV` for a boot under `policy`; `--static-port` runs `prod` by rule. */
export function stackRmEnvFor(standingStack: boolean, policy: "prod" | "stage"): RmEnv {
  return resolveStackRmEnv({ standingStack, policy });
}

// ── What else the operator's shell may still contribute ─────────────────────
//
// The base allowlist lives one module further down (smoke-compose-passthrough
// .ts) so the judge-transport test can import it without importing this file's
// RM_ENV resolver. This file owns the two adjustments that are facts about a
// BOOT rather than about the list:
//
//   * MIGRATE_DATABASE_URL is ADDED. It is not inherited from an operator's
//     shell — restore-container.ts assigns it on this process from the shaped
//     twin, and the passthrough is how it reaches compose. Set only by a
//     rehearsal that opted into RM_TWIN_PRODUCTION_PRIVILEGES; it is what makes
//     migrate.ts (:34) run as the non-superuser bootstrap login instead of
//     inheriting the container superuser's DATABASE_URL.
//
//   * WORKER_DATABASE_URL is REMOVED (ffa431b6), because it cost a stage twin
//     boot on 2026-09-18: the stage checkout's `.env` carries the DEPLOYMENT's
//     value (`…@postgres:5432/robotmoney`, the rm_worker login of the
//     persistent stack, deployment.md §4.3) and bun auto-loads `.env` into the
//     driver's process.env, so every `bun smoke:twin` on that host forwarded it
//     into all three worker lanes. A smoke has no `postgres` service to resolve
//     — `--twin`/`--db external` delete it outright (`postgres: !reset null`) —
//     so each lane's first query died in DNS (`getaddrinfo ESERVFAIL`), the
//     lanes sat `unhealthy` forever, and every enqueued swarm.open_session
//     stayed `pending` at attempts=0. It could never have worked in the other
//     direction either: with an in-stack postgres the ephemeral database's
//     credentials are generated per boot. This is a DATABASE URL — precisely
//     the class buildComposeEnv() owns and an exported value must never shadow.
//     Unset, docker-compose.yml's `:-` default leaves it empty and
//     worker-client.ts:49 falls back to the stack's DATABASE_URL, which is the
//     twin. Exported, it is now reported and dropped (see below).
//
// Derived from the leaf rather than restated, so a key added there (the judge's
// transport settings, the fault-injection levers) arrives here automatically
// and the two lists can never silently disagree.
const NEVER_FROM_THE_SHELL: ReadonlySet<string> = new Set(["WORKER_DATABASE_URL"]);

export const DEMO_COMPOSE_PASSTHROUGH: readonly string[] = Object.freeze([
  ...LEAF_COMPOSE_PASSTHROUGH.filter((k) => !NEVER_FROM_THE_SHELL.has(k)),
  "MIGRATE_DATABASE_URL",
]);

/**
 * The migration credential an operator's shell may not supply.
 *
 * MIGRATE_DATABASE_URL is in the passthrough above for ONE reason: this process
 * assigns it itself, for one migrate run (restore-container.ts's
 * twinMigrationCredential() for a dump, the interactive prompt for the remote
 * database). An EXPORTED value is a different thing: `--local blank --migrate`
 * with a remote MIGRATE_DATABASE_URL in the shell would have run migrate.ts
 * against that remote database, which is exactly the remote connection a local
 * mode must never open (criterion 32, spec §3). So the shell's value is removed
 * from `env` before anything reads it, and the caller says so out loud.
 *
 * Mutates `env` (the caller passes process.env, at the very top of the boot)
 * and returns the warning to print, or null when nothing was exported.
 */
export function dropShellMigrationCredential(env: Record<string, string | undefined>): string | null {
  const raw = env.MIGRATE_DATABASE_URL;
  if (raw === undefined) return null;
  delete env.MIGRATE_DATABASE_URL;
  if (raw.trim() === "") return null;
  return (
    "WARNING: MIGRATE_DATABASE_URL is set in the environment and is being IGNORED for this boot. " +
    "A boot builds its own migration credential for the one migrate run that needs it (a local mode " +
    "from its container, the remote database from the interactive prompt); a shell value would point " +
    "migrate.ts at whatever database it names. This message means the smoke did NOT forward it."
  );
}

export function smokePassthroughEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DEMO_COMPOSE_PASSTHROUGH) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

// NO JUDGE CREDENTIAL (D52). A `judgeCredentialEnv()` used to live here and
// hand `api` the shared OpenCode Zen key plus the judge's per-call bound, for
// an inline judge. Nothing in the stack judges inline any more: the judge is a
// participant that takes its model key from credential.json (smoke spec §6.1,
// §6.2), and no rendered service other than a participant carries a model key
// (scripts/tests/integration/no-docker-socket-compose-config.test.ts).


// A stack-owned value an operator's environment can no longer shadow, paired with
// the reason its presence is worth a line of output rather than silence.
const SHADOWING_STACK_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  [
    "WORKER_DATABASE_URL",
    "the worker lanes take the stack's own DATABASE_URL (the twin, under --twin). " +
      "Forwarding a deployment's rm_worker URL pointed them at a `postgres` host this stack does " +
      "not have, and every lane died in DNS while the boot reported only unhealthy workers",
  ],
];

/**
 * Loud-never-silent warnings for a stack-owned database URL left in the operator's
 * environment (typically a `.env` shared with the persistent deployment).
 * Pure, in the shape of stack/ports.ts's stalePortEnvWarnings: the caller passes
 * its own env in and printing is the caller's job. One line per var actually set.
 */
export function shadowingStackEnvWarnings(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [name, why] of SHADOWING_STACK_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    out.push(
      `WARNING: ${name} is set and is being IGNORED for this boot — ${why}. ` +
        `It still configures the persistent stack (deployment.md §4.3); nothing needs to change there. ` +
        `This message means the smoke did NOT forward it.`,
    );
  }
  return out;
}
