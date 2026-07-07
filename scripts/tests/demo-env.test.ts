// Unit tests for the demo data-path env resolver (issue #50). Imported from
// scripts/demo.ts (the `bun run demo` entrypoint) — the entry re-exports the
// resolver and only triggers the side-effectful demo bring-up under
// `import.meta.main`, so this import is safe and proves the tested resolver is
// exactly the one the demo consumes.
//
// Contract under test:
//   - DEFAULT (CI and DEMO_HERMETIC unset) → the LIVE production-parity path:
//     BASE_RPC_URL left unset (backend config.ts falls through to its live
//     default https://mainnet.base.org), ANALYTICS_SOURCE=live,
//     ANALYTICS_FLOOR_SEED=1 (cold-boot floor seed), provenance 'live'.
//   - DEMO_HERMETIC=1 → the explicit hermetic opt-in: stub RPC URL, offline
//     seeded analytics, floor seed off, provenance 'stub'.
//   - CI alone NEVER selects hermetic — the e2e workflow must opt in
//     explicitly (scripts/demo-rpc-guard.ts fails the run loudly otherwise).
//   - Explicit BASE_RPC_URL / ANALYTICS_SOURCE / ANALYTICS_FLOOR_SEED always win.
import { describe, expect, test } from "bun:test";
import { resolveDemoEnv, HERMETIC_STUB_RPC_URL } from "../demo.ts";

describe("resolveDemoEnv — default live path (production parity)", () => {
  test("with CI and DEMO_HERMETIC unset, resolves the live data path", () => {
    const r = resolveDemoEnv({});
    expect(r.hermetic).toBe(false);
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
    // Always present and normalized to "" (never omitted) — see the
    // stray-value normalization test below for why omission is unsafe.
    expect(r.composeEnv.DEMO_HERMETIC).toBe("");
  });

  test("CI=true alone does NOT select hermetic — the opt-in must be explicit", () => {
    const r = resolveDemoEnv({ CI: "true" });
    expect(r.hermetic).toBe(false);
    expect(r.baseRpcUrl).toBeUndefined();
    expect(r.analyticsSource).toBe("live");
    expect(r.baseRpcSource).toBe("live");
  });

  test("empty-string knobs behave as unset (compose interpolation yields empty strings)", () => {
    const r = resolveDemoEnv({ BASE_RPC_URL: "", ANALYTICS_SOURCE: "", ANALYTICS_FLOOR_SEED: "", DEMO_HERMETIC: "" });
    expect(r.hermetic).toBe(false);
    expect(r.baseRpcUrl).toBeUndefined();
    expect(r.analyticsSource).toBe("live");
    expect(r.analyticsFloorSeed).toBe("1");
  });

  test("explicit overrides win on the live path", () => {
    const r = resolveDemoEnv({
      BASE_RPC_URL: "https://base.example.private/rpc",
      ANALYTICS_SOURCE: "hermetic",
      ANALYTICS_FLOOR_SEED: "0",
    });
    expect(r.hermetic).toBe(false);
    expect(r.baseRpcUrl).toBe("https://base.example.private/rpc");
    expect(r.composeEnv.BASE_RPC_URL).toBe("https://base.example.private/rpc");
    expect(r.analyticsSource).toBe("hermetic");
    expect(r.analyticsFloorSeed).toBe("0");
    // Provenance tracks the hermetic knob, not the URL override: a private
    // live RPC is still 'live'.
    expect(r.baseRpcSource).toBe("live");
  });
});

describe("resolveDemoEnv — explicit hermetic opt-in (DEMO_HERMETIC=1)", () => {
  test("pins the in-compose RPC stub, offline analytics, no floor seed, 'stub' provenance", () => {
    const r = resolveDemoEnv({ DEMO_HERMETIC: "1" });
    expect(r.hermetic).toBe(true);
    expect(r.baseRpcUrl).toBe(HERMETIC_STUB_RPC_URL);
    expect(r.composeEnv.BASE_RPC_URL).toBe("http://base-rpc-stub:8645");
    expect(r.baseRpcSource).toBe("stub");
    expect(r.composeEnv.BASE_RPC_SOURCE).toBe("stub");
    expect(r.analyticsSource).toBe("hermetic");
    expect(r.composeEnv.ANALYTICS_SOURCE).toBe("hermetic");
    expect(r.analyticsFloorSeed).toBe("0");
    expect(r.composeEnv.ANALYTICS_FLOOR_SEED).toBe("0");
    // Propagated so docker-compose.demo.yml's own ${DEMO_HERMETIC:+…}
    // interpolation defaults agree with the resolver layer.
    expect(r.composeEnv.DEMO_HERMETIC).toBe("1");
  });

  test("the stub URL never resolves to live Base mainnet", () => {
    const r = resolveDemoEnv({ DEMO_HERMETIC: "1", CI: "true" });
    expect(r.baseRpcUrl).not.toContain("mainnet.base.org");
    for (const v of Object.values(r.composeEnv)) expect(v).not.toContain("mainnet.base.org");
  });

  test("only the exact value '1' opts in", () => {
    for (const v of ["0", "false", "yes", "true"]) {
      expect(resolveDemoEnv({ DEMO_HERMETIC: v }).hermetic).toBe(false);
    }
    expect(resolveDemoEnv({ DEMO_HERMETIC: "1" }).hermetic).toBe(true);
  });

  test("an explicit BASE_RPC_URL override still wins under hermetic (guard catches a mainnet leak)", () => {
    const r = resolveDemoEnv({ DEMO_HERMETIC: "1", BASE_RPC_URL: "http://127.0.0.1:9999" });
    expect(r.baseRpcUrl).toBe("http://127.0.0.1:9999");
    expect(r.baseRpcSource).toBe("stub");
  });
});

describe("resolveDemoEnv — composeEnv.DEMO_HERMETIC is always normalized (never a stray ambient value)", () => {
  // scripts/lib/demo-main.ts merges as `{...process.env, ...resolveDemoEnv(process.env).composeEnv}`.
  // If composeEnv ever OMITTED the key on the live path (rather than
  // explicitly emitting ""), a stray non-"1" ambient DEMO_HERMETIC (e.g. an
  // operator typo `DEMO_HERMETIC=true`, believing any truthy string opts in)
  // would survive that merge unnormalized and reach docker-compose.demo.yml's
  // OWN `${DEMO_HERMETIC:+...}` interpolation — which treats ANY non-empty
  // string as "set" — independently re-pinning BASE_RPC_URL at the stub while
  // this resolver reports hermetic:false / source:'live' / ANALYTICS_SOURCE
  // 'live'. That split-brain would mislabel stub-served vault-economics data
  // as live chain data AND fire real live analytics calls the operator
  // believed were disabled. composeEnv must always carry an explicit,
  // normalized value so it wins the merge regardless of what is ambient.
  test("a stray truthy-but-not-'1' DEMO_HERMETIC resolves to hermetic:false AND is normalized to '' in composeEnv", () => {
    for (const stray of ["true", "TRUE", "yes", "0", "hermetic"]) {
      const r = resolveDemoEnv({ DEMO_HERMETIC: stray });
      expect(r.hermetic).toBe(false);
      expect(r.composeEnv.DEMO_HERMETIC).toBe("");
      expect(r.baseRpcSource).toBe("live");
      expect(r.analyticsSource).toBe("live");
    }
  });

  test("composeEnv.DEMO_HERMETIC is always present: '' on the live path, '1' under the opt-in", () => {
    expect(resolveDemoEnv({}).composeEnv.DEMO_HERMETIC).toBe("");
    expect(resolveDemoEnv({ DEMO_HERMETIC: "1" }).composeEnv.DEMO_HERMETIC).toBe("1");
  });
});
