# System scheduler spec

> **Status: first draft, 2026-09-23. Prescriptive.** This document describes
> the scheduling architecture the system is to have. It does not describe the
> current implementation and does not inherit from it. Where it conflicts with
> code, the code is what changes. It sits beside
> [`smoke-production-spec.md`](./smoke-production-spec.md), which owns
> deployment, credentials and participants; this document owns how sessions are
> timed and driven once the stack is running.

---

## 1. Roles

Three things take part. Each has exactly one job.

| Role | Job | Database connection |
|---|---|---|
| **API** | Stores. Exposes authenticated endpoints to read subjects, read sessions, change a subject's epoch duration, and perform each lifecycle transition. Publishes change events and pushes ad-hoc work to subscribers over a stream. Decides nothing about timing, beyond computing `window_closes_at` from the subject's duration when it opens an epoch. | Yes — the only running service that holds one. |
| **`system-scheduler`** | Is the clock. Holds one timer per active subject, fires each subject's epoch boundary, and drives settlement. Subscribes to the stream. | **No.** Never. |
| **Participants** (agents, judges) | Do the work that needs a model: takes and judgements. Defined in `smoke-production-spec.md` §6. | No. |

`system-scheduler` is one long-running container. It replaces the process formerly called `worker-swarm`. There is no separate clock process and no separate executor process.

## 2. Epochs

### 2.1 The model

A subject's sessions run in **epochs**, back to back. Each epoch is one session. When epoch N's submission window closes, epoch N+1's window opens at that same instant. For an active subject there is always exactly one open window. There is no gap between epochs, no idle state, and no daily convene.

### 2.2 The one duration

Each subject has one scheduling parameter: its **epoch duration** — how long its submission window stays open. That is the entire schedule. Nothing else about a session's timing is configured.

### 2.3 Where it lives and who sets it

The epoch duration is a column on the subject.

- On a **blank database** it is set by the bootstrap data in the schema snapshot (`smoke-production-spec.md` §8.1), once, at initial migration.
- Afterwards it is changed only through the **admin API**, as an ordinary authenticated update to the subject.

No environment variable sets it. No seed command sets it. No boot overwrites it on a populated database. A rehearsal that wants short epochs on a copy of production changes the subjects through the admin API.

### 2.4 Never disabled

An active subject always has an open epoch. There is no on/off state for scheduling. Activating a subject opens its first epoch (§3). A subject that must stop running epochs is deactivated, and deactivation closes its open epoch and settles it (§4.5).

## 3. The clock

`system-scheduler` is the clock. It holds one timer per active subject: the instant that subject's current epoch closes. On start, and on every rebuild:

1. Read every active subject, with its epoch duration, through the API.
2. Read every subject's current open session, with its `window_closes_at`, through the API.
3. For each subject, set the timer to that instant.
4. Wait until the earliest timer. Fire it (§4.3). Recompute that subject's timer. Repeat.

**An active subject with no open epoch is opened immediately** (§4.1) as part of the rebuild — a fresh database, a subject activated while the scheduler was down, a subject whose epoch an operator closed by deactivating and then re-activated. This is how the invariant in §2.1 holds from the first instant; nothing else opens a first epoch.

It fires at the instant. It does not poll the API on an interval. It does not tick.

### 3.1 The clock is current, or it is rebuilt

The clock's copy of the subjects and open sessions is current if and only if two things hold: its stream connection (§6) is live, and it has applied every change event since its last full read, with no gap in the event sequence. When both hold, it acts. When either fails, it stops acting, performs a full read (steps 1–2 above), rebuilds every timer, and resumes.

There is no third state. The clock never reconciles on a timer, never re-reads "just in case", and never acts on a copy it cannot prove is current.

### 3.2 Downtime, and what happens after it

**Downtime is any interval during which the clock was not current under §3.1.** That covers three cases, treated identically:

- the process was not running — a crash, a restart, a redeploy;
- the process was running but its stream connection was down;
- the process was running and connected but detected a sequence gap.

In every case the clock stops acting at the start of the interval and rebuilds at the end of it.

**On rebuild, for each subject whose window instant fell inside the interval:** fire the boundary once, now. That closes the stale epoch, opens a fresh one, and starts settlement of the stale one. **Missed boundaries are not replayed.** A subject that should have turned over three times during a two-day outage turns over once, on rebuild. Epochs are not opened into the past.

An epoch that was already closed and mid-settlement when downtime began resumes settlement (§4.4) on rebuild; every settlement step is state-guarded (§5), so nothing runs twice.

## 4. The session lifecycle

### 4.1 Epoch open

Opening an epoch is one API call that does three things atomically: create the session, publish its brief, and set `window_closes_at = now + epoch duration`. The session is `collecting` from its first instant. There is no `scheduled` state and no "brief opens later."

### 4.2 The submission window

While `collecting`, participants submit takes through the API. The window is the only timed part of a session's life, and the only part with a fixed duration.

### 4.3 The boundary

When a subject's timer fires, `system-scheduler` makes one API call for that subject: **turn over**. The API closes epoch N (`collecting → window_closed`, recording an `absent` event for each seated member who did not file) and opens epoch N+1 (§4.1), in one transaction. The scheduler then sets that subject's timer to the new `window_closes_at`.

Turnover is the only way an epoch closes while its subject stays active. An operator ending a window early does it through the same turnover endpoint; the scheduler learns of it by event (§6.2) and treats it exactly as it treats its own.

### 4.4 Settlement

Closing an epoch starts its settlement, and settlement is **not scheduled**. It is an event chain that runs as soon as each step can:

1. **Aggregate** — roll the signed takes up into the recommendation. `window_closed → aggregated`.
2. **Judge** — the scheduler requests judging; the API pushes the request to the judge participants (`smoke-production-spec.md` §6) and moves the session to `judging`. When the judges' consensus lands, the API records it, moves the session to `judged`, and publishes `session.judged`. This step has a **hardcoded deadline**. It is a timeout the scheduler holds while waiting, not a scheduled instant.
3. **Publish** — the session goes public, with its consensus certificate when one exists. `→ published`.

`system-scheduler` drives the chain: it calls aggregate the moment turnover returns, requests judging the moment aggregate returns, then waits for **either** the `session.judged` event **or** the deadline — whichever comes first — and calls publish. It never polls for the judgement; the event brings it.

**No consensus.** If the deadline passes before `session.judged` arrives, the scheduler marks the session `no_consensus` and publishes it in that state. No consensus certificate is produced. Nothing is fabricated: no template opinion, no placeholder certificate, no default verdict. A session with no consensus says so.

### 4.5 Deactivating a subject

Deactivating a subject through the admin API closes its open epoch and settles it, and opens no new one. The scheduler drops its timer on the `subject.changed` event.

## 5. Transitions are state-guarded

Every transition endpoint checks the session's current state before acting and refuses, as a no-op with a reason, if the transition is not valid from that state. This is what makes the clock safe: a boundary fired twice, a settlement resumed after downtime, and an operator firing a step by hand all reach the same guard.

## 6. Timed work, event-driven work, and the stream

### 6.1 Two kinds of work

- **Timed work** fires at an instant the clock already knows. There is one scheduled kind: the epoch boundary, one per active subject. The clock fires it directly; the API sends nothing, because the scheduler already holds the instant. The judge deadline (§4.4) is also a timer the scheduler holds, but it is a timeout inside settlement, not a schedule.
- **Event-driven work** fires because something happened. Settlement is driven by the scheduler as the direct consequence of a turnover — its own, or an operator's — and advanced by the `session.judged` event. An operator triggering a step is event-driven. A change to a subject's epoch duration is itself an event.

### 6.2 Change events

Any write that alters what the scheduler is waiting on is published by the API as an event. The scheduler applies it by re-reading the affected thing through the API and resetting the affected timer.

| event | cause | scheduler does |
|---|---|---|
| `subject.changed` | epoch duration changed, or subject activated / deactivated | re-reads that subject; on activation opens its first epoch (§3); on deactivation drops its timer and settles the closed epoch (§4.5) |
| `epoch.turned_over` | epoch N closed and N+1 opened — by the boundary or by an operator | sets that subject's timer to the new `window_closes_at`; settles N if it is not already settling |
| `session.judged` | the judges' consensus was recorded | proceeds to publish (§4.4) |

A duration change takes effect at the **next** boundary: the current window keeps the `window_closes_at` it was opened with, and the epoch opened at that boundary uses the new duration.

This is what keeps the in-memory timers honest without polling: the copy is never more than one unapplied event behind, and §3.1 says what to do when it might be.

### 6.3 Contract

- `system-scheduler` opens one long-lived, authenticated connection to the API and subscribes.
- Every message carries a **monotonic sequence number**. The scheduler records the last one it applied.
- A change event carries what changed. A job push carries kind, target, and an idempotency key.
- The scheduler acks a job through the API when it is done. An unacked job is re-pushed after a timeout; redelivery is safe because the target transition is state-guarded and the key is idempotent.
- A **gap** — a sequence number that is not the last applied plus one — means the copy is no longer provably current. The scheduler treats it exactly like a dropped connection: stop, full read, rebuild.
- A dropped connection is reconnected with backoff. On reconnect the scheduler performs a full read (§3.1) and the API re-pushes anything unacked. The scheduler does not replay from its last sequence number; it rebuilds. Rebuilding is cheap and provably correct; replay would have to be proven complete.

## 7. Credentials

There are three kinds of credential in this system, and they must not be confused:

| kind | proves | held by | lives in |
|---|---|---|---|
| **Signing** — an Ed25519 key | authorship of a take or judgement | participants only | `credential.json` (`smoke-production-spec.md` §6.1) |
| **API** — a bearer token | that the caller may call the API | anything that calls the API | provisioned per caller |
| **Database** — a Postgres role password | that the process may open a database connection | the API only, at runtime | `~/.env` (`smoke-production-spec.md` §3) |
| **Model** — a third-party LLM key (e.g. `OPENCODE_API_KEY`) | that the holder may call a model vendor | participants that call a model: agents, judges | delivered to those containers only |

`system-scheduler` holds exactly one: an **API credential**, an automation token with the rights to read subjects and sessions and to perform lifecycle transitions. It signs nothing, so it has no signing key and no entry in `credential.json`. It never touches the database, so it has no role password. It calls no model, so it has no model key. It holds no Docker socket.

How that automation token is provisioned to the container is not defined here or in `smoke-production-spec.md` §3 yet; §3 covers database and signing credentials only. It is the one addition that spec needs.

## 8. Environments

The same `system-scheduler` image and code run in production, stage, test and CI. Only the subjects' epoch durations differ: a blank database gets its bootstrap values, and any other environment changes them through the admin API. A test that needs a fast lifecycle sets short epoch durations and runs the real scheduler; it does not bypass the scheduler.

## 9. Invariants

- Among running services, only the API connects to the database.
- A subject's epoch duration is set once by bootstrap and afterwards only by the admin API.
- An active subject always has exactly one open epoch. There is no scheduling on/off state.
- The submission window is the only timed part of a session. Settlement is never scheduled.
- `system-scheduler` never polls the API on an interval, and never re-reads on a timer.
- The clock is either provably current or rebuilding. There is no third state.
- Every change to what the clock waits on is an event on the stream.
- A fired transition is safe to fire again.
- A session without consensus is published as `no_consensus`. Nothing is ever fabricated to fill the gap.

## 10. Acceptance gates

- A blank-database boot sets every subject's epoch duration from the snapshot; a boot on a populated database changes none of them.
- No service other than `api` carries a database credential in any composition, asserted by rendering the compose config.
- For an active subject, closing epoch N and opening N+1 happen in one transaction at `window_closes_at`, and the new session's `window_closes_at` equals its open instant plus the subject's duration.
- Two subjects with different durations turn over independently at their own instants.
- Changing a subject's duration through the admin API publishes `subject.changed`; the current window is unaffected; the next epoch uses the new duration; no restart.
- Settlement of a closed epoch runs aggregate, judge and publish with no scheduled delay between them.
- A judge that does not reach consensus by the deadline yields a session published as `no_consensus` with no certificate and no fabricated content, asserted by inspecting every row the settlement wrote; a `session.judged` event arriving after the deadline changes nothing.
- Activating a subject, or booting a blank database with active subjects, opens an epoch for each with no operator action.
- An operator turning over an epoch early through the admin API settles it and opens the next exactly as the boundary would, and the scheduler's timer moves to the new instant.
- Killing `system-scheduler` mid-window and restarting it after the window instant fires the boundary once on rebuild; a window that should have turned over three times during the outage turns over once.
- Killing `system-scheduler` mid-settlement and restarting it resumes settlement; no step runs twice.
- Firing any transition twice yields one state change and one no-op with a reason.
- Deactivating a subject closes and settles its open epoch and opens no new one.
- Dropping one event from the stream (a sequence gap) causes a full read and rebuild before any further fire.
- Between instants, with a live stream and no events, `system-scheduler` makes no API call at all.

## 11. Out of scope

The participant protocol (takes, judgements) and how a judgement is signed — `smoke-production-spec.md` §6. How judges reach consensus among themselves. The analytics and research workers, which will follow the same no-database, subscribe-and-ack model in a later document.
