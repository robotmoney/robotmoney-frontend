// WHAT REACHES THE STACK'S COMPOSE ENVIRONMENT, AND WHERE IT CAME FROM.
//
// Two halves of one question, kept together because they are the same
// argument seen from different ends: which operator knobs the shell may still
// contribute, and which stack-owned values it may NOT contribute even though it
// set them.
//
// NO RM_ENV REACHES A CONTAINER (issue 1326, D69). It used to be derived here
// from the boot's policy and emitted into every service, for the acceptance
// path the api read. That path is now stated by the boot itself, never read
// from an environment (backend/src/acceptance-path.ts).
import { DEMO_COMPOSE_PASSTHROUGH as LEAF_COMPOSE_PASSTHROUGH } from "./smoke-compose-passthrough.ts";

/**
 * True for a boot whose stack is an acceptance deployment: the `prod` policy,
 * or the standing `--static-port` stack a tunnel points at under either policy.
 * Its inference is the acceptance path, and it must hand the live settings.
 */
export function isAcceptanceBoot(standingStack: boolean, policy: "prod" | "stage"): boolean {
  return policy === "prod" || standingStack;
}

// ── What else the operator's shell may still contribute ─────────────────────
//
// The allowlist lives one module further down (smoke-compose-passthrough.ts) so
// the judge-transport test can import it without importing this file. It is
// used as it stands: nothing is added to it here any more.
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
 * The refusal text when an acceptance boot ({@link isAcceptanceBoot}) has no
 * `PROJECTS_SOURCE=live` to hand its containers; null when nothing refuses
 * (issue #1113).
 *
 * `selectProjectsDataSource()` throws unless `PROJECTS_SOURCE=live`, so every
 * projects job dies one tick after a boot that forgot it. v0.5.x got the value from the checkout `.env`; the boot now runs
 * `--no-env-file`, so the only path is the shell. Judged on the value the
 * passthrough will actually forward (set and non-empty), not on mere presence.
 */
export function refuseProdWithoutProjectsSource(
  acceptanceBoot: boolean,
  env: Record<string, string | undefined>,
): string | null {
  if (!acceptanceBoot) return null;
  if (env.PROJECTS_SOURCE === "live") return null;
  return (
    "PROJECTS_SOURCE=live is required for a production or standing boot, and it is " +
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
export function missingProdSettingNotes(acceptanceBoot: boolean, env: Record<string, string | undefined>): string[] {
  if (!acceptanceBoot) return [];
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
