// Central environment configuration. The only required input is DATABASE_URL.
// RM_ENV selects behavior hints (ephemeral | demo | prod) but the connection
// itself is always driven by DATABASE_URL so the same code runs everywhere.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

// Fail-closed: default to "prod" when RM_ENV is unset, and REFUSE to start on an
// unrecognized value (so a typo like "production" can never silently open the
// privileged surface). The unauthenticated convenience path is opt-in: it is
// allowed only in the "ephemeral" (CI/throwaway) env or with RM_ALLOW_INSECURE=1.
const VALID_ENVS = ["ephemeral", "demo", "prod"] as const;
const RM_ENV = process.env.RM_ENV ?? "prod";
if (!(VALID_ENVS as readonly string[]).includes(RM_ENV)) {
  throw new Error(`invalid RM_ENV "${RM_ENV}" — expected one of ${VALID_ENVS.join(" | ")}`);
}

export const config = {
  env: RM_ENV as (typeof VALID_ENVS)[number],
  // Privileged endpoints (onboarding/admin/analytics) may run WITHOUT a token
  // only when this is true; otherwise the relevant token is required in every env.
  allowInsecure: process.env.RM_ALLOW_INSECURE === "1" || RM_ENV === "ephemeral",
  // Trust X-Forwarded-For for client-ip (rate limiting) only behind a known proxy.
  trustProxy: process.env.TRUST_PROXY === "1",
  databaseUrl: required("DATABASE_URL"),
  apiPort: Number(process.env.API_PORT ?? 8787),
  // If set, the API process also serves this static directory (the built
  // frontend) — a single-box deployment with no reverse proxy.
  staticDir: process.env.STATIC_DIR || null,
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  // Shared secret guarding privileged endpoints (member onboarding + admin
  // lifecycle). If set, callers must present it as `X-Admin-Token`. If unset,
  // those endpoints are allowed only outside prod (demo/ephemeral convenience).
  adminToken: process.env.ADMIN_TOKEN || null,
  // Credential for the analytics-provider role. Only this role may write the
  // regime via POST /api/committee/regime. Presented as a Bearer token. If set,
  // it is required (every env); if unset, the role is allowed only outside prod
  // (demo/ephemeral convenience), mirroring adminToken.
  analyticsToken: process.env.ANALYTICS_TOKEN || null,
  // DEPRECATED for orchestrator source selection — kept only for the retired
  // FetcherProvider test scaffolding (access/fetcher-provider.ts, tests/providers.test.ts).
  // The production/demo analytics pipeline (analytics/index.ts runAnalytics) selects its
  // data source SOLELY via `ANALYTICS_SOURCE` (unset|live → real fetchers, hermetic →
  // seeded/offline) — see analytics/index.ts::resolveAnalyticsSource. `PROVIDER` no
  // longer influences the live/demo data path; do NOT use it to opt a demo into real data.
  analyticsProvider: (process.env.PROVIDER === "live" ? "live" : "seeded") as "live" | "seeded",
  // --- Vault economics (live Base RPC read, issue #40) ---------------------
  // Base mainnet (chainId 8453) JSON-RPC endpoint used for the read-only
  // eth_call vault-economics pipeline (backend/src/chain). No API key required
  // for the public default; override for a private/rate-limited provider.
  baseRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  vault: {
    // RobotMoneyVault on Base, documented publicly at
    // frontend/public/views/docs/skill/installation.html and skill.html.
    address: process.env.VAULT_ADDRESS || "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd",
    // USDC on Base, same doc pages.
    usdc: process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // Decision (issue #40): adapter set comes from config, NOT on-chain
    // discovery. The vault's three real adapter contract addresses are not
    // published anywhere in this repo yet, so the defaults below are
    // deliberately NON-FUNCTIONAL placeholders — override with the real
    // deployed addresses via env once known. IMPORTANT: these must be
    // addresses with NO contract code (an `eth_call` to them then decodes a
    // clean empty `0x` result as 0n). Do NOT use low addresses like
    // 0x0…01/02/03 — on Base (and most EVM chains) those alias the
    // ecrecover/sha256/ripemd160 precompiles, which return real (garbage,
    // for this use) output instead of erroring, silently producing an
    // absurd fabricated-looking balance. The repeating-digit addresses below
    // are verified empty accounts on Base mainnet. A placeholder/wrong
    // address makes its balance read as 0 — the chain client
    // (chain/vault-economics.ts) still reports `stale: false` (the RPC itself
    // is healthy), so this is a config gap to close before adapters are
    // meaningful, not a fabricated number.
    adapters: [
      { name: "Morpho", address: process.env.ADAPTER_MORPHO_ADDRESS || "0x1111111111111111111111111111111111111111" },
      { name: "Aave", address: process.env.ADAPTER_AAVE_ADDRESS || "0x2222222222222222222222222222222222222222" },
      { name: "Compound", address: process.env.ADAPTER_COMPOUND_ADDRESS || "0x3333333333333333333333333333333333333333" },
    ],
  },
};

