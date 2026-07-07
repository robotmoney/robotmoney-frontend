// Compose-layer test for the demo data path (issue #50). Shells
// `docker compose -f docker-compose.yml -f docker-compose.demo.yml config`
// (offline — pure interpolation, no daemon-side state, no containers) under
// both env sets and asserts the RESOLVED api/worker environment:
//
//   - hermetic opt-in set (DEMO_HERMETIC=1) → BASE_RPC_URL pinned at the
//     in-compose base-rpc-stub endpoint, ANALYTICS_SOURCE=hermetic,
//     BASE_RPC_SOURCE=stub (DTO provenance), ANALYTICS_FLOOR_SEED=0;
//   - otherwise → the live path: all four resolve EMPTY, so backend config.ts
//     falls through to its live production defaults (BASE_RPC_URL
//     https://mainnet.base.org, analytics live).
//
// It also proves the resolver layer (scripts/lib/demo-env.ts) and the compose
// interpolation layer agree when composed, and that an explicit BASE_RPC_URL
// override beats both defaults. Docker is a hard dependency of this repo's
// test harness (the backend suite boots ephemeral Postgres through it); a
// missing docker CLI fails this test loudly — never a silent skip
// (test-coverage policy).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveDemoEnv } from "../demo.ts";

const repoRoot = join(import.meta.dir, "../..");

interface ComposeConfig {
  services: Record<string, { environment?: Record<string, string | null> }>;
}

// Base env for the compose call: inherit the caller's env (PATH/HOME/DOCKER_*)
// but STRIP every data-path knob so each case controls them exactly.
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (["DEMO_HERMETIC", "BASE_RPC_URL", "BASE_RPC_SOURCE", "ANALYTICS_SOURCE", "ANALYTICS_FLOOR_SEED", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"].includes(k)) continue;
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

const RPC_CONSUMERS = ["api", "worker"] as const;

describe("docker compose config — demo data path resolution", () => {
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

  test("hermetic opt-in (DEMO_HERMETIC=1) pins the stub endpoint + hermetic analytics + stub provenance", () => {
    const cfg = composeConfig({ DEMO_HERMETIC: "1" });
    for (const svc of RPC_CONSUMERS) {
      const env = serviceEnv(cfg, svc);
      expect(env.BASE_RPC_URL).toBe("http://base-rpc-stub:8645");
      expect(env.BASE_RPC_URL).not.toContain("mainnet.base.org");
      expect(env.ANALYTICS_SOURCE).toBe("hermetic");
      expect(env.BASE_RPC_SOURCE).toBe("stub");
      expect(env.ANALYTICS_FLOOR_SEED).toBe("0");
    }
  });

  test("explicit BASE_RPC_URL override beats both defaults", () => {
    const cfg = composeConfig({ DEMO_HERMETIC: "1", BASE_RPC_URL: "http://127.0.0.1:9999" });
    for (const svc of RPC_CONSUMERS) {
      expect(serviceEnv(cfg, svc).BASE_RPC_URL).toBe("http://127.0.0.1:9999");
    }
  });

  test("compose layer agrees with the scripts/lib/demo-env.ts resolver layer in both modes", () => {
    // Live: the resolver sets ANALYTICS_SOURCE=live + floor seed 1 and leaves
    // BASE_RPC_URL unset; compose must pass those through untouched.
    const live = composeConfig(resolveDemoEnv({}).composeEnv);
    for (const svc of RPC_CONSUMERS) {
      const env = serviceEnv(live, svc);
      expect(env.BASE_RPC_URL ?? "").toBe(""); // unset → backend live default
      expect(env.ANALYTICS_SOURCE).toBe("live");
      expect(env.BASE_RPC_SOURCE).toBe("live");
      expect(env.ANALYTICS_FLOOR_SEED).toBe("1");
    }
    // Hermetic: resolver + compose must land on the exact same stub pin.
    const hermetic = composeConfig(resolveDemoEnv({ DEMO_HERMETIC: "1" }).composeEnv);
    for (const svc of RPC_CONSUMERS) {
      const env = serviceEnv(hermetic, svc);
      expect(env.BASE_RPC_URL).toBe("http://base-rpc-stub:8645");
      expect(env.ANALYTICS_SOURCE).toBe("hermetic");
      expect(env.BASE_RPC_SOURCE).toBe("stub");
      expect(env.ANALYTICS_FLOOR_SEED).toBe("0");
    }
  });

  test("no assignment in either compose layer can resolve BASE_RPC_URL to live mainnet", () => {
    // Even with every knob unset the resolved value must never BE mainnet —
    // the live default lives in backend config.ts, not in a compose literal
    // (so the hermetic e2e guard can prove zero-live-RPC from env layers).
    const knobSets: Record<string, string>[] = [{}, { DEMO_HERMETIC: "1" }];
    for (const knobs of knobSets) {
      const cfg = composeConfig(knobs);
      for (const svc of RPC_CONSUMERS) {
        expect(serviceEnv(cfg, svc).BASE_RPC_URL ?? "").not.toContain("mainnet.base.org");
      }
    }
  });
});
