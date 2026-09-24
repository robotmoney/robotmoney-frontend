# System scheduler spec

> **Status: second draft, 2026-09-23; amended 2026-09-24 (§13). Prescriptive.** This document describes
> the scheduling architecture the system is to have. It does not describe the
> current implementation and does not inherit from it. Where it conflicts with
> code, the code is what changes. It sits beside
> [`smoke-production-spec.md`](./smoke-production-spec.md), which owns
> deployment, credentials and participants; this document owns how sessions are
> timed and driven once the stack is running. §12 lists the companion clauses
> this document supersedes on adoption.

---

## 1. Roles

Three things take part. Each has exactly one job.

| Role | Job | Database connection |
|---|---|---|
| **API** | Stores. Exposes authenticated endpoints to read subjects, read sessions, change a subject's scheduling columns, and perform each lifecycle transition. Serves the event stream to subscribers as part of handling their connections. Decides nothing about timing, beyond computing `window_closes_at` from the subject's grid when it opens an epoch. It runs no background orchestration of its own. | Yes — the only running service in this document's scope that holds one. |
| **`system-scheduler`** | Is the clock. Holds one timer per active subject, fires each subject's epoch boundary, drives settlement, and recovers all of it after any interruption. Subscribes to the stream. | **No.** Never. |
| **Participants** (agents, judges) | Do the work that needs a model: takes and judgements. Defined in `smoke-production-spec.md` §6. | No. |

`system-scheduler` is one long-running container. It replaces the process formerly called `worker-swarm`. There is no separate clock process and no separate executor process. Correctness does not depend on there being exactly one: two schedulers briefly overlapping during a deploy must produce the same results as one (§4.3, §10).

## 2. Epochs

### 2.1 The model

A subject's sessions run in **epochs**, back to back. Each epoch is one session. When epoch N's submission window closes, epoch N+1's window opens in the same transaction. There is no gap between epochs, no idle state, and no daily convene.

Two statements, kept separate because they have different strength:

- **Invariant, always true:** an active subject has **at most one** session in `collecting`. The database enforces it with a uniqueness constraint.
- **Liveness, true in normal operation:** an active subject has **exactly one** open window. The scheduler opens a missing one when it processes an activation or rebuilds (§3). Between an activation and the scheduler processing it, or during scheduler downtime, a subject can briefly have none. Bootstrap readiness (`smoke-production-spec.md` §6.3) requires every active subject's first epoch to exist before the stack is declared ready.

### 2.2 The schedule: a grid

Each subject's windows close on a fixed wall-clock **grid**. Three columns on the subject define it, and they are the whole schedule:

| column | meaning |
|---|---|
| `epoch_duration` | the spacing of the grid, and the length of every full window |
| `epoch_anchor` | one instant on the grid; every close is `epoch_anchor + k × epoch_duration` for some integer `k` |
| `judging_duration` | how long judging waits for a consensus after it is requested (§4.4); not part of the grid |

The grid keeps windows from drifting. A late turnover does not push later windows back, and a daily subject anchored after the analytics producer's 22:30 UTC regime refresh closes after it every day.

- **Turnover.** Epoch N+1 closes at the first grid instant after N's `window_closes_at` — on an unchanged grid, exactly `window_closes_at + epoch_duration`. If that instant has already passed, it closes at the first grid instant after now instead. Missed slots are skipped, never opened (§3.2). An operator's early turnover (§4.3) follows the same rule, so the next window runs to the grid instant after the early-closed window's scheduled close and is longer than one duration.
- **First epoch.** An epoch opened with no predecessor (a fresh database, an activation, a reactivation) closes at the first grid instant at least **half of `epoch_duration`** after now; if the next instant is nearer than that, it closes at the one after. Its window is therefore between half a duration and one and a half, never a sliver. Without the floor, a subject activated moments before a grid instant would open a window nobody can submit into and then publish a session recording every seated member absent.
- **Duration change.** Changing `epoch_duration` through the admin API also sets `epoch_anchor` to the current window's `window_closes_at`, in the same transaction; a subject with no open window keeps its anchor. The current window is unchanged, and the grid continues from its close with the new spacing.

### 2.3 Where it lives and who sets it

`epoch_duration`, `epoch_anchor` and `judging_duration` are columns on the subject.

- On a **blank database** they are set by the bootstrap data in the schema snapshot (`smoke-production-spec.md` §8.1), once, at initial migration.
- Afterwards they are changed only through the **admin API**, as an ordinary authenticated update to the subject.

No environment variable sets them. No seed command sets them. No boot overwrites them on a populated database. A rehearsal that wants short epochs or a short judging wait on a copy of production changes the subjects through the admin API.

### 2.4 Never disabled

There is no on/off state for scheduling. Activating a subject opens its first epoch (§3). A subject that must stop running epochs is deactivated, and deactivation closes its open epoch and settles it (§4.5).

## 3. The clock

`system-scheduler` is the clock. It holds one timer per active subject: the instant that subject's current epoch closes. It also holds one timer per session in `judging`: that session's judging deadline (§4.4). On start, and on every rebuild, it performs a **full read** through the API:

1. Every active subject, with its scheduling columns (§2.2).
2. Every session in `collecting`, with its `window_closes_at`.
3. **Every session that is closed but not yet `published`** — in `window_closed`, `aggregated`, `judging` or `judged` — with its state, and for `judging` its recorded deadline. A recovered `judged` session proceeds straight to finalize. This includes sessions whose subject has since been deactivated; deactivation closes an epoch but settlement still has to finish.
4. The stream cursor the API returns with the read (§6.3).

Then it sets a boundary timer per collecting session, a deadline timer per judging session, resumes every unfinished settlement from its recorded state, opens an epoch for every active subject that has none, and waits until the earliest timer. Fire it. Recompute. Repeat.

**An active subject with no session in `collecting` is opened immediately** as part of the rebuild — a fresh database, a subject activated while the scheduler was down, a subject deactivated and re-activated. Nothing else opens a first epoch.

It fires at the instant. It does not poll the API on an interval. It does not tick.

### 3.1 The clock is current, or it is rebuilt

The clock's copy of the world is current if and only if: its stream connection (§6) is live, and it has applied every event with a sequence number above its full read's cursor, in order, with no gap. When both hold, it acts. When either fails, it stops acting, performs a full read, rebuilds every timer, and resumes.

There is no third state. The clock never reconciles on a timer, never re-reads "just in case", and never acts on a copy it cannot prove is current.

### 3.2 Downtime, and what happens after it

**Downtime is any interval during which the clock was not current under §3.1.** That covers four cases, treated identically:

- the process was not running — a crash, a restart, a redeploy;
- the process was running but its stream connection was down;
- the process was running and connected but detected a sequence gap;
- the API told it to resync (§6.3).

In every case the clock stops acting at the start of the interval and rebuilds at the end of it.

**On rebuild, for each collecting session whose `window_closes_at` fell inside the interval:** fire the boundary once, now, against that session (§4.3). That closes it, opens a fresh one closing on the next future grid instant (§2.2), and starts its settlement. **Missed boundaries are not replayed.** A subject that should have turned over three times during a two-day outage turns over once, on rebuild, and its next window still closes on the grid. Epochs are not opened into the past.

**For each unfinished settlement:** resume it from its recorded state (§4.4). A `judging` session whose recorded deadline has already passed is finalized immediately; one whose deadline is still ahead gets its timer reconstructed from the recorded instant, never restarted from now. Every settlement step is state-guarded (§5), so nothing runs twice.

## 4. The session lifecycle

### 4.1 Epoch open

Opening an epoch is one API call that does three things atomically: create the session, publish its brief, and set `window_closes_at` to the first grid instant after now (§2.2). The session is `collecting` from its first instant. There is no `scheduled` state and no "brief opens later." The uniqueness constraint in §2.1 makes two concurrent first-openings for one subject yield one session; the second call returns it.

### 4.2 The submission window

While a session is `collecting` **and now is before its `window_closes_at`**, participants submit takes through the API. The advertised instant is the contract participants are bound to, not the state: a submission after `window_closes_at` is refused even if delayed turnover has not yet moved the session out of `collecting`. Absences (§4.3) are judged against the same instant, so accepted takes and recorded absences can never disagree about who was on time.

**One clock.** Every comparison of the present against a stored instant — a take against `window_closes_at`, an absence, a consensus against the judging deadline, finalize's time guard — reads the database clock with `clock_timestamp()` at the moment of the comparison. Never the application's clock, and never `now()`, which is the transaction's start time and would let a slow transaction accept a late take. A **derived** instant, such as the next grid close, is computed once per transaction from a single read of that clock and reused, so one transaction never acts on two different presents. The instants the API stores come from the same clock.

The window is the only scheduled part of a session's life. The judging deadline is a timeout inside settlement, not a schedule (§6.1).

### 4.3 The boundary

When a session's boundary timer fires, `system-scheduler` makes one API call: **turn over**, naming the epoch it intends to close — `expected_session_id`. The API, in one transaction and behind the state guard (§5): checks that the named session is the subject's current `collecting` session; closes it (`collecting → window_closed`, recording an `absent` event for each seated member with no take received before `window_closes_at`); opens epoch N+1 with its close set by the turnover rule of §2.2; and records the turnover. The scheduler then sets the subject's boundary timer to the new `window_closes_at` and starts settlement of N (§4.4).

**Turnover is bound to the epoch, never to "whatever is open."** If the named session is no longer the current collecting one — because this call is a retry after a lost response, because a stale timer fired after an operator's early turnover, or because a second scheduler got there first — the API returns the original turnover's result if it has one, or a reasoned no-op. It never closes the successor. This is what makes a repeated boundary safe under §5 and §10.

Turnover is the only way an epoch closes while its subject stays active. An operator ending a window early does it through the same endpoint with the same `expected_session_id`; the scheduler learns of it by event (§6.2) and treats it exactly as it treats its own.

### 4.4 Settlement

Closing an epoch starts its settlement, and settlement is **not scheduled**. It is a chain the scheduler drives through the API, each step as soon as the previous one returns. Settlement of session N and the open window of N+1 are independent: nothing about N blocks submissions to N+1, and nothing about one subject's settlement blocks another subject's boundary.

**Judge mode and judging duration are captured at turnover.** The session records the judge mode in force (`off` or `enforce`, per D48) and the subject's `judging_duration` at the instant it closes. An admin changing either afterwards affects later sessions, never one already settling.

**The judge of record.** A session has one **judge of record**, and its judgement is the session's consensus. An eligible judgement is signed by an active member holding the `judge` role that has no take in that session, and it passes the third-party gate of `smoke-production-spec.md` §6.2. Today one judge is seated, so the judge of record is that judge. If more than one is seated, the judge of record is chosen deterministically by member id — never by which judgement arrived first, so no judgement is selected by being fastest. Judgements from other seated judges are recorded and change no outcome. Agreement among several judges is a later amendment.

1. **Aggregate** — roll the signed takes up into the recommendation. `window_closed → aggregated`. Deterministic; the allocation arithmetic and the signed member history are the same whatever judging later produces.
2. **Judge** — branches on the captured mode:
   - **`off`:** no judging is requested and nothing waits. `aggregated → publish` directly, with judging outcome `not_judged`. This is not a failure and is never presented as one.
   - **`enforce`:** the scheduler requests judging. The API records the request instant and the **absolute deadline** (request instant plus the judging duration captured at turnover), moves the session to `judging`, returns the deadline, and pushes the request to the judge participants (`smoke-production-spec.md` §6). The scheduler holds a timer for that deadline. When the judges' consensus lands, the API records it with its acceptance instant, advances the session to `judged` if its state guard permits (§5), and publishes `session.judged`. A consensus that lands after the session is already `published` is recorded as late evidence and changes neither the lifecycle state nor the published outcome.
3. **Publish** — the session goes public, with its consensus certificate when one exists. `→ published`.

The scheduler waits for **either** `session.judged` **or** its deadline timer, whichever first, and then calls **finalize**. It never polls for the judgement.

**The event is a wake-up and nothing more.** It lets the scheduler finalize the moment consensus lands instead of waiting out the deadline. It decides nothing. Its arrival time is never compared to anything. A late event, a duplicate event, or a lost event changes no outcome: the scheduler finalizes on the deadline instead, and finalize reads the same stored facts.

**Finalize is one API call and decides the judging outcome atomically from stored data.** The API compares the stored consensus acceptance instant (if a consensus was recorded) against the stored deadline. Its outcome is one of:

- `judged` — a consensus was recorded at or before the deadline;
- `no_consensus` — no consensus was recorded at or before the deadline;
- `not_judged` — mode was `off`.

Then it publishes. A repeated finalize returns the outcome already decided; it never re-decides. A consensus recorded after the deadline is kept as a record but does not change a `no_consensus` outcome.

**Finalize is time-guarded as well as state-guarded.** Under `enforce`, the API accepts finalize before the deadline only if an eligible consensus is already recorded, in which case it publishes `judged` at once. With no eligible consensus it refuses finalize as a reasoned no-op until the deadline has passed by the database clock (§4.2), because absence of a consensus before the deadline proves nothing. At the exact deadline instant: a consensus recorded *at or before* it is eligible, and finalize is accepted *at or after* it. This is request validation, not an API timer; the scheduler still holds the deadline and issues the call.

**No consensus.** A session finalized as `no_consensus` is published in that state with no consensus certificate. Nothing is fabricated: no template opinion, no placeholder certificate, no default verdict. A session with no consensus says so. Its aggregate and its signed takes are published unchanged.

**`no_consensus`, `not_judged` and `judged` are outcomes recorded on the published session.** The lifecycle ends at `published` in every case. Note that `judged` is used in two senses and both are intended: as the **lifecycle state** a session holds between consensus being recorded and finalize (§3 recovers it), and as the **outcome** finalize records when that consensus was eligible. `no_consensus` and `not_judged` are outcomes only and never lifecycle states.

### 4.5 Deactivating a subject

Deactivating a subject through the admin API closes its open epoch (recording absences as in §4.3) and opens no new one. Settlement of that closed epoch proceeds and must finish; §3 step 3 includes it in every rebuild. The scheduler drops the subject's boundary timer on the `subject.changed` event and settles the closed epoch.

### 4.6 Transition calls that fail

A transition call from the scheduler can fail three ways, and they are handled differently:

- **A refusal with a reason** (the state guard, a bound epoch that is no longer current, a permanent validation error) is final. The scheduler records it, does not retry, and moves on. If the refusal means the work is already done — the original result is returned — the scheduler continues the chain from there.
- **A transient error or a lost response** is retried by the scheduler with bounded exponential backoff. Retrying is safe because every transition is state-guarded and turnover is epoch-bound. This applies to every call the scheduler makes — first opening, turnover, and each settlement step alike.

  **After the retry budget is exhausted, the work waits.** The scheduler leaves it in its recorded state, marks itself degraded on its health surface naming the subject or session and the last error, and stops retrying that item. It does not retry indefinitely and it does not reconcile on a timer. The work resumes on the next rebuild (§3), and the supported way to force one is to restart `system-scheduler`; any later downtime event also triggers it. This is deliberate: a dependency that has been failing for the whole retry budget is an operator's problem to see, not something to paper over with an infinite loop. A subject whose turnover is exhausted keeps its collecting session past `window_closes_at`; that is harmless, because §4.2 refuses submissions by instant, not by state, and the boundary fires once on rebuild.
- **A stream problem** is not a transition failure and is handled by §3.1, not here.

These retries are triggered by a failure and are bounded. They are not polling.

## 5. Transitions are state-guarded

Every transition endpoint checks the session's current state — and, for turnover, the named epoch — before acting, and refuses as a no-op with a reason if the transition is not valid. This is what makes the clock safe: a boundary fired twice, a settlement resumed after downtime, a stale timer, a second scheduler, and an operator firing a step by hand all reach the same guard. Where the transition has already happened, the guard returns the original result rather than a bare refusal, so a caller can tell "already done" from "not allowed."

## 6. Timed work, event-driven work, and the stream

### 6.1 Two kinds of work

- **Timed work** fires at an instant the clock already knows. There is one scheduled kind: the epoch boundary, one per active subject. The clock fires it directly; the API sends nothing, because the scheduler already holds the instant. The judging deadline (§4.4) is also a timer the scheduler holds, reconstructed from the instant the API stored, but it is a timeout inside settlement, not a schedule.
- **Event-driven work** fires because something happened. Settlement is driven by the scheduler as the direct consequence of a turnover — its own, or an operator's — and advanced by the `session.judged` event. An operator triggering a step is event-driven. A change to a subject's scheduling columns is itself an event.

### 6.2 Change events

Any write that alters what the scheduler is waiting on is published by the API as an event. The scheduler applies it by re-reading the affected thing through the API and resetting the affected timer.

| event | cause | scheduler does |
|---|---|---|
| `subject.changed` | a scheduling column changed (§2.2), or subject activated / deactivated | re-reads that subject; on activation opens its first epoch (§3); on deactivation drops its boundary timer and settles the closed epoch (§4.5) |
| `epoch.turned_over` | epoch N closed and N+1 opened — by the boundary or by an operator | sets that subject's boundary timer to the new `window_closes_at`; settles N if it is not already settling |
| `session.judged` | the judges' consensus was recorded | proceeds to finalize (§4.4) |

A duration change takes effect at the **next** boundary: the current window keeps the `window_closes_at` it was opened with, the grid is re-anchored at that instant (§2.2), and the epoch opened at that boundary uses the new duration. A change to `epoch_anchor` alone likewise leaves the current window alone and moves the grid from the next boundary. A change to `judging_duration` applies to sessions that close afterwards (§4.4).

### 6.3 Contract

**The read/stream handoff.** A full read is a consistent snapshot, and the API returns with it a **cursor**: the sequence number of the last event committed before that snapshot. The scheduler then subscribes from that cursor. Every committed change that the snapshot does not reflect has a sequence number above the cursor, and the API delivers those in order. Writes that land while the read is in flight are therefore either in the snapshot or on the stream, never lost between the two. The scheduler applies only events above its cursor and ignores any at or below it as duplicates.

- **Sequence numbers** are monotonic across the API's event log, not per connection. A reconnect that subscribes from an old cursor receives everything above it, in order.
- **Gapless, in commit order.** Each event takes its number by incrementing one counter row inside the transaction that makes the change. The row lock serializes event-writing transactions, so numbers are assigned in commit order and a rolled-back transaction leaves no hole. A database sequence must not be used: it assigns numbers at insert time, so a later number can commit first and move a subscriber's cursor past an earlier one still in flight, which the subscriber would then drop as a duplicate. The full read takes its cursor from the counter value visible in its own snapshot.
- **Duplicates** (a sequence number at or below the last applied) are ignored.
- **A gap** — a sequence number that is not the last applied plus one — means the copy is no longer provably current. Stop, full read, rebuild.
- **Retention.** The event log is append-only and is retained at least as far back as the oldest cursor the API may still be asked to serve. Pruning above that point is permitted; pruning below it is forbidden.
- **Resync.** If the API cannot serve from the requested cursor — its buffer for this subscriber overflowed, or the cursor is above the log's head — it says so, and the scheduler treats that as downtime (§3.2): full read, rebuild. The API never silently skips.
- **Silent failure detection.** The connection carries a transport-level keepalive (a WebSocket ping/pong or equivalent). A missed keepalive is a dropped connection under §3.1. This is a transport frame, not an API call, and not a read of business state; §10's no-API-call gate is stated accordingly.
- **The keepalive carries the head sequence.** Each keepalive from the API includes the sequence number of the last event it committed. A scheduler whose last-applied number is below that head has missed an event with no later event to expose the gap; it treats this exactly like a gap — stop, full read, rebuild. This closes the one loss sequence numbers alone cannot detect: the final event before a quiet period. It costs nothing beyond a number on a frame the protocol already requires, and it is not a read of business state.
- **A dropped connection** is reconnected with backoff and followed by a full read. The scheduler does not replay from its last cursor after a drop; it rebuilds. Rebuilding is cheap and provably correct; replay would have to be proven complete.
- **No job pushes.** The stream carries change events only. Every piece of work the scheduler does follows from an event or a timer; there is no ad-hoc job kind for the API to push, ack or redeliver.

Serving a subscription and writing an event's sequence number in the same transaction as the change it describes are the API's only stream duties. Neither is a background process.

## 7. Credentials

There are four kinds of credential in this system, and they must not be confused:

| kind | proves | held by | lives in |
|---|---|---|---|
| **Signing** — an Ed25519 key | authorship of a take or judgement | participants only | `credential.json` (`smoke-production-spec.md` §6.1) |
| **API** — a bearer token | that the caller may call the API | anything that calls the API | a service token (scheduler, analytics producer, operator admin) is a per-instance file whose hash and rights sit in the API's token store; a participant's bearer is in its `credential.json` entry (`smoke-production-spec.md` §3) |
| **Database** — a Postgres role password | that the process may open a database connection | the API and the pipeline worker, at runtime | `~/.env` (`smoke-production-spec.md` §3) |
| **Model** — a third-party LLM key (e.g. `OPENCODE_API_KEY`) | that the holder may call a model vendor | participants that call a model: agents, judges | each participant's own `credential.json` entry, delivered to its container only |

`system-scheduler` holds exactly one: an **API credential**, an automation token with the rights to read subjects and sessions and to perform lifecycle transitions. It signs nothing, so it has no signing key and no entry in `credential.json`. It never touches the database, so it has no role password. It calls no model, so it has no model key. It holds no Docker socket.

How that automation token is issued, validated, delivered and rotated is defined in `smoke-production-spec.md`: §3 for the token store and delivery, §9.1 for production, §5 for rehearsal (blank, dump, volume and remote rehearsal targets). Every environment in §8 obtains it by one of those two paths; none reuses another's.

## 8. Environments

The same `system-scheduler` image and code run in production, stage, test and CI. Only the subjects' scheduling columns differ: a blank database gets its bootstrap values, and any other environment changes them through the admin API. A test that needs a fast lifecycle sets short epoch and judging durations and runs the real scheduler; it does not bypass the scheduler.

## 9. Invariants

- **A transition transaction never spans a network call, a model call, or a wait on another service.** It does database work and commits. The event counter (§6.3) therefore serializes only database work, bounded by the slowest single transition. Without this rule, one transition holding its transaction open would stall every other subject's.
- Exactly two running services hold a database credential: `api`, and the pipeline worker running the vault, wallet, buyback and project jobs as `rm_worker` (`smoke-production-spec.md` §7.2). A third is a defect. The pipeline worker's move to the same no-database model is a later document.
- A subject's scheduling columns are set once by bootstrap and afterwards only by the admin API.
- Every window closes on its subject's grid. A late turnover never shifts later windows.
- Event sequence numbers are gapless and assigned in commit order.
- Every comparison against a stored instant uses the database clock.
- An active subject has at most one `collecting` session, enforced by the database.
- The submission window is the only scheduled part of a session. Settlement is never scheduled; the judging deadline is a timeout inside it.
- A submission after `window_closes_at` is refused regardless of state.
- Turnover is bound to a named epoch and never retargets its successor.
- `system-scheduler` never polls the API on an interval, and never re-reads on a timer. Failure-triggered, bounded retries are not polling.
- The clock is either provably current or rebuilding. There is no third state.
- Every change to what the clock waits on is an event on the stream, sequenced in the transaction that made the change.
- A fired transition is safe to fire again, and a repeated one returns the original result.
- A judging deadline is stored by the API when judging is requested and is never restarted by a rebuild.
- A session's judging outcome is decided once, by finalize, from stored instants, and is one of `judged`, `no_consensus`, `not_judged`. An event's arrival time never decides an outcome. Nothing is ever fabricated to fill a gap.

## 10. Acceptance gates

Timing gates distinguish **dispatch** (the scheduler issued the call at the instant) from **completion** (the API transaction committed); each names a tolerance.

- A blank-database boot sets every subject's `epoch_duration`, `epoch_anchor` and `judging_duration` from the snapshot; a boot on a populated database changes none of them.
- No service other than `api` and the pipeline worker carries a database credential in any composition, asserted by rendering the compose config; `system-scheduler` carries none.
- For an active subject, closing epoch N and opening N+1 happen in one transaction; turnover is dispatched within one second of `window_closes_at`; the new session's `window_closes_at` is the first grid instant after N's close, and a first epoch closes at the first grid instant after its open instant.
- **Epoch binding:** drop a successful turnover's response and retry; fire a stale timer after an operator's early turnover; race two schedulers against the same epoch. Each yields exactly one successor and one reasoned no-op or replayed result; N+1 is never closed by a retry aimed at N.
- Two concurrent first-openings for one subject yield one `collecting` session.
- Two subjects with different durations turn over independently at their own instants.
- **No drift:** a turnover dispatched late still gives N+1 a close on the grid; after ten epochs each close equals `epoch_anchor + k × epoch_duration` exactly.
- **Grid after downtime:** restart after two missed slots; the one turnover on rebuild gives N+1 the first future grid instant, never a past one and never `now + duration`.
- Changing a subject's duration through the admin API publishes `subject.changed` and re-anchors the grid at the current close in the same transaction; the current window is unaffected; the next epoch uses the new duration; no restart. Changing `judging_duration` leaves a session already settling on its captured value.
- A take submitted after `window_closes_at`, while the session is still `collecting` because turnover is delayed, is refused; a take submitted just before it is accepted; the member is not recorded absent.
- Settlement of a closed epoch runs aggregate, judge and publish with no scheduled delay between them.
- **Judge off:** a session that closes with mode `off` is published with outcome `not_judged`, requests no judging, and waits for nothing.
- **Deadline:** a session finalized with no eligible consensus is published as `no_consensus` with no certificate and no fabricated content, asserted by inspecting every row the settlement wrote.
- **Eligibility is decided by stored time, not event arrival:** a consensus recorded before the stored deadline whose `session.judged` event arrives after it yields `judged`. A consensus recorded after the deadline yields `no_consensus` and is kept as a record. Repeated finalize returns the same outcome. A lost or duplicated `session.judged` event changes no outcome.
- **Deadline reconstruction:** kill the scheduler after judging was requested and restart it before the deadline — the deadline timer fires at the originally stored instant, not later. Restart after the deadline — finalize runs immediately.
- **Recovery read:** kill the scheduler between every pair of settlement transitions — after turnover, after aggregate, after the judging request, after `judged` — including for a subject deactivated meanwhile, and after an API commit whose response was lost. On restart each settlement resumes from its recorded state and no durable effect repeats.
- **Isolation:** a judge wait on one session, and a failed transition on another, delay no subject's boundary and no other session's settlement. Both happen between transactions, never inside one; transitions contend only on the event counter, for the duration of a database write (§9).
- Transient aggregate failure with a healthy stream is retried and succeeds; a refusal with a reason is not retried.
- Activating a subject, or booting a blank database with active subjects, opens an epoch for each with no operator action; activation during scheduler downtime yields one fresh epoch on rebuild, not backdated.
- An operator turning over an epoch early through the admin API settles it and opens the next exactly as the boundary would, the new window closes on the grid instant after the early-closed window's scheduled close, and the scheduler's timer moves to that instant.
- Killing `system-scheduler` mid-window and restarting it after the window instant fires the boundary once on rebuild; a window that should have turned over three times during the outage turns over once.
- Deactivating a subject closes and settles its open epoch and opens no new one.
- **Handoff:** a turnover committed by an operator between the scheduler's full read and its subscription is delivered on the stream above the cursor, not lost.
- **Silent stall:** stall the connection without closing it — the missed keepalive is detected, the scheduler rebuilds, and no stale timer fires.
- **Final-event loss:** drop one application event at the API-to-scheduler hop while keepalives keep flowing, with no later event to follow it. The next keepalive's head sequence exceeds the scheduler's last-applied number; that alone triggers the rebuild, and the rebuilt state reflects the dropped change. The test asserts the trigger was the head-sequence mismatch, not a manually induced rebuild.
- **Early finalize:** under `enforce`, calling finalize before the deadline with no eligible consensus is refused with a reason and changes nothing; calling it before the deadline with an eligible consensus publishes `judged`; calling it at the deadline instant with a consensus recorded at that instant publishes `judged`.
- **Late consensus after publish:** a consensus arriving after the session is `published` is recorded and changes neither state nor outcome.
- **Retry exhaustion:** with a dependency failing for the whole retry budget, the scheduler marks itself degraded naming the item and stops retrying; restarting it after the dependency recovers resumes the item exactly once. A subject whose turnover exhausted refuses submissions after `window_closes_at` throughout.
- Dropping one event from the stream (a sequence gap) causes a full read and rebuild before any further fire. An API resync notice does the same.
- **Commit-ordered numbering:** two concurrent transitions for different subjects commit events whose numbers follow their commit order; a rolled-back transition leaves no hole; a subscriber applying both sees no gap and loses neither.
- **One clock:** a take arriving inside a transaction that started before `window_closes_at` but reaches the check after it is refused.
- **One present per transaction:** a transition that both derives the next grid close and checks lateness uses one reading of the clock for the derivation, so its stored close never disagrees with itself.
- **First-epoch floor:** activate a subject one second before a grid instant; its first window closes at the following instant instead, is at least half a duration long, and no session is published with every member absent because nobody could submit in time.
- **Judge of record:** with two judges seated, the judge of record is the same one on every replay and does not change when the other answers first; the other's judgement is recorded and changes no outcome.
- **No transaction spans a call:** a transition never holds its transaction open across a network or model call, asserted by instrumenting the transition path; with one transition deliberately slowed, another subject's boundary still fires within its tolerance.
- **Two credential holders:** the rendered compose config gives exactly `api` and the pipeline worker a database credential; a third service carrying one fails the gate by name.
- Between instants, with a live stream and no events, `system-scheduler` makes no API call; transport keepalive frames are not API calls.

## 11. Out of scope

The participant protocol (takes, judgements), how a judgement is signed, and how agents learn of a new window — `smoke-production-spec.md` §6; this document's no-polling rule applies to the scheduler, not to participants. Agreement among several judges, beyond the single-judgement rule of §4.4, and the format of what judges record. The pipeline worker's database role, which `smoke-production-spec.md` §7.2 governs.

## 12. Companion amendments (applied 2026-09-23)

Adopting this document superseded these clauses of `smoke-production-spec.md`. They were rewritten the same day to point here; the table records what each said before and what it says now, so the change is auditable from this document alone.

| clause | said before | says now |
|---|---|---|
| §4.4 | stage runs "accelerated `SWARM_*_CRON` values"; `--schedules-off` flag | stage sets short epoch durations on subjects through the admin API; no flag |
| §6.3 | `worker-swarm` schedules sessions from `job_schedules` rows; `bun run schedules:enable`; preflight-vs-readiness on `next_run_at` | `system-scheduler` and epochs, per this document; no enable command; nothing to disable |
| §7 check 6 | "the five `swarm.*` schedule rows are enabled and their cron strings parse" | preflight: every active subject has an epoch duration. Readiness, separately (§6.3): every active subject has a `collecting` session and the scheduler reports healthy |
| §6.3 (addition) | readiness = a `collecting` row per active subject | readiness also requires scheduler authentication, a synchronized stream, a completed initial rebuild, and no exhausted work; receipt vs live health distinguished |
| §5 (addition) | local modes generate role passwords only | preparation also provisions the scheduler's API token for rehearsal targets; `volume` reuses it |
| §6.2 (addition) | every participant "polls the API" | agents poll; judges subscribe and are served pending `judging` requests on every connect |
| §7.2 | database-holding containers are `api`, `worker`, `worker-swarm` | `api` only, within this document's scope |
| §8.1 | bootstrap data includes "seed schedules" | bootstrap data includes each subject's epoch duration; there are no schedule rows |
| §9.1 step 4 | `bun run schedules:enable` | deleted |
| §9.3 | "`job_schedules` rows are disabled" as a transition fact | replaced by the epoch model's first-boot behaviour (§3) |
| §3 (addition) | covers database and signing credentials | adds how an API automation token is provisioned to `system-scheduler` |
| §2 / §1.2 | `bun run schedules:enable` listed among the tools sharing the target-lock protocol | removed from that list |

The companion's participant model — agents polling for a new window, judges subscribing for judging requests — is defined in its §6.2. The judge subscription is its own connection and its own contract: the API serves pending `judging` sessions as state on every connect, so it does not depend on this document's cursor-and-sequence stream (§6.3), which exists for the scheduler alone.

## 13. Amendments (2026-09-24)

Decided with the owner on 2026-09-24 and recorded as [D52](../decisions.md#d52). Each row records what changed so the edit is auditable from this document alone.

| clause | said before | says now |
|---|---|---|
| §2.2, §4.1, §4.3 | one parameter, `window_closes_at = now + duration`; windows drift with turnover latency | windows close on a wall-clock grid, `epoch_anchor + k × epoch_duration`; downtime skips to the next future grid instant |
| §2.2, §4.4 | judging duration hardcoded | `judging_duration` is a subject column, captured at turnover with the judge mode |
| §4.2 | clock unspecified | every instant comparison uses the database clock, `clock_timestamp()` |
| §4.4 | consensus among judges out of scope | a session has one judge of record whose judgement is its consensus; with several seated, chosen by member id, never by arrival |
| §6.3 | monotonic sequence numbers; retained log may not reach a cursor; job pushes with acks | gapless numbers from one counter row in commit order; the log is retained past the oldest servable cursor; no job pushes |
| §7 | API tokens "provisioned per caller" | service tokens are per-instance files hashed in the API's token store; participant bearers live in `credential.json` |
| §9, §11 | "analytics and research workers" outside scope | exactly two services hold a database credential, `api` and the pipeline worker; a third is a defect |
| §2.2 | a first epoch may be arbitrarily short | a first epoch's window is at least half a duration, so activation timing cannot publish an unusable session |
| §9, §10 | the counter serializes transitions while the isolation gate implies none | a transition transaction never spans a network or model call, so the counter serializes only database work |

