# Admin Surface: Research and Investment Swarm

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## Admin Surface: Research and Investment Swarm

Status: implementation specification, realigned 2026-09-23 to the epoch model
of [system-scheduler-spec](../technical/system-scheduler-spec.md). The
session-lifecycle parts below describe the target; the shipped admin surface
still follows the older scheduled-session path until the scheduler ships.
Audience: engineering agents implementing the next admin phase
Route: `/admin` and `/admin/*` (not linked from public navigation)

## 1. Outcome

Build one authenticated operator surface that lets a Robot Money administrator:

1. diagnose every run of the research pipeline from source access through the
   public report;
2. inspect and safely rerun queue work;
3. create and manage Investment Swarm topics, including each topic's epoch
   duration;
4. add, activate, deactivate, and review swarm members;
5. observe each topic's current epoch (its `collecting` session and
   `window_closes_at`) and every session's lifecycle state, judging outcome
   and judging deadline, plus the scheduler's health;
6. inspect the exact roster, brief inputs, signed member recommendations,
   absences, aggregate, and publication for a session; and
7. see an immutable audit trail for every admin mutation.

An implementation is complete only when an admin can perform these workflows
without SQL access, shell access, or manual calls to the existing swarm
admin dispatcher.

## 2. Settled scope for this surface

These points are settled for this surface. Where one touches session timing or
lifecycle, the scheduler spec governs and this list only summarizes it:

- Keep the existing `ADMIN_TOKEN` and `X-Admin-Token` authentication model.
  Role-based admin accounts are out of scope for this phase.
- Keep the buildless Alpine frontend and the frontend-to-backend HTTP boundary.
- Research and queue admin requests still go through the Postgres queue. Swarm
  lifecycle actions do not: an admin action calls the same state-guarded API
  transition that `system-scheduler` calls (turn over with
  `expected_session_id`, aggregate, request judging, finalize), and the API
  performs it as one transaction
  ([scheduler spec §5](../technical/system-scheduler-spec.md#5-transitions-are-state-guarded)).
  The browser never runs domain operations itself.
- Preserve accepted swarm recommendations as append-only signed records.
  Admins cannot edit or delete them. Under [D49](../decisions.md#d49) a member
  files one take per epoch and cannot amend it; a changed view goes into the
  next epoch's take.
- “Remove member” means deactivate. No swarm member is hard-deleted.
- “Topic” is the UI term; `swarm_subjects` remains the database and API
  domain term.
- The target lifecycle states for a new session are `collecting`,
  `window_closed`, `aggregated`, `judging`, `judged` and `published`
  ([scheduler spec §4](../technical/system-scheduler-spec.md#4-the-session-lifecycle)).
  A session is `collecting` from the instant it opens; there is no
  `scheduled` state, no `brief_published` state, and no `cancelled` state for
  new epochs. `judging` and `judged` appear only under judge mode `enforce`;
  `aggregated → published` remains legal under `off`. The judging **outcome**
  (`judged`, `no_consensus`, `not_judged`) is a separate field on the
  published session, not a lifecycle state. Historical rows in `scheduled` or
  `cancelled` remain readable; how legacy in-flight sessions convert is a
  migration/release concern outside this document.
- A swarm session snapshots its expected roster when it opens, and the roster
  is frozen from that instant because the session is already `collecting`.
  Later global member changes do not rewrite that roster or historical quorum.
- Research recovery reruns a complete tool. Individual stages are not retried
  because the current stages share in-memory data and are not independently
  executable.
- Analytics natural-key rows remain current-value projections and may be
  upserted by a rerun. The new run/stage records preserve who ran what, the
  before/after checksums, warnings, and outcome; this phase does not introduce
  versioned copies of every raw time-series row.
- There are no swarm schedule rows, cron strings or enable switches in the
  target. A topic's epoch duration is its whole schedule: set by bootstrap data
  on a blank database, changed afterwards only through the admin API (US-C1),
  and never disabled. Schedule toggles in this UI concern analytics rows only.
  See [smoke-production-spec §6.3](../technical/smoke-production-spec.md#63-sessions-are-independent)
  and [scheduler spec §2](../technical/system-scheduler-spec.md#2-epochs).

## 3. Current product baseline

The implementation must extend, not replace, these pieces:

- `frontend/public/views/admin.html` and
  `frontend/public/assets/js/app/alpine/views/admin-jobs.js` provide the current
  password gate, five-second polling, schedules, queue jobs, runs, and JSON logs.
- `backend/src/api/routes/admin.ts` exposes `POST /api/admin/auth`,
  `GET /api/admin/jobs`, `GET /api/admin/jobs/:id`, and
  `GET /api/admin/runs`. These routes are read-only and fail closed before SQL.
- `jobs`, `job_schedules`, and `job_runs` are defined by migration `0003`.
  `jobs.status` currently allows `pending`, `running`, `succeeded`, `failed`, and
  `dead`; normal retry handling leaves the job `pending` and records `failed` or
  `degraded` on `job_runs`.
- Analytics runs through `runAnalytics()` and the stages described in
  `docs/architecture.md`: `access → extract → transform → analyze → store →
  report`. The independent producer owns `regime` at 22:30 UTC and `research`
  at 23:00 UTC; retired consumer job rows are observability/cleanup debt only.
- The independent analytics producer persists through the authenticated
  `/api/analytics/*` boundary and has no database credential. Migration `0016`
  continues denying the shared worker role writes to analytics tables. New
  analytics telemetry writes must respect the same boundary.
- The current swarm domain (legacy, 2026-09-23) supports public reads,
  applications, activation, signed submissions, memos, subject creation, and a
  scheduled-session lifecycle driven by queue jobs. Every target transition is
  state-guarded and returns the original result when repeated
  ([scheduler spec §5](../technical/system-scheduler-spec.md#5-transitions-are-state-guarded));
  this plan adds those guards where they are missing.
- Canonical accepted takes live in `swarm_recommendations`, one per
  `(session_id, member_id)` ([D49](../decisions.md#d49), which supersedes
  D33's capped revisions). A resubmission on that key returns the existing
  row. Legacy sessions may hold several `revision` rows per member; reads of
  those sessions still resolve latest-per-member. Replay protection on
  `(member_id, nonce)` is unchanged.
  Invalid signatures are rejected before insert and are not retained. The admin
  UI therefore shows accepted submissions only; rejected submission-attempt
  forensics are out of scope.
- Public swarm DTOs intentionally omit secrets and admin metadata. Admin DTOs
  must be new types rather than widening public responses with contact or key
  information.

## 4. User stories and required behavior

### US-A1 — Sign in and retain a tab session

As an admin, I can enter the admin password once and use all admin sections in
that browser tab.

Acceptance:

- The existing `rm_admin_token` `sessionStorage` key is retained.
- Every admin request sends `X-Admin-Token`.
- Any 403 clears the stored token, stops polling, clears sensitive state, and
  returns to the login form with “Session expired — sign in again.”
- The token never appears in a URL, log, audit row, or rendered JSON payload.

### US-A2 — See operational health

As an admin, I can see current failures, stale research, active swarm work,
each topic's current epoch, and scheduler health on one page.

Acceptance:

- Overview cards show queue counts, stale analytics outputs, historical retired
  consumer-job health, any accidentally enabled legacy analytics schedule,
  each active topic's `collecting` session with its `window_closes_at`, every
  session still settling with its state (and judging deadline when
  `judging`), and the scheduler's health. Producer-native cadence/run health
  remains an observability follow-up.
- Scheduler health comes from `system-scheduler`'s health endpoint as defined
  in [smoke-production-spec §6.3](../technical/smoke-production-spec.md#63-sessions-are-independent):
  authenticated, stream synchronized, initial rebuild complete, and no
  exhausted work. A degradation is shown with its subject or session and last
  error. A session waiting on its judging deadline, or published
  `no_consensus`, is not a health failure. The UI offers no restart control;
  recovery is an operator restart of the scheduler container.
- Alerts distinguish `not_run`, `running`, `degraded`, `failed`, `dead`,
  `stale`, and `healthy`.
- A “running too long” alert means `jobs.status = 'running'` and
  `locked_at < now() - JOB_VISIBILITY_TIMEOUT`; it does not guess from average
  duration.
- Regime staleness uses the existing regime projection’s staleness block.
- Each research signal is stale when its latest `research_signals.date` is more
  than two UTC calendar days behind the API server date. Use a named constant
  `RESEARCH_STALE_DAYS = 2` in the admin projection.

### US-R1 — List and filter research runs

As an admin, I can find a run by job kind, tool, as-of date, status, or job id.

Acceptance:

- One producer regime execution creates one analytics run with the `regime` tool.
- One producer research execution creates one analytics run containing
  `channel-divergence` and `late-cycle-signals` tool traces.
- Admin rerun/retry endpoints reject analytics execution with `409`; they never
  enqueue `regime.classify` or `research.refresh`.
- The list shows run id, optional legacy job id, attempt, source mode, as-of date, tools,
  current stage, status, warning count, start, finish, and duration.

### US-R2 — Inspect every research stage

As an admin, I can open a research run and understand what happened at every
stage without reading arbitrary console logs.

Acceptance:

| Stage | Required recorded detail |
|---|---|
| `access` | `ANALYTICS_SOURCE` result (`live` or `hermetic`), requested tool inputs, persisted-floor row counts, floor-seed result, and cache configuration; never headers or tokens |
| `extract` | source and indicator/input keys, request outcome, timeout/error summary, fetched point counts, first/last date, and persisted-floor fallback use |
| `transform` | tool, date range, alignment mode, raw/aligned/transformed counts, missing/forward-filled/zero-filled counts, and bounded preview |
| `analyze` | tool, dependency list, methodology/version, output summary, insufficient-history warnings, and output checksum |
| `store` | authenticated API operation, target table, natural keys/counts, inserted-or-updated result, before/after checksum, and transaction outcome |
| `report` | public route checked, returned as-of date, payload checksum, staleness result, and whether it matches the stored output |

Stage states are `pending`, `running`, `succeeded`, `warning`, `failed`, and
`skipped`. A stage with zero rows is never silently shown as succeeded: it is
either `warning` with fallback detail or `failed` when no usable data exists.

The detail page links back to the queue job and exposes redacted `job_runs`
output/error. It displays at most 250 preview points per artifact. Complete
persisted raw history is fetched on demand by indicator/date range; it is not
copied into telemetry JSON.

### US-R3 — Navigate research datapoints

As an admin, I can move from a source indicator to stored data and the public
report it affects.

Acceptance:

- `regime` shows all registry indicators, their source, transform, latest raw
  date/value, transformed value, signed percentile, panel weight, and raw
  history range from `raw_indicator_history`.
- `channel-divergence` and `late-cycle-signals` expose the persisted payload for
  the selected `(signal_key, date)` and its bounded source/transform previews.
- A raw-series request accepts an indicator, start date, end date, and limit;
  it cannot execute arbitrary SQL or request an unregistered table.
- Links open the corresponding public `/regime` or `/research/:key` page in a
  separate tab.

### US-R4 — Keep producer execution outside admin authority

As an admin, I can inspect analytics results without gaining the producer's
credential or a consumer-queue path that impersonates it.

Acceptance:

- Research rerun, analytics job retry, and analytics schedule-toggle endpoints
  return `409` without inserting a job or changing a schedule.
- The swarm admin dispatcher accepts lifecycle actions only; it cannot
  enqueue `regime.classify` or `research.refresh`.
- The retired authenticated `research-eligibility` path returns
  `409 producer_owned` and performs zero queue/schedule mutations.
- Operational reruns execute from the independent producer environment under
  its own scoped credential, not through `ADMIN_TOKEN`.

### US-Q1 — Inspect and retry queue work

As an admin, I can filter queue jobs and create a safe retry of dead work.

Acceptance:

- Existing queue screens remain available under `/admin/queue`.
- Filters cover kind, job status, run status, scope type/id, and created range.
- Job detail includes payload, dedupe key, worker lock, attempts, every run, and
  any linked analytics run or swarm session.
- “Retry” is available only for a `dead` job. It clones kind/payload/priority into
  a new pending job, gives it a unique manual dedupe key, and audits the source
  and new job ids. It never changes the dead row.
- Schedule editing is limited to enabled/disabled for existing analytics
  schedules. Cron, timezone, kind, and payload are read-only in this phase.
- No swarm lifecycle work appears in this queue in the target: sessions are
  driven by `system-scheduler` through the API, and a topic's epoch duration
  (US-C1) is the only schedule
  ([smoke-production-spec §6.3](../technical/smoke-production-spec.md#63-sessions-are-independent)).
  Legacy `swarm.*` rows from the pre-scheduler worker are history only.

### US-C1 — Create and edit a swarm topic

As a swarm manager, I can add a topic, set its epoch duration, and make it
eligible for sessions.

Acceptance:

- Create and edit support every durable `swarm_subjects` field, including the
  **epoch duration**. That duration is the topic's whole schedule
  ([scheduler spec §2.2](../technical/system-scheduler-spec.md#22-the-one-duration)).
- Changing the duration is an ordinary authenticated update. It publishes
  `subject.changed`; the current window keeps the `window_closes_at` it was
  opened with, and the epoch opened at the next boundary uses the new value
  (scheduler spec §6.2). No restart is needed.
- Activating a topic causes the scheduler to open its first epoch; the admin
  surface does not open sessions itself (scheduler spec §3).
- New topic ids match `^[a-z0-9][a-z0-9-]{1,63}$` and are immutable after create.
- Required fields are id, name, operator, thesis, source type,
  recommendation type, and epoch duration.
- Source type is `rpc`, `manual`, `vault_tvl`, or `framework`.
- Recommendation type is `position_actions` or `bucket_weights`.
- Wallet and NFT entries have `address`, `chain`, and optional `label` strings.
  `framework` requires an empty wallet array; `rpc` requires at least one wallet.
- `linkedMemberId`, when present, must reference an existing member.
- Deactivation sets `status = 'inactive'`, closes the topic's open epoch
  (recording absences as a boundary would), opens no successor, and lets
  settlement of that closed epoch run to `published`
  ([scheduler spec §4.5](../technical/system-scheduler-spec.md#45-deactivating-a-subject)).
  Old sessions, briefs, snapshots, and recommendations are unchanged.
- Edits require the current `version`; a stale version returns 409.

### US-C2 — Review and manage swarm members

As a swarm manager, I can review applications and manually manage the
roster without destroying history.

Acceptance:

- Roster filters are `applied`, `active`, and `inactive`.
- Member detail includes profile fields, contact email, application status,
  timestamps, active-key metadata, participation history, and audit events.
  It never returns `token_hash` or any bearer token already issued.
- Activating an applicant uses the existing pending public key, marks the
  application approved, and returns a new bearer token exactly once. The UI
  presents a copy-and-dismiss panel and cannot retrieve the token later.
- Manual add requires name, public key, and optional profile/contact fields. It
  creates an active member, one active key, and returns a bearer token exactly
  once. It does NOT take a member id (issue #690): the id is generated with
  `crypto.randomUUID()` — the same mint the public apply path uses — and returned
  as `member.id`, so the admin surface is no longer a way to create a member
  whose id is a human slug. A body still carrying `memberId` is refused with a
  400 naming the field rather than seated under a different id. Duplicate
  detection is on the public key, not the id: re-submitting a credential that
  already belongs to a member is a 409.
- Deactivate changes the member to `inactive` and deactivates all member keys in
  the same transaction. Existing recommendations and roster snapshots remain.
- Reactivate requires a new public key. It inserts a new active key, keeps old
  keys inactive, returns a new bearer token once, and sets status active.
- Key rotation for an active member likewise requires a new public key and
  atomically revokes old keys before issuing a new token.
- Rejecting an application sets its application status to `rejected`, sets the
  member inactive, and leaves its key inactive.
- `SWARM_ROSTER_CAP` is HARD-ENFORCED on every transition-to-active. The
  production admin API (manual add, activate/approve, reactivate — and the smoke
  `registerMember` shortcut) refuses an admission that would exceed the cap with
  a 409, race-safely (a transaction-scoped advisory lock serializes admissions
  so two concurrent activations cannot both slip past the last free seat).
- All writes require the current member `version`; stale writes return 409.

### US-C3 — Observe a topic's current epoch and its sessions

As a swarm manager, I can see which session each topic is collecting now, when
its window closes, and where every earlier session stands in settlement.

Acceptance:

- There is no session create form. Sessions are opened by `system-scheduler`
  (first epoch on activation or rebuild, every later one at turnover) through
  the API's atomic open, which creates the session, publishes its brief and
  sets `window_closes_at = open instant + epoch duration`
  ([scheduler spec §4.1](../technical/system-scheduler-spec.md#41-epoch-open)).
  The admin surface reads the result; it does not choose instants.
- The topic detail shows the current `collecting` session (at most one per
  topic, enforced by the database) with its `window_closes_at` in UTC and
  browser-local time, a countdown, and the epoch duration the next window will
  use.
- Session identity is the session id. Several sessions per topic on one date
  are normal; the display date is derived from the open instant and is not a
  key.
- Session detail presents the lifecycle state, the transition history from
  `swarm_session_events`, the judge mode captured at turnover, the judging
  deadline while `judging`, the judging outcome once `published`
  (`judged`, `no_consensus`, `not_judged`), expected roster, response count,
  and the next legal transition.
- The expected roster is snapshotted into `swarm_session_members` when the
  session opens and is immutable from that instant, because the session is
  already `collecting`. Members activated afterwards join the next epoch.
  There is no pre-collection roster-edit step.
- The legacy scheduled-session path (brief-open, window-close and publish
  timestamps; five one-off `swarm.*` jobs; `MIN_SESSION_STEP_MS` clamps) is
  what shipped before the scheduler and is not a target requirement.

### US-C4 — Operate guarded swarm transitions

As a swarm manager, I can fire a lifecycle step by hand without creating
impossible state.

The transition contract lives in
[scheduler spec §§4–5](../technical/system-scheduler-spec.md#4-the-session-lifecycle);
this surface exposes those same endpoints and adds nothing to them. Summary:

| Action | Effect | Guard |
|---|---|---|
| turn over (`expected_session_id`) | closes the named `collecting` session (absences recorded), opens the next epoch, records the turnover — one transaction | the named session must be the topic's current `collecting` one; otherwise the original result or a reasoned no-op (§4.3) |
| aggregate | `window_closed → aggregated`, deterministic, over accepted takes only | state guard (§5) |
| request judging | `aggregated → judging`; stores the absolute deadline | mode captured at turnover is `enforce`; under `off` finalize is called directly (§4.4) |
| finalize | decides the outcome from stored instants and publishes: `→ published` | state-guarded and time-guarded: under `enforce` with no eligible consensus it refuses until the deadline (§4.4) |

An operator ending a window early is a turnover with the same
`expected_session_id`; it is not a distinct "early close" and never targets
the successor. There is no reopen, no cancel and no `shadow` mode in the
target ([D48](../decisions.md#d48)). Every other call returns 409 with a
reason. A repeated call for a transition that already happened returns the
original result; it must not rewrite timestamps.
`published` is terminal.

Manual actions are synchronous calls to the same state-guarded API endpoints
the scheduler uses; they return the transition's result, not a job id. The
scheduler learns of them by event (`epoch.turned_over`, `session.judged`) and
continues the chain (scheduler spec §6.2).

### US-C5 — Inspect member datapoints and aggregation

As a swarm manager, I can inspect what every expected member supplied and
how the aggregate was derived.

Acceptance:

- The roster matrix derives one row per `swarm_session_members` row and
  reports `expected`, `submitted`, or `absent` (`excused` appears only on
  legacy sessions that had a pre-collection roster edit; the target has none).
- `submitted` includes recommendation id, stance, confidence, received time,
  verification state, body, memo URL, nonce, signature, and canonical payload.
  Signature and payload are admin-only and rendered in a collapsed disclosure.
- The UI can filter and sort by roster state, stance, confidence, received time,
  and member.
- The aggregate denominator comes from non-excused session roster rows, never
  the current global active-member query.
- The aggregate view shows stance counts, mean confidence, expected/submitted/
  absent counts, consensus, disagreements, actions or weights, and the source
  recommendation ids used.
- No admin endpoint can update `swarm_recommendations`, and no code path
  anywhere UPDATEs an accepted take's content ([D49](../decisions.md#d49)).

### US-A3 — Inspect audit history

As an admin, I can determine who or what changed operational state and why.

Acceptance:

- Every admin mutation records actor `admin`, action, target, reason, request id,
  before summary, after summary, outcome, timestamp, and related job/session ids.
- Existing public/member events remain visible (`public:apply` and member
  submission events).
- Audit rows are append-only through the application. No delete/update endpoint
  exists.
- Secrets, token hashes, bearer tokens, signatures, full recommendation bodies,
  and request headers are excluded from audit JSON.

## 5. Database migration

Add one forward migration, `backend/migrations/0017_admin_surface.sql`. It must be
idempotent in the same style as existing migrations and preserve all current
rows.

### 5.1 Queue extensions

Add to `jobs`:

```sql
scope_type     text,
scope_id       text,
requested_by   text,
audit_request_id uuid
```

Add index `(scope_type, scope_id, id DESC)`. Replace the jobs status check so it
also allows `cancelled`. Do not remove the currently allowed `failed` value even
though normal retries use `pending`; existing deployments may contain it.

### 5.2 Research telemetry

Create `analytics_runs`:

```text
id uuid primary key default gen_random_uuid()
job_id bigint references jobs(id) on delete set null
job_kind text not null
attempt int not null
asof date not null
source_mode text not null check (live, hermetic)
tools jsonb not null                         -- JSON array of allowed tool ids
status text not null check (running, succeeded, warning, failed)
current_stage text
code_version text not null default 'unknown'
warning_count int not null default 0
warnings jsonb not null default []
error text
started_at timestamptz not null default now()
finished_at timestamptz
created_by text not null                     -- scheduler or admin
audit_request_id uuid
```

Index `(started_at DESC)`, `(job_id, attempt)`, and `(asof DESC, job_kind)`.
There is no uniqueness constraint on job/attempt because telemetry failure and a
subsequent retry must not block a new trace; list projection selects the latest
trace and flags duplicates.

Create `analytics_stage_runs`:

```text
id bigserial primary key
analytics_run_id uuid references analytics_runs(id) on delete cascade
tool_id text not null
stage text not null check (access, extract, transform, analyze, store, report)
sequence smallint not null
status text not null check (pending, running, succeeded, warning, failed, skipped)
started_at timestamptz
finished_at timestamptz
summary jsonb not null default {}
error text
unique (analytics_run_id, tool_id, stage)
```

Create `analytics_artifacts`:

```text
id bigserial primary key
analytics_run_id uuid references analytics_runs(id) on delete cascade
stage_run_id bigint references analytics_stage_runs(id) on delete cascade
tool_id text not null
kind text not null
artifact_key text not null
checksum text
row_count int
first_date date
last_date date
preview jsonb                            -- maximum 250 points/items
storage_ref jsonb not null default {}    -- allowlisted table/key/date reference
created_at timestamptz not null default now()
```

Index `(analytics_run_id, tool_id)` and `(artifact_key, created_at DESC)`.
Telemetry tables are analytics-owned: migration `0017` must explicitly revoke
worker `INSERT/UPDATE/DELETE` on them. Worker telemetry is written through new
analytics-provider endpoints, never the worker SQL connection.

### 5.3 Swarm integrity and scheduling

Add `version int NOT NULL DEFAULT 1` and `updated_at timestamptz NOT NULL DEFAULT
now()` to `swarm_members`, `swarm_subjects`, and `swarm_sessions`.

**Shipped history (migration `0017`, before the scheduler spec).** That
migration added `brief_opens_at`, `publish_at` and `cancelled_at` to
`swarm_sessions`. They served the scheduled-session path and are not target
schema guidance: the target session carries `window_closes_at`, the judge
mode captured at turnover, the judging request instant and deadline, the
consensus acceptance instant, the judging outcome, and `published_at`. The
subject carries its epoch duration. The enforced uniqueness is at most one
`collecting` session per subject; there is no `(date, subject_id)`
uniqueness, because a subject runs many epochs per day and a session's
display date is not its identity
([scheduler spec §2.1](../technical/system-scheduler-spec.md#21-the-model)).
The exact migration that lands these, and what happens to legacy columns and
in-flight rows, is release work outside this document.

Keep existing `window_closes_at` and `published_at`. Add a state check for the
target states in section 2 while still admitting the legacy values present in
existing rows. Validate existing values before validating the
constraint. Add foreign keys from sessions/recommendations/snapshots/briefs to
subjects only after a migration query proves there are no orphan subject ids;
otherwise insert placeholder inactive subjects for the orphan ids first.

Create `swarm_session_members`:

```text
session_id uuid references swarm_sessions(id) on delete cascade
member_id text references swarm_members(id)
member_name text not null
member_lens text
status text not null default 'expected' check (expected, excused)
included_at timestamptz not null default now()
excused_at timestamptz
reason text
primary key (session_id, member_id)
```

Backfill existing sessions from the historical evidence available:

- insert every member that submitted to the session as `expected` using current
  name/lens snapshots;
- for sessions with `swarm_recommendation.quorum.active`, add currently
  active members until the recorded active count is reached, ordered by member
  id; and
- if the exact historical roster cannot be reconstructed, retain the row set and
  add an audit event `backfill_session_roster` with `scope.approximate = true`.

Create `swarm_session_events`:

```text
id bigserial primary key
session_id uuid references swarm_sessions(id) on delete cascade
from_state text
to_state text not null
action text not null
actor text not null
reason text
job_id bigint references jobs(id) on delete set null
at timestamptz not null default now()
```

Index `(session_id, at)`. Backfill one `backfill` event per existing session using
its current state and `generated_at`.

Add checks for member status (`applied`, `active`, `inactive`), subject status
(`active`, `inactive`), and application status (`pending`, `approved`,
`rejected`). Normalize unknown existing values to `inactive`/`rejected` before
validating.

### 5.4 Audit extension

Extend existing `audit_log` without removing `scope`:

```text
request_id uuid default gen_random_uuid()
target_type text
target_id text
reason text
before_state jsonb
after_state jsonb
outcome text not null default 'succeeded'
job_id bigint references jobs(id) on delete set null
session_id uuid references swarm_sessions(id) on delete set null
```

Index `(at DESC)`, `(target_type, target_id, at DESC)`, and `request_id`.

## 6. Backend implementation

### 6.1 Boundaries and module placement

- Keep `handleAdmin` as the single `/api/admin/*` dispatcher, but split SQL and
  domain logic into `backend/src/admin/` projections/services so the route does
  not become a monolith.
- Add admin DTOs to `contract/src/admin.d.ts` and routes to
  `contract/src/routes.js`/`routes.d.ts`. Run `scripts/sync-contract.ts` so the
  browser contract copy stays generated from the canonical contract.
- Add swarm mutations to `backend/src/swarm/domain.ts` or focused
  modules under `backend/src/swarm/`; both REST and workers call the same
  functions.
- Add an optional analytics trace observer to `runAnalytics`. The compute path
  must remain usable with a no-op observer in tests and non-worker callers.
- Change `JobHandler` to `(payload, context)`, where context is
  `{ jobId, kind, attempt, workerId }`, and pass it from `processOneJob`. Existing
  non-admin handlers may ignore the second argument.

### 6.2 Analytics telemetry write path

Add analytics-provider-only endpoints alongside existing ingestion routes:

- `POST /api/analytics/runs` — begin a trace;
- `PATCH /api/analytics/runs/:id` — finish/update run status;
- `PUT /api/analytics/runs/:id/stages/:tool/:stage` — idempotently start or
  finish one stage;
- `POST /api/analytics/runs/:id/artifacts` — add bounded artifact metadata.

They use `ANALYTICS_TOKEN`, validate complete payloads before transactions, and
redact/reject forbidden keys matching `token`, `authorization`, `header`,
`cookie`, `secret`, or `password` case-insensitively. Preview payloads larger
than 256 KiB or more than 250 entries return 400.

Telemetry is best-effort with respect to analytics computation: inability to
begin or update telemetry does not prevent canonical analytics persistence. The
handler must include `telemetryWarning` in `job_runs.output`; the admin overview
then flags “completed without trace.” Canonical data failures still fail the job.

Instrument actual code boundaries:

- source selection/floor loading in `analytics/index.ts` emits `access`;
- per-source fetch outcomes in `analytics/extract/sources.ts` and data-source
  adapters emit `extract` summaries;
- alignment and `applyTransform` emit `transform` summaries;
- each pure tool computation emits `analyze`;
- each `AnalyticsPersistence` call emits `store`; and
- after store, the worker fetches the relevant public dashboard route and emits
  `report` verification.

### 6.3 Admin read/write API

All routes below require `X-Admin-Token`. Validate auth before parsing bodies or
querying SQL. List routes accept `limit` default 50/max 200 and opaque cursor;
responses are `{ items, nextCursor }`. Invalid input is 400, unauthenticated is
403 (matching current admin behavior), missing is 404, stale version/illegal
state is 409, accepted queue work is 202, and successful synchronous mutation is
200 or 201.

| Method and route | Purpose |
|---|---|
| `GET /api/admin/overview` | health cards and alert feed |
| `GET /api/admin/jobs` | extend existing list with filters and scope fields |
| `GET /api/admin/jobs/:id` | extend existing detail with domain links |
| `POST /api/admin/jobs/:id/retry` | clone a non-analytics dead job; analytics kinds return `409` |
| `GET /api/admin/runs` | retain queue-run feed and add filters |
| `PATCH /api/admin/schedules/:id` | retired analytics control; returns `409` without mutation |
| `GET /api/admin/research/runs` | analytics-run list |
| `GET /api/admin/research/runs/:id` | stages, artifacts, linked queue runs |
| `GET /api/admin/research/series/:indicator` | allowlisted raw history range |
| `GET /api/admin/research/signals/:key/:date` | stored signal payload |
| `POST /api/admin/research/rerun` | retired producer control; returns `409` without enqueue |
| `GET /api/admin/swarm/overview` | session/member/topic summary |
| `GET/POST /api/admin/swarm/subjects` | list/create topics |
| `GET/PATCH /api/admin/swarm/subjects/:id` | topic detail/edit, including the epoch duration; detail carries the current `collecting` session and its `window_closes_at` |
| `POST /api/admin/swarm/subjects/:id/deactivate` | deactivate topic: closes and settles its open epoch, opens no successor |
| `GET /api/admin/swarm/members` | all statuses/applications |
| `GET /api/admin/swarm/members/:id` | private admin member projection |
| `POST /api/admin/swarm/members` | manual active member add — `{ name, publicKey, lens?, contact? }`; the id is GENERATED (`crypto.randomUUID()`) and returned as `member.id`, and a body carrying `memberId` is refused with 400 (issue #690) |
| `PATCH /api/admin/swarm/members/:id` | profile fields only |
| `POST /api/admin/swarm/members/:id/activate` | activate applicant |
| `POST /api/admin/swarm/members/:id/deactivate` | deactivate and revoke keys |
| `POST /api/admin/swarm/members/:id/reactivate` | new key/token and activate |
| `POST /api/admin/swarm/members/:id/rotate-key` | rotate active key/token |
| `POST /api/admin/swarm/members/:id/reject` | reject application |
| `GET /api/admin/swarm/sessions` | list sessions (no create: the scheduler opens sessions) |
| `GET /api/admin/swarm/sessions/:id` | complete operational session DTO: state, events, captured judge mode, judging deadline, judging outcome |
| `POST /api/admin/swarm/sessions/:id/actions/:action` | fire one state-guarded transition synchronously (`turn_over`, `aggregate`, `request_judging`, `finalize`) |
| `GET /api/admin/audit` | filtered append-only audit list |

Mutation request and response shapes are fixed as follows. Unknown fields are
rejected with 400 rather than ignored.

```ts
type AdminReason = string; // trimmed, 10..500 characters

type ResearchRerunRequest = {
  kind: "regime.classify" | "research.refresh";
  asof: string; // YYYY-MM-DD
  toolId?: "channel-divergence" | "late-cycle-signals"; // research only
  reason: AdminReason;
};

type TopicWriteRequest = {
  version?: number; // absent on create, required on edit/deactivate
  id?: string; // required on create, forbidden on edit
  name: string;
  status?: "active" | "inactive"; // create defaults active
  operator: string;
  homepage?: string | null;
  xHandle?: string | null;
  thesisBlurb: string;
  wallets: Array<{ address: string; chain: string; label?: string }>;
  nftContracts: Array<{ address: string; chain: string; label?: string }>;
  source: { type: "rpc" | "manual" | "vault_tvl" | "framework" };
  recommendationType: "position_actions" | "bucket_weights";
  linkedMemberId?: string | null;
  structuralNotes: string[];
  lastReviewed?: string | null; // YYYY-MM-DD
  epochDurationSeconds: number; // the topic's whole schedule (scheduler spec §2.2)
  reason: AdminReason;
};

type MemberProfileWrite = {
  version: number; // profile edit only
  name: string;
  tagline?: string | null;
  lens?: string | null;
  mandate?: string | null;
  biases?: unknown;
  voiceMd?: string | null;
  mode?: string | null;
  operator?: string | null;
  avatar?: unknown;
  contactEmail?: string | null;
  reason: AdminReason;
};

type ManualMemberCreateRequest = Omit<MemberProfileWrite, "version"> & {
  memberId: string;
  publicKey: string;
};

type MemberStatusRequest = {
  version: number;
  publicKey?: string; // required for reactivate and rotate-key; forbidden otherwise
  reason: AdminReason;
};

// No SessionCreateRequest and no RosterPatchRequest: sessions are opened by
// system-scheduler and the roster is frozen at open (US-C3).

type SessionActionRequest = {
  version: number;
  action: "turn_over" | "aggregate" | "request_judging" | "finalize";
  expectedSessionId?: string; // required for turn_over; the epoch being closed
  reason?: AdminReason; // required for a manual turn_over before window_closes_at
};

type TopicDeactivateRequest = { version: number; reason: AdminReason };
type DeadJobRetryRequest = { reason: AdminReason };
type ScheduleToggleRequest = { enabled: boolean; reason: AdminReason };
```

Create responses are `{ item, auditRequestId }` with status 201. Synchronous
updates are `{ item, auditRequestId }`. A response that reveals a newly issued
member credential additionally contains `credential: { token }`; that property
is produced only by create/activate/reactivate/rotate and is never persisted in
an API response table. Enqueued operations return
`{ jobId, auditRequestId, existing: boolean }` with status 202. A 409 response is
`{ error, code: "stale_version" | "invalid_transition" | "duplicate", current? }`.

A manual lifecycle action calls the same state-guarded transition endpoint
that `system-scheduler` calls and returns its result synchronously with
status 200. A transition that already happened returns the original result
(the API distinguishes "already done" from "not allowed"); an invalid one is
409 `invalid_transition` with a reason. No queue job is created. The scheduler
receives the change on the event stream and continues settlement; the
operator does not drive later steps by hand unless a step is stuck
([scheduler spec §§4.6, 5, 6.2](../technical/system-scheduler-spec.md#46-transition-calls-that-fail)).

The generic existing `/api/swarm/admin/:action` endpoints remain for smoke
compatibility but the new browser must not call them. Mark `reset` and
`subject_fixtures` dev/smoke-only and return 403 for them when `RM_ENV=prod`.

### 6.4 Required domain corrections

Before wiring UI controls, bring the domain in line with
[scheduler spec §§4–5](../technical/system-scheduler-spec.md#4-the-session-lifecycle):

- Opening an epoch is one transaction: create the session in `collecting`,
  snapshot the roster, publish the brief, set `window_closes_at`. Two
  concurrent first-openings for one subject yield one session; the second
  call returns it. Nothing resets an existing session to an earlier state.
- Brief regime data and research signals must be the latest rows at or before
  the open instant; do not require an exact signal date and do not read
  future data.
- Turnover must check `expected_session_id` against the subject's current
  `collecting` session, close it, record absences, open the successor and
  record the turnover in one transaction; a zero-row guarded update is a
  reasoned no-op (or the original result), never a reported transition that
  did not occur.
- `submitRecommendation` must refuse after `window_closes_at` regardless of
  state, and must require an `expected` roster row for the member.
- `aggregateSession` must require `window_closed`, read expected members from
  `swarm_session_members`, and use the latest subject snapshot at or before
  the open instant.
- Request-judging must store the request instant and the absolute deadline;
  finalize must decide `judged` / `no_consensus` / `not_judged` from stored
  instants only, be time-guarded under `enforce`, and never re-decide.
- Every transition must return the original result when repeated.
- `registerMember` remains a smoke helper and is not used for production admin
  workflows. It is idempotent by member id (`ON CONFLICT (id) DO UPDATE`,
  rebinding the key and minting a token, with the roster cap exempting an
  existing member), which is what lets a restarted smoke re-adopt a persona
  rather than admit a duplicate.
- `resetSessions` is REMOVED — it TRUNCATEd published session/brief/
  recommendation/memo history so a smoke could reuse today's date. See §5's
  "the database dates a session" note.
- Every transition writes `swarm_session_events` and `audit_log` in the same
  transaction as the state update.

## 7. Frontend implementation

### 7.1 Routing and structure

Use one admin shell for:

- `/admin`
- `/admin/research`
- `/admin/research/runs/:id`
- `/admin/queue`
- `/admin/swarm`
- `/admin/swarm/subjects/:id`
- `/admin/swarm/members/:id`
- `/admin/swarm/sessions/:id`
- `/admin/audit`

Update `frontend/public/assets/js/app/routes.js` so every `/admin` subpath maps to
`/views/admin.html`; otherwise the current catch-all will request nonexistent
view fragments. The shell reads `location.pathname`, uses `history.pushState`,
and listens for `popstate`. It remains absent from public navigation.

Replace `adminJobsView` with one `adminSurfaceView` Alpine factory and move
section-specific fetch/state helpers into modules under
`alpine/views/admin/`. Register the factory at boot in `alpine/views.js`; inline
scripts in the injected HTML fragment will not execute.

### 7.2 Common UI behavior

- Persistent left/top admin navigation, page title, last-refreshed timestamp,
  refresh, pause polling, and sign out.
- Poll overview/active records every five seconds only while `document.hidden`
  is false. Lists and historical detail do not continuously poll.
- Preserve list filters in query parameters and record selection in the path.
- Every empty, loading, error, stale, and unauthorized state has visible text.
- Show UTC first for epoch windows and judging deadlines, with browser-local
  time secondary.
- Render JSON in collapsed, copyable `<pre>` blocks. Never inject payload HTML.
- Mutation buttons disable while pending. Success links to the created job or
  record; errors remain beside the form.
- Confirmation dialogs name the target, explain historical impact, and require
  the reason before enabling destructive/exceptional actions.
- Token reveal is a one-time modal with copy and acknowledgement. Clearing or
  navigating away destroys the plaintext value from Alpine state.

## 8. Verification

### 8.1 Backend/database tests

Add tests proving:

- every new admin route rejects a missing/wrong token before SQL;
- telemetry endpoints reject admin/member credentials and accept only the
  analytics-provider bearer;
- worker-role SQL writes to all three telemetry tables are denied;
- migration backfills existing sessions and does not orphan historical data;
- topic validation, uniqueness, optimistic concurrency, and deactivation;
- member activate/manual-add/deactivate/reactivate/rotate/reject transactions,
  including one-time token behavior and key revocation;
- opening an epoch snapshots the roster, publishes the brief and sets
  `window_closes_at` in one transaction, and creates no queue job;
- changing a topic's epoch duration leaves the current window's
  `window_closes_at` unchanged and applies at the next boundary;
- turnover with a stale `expected_session_id` returns the original result or
  a reasoned no-op and never closes the successor;
- each legal state transition, every illegal transition (including reopen,
  cancel and `shadow`, which return 409), and repeated calls returning the
  original result;
- finalize decides `judged` / `no_consensus` / `not_judged` from stored
  instants and is refused early under `enforce` with no eligible consensus;
- deactivating a topic closes and settles its open epoch and opens none;
  the scheduler-side gates themselves are
  [scheduler spec §10](../technical/system-scheduler-spec.md#10-acceptance-gates);
- member changes after session creation do not alter historical quorum;
- submissions from members outside the session roster are rejected;
- aggregation uses the roster snapshot and at-or-before data only;
- analytics run/stage/artifact recording, redaction, preview limits, and missing
  telemetry warning behavior;
- dead-job retry clones rather than mutates; and
- analytics retry/rerun/schedule paths return `409` with zero queue/schedule
  mutation; swarm smoke rows remain protected too.

### 8.2 Browser tests

Expand `frontend/test/browser/admin-view.spec.ts` into focused cases for:

- login, persisted tab session, 403 logout, navigation, and browser back/forward;
- overview alerts and polling pause;
- research list filters, stage timeline, artifact preview, raw-series navigation,
  and retired-rerun warning;
- queue filters, job detail, non-analytics dead-job retry, and fail-closed legacy
  schedule controls;
- topic create/edit/deactivate validation;
- member application activation, manual add, one-time token modal,
  deactivation, and participation history;
- topic epoch-duration edit, current-epoch card with UTC/local
  `window_closes_at` and countdown, roster snapshot, transition controls,
  invalid-action disabled states, judging deadline and outcome, and scheduler
  degradation display;
- recommendation matrix, signature/payload disclosure, aggregate derivation,
  and absences; and
- audit filters and redaction.

Use mocked API fixtures for browser rendering and backend integration tests for
domain correctness. Do not place real admin, analytics, or member credentials in
fixtures or snapshots.

### 8.3 Required repository checks

Run at minimum:

```text
bun run test
(cd backend && bun run test)
bunx playwright test frontend/test/browser/admin-view.spec.ts
bun run check-contract
bun run typecheck
```

Also run the repository’s analytics boundary, worker-role, swarm lifecycle,
and frontend route guard tests touched by these changes.

## 9. Delivery order

Implement in this order so every phase leaves a usable product:

1. migration `0017`, constraints, roster/session-event backfill, and audit helper;
2. guarded swarm domain transitions and roster-based aggregation;
3. admin DTOs/routes and queue scope/retry/schedule services;
4. analytics telemetry tables, authenticated write client, observer, and stage
   instrumentation;
5. admin shell, routing, overview, queue, and research read-only views;
6. topic (including epoch duration), member, and lifecycle mutation UI;
7. audit UI, all browser tests, integration tests, and documentation updates.

The first production deployment must run the migration before API or worker code
that writes the new columns/tables. API can be deployed next, workers after the
analytics telemetry endpoints exist, and the frontend last.

## 10. Definition of done

The phase is done when all user stories in section 4 pass, no existing public
swarm/research route regresses, production admin and telemetry routes fail
closed, a research job can be traced through all six stages, and a swarm
manager can create a topic and set its epoch duration, manage members,
observe the current epoch and each session's state and judging outcome,
inspect every accepted member datapoint, fire guarded lifecycle transitions,
and explain every mutation from the audit log.

---
