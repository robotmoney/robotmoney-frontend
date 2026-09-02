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
    allocation: "/api/dashboards/allocation", // GET → admin/swarm-managed strategy+bucket target weights
    // Issue #384 (/list "Total Market"): unified agent/coin/vault/wallet table
    // feed + the TotalMarketOverview summary (counts, vault TVL, leaders, RM
    // token). Namespaced under dashboards (public, unauthenticated reads) —
    // NOT analytics.* below, which is the analytics-provider bearer-gated
    // ingestion boundary and would be the wrong home for a public GET.
    entities: "/api/dashboards/entities", // GET → unified /list table rows
    overview: "/api/dashboards/overview", // GET → TotalMarketOverview summary
    // Issue #387 (/list2, /list3): public, unauthenticated reads over the
    // same facet tables /list (#384) and /projects (#70) already read.
    // Namespaced under dashboards, NOT analytics.* below (the
    // analytics-provider bearer-gated ingestion boundary — the wrong home
    // for a public GET).
    list2: "/api/dashboards/list2", // GET → List v2 per-facet-tab table feed
    leaderboard: "/api/dashboards/leaderboard", // GET → List v3 money-agent leaderboard + evidence
    // Issue #393 (/submit, docs/bot-analytics-ui-port-plan.md §5.17): public
    // agent-onboarding/community-commit intake. Same public-GET-adjacent
    // dashboards namespace as entities/overview above (not analytics.* —
    // that boundary is the bearer-gated PRODUCER ingestion surface; this is
    // an anonymous public submission, moderated later from /admin).
    submissions: "/api/dashboards/submissions", // POST → create a pending submission
    // Issue #392 (/market + /dashboard TerminalFeed): real-time feed of agent
    // actions, governance votes, and market events. Same public-read
    // reasoning as entities/overview above — never analytics.* (bearer-gated
    // ingestion). Backed by agent_activity_log (migration 0023); returns
    // `{ entries: [] }` honestly until a pipeline writer lands (P1.6).
    activity: "/api/dashboards/activity", // GET → agent activity log feed
    // Issue #385 (/agents "OpenClaw Agents"): tracked-agent directory feed.
    // Namespaced under dashboards (public, unauthenticated reads) — NOT
    // analytics.* below, which is the analytics-provider bearer-gated
    // ingestion boundary and would be the wrong home for a public GET.
    agents: "/api/dashboards/agents", // GET → tracked-agent directory rows + summary
    // Issue #390 (/agents/:id "Money-agent dossier" AgentProfile, P3.2): one
    // agent's full dossier (trust breakdown, managing vaults, tracked
    // wallets). Same public-dashboards-namespace reasoning as agents above.
    agentDetail: "/api/dashboards/agents/:id", // GET → AgentDetail, 404 when the id doesn't exist
    // Analytics-dashboard directory list feeds (issue #386, docs/bot-
    // analytics-ui-port-plan.md §5.9/§5.11/§5.13). A distinct feature area
    // from the treasury-dashboard entries above, sharing only this route
    // namespace — NOT `analytics.*` below (the bearer-gated analytics-
    // PROVIDER ingestion boundary, issue #106; precedent set by #384/#385).
    coins: "/api/dashboards/coins", // GET → lobster-coin directory (/lobster)
    vaults: "/api/dashboards/vaults", // GET → agent-managed vault directory (/vaults)
    wallets: "/api/dashboards/wallets", // GET → tracked + agent-derived wallet directory (/wallets)
    // Issue #391 (/lobster/:id, /vaults/:id, /wallets/:id detail dossiers):
    // same public, unauthenticated dashboards.* namespace as the LIST feeds
    // directly above (issue #386) — a distinct :id sub-path per facet, never
    // colliding with the exact-match LIST route.
    coinDetail: "/api/dashboards/coins/:id", // GET → CoinProfile dossier
    vaultDetail: "/api/dashboards/vaults/:id", // GET → VaultProfile dossier
    walletDetail: "/api/dashboards/wallets/:id", // GET → WalletProfile dossier
  },

  projects: {
    list: "/api/projects", // GET → aggregated projects directory
    // Issue #389 (§5.5, P3.1): ProjectProfile "dossier" — hero, KPI strip,
    // full facet tables, 90d raw-daily history, ratio tiles, activity feed
    // for ONE project. Same public/unauthenticated `projects` namespace as
    // `list` above (not `dashboards.*` or `analytics.*` — this is the
    // existing #70/#93 route family, not a new dashboard surface).
    detail: "/api/projects/:slug", // GET → one project's full profile DTO
    adminUpdate: "/api/projects/admin/:slug", // POST — admin-managed overview write (#93)
  },

  swarm: {
    members: "/api/swarm/members", // GET
    waitlist: "/api/swarm/waitlist", // POST — capture interest when roster is full
    member: "/api/swarm/members/:id", // GET
    memberTakes: "/api/swarm/members/:id/takes", // GET ?limit= — this member's takes across sessions (issue #243), newest first, in-progress included
    // POST (member bearer) — issue #325: the apply payload is deliberately
    // minimal ({name, contact, lens?, publicKey}, D21), so this is the ONLY
    // path by which an admitted member ever acquires tagline/mandate/biases/
    // voiceMd/mode/operator/avatar. Partial write: only the fields present in
    // the body are changed. The path :id must match the bearer token's own
    // member id — this can never write another member's profile.
    memberProfile: "/api/swarm/members/:id/profile",
    // GET, public, no auth — serves the bytes issue #626's admin upload
    // stores in swarm_member_avatars (migration 0035). Distinct from
    // admin.memberAvatar below, which is the privileged POST that writes them.
    memberAvatar: "/api/swarm/members/:id/avatar",
    subject: "/api/swarm/subjects/:id", // GET
    subjectSnapshots: "/api/swarm/subjects/:id/snapshots", // GET
    // GET ?state=&limit=&cursor= — light index rows (no regimeSummary/synthesis/
    // subjectSnapshotTotalValueUsd) + an opaque nextCursor (null when exhausted).
    // ?full=1 reproduces the pre-#243 unpaginated/unprojected response for
    // callers (e.g. the admin sessions views) that still need every field.
    sessions: "/api/swarm/sessions",
    session: "/api/swarm/sessions/:date/:subject", // GET — the LATEST session that day for that subject
    // GET one session by its own id. Since migration 0022 a subject may convene
    // more than once a day, so (date, subject) addresses "the latest one that
    // day" and cannot reach the earlier ones; this is the unambiguous handle.
    // One path segment, so it can never be confused with the two-segment
    // date/subject form above.
    sessionById: "/api/swarm/sessions/:id",
    // The Project Fusion CONSENSUS receipt for one session (issue #754): the
    // signed aggregate, as opposed to `take` below which is one member's signed
    // take. A STABLE BACKEND PATH, deliberately not content-addressed — the
    // anchored digest already addresses the bytes, and a reader holding only a
    // session id must be able to reach the receipt without first knowing its
    // digest. The path is derived from the session id alone, so it survives
    // every redeploy and every rebuild of the frontend.
    sessionConsensusReceipt: "/api/swarm/sessions/:id/consensus-receipt", // GET — public, read-time-verified
    take: "/api/swarm/takes/:id", // GET — public read-time-verified receipt
    takePermalink: "/swarm/takes/:id", // rendered public verification receipt
    openSession: "/api/swarm/open-session", // GET → session currently collecting, if any
    // GET the brief a session published. `?session=<sessionId>` is the
    // unambiguous handle — since migration 0028 a brief is keyed on its session
    // rather than its day, so every session of a multi-session day keeps its own
    // brief and its own advertised `windowClosesAt`. `?date=&subject=` remains
    // supported and resolves to the most recent session of that day THAT HAS
    // PUBLISHED A BRIEF — which is not always the newest session, since a
    // session convenes as 'scheduled' and its brief follows on a separate cron.
    brief: "/api/swarm/brief", // GET ?session= | ?date=&subject=
    signingPayload: "/api/swarm/signing-payload", // POST → canonical bytes a member must sign
    memos: "/api/swarm/memos", // POST (member bearer) — publish a long-form memo
    memo: "/api/swarm/memos/:id", // GET — public memo read
    verifyToken: "/api/swarm/verify-token", // GET (member bearer) → { memberId }
    apply: "/api/swarm/apply", // POST — public onboarding (recorded 'applied', inactive key)
    applyStatus: "/api/swarm/apply/:id", // GET — public, redacted application status (applied/approved/claimed)
    applicationStatus: "/api/swarm/applications/:id/status", // GET — public, privacy-safe application status
    claimChallenge: "/api/swarm/token-claim/challenge", // POST — opaque 10-minute key-proof challenge
    claimToken: "/api/swarm/token-claim", // POST — first valid key proof returns the sole bearer token
    register: "/api/swarm/register", // POST (privileged) — apply+activate shortcut for demo/E2E
    regime: "/api/swarm/regime", // POST (analytics-provider bearer) — provider SUBMITS computed snapshots ({ snapshots }); never a server-side recompute
    submit: "/api/swarm/submit", // POST (member bearer, ed25519-signed)
    // Admin lifecycle (X-Admin-Token). The backend registers ONE dispatcher at
    // admin.action; the named entries below enumerate the verbs it accepts so
    // drivers can reference them without re-hardcoding the path.
    admin: {
      action: "/api/swarm/admin/:action", // POST — generic lifecycle dispatch
      activate: "/api/swarm/admin/activate", // POST — flip applied→active, mint bearer token
      // The former `reset` action (POST — wipe session data) is REMOVED: it
      // TRUNCATEd published session/brief/recommendation/memo history so a demo
      // could reuse today's date, which is data loss against any database that
      // outlives its stack.
      // The former admin `regime` action and analytics queue action were
      // removed by issue #361: producer data only arrives as a submission,
      // and the independent producer owns its own cadence.
      subject: "/api/swarm/admin/subject", // POST — ensure a subject row
      subjectFixtures: "/api/swarm/admin/subject_fixtures", // POST — seed reference-shaped demo fixtures
      open: "/api/swarm/admin/open", // POST — open a session
      brief: "/api/swarm/admin/brief", // POST — publish the brief, open the window
      close: "/api/swarm/admin/close", // POST — close the submission window
      aggregate: "/api/swarm/admin/aggregate", // POST — deterministic rollup
      publish: "/api/swarm/admin/publish", // POST — publish the session
      enqueueJob: "/api/swarm/admin/enqueue-job", // POST — drive lifecycle via the worker job queue

      // Admin surface (issue #152): topics/members/roster/lifecycle/audit.
      // Distinct sub-resource paths (never a single-segment :action) so they
      // never collide with the generic dispatcher above.
      subjects: "/api/swarm/admin/subjects", // GET list (all statuses) / POST create
      subjectUpdate: "/api/swarm/admin/subjects/:id/update", // POST — versioned edit (409 stale_version)
      subjectDeactivate: "/api/swarm/admin/subjects/:id/deactivate", // POST — versioned deactivate

      // GET list (all statuses, redacted) / POST manual add.
      // POST body is { name, publicKey, lens?, contact? } — issue #690: the id is
      // GENERATED server-side and returned as `member.id`; a body carrying
      // `memberId` is refused with 400, never silently given a different id.
      members: "/api/swarm/admin/members",
      applications: "/api/swarm/admin/applications", // GET ?status= — application review queue
      memberReview: "/api/swarm/admin/members/:id/review", // POST { decision: approve|reject }
      memberUpdate: "/api/swarm/admin/members/:id/update", // POST — versioned profile edit (409 stale_version)
      memberDeactivate: "/api/swarm/admin/members/:id/deactivate", // POST — versioned
      memberReactivate: "/api/swarm/admin/members/:id/reactivate", // POST — versioned, mints a fresh credential
      memberRotateKey: "/api/swarm/admin/members/:id/rotate-key", // POST — one-time credential in the response only
      memberRole: "/api/swarm/admin/members/:id/role", // POST — versioned { role: member|judge }, no credential change
      // POST — issue #626: raw image bytes as the body (Content-Type is the
      // upload's mime type, not application/json). Stores the file and points
      // avatar.path at it, which is all member-mark.js's precedence check
      // (issue #625) needs to prefer it over the derived mark.
      memberAvatar: "/api/swarm/admin/members/:id/avatar",

      sessionCreate: "/api/swarm/admin/sessions", // POST — UTC-validated, snapshots the roster, enqueues 5 scoped jobs
      sessionRoster: "/api/swarm/admin/sessions/:id/roster", // GET — the frozen expected roster
      // GET ?limit= — the shadow soak's read path (issue #767). Every judge run
      // for one session, newest first, plus which one is in force: mode,
      // source, fallback reason, whether an `enforce` opinion actually reached
      // the session, and what the parser dropped out of the model's response.
      sessionJudgements: "/api/swarm/admin/sessions/:id/judgements",
      rosterAdd: "/api/swarm/admin/sessions/:id/roster/add", // POST { memberId } — before collecting only
      rosterExcuse: "/api/swarm/admin/sessions/:id/roster/excuse", // POST { memberId } — before collecting only
      rosterRestore: "/api/swarm/admin/sessions/:id/roster/restore", // POST { memberId } — before collecting only
      sessionCancel: "/api/swarm/admin/sessions/:id/cancel", // POST — versioned guarded transition
      sessionClose: "/api/swarm/admin/sessions/:id/close", // POST — versioned guarded transition
      sessionReopen: "/api/swarm/admin/sessions/:id/reopen", // POST — versioned guarded transition
      sessionAggregate: "/api/swarm/admin/sessions/:id/aggregate", // POST — versioned guarded transition
      sessionPublish: "/api/swarm/admin/sessions/:id/publish", // POST — versioned guarded transition
      // Consensus judge (issue #752). `sessionJudge` moves aggregated -> judged
      // and records the opinion; `judgeConfig` is the runtime switch (GET reads
      // it, POST { mode, minTakes } sets it) that lets an operator take the
      // judge off published sessions WITHOUT a redeploy.
      sessionJudge: "/api/swarm/admin/sessions/:id/judge", // POST — versioned guarded transition
      judgeConfig: "/api/swarm/admin/judge", // GET | POST { mode: off|shadow|enforce, minTakes }
      // Assemble, sign-collect and PUBLISH the consensus receipt for a judged
      // session (issue #754). Immutable once published: a second POST returns
      // the receipt already on file rather than re-assembling it.
      sessionConsensusReceipt: "/api/swarm/admin/sessions/:id/consensus-receipt", // POST — publish (idempotent)

      audit: "/api/swarm/admin/audit", // GET ?actor=&action=&since=&until=&limit= — redacted audit trail

      // Agent health (issue #208, scout #214): missed-window absences and
      // rejected submission signatures, otherwise visible only in an agent's
      // own stdout. Raw event history + per-type counts; no automatic
      // dead-agent threshold.
      agentHealth: "/api/swarm/admin/agent-health", // GET ?sessionId=&memberId=&eventType=&limit=
    },
  },

  // Analytics-provider ingestion boundary (issue #106). Every route requires the
  // ANALYTICS_TOKEN bearer (analytics-provider role); updater processes call
  // these instead of writing SQL. Mutations validate the whole payload before
  // opening a transaction and are idempotent on their natural keys. There is NO
  // generic SQL-over-HTTP endpoint.
  analytics: {
    readiness: "/api/analytics/readiness", // GET — authenticate producer credential; no data read or mutation
    rawHistory: "/api/analytics/raw-history", // GET → persisted floor; POST — batch upsert on (date, indicator)
    rawHistorySeed: "/api/analytics/raw-history/seed", // POST — cold-DB gap-fill (existing rows win; EDGAR seed ingestion)
    regimeSnapshots: "/api/analytics/regime-snapshots", // POST — snapshot batch upsert on (date)
    researchSignals: "/api/analytics/research-signals", // POST — signal batch upsert on (signal_key, date)
    // GET ?since=YYYY-MM-DD — which (signal_key, date) pairs exist on/after
    // `since` (issue #614 AC4). No payload content, just presence — the
    // producer's own read side for catch-up: it has no DATABASE_URL, so this
    // is the only way it can tell which recent days it needs to re-run.
    researchSignalDates: "/api/analytics/research-signals/dates",
    // GET ?since=YYYY-MM-DD — which raw_indicator_history interior gap dates
    // exist on/after `since` (issue #646, closing #614 AC4's Class A bullet).
    // The read side of the producer's INDICATOR catch-up: same shape as
    // researchSignalDates above, one series (Class A) instead of two signal
    // keys, driven by the shared gap detector (ops/gap-detector.ts) instead
    // of a bespoke presence query.
    rawHistoryGaps: "/api/analytics/raw-history/gaps",
    // POST — retired control-plane path; authenticated callers receive 409 and
    // no consumer schedule/job mutation. Retained so old clients fail closed.
    researchEligibility: "/api/analytics/research-eligibility",
    // POST — submit one run's structured telemetry (stages/warnings/artifacts/
    // outcome; issue #151). Non-fatal to callers: a failed submission never
    // blocks the canonical analytics writes above.
    telemetry: "/api/analytics/telemetry",
  },

  admin: {
    auth: "/api/admin/auth", // POST — verify the admin password → { ok: true }
    // WebAuthn ceremonies (issue #587). Registration remains behind the
    // existing admin gate; authentication yields a short-lived admin session.
    webauthnRegisterOptions: "/api/admin/webauthn/register/options", // GET
    webauthnRegisterVerify: "/api/admin/webauthn/register/verify", // POST
    webauthnAuthOptions: "/api/admin/webauthn/auth/options", // GET
    webauthnAuthVerify: "/api/admin/webauthn/auth/verify", // POST
    isClaimed: "/api/admin/is-claimed", // GET — check if admin credential is claimed
    claim: "/api/admin/claim", // POST — claim the admin credential
    passwordChange: "/api/admin/password-change", // POST — change admin password
    passwordRecover: "/api/admin/password-recover", // POST — use recovery code to set new password
    // GET — health cards + alert feed (queue counts, last success/failure by
    // kind, stale research signals, next enabled schedules). See
    // docs/architecture.md US-A2. Route shape fixed here so the #157
    // frontend and the #155 backend converge on the same path on rebase.
    overview: "/api/admin/overview",
    // GET — one gap report per registered series (issue #614 AC3): interior
    // gaps and a stale head, reported separately, for every persisted time
    // series the pipeline writes on a schedule.
    gaps: "/api/admin/gaps",
    jobs: "/api/admin/jobs", // GET ?limit=&cursor=&kind=&status=&scopeType=&scopeId=&createdFrom=&createdTo= — task-queue jobs + schedules + status summary
    job: "/api/admin/jobs/:id", // GET — one job + its recent runs (the logs)
    jobRetry: "/api/admin/jobs/:id/retry", // POST — clone a dead job into a new pending job (US-Q1)
    runs: "/api/admin/runs", // GET ?kind=&status=&limit=&cursor= — recent job_runs feed (the logs)
    schedule: "/api/admin/schedules/:id", // PATCH — legacy analytics rows fail closed; non-analytics rows are not accepted
    audit: "/api/admin/audit", // GET ?actor=&action=&targetType=&targetId=&from=&to=&limit=&cursor= — redacted, filtered audit_log feed (issue #155)
    // Research pipeline telemetry admin surface (issue #151, consumed by the
    // #157 operator UI per docs/architecture.md US-R1..US-R4).
    // X-Admin-Token. Shape fixed by the #151 backend; frontend converges here.
    researchRuns: "/api/admin/research/runs", // GET ?kind=&status=&limit= — run list
    researchRun: "/api/admin/research/runs/:id", // GET — run detail: stage timeline, warnings, artifacts, freshness
    researchRawSeries: "/api/admin/research/raw-series/:indicator", // GET ?from=&to=&limit= — allowlisted raw_indicator_history read
    researchSignal: "/api/admin/research/signals/:key", // GET ?from=&to=&limit= — allowlisted research_signals read
    researchRerun: "/api/admin/research/rerun", // POST — retired; 409 because the independent producer owns execution
  },

  // Swarm operations surface (issue #159 UI over issue #152/PR #169's
  // already-shipped backend; docs/architecture.md §6.3 and §7.1). This
  // is the SAME table `swarm.admin.*` above (backend/src/api/routes/
  // swarm-admin.ts) — there is deliberately no second `admin.swarm.*`
  // route table for this feature, so the frontend and backend can never drift
  // onto two different URL prefixes again (see PR #172 review). Consumers:
  // frontend/public/assets/js/app/alpine/views/admin/swarm-*.js.
};
