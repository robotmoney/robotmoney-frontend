// The operator-environment knobs a DEMO/smoke boot forwards into compose.
//
// Extracted from smoke-main.ts (issue #456's split, continued): it is a
// self-contained allowlist plus the one function that applies it, with no
// dependency on smoke-main's boot state, and keeping it there was the kind of
// growth that split was meant to stop.
// Compose interpolation values the DEMO honours from the operator's own
// environment, passed to the shared stack explicitly via `extraComposeEnv`.
//
// Why an allowlist and not `...process.env`: scripts/stack deliberately does not
// inherit the ambient environment (§11.3 E1 — that is what keeps a provider key
// out of a container). But the DEMO is an operator tool, and these knobs are
// documented and load-bearing for it: exporting SWARM_WINDOW_MINUTES=5 or a
// custom BASE_RPC_URL before `bun run smoke` works today, and silently ignoring
// it after the bring-up moved onto the shared module would be a behaviour
// regression that is miserable to debug. Every name here is interpolated by
// docker-compose.yml / docker-compose.smoke.yml and each already carries a
// `:-default` there, so an unset value behaves exactly as before. Values
// buildComposeEnv() owns (ports, credentials, DATABASE_URL, POSTGRES_*,
// DEMO_PROJECT) are deliberately NOT listed: the stack config is their single
// source and an exported value must never shadow it.
const DEMO_COMPOSE_PASSTHROUGH = [
  "BASE_RPC_URL",
  "SWARM_AGGREGATE_CRON",
  "SWARM_CLOSE_WINDOW_CRON",
  "SWARM_NOTIFICATION_EMAIL_FROM",
  "SWARM_NOTIFICATION_EMAIL_TRANSPORT_TOKEN",
  "SWARM_NOTIFICATION_EMAIL_TRANSPORT_URL",
  "SWARM_OPEN_SESSION_CRON",
  "SWARM_PUBLISH_BRIEF_CRON",
  "SWARM_PUBLISH_CRON",
  "SWARM_SCHEDULES_ENABLED",
  "SWARM_WINDOW_MINUTES",
  "FETCH_CACHE_DIR",
  "FLOOR_SEED_PATH",
  "PROJECTS_SOURCE",
  "RM_ENV",
  // NOT "WORKER_DATABASE_URL". It was on this list from the 2026-07-28 extraction
  // (9aaaaeec) until it cost a stage twin boot on 2026-09-18: the stage checkout's
  // `.env` carries the DEPLOYMENT's value (`…@postgres:5432/robotmoney`, the
  // rm_worker login of the persistent stack, deployment.md §4.3) and bun auto-loads
  // `.env` into the driver's process.env, so every `bun smoke:twin` on that host
  // forwarded it into all three worker lanes. A smoke has no `postgres` service to
  // resolve — `--db smoke-twin`/`--db external` delete it outright (`postgres:
  // !reset null`) — so each lane's first query died in DNS (`getaddrinfo ESERVFAIL`,
  // the embedded resolver forwarding a name nothing serves), the lanes sat
  // `unhealthy` forever, and every enqueued swarm.open_session stayed `pending` at
  // attempts=0 while the driver reported only "no session … reached 'scheduled'".
  // It could never have worked in the other direction either: with an in-stack
  // postgres, the ephemeral database's credentials are generated per boot, so an
  // ambient rm_worker URL would authenticate against nothing. This is a DATABASE
  // URL — precisely the class the header says buildComposeEnv() owns and an
  // exported value must never shadow. Unset, docker-compose.yml's `:-` default
  // leaves it empty and worker-client.ts:49 falls back to the stack's DATABASE_URL,
  // which is the twin. Exported, it is now reported and dropped (see below).
  // Set only by a rehearsal that opted into RM_TWIN_PRODUCTION_PRIVILEGES; it
  // is what makes migrate.ts (:34) run as the non-superuser bootstrap login
  // instead of inheriting the container superuser's DATABASE_URL.
  "MIGRATE_DATABASE_URL",
] as const;

export function smokePassthroughEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DEMO_COMPOSE_PASSTHROUGH) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

// A stack-owned value an operator's environment can no longer shadow, paired with
// the reason its presence is worth a line of output rather than silence.
const SHADOWING_STACK_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  [
    "WORKER_DATABASE_URL",
    "the worker lanes take the stack's own DATABASE_URL (the twin, under --db smoke-twin). " +
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
