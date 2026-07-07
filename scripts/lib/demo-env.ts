// Demo data-path resolver (issue #50). Single source of truth for which data
// path a `bun run demo` stack runs on:
//
//   DEFAULT (no env)      → PRODUCTION PARITY. BASE_RPC_URL is left unset so the
//                           backend's config.ts falls through to its live default
//                           (https://mainnet.base.org), ANALYTICS_SOURCE=live, and
//                           ANALYTICS_FLOOR_SEED=1 so a cold live boot seeds the
//                           vendored raw-indicator floor instead of re-fetching
//                           years of history.
//   DEMO_HERMETIC=1       → EXPLICIT hermetic opt-in (set by the required e2e CI
//                           workflow, .github/workflows/e2e.yml, and available
//                           locally as `DEMO_HERMETIC=1 bun run demo`). Pins the
//                           vault-economics eth_call reads at the in-compose
//                           deterministic stub (base-rpc-stub service,
//                           backend/tests/support/base-rpc-stub.ts), the analytics
//                           at the offline seeded source, marks the RPC provenance
//                           as `stub` (BASE_RPC_SOURCE → the vault-economics DTO's
//                           source:'stub'), and disables the floor seed. Zero live
//                           mainnet / live analytics calls — enforced post-run by
//                           scripts/demo-rpc-guard.ts.
//
// Explicit BASE_RPC_URL / ANALYTICS_SOURCE / ANALYTICS_FLOOR_SEED env overrides
// always win over both defaults. docker-compose.demo.yml mirrors the same
// DEMO_HERMETIC conditional in its interpolation defaults so BOTH layers agree
// even when compose is invoked without this resolver (see the compose-config
// test, scripts/tests/demo-compose-config.test.ts).
//
// This module is imported by scripts/demo.ts (which re-exports it for the unit
// tests in scripts/tests/demo-env.test.ts) and MUST stay side-effect free.

export const HERMETIC_STUB_RPC_URL = "http://base-rpc-stub:8645";

export interface DemoEnvResolution {
  /** True iff the explicit hermetic opt-in knob (DEMO_HERMETIC=1) is set. */
  hermetic: boolean;
  /**
   * Resolved BASE_RPC_URL for the api/worker containers. `undefined` means
   * "leave unset" → backend config.ts falls through to its live production
   * default (https://mainnet.base.org).
   */
  baseRpcUrl: string | undefined;
  /** Vault-economics DTO provenance the backend will report. */
  baseRpcSource: "live" | "stub";
  /** Resolved ANALYTICS_SOURCE for the api/worker containers. */
  analyticsSource: string;
  /** Resolved ANALYTICS_FLOOR_SEED for the api/worker containers. */
  analyticsFloorSeed: string;
  /**
   * The exact env entries `scripts/demo.ts` merges into every `docker compose`
   * invocation. BASE_RPC_URL is intentionally ABSENT on the live path (so the
   * compose default and backend config default both apply).
   */
  composeEnv: Record<string, string>;
}

export function resolveDemoEnv(
  env: Record<string, string | undefined> = process.env,
): DemoEnvResolution {
  // Explicit opt-in ONLY. CI does NOT imply hermetic: the e2e workflow must set
  // DEMO_HERMETIC=1 itself, and scripts/demo-rpc-guard.ts fails the CI run
  // loudly when the hermetic layer is missing — a new CI demo consumer can
  // never silently reach live mainnet.
  const hermetic = env.DEMO_HERMETIC === "1";

  const baseRpcUrl = env.BASE_RPC_URL || (hermetic ? HERMETIC_STUB_RPC_URL : undefined);
  const baseRpcSource: "live" | "stub" = hermetic ? "stub" : "live";
  const analyticsSource = env.ANALYTICS_SOURCE || (hermetic ? "hermetic" : "live");
  // Cold-DB floor seed: on by default for the LIVE local demo cold-boot path
  // (idempotent; no-op once warm); pinned off under hermetic so the offline
  // seeded run stays byte-for-byte deterministic.
  const analyticsFloorSeed = env.ANALYTICS_FLOOR_SEED || (hermetic ? "0" : "1");

  const composeEnv: Record<string, string> = {
    ...(baseRpcUrl !== undefined ? { BASE_RPC_URL: baseRpcUrl } : {}),
    BASE_RPC_SOURCE: baseRpcSource,
    ANALYTICS_SOURCE: analyticsSource,
    ANALYTICS_FLOOR_SEED: analyticsFloorSeed,
    ...(hermetic ? { DEMO_HERMETIC: "1" } : {}),
  };

  return { hermetic, baseRpcUrl, baseRpcSource, analyticsSource, analyticsFloorSeed, composeEnv };
}
