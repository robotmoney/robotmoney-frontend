// Compose-layer test for the demo data path (issue #50; issue #147 removed
// DEMO_HERMETIC and the base-rpc-stub service entirely). Shells
// `docker compose -f docker-compose.yml -f docker-compose.demo.yml config`
// (offline — pure interpolation, no daemon-side state, no containers) and
// asserts the RESOLVED api/worker environment:
//
//   - by default (no knobs) every RPC/analytics knob resolves EMPTY, so
//     backend config.ts falls through to its live production defaults
//     (BASE_RPC_URL https://mainnet.base.org, analytics live);
//   - going through the scripts/lib/demo-env.ts resolver (the path
//     `bun run demo` actually takes) pins ANALYTICS_SOURCE=live,
//     BASE_RPC_SOURCE=live, ANALYTICS_FLOOR_SEED=1 explicitly;
//   - an explicit BASE_RPC_URL override beats both defaults.
//
// It also proves the resolver layer (scripts/lib/demo-env.ts) and the compose
// interpolation layer agree when composed. Docker is a hard dependency of this
// repo's test harness (the backend suite boots ephemeral Postgres through it);
// a missing docker CLI fails this test loudly — never a silent skip
// (test-coverage policy).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveDemoEnv } from "../../demo.ts";
import { COMMITTED_REGIME_CRON, COMMITTED_RESEARCH_CRON, resolveDemoCadence } from "../../lib/demo-schedule.ts";
import { scenarioPlan } from "../../lib/smoke-mode.ts";

const repoRoot = join(import.meta.dir, "../../..");

interface ComposeConfig {
  services: Record<string, {
    environment?: Record<string, string | null>;
    secrets?: Array<{ source: string; target: string }>;
    volumes?: Array<{ source?: string; target?: string; read_only?: boolean }>;
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
      // Cadence knobs (issue #371): only resolveDemoEnv's stage path may set
      // these, so an ambient value must never leak into a case's resolution.
      "PRODUCER_REGIME_CRON", "PRODUCER_RESEARCH_CRON",
    ].includes(k)) continue;
    env[k] = v;
  }
  env.DEMO_PROJECT = "compose-config-test"; // used by labels; avoids interpolation warnings
  // The environment labels docker-compose.demo.yml stamps on every service and
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

const DEMO_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.demo.yml"] as const;

function composeConfig(
  knobs: Record<string, string>,
  composeFiles: readonly string[] = DEMO_COMPOSE_FILES,
): ComposeConfig {
  const r = Bun.spawnSync(
    ["docker", "compose", ...composeFiles.flatMap((file) => ["-f", file]), "config", "--format", "json"],
    { cwd: repoRoot, env: { ...baseEnv(), ...knobs }, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker compose config failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(r.stdout)) as ComposeConfig;
}

function serviceEnv(cfg: ComposeConfig, svc: string): Record<string, string | null> {
  const env = cfg.services?.[svc]?.environment;
  if (!env) throw new Error(`compose config has no environment for service "${svc}"`);
  return env;
}

// Every service whose process reads the Base RPC / analytics knobs: the api and
// all three worker lanes (issue #107 topology — swarm/analytics/research).
const RPC_CONSUMERS = ["api", "worker-swarm", "worker-analytics", "worker-research"] as const;
const HTTP_CACHE_CONSUMERS = [...RPC_CONSUMERS, "analytics-producer"] as const;

describe("docker compose config — production capability TTLs", () => {
  test("base compose leaves optional TTLs blank so backend defaults remain authoritative", () => {
    const cfg = composeConfig({}, ["docker-compose.yml"]);
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
      ["docker-compose.yml"],
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

describe("docker compose config — demo data path resolution", () => {
  test("the default network is explicitly attributable when no containers survive", () => {
    const labels = composeConfig({}).networks?.default?.labels;
    expect(labels).toMatchObject({
      "robotmoney.demo.network": "1",
      "robotmoney.demo.project": "compose-config-test",
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

  test("compose layer agrees with the scripts/lib/demo-env.ts resolver layer", () => {
    // The resolver (the path `bun run demo` actually takes) sets
    // ANALYTICS_SOURCE=live + BASE_RPC_SOURCE=live + floor seed 1 and leaves
    // BASE_RPC_URL unset; compose must pass those through untouched.
    const live = composeConfig(resolveDemoEnv({}).composeEnv);
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

// Issue #371: the demo's cadence PROFILE reaches the analytics-producer through
// resolveDemoEnv's composeEnv, so swarm cadence and research cadence are
// stated in one file (scripts/lib/demo-schedule.ts). These cases run the real
// `docker compose config` interpolation, which is the only thing that proves the
// container would actually receive those cron strings.
describe("analytics-producer cron resolution — the demo cadence profile (issue #371)", () => {
  test("the STAGE path resolves the realistic profile's 3-hourly research/regime timers", () => {
    const stage = resolveDemoCadence({ stage: true });
    const resolution = resolveDemoEnv({}, { stage: true });
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
    const resolution = resolveDemoEnv({}, { stage: false });
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
    const env = serviceEnv(composeConfig(resolveDemoEnv({}).composeEnv), "analytics-producer");
    expect(env.PRODUCER_RESEARCH_CRON).toBe(COMMITTED_RESEARCH_CRON);
    expect(env.PRODUCER_REGIME_CRON).toBe(COMMITTED_REGIME_CRON);
  });

  test("the two paths really do resolve DIFFERENT producer schedules", () => {
    const stage = serviceEnv(composeConfig(resolveDemoEnv({}, { stage: true }).composeEnv), "analytics-producer");
    const plain = serviceEnv(composeConfig(resolveDemoEnv({}, { stage: false }).composeEnv), "analytics-producer");
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
    const tokenPath = "/tmp/robotmoney-demo-session-secrets/analytics-token";
    const cfg = composeConfig({ ANALYTICS_TOKEN_FILE_HOST: tokenPath });
    expect(cfg.secrets?.analytics_token?.file).toBe(tokenPath);
    expect(cfg.services["analytics-producer"]?.environment?.ANALYTICS_TOKEN_FILE).toBe("/run/secrets/analytics_token");
    expect(cfg.services["analytics-producer"]?.secrets?.map((s) => s.source)).toContain("analytics_token");
    expect(cfg.services["member-agent"]?.secrets ?? []).toEqual([]);
    expect(JSON.stringify(cfg.services["member-agent"]?.volumes ?? [])).not.toContain(tokenPath);
  });
});

describe("demo-specific behavior is selected by explicit orchestration", () => {
  test("compose carries no generic demo-mode environment marker", () => {
    const cfg = composeConfig({});
    for (const svc of RPC_CONSUMERS) {
      expect(Object.keys(serviceEnv(cfg, svc))).not.toContain(["DEMO", "MODE"].join("_"));
    }
  });

  test("demo and smoke share one-hour capability TTLs; production keeps backend defaults", () => {
    const normal = composeConfig(resolveDemoEnv({}).composeEnv);
    const smoke = composeConfig(resolveDemoEnv({}).composeEnv);
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

  test("demo and smoke share one migrate path with scenario-specific initialization", async () => {
    const demo = scenarioPlan(false);
    const smoke = scenarioPlan(true);

    expect(demo.initializer).toBe("simulation");
    expect(demo.migrateEnv).toEqual({ DEMO_SEED_PROJECTS: "1" });
    expect(demo.migrateScriptArgs).toEqual(["--seed-demo-schedules"]);
    expect(smoke.initializer).toBe("archive");
    expect(smoke.migrateEnv).toEqual({});
    expect(smoke.migrateScriptArgs).toEqual([]);

    const demoMain = await Bun.file(join(repoRoot, "scripts/lib/demo-main.ts")).text();
    expect(demoMain.match(/await stack\.up\(/g) ?? []).toHaveLength(1);
    expect(demoMain).toContain("migrateEnv: scenario.migrateEnv");
    expect(demoMain).toContain("migrateScriptArgs: [...scenario.migrateScriptArgs]");
    expect(demoMain).toContain("initialize: initializeScenario");
    expect(demoMain).toContain('"--already-migrated"');
    expect(demoMain).toContain('"src/producer/index.ts", "seed"');
    expect(demoMain).not.toContain("v0-seed-bootstrap");
    expect(demoMain).toContain("{ stage: staticPortMode }");
    const stackSrc = await Bun.file(join(repoRoot, "scripts/stack/stack.ts")).text();
    expect(stackSrc).toContain("migrateScriptArgs");
    const stackConfigSrc = await Bun.file(join(repoRoot, "scripts/stack/config.ts")).text();
    expect(`${stackSrc}${stackConfigSrc}`).toMatch(/"-e"/);
    const seed = await Bun.file(join(repoRoot, "backend/src/db/seed.ts")).text();
    expect(seed).toContain("seedDemoJobSchedules");
    for (const retired of ["DEMO_FAST_SCHEDULES", "DEMO_SLOW_SAMPLERS"]) {
      expect(demoMain).not.toContain(retired);
      expect(seed).not.toContain(retired);
    }
  });
});
