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
  "WORKER_DATABASE_URL",
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

/**
 * The judge's credential, for the two services that run the judge.
 *
 * SEPARATE FROM THE ALLOWLIST ABOVE, because it is not an operator knob — it is
 * the shared OpenCode Zen key, and docker-compose.yml names it on `api` and
 * `worker-swarm` ONLY (not on the *worker-env anchor), so worker-analytics and
 * worker-research never receive an inference credential they do not use.
 *
 * WHY IT HAS TO BE PASSED EXPLICITLY. It never was: `${OPENCODE_API_KEY:-}` was
 * filled by compose's own auto-load of the checkout's `.env`. Closing that hole
 * (composeArgs' `--env-file /dev/null`, which stopped a deployment's
 * WORKER_DATABASE_URL reaching the worker lanes) also cut this off — and the
 * failure is SILENT by design: an unconfigured transport is a legible state, so
 * the judge wrote `source='fallback'`, `fallback_reason='model_unconfigured'`
 * and carried on. docker-compose.yml:385 predicted exactly this ("the one
 * process that actually runs the judge on a schedule falls back to template
 * prose silently"). A boot that spends real money on member takes and then
 * judges them with a template is the worst of both, so the key travels
 * deliberately now rather than by accident.
 *
 * Absent key → absent entry, and `${VAR:-}` resolves empty exactly as before.
 */
export function judgeCredentialEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const key = env.OPENCODE_API_KEY?.trim();
  if (key) out.OPENCODE_API_KEY = key;
  // AND ENOUGH TIME TO THINK. backend's DEFAULT_JUDGE_TIMEOUT_MS is 60s, sized
  // for the judge's original ask (summarise, list disagreements). The
  // instruction now also demands a COHERENCE DETERMINATION — read every
  // member's numbers against the position their prose argues — over take bodies
  // that run to hundreds of words each, and 60s stopped being enough: the first
  // run under the new prompt timed out and fell back to template prose, which
  // is the one outcome this release exists to prevent. A smoke/twin gets a
  // bound that fits the question; production keeps its own default and its own
  // operator-set value, which is honoured here when present.
  out.SWARM_JUDGE_TIMEOUT_MS = env.SWARM_JUDGE_TIMEOUT_MS?.trim() || "180000";
  return out;
}

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
