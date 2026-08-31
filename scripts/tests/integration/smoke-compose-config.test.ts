// Compose-layer test for the smoke data path (issue #50; issue #147 removed
// DEMO_HERMETIC and the base-rpc-stub service entirely). Shells
// `docker compose -f docker-compose.yml -f docker-compose.smoke.yml config`
// (offline — pure interpolation, no daemon-side state, no containers) and
// asserts the RESOLVED api/worker environment:
//
//   - by default (no knobs) every RPC/analytics knob resolves EMPTY, so
//     backend config.ts falls through to its live production defaults
//     (BASE_RPC_URL https://mainnet.base.org, analytics live);
//   - going through the scripts/lib/smoke-env.ts resolver (the path
//     `bun run smoke` actually takes) pins ANALYTICS_SOURCE=live,
//     BASE_RPC_SOURCE=live, ANALYTICS_FLOOR_SEED=1 explicitly;
//   - an explicit BASE_RPC_URL override beats both defaults.
//
// It also proves the resolver layer (scripts/lib/smoke-env.ts) and the compose
// interpolation layer agree when composed. Docker is a hard dependency of this
// repo's test harness (the backend suite boots ephemeral Postgres through it);
// a missing docker CLI fails this test loudly — never a silent skip
// (test-coverage policy).
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveSmokeEnv } from "../../smoke.ts";
import { COMMITTED_REGIME_CRON, COMMITTED_RESEARCH_CRON, resolveSmokeCadence } from "../../lib/smoke-schedule.ts";
import { scenarioPlan } from "../../lib/smoke-mode.ts";

const repoRoot = join(import.meta.dir, "../../..");

interface ComposeConfig {
  services: Record<string, {
    build?: { context?: string; dockerfile?: string; args?: Record<string, string | null> };
    environment?: Record<string, string | null>;
    secrets?: Array<{ source: string; target: string }>;
    volumes?: Array<{ source?: string; target?: string; read_only?: boolean }>;
    logging?: { driver?: string; options?: Record<string, string> };
    healthcheck?: { test?: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string; disable?: boolean };
    restart?: string;
    profiles?: string[];
  }>;
  secrets?: Record<string, { file?: string }>;
  networks?: Record<string, { labels?: Record<string, string> }>;
}

// Base env for the compose call: inherit the caller's env (PATH/HOME/DOCKER_*)
// but STRIP every data-path knob so each case controls them exactly.
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if ([
      "BASE_RPC_URL", "BASE_RPC_SOURCE", "ANALYTICS_SOURCE", "ANALYTICS_FLOOR_SEED",
      "HTTP_FETCH_CACHE_TTL_MS", "TOKEN_PRICE_CACHE_TTL_MS",
      "ANALYTICS_TOKEN", "ANALYTICS_TOKEN_FILE_HOST", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME",
      // Cadence knobs (issue #371): only resolveSmokeEnv's stage path may set
      // these, so an ambient value must never leak into a case's resolution.
      "PRODUCER_REGIME_CRON", "PRODUCER_RESEARCH_CRON",
      // Boot-guard operator controls (issue #602): the cases below assert both
      // the set and the unset resolution, so neither may be inherited.
      "RM_ALLOW_HANDLE_NAMESPACE_VIOLATION", "PG_NAMESPACE_GUARD_TIMEOUT_MS",
      // Build identity is asserted set and unset below; never inherit it.
      "AUM_PRODUCER_REVISION",
    ].includes(k)) continue;
    env[k] = v;
  }
  env.SMOKE_PROJECT = "compose-config-test"; // used by labels; avoids interpolation warnings
  // The environment labels docker-compose.smoke.yml stamps on every service and
  // on the pgdata volume (scripts/stack/naming.ts). Same reason as above:
  // supplied so `config` resolves without interpolation warnings.
  env.RM_STACK_ENV_CLASS = "local";
  env.RM_STACK_ENV_HASH = "composecfg0";
  // REQUIRED inputs now, not defaults: docker-compose.yml's two port lines are
  // `${VAR:?…}` and `docker compose config` refuses to resolve without them.
  // Values are arbitrary — this test never publishes anything.
  env.WEB_PORT = "18787";
  env.POSTGRES_PORT = "15432";
  return env;
}

const DEMO_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.smoke.yml"] as const;

const BASE_COMPOSE_FILES = ["docker-compose.yml"] as const;
const STAGE_COMPOSE_FILES = [...DEMO_COMPOSE_FILES, "docker-compose.stage.yml"] as const;
// The three compositions this repo actually boots, in the order the describes
// below iterate them.
const ALL_COMPOSITIONS: ReadonlyArray<readonly string[]> = [
  BASE_COMPOSE_FILES,
  DEMO_COMPOSE_FILES,
  STAGE_COMPOSE_FILES,
];

// ---------------------------------------------------------------------------
// ONE `docker compose config` RUN PER DISTINCT ARGUMENT SET (issue #809).
//
// Every case below reads a RENDERED compose configuration, and rendering one
// shells out to the Docker CLI. On a cold GitHub-hosted `ubuntu-latest` runner
// that costs seconds, which is enough for the 5000 ms Bun gives a test that
// declares no timeout to expire on a diff that changed nothing here: PR #801's
// `unit` run 33355162238 died at 5187 ms with the same test green one commit
// earlier. At roughly one effective concurrency a spurious red costs a full
// re-queue behind the whole merge train, so the budget is not the thing to
// raise — the redundant work is the thing to remove.
//
// So `composeConfig` memoises on its FULL argument set (knobs + compose files +
// profiles), and `PREWARM` renders every distinct set once in a `beforeAll`
// with an explicit budget. Two cases asking for the same rendering then share
// one Docker run and NO test body ever waits on Docker.
//
// The memo key deliberately includes the overlay list and the profile list.
// Several cases here render genuinely DIFFERENT configurations — base vs smoke
// vs stage, the profile-gated member-agent resolution, the resolver's
// `--stage` cadence profile — and collapsing those into one shared render
// would make them pass while asserting against the wrong config, which is
// strictly worse than the flake this removes.
//
// The cache stores the raw JSON TEXT and re-parses per call, so every case gets
// its own object graph: a case that mutated its config could never leak that
// into a sibling.
const renderCache = new Map<string, string>();
let prewarmed = false;
/** Renders that missed the prewarm — see the regression guard at end of file. */
const coldRendersAfterPrewarm: string[] = [];

function renderKey(
  knobs: Record<string, string>,
  composeFiles: readonly string[],
  profiles: readonly string[],
): string {
  return JSON.stringify({
    files: [...composeFiles],
    profiles: [...profiles],
    knobs: Object.entries(knobs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });
}

function renderComposeConfig(
  knobs: Record<string, string>,
  composeFiles: readonly string[],
  profiles: readonly string[],
): string {
  const r = Bun.spawnSync(
    [
      "docker", "compose",
      ...profiles.flatMap((profile) => ["--profile", profile]),
      ...composeFiles.flatMap((file) => ["-f", file]),
      "config", "--format", "json",
    ],
    { cwd: repoRoot, env: { ...baseEnv(), ...knobs }, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker compose config failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
  }
  return new TextDecoder().decode(r.stdout);
}

function composeConfig(
  knobs: Record<string, string>,
  composeFiles: readonly string[] = DEMO_COMPOSE_FILES,
  profiles: readonly string[] = [],
): ComposeConfig {
  const key = renderKey(knobs, composeFiles, profiles);
  let json = renderCache.get(key);
  if (json === undefined) {
    if (prewarmed) coldRendersAfterPrewarm.push(key);
    json = renderComposeConfig(knobs, composeFiles, profiles);
    renderCache.set(key, json);
  }
  return JSON.parse(json) as ComposeConfig;
}

interface RenderArgs {
  knobs: Record<string, string>;
  files: readonly string[];
  profiles?: readonly string[];
}

// Every distinct rendering the cases below ask for. Adding a case that needs a
// new one without listing it here is caught mechanically by the regression
// guard at the end of this file, not left to be rediscovered as a flake.
//
// The INPUT knobs are duplicated here on purpose: the values a case asserts on
// stay written out in the case itself, so mutating an expected value still
// turns that case red.
const PREWARM: readonly RenderArgs[] = [
  ...ALL_COMPOSITIONS.flatMap((files): RenderArgs[] => [
    // "AUM producer revision reaches every backend image build", explicit.
    { knobs: { AUM_PRODUCER_REVISION: "git-fixture-abc123" }, files },
    // The unset baseline: the revision cases, the healthcheck sweep, and the
    // boot-guard "even when UNSET" cases all read it.
    { knobs: {}, files },
    // "boot-guard operator controls reach the api container", both set.
    {
      knobs: { RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1", PG_NAMESPACE_GUARD_TIMEOUT_MS: "15000" },
      files,
    },
  ]),
  // "production capability TTLs" — explicit TTLs, base composition only.
  {
    knobs: { HTTP_FETCH_CACHE_TTL_MS: "45000", TOKEN_PRICE_CACHE_TTL_MS: "90000" },
    files: BASE_COMPOSE_FILES,
  },
  // "explicit BASE_RPC_URL override is honored".
  { knobs: { BASE_RPC_URL: "http://127.0.0.1:9999" }, files: DEMO_COMPOSE_FILES },
  // The resolver-driven renders. The non-stage and stage cadence profiles are
  // DIFFERENT argument sets and keep their own renders; `resolveSmokeEnv({})`
  // and `resolveSmokeEnv({}, { stage: false })` resolve to the same composeEnv
  // and legitimately share one.
  { knobs: resolveSmokeEnv({}).composeEnv, files: DEMO_COMPOSE_FILES },
  { knobs: resolveSmokeEnv({}, { stage: false }).composeEnv, files: DEMO_COMPOSE_FILES },
  { knobs: resolveSmokeEnv({}, { stage: true }).composeEnv, files: DEMO_COMPOSE_FILES },
  // "member-agent compose template — zero ambient model configuration".
  {
    knobs: { OPENCODE_API_KEY: "planted-compose-secret", AGENT_MODEL: "opencode/planted-model" },
    files: DEMO_COMPOSE_FILES,
  },
  {
    knobs: { ANALYTICS_TOKEN_FILE_HOST: "/tmp/robotmoney-smoke-session-secrets/analytics-token" },
    files: DEMO_COMPOSE_FILES,
  },
  // "the retired per-property cache knobs are NOT compose passthroughs anymore".
  { knobs: { FETCH_CACHE_TTL_MS: "123", GECKO_PRICE_CACHE_TTL_MS: "456" }, files: DEMO_COMPOSE_FILES },
  // The profile-gated member-agent resolution.
  { knobs: {}, files: DEMO_COMPOSE_FILES, profiles: ["member-agent"] },
  // "the controls are scoped to the api".
  { knobs: { RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1" }, files: DEMO_COMPOSE_FILES },
];

// The whole file's Docker cost, paid once, outside any case's budget. Locally
// the loop takes ~3.5 s; 120 s is ~35x that, sized for a cold shared runner
// paying the Docker CLI's own start-up on the first render and running several
// times slower than a warm workstation thereafter. It is still bounded, so a
// genuinely wedged Docker fails the job in well under the workflow timeout
// rather than hanging it. A missing or broken docker CLI throws here and turns
// the whole file RED — never a silent skip (test-coverage policy).
const PREWARM_TIMEOUT_MS = 120_000;

beforeAll(() => {
  for (const { knobs, files, profiles } of PREWARM) composeConfig(knobs, files, profiles ?? []);
  prewarmed = true;
}, PREWARM_TIMEOUT_MS);

function serviceEnv(cfg: ComposeConfig, svc: string): Record<string, string | null> {
  const env = cfg.services?.[svc]?.environment;
  if (!env) throw new Error(`compose config has no environment for service "${svc}"`);
  return env;
}

// Every service whose process reads the Base RPC / analytics knobs: the api and
// all three worker lanes (issue #107 topology — swarm/analytics/research).
const RPC_CONSUMERS = ["api", "worker-swarm", "worker-analytics", "worker-research"] as const;
const HTTP_CACHE_CONSUMERS = [...RPC_CONSUMERS, "analytics-producer"] as const;
const BACKEND_IMAGE_BUILDS = [...RPC_CONSUMERS, "analytics-producer"] as const;

describe("AUM producer revision reaches every backend image build", () => {
  // The same three file lists PREWARM renders — shared so a case can never ask
  // for a composition the prewarm did not pay for.
  const COMPOSITIONS: Array<readonly [string, readonly string[]]> = [
    ["base", BASE_COMPOSE_FILES],
    ["smoke", DEMO_COMPOSE_FILES],
    ["stage", STAGE_COMPOSE_FILES],
  ];

  for (const [label, files] of COMPOSITIONS) {
    test(`${label} passes the exact explicit revision to every backend Docker build`, () => {
      const cfg = composeConfig({ AUM_PRODUCER_REVISION: "git-fixture-abc123" }, files);
      for (const service of BACKEND_IMAGE_BUILDS) {
        expect(`${service}:${cfg.services[service]?.build?.args?.AUM_PRODUCER_REVISION ?? "missing"}`)
          .toBe(`${service}:git-fixture-abc123`);
      }
    });

    test(`${label} preserves honest unavailable semantics when the revision is unset`, () => {
      const cfg = composeConfig({}, files);
      for (const service of BACKEND_IMAGE_BUILDS) {
        expect(`${service}:${cfg.services[service]?.build?.args?.AUM_PRODUCER_REVISION ?? ""}`)
          .toBe(`${service}:`);
      }
    });
  }

  test("the Dockerfile exposes only the explicit build argument, with no fallback", async () => {
    const dockerfile = await Bun.file(join(repoRoot, "backend/Dockerfile")).text();
    expect(dockerfile).toMatch(/^ARG AUM_PRODUCER_REVISION$/m);
    expect(dockerfile).toMatch(/^ENV AUM_PRODUCER_REVISION=\$AUM_PRODUCER_REVISION$/m);
    expect(dockerfile).not.toMatch(/AUM_PRODUCER_REVISION=.*(?:unknown|package|date|timestamp)/i);
  });
});

describe("docker compose config — production capability TTLs", () => {
  test("base compose leaves optional TTLs blank so backend defaults remain authoritative", () => {
    const cfg = composeConfig({}, BASE_COMPOSE_FILES);
    for (const svc of HTTP_CACHE_CONSUMERS) {
      expect(serviceEnv(cfg, svc).HTTP_FETCH_CACHE_TTL_MS ?? "").toBe("");
    }
    for (const svc of RPC_CONSUMERS) {
      expect(serviceEnv(cfg, svc).TOKEN_PRICE_CACHE_TTL_MS ?? "").toBe("");
    }
    expect("TOKEN_PRICE_CACHE_TTL_MS" in serviceEnv(cfg, "analytics-producer")).toBe(false);
  });

  test("base compose honors explicit TTLs only on services that consume them", () => {
    const cfg = composeConfig(
      { HTTP_FETCH_CACHE_TTL_MS: "45000", TOKEN_PRICE_CACHE_TTL_MS: "90000" },
      BASE_COMPOSE_FILES,
    );
    for (const svc of HTTP_CACHE_CONSUMERS) {
      expect(serviceEnv(cfg, svc).HTTP_FETCH_CACHE_TTL_MS).toBe("45000");
    }
    for (const svc of RPC_CONSUMERS) {
      expect(serviceEnv(cfg, svc).TOKEN_PRICE_CACHE_TTL_MS).toBe("90000");
    }
    expect("TOKEN_PRICE_CACHE_TTL_MS" in serviceEnv(cfg, "analytics-producer")).toBe(false);
  });
});

describe("docker compose config — smoke data path resolution", () => {
  test("the default network is explicitly attributable when no containers survive", () => {
    const labels = composeConfig({}).networks?.default?.labels;
    expect(labels).toMatchObject({
      "robotmoney.smoke.network": "1",
      "robotmoney.smoke.project": "compose-config-test",
      "robotmoney.env": "local",
      "robotmoney.env.hash": "composecfg0",
    });
  });

  test("the complete compose model parses without an analytics token file", () => {
    const cfg = composeConfig({});
    expect(cfg.secrets?.analytics_token?.file).toBe("/dev/null");
    expect(cfg.services["postgres"]).toBeDefined();
    expect(cfg.services["api"]).toBeDefined();
  });

  test("no base-rpc-stub service exists anymore", () => {
    const cfg = composeConfig({});
    expect(cfg.services?.["base-rpc-stub"]).toBeUndefined();
  });

  test("default (no knobs) resolves the LIVE path: RPC/analytics knobs empty → backend live defaults", () => {
    const cfg = composeConfig({});
    for (const svc of RPC_CONSUMERS) {
      const env = serviceEnv(cfg, svc);
      // Empty ⇒ backend config.ts falls through to https://mainnet.base.org and
      // resolveAnalyticsSource/resolveBaseRpcSource treat "" as live.
      expect(env.BASE_RPC_URL ?? "").toBe("");
      expect(env.ANALYTICS_SOURCE ?? "").toBe("");
      expect(env.BASE_RPC_SOURCE ?? "").toBe("");
      expect(env.ANALYTICS_FLOOR_SEED ?? "").toBe("");
    }
  });

  test("explicit BASE_RPC_URL override is honored", () => {
    const cfg = composeConfig({ BASE_RPC_URL: "http://127.0.0.1:9999" });
    for (const svc of RPC_CONSUMERS) {
      expect(serviceEnv(cfg, svc).BASE_RPC_URL).toBe("http://127.0.0.1:9999");
    }
  });

  test("compose layer agrees with the scripts/lib/smoke-env.ts resolver layer", () => {
    // The resolver (the path `bun run smoke` actually takes) sets
    // ANALYTICS_SOURCE=live + BASE_RPC_SOURCE=live + floor seed 1 and leaves
    // BASE_RPC_URL unset; compose must pass those through untouched.
    const live = composeConfig(resolveSmokeEnv({}).composeEnv);
    for (const svc of RPC_CONSUMERS) {
      const env = serviceEnv(live, svc);
      expect(env.BASE_RPC_URL ?? "").toBe(""); // unset → backend live default
      expect(env.ANALYTICS_SOURCE).toBe("live");
      expect(env.BASE_RPC_SOURCE).toBe("live");
      expect(env.ANALYTICS_FLOOR_SEED).toBe("1");
    }
  });

  test("no assignment in either compose layer can resolve BASE_RPC_URL to live mainnet", () => {
    // Even with every knob unset the resolved value must never BE mainnet —
    // the live default lives in backend config.ts, not in a compose literal.
    const cfg = composeConfig({});
    for (const svc of RPC_CONSUMERS) {
      expect(serviceEnv(cfg, svc).BASE_RPC_URL ?? "").not.toContain("mainnet.base.org");
    }
  });
});

// Issue #371: the smoke's cadence PROFILE reaches the analytics-producer through
// resolveSmokeEnv's composeEnv, so swarm cadence and research cadence are
// stated in one file (scripts/lib/smoke-schedule.ts). These cases run the real
// `docker compose config` interpolation, which is the only thing that proves the
// container would actually receive those cron strings.
describe("analytics-producer cron resolution — the smoke cadence profile (issue #371)", () => {
  test("the STAGE path resolves the realistic profile's 3-hourly research/regime timers", () => {
    const stage = resolveSmokeCadence({ stage: true });
    const resolution = resolveSmokeEnv({}, { stage: true });
    // The resolver emits them…
    expect(resolution.composeEnv.PRODUCER_RESEARCH_CRON).toBe(stage.researchCron);
    expect(resolution.composeEnv.PRODUCER_REGIME_CRON).toBe(stage.regimeCron);
    // …and compose resolves the producer service to exactly those values.
    const env = serviceEnv(composeConfig(resolution.composeEnv), "analytics-producer");
    expect(env.PRODUCER_RESEARCH_CRON).toBe("0 */3 * * *");
    expect(env.PRODUCER_REGIME_CRON).toBe("30 */3 * * *");
    expect(env.PRODUCER_RESEARCH_CRON).toBe(stage.researchCron);
    expect(env.PRODUCER_REGIME_CRON).toBe(stage.regimeCron);
  });

  test("the NON-STAGE path injects nothing and resolves the committed production defaults", () => {
    const resolution = resolveSmokeEnv({}, { stage: false });
    expect("PRODUCER_RESEARCH_CRON" in resolution.composeEnv).toBe(false);
    expect("PRODUCER_REGIME_CRON" in resolution.composeEnv).toBe(false);
    const env = serviceEnv(composeConfig(resolution.composeEnv), "analytics-producer");
    expect(env.PRODUCER_RESEARCH_CRON).toBe("0 23 * * *");
    expect(env.PRODUCER_REGIME_CRON).toBe("30 22 * * *");
    // Same strings the fast profile states, so the single-source claim holds.
    expect(env.PRODUCER_RESEARCH_CRON).toBe(COMMITTED_RESEARCH_CRON);
    expect(env.PRODUCER_REGIME_CRON).toBe(COMMITTED_REGIME_CRON);
  });

  test("omitting the option entirely is the non-stage path — CI can never opt in by accident", () => {
    const env = serviceEnv(composeConfig(resolveSmokeEnv({}).composeEnv), "analytics-producer");
    expect(env.PRODUCER_RESEARCH_CRON).toBe(COMMITTED_RESEARCH_CRON);
    expect(env.PRODUCER_REGIME_CRON).toBe(COMMITTED_REGIME_CRON);
  });

  test("the two paths really do resolve DIFFERENT producer schedules", () => {
    const stage = serviceEnv(composeConfig(resolveSmokeEnv({}, { stage: true }).composeEnv), "analytics-producer");
    const plain = serviceEnv(composeConfig(resolveSmokeEnv({}, { stage: false }).composeEnv), "analytics-producer");
    expect(stage.PRODUCER_RESEARCH_CRON).not.toBe(plain.PRODUCER_RESEARCH_CRON);
    expect(stage.PRODUCER_REGIME_CRON).not.toBe(plain.PRODUCER_REGIME_CRON);
  });
});

describe("member-agent compose template — zero ambient model configuration", () => {
  test("OPENCODE_API_KEY and AGENT_MODEL never propagate through service environment", () => {
    const cfg = composeConfig({
      OPENCODE_API_KEY: "planted-compose-secret",
      AGENT_MODEL: "opencode/planted-model",
    });
    const env = cfg.services?.["member-agent"]?.environment ?? {};
    expect("OPENCODE_API_KEY" in env).toBe(false);
    expect("AGENT_MODEL" in env).toBe(false);
  });

  test("analytics secret is mounted into the producer, never the member-agent", () => {
    const tokenPath = "/tmp/robotmoney-smoke-session-secrets/analytics-token";
    const cfg = composeConfig({ ANALYTICS_TOKEN_FILE_HOST: tokenPath });
    expect(cfg.secrets?.analytics_token?.file).toBe(tokenPath);
    expect(cfg.services["analytics-producer"]?.environment?.ANALYTICS_TOKEN_FILE).toBe("/run/secrets/analytics_token");
    expect(cfg.services["analytics-producer"]?.secrets?.map((s) => s.source)).toContain("analytics_token");
    expect(cfg.services["member-agent"]?.secrets ?? []).toEqual([]);
    expect(JSON.stringify(cfg.services["member-agent"]?.volumes ?? [])).not.toContain(tokenPath);
  });
});

describe("smoke-specific behavior is selected by explicit orchestration", () => {
  test("compose carries no generic smoke-mode environment marker", () => {
    const cfg = composeConfig({});
    for (const svc of RPC_CONSUMERS) {
      expect(Object.keys(serviceEnv(cfg, svc))).not.toContain(["DEMO", "MODE"].join("_"));
    }
  });

  test("smoke and smoke share one-hour capability TTLs; production keeps backend defaults", () => {
    const normal = composeConfig(resolveSmokeEnv({}).composeEnv);
    const smoke = composeConfig(resolveSmokeEnv({}).composeEnv);
    for (const svc of HTTP_CACHE_CONSUMERS) {
      expect(serviceEnv(normal, svc).HTTP_FETCH_CACHE_TTL_MS).toBe("3600000");
      expect(serviceEnv(smoke, svc).HTTP_FETCH_CACHE_TTL_MS).toBe("3600000");
    }
    for (const svc of RPC_CONSUMERS) {
      expect(serviceEnv(normal, svc).TOKEN_PRICE_CACHE_TTL_MS).toBe("3600000");
      expect(serviceEnv(smoke, svc).TOKEN_PRICE_CACHE_TTL_MS).toBe("3600000");
    }
  });

  test("the retired per-property cache knobs are NOT compose passthroughs anymore", () => {
    // Setting retired knobs in the caller env must not reach any container.
    const cfg = composeConfig({ FETCH_CACHE_TTL_MS: "123", GECKO_PRICE_CACHE_TTL_MS: "456" });
    for (const svc of RPC_CONSUMERS) {
      const env = serviceEnv(cfg, svc);
      expect("FETCH_CACHE_TTL_MS" in env).toBe(false);
      expect("GECKO_PRICE_CACHE_TTL_MS" in env).toBe(false);
    }
  });

  test("smoke and twin share one migrate path with scenario-specific initialization", async () => {
    const smoke = scenarioPlan(false);
    const twin = scenarioPlan(true);

    expect(smoke.initializer).toBe("simulation");
    expect(smoke.migrateEnv).toEqual({ SMOKE_SEED_PROJECTS: "1" });
    expect(smoke.migrateScriptArgs).toEqual(["--seed-smoke-schedules"]);
    expect(twin.initializer).toBe("archive");
    expect(twin.migrateEnv).toEqual({});
    expect(twin.migrateScriptArgs).toEqual([]);

    const smokeMain = await Bun.file(join(repoRoot, "scripts/lib/smoke-main.ts")).text();
    expect(smokeMain.match(/await stack\.up\(/g) ?? []).toHaveLength(1);
    expect(smokeMain).toContain("migrateEnv: scenario.migrateEnv");
    expect(smokeMain).toContain("migrateScriptArgs: [...scenario.migrateScriptArgs]");
    expect(smokeMain).toContain("initialize: initializeScenario");
    expect(smokeMain).toContain('"--already-migrated"');
    expect(smokeMain).toContain('"src/producer/index.ts", "seed"');
    expect(smokeMain).not.toContain("v0-seed-bootstrap");
    expect(smokeMain).toContain("{ stage: staticPortMode }");
    const stackSrc = await Bun.file(join(repoRoot, "scripts/stack/stack.ts")).text();
    expect(stackSrc).toContain("migrateScriptArgs");
    const stackConfigSrc = await Bun.file(join(repoRoot, "scripts/stack/config.ts")).text();
    expect(`${stackSrc}${stackConfigSrc}`).toMatch(/"-e"/);
    const seed = await Bun.file(join(repoRoot, "backend/src/db/seed.ts")).text();
    expect(seed).toContain("seedSmokeJobSchedules");
    for (const retired of ["DEMO_FAST_SCHEDULES", "DEMO_SLOW_SAMPLERS"]) {
      expect(smokeMain).not.toContain(retired);
      expect(seed).not.toContain(retired);
    }
  });
});

// Docker's json-file driver is UNBOUNDED by default, and a service that simply
// omits `logging:` silently gets that default back — which is why this asserts
// over EVERY resolved service rather than a named list. Container logs are the
// primary debugging surface for a crashing lane, so they must be retained and
// bounded, not merely one or the other.
describe("container logs are bounded on every service", () => {
  test("each resolved service pins a rotating json-file driver", () => {
    const cfg = composeConfig({});
    const services = Object.keys(cfg.services ?? {});
    expect(services.length).toBeGreaterThan(0);

    const unbounded = services.filter((name) => {
      const log = cfg.services[name]?.logging;
      return log?.driver !== "json-file" || !log?.options?.["max-size"] || !log?.options?.["max-file"];
    });

    expect(unbounded).toEqual([]);
  });

  test("retention is large enough to show a crash loop developing", () => {
    const cfg = composeConfig({});
    for (const [name, svc] of Object.entries(cfg.services ?? {})) {
      const files = Number(svc.logging?.options?.["max-file"]);
      expect(`${name}:${files}`).toBe(`${name}:${Math.max(files, 3)}`);
    }
  });
});

// Every standing service must be able to answer "am I still working?" — the
// worker lanes and the analytics producer shipped without one for a long time
// because no honest answer existed for them (a process-existence probe paints a
// WEDGED lane green, which is worse than no check at all). Now that they report
// a work-loop heartbeat (backend/src/ops/heartbeat.ts), the gap is closed, and
// these tests keep it closed.
//
// Iterated over the RESOLVED service set rather than a named list, for the same
// reason as the logging tests above: a service added later that omits a
// healthcheck inherits nothing and would otherwise ship silently unmonitored.
describe("every long-running service reports its own health", () => {
  // Checked against every composition the repo actually boots, not just the
  // smoke one: an overlay that replaces a service's block can drop the base
  // healthcheck, and the stage overlay is what runs the public smoke.
  // The same three file lists PREWARM renders — shared so a case can never ask
  // for a composition the prewarm did not pay for.
  const COMPOSITIONS: Array<readonly [string, readonly string[]]> = [
    ["base", BASE_COMPOSE_FILES],
    ["smoke", DEMO_COMPOSE_FILES],
    ["stage", STAGE_COMPOSE_FILES],
  ];

  for (const [label, files] of COMPOSITIONS) {
    test(`each service resolved by the ${label} composition declares a healthcheck`, () => {
      const cfg = composeConfig({}, files);
      const services = Object.keys(cfg.services ?? {});
      expect(services.length).toBeGreaterThan(0);

      const unmonitored = services.filter((name) => {
        const hc = cfg.services[name]?.healthcheck;
        // `disable: true` is compose's explicit opt-out and counts as no check.
        return hc?.disable === true || !(hc?.test?.length);
      });

      expect(`${label}:${unmonitored.join(",")}`).toBe(`${label}:`);
    });
  }

  test("a slow first boot is not counted as a failure — every app service sets a start_period", () => {
    const cfg = composeConfig({});
    // postgres is exempt by construction: its pg_isready check has no
    // start_period but retries 10x at 5s, which covers first boot the same way.
    const withoutGrace = Object.entries(cfg.services ?? {})
      .filter(([name]) => name !== "postgres")
      .filter(([, svc]) => !svc.healthcheck?.start_period)
      .map(([name]) => name);

    expect(withoutGrace).toEqual([]);
  });

  test("the producer's grace covers the readiness wait it blocks on before its first heartbeat", () => {
    const cfg = composeConfig({});
    // startProducerSchedules blocks in waitForApi for up to 120s before the
    // liveness loop writes anything; a shorter grace would report a healthy
    // producer as failed on every cold boot.
    const seconds = (v: string | undefined) => {
      const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(v ?? "");
      return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
    };

    expect(seconds(cfg.services["analytics-producer"]?.healthcheck?.start_period)).toBeGreaterThan(120);
  });

  test("the lanes and the producer all run the heartbeat check, not a process-existence probe", () => {
    const cfg = composeConfig({});
    for (const name of ["worker-swarm", "worker-analytics", "worker-research", "analytics-producer"]) {
      const test_ = cfg.services[name]?.healthcheck?.test ?? [];
      // Pinning the command is the point: `CMD true` / `pgrep bun` would satisfy
      // the "declares a healthcheck" test above while proving nothing.
      expect(`${name}:${test_.join(" ")}`).toBe(`${name}:CMD bun run src/ops/healthcheck.ts`);
    }
  });

  test("the one-shot member-agent template is exempt BY PROFILE GATING, not by being forgotten", () => {
    // It is a `docker compose run` template, not a standing service, so a
    // standing healthcheck is the wrong mechanism for it. That exemption must
    // rest on something the sweep above can see — profile gating keeps it out of
    // the default resolution entirely.
    expect(Object.keys(composeConfig({}).services)).not.toContain("member-agent");

    const gated = composeConfig({}, DEMO_COMPOSE_FILES, ["member-agent"]);
    expect(Object.keys(gated.services)).toContain("member-agent");
    // And it is still a one-shot when it does appear: `restart: no`, so nothing
    // supervises it as a standing process.
    expect(gated.services["member-agent"]?.restart).toBe("no");
    expect(gated.services["member-agent"]?.profiles).toEqual(["member-agent"]);
  });
});

// The handle/id namespace boot guard's two OPERATOR CONTROLS (issue #602): the
// emergency override RM_ALLOW_HANDLE_NAMESPACE_VIOLATION and the wall-clock
// budget PG_NAMESPACE_GUARD_TIMEOUT_MS.
//
// WHY THIS LIVES HERE AND NOT IN backend/tests. The backend suite spawns the
// entrypoint with `env: { ..., RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1" }`,
// which proves the CODE honours the variable and can prove nothing about
// whether the variable ever ARRIVES: Bun.spawn bypasses compose entirely. The
// api service's `environment:` block is an ALLOWLIST — no compose file here has
// an `env_file:` and backend/Dockerfile sets no ENV — so a variable that block
// does not name is never delivered to the container, and the failure is
// perfectly silent: an override that was never delivered and one that was never
// set produce byte-identical output, while docs/runbooks/deployment.md §2.1
// tells a paged operator to set it and redeploy. That is the gap these cases
// close, and they close it the only way it can be closed — against the RENDERED
// compose configuration, over every composition the repo actually boots.
describe("boot-guard operator controls reach the api container (issue #602)", () => {
  // The same three file lists PREWARM renders — shared so a case can never ask
  // for a composition the prewarm did not pay for.
  const COMPOSITIONS: Array<readonly [string, readonly string[]]> = [
    ["base", BASE_COMPOSE_FILES],
    ["smoke", DEMO_COMPOSE_FILES],
    ["stage", STAGE_COMPOSE_FILES],
  ];
  const CONTROLS = ["RM_ALLOW_HANDLE_NAMESPACE_VIOLATION", "PG_NAMESPACE_GUARD_TIMEOUT_MS"] as const;

  for (const [label, files] of COMPOSITIONS) {
    test(`the ${label} composition DELIVERS both controls to the api when they are set`, () => {
      const env = serviceEnv(
        composeConfig(
          { RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1", PG_NAMESPACE_GUARD_TIMEOUT_MS: "15000" },
          files,
        ),
        "api",
      );
      // The values, not merely the keys: a `${VAR}` that resolved to the wrong
      // thing would satisfy a presence check and still lose the override.
      expect(env.RM_ALLOW_HANDLE_NAMESPACE_VIOLATION).toBe("1");
      expect(env.PG_NAMESPACE_GUARD_TIMEOUT_MS).toBe("15000");
    });

    test(`the ${label} composition names both controls even when they are UNSET`, () => {
      // The allowlist entries must exist unconditionally. If they were only
      // present when the operator happened to have them exported, the rendered
      // config would look fine on the box that set them and lose them on the
      // one that did not.
      const env = serviceEnv(composeConfig({}, files), "api");
      for (const key of CONTROLS) {
        expect(`${label}:${key}:${key in env}`).toBe(`${label}:${key}:true`);
        // Blank, not a literal — backend/src/db/handle-namespace.ts treats an
        // empty string as "unset" (parseGuardBudgetMs returns the default
        // SILENTLY on "", and the override compares strictly against "1"), so a
        // blank passthrough must not arm anything or log an IGNORING line on
        // every production boot.
        expect(`${label}:${key}:${env[key] ?? ""}`).toBe(`${label}:${key}:`);
      }
    });
  }

  test("the controls are scoped to the api — the guard runs on no other service's boot", () => {
    // assertHandleNamespaceClean has three call sites and only one of them is a
    // compose service (the api entrypoint); prod-bootstrap and db-preflight are
    // host-side `bun run`s. Passing the override into a worker lane would widen
    // the blast radius of a forgotten variable for no benefit.
    const cfg = composeConfig({ RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1" });
    for (const [name, svc] of Object.entries(cfg.services ?? {})) {
      if (name === "api") continue;
      for (const key of CONTROLS) {
        expect(`${name}:${key}:${key in (svc.environment ?? {})}`).toBe(`${name}:${key}:false`);
      }
    }
  });

  test("no compose file delivers container environment through an env_file, so the allowlist IS the delivery path", async () => {
    // The premise the cases above rest on, asserted rather than assumed: if a
    // future `env_file:` appeared, "not in the allowlist" would stop meaning
    // "not delivered" and these tests would be guarding the wrong thing.
    for (const file of ["docker-compose.yml", "docker-compose.smoke.yml", "docker-compose.stage.yml"]) {
      const text = await Bun.file(join(repoRoot, file)).text();
      expect(`${file}:${/^\s*env_file\s*:/m.test(text)}`).toBe(`${file}:false`);
    }
    const dockerfile = await Bun.file(join(repoRoot, "backend/Dockerfile")).text();
    for (const key of CONTROLS) {
      expect(`${key}:${new RegExp(`^\\s*ENV\\s+${key}(?:=|\\s)`, "m").test(dockerfile)}`)
        .toBe(`${key}:false`);
    }
  });
});

// Issue #809's regression guard. Every case above reads its compose
// configuration through `composeConfig`, which serves it from the prewarmed
// memo; a case that asks for a rendering `PREWARM` does not list falls back to
// shelling out to Docker inside its own 5000 ms budget, which is exactly the
// flake this file was changed to remove. Declared last so every case has run.
describe("compose renders stay hoisted out of the case bodies (issue #809)", () => {
  test("no case shelled out to Docker on its own — every rendering was prewarmed", () => {
    // A failure lists the argument sets that missed. The fix is to add each one
    // to PREWARM, not to give the case a bigger timeout.
    expect(coldRendersAfterPrewarm).toEqual([]);
  });
});
