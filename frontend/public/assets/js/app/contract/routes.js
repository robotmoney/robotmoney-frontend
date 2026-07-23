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
    memberTakes: "/api/committee/members/:id/takes", // GET ?limit= — this member's takes across sessions (issue #243), newest first, in-progress included
    subject: "/api/committee/subjects/:id", // GET
    subjectSnapshots: "/api/committee/subjects/:id/snapshots", // GET
    // GET ?state=&limit=&cursor= — light index rows (no regimeSummary/synthesis/
    // subjectSnapshotTotalValueUsd) + an opaque nextCursor (null when exhausted).
    // ?full=1 reproduces the pre-#243 unpaginated/unprojected response for
    // callers (e.g. the admin sessions views) that still need every field.
    sessions: "/api/committee/sessions",
    session: "/api/committee/sessions/:date/:subject", // GET
    take: "/api/committee/takes/:id", // GET — public read-time-verified receipt
    takePermalink: "/committee/takes/:id", // rendered public verification receipt
    openSession: "/api/committee/open-session", // GET → session currently collecting, if any
    brief: "/api/committee/brief", // GET ?date=&subject=
    signingPayload: "/api/committee/signing-payload", // POST → canonical bytes a member must sign
    memos: "/api/committee/memos", // POST (member bearer) — publish a long-form memo
    memo: "/api/committee/memos/:id", // GET — public memo read
    verifyToken: "/api/committee/verify-token", // GET (member bearer) → { memberId }
    apply: "/api/committee/apply", // POST — public onboarding (recorded 'applied', inactive key)
    claimChallenge: "/api/committee/token-claim/challenge", // POST — opaque 10-minute key-proof challenge
    claimToken: "/api/committee/token-claim", // POST — first valid key proof returns the sole bearer token
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

      // Admin surface (issue #152): topics/members/roster/lifecycle/audit.
      // Distinct sub-resource paths (never a single-segment :action) so they
      // never collide with the generic dispatcher above.
      subjects: "/api/committee/admin/subjects", // GET list (all statuses) / POST create
      subjectUpdate: "/api/committee/admin/subjects/:id/update", // POST — versioned edit (409 stale_version)
      subjectDeactivate: "/api/committee/admin/subjects/:id/deactivate", // POST — versioned deactivate

      members: "/api/committee/admin/members", // GET list (all statuses, redacted) / POST manual add
      applications: "/api/committee/admin/applications", // GET ?status= — application review queue
      memberReview: "/api/committee/admin/members/:id/review", // POST { decision: approve|reject }
      memberDeactivate: "/api/committee/admin/members/:id/deactivate", // POST — versioned
      memberReactivate: "/api/committee/admin/members/:id/reactivate", // POST — versioned, mints a fresh credential
      memberRotateKey: "/api/committee/admin/members/:id/rotate-key", // POST — one-time credential in the response only

      sessionCreate: "/api/committee/admin/sessions", // POST — UTC-validated, snapshots the roster, enqueues 4 scoped jobs
      sessionRoster: "/api/committee/admin/sessions/:id/roster", // GET — the frozen expected roster
      rosterAdd: "/api/committee/admin/sessions/:id/roster/add", // POST { memberId } — before collecting only
      rosterExcuse: "/api/committee/admin/sessions/:id/roster/excuse", // POST { memberId } — before collecting only
      rosterRestore: "/api/committee/admin/sessions/:id/roster/restore", // POST { memberId } — before collecting only
      sessionCancel: "/api/committee/admin/sessions/:id/cancel", // POST — versioned guarded transition
      sessionClose: "/api/committee/admin/sessions/:id/close", // POST — versioned guarded transition
      sessionReopen: "/api/committee/admin/sessions/:id/reopen", // POST — versioned guarded transition
      sessionAggregate: "/api/committee/admin/sessions/:id/aggregate", // POST — versioned guarded transition
      sessionPublish: "/api/committee/admin/sessions/:id/publish", // POST — versioned guarded transition

      audit: "/api/committee/admin/audit", // GET ?actor=&action=&since=&until=&limit= — redacted audit trail

      // Agent health (issue #208, scout #214): missed-window absences and
      // rejected submission signatures, otherwise visible only in an agent's
      // own stdout. Raw event history + per-type counts; no automatic
      // dead-agent threshold.
      agentHealth: "/api/committee/admin/agent-health", // GET ?sessionId=&memberId=&eventType=&limit=
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
    // POST — submit one run's structured telemetry (stages/warnings/artifacts/
    // outcome; issue #151). Non-fatal to callers: a failed submission never
    // blocks the canonical analytics writes above.
    telemetry: "/api/analytics/telemetry",
  },

  admin: {
    auth: "/api/admin/auth", // POST — verify the admin password → { ok: true }
    // GET — health cards + alert feed (queue counts, last success/failure by
    // kind, stale research signals, next enabled schedules). See
    // docs/architecture.md US-A2. Route shape fixed here so the #157
    // frontend and the #155 backend converge on the same path on rebase.
    overview: "/api/admin/overview",
    jobs: "/api/admin/jobs", // GET ?limit=&cursor=&kind=&status=&scopeType=&scopeId=&createdFrom=&createdTo= — task-queue jobs + schedules + status summary
    job: "/api/admin/jobs/:id", // GET — one job + its recent runs (the logs)
    jobRetry: "/api/admin/jobs/:id/retry", // POST — clone a dead job into a new pending job (US-Q1)
    runs: "/api/admin/runs", // GET ?kind=&status=&limit=&cursor= — recent job_runs feed (the logs)
    schedule: "/api/admin/schedules/:id", // PATCH — toggle enabled on an analytics job_schedules row (issue #155)
    audit: "/api/admin/audit", // GET ?actor=&action=&targetType=&targetId=&from=&to=&limit=&cursor= — redacted, filtered audit_log feed (issue #155)
    // Research pipeline telemetry admin surface (issue #151, consumed by the
    // #157 operator UI per docs/architecture.md US-R1..US-R4).
    // X-Admin-Token. Shape fixed by the #151 backend; frontend converges here.
    researchRuns: "/api/admin/research/runs", // GET ?kind=&status=&limit= — run list
    researchRun: "/api/admin/research/runs/:id", // GET — run detail: stage timeline, warnings, artifacts, freshness
    researchRawSeries: "/api/admin/research/raw-series/:indicator", // GET ?from=&to=&limit= — allowlisted raw_indicator_history read
    researchSignal: "/api/admin/research/signals/:key", // GET ?from=&to=&limit= — allowlisted research_signals read
    researchRerun: "/api/admin/research/rerun", // POST — enqueue a complete or single-tool rerun for a given as-of date
  },

  // Committee operations surface (issue #159 UI over issue #152/PR #169's
  // already-shipped backend; docs/architecture.md §6.3 and §7.1). This
  // is the SAME table `committee.admin.*` above (backend/src/api/routes/
  // committee-admin.ts) — there is deliberately no second `admin.committee.*`
  // route table for this feature, so the frontend and backend can never drift
  // onto two different URL prefixes again (see PR #172 review). Consumers:
  // frontend/public/assets/js/app/alpine/views/admin/committee-*.js.
};
