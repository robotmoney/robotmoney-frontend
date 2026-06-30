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
  // Comma-separated list of allowed browser origins for the frontend. Only
  // relevant when the frontend is served from a different origin than the API.
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:8080")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
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
  // Analytics data source. Default "seeded" (deterministic, hermetic, no keys).
  // Opt in to REAL keyless live data (DefiLlama/CoinGecko/Yahoo) with PROVIDER=live;
  // per-series failures still fall back to seeded so a run never breaks.
  analyticsProvider: (process.env.PROVIDER === "live" ? "live" : "seeded") as "live" | "seeded",
};

