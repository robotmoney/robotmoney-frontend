// Compose-layer test for the robotmoney-swarm stack (issue #894, modelled on
// scripts/tests/integration/smoke-compose-config.test.ts). Shells
// `docker compose -f stacks/robotmoney-swarm/pods/<pod>/composefile.yml config`
// (offline — pure interpolation, no daemon-side state, no containers) and
// asserts that every per-environment knob issue #894's Scope section lists —
// RM_ENV, PROJECTS_SOURCE, SWARM_PUBLIC_BASE_URL, SWARM_SCHEDULES_ENABLED,
// SWARM_WINDOW_MINUTES, and the five SWARM_*_CRON vars — resolves as an
// UNBAKED ${VAR} passthrough in both the app pod's api service and every
// worker-lane service in the workers pod: a distinct sentinel set on the host
// reaches the container verbatim, and each var resolves to the EMPTY STRING
// (never a non-empty inline literal) when the host leaves it unset. An inline
// non-empty default would silently beat an operator's `stack init --config
// VAR=value`, which is exactly the failure mode issue #894 exists to close —
// see both composefiles' own header comments for the no-baked-default rule
// this asserts.
//
// Docker is a hard dependency of this repo's test harness already (the
// backend suite boots ephemeral Postgres through it); a missing docker CLI
// fails this test loudly — never a silent skip (test-coverage policy).
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

const APP_COMPOSE = "stacks/robotmoney-swarm/pods/app/composefile.yml";
const WORKERS_COMPOSE = "stacks/robotmoney-swarm/pods/workers/composefile.yml";

interface ComposeConfig {
  services: Record<string, { environment?: Record<string, string | null> }>;
}

// The full per-environment knob set issue #894's Scope section requires both
// composefiles to forward. Order matches the issue body.
const FORWARDED_VARS = [
  "RM_ENV",
  "PROJECTS_SOURCE",
  "SWARM_PUBLIC_BASE_URL",
  "SWARM_SCHEDULES_ENABLED",
  "SWARM_WINDOW_MINUTES",
  "SWARM_OPEN_SESSION_CRON",
  "SWARM_PUBLISH_BRIEF_CRON",
  "SWARM_CLOSE_WINDOW_CRON",
  "SWARM_AGGREGATE_CRON",
  "SWARM_PUBLISH_CRON",
] as const;

// A distinct, unambiguous sentinel per var so a case can never pass by
// accident (e.g. two vars both resolving to the same stray value).
const SENTINELS: Record<(typeof FORWARDED_VARS)[number], string> = Object.fromEntries(
  FORWARDED_VARS.map((v) => [v, `sentinel-${v.toLowerCase().replace(/_/g, "-")}`]),
) as Record<(typeof FORWARDED_VARS)[number], string>;

// Base env for the compose call: inherit the caller's env (PATH/HOME/DOCKER_*)
// but strip every var under test so each case controls it exactly, never an
// ambient leak from the calling shell.
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if ((FORWARDED_VARS as readonly string[]).includes(k)) continue;
    env[k] = v;
  }
  return env;
}

// Memoised per (file, knobs) — this file only ever renders 4 distinct
// configurations (2 composefiles x {sentinels set, all unset}), all paid for
// up front in beforeAll, so no individual test ever waits on a cold Docker
// CLI start-up (the failure mode that reddened PR #801 in the sibling file).
const renderCache = new Map<string, ComposeConfig>();

function renderKey(file: string, knobs: Record<string, string>): string {
  return JSON.stringify({ file, knobs: Object.entries(knobs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) });
}

function renderComposeConfig(file: string, knobs: Record<string, string>): ComposeConfig {
  const key = renderKey(file, knobs);
  const cached = renderCache.get(key);
  if (cached) return cached;
  const r = Bun.spawnSync(
    ["docker", "compose", "-f", file, "config", "--format", "json"],
    { cwd: repoRoot, env: { ...baseEnv(), ...knobs }, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker compose config failed for ${file} (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
  }
  const cfg = JSON.parse(new TextDecoder().decode(r.stdout)) as ComposeConfig;
  renderCache.set(key, cfg);
  return cfg;
}

function serviceEnv(cfg: ComposeConfig, svc: string): Record<string, string | null> {
  const env = cfg.services?.[svc]?.environment;
  if (!env) throw new Error(`compose config has no environment for service "${svc}"`);
  return env;
}

// Generous but bounded, same reasoning as smoke-compose-config.test.ts: a
// cold Docker CLI start-up alone can exceed bun's 5000 ms default beforeAll
// timeout, but a genuinely wedged Docker must still fail loudly rather than
// run out the job.
const PREWARM_TIMEOUT_MS = 60_000;

beforeAll(() => {
  renderComposeConfig(APP_COMPOSE, SENTINELS);
  renderComposeConfig(APP_COMPOSE, {});
  renderComposeConfig(WORKERS_COMPOSE, SENTINELS);
  renderComposeConfig(WORKERS_COMPOSE, {});
}, PREWARM_TIMEOUT_MS);

describe("stacks/robotmoney-swarm/pods/app/composefile.yml forwards per-environment knobs with no inline default", () => {
  test("api service resolves every knob to its distinct host-provided sentinel", () => {
    const env = serviceEnv(renderComposeConfig(APP_COMPOSE, SENTINELS), "api");
    for (const v of FORWARDED_VARS) expect(env[v]).toBe(SENTINELS[v]);
  });

  test("api service resolves every knob to the empty string when unset (no inline literal default)", () => {
    const env = serviceEnv(renderComposeConfig(APP_COMPOSE, {}), "api");
    for (const v of FORWARDED_VARS) expect(env[v] ?? "").toBe("");
  });
});

describe("stacks/robotmoney-swarm/pods/workers/composefile.yml forwards per-environment knobs with no inline default", () => {
  // The three task-queue lanes share the x-worker-env anchor this issue
  // extends; analytics-producer is out of this issue's var set (it runs no
  // swarm.* schedule and is asserted separately by other coverage).
  const WORKER_SERVICES = ["worker-swarm", "worker-analytics", "worker-research"] as const;

  for (const svc of WORKER_SERVICES) {
    test(`${svc} resolves every knob to its distinct host-provided sentinel`, () => {
      const env = serviceEnv(renderComposeConfig(WORKERS_COMPOSE, SENTINELS), svc);
      for (const v of FORWARDED_VARS) expect(env[v]).toBe(SENTINELS[v]);
    });

    test(`${svc} resolves every knob to the empty string when unset (no inline literal default)`, () => {
      const env = serviceEnv(renderComposeConfig(WORKERS_COMPOSE, {}), svc);
      for (const v of FORWARDED_VARS) expect(env[v] ?? "").toBe("");
    });
  }
});
