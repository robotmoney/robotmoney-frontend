# Swarm session and judge — state machine specification

## Purpose and status

**Descriptive, not yet normative.** This is the first single document that states
the swarm session lifecycle as a state machine with the invariants that must hold
at every step. It was written by reading the implementation on `main`
(`a9f2008b`) and the schema, not by reading the prose docs. Where the code and
the prose disagree, §10 says so.

It exists so that "what should the judge do on failure" can be answered against a
written contract instead of against two branches that disagree. Adopt it, amend
it, then reconcile the branches to it.

Existing partial authorities, none of which is a state machine:

| Document | Covers | Gap |
|---|---|---|
| `docs/architecture.md` §9.4 | State list, job kinds | No guards, no invariants, no failure semantics |
| `docs/architecture.md` §9.7 | The judge, ~800 lines | Prose, organized by incident rather than by state |
| `docs/architecture.md` §9.7.1 | Receipt assembly | — |
| `docs/decisions.md` D42 | The judge authors no number | — |
| `docs/runbooks/v0-5-0-rollout.md` | The D-A7 split, operator triage | Release-scoped |

## 1. States

Seven, fixed by a CHECK constraint. `backend/migrations/0039_swarm_judge.sql:36-37`:

```sql
CHECK (state IN ('scheduled', 'collecting', 'window_closed', 'aggregated', 'judged', 'published', 'cancelled'));
```

`contract/src/swarm.d.ts:309` carries the same union.

| State | Meaning | Terminal |
|---|---|---|
| `scheduled` | Session row exists, window not open | no |
| `collecting` | Submission window open | no |
| `window_closed` | Window shut, takes frozen for aggregation | no |
| `aggregated` | Deterministic rollup computed over posted takes | no |
| `judged` | A judge opinion was adopted onto the session | no |
| `published` | Visible via API and frontend | **yes** |
| `cancelled` | Abandoned | **yes** |

`judged` is **optional**. `aggregated → published` is legal, so a deployment with
the judge `off` never enters it. Verified two ways: `PUBLISHABLE_STATES`
(`domain.ts:2546`) includes `aggregated`, and the transition table admits it.

## 2. Legal transitions (normative)

`backend/src/swarm/admin.ts:1140-1148`, verbatim:

```js
const TERMINAL = new Set(["published", "cancelled"]);
const TRANSITIONS = {
  scheduled:     ["collecting", "cancelled"],
  collecting:    ["window_closed", "cancelled"],
  window_closed: ["collecting", "aggregated", "cancelled"],
  aggregated:    ["window_closed", "judged", "published"],
  judged:        ["window_closed", "published"],
  published:     [],
  cancelled:     [],
};
```

Note the **backward edges**: `window_closed → collecting`, `aggregated →
window_closed`, `judged → window_closed`. These are legal and they matter,
because `TAKES_AMENDABLE_STATES` (`domain.ts:171-175`) is
`{scheduled, collecting, window_closed}`. **Reopening a judged session to
`window_closed` reopens the take-amendment window**, invalidating the evidence
the existing judgement was formed over.

INV-T1. No transition out of `published` or `cancelled`.
INV-T2. Every state change is one of the edges above.
INV-T3. A transition that reopens take amendment must invalidate any adopted
judgement covering the old take set. *(Partially enforced — see §10, GAP-4.)*

## 3. Two transition mechanisms — and only one is fully guarded

This is the most important structural fact about the machine, and it is not
documented anywhere else.

**The guarded path** — `transitionWithin` (`admin.ts:1197-1216`). Takes
`FOR UPDATE` on the row, then:
- rejects a stale `expectedVersion` with `409 stale_version` (optimistic lock);
- returns an idempotent 200 if already in the target state;
- rejects any transition out of a terminal state (`terminal_state:<state>`);
- rejects an edge not in `TRANSITIONS` (`illegal_transition:<from>-><to>`);
- bumps `version`, and writes `swarm_session_events` + `audit_log` in the same
  transaction.

`admin.ts:1212` is the **only** writer of `swarm_session_events` in the repo.

**The domain path** — raw primitives in `domain.ts` that write `state` directly.
Guard coverage is inconsistent:

| Transition | Function | SQL guard | version bump | event row |
|---|---|---|---|---|
| → `collecting` (brief) | `publishBrief` `domain.ts:1971` | **none** (`WHERE id = $1`) | no | no |
| `collecting` → `window_closed` | `closeWindow` `domain.ts:2031` | `AND state = 'collecting'` | no | no |
| → `aggregated` | `aggregateSession` `domain.ts:2504` | **none** (`WHERE id = $1`) | no | no |
| `{aggregated,judged}` → `published` | `publishSession` `domain.ts:2548` | `AND state = ANY(PUBLISHABLE_STATES)` | yes | no |
| → `judged` | via `transitionWithin` only | full | yes | yes |
| → `cancelled` | via `transitionWithin` only | full | yes | yes |

**`aggregated` is safe in practice.** The worker calls
`admin.aggregateSessionAdmin`, which calls `guardedTransition(…, "aggregated")`
*before* the unguarded domain primitive (`admin.ts:1249-1254`). The guard lives
one layer up. architecture.md's claim that aggregate is "state-guarded like every
other transition" is true of the cadence path.

**`→ collecting` is not.** The worker handler calls the domain function directly
(`worker/handlers/swarm.ts:16-21` → `ic.publishBrief`), there is no
`publishBriefAdmin`, and `guardedTransition` is never invoked for it
(its five call sites are `cancelled`, `window_closed`, `collecting`-reopen,
`aggregated`, `published`). See §10, GAP-1.

## 4. The job layer

Five per-session kinds, enqueued together at session creation.
`admin.ts:861`:

```js
const SESSION_JOB_KINDS = ["swarm.publish_brief", "swarm.close_window", "swarm.aggregate", "swarm.judge", "swarm.publish"];
```

`swarm.open_session` is cron-driven, not per-session.

**Ordering, not spacing.** `admin.ts:957-963` — the scheduling instants are
clamped so the jobs are *ordered*, not spread out. All five are priority 0 and
`aggregate`/`judge` can collapse onto an identical `run_after`, so the claim
query's `, id` tiebreak (`ORDER BY priority DESC, run_after, id`) is
load-bearing: without it the judge measurably lost the tie and sessions published
with zero judgement rows (issue #806).

**One lane, one worker.** The `swarm` lane claims only `swarm.%`; `analytics` and
`generic` explicitly exclude it. Serialization comes from claiming `LIMIT 1` with
`FOR UPDATE SKIP LOCKED` in a serial loop, with one `worker-swarm` process. All
five session kinds plus `swarm.open_session` and three notification kinds contend
for that single lane.

**Four run outcomes:**

| Outcome | Condition | Effect |
|---|---|---|
| SUCCEEDED | return value is not `{ok:false}` | job settles `succeeded` |
| DEGRADED | `{ok:false}` | retry with `2^attempts` backoff, capped |
| TERMINAL | `{ok:false, terminal:true}` | settles `failed` on attempt 1 |
| THREW | exception | retry, then `dead` at `max_attempts` |

`max_attempts` defaults to 5. An **exhausted degrade settles `failed`, not
`succeeded`** — deliberately, after a staging job read `succeeded, attempts 5,
last_error judge_unavailable` for a judging that never happened.

**Benign skips.** `translateBenignSkip` converts `{ok:false}` into a clean
success, but only for an explicit per-kind allowlist — `judge_disabled` and
`terminal_state:*` for the judge; `terminal_state:*` and
`illegal_transition:judged->aggregated` for aggregate. The governing rule is
*"can a retry change the answer, not is it an error"*. There is deliberately **no**
`illegal_transition` wildcard for the judge: from `window_closed` a retry
genuinely can help, and translating it away "converted a loud, temporary failure
into a silent, permanent one."

**Idempotency.** Dedupe key is `swarm:<sessionId>:<action>`, backed by a unique
partial index, inserted `ON CONFLICT … DO NOTHING`. Re-enqueueing a session's
jobs is a no-op.

INV-J1. A session's lifecycle jobs are enqueued exactly once per session.
INV-J2. Exactly one worker may hold a given job; all terminal writes are guarded
on `locked_by` + `status='running'`, and a 0-row update discards the result.
INV-J3. A job whose outcome a retry cannot change must not be retried.
INV-J4. A job that did not do its work must not settle `succeeded`.

## 5. The judge sub-machine

**Config is a database row, not an env var** — `swarm_judge_config`, one row,
`CHECK (id = 1)`.

| Column | Constraint |
|---|---|
| `mode` | `CHECK (mode IN ('off','shadow','enforce'))`, ships `off` |
| `min_takes` | `CHECK (min_takes >= 1)`, default 3 |
| `model` | `CHECK (model IS NULL OR btrim(model) <> '')`, ships NULL |

Plus, from migration 0056:

```sql
CHECK (mode = 'off' OR (model IS NOT NULL AND btrim(model) <> ''))
```

INV-JC1. **A judge that is on must name a model.** Migration 0056 both adds this
constraint and self-heals: an existing `enforce`+NULL row is forced to `off`.
This is the DB half of the #969 fix. Production had reached `mode='enforce'` with
`model=NULL`, and every enforce-mode opinion the system published was authored by
a template and attributed to a judge.

**Mode semantics.**
- `off` — the judge never runs. The scheduled judging is a SKIP, not a degradation.
- `shadow` — it runs and is recorded; nothing it says reaches the session. A
  receipt over a shadow judgement is refused (`judgement_not_adopted`), so shadow
  exercises the judge and proves nothing about the artifact.
- `enforce` — its prose replaces the template prose on the session it judged.

**Judgement rows** — `swarm_session_judgements`, append-only, many per session
legal, latest-wins. No unique index.

INV-JR1. `CHECK (mode IN ('shadow','enforce'))` — a judgement row cannot exist
for an `off` judge.
INV-JR2. `CHECK ((source = 'fallback') = (fallback_reason IS NOT NULL))` —
exactly one of "a model authored it" / "templates did, and here is why".
INV-JR3. **The judge authors no number** (D42). Enforced in the schema by a
recursive `jsonb_path_exists` scan refusing `weight`, `weights`,
`bucket_weights`, `allocation`, `vector`, `weighting`, `portfolio` and siblings
at *any* depth of the opinion document — not only in the code that writes it.
INV-JR4. `min_takes` is recorded **on the row**, so a historical opinion is read
against the threshold in force when it was made. Raising the threshold today
cannot retroactively retract a past receipt.
INV-JR5. Ordering: the model call happens **outside** any transaction; the
transition to `judged`, the judgement row, and its application commit together
under an advisory lock on the session id. So `judged` and the row that justifies
it commit together or not at all, and two judges racing the same session are
serialized.

**Quorum: there is none.** `min_takes` is advisory — below it the session is
"thinly supported" and the release-safety opinion says so. The only hard floor is
`no_takes` (zero) at receipt assembly.

**Failure classes — this is the contested part.** See §9.

## 6. The receipt sub-machine

One receipt per session, structurally: `session_id uuid PRIMARY KEY`.

Preconditions: assembly refuses a session that is not already terminal
(`published`). The receipt records `session_version`, so a session that moves
afterwards is a *detectable* divergence rather than an invisible one.

The 21 refusal reasons **are** the receipt-layer invariants. Each refusal reports
exactly one violated invariant:

| Refusal | Invariant |
|---|---|
| `no_session` | The referenced session exists |
| `session_not_published` | Only a published session may be certified |
| `session_not_reaggregated` | The aggregate reflects the current take set |
| `not_judged` | A judgement exists |
| `judgement_not_adopted` | Only an `enforce` judgement the session adopted is publishable |
| `judgement_stale` | The judgement covers the session's current takes |
| `no_takes` | At least one submitted take |
| `created_at_unparseable` | Timestamps are well-formed |
| `digest_malformed` | `prompt_hash` / `inputs_digest` are well-formed |
| `signing_key_unresolved` | A signing key is available |
| `take_not_bound_to_session` | Each signed payload binds to its member and subject |
| `nonce_replayed` | Each nonce is unique and matches its row |
| `weights_malformed` | The weight vector is structurally valid |
| `weights_not_canonical_four` | Exactly the four canonical buckets |
| `weights_not_a_share_vector` | Values form a normalizable share vector |
| `weights_absent_for_bucket_weights_subject` | A `bucket_weights` session produced a vector at all |
| `weights_not_authored_by_every_take` | `take_count` does not overstate who voted on the vector |
| `schema_invalid` | The receipt matches its published schema |
| `semantics_invalid` | The receipt passes semantic checks |
| `canonicalization_failed` | Bytes canonicalize deterministically |

Plus `judgement_not_authored` on `releases-0.5.x` only — see §9.

**Two refusals are terminal**, not retryable:
`weights_absent_for_bucket_weights_subject` and
`weights_not_authored_by_every_take`. Both are facts about an already-frozen take
set, repairable only by re-running the session.

**Four refusals are expected** and leave the publish job successful:
`not_judged`, `judgement_not_adopted`, `session_not_reaggregated`,
`judgement_stale`. This is an allowlist on purpose, so a newly-added reason
degrades loudly rather than being absorbed silently.

The canonical bucket order is frozen in the contract:
`["agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets"]`.

## 7. Take submission invariants

INV-S1. A member may file up to **5** revisions per session
(`SWARM_TAKE_REVISION_CAP`), enforced both by a pre-check and inside the insert's
WHERE clause, so two racing submits cannot both pass.
INV-S2. `UNIQUE (session_id, member_id, revision)` — reads resolve
latest-per-member via `DISTINCT ON … ORDER BY revision DESC`. Nothing is edited
in place.
INV-S3. `UNIQUE (member_id, nonce)` — the nonce is scoped **per member globally**,
not per session. An in-receipt `seenNonce` set additionally prevents carrying one
signed take into a second receipt.
INV-S4. Ed25519 signature verification runs after cheaper refusals but before the
take is accepted.
INV-S5. A take is amendable only in `{scheduled, collecting, window_closed}`.

## 8. Append-only — weaker than the name suggests

13 swarm tables are registered append-only. **The guard blocks DELETE and
TRUNCATE only. UPDATE is permitted by design.** Migration 0032 is explicit:

> UPDATE. Permitted BY DESIGN … An UPDATE can blank every column of every row, so
> a protected table can be emptied of MEANING while keeping its row count.
> "History rows are not removed" is the guarantee; "the recorded facts cannot be
> altered" is NOT.

Two triggers per table, both `ENABLE ALWAYS`: a STATEMENT trigger for
DELETE-or-TRUNCATE and a ROW trigger for DELETE. Both are needed — logical
replication has no statement, and a row trigger cannot fire for TRUNCATE.

A stricter registry that *does* refuse UPDATE exists (`LEDGER_IMMUTABLE_FAMILIES`,
migrations 0057-0060). **No swarm table is in it.**

INV-A1. No swarm history row is deleted or truncated.
INV-A2. *(Not guaranteed.)* Swarm history rows cannot be altered in place.

For a system whose output is a signed attestation, INV-A2 being unguaranteed is
worth an explicit decision rather than an inherited default.

## 9. The contested step: judge failure

This is the step the two branches answer differently, and the reason this spec
exists. Neither answer is obviously wrong; they are different contracts.

**`main` — the D-A7 split.** Two failure classes:
- *Never really asked* — no model, no credential, rejected credential, exhausted
  credit, unsupported model, launcher unavailable. **Fails closed**: throws, writes
  no judgement row, publishes nothing, records the class in the job's
  `last_error`.
- *Asked, and the model misbehaved* — timeout, unparsable answer, an answer
  smuggling a number. **Falls back**: writes `source='fallback'` with template
  prose and a bounded reason. The session publishes. The receipt is assembled and
  signed, carrying `source: "fallback"` honestly in the signed bytes.

**`releases-0.5.x`.** One class. Any failure throws `JudgeUnavailable`. No
judgement row is written. `templateOpinion()` is unreachable. Additionally,
receipt assembly refuses `judgement_not_authored` when an adopted judgement has
`source != 'model'` — *"a receipt is a claim about authorship, so this is a
refusal and not a warning."*

**The schema permits both.** `source` keeps `'fallback'` in its CHECK on both
branches, because the table is append-only and holds real historical fallback
rows, including ones embedded in receipts already published and signed.

**Timeline, which matters for reading intent:**

| Date | Event |
|---|---|
| 2026-09-12 | Lucas states the judge refuses rather than fakes — no fallback mode |
| 2026-09-13 | D-A7 correction restores the narrow runtime-class fallback |
| 2026-09-18 | Fusion, carrying D-A7, squash-merges to `main` |
| 2026-09-19 | `a42d6c5a` on `releases-0.5.x` removes fallback entirely |

Migration 0056's own tail comment flags the residue as unresolved:

> Those published receipts are NOT retracted here either. They are
> signature-valid attestations of template prose; whether they should remain
> servable is a product decision, not a schema one.

**The decision is two questions, not one:**
1. May `judge()` return an opinion no model authored?
2. May such an opinion be published as a signed receipt?

`main` answers yes/yes. `releases-0.5.x` answers no/no. yes/no is coherent and
un-implemented: keep the fallback so a session still publishes, refuse it a
certificate. That option deserves consideration precisely because it separates
"the swarm keeps running" from "we signed something a model did not write".

## 10. Gaps between this machine and its implementation

GAP-1. **`→ collecting` is unguarded.** `publishBrief` writes
`state='collecting'` with `WHERE id = $1` and no state predicate, no version
bump, no event row. The guarded admin path forbids re-entering `collecting` from
a terminal state; this path cannot express that refusal. Practical reachability
is limited by the dedupe key, but the guard is absent, not merely redundant.

GAP-2. **`version` is not bumped by three transitions** — `publishBrief`,
`closeWindow`, `aggregateSession`. The receipt records `session_version` so later
divergence is detectable; that detection is weaker than it reads, because three
state changes leave the version untouched.

GAP-3. **No event row for cadence transitions.** `swarm_session_events` is
written only by `transitionWithin`, so the audit trail covers admin-driven
transitions and not the cadence that drives most sessions.

GAP-4. **Backward edges reopen the take window without invalidating a
judgement.** `judged → window_closed → collecting` is legal and reopens
amendment. `judgement_stale` catches the consequence at receipt time; nothing
prevents the reopening itself.

GAP-5. **A settled job never re-arms.** The dedupe key is unique across all time
and the insert is `DO NOTHING`, so a rescheduled session keeps its original
`run_after` and its spent attempts. *(This is what `ebbfc0bb` on `releases-0.5.x`
fixes with `DO UPDATE`.)*

GAP-6. **Cancelling a session does not dequeue its remaining lifecycle jobs.**

GAP-7. **`closeWindow` reports success when it transitioned nothing** — it
returns `{state: "window_closed"}` whether or not the guard matched.

GAP-8. **Telemetry can roll back a state change.** On `main`, `closeWindow` wraps
the transition and the absence-telemetry inserts in one transaction, so a
telemetry failure rolls back the close, the job retries, attempts exhaust, and
the session wedges in `collecting` permanently. *(Fixed on `releases-0.5.x` by
`ebbfc0bb`.)*

GAP-9. **INV-A2 is unenforced** — see §8.

## 11. Open decisions

1. §9's two questions — may a non-model opinion exist, and may it be certified?
2. Should GAP-1 through GAP-4 be closed by routing every transition through
   `transitionWithin`, making the domain primitives private?
3. Should swarm judgement and receipt tables move to the stricter
   UPDATE-refusing registry (§8, GAP-9)?
4. Are the already-published receipts over template prose retracted, left
   servable, or flagged?
