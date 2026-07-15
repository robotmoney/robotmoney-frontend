// Single source of truth for HTTP endpoint paths shared across the boundary.
// Frontend imports these to build URLs; backend imports them to register routes.
// Pure data — no runtime dependencies.

/**
 * Build a path from a template by substituting :params.
 * @param {string} template
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function path(template, params = {}) {
  return template.replace(/:([a-zA-Z_]+)/g, (/** @type {string} */ _, /** @type {string} */ key) => {
    if (params[key] == null) throw new Error(`missing path param: ${key}`);
    return encodeURIComponent(String(params[key]));
  });
}

export const ROUTES = {
  health: "/health",

  comments: {
    list: "/api/comments", // GET ?page=
    create: "/api/comments", // POST
  },

  dashboards: {
    regimeSnapshots: "/api/dashboards/regime-snapshots", // GET ?range=
    researchSignal: "/api/dashboards/research-signals/:key", // GET
    vaultEconomics: "/api/dashboards/vault-economics", // GET
    walletBalances: "/api/dashboards/wallet-balances", // GET — live prop-wallet valuation (#84)
    buybacks: "/api/dashboards/buybacks", // GET → token buyback history
    tokenMetrics: "/api/dashboards/token-metrics", // GET → ROBOTMONEY price/supply/marketCap + fee split
    walletSleeves: "/api/dashboards/wallet-sleeves", // GET → per-prop-wallet holdings breakdown
    allocation: "/api/dashboards/allocation", // GET → admin/committee-managed strategy+bucket target weights
  },

  projects: {
    list: "/api/projects", // GET → aggregated projects directory
    adminUpdate: "/api/projects/admin/:slug", // POST — admin-managed overview write (#93)
  },

  committee: {
    members: "/api/committee/members", // GET
    member: "/api/committee/members/:id", // GET
    subject: "/api/committee/subjects/:id", // GET
    subjectSnapshots: "/api/committee/subjects/:id/snapshots", // GET
    sessions: "/api/committee/sessions", // GET
    session: "/api/committee/sessions/:date/:subject", // GET
    openSession: "/api/committee/open-session", // GET → session currently collecting, if any
    brief: "/api/committee/brief", // GET ?date=&subject=
    signingPayload: "/api/committee/signing-payload", // POST → canonical bytes a member must sign
    memos: "/api/committee/memos", // POST (member bearer) — publish a long-form memo
    memo: "/api/committee/memos/:id", // GET — public memo read
    verifyToken: "/api/committee/verify-token", // GET (member bearer) → { memberId }
    apply: "/api/committee/apply", // POST — public onboarding (recorded 'applied', inactive key)
    register: "/api/committee/register", // POST (privileged) — apply+activate shortcut for demo/E2E
    regime: "/api/committee/regime", // POST (analytics-provider bearer) — persist the regime
    submit: "/api/committee/submit", // POST (member bearer, ed25519-signed)
    // Admin lifecycle (X-Admin-Token). The backend registers ONE dispatcher at
    // admin.action; the named entries below enumerate the verbs it accepts so
    // drivers can reference them without re-hardcoding the path.
    admin: {
      action: "/api/committee/admin/:action", // POST — generic lifecycle dispatch
      activate: "/api/committee/admin/activate", // POST — flip applied→active, mint bearer token
      reset: "/api/committee/admin/reset", // POST — wipe session data (dev/demo)
      regime: "/api/committee/admin/regime", // POST — recompute the regime composite
      subject: "/api/committee/admin/subject", // POST — ensure a subject row
      subjectFixtures: "/api/committee/admin/subject_fixtures", // POST — seed reference-shaped demo fixtures
      open: "/api/committee/admin/open", // POST — open a session
      brief: "/api/committee/admin/brief", // POST — publish the brief, open the window
      close: "/api/committee/admin/close", // POST — close the submission window
      aggregate: "/api/committee/admin/aggregate", // POST — deterministic rollup
      publish: "/api/committee/admin/publish", // POST — publish the session
      enqueueJob: "/api/committee/admin/enqueue-job", // POST — drive lifecycle via the worker job queue
    },
  },

  // Analytics-provider ingestion boundary (issue #106). Every route requires the
  // ANALYTICS_TOKEN bearer (analytics-provider role); updater processes call
  // these instead of writing SQL. Mutations validate the whole payload before
  // opening a transaction and are idempotent on their natural keys. There is NO
  // generic SQL-over-HTTP endpoint.
  analytics: {
    rawHistory: "/api/analytics/raw-history", // GET → persisted floor; POST — batch upsert on (date, indicator)
    rawHistorySeed: "/api/analytics/raw-history/seed", // POST — cold-DB gap-fill (existing rows win; EDGAR seed ingestion)
    regimeSnapshots: "/api/analytics/regime-snapshots", // POST — snapshot batch upsert on (date)
    researchSignals: "/api/analytics/research-signals", // POST — signal batch upsert on (signal_key, date)
    // POST — flips job_schedules.research.refresh to enabled (issue #108). Called
    // ONLY after the EDGAR/MNA seed bootstrap ingests successfully, so a fresh
    // boot's research schedule never becomes claimable before the floor is seeded.
    researchEligibility: "/api/analytics/research-eligibility",
  },

  admin: {
    auth: "/api/admin/auth", // POST — verify the admin password → { ok: true }
    jobs: "/api/admin/jobs", // GET ?limit= — task-queue jobs + schedules + status summary
    job: "/api/admin/jobs/:id", // GET — one job + its recent runs (the logs)
    runs: "/api/admin/runs", // GET ?kind=&status=&limit= — recent job_runs feed (the logs)
  },
};
