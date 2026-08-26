// Pure unit tests for scripts/stack/config.ts and scripts/stack/host-env.ts —
// no Docker, no network.
//
// These execute the two properties the shared stack module exists to
// guarantee (docs/decisions.md D22, docs/architecture.md §11.3 E1/E5):
//   - `core` never contains a worker lane or the member-agent service, so the
//     eval can never accidentally boot the full smoke cluster;
//   - the environment handed to a compose child is BUILT, not inherited, so an
//     ambient provider key or an operator's own admin token can never reach a
//     container.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFullStackProducerCredential,
  buildArgs,
  buildComposeEnv,
  buildServicesFor,
  buildSpawnEnv,
  composeArgs,
  CORE_SERVICES,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  DOCKER_CLIENT_ENV_ALLOWLIST,
  dockerClientHostEnv,
  downArgs,
  generateStackCredentials,
  hostBackendUrl,
  internalDatabaseUrl,
  migrateArgs,
  MEMBER_AGENT_SERVICE,
  pgReadyArgs,
  servicesFor,
  upArgs,
  WORKER_LANE_SERVICES,
  PRODUCER_SERVICES,
  type StackConfig,
} from "../../stack/index.ts";

// A FIXED environment (seeded, so the local hash is deterministic) — these are
// pure-builder tests, and a per-boot random hash would make the compose-env
// assertions below unassertable.
const ENVIRONMENT = { class: "local", hash: "0123456789" } as const;

function cfg(overrides: Partial<StackConfig> = {}): StackConfig {
  return {
    repoRoot: "/repo",
    project: "rm_smoke_stack_0123456789",
    profile: "core",
    composeFiles: DEFAULT_COMPOSE_FILES,
    database: DEFAULT_STACK_DATABASE,
    credentials: { adminToken: "cfg-admin", automationToken: "cfg-automation", analyticsToken: "cfg-analytics" },
    environment: ENVIRONMENT,
    ...overrides,
  };
}

describe("stack profiles", () => {
  test("core is exactly postgres + api — no worker lane, no member-agent", () => {
    expect(servicesFor("core")).toEqual(["postgres", "api"]);
    for (const lane of WORKER_LANE_SERVICES) expect(servicesFor("core")).not.toContain(lane);
    expect(servicesFor("core")).not.toContain("member-agent");
  });

  test("full is core plus worker lanes and the independent producer, in order", () => {
    expect(servicesFor("full")).toEqual([...CORE_SERVICES, ...WORKER_LANE_SERVICES, ...PRODUCER_SERVICES]);
    expect(servicesFor("full")).not.toContain("member-agent");
  });

  test("full prebuilds the profile-gated member-agent image exactly once without starting it", () => {
    const buildServices = buildServicesFor("full");
    expect(buildServices).toEqual([...servicesFor("full"), MEMBER_AGENT_SERVICE]);
    expect(buildServices.filter((service) => service === MEMBER_AGENT_SERVICE)).toHaveLength(1);
    expect(buildArgs(buildServices)).toEqual(["build", ...servicesFor("full"), MEMBER_AGENT_SERVICE]);
    expect(servicesFor("full")).not.toContain(MEMBER_AGENT_SERVICE);
  });

  test("core retains its existing image plan; eval opts into member-agent explicitly", () => {
    expect(buildServicesFor("core")).toEqual(servicesFor("core"));
    expect(buildServicesFor("core")).not.toContain(MEMBER_AGENT_SERVICE);
  });
});

describe("buildComposeEnv", () => {
  test("full profile requires a real producer credential file", () => {
    expect(() => buildComposeEnv(cfg({ profile: "full" }))).toThrow(
      "full stack profile requires credentials.analyticsTokenFile",
    );
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

describe("full-stack producer credential preflight", () => {
  test("core does not require producer secret material", () => {
    expect(() => assertFullStackProducerCredential(cfg())).not.toThrow();
  });

  test("full rejects missing, unreadable, and empty token files before Docker launch", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-stack-token-preflight-"));
    try {
      expect(() => assertFullStackProducerCredential(cfg({ profile: "full" }))).toThrow(
        "full stack profile requires credentials.analyticsTokenFile",
      );
      expect(() => assertFullStackProducerCredential(cfg({
        profile: "full",
        credentials: { adminToken: "a", automationToken: "automation", analyticsToken: "b", analyticsTokenFile: join(dir, "missing") },
      }))).toThrow("is not readable");
      const empty = join(dir, "empty");
      writeFileSync(empty, "\n", { mode: 0o600 });
      expect(() => assertFullStackProducerCredential(cfg({
        profile: "full",
        credentials: { adminToken: "a", automationToken: "automation", analyticsToken: "b", analyticsTokenFile: empty },
      }))).toThrow("is empty");
      const valid = join(dir, "valid");
      writeFileSync(valid, "bearer\n", { mode: 0o600 });
      expect(() => assertFullStackProducerCredential(cfg({
        profile: "full",
        credentials: { adminToken: "a", automationToken: "automation", analyticsToken: "b", analyticsTokenFile: valid },
      }))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
    expect(composeArgs("p")).toEqual(["compose", "-p", "p", "-f", "docker-compose.yml", "-f", "docker-compose.smoke.yml"]);
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
    expect(migrateArgs({ DEMO_SEED_PROJECTS: "1" }, ["--seed-smoke-schedules"])).toEqual([
      "run", "--rm", "--no-deps", "-T",
      "-e", "DEMO_SEED_PROJECTS=1",
      "api", "bun", "run", "src/db/migrate.ts", "--seed-smoke-schedules",
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
    expect(a.automationToken.length).toBeGreaterThan(0);
    expect(a.analyticsToken.length).toBeGreaterThan(0);
    expect(a.adminToken).not.toBe(a.analyticsToken);
    expect(a.adminToken).not.toBe(a.automationToken);
    expect(a.automationToken).not.toBe(a.analyticsToken);
    expect(a.adminToken).not.toBe(b.adminToken);
    expect(a.automationToken).not.toBe(b.automationToken);
    expect(a.analyticsToken).not.toBe(b.analyticsToken);
  });
});

// ── scripts/stack/host-env.ts ───────────────────────────────────────────────
// The ONE deliberate ambient-environment read on a stack path exists so the
// keyless eval under evals/ (which may contain no environment read at all; the
// scripts/checks/ guard enforcing that ships with the eval itself) can still find
// a Docker daemon. These tests are what make "provably nothing else comes out of it"
// true rather than merely claimed.
describe("dockerClientHostEnv", () => {
  const polluted = {
    PATH: "/usr/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    HTTPS_PROXY: "http://proxy:3128",
    ANTHROPIC_API_KEY: "leak",
    OPENAI_API_KEY: "leak",
    OPENCODE_MODEL: "paid/model",
    ADMIN_TOKEN: "operator-leak",
    SOME_RANDOM_HOST_VAR: "leak",
  };

  test("returns docker-client plumbing and NOTHING else (no key, no token, no model knob)", () => {
    const env = dockerClientHostEnv(polluted);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
    expect(JSON.stringify(env)).not.toContain("leak");
    expect(JSON.stringify(env)).not.toContain("paid/model");
  });

  test("every key it can ever return is on the allowlist — there is no pass-through", () => {
    for (const key of Object.keys(dockerClientHostEnv(polluted))) {
      expect(([...DOCKER_CLIENT_ENV_ALLOWLIST] as string[])).toContain(key);
    }
  });

  test("an absent variable is omitted, never emitted as an empty string", () => {
    expect(dockerClientHostEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });
});
