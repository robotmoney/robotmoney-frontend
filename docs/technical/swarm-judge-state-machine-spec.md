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
un-implemented: keep a clearly-labelled non-model opinion on the session for
readers, and refuse it a certificate.

**A judge failure does not stop a session on either branch.** This is worth
stating plainly, because the fallback debate is easy to misread as an
availability question. It is not. `judged` is optional, `aggregated → published`
is legal, and `swarm.judge` is a separate job from `swarm.publish`. When judging
fails, the session stays `aggregated`, the publish job still runs, and the
session reaches `published`. What it loses is its certificate — `not_judged` is
an *expected* receipt refusal, and the missing receipt is reported per session in
the admin overview alert feed rather than passing in silence.

So all three answers keep the machine running. They differ only in what a reader
sees on the session, and in whether a certificate exists. The things that
genuinely stop a session are in §10 — GAP-5 and GAP-8 — and they have nothing to
do with judge policy.

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

## 11. Target design — the judge as evaluator

Product direction stated by Lucas, 2026-09-21. Recorded as the target. **Not
current behavior.** Sections 1-10 describe what is built.

### 11.1 The contract

- Sessions always end.
- The judge cannot commence work until the session's takes are frozen.
- The judge's output is always typed JSON carrying **both**:
  - a consensus weight, and
  - one evaluation per submitted memo, each with a confidence field and
    discursive text explaining that evaluation.
- The judge brings no new evidence. Its evidence is what the agents submitted.
- The judge **may** check the facts an agent asserts against canonical source
  data the RM platform already serves (macro data APIs and similar).

### 11.2 This preserves more of D42 than it first appears

The phrasing matters: the judge reports *"the consensus weight the swarm agents
provided"*, over the subset it judged reasonable. **The judge is not an
allocator.** It does not author an allocation from its own market view. It
filters, and reports the consensus of what survives.

So the arithmetic stays arithmetic. The model contributes a *filter*, not a
number. That admits a design where D42's core property survives an amendment
rather than a repeal:

1. The judge scores each memo. Those scores are model output.
2. The vector is still computed by `meanTakeWeights()`, over the surviving takes.
3. The receipt carries the takes **and** the per-memo scores, both signed.
4. A verifier recomputes the vector exactly — apply the signed scores, run the
   same mean, compare against the receipt.

Reproducibility moves from *"from the take set"* to *"from the take set plus the
judge's signed scores"*. It does not disappear. A dishonest judge becomes
detectable in its scores rather than invisible in its arithmetic, which is a
strictly smaller surface than a judge that authors the vector outright.

INV-TG1. The vector in a receipt must be recomputable from that receipt's own
signed bytes, with no live service call.

### 11.3 Required changes

| # | Change | Why |
|---|---|---|
| 1 | Amend D42 | It currently forbids the judge authoring any number |
| 2 | Drop/replace `swarm_session_judgements_no_weights_check` | It refuses `weight`/`weights`/`allocation`/`vector` at any depth, so it rejects every target-shaped opinion |
| 3 | Widen the opinion shape | Today `{rationale, disagreements, release_safety}`; target adds N per-memo evaluations |
| 4 | Reorder the cadence | `aggregate` authors the vector today and runs **before** `judge`. Either judge moves ahead of aggregation, or aggregation re-runs after judging (`session_not_reaggregated` is precedent) |
| 5 | Widen the prompt | The judge is shown "the brief and the takes and nothing else" today; fact-checking needs canonical data |
| 6 | Widen `canonicalizeDigestInputs()` and bump `DIGEST_SCHEME` | Off `derivation-v1`. The repo's own rule: bump in the same change that widens the covered set |
| 7 | Carry the per-memo evaluations into the receipt | Otherwise INV-TG1 fails — the weight stops being reproducible |
| 8 | Keep `meanTakeWeights()` as the arithmetic | Per 11.2, the judge filters and the function still computes |
| 9 | Redefine `weights_not_authored_by_every_take` against the SURVIVING set | Per 11.5(a) it goes silent exactly when its own invariant breaks |
| 10 | Split `take_count` into attested and contributing | INV-TG2 |
| 11 | Add a recorded drop threshold on the `min_takes` pattern | Per 11.5(b), keeps the filter deterministic and auditable |
| 12 | Recompute thin support against the contributing count | Per 11.5(c) |

### 11.4 The tension to resolve in wording

"No new evidence" and "may check canonical data" are in tension as written.
Checking a claim against a macro API *is* reading data the agents did not submit.

The workable distinction: canonical data is a **verification oracle, not
evidence**. The judge may use it to test a claim an agent made. The judge may not
use it to form a position of its own. Enforceable in the output shape — every
evaluation is *about* a submitted memo, and the consensus weight is derived from
the surviving memos rather than from the judge's own view.

This needs to be written into the prompt contract explicitly, because it is the
line between an evaluator and a thirteenth analyst.

### 11.5 An unreasonable memo is DROPPED from the vector

Decided by Lucas, 2026-09-21. The filter is binary, not a confidence-weighted
average. A memo the judge rules unreasonable contributes nothing to the vector.

Four consequences follow, and the first is a silent failure.

**(a) `weights_not_authored_by_every_take` stops protecting its own invariant.**

That refusal exists to stop exactly this sentence, quoted from its own message:

> `release_safety.take_count` would report every take while the numbers came
> from a subset, and a bucket a member never named would be counted as that
> member's explicit 0.00 vote.

But its coded check (`consensus-receipt.ts:751-766`) only collects takes where
`!isCanonicalFourVector(normalizedTakeWeights(payload.weights))` — takes carrying
**no** vector. A dropped memo carries a perfectly valid vector. It passes the
check untouched. So under the target design this refusal goes quiet precisely
when its stated invariant is violated.

It must be redefined against the **surviving** set, and `take_count` must split
into two fields that are no longer the same number:

- *attested* — how many takes the receipt covers
- *contributing* — how many authored the vector

INV-TG2. A receipt must state both counts. A reader must never have to infer
which one a single `take_count` meant.

**(b) The drop threshold must be recorded, not left to the model.**

The judge reports a confidence figure per memo. A binary drop needs a threshold.
If the model decides the cutoff internally, the drop is not reproducible and can
drift between runs over identical inputs.

The repo already has the right pattern in `min_takes`: a config column, recorded
onto **every judgement row**, so a historical opinion is read against the
threshold actually in force when it was made. The drop threshold should work the
same way.

That keeps the filter deterministic. Model output is the per-memo score. The
drop is arithmetic over a signed score and a recorded threshold — so INV-TG1
holds, and a verifier can re-derive not just the vector but the membership.

**The placeholder values** (chosen 2026-09-21; Lucas: immaterial for now, so
these exist to make the design concrete and are expected to be tuned):

| Item | Value | Reasoning |
|---|---|---|
| Scale | `0.0 … 1.0` | Matches the existing submitter `confidence` field, which the contract already bounds `minimum: 0, maximum: 1`. One scale, not two |
| Column | `swarm_judge_config.min_memo_confidence` | The `min_takes` pattern, same table, stamped onto every judgement row |
| Default | `0.5` | The judge must affirmatively say "less likely reasonable than not" before a memo is dropped |
| Comparison | drop when `score < threshold` | Strictly less, so a score exactly at the threshold survives. Pinned now because this is the classic off-by-one argument |

`0.5` is deliberately permissive. The expensive failure is not a bad memo
surviving — the mean dilutes it. The expensive failure is mass dropping, which
empties the vector and terminally refuses the receipt (see (d)). A first ship
should under-filter.

**Ship the filter in `shadow` first.** This is why the threshold really is
immaterial today. The judge already has a `shadow` mode built for exactly this —
"computing and recording an opinion that reaches no session — for as long as it
takes to trust it" (D42). The filter should ride that same rail: record every
per-memo score and the set that *would* have been dropped, change no vector.
Then the threshold is chosen against observed score distributions on real
sessions instead of being guessed now. The unfiltered-versus-filtered gap
(§12.2) is the signal to read.

**(c) Thin support must be recomputed against survivors.** `min_takes` compares
against a take count. After filtering, the comparison has to use the
contributing count. Otherwise a session where the judge dropped most memos still
reports itself well-supported.

**(d) Every memo dropped is a real, reachable state.** The vector is then absent,
which is `weights_absent_for_bucket_weights_subject` — a TERMINAL refusal. The
session still publishes and loses its receipt, which is correct under
"the machine never stops". It must be a **named, alerted** condition rather than
an accident, because it is also what a malfunctioning judge looks like.

### 11.6 Reproducibility hazard — canonical data moves

Macro data is revised. A judge that checked a claim against a series at judging
time, and a verifier who re-reads that series a month later, do not see the same
numbers. Left alone this silently breaks INV-TG1.

The fix is the pattern the repo already uses elsewhere: pin a snapshot. Sessions
already carry `report_snapshot_id`, `swarm_subject_snapshots` and a digested
`regimeComposite`. Whatever canonical series the judge consults must be
snapshotted, identified in the judgement row, and covered by `inputs_digest`.

**A fact-check against live, unpinned data is not auditable and must not ship.**

## 12. Open decisions

1. ~~What is the drop threshold?~~ **Resolved** — placeholder `0.5` on a
   `0.0 … 1.0` scale, as `swarm_judge_config.min_memo_confidence`, drop when
   `score < threshold`. See §11.5(b). Tune it from shadow-mode observations
   rather than from argument.
2. Does `meanTakeWeights()` over the *unfiltered* set stay published alongside
   the filtered one? Keeping it is a cheap audit signal — a large gap between
   the two is exactly the symptom of a judge filtering too aggressively.
3. §9's two questions — may a non-model opinion exist, and may it be certified?
   §11 narrows this: an evaluator that cannot reach a model has nothing to say
   about any memo, so the zero-fallback answer looks more natural under the
   target design than under today's.
4. Should GAP-1 through GAP-4 be closed by routing every transition through
   `transitionWithin`, making the domain primitives private?
5. Should swarm judgement and receipt tables move to the stricter
   UPDATE-refusing registry (§8, GAP-9)?
6. Are the already-published receipts over template prose retracted, left
   servable, or flagged?
