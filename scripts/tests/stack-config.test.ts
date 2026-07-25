// Pure unit tests for scripts/stack/config.ts — no Docker, no network.
//
// These execute the two properties the shared stack module exists to
// guarantee (docs/decisions.md D22, docs/architecture.md §11.3 E1/E5):
//   - `core` never contains a worker lane or the member-agent service, so the
//     eval can never accidentally boot the full demo cluster;
//   - the environment handed to a compose child is BUILT, not inherited, so an
//     ambient provider key or an operator's own admin token can never reach a
//     container.
import { describe, expect, test } from "bun:test";
import {
  buildComposeEnv,
  buildSpawnEnv,
  composeArgs,
  CORE_SERVICES,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  downArgs,
  generateStackCredentials,
  hostBackendUrl,
  internalDatabaseUrl,
  migrateArgs,
  pgReadyArgs,
  servicesFor,
  upArgs,
  WORKER_LANE_SERVICES,
  type StackConfig,
} from "../stack/config.ts";

function cfg(overrides: Partial<StackConfig> = {}): StackConfig {
  return {
    repoRoot: "/repo",
    project: "rmtest",
    profile: "core",
    apiPort: 41234,
    pgPort: 45678,
    composeFiles: DEFAULT_COMPOSE_FILES,
    database: DEFAULT_STACK_DATABASE,
    credentials: { adminToken: "cfg-admin", analyticsToken: "cfg-analytics" },
    ...overrides,
  };
}

describe("stack profiles", () => {
  test("core is exactly postgres + api — no worker lane, no member-agent", () => {
    expect(servicesFor("core")).toEqual(["postgres", "api"]);
    for (const lane of WORKER_LANE_SERVICES) expect(servicesFor("core")).not.toContain(lane);
    expect(servicesFor("core")).not.toContain("member-agent");
  });

  test("full is core plus the three worker lanes, in order", () => {
    expect(servicesFor("full")).toEqual([...CORE_SERVICES, ...WORKER_LANE_SERVICES]);
    expect(servicesFor("full")).not.toContain("member-agent");
  });
});

describe("buildComposeEnv", () => {
  test("returns EXACTLY the compose interpolation keys — and no COMPOSE_FILE/COMPOSE_PROJECT_NAME", () => {
    const env = buildComposeEnv(cfg());
    expect(Object.keys(env).sort()).toEqual([
      "ADMIN_TOKEN",
      "ANALYTICS_TOKEN",
      "DATABASE_URL",
      "DEMO_PROJECT",
      "POSTGRES_DB",
      "POSTGRES_PASSWORD",
      "POSTGRES_PORT",
      "POSTGRES_USER",
      "WEB_PORT",
    ]);
    expect(env.COMPOSE_FILE).toBeUndefined();
    expect(env.COMPOSE_PROJECT_NAME).toBeUndefined();
  });

  test("extraComposeEnv is merged, not dropped", () => {
    const env = buildComposeEnv(cfg({ extraComposeEnv: { ANALYTICS_SOURCE: "live" } }));
    expect(env.ANALYTICS_SOURCE).toBe("live");
  });

  test("ignores the ambient environment entirely — the config's tokens win, sentinels never appear", () => {
    const saved = {
      ADMIN_TOKEN: process.env.ADMIN_TOKEN,
      ANALYTICS_TOKEN: process.env.ANALYTICS_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.ADMIN_TOKEN = "AMBIENT-ADMIN-SENTINEL";
    process.env.ANALYTICS_TOKEN = "AMBIENT-ANALYTICS-SENTINEL";
    process.env.ANTHROPIC_API_KEY = "AMBIENT-KEY-SENTINEL";
    try {
      const env = buildComposeEnv(cfg());
      expect(env.ADMIN_TOKEN).toBe("cfg-admin");
      expect(env.ANALYTICS_TOKEN).toBe("cfg-analytics");
      expect(JSON.stringify(env)).not.toContain("SENTINEL");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("buildSpawnEnv", () => {
  const hostEnv = {
    PATH: "/usr/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    ANTHROPIC_API_KEY: "leak",
    OPENAI_API_KEY: "leak",
    OPENCODE_MODEL: "paid/model",
    ADMIN_TOKEN: "operator-leak",
    SOME_RANDOM_HOST_VAR: "leak",
  };

  test("keeps docker-client plumbing and drops every provider key / model knob (D22 E1)", () => {
    const env = buildSpawnEnv(cfg(), hostEnv);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENCODE_MODEL).toBeUndefined();
    expect(env.SOME_RANDOM_HOST_VAR).toBeUndefined();
  });

  test("a stray operator ADMIN_TOKEN never shadows the stack's own", () => {
    expect(buildSpawnEnv(cfg(), hostEnv).ADMIN_TOKEN).toBe("cfg-admin");
  });
});

describe("argv builders", () => {
  test("composeArgs puts the topology in argv, not the environment", () => {
    expect(composeArgs("p", ["a.yml", "b.yml"])).toEqual(["compose", "-p", "p", "-f", "a.yml", "-f", "b.yml"]);
    expect(composeArgs("p")).toEqual(["compose", "-p", "p", "-f", "docker-compose.yml", "-f", "docker-compose.demo.yml"]);
  });

  test("upArgs names services explicitly — never a bare `up -d`", () => {
    expect(upArgs(["postgres", "api"])).toEqual(["up", "-d", "postgres", "api"]);
  });

  test("downArgs is a plain `down` unless volumes/orphans are explicitly requested", () => {
    expect(downArgs()).toEqual(["down"]);
    expect(downArgs({ removeVolumes: true, removeOrphans: true })).toEqual(["down", "--volumes", "--remove-orphans"]);
  });

  test("pgReadyArgs polls with the configured database identity", () => {
    expect(pgReadyArgs({ user: "u", password: "p", name: "n" })).toEqual([
      "exec", "-T", "postgres", "pg_isready", "-U", "u", "-d", "n",
    ]);
  });

  test("migrateArgs renders each -e pair in order and still ends in the migrate command", () => {
    expect(migrateArgs({ DEMO_MODE: "1", DEMO_SEED_PROJECTS: "1" })).toEqual([
      "run", "--rm", "--no-deps", "-T",
      "-e", "DEMO_MODE=1",
      "-e", "DEMO_SEED_PROJECTS=1",
      "api", "bun", "run", "src/db/migrate.ts",
    ]);
    expect(migrateArgs()).toEqual(["run", "--rm", "--no-deps", "-T", "api", "bun", "run", "src/db/migrate.ts"]);
  });
});

describe("urls and credentials", () => {
  test("internalDatabaseUrl targets the compose service host, never a host port", () => {
    expect(internalDatabaseUrl(DEFAULT_STACK_DATABASE)).toBe("postgres://robotmoney:robotmoney@postgres:5432/robotmoney");
  });

  test("hostBackendUrl uses 127.0.0.1, never localhost (::1 breaks the CI health check)", () => {
    expect(hostBackendUrl(48787)).toBe("http://127.0.0.1:48787");
    expect(hostBackendUrl(48787)).not.toContain("localhost");
  });

  test("generateStackCredentials returns two distinct, non-empty, per-call-fresh secrets", () => {
    const a = generateStackCredentials();
    const b = generateStackCredentials();
    expect(a.adminToken.length).toBeGreaterThan(0);
    expect(a.analyticsToken.length).toBeGreaterThan(0);
    expect(a.adminToken).not.toBe(a.analyticsToken);
    expect(a.adminToken).not.toBe(b.adminToken);
    expect(a.analyticsToken).not.toBe(b.analyticsToken);
  });
});
