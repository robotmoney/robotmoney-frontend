// Central environment configuration. The only required input is DATABASE_URL.
// RM_ENV selects behavior hints (ephemeral | demo | prod) but the connection
// itself is always driven by DATABASE_URL so the same code runs everywhere.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export const config = {
  env: (process.env.RM_ENV ?? "demo") as "ephemeral" | "demo" | "prod",
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
  // Analytics data source. Default "seeded" (deterministic, hermetic, no keys).
  // Opt in to REAL keyless live data (DefiLlama/CoinGecko/Yahoo) with PROVIDER=live;
  // per-series failures still fall back to seeded so a run never breaks.
  analyticsProvider: (process.env.PROVIDER === "live" ? "live" : "seeded") as "live" | "seeded",
};

