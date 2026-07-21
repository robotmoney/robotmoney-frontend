# Admin Surface: Research and Investment Committee

Status: implementation specification  
Audience: engineering agents implementing the next admin phase  
Route: `/admin` and `/admin/*` (not linked from public navigation)

## 1. Outcome

Build one authenticated operator surface that lets a Robot Money administrator:

1. diagnose every run of the research pipeline from source access through the
   public report;
2. inspect and safely rerun queue work;
3. create and manage Investment Committee topics;
4. add, activate, deactivate, and review committee members;
5. schedule a committee session and observe its lifecycle;
6. inspect the exact roster, brief inputs, signed member recommendations,
   absences, aggregate, and publication for a session; and
7. see an immutable audit trail for every admin mutation.

An implementation is complete only when an admin can perform these workflows
without SQL access, shell access, or manual calls to the existing committee
admin dispatcher.

## 2. Decisions fixed by this specification

These decisions are not open implementation questions:

- Keep the existing `ADMIN_TOKEN` and `X-Admin-Token` authentication model.
  Role-based admin accounts are out of scope for this phase.
- Keep the buildless Alpine frontend and the frontend-to-backend HTTP boundary.
- Keep the Postgres queue as the executor. Admin requests enqueue lifecycle and
  research work; the browser never runs domain operations itself.
- Preserve accepted committee recommendations as append-only signed records.
  Admins cannot edit or delete them.
- “Remove member” means deactivate. No committee member is hard-deleted.
- “Topic” is the UI term; `committee_subjects` remains the database and API
  domain term.
- The persisted committee states are exactly `scheduled`, `collecting`,
  `window_closed`, `aggregated`, `published`, and the new terminal state
  `cancelled`. There is no persisted `brief_published` state in the product.
- A committee session snapshots its expected roster when it is created.
  Later global member changes do not rewrite that roster or historical quorum.
- Research recovery reruns a complete tool. Individual stages are not retried
  because the current stages share in-memory data and are not independently
  executable.
- Analytics natural-key rows remain current-value projections and may be
  upserted by a rerun. The new run/stage records preserve who ran what, the
  before/after checksums, warnings, and outcome; this phase does not introduce
  versioned copies of every raw time-series row.
- The seeded recurring committee schedules remain disabled. Product committee
  scheduling uses one-off queue jobs scoped to a specific session. Empty-payload
  recurring rows cannot identify a subject or session and must not be enabled by
  this UI.

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
  report`. The production jobs are `regime.classify` at 22:30 UTC and
  `research.refresh` at 23:00 UTC.
- The analytics worker must persist through the authenticated
  `/api/analytics/*` boundary. Migration `0016` denies its database role writes
  to analytics tables. New analytics telemetry writes must respect the same
  boundary.
- The current committee domain supports public reads, applications, activation,
  signed submissions, memos, subject creation, and the five-state lifecycle.
  Several lifecycle functions currently lack state guards; this plan adds them.
- Canonical accepted takes live in `committee_recommendations`, one per
  `(session_id, member_id)`, with replay protection on `(member_id, nonce)`.
  Invalid signatures are rejected before insert and are not retained. The admin
  UI therefore shows accepted submissions only; rejected submission-attempt
  forensics are out of scope.
- Public committee DTOs intentionally omit secrets and admin metadata. Admin DTOs
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

As an admin, I can see current failures, stale research, active committee work,
and the next scheduled events on one page.

Acceptance:

- Overview cards show queue counts, last success/failure by production kind,
  stale analytics outputs, the next enabled analytics schedules, and the next
  committee session event.
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

- One `regime.classify` attempt creates one analytics run with the `regime` tool.
- One scheduled `research.refresh` attempt creates one analytics run containing
  `channel-divergence` and `late-cycle-signals` tool traces.
- A manual single-tool research rerun creates a `research.refresh` run containing
  only the requested research tool.
- The list shows run id, job id, attempt, source mode, as-of date, tools,
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

### US-R4 — Rerun research safely

As an admin, I can rerun a failed, degraded, or stale research tool for an
explicit as-of date.

Acceptance:

- The form requires `kind`, `asof`, and a reason of 10–500 characters.
- `regime.classify` only permits tool `regime`.
- `research.refresh` permits either both research tools or exactly one of
  `channel-divergence` and `late-cycle-signals`.
- The API inserts a new pending job with a unique manual dedupe key and returns
  202 with the job id. It never resets or mutates the original job.
- The queue payload records only `asof`, optional `toolId`, and an internal
  audit request id. The human reason is stored in audit data, not copied into
  worker logs.
- A rerun may upsert existing natural keys. The store stage records before and
  after checksums so the admin can see whether the canonical output changed.

### US-Q1 — Inspect and retry queue work

As an admin, I can filter queue jobs and create a safe retry of dead work.

Acceptance:

- Existing queue screens remain available under `/admin/queue`.
- Filters cover kind, job status, run status, scope type/id, and created range.
- Job detail includes payload, dedupe key, worker lock, attempts, every run, and
  any linked analytics run or committee session.
- “Retry” is available only for a `dead` job. It clones kind/payload/priority into
  a new pending job, gives it a unique manual dedupe key, and audits the source
  and new job ids. It never changes the dead row.
- Schedule editing is limited to enabled/disabled for existing analytics
  schedules. Cron, timezone, kind, and payload are read-only in this phase.
- The five disabled recurring `committee.*` rows are labelled “legacy/demo —
  not product scheduling” and cannot be enabled from the UI.

### US-C1 — Create and edit a committee topic

As a committee manager, I can add a topic and make it eligible for future
sessions.

Acceptance:

- Create and edit support every durable `committee_subjects` field.
- New topic ids match `^[a-z0-9][a-z0-9-]{1,63}$` and are immutable after create.
- Required fields are id, name, operator, thesis, source type, and
  recommendation type.
- Source type is `rpc`, `manual`, `vault_tvl`, or `framework`.
- Recommendation type is `position_actions` or `bucket_weights`.
- Wallet and NFT entries have `address`, `chain`, and optional `label` strings.
  `framework` requires an empty wallet array; `rpc` requires at least one wallet.
- `linkedMemberId`, when present, must reference an existing member.
- Deactivation sets `status = 'inactive'`. It prevents new sessions but leaves
  old sessions, briefs, snapshots, and recommendations unchanged.
- Edits require the current `version`; a stale version returns 409.

### US-C2 — Review and manage committee members

As a committee manager, I can review applications and manually manage the
roster without destroying history.

Acceptance:

- Roster filters are `applied`, `active`, and `inactive`.
- Member detail includes profile fields, contact email, application status,
  timestamps, active-key metadata, participation history, and audit events.
  It never returns `token_hash` or any bearer token already issued.
- Activating an applicant uses the existing pending public key, marks the
  application approved, and returns a new bearer token exactly once. The UI
  presents a copy-and-dismiss panel and cannot retrieve the token later.
- Manual add requires member id, name, public key, and optional profile/contact
  fields. It creates an active member, one active key, and returns a bearer token
  exactly once.
- Deactivate changes the member to `inactive` and deactivates all member keys in
  the same transaction. Existing recommendations and roster snapshots remain.
- Reactivate requires a new public key. It inserts a new active key, keeps old
  keys inactive, returns a new bearer token once, and sets status active.
- Key rotation for an active member likewise requires a new public key and
  atomically revokes old keys before issuing a new token.
- Rejecting an application sets its application status to `rejected`, sets the
  member inactive, and leaves its key inactive.
- `COMMITTEE_ROSTER_CAP` is HARD-ENFORCED on every transition-to-active. The
  production admin API (manual add, activate/approve, reactivate — and the demo
  `registerMember` shortcut) refuses an admission that would exceed the cap with
  a 409, race-safely (a transaction-scoped advisory lock serializes admissions
  so two concurrent activations cannot both slip past the last free seat).
- All writes require the current member `version`; stale writes return 409.

### US-C3 — Schedule and observe a committee session

As a committee manager, I can select a topic and schedule its collection and
publication times.

Acceptance:

- The create form requires an active topic, session date, brief-open timestamp,
  window-close timestamp, publish timestamp, and reason.
- Times are ISO 8601 instants. Validation is
  `briefOpensAt < windowClosesAt < publishAt` and session date equals the UTC date
  of `briefOpensAt`.
- `(date, subject_id)` remains unique.
- Creation inserts the session in `scheduled`, snapshots all currently active
  members into `committee_session_members`, and enqueues four one-off jobs:
  `publish_brief` at brief open, `close_window` at window close, `aggregate` one
  second after close, and `publish` at publish time.
- Each job has `scope_type = 'committee_session'`, `scope_id = session UUID`, and
  dedupe key `committee:<session-id>:<action>`. Repeated creation or enqueue does
  not duplicate jobs.
- Session detail presents the timeline in UTC and browser-local time, linked job
  states, countdown, expected roster, response count, and next legal action.
- Members activated after creation are not automatically added. Before the
  session reaches `collecting`, an admin may explicitly add or excuse a roster
  member. Once collecting starts, the roster is immutable.

### US-C4 — Operate guarded committee transitions

As a committee manager, I can run or recover a session lifecycle without
creating impossible state.

The transition matrix is authoritative:

| From | Action | To | Conditions |
|---|---|---|---|
| `scheduled` | publish brief | `collecting` | topic active; expected roster non-empty; brief is upserted; absolute close time is in the future |
| `scheduled` | cancel | `cancelled` | reason required; pending scoped lifecycle jobs become cancelled |
| `collecting` | close window | `window_closed` | normal schedule or manual early close with reason |
| `window_closed` | reopen | `collecting` | exceptional reason and new future close time required; aggregate/publish jobs are rescheduled |
| `window_closed` | aggregate | `aggregated` | roster snapshot exists; aggregate only accepted verified recommendations |
| `aggregated` | publish | `published` | aggregate and synthesis are present |

All other transitions return 409. Repeating an action already reflected in state
returns 200 with `{ idempotent: true }` only when the target state and associated
artifact already exist; it must not rewrite timestamps or enqueue duplicate jobs.
`published` and `cancelled` are terminal in this phase.

Manual actions enqueue the same worker kind used by scheduled actions and return
202 with a job id. `cancel` and `reopen` add `committee.cancel` and
`committee.reopen_window` worker kinds so every transition remains observable in
the committee lane.

### US-C5 — Inspect member datapoints and aggregation

As a committee manager, I can inspect what every expected member supplied and
how the aggregate was derived.

Acceptance:

- The roster matrix derives one row per `committee_session_members` row and
  reports `expected`, `excused`, `submitted`, or `absent`.
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
- No admin endpoint can update `committee_recommendations`.

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

### 5.3 Committee integrity and scheduling

Add `version int NOT NULL DEFAULT 1` and `updated_at timestamptz NOT NULL DEFAULT
now()` to `committee_members`, `committee_subjects`, and `committee_sessions`.

Add to `committee_sessions`:

```text
brief_opens_at timestamptz
publish_at timestamptz
cancelled_at timestamptz
```

Keep existing `window_closes_at` and `published_at`. Add a state check allowing
the six states in section 2. Validate existing values before validating the
constraint. Add foreign keys from sessions/recommendations/snapshots/briefs to
subjects only after a migration query proves there are no orphan subject ids;
otherwise insert placeholder inactive subjects for the orphan ids first.

Create `committee_session_members`:

```text
session_id uuid references committee_sessions(id) on delete cascade
member_id text references committee_members(id)
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
- for sessions with `committee_recommendation.quorum.active`, add currently
  active members until the recorded active count is reached, ordered by member
  id; and
- if the exact historical roster cannot be reconstructed, retain the row set and
  add an audit event `backfill_session_roster` with `scope.approximate = true`.

Create `committee_session_events`:

```text
id bigserial primary key
session_id uuid references committee_sessions(id) on delete cascade
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
session_id uuid references committee_sessions(id) on delete set null
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
- Add committee mutations to `backend/src/committee/domain.ts` or focused
  modules under `backend/src/committee/`; both REST and workers call the same
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
| `POST /api/admin/jobs/:id/retry` | clone a dead job |
| `GET /api/admin/runs` | retain queue-run feed and add filters |
| `PATCH /api/admin/schedules/:id` | toggle an analytics schedule only |
| `GET /api/admin/research/runs` | analytics-run list |
| `GET /api/admin/research/runs/:id` | stages, artifacts, linked queue runs |
| `GET /api/admin/research/series/:indicator` | allowlisted raw history range |
| `GET /api/admin/research/signals/:key/:date` | stored signal payload |
| `POST /api/admin/research/runs` | enqueue manual rerun |
| `GET /api/admin/committee/overview` | session/member/topic summary |
| `GET/POST /api/admin/committee/subjects` | list/create topics |
| `GET/PATCH /api/admin/committee/subjects/:id` | topic detail/edit |
| `POST /api/admin/committee/subjects/:id/deactivate` | deactivate topic |
| `GET /api/admin/committee/members` | all statuses/applications |
| `GET /api/admin/committee/members/:id` | private admin member projection |
| `POST /api/admin/committee/members` | manual active member add |
| `PATCH /api/admin/committee/members/:id` | profile fields only |
| `POST /api/admin/committee/members/:id/activate` | activate applicant |
| `POST /api/admin/committee/members/:id/deactivate` | deactivate and revoke keys |
| `POST /api/admin/committee/members/:id/reactivate` | new key/token and activate |
| `POST /api/admin/committee/members/:id/rotate-key` | rotate active key/token |
| `POST /api/admin/committee/members/:id/reject` | reject application |
| `GET/POST /api/admin/committee/sessions` | list/create scheduled session |
| `GET /api/admin/committee/sessions/:id` | complete operational session DTO |
| `PATCH /api/admin/committee/sessions/:id/roster` | add/excuse before collecting |
| `POST /api/admin/committee/sessions/:id/actions/:action` | enqueue transition |
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

type SessionCreateRequest = {
  subjectId: string;
  date: string; // YYYY-MM-DD
  briefOpensAt: string; // ISO instant
  windowClosesAt: string; // ISO instant
  publishAt: string; // ISO instant
  reason: AdminReason;
};

type RosterPatchRequest = {
  version: number;
  operation: "add" | "excuse" | "restore";
  memberId: string;
  reason: AdminReason;
};

type SessionActionRequest = {
  version: number;
  reason?: AdminReason; // required for cancel, early close, reopen, manual retry
  windowClosesAt?: string; // required for reopen
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

For a manual lifecycle action, first locate the scoped job with the canonical
dedupe key. If it is pending, atomically move `run_after` to `now()` and return
that job with `existing: true`. If it is running, return it unchanged with
`existing: true`. If it is terminal or absent, enqueue a recovery job with
dedupe key `committee:<session-id>:<action>:manual:<audit-request-id>`. This is
how “run now” coexists with the four jobs created at scheduling time.

Reopen atomically changes the session to `collecting`, sets the new close time,
marks any pending canonical aggregate/publish jobs `cancelled`, and creates new
close/aggregate/publish jobs suffixed with the reopen event id. Cancel atomically
changes the session to `cancelled` and marks all pending scoped jobs cancelled.
Neither operation touches running or terminal queue rows.

The generic existing `/api/committee/admin/:action` endpoints remain for demo
compatibility but the new browser must not call them. Mark `reset` and
`subject_fixtures` dev/demo-only and return 403 for them when `RM_ENV=prod`.

### 6.4 Required domain corrections

Before wiring UI controls, correct these current behaviors:

- `openSession` must not reset an existing non-scheduled session to `scheduled`.
  On conflict return the existing row idempotently only when it is already
  scheduled; otherwise return 409.
- `publishBrief` must require `scheduled`, a real active subject, a non-empty
  roster snapshot, and an absolute future close timestamp.
- Brief regime data and research signals must be the latest rows at or before the
  session date; do not require an exact signal date and do not read future data.
- `closeWindow` must detect a zero-row guarded update and return 409 instead of
  reporting a transition that did not occur.
- `aggregateSession` must require `window_closed`, read expected members from
  `committee_session_members`, and use the latest subject snapshot at or before
  the session date.
- `publishSession` must require `aggregated` and non-null recommendation and
  synthesis.
- `submitRecommendation` must require an `expected` roster row for the member.
- `registerMember` and `resetSessions` remain demo helpers and are not used for
  production admin workflows.
- Every transition writes `committee_session_events` and `audit_log` in the same
  transaction as the state update.

## 7. Frontend implementation

### 7.1 Routing and structure

Use one admin shell for:

- `/admin`
- `/admin/research`
- `/admin/research/runs/:id`
- `/admin/queue`
- `/admin/committee`
- `/admin/committee/subjects/:id`
- `/admin/committee/members/:id`
- `/admin/committee/sessions/:id`
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
- Show UTC first for committee schedules, with browser-local time secondary.
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
- session creation snapshots the roster and creates exactly four deduped jobs;
- each legal state transition, every illegal transition, idempotent repeats,
  cancel, and reopen;
- member changes after session creation do not alter historical quorum;
- submissions from members outside the session roster are rejected;
- aggregation uses the roster snapshot and at-or-before data only;
- analytics run/stage/artifact recording, redaction, preview limits, and missing
  telemetry warning behavior;
- dead-job retry clones rather than mutates; and
- schedule PATCH cannot modify cron/kind/payload or enable committee demo rows.

### 8.2 Browser tests

Expand `frontend/test/browser/admin-view.spec.ts` into focused cases for:

- login, persisted tab session, 403 logout, navigation, and browser back/forward;
- overview alerts and polling pause;
- research list filters, stage timeline, artifact preview, raw-series navigation,
  and rerun confirmation;
- queue filters, job detail, dead-job retry, and schedule toggle;
- topic create/edit/deactivate validation;
- member application activation, manual add, one-time token modal,
  deactivation, and participation history;
- session create, UTC/local schedule, roster snapshot, transition controls,
  invalid-action disabled states, and linked jobs;
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

Also run the repository’s analytics boundary, worker-role, committee lifecycle,
and frontend route guard tests touched by these changes.

## 9. Delivery order

Implement in this order so every phase leaves a usable product:

1. migration `0017`, constraints, roster/session-event backfill, and audit helper;
2. guarded committee domain transitions and roster-based aggregation;
3. admin DTOs/routes and queue scope/retry/schedule services;
4. analytics telemetry tables, authenticated write client, observer, and stage
   instrumentation;
5. admin shell, routing, overview, queue, and research read-only views;
6. topic, member, roster, scheduling, and lifecycle mutation UI;
7. audit UI, all browser tests, integration tests, and documentation updates.

The first production deployment must run the migration before API or worker code
that writes the new columns/tables. API can be deployed next, workers after the
analytics telemetry endpoints exist, and the frontend last.

## 10. Definition of done

The phase is done when all user stories in section 4 pass, no existing public
committee/research route regresses, production admin and telemetry routes fail
closed, a research job can be traced through all six stages, and a committee
manager can create a topic, manage members, schedule a roster-snapshotted
session, inspect every accepted member datapoint, operate guarded lifecycle
transitions, and explain every mutation from the audit log.
