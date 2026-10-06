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
import { refuseWeakeningFlagsOnProd } from "../../backend/src/deploy-policy.ts";
import { DEMO_COMPOSE_PASSTHROUGH as LEAF_COMPOSE_PASSTHROUGH } from "./smoke-compose-passthrough.ts";

/** The containers' `RM_ENV` for a boot under `policy`; `--static-port` runs `prod` by rule. */
export function stackRmEnvFor(standingStack: boolean, policy: "prod" | "stage"): RmEnv {
  return resolveStackRmEnv({ standingStack, policy });
}

/**
 * Whether the api runs allow-insecure (RM_ALLOW_INSECURE=1) for a boot under
 * `policy`, given whether `--allow-insecure` was passed. Secure by default: no
 * flag means no allow-insecure, on every policy. With the flag, the §4.4 rule
 * itself decides (refuseWeakeningFlagsOnProd): stage keeps it, and a boot under
 * `RM_ENV=prod` never gets it, whatever else is true. The boot refuses before
 * this is asked (`refuseAllowInsecureOnProd`). Handed to the stack as
 * StackConfig.allowInsecure. There is no compose overlay to pin it.
 */
export function stackAllowInsecureFor(policy: "prod" | "stage", requested: boolean): boolean {
  return requested && refuseWeakeningFlagsOnProd(policy, { allowInsecure: true }).allow;
}

/** The refusal text when `--allow-insecure` is passed under prod; null when nothing refuses. */
export function refuseAllowInsecureOnProd(policy: "prod" | "stage", requested: boolean): string | null {
  const verdict = refuseWeakeningFlagsOnProd(policy, { allowInsecure: requested });
  return verdict.allow ? null : verdict.reason;
}

// ── What else the operator's shell may still contribute ─────────────────────
//
// The allowlist lives one module further down (smoke-compose-passthrough.ts) so
// the judge-transport test can import it without importing this file's RM_ENV
// resolver. It is used as it stands: nothing is added to it here any more.
//
//   * NO MIGRATION CREDENTIAL reaches compose. MIGRATE_DATABASE_URL used to be
//     added here so a one-shot migrate container could run the legacy runner
//     as a bootstrap login. `bun smoke` no longer migrates inside a container:
//     `--migrate` runs the migrate run on the HOST, as rm_owner, under the
//     boot's target lock (backend/scripts/smoke-prepare.ts, migrate-run.ts
//     migrateCommand), so no container is ever handed a migration credential.
//
//   * WORKER_DATABASE_URL is STACK-OWNED. It is the pipeline worker's rm_worker
//     URL, emitted by buildComposeEnv() from the stack's own role URLs
//     (scripts/stack/config.ts StackDatabase.roleUrls) — the smoke's generated
//     rm_worker password for a local mode, `~/.env`'s for the remote database.
//     It is not on the shell allowlist: a deployment `.env` once forwarded the
//     persistent stack's `…@postgres:5432` value into every lane of a twin boot
//     that has no `postgres` service (ffa431b6), and every lane died in DNS. An
//     exported value is reported and ignored (shadowingStackEnvWarnings below).
export const DEMO_COMPOSE_PASSTHROUGH: readonly string[] = Object.freeze([...LEAF_COMPOSE_PASSTHROUGH]);

/**
 * The migration credential an operator's shell may not supply.
 *
 * Nothing in `bun smoke` reads MIGRATE_DATABASE_URL: the migrate run takes the
 * rm_owner password smoke generated (local) or the one typed at the terminal
 * (remote), for one run, and never from the environment (spec §3). An EXPORTED
 * value is still removed from `env` before anything could read it, and the
 * caller says so out loud: `--local blank --migrate` with a remote
 * MIGRATE_DATABASE_URL in the shell once ran a migration against that remote
 * database, which is exactly the remote connection a local mode must never open
 * (criterion 32, spec §3).
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
    "A boot's migrate run logs in as rm_owner with the password smoke generated (a local mode) or the one " +
    "typed at the terminal (the remote database); a shell value would point a migration at whatever " +
    "database it names. This message means the smoke did NOT forward it."
  );
}

/**
 * The refusal text when a boot whose containers run `RM_ENV=prod` has no
 * `PROJECTS_SOURCE=live` to hand them; null when nothing refuses (issue #1113).
 *
 * `selectProjectsDataSource()` throws under `RM_ENV=prod` unless
 * `PROJECTS_SOURCE=live`, so every projects job dies one tick after a boot that
 * forgot it. v0.5.x got the value from the checkout `.env`; the boot now runs
 * `--no-env-file`, so the only path is the shell. Judged on the value the
 * passthrough will actually forward (set and non-empty), not on mere presence.
 */
export function refuseProdWithoutProjectsSource(
  stackRmEnv: RmEnv,
  env: Record<string, string | undefined>,
): string | null {
  if (stackRmEnv !== "prod") return null;
  if (env.PROJECTS_SOURCE === "live") return null;
  return (
    "PROJECTS_SOURCE=live is required for a boot whose containers run RM_ENV=prod, and it is " +
    (env.PROJECTS_SOURCE ? `\`${env.PROJECTS_SOURCE}\`` : "not set") +
    ". Every projects pipeline throws without it. `bun smoke` ignores the checkout `.env`: " +
    "export PROJECTS_SOURCE=live in the shell, then boot again. Nothing was started."
  );
}

/**
 * Names of the settings production's containers used to get from the checkout
 * `.env` that are unset in this boot's shell. A note, never a refusal: each has
 * a working built-in default, but the default is not what v0.5.x ran.
 */
export function missingProdSettingNotes(stackRmEnv: RmEnv, env: Record<string, string | undefined>): string[] {
  if (stackRmEnv !== "prod") return [];
  return ["BASE_RPC_URL", "WEBAUTHN_ORIGIN"]
    .filter((k) => env[k] === undefined || env[k] === "")
    .map(
      (k) =>
        `NOTE: ${k} is not set in the shell. v0.5.x read it from the checkout .env; the containers fall back to ` +
        `their built-in default. Export it before \`bun smoke\` if production relied on it.`,
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

/**
 * The ONE `~/.env` value forwarded into the compose environment: the paid
 * CoinGecko key (issue #1098). Preflight check 4 allows it in `~/.env` and
 * compose interpolates it into worker-analytics and analytics-producer, but
 * only the shell's environment used to reach compose. Only that key, only when
 * set and non-empty; the role passwords, RM_ENV and RM_CREDENTIALS are never
 * returned. The value is never logged. Spread it BEFORE smokePassthroughEnv so
 * a shell-exported key still wins.
 */
export function homeEnvComposeEnv(homeEnv: Record<string, string | undefined>): Record<string, string> {
  const v = homeEnv.COINGECKO_API_KEY;
  return v !== undefined && v !== "" ? { COINGECKO_API_KEY: v } : {};
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
    "the worker lanes take the stack's own rm_worker URL (the instance's generated password for a local " +
      "mode, ~/.env's for the remote database). Forwarding a deployment's rm_worker URL pointed them at a " +
      "`postgres` host this stack does not have, and every lane died in DNS while the boot reported only " +
      "unhealthy workers",
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
