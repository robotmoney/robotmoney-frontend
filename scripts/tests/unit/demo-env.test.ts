// Unit tests for the demo data-path env resolver (issue #50; issue #147
// removed DEMO_HERMETIC and the hermetic opt-in entirely — the resolver now
// always resolves the LIVE path). Imported from scripts/demo.ts (the
// `bun run demo` entrypoint) — the entry re-exports the resolver and only
// triggers the side-effectful demo bring-up under `import.meta.main`, so this
// import is safe and proves the tested resolver is exactly the one the demo
// consumes.
//
// Contract under test:
//   - ALWAYS the LIVE production-parity path: BASE_RPC_URL left unset (backend
//     config.ts falls through to its live default https://mainnet.base.org),
//     ANALYTICS_SOURCE=live, ANALYTICS_FLOOR_SEED=1 (cold-boot floor seed),
//     provenance 'live' — in every env, including CI.
//   - Explicit BASE_RPC_URL / ANALYTICS_SOURCE / ANALYTICS_FLOOR_SEED overrides
//     always win.
import { describe, expect, test } from "bun:test";
import { resolveDemoEnv } from "../../demo.ts";
import { NORMAL_DEMO_CACHE_TTL_MS } from "../../lib/demo-env.ts";

describe("resolveDemoEnv — always the live path (production parity)", () => {
  test("with no env set, resolves the live data path", () => {
    const r = resolveDemoEnv({});
    // BASE_RPC_URL stays UNSET so backend config.ts falls through to its live
    // default (https://mainnet.base.org) — the resolver never pins a stub.
    expect(r.baseRpcUrl).toBeUndefined();
    expect("BASE_RPC_URL" in r.composeEnv).toBe(false);
    expect(r.baseRpcSource).toBe("live");
    expect(r.analyticsSource).toBe("live");
    expect(r.analyticsFloorSeed).toBe("1");
    expect(r.composeEnv.BASE_RPC_SOURCE).toBe("live");
    expect(r.composeEnv.ANALYTICS_SOURCE).toBe("live");
    expect(r.composeEnv.ANALYTICS_FLOOR_SEED).toBe("1");
    expect(r.composeEnv.HTTP_FETCH_CACHE_TTL_MS).toBe(String(NORMAL_DEMO_CACHE_TTL_MS));
    expect(r.composeEnv.TOKEN_PRICE_CACHE_TTL_MS).toBe(String(NORMAL_DEMO_CACHE_TTL_MS));
  });

  test("CI=true resolves the exact same live path — there is no hermetic mode to opt into", () => {
    const r = resolveDemoEnv({ CI: "true" });
    expect(r.baseRpcUrl).toBeUndefined();
    expect(r.analyticsSource).toBe("live");
    expect(r.baseRpcSource).toBe("live");
  });

  test("both scenarios share the same capability-specific demo cache policy", () => {
    const r = resolveDemoEnv({});
    expect(r.composeEnv.HTTP_FETCH_CACHE_TTL_MS).toBe(String(NORMAL_DEMO_CACHE_TTL_MS));
    expect(r.composeEnv.TOKEN_PRICE_CACHE_TTL_MS).toBe(String(NORMAL_DEMO_CACHE_TTL_MS));
  });

  test("empty-string knobs behave as unset (compose interpolation yields empty strings)", () => {
    const r = resolveDemoEnv({ BASE_RPC_URL: "", ANALYTICS_SOURCE: "", ANALYTICS_FLOOR_SEED: "" });
    expect(r.baseRpcUrl).toBeUndefined();
    expect(r.analyticsSource).toBe("live");
    expect(r.analyticsFloorSeed).toBe("1");
  });

  test("explicit overrides win", () => {
    const r = resolveDemoEnv({
      BASE_RPC_URL: "https://base.example.private/rpc",
      // ANALYTICS_SOURCE=hermetic is still a VALID backend value (the
      // deterministic offline fixture backend unit tests depend on directly,
      // backend/src/analytics/access/hermetic-source.ts) — an operator can
      // still opt into it explicitly for local debugging, but no demo default
      // ever selects it, and the DTO provenance stays 'live' regardless.
      ANALYTICS_SOURCE: "hermetic",
      ANALYTICS_FLOOR_SEED: "0",
    });
    expect(r.baseRpcUrl).toBe("https://base.example.private/rpc");
    expect(r.composeEnv.BASE_RPC_URL).toBe("https://base.example.private/rpc");
    expect(r.analyticsSource).toBe("hermetic");
    expect(r.analyticsFloorSeed).toBe("0");
    // Provenance is always 'live' now — there is no stub source in the demo
    // resolver anymore.
    expect(r.baseRpcSource).toBe("live");
  });

  test("the resolved values never point at a stub host", () => {
    const r = resolveDemoEnv({ CI: "true" });
    expect(r.composeEnv.BASE_RPC_SOURCE).not.toBe("stub");
    for (const v of Object.values(r.composeEnv)) expect(v).not.toContain("base-rpc-stub");
  });
});
