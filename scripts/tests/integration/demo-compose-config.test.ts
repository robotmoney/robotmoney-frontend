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

const repoRoot = join(import.meta.dir, "../../..");

interface ComposeConfig {
  services: Record<string, { environment?: Record<string, string | null> }>;
}

// Base env for the compose call: inherit the caller's env (PATH/HOME/DOCKER_*)
// but STRIP every data-path knob so each case controls them exactly.
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (["BASE_RPC_URL", "BASE_RPC_SOURCE", "ANALYTICS_SOURCE", "ANALYTICS_FLOOR_SEED", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"].includes(k)) continue;
    env[k] = v;
  }
  env.DEMO_PROJECT = "compose-config-test"; // used by labels; avoids interpolation warnings
  return env;
}

function composeConfig(knobs: Record<string, string>): ComposeConfig {
  const r = Bun.spawnSync(
    ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.demo.yml", "config", "--format", "json"],
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
// all three worker lanes (issue #107 topology — committee/analytics/research).
const RPC_CONSUMERS = ["api", "worker-committee", "worker-analytics", "worker-research"] as const;

describe("docker compose config — demo data path resolution", () => {
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

  // INVERTED (docs/decisions.md D22 rule 1, docs/architecture.md §11.3 E1): the
  // member-agent service used to DELIBERATELY forward two provider keys and a
  // model override as an operator paid-model opt-in. It now forwards nothing,
  // proven at the RESOLVED-config level (what compose would actually hand the
  // container) rather than by a source grep. serviceEnv() throws when a service
  // has no environment at all, so this asserts on cfg.services[...] directly.
  test("member-agent forwards NO provider key or model override, even when all three are set in the calling env", () => {
    const cfg = composeConfig({
      ANTHROPIC_API_KEY: "leak-me",
      OPENAI_API_KEY: "leak-me",
      OPENCODE_MODEL: "anthropic/claude-x",
    });
    const env = cfg.services?.["member-agent"]?.environment;
    expect(env === undefined || Object.keys(env).length === 0).toBe(true);
  });
});

describe("DEMO_MODE — the single pinned demo-stack signal (per-IP quota protection)", () => {
  // The demo overlay IS the demo, so DEMO_MODE is a pinned "1" literal (never a
  // ${...} passthrough): every api/worker container knows it unconditionally,
  // and the backend selects its hard-coded demo values off it (1h provider-cache
  // TTLs in analytics/extract/fetch-cache.ts + chain/token-prices.ts; the seed's
  // hourly wallet sampler). Motivation: the standing demo and the self-hosted CI
  // runner share one host IP against GeckoTerminal + the public Base RPC.
  test("compose pins DEMO_MODE=1 on api and every worker lane, regardless of caller env", () => {
    // Even an explicit attempt to unset it from the caller env must not win —
    // a pinned literal ignores interpolation.
    const cfg = composeConfig({ DEMO_MODE: "" });
    for (const svc of RPC_CONSUMERS) {
      expect(serviceEnv(cfg, svc).DEMO_MODE).toBe("1");
    }
  });

  test("the retired per-property cache knobs are NOT compose passthroughs anymore", () => {
    // FETCH_CACHE_TTL_MS / GECKO_PRICE_CACHE_TTL_MS were replaced by
    // DEMO_MODE-selected constants in the backend. Setting them in the caller
    // env must not reach any container — if a key reappears here, someone
    // re-introduced an env tuning surface the review explicitly removed.
    const cfg = composeConfig({ FETCH_CACHE_TTL_MS: "123", GECKO_PRICE_CACHE_TTL_MS: "456" });
    for (const svc of RPC_CONSUMERS) {
      const env = serviceEnv(cfg, svc);
      expect("FETCH_CACHE_TTL_MS" in env).toBe(false);
      expect("GECKO_PRICE_CACHE_TTL_MS" in env).toBe(false);
    }
  });

  test("demo-main passes -e DEMO_MODE=1 on the migrate/seed one-shot and no retired flag survives", async () => {
    // The migrate/seed `compose run` is where the seed's demo gating executes;
    // this wiring guard proves the flag actually reaches it (deliberate
    // redundancy with the compose pin above) and that the retired
    // DEMO_FAST_SCHEDULES / DEMO_SLOW_SAMPLERS names are fully gone from the
    // demo wiring + seed, so a stale reference can't silently gate anything.
    const demoMain = await Bun.file(join(repoRoot, "scripts/lib/demo-main.ts")).text();
    expect(demoMain).toContain('"-e", "DEMO_MODE=1"');
    const seed = await Bun.file(join(repoRoot, "backend/src/db/seed.ts")).text();
    expect(seed).toContain("process.env.DEMO_MODE");
    for (const retired of ["DEMO_FAST_SCHEDULES", "DEMO_SLOW_SAMPLERS"]) {
      expect(demoMain).not.toContain(retired);
      expect(seed).not.toContain(retired);
    }
  });
});
