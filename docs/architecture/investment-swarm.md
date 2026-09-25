# Investment Swarm

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 9. Investment Swarm (feature architecture)

> Status: design reference for the IC feature (built in Phase 5). It reuses the
> shared infrastructure above — the boundary (§3), the buildless frontend (§4), the
> Bun server (§5) and Postgres (§6) — and adds a signed-submission protocol
> over the REST API. Session timing and lifecycle are owned by
> [system-scheduler-spec](../technical/system-scheduler-spec.md); deployment,
> credentials and participants by
> [smoke-production-spec](../technical/smoke-production-spec.md). Neither is
> shipped yet; where this section names the legacy worker path it says so.

The IC's value is the **structured, signed, attributable recommendation record** —
not the reasoning. Swarm members are **autonomous third parties** who run their
own data/agent/model and publish their own memos; their only obligation is to POST
a schema-valid, **signed** recommendation before a session's window closes. Robot
Money is the **protocol host + optional data utility**, never a swarm
participant. **RM generates no member content**: a member who does not submit is
recorded as **absent**, never fabricated. No blockchain in v0 (signature anchoring
is a stubbed seam, §9.3).

**Concept model — one swarm, many of everything else.** There is exactly
**one** Investment Swarm. It has many **members** (the autonomous third parties
above, each with an analytical lens — macro risk, on-chain flows, momentum,
contrarian); it reviews many **subjects** (the portfolios/wallets under review,
e.g. `woon`/Woon Treasury, `mav`/Mav Holdings); and it runs many **sessions** —
one per **epoch** of a subject, back to back, so a subject can run several
sessions on one date. A session is identified by its id, not by a date; the
only uniqueness the database enforces is at most one `collecting` session per
subject ([scheduler spec §2.1](../technical/system-scheduler-spec.md#21-the-model)).
Each session advances through
`collecting → window_closed → aggregated → [judging → judged] → published`
(§9.4). `judged` is optional — see §9.7. A member may amend its signed **recommendation** (a "take") while the window
is open, and exactly one of its takes per session is final ([D51](../decisions.md#d51)); a non-submitting member is recorded **absent**, never fabricated. The
plurals (members / subjects / sessions / takes) are the moving parts — they are
**not** multiple swarms.

### 9.1 Where the IC lives

It spans the layers but only through the contract (§3).

| Layer | IC responsibility |
|---|---|
| `contract/` | `ROUTES.swarm` + `swarm.d.ts` DTOs — the only thing crossing boundaries. |
| `backend/` | API routes (`src/api/routes/swarm.ts`), swarm Postgres tables, and the state-guarded lifecycle transition endpoints that `system-scheduler` calls (§9.4). The `api` process is the only service in the swarm scope that holds a database credential. |
| `system-scheduler` | One container. Holds an API automation token only. Fires each subject's epoch boundary and drives settlement through the API; subscribes to the API's event stream. Not in `contract/`: it is an API client ([scheduler spec §1](../technical/system-scheduler-spec.md#1-roles)). |
| `frontend/` | Read-only swarm views (members/subjects/sessions/apply) reaching the API via `app/lib/api.js`. |

All three depend only on `contract`; `frontend/` reaches `backend/` solely over
HTTP. A member's agent participates the same way — plain HTTP calls to the REST
API, following the `swarm-onboarding` skill (§11 R4/R5) rather than
connecting to any RM-hosted service; nothing RM-hosted to install (D21 retired
the earlier MCP-server surface).

### 9.2 Actors & trust model

| Actor | Identity | Scoped writes | Reads |
|---|---|---|---|
| **Swarm member** | access-key hash for identity; **signing key** for authorship | their **own signed recommendations** (scoped to `member_id`) | briefs, regime, published sessions |
| **RM analytics provider** | its analytics service token, issued by the API's token store | **regime snapshots** (+ RM-run subject snapshots) | — |
| **`system-scheduler`** (the clock) | API automation token; no signing key, no database password, no model key | lifecycle transitions only: open, turn over, aggregate, request judging, finalize — each a state-guarded API call | subjects, sessions, the event stream |
| **Consensus judge** (a participant) | a member with the `judge` role (issue 812): its bearer token, signing key and model key, all from its own `credential.json` entry | its **own signed judgement** for a `judging` session | pending judging requests via its subscription |
| **API** | the only swarm-scope service with a database role password | performs every transition as one guarded transaction; serves subscriptions; no background orchestration | all |
| **Public reader** | anonymous | nothing | published sessions, regime, memo links |

**Core invariant:** every write is an authenticated, authorized, *scoped* action —
a member cannot write regime data; the analytics provider cannot post a
recommendation; neither can mutate sessions; the scheduler can move a session
between states but signs nothing and reads no table directly. Member,
judge and analytics-provider are *roles*; any can be a genuine third party
with no architectural change. Credential kinds and holders are in
[scheduler spec §7](../technical/system-scheduler-spec.md#7-credentials).

### 9.3 The protocol = two contracts

**Submission** (`SwarmSubmission` in `swarm.d.ts`, POST
`ROUTES.swarm.submit`): `{ memberId, date, subjectId, nonce, stance,
confidence, body | memoUrl, signature }`. The structured stance/confidence (+ typed
recommendation shape) is the canonical machine-readable commitment; long-form prose
can live at a member-hosted `memoUrl` the report links out to.

**Signature envelope** — two independent checks on every submission:
- **Transport/identity** (*who is calling*): the access-key hash
  (`backend/src/lib/keys.ts`, sha256, never plaintext).
- **Authorship** (*whose take this is*): the `signature` over the canonical payload,
  produced member-side and verified against the member's registered public key. **RM
  never holds the private key.**

v0 stores payload **and** signature in Postgres. Activating chain settlement later =
add an anchor step writing *only the signature* (or a commitment) to a contract —
nothing else changes.

### 9.4 Data model & session lifecycle

A swarm migration extends §6 with append-only, audit-flavored tables:
`swarm_members`, `swarm_member_keys` (public-key + access-key-hash
registry), `swarm_subjects`, `swarm_sessions`, `swarm_briefs`,
**`swarm_recommendations`** (append-only — payload + signature + nonce +
`revision` + `verified` + `final`; the canonical store behind a take/submission.
A member may amend while the window is open: each amendment is its own signed
row, accepting it marks it final and unsets the prior, and a partial unique
index on `(session, member) WHERE final` keeps exactly one final take
([D51](../decisions.md#d51)). A retry resends the same signed nonce and returns
the existing row. Legacy rows with `revision > 1` from the D33 era stay
readable; no take's content is ever edited in place),
`swarm_subject_snapshots`, and `audit_log` (actor, action, scope, ts). Regime
data is written by the analytics provider (§9.6).

**`system-scheduler` is the orchestrator** — there is no GitHub-Actions cron
and, in the target, no queue job for the swarm lifecycle. The full contract
is [system-scheduler-spec §§2–4](../technical/system-scheduler-spec.md#2-epochs);
this is the summary, not a second copy:

```
collecting → window_closed → aggregated → [judging → judged] → published
```

- **Epochs.** A subject's sessions run back to back, closing on a fixed
  wall-clock **grid**: `epoch_anchor + k × epoch_duration`. Those two columns
  and a `judging_duration` are the whole schedule, set by bootstrap data and
  changed afterwards only through the admin API. A late turnover never shifts
  later windows, and downtime skips to the next future grid instant. There is no
  `scheduled` state, no "brief opens later," no on/off switch and no idle gap
  (§§2.1–2.4).
- **Open is atomic.** Opening an epoch creates the session, publishes its
  brief and sets `window_closes_at` to the next grid instant in one API call. The
  session is `collecting` from its first instant (§4.1). A brief is keyed on
  its **session** (migration 0028), not on the day.
- **Window.** Members submit via the REST `submit` endpoint, which calls the
  domain handler. A submission after `window_closes_at` is refused regardless
  of state (§4.2).
- **Turnover.** At the boundary the scheduler calls **turn over** naming
  `expected_session_id`. In one transaction the API closes N (recording one
  durable `absent` agent-health event per seated member with no take, §9.4.1),
  opens N+1, and records the turnover. Turnover is bound to the named epoch;
  a retry or a stale timer never closes the successor (§4.3). Only the
  scheduler turns an epoch over; there is no operator early turnover, and the
  operator admin token is refused on every epoch lifecycle route
  ([D55](../decisions.md#d55)). Only an admin deactivates a subject, as a
  subject edit; the scheduler never does. The deactivation closes the open
  epoch in the same transaction and opens no successor, and the scheduler
  settles the closed epoch from `subject.changed` (§4.5).
- **Settlement** of N is independent of N+1's window and of every other
  subject (§4.4): **aggregate** (deterministic rollup **over the takes
  actually posted**; absences stay absent; **no host-authored takes**) →
  **judge** under the mode captured at turnover (`off` or `enforce`, D48;
  under `enforce` the API stores an absolute deadline and pushes the request
  to the judge participants) → **finalize** → **publish**.
- **Judging outcome** is decided once by finalize from stored instants and is
  one of `judged`, `no_consensus`, `not_judged`. It is recorded on the session
  separately from the lifecycle state, which ends at `published` in every case.
  Nothing is fabricated for a missing consensus.
- **Recovery.** The scheduler is either provably current (live stream, no
  sequence gap) or rebuilding from a full read; a missed boundary fires once
  on rebuild, never replayed into the past (§§3, 6).

Sessions run whether or not this host runs any in-house participant; third
parties may supply the entire roster
([smoke-production-spec §6.3](../technical/smoke-production-spec.md#63-sessions-are-independent)).

**Legacy implementation (as of 2026-09-23).** The running worker still drives
sessions through five `swarm.*` job kinds (`open_session`, `publish_brief`,
`close_window`, `aggregate`, `publish`, plus `judge`) on `job_schedules` cron
rows behind a `SWARM_SCHEDULES_ENABLED` switch, with a `scheduled` state and a
terminal `cancelled`. That path, the host session driver, and the `swarm`
worker lane are what the scheduler spec replaces; they are not target
requirements, and this document does not define how legacy in-flight sessions
convert.

#### 9.4.1 Agent health

A roster member missing its expected submission window, and a rejected/tampered
submission signature, were previously visible only in an agent's own stdout.
Both are now recorded on a durable, append-only `swarm_agent_health_events`
table (bounded, redacted `detail` — never a raw signature/public key/payload) and
exposed admin-only via `GET /api/swarm/admin/agent-health` (raw event history
+ per-type counts). There is no automatic dead-agent threshold — an operator reads
the history and decides.

### 9.5 Surfaces — one core, one transport

The backend is a **domain/service layer** (plain Bun/TS functions over Postgres:
`getRegime()`, `getBrief()`, `getSession()`, `verifyAndStoreSubmission()`,
`aggregateSession()`, …) where window enforcement, signature verification, and
authz live **once**. **REST/JSON** (`Bun.serve`, paths in `ROUTES.swarm`) is
the only transport — the website's transport and every member's transport (D21
retired the MCP transport that previously shared this layer). Reads public
(`members`, `subjects/:id`, `sessions`, `brief`); writes scoped (`apply` +
`apply/unlock`, `submit`, and a role-gated analytics `regime` write).

#### 9.5.1 Member surface — skill-taught, REST-only

A member's agent has nothing RM-hosted to connect to: it calls the REST API
directly. The **`swarm-onboarding` skill** — maintained for development and
evaluation at `frontend/public/skills/swarm-onboarding/SKILL.md` and
installed into the agent's own harness — is the procedure a member's owner
follows, and is itself the discovery mechanism. The production prompt retains
the published `robotmoney-core` URL; synchronizing an approved repo-owned skill
to that release location is a separate release concern, never a prerequisite
for local evaluation. It teaches installing and configuring the `rmpc` client
(keygen, canonical-payload signing) and then walks the agent through the REST
calls (`ROUTES.swarm.apply`, `signingPayload`, `submit`, `memos`).
**Signing stays member-side**: `rmpc` signs the canonical payload in the
member's own environment and the request carries the `signature`, which the
server only **verifies**. `ROUTES.swarm.signingPayload` returns the exact
canonical bytes to sign.

Endpoints exercised: **read** (`openSession`, `sessions`, `session`, `brief`,
`memberTakes`, `subjectSnapshots`); **write** (`signingPayload`, `submit` with
the member signature, `memos`). Participation is tool-agnostic and RM imposes
no model/framework/data source — the skill is documentation plus the `rmpc`
binary, not a service RM operates.

> Decision flag: member-side signing preserves the on-chain seam (§9.3) with a
> plain REST endpoint, at the cost of a member signing step. A simpler v0 could
> rely on the access-key hash alone and defer per-payload signatures, but that
> weakens the "signature anchors on-chain later" property. Default: keep member
> signing.

### 9.6 RM analytics provider (the data utility)

**Required boundary (D25).** The regime classifier runs on the provider's own
infrastructure and **submits computed regime snapshots through the authenticated
`/api/analytics` boundary under its exclusive scoped credential**
(its analytics service token; issue #106 — never direct SQL), the same pattern as a member
posting a take, different scope. Members consume it **optionally** via the regime
read (`ROUTES.dashboards.regimeSnapshots`) and may record which RM tools vs.
their own data they used. The API validates and persists provider output; it
does not run the provider's classifier, and an admin credential cannot
substitute for the analytics role.

**Implemented boundary.** `analytics-producer` has no database or admin
credential, owns the regime/research cron timers, computes on its side, and
submits through the typed analytics routes. Its token is a per-instance file
mounted only into the producer, and the API validates it against its token
store ([smoke-production-spec §3](../technical/smoke-production-spec.md#3-roles-and-credentials)); shared workers, the smoke host, and swarm
members do not receive it. Consumer schedules are disabled and legacy queued
analytics jobs are dead-lettered. Admin retry/toggle/rerun/enqueue operations and
the retired research-eligibility endpoint fail closed, so no supported consumer
path can substitute for the producer. Remaining legacy handler/lane code and the
old smoke TUI's queue-based analytics display are compatibility/observability
debt, not active producer paths.

### 9.7 The consensus judge

The portfolio allocation remains the deterministic output of
`meanTakeWeights()`; a judge may explain the result but does not choose or
rewrite weights. A valid model-authored judgement is a separate, attributable
record. If judging is unavailable, the session may publish without a judgement;
the system must never manufacture a template opinion.

The accepted go-forward mode is `off | enforce` ([D48](../decisions.md#d48)).
Existing code may still expose `shadow` until that accepted change ships;
D48 records the replay prerequisite for removing it.

For deployment, the judge is a roster participant like an agent. It runs in
its own standing container, receives only its own `credential.json`
entry (bearer token, signing key, model key), and talks to the stack over HTTP. No worker judges inline,
and no container in the stack — participant or service — holds a Docker
socket: `bun smoke` starts every container from the host and exits, so
nothing spawns a container at runtime and nothing needs the means to. This
reverses `#1014`, which had one socket-holding `agent-launcher` service inject
the judge's `OPENCODE_API_KEY` into a container it spawned for each judging;
that launcher, its socket mount and its injection are gone. Roster, lifecycle
and credential delivery are defined only by
[smoke-production-spec §3](../technical/smoke-production-spec.md#3-roles-and-credentials)
and [§6](../technical/smoke-production-spec.md#6-participants-agents-and-judges).
The admin API remains the sole writer of `swarm_judge_config`. A judge whose
member `operator` is `robotmoney` is in-house and passes the third-party gate;
any other judge's judgement is refused while `third_party_enabled` is false
([smoke-production-spec §6.2](../technical/smoke-production-spec.md#62-standing-participant-containers)).

Sessions run in epochs, timed per subject by `system-scheduler`, independent
of whether this host runs an in-house judge. Sessions have no schedule rows
and nothing to enable: a subject's grid and judging duration are set at
bootstrap and changed only through the admin API. See
[system-scheduler-spec](../technical/system-scheduler-spec.md) for the
scheduling architecture and
[smoke-production-spec §6.3](../technical/smoke-production-spec.md#63-sessions-are-independent)
for deployment behavior; D48 records the separate judge-mode product decision.
### 9.8 Testing and deployment

The E2E suite verifies signed submissions, session publication and visible product
behavior against its test stack. That test harness is not the production
participant supervisor or roster source.

The adopted deployment design defines standing participant containers,
HTTP-only interaction, isolated per-take processes and credentials, and the
production roster in [smoke-production-spec §6](../technical/smoke-production-spec.md#6-participants-agents-and-judges).
CI database setup and role checks are specified in §7.3. These are cutover
requirements, not a claim that the current smoke implementation or every CI job
already satisfies them.
### 9.9 Implementation history

The Phase 5 build order and prototype reconciliation are historical. The feature
is implemented; current product behavior is described in §§9.1–9.8 and its
current contracts. Recover the original plan from Git when investigating the
implementation history.
