// Demo data-path resolver. Single source of truth for which data path a
// `bun run demo` stack — and the required per-PR e2e gate — runs on: ALWAYS
// the production-parity LIVE path.
//
// Issue #147 removed DEMO_HERMETIC and the stubbed/offline demo path entirely
// (decision: issue #163). There is no hermetic opt-in anymore: every
// `bun run demo` invocation, local or CI, resolves live external providers
// (Base mainnet RPC, FRED/Coin Metrics/GeckoTerminal/Yahoo/EDGAR). A required
// credential or provider that is unavailable must fail loudly (non-zero exit,
// actionable message) — never silently fall back to a fixture or stub.
//
//   BASE_RPC_URL is left unset so the backend's config.ts falls through to its
//   live default (https://mainnet.base.org); ANALYTICS_SOURCE=live; and
//   ANALYTICS_FLOOR_SEED=1 so a cold live boot seeds the vendored raw-indicator
//   floor instead of re-fetching years of history.
//
// Explicit BASE_RPC_URL / ANALYTICS_SOURCE / ANALYTICS_FLOOR_SEED env
// overrides always win (e.g. pointing at a private RPC, or setting
// ANALYTICS_SOURCE=hermetic to reuse the deterministic offline analytics
// fixture backend unit tests depend on directly —
// backend/src/analytics/access/hermetic-source.ts — for local debugging).
// That fixture is NOT selected by any demo default; ANALYTICS_SOURCE is a
// general backend config knob unrelated to the removed DEMO_HERMETIC wiring.
//
// This module is imported by scripts/demo.ts (which re-exports it for the
// unit tests in scripts/tests/demo-env.test.ts) and MUST stay side-effect free.

export interface DemoEnvResolution {
  /**
   * Resolved BASE_RPC_URL for the api/worker containers. `undefined` means
   * "leave unset" → backend config.ts falls through to its live production
   * default (https://mainnet.base.org).
   */
  baseRpcUrl: string | undefined;
  /** Vault-economics DTO provenance the backend will report — always 'live'. */
  baseRpcSource: "live";
  /** Resolved ANALYTICS_SOURCE for the api/worker containers. */
  analyticsSource: string;
  /** Resolved ANALYTICS_FLOOR_SEED for the api/worker containers. */
  analyticsFloorSeed: string;
  /**
   * The exact env entries `scripts/demo.ts` merges into every `docker compose`
   * invocation. BASE_RPC_URL is intentionally ABSENT unless overridden (so the
   * compose default and backend config default both apply).
   */
  composeEnv: Record<string, string>;
}

export function resolveDemoEnv(
  env: Record<string, string | undefined> = process.env,
): DemoEnvResolution {
  const baseRpcUrl = env.BASE_RPC_URL || undefined;
  const baseRpcSource: "live" = "live";
  const analyticsSource = env.ANALYTICS_SOURCE || "live";
  // Cold-DB floor seed: on by default so a cold live boot doesn't re-fetch
  // years of history (idempotent; no-op once warm).
  const analyticsFloorSeed = env.ANALYTICS_FLOOR_SEED || "1";

  const composeEnv: Record<string, string> = {
    ...(baseRpcUrl !== undefined ? { BASE_RPC_URL: baseRpcUrl } : {}),
    BASE_RPC_SOURCE: baseRpcSource,
    ANALYTICS_SOURCE: analyticsSource,
    ANALYTICS_FLOOR_SEED: analyticsFloorSeed,
  };

  return { baseRpcUrl, baseRpcSource, analyticsSource, analyticsFloorSeed, composeEnv };
}
