# Data self-healing — detecting and repairing bad persisted state

> **Status: design proposal, first pass.** Nothing here is ratified. No accepted
> decision in [decisions.md](../decisions.md) backs this document, and none of
> the mechanisms it describes exists in `main` today. It merges two previously
> separate plans — a wallet/AUM history reconstruction project and a continuous
> source-reconciliation issue — into one design so they cannot build two
> competing repair pipelines. Since this document's first draft the wallet plan
> has been **split into three workstreams and most of it filed** (§3.1): the
> v0.2.2 release nits as **#647** with subtasks **#639–#646**, the shared
> chart-axis defect with **#624**, and only the backfill capability itself —
> four code issues plus a `decision:` issue — still unfiled. The
> continuous-reconciliation half remains unfiled in every part. **Settled:** the
> defect taxonomy (§2), the three-detector / one-dispatcher shape (§4), the five
> verdicts (§5), and the safety properties (§7) — these were argued from the
> audit evidence and from code that exists. **Open:** every scheduling,
> storage-layout, and API-surface choice, and the whole of §11. **Gated:** the
> Class C archive-read direction depends on a `decision:` issue that **has still
> not been filed** (re-checked against `gh` on 2026-08-15: no `decision:` issue
> for archive-capable reads exists); three recorded decisions currently read as
> asserting that data is unreachable, and nothing in §6.3 should be built until
> that is settled — §11 sets out which of the three needs only a clarifying
> cross-reference and which needs a genuine new entry. Where a claim below could
> not be verified against this checkout it is marked *unverified* inline.

## 1. Purpose

**Self-healing** here means one specific thing, and not a looser one: *the
system notices that its own persisted state disagrees with reality, and repairs
it, without an operator remembering to run a script.* Three properties are load-
bearing in that sentence.

- **Notices.** The comparison is performed on a standing schedule, not on
  demand. A tool that would find the defect if someone ran it is not
  self-healing; it is a forensics aid.
- **Its own persisted state.** The subject is what is already in the database,
  not what is about to be written. Write-time validation cannot repair a row
  that was written correctly under a rule we later discovered was wrong.
- **Repairs.** Detection that dead-ends at a read-only report is not healing.
  This is the specific failure the repo keeps repeating (§3).

The requirement driving this is that **bad data may be ingested through our own
bug or a vendor's**, so correctness cannot rest on write-time care alone. That
is not hypothetical. The originating audit,
[`docs/code-review/20260814-review-data-integrity-macro-index-discrepancy.md`](../code-review/20260814-review-data-integrity-macro-index-discrepancy.md),
documents a defect in v0 (`agentjuno/robotmoney`) where the pipeline persisted
its own forward-filled values back into its raw floor and read them next run as
genuine source observations. Because FRED never re-publishes weekends and
non-publication days, the fabricated rows could never be corrected by any
subsequent fetch: the merge contract is *fetched wins on overlap*, and there was
never an overlap. The audit's finding **D1** rates this CRITICAL and measures
its effect — the macro index moved `0.610602 → 0.653632` when the input floor
alone was source-date-cleaned, with `ICSA` contributing `+0.039932` of the
`0.046607` v1-v0 gap in the first captured run.

v1's storage shape is structurally immune to that particular feedback loop: it
persists sparse real observations and forward-fills at read time. But **D6**
records that v1's vendored floor-seed fixture inherited 110 source-absent `ICSA`
keys and 14 source-absent `DXY` keys from v0's floor, and that the DB-rows-win
seed path retains them indefinitely, because refresh has no matching key to
overwrite. Immunity to the *mechanism* did not confer immunity to the *data*.

And **D5** (MEDIUM, both repos) states the gap this document exists to close:
*"No cross-implementation reconciliation check; a 0.05 divergence ran
undetected."* Its three recommendations — a freshness assertion against source,
a reconciliation job, and a testable persisted-floor invariant — were never
filed as issues.

## 2. The defect taxonomy

Persisted state can be wrong in four distinct ways. They are separated here
because **each needs a different detector**, and conflating them is how a
self-healer becomes a self-destroyer.

| Class | Shape | Canonical instance | Detector needed |
|---|---|---|---|
| **Absent** | the row should exist and does not | 42 missing AUM days on `/performance` | gap detector — enumerate expected keys, diff against persisted |
| **Structurally impossible** | a row exists on a date the source could never publish | v0's ICSA rows on non-Saturdays; DXY weekend rows (D1) | calendar validator — pure, offline, needs no network |
| **Present and wrong** | right shape, right date, wrong value | a vendor revision we never re-fetched; a correctly-labelled `live` row carrying a stale carry | source reconciler — re-fetch and compare key-by-key |
| **Unverifiable** | outside what the source can still re-serve | `HY_OAS` pre-history (D7): FRED serves `BAMLH0A0HYM2` only as a trailing ~3y window, and the `cosd=2010` workaround does not work for this series | none possible — disclose, never repair |

The state of play is uneven and worth stating bluntly:

- **Absent** has partial machinery: a gap detector exists on PR #615's branch,
  read-only, with no repair path.
- **Structurally impossible** has partial machinery: a calendar validator is
  merged, but runs offline against a committed fixture and classifies most of
  the registry as unconstrained.
- **Present and wrong** has **none**. Nothing in this repo ever re-asks a source
  about a date it already gave us. A persisted row that is present,
  calendar-valid, and simply wrong is invisible forever.
- **Unverifiable** has no machinery and needs none, but it needs a *label*, so
  that "we checked and it was fine" and "we cannot check" are distinguishable.

## 3. What exists today, and what each layer is blind to

Every integrity mechanism this repo has is write-time or absence-shaped.

| Layer | Where | Blind to |
|---|---|---|
| Provenance labels (`live`/`stub`/`stale`/`seed`) | `backend/migrations/0014_wallet_balance_samples.sql:30`, `backend/migrations/0024_analytics_provenance_source.sql:21` | a row correctly labelled `live` whose **value** is wrong |
| Calendar guard (#616/#630) | `backend/src/analytics/extract/floor-seed-calendar.ts:85` (`validateFloorCalendar`) | anything on a calendar-legal date; every source it classifies `"any"`; and it never runs against production data |
| Gap detection (#614) | `ops/gap-detector.ts`, PR #615 branch — **not in `main`** | present-but-wrong rows — absence-only by construction; dead-ends at a read-only `GET /api/admin/gaps` |
| EDGAR two-tier refresh (#488/#509) | `backend/src/analytics/edgar-incremental-refresh.ts:101` (`selectEdgarRefreshTier`), `backend/src/analytics/extract/edgar-fetch-plan.ts:309` (`assessEdgarBatchDivergence`) | everything outside the single EDGAR indicator |
| Forward-fill cap (#402) | `backend/src/analytics/transform/math.ts:302` (`MAX_FORWARD_FILL_DAYS = 120`), surfaced at `backend/src/analytics/index.ts:528` | emits a DTO field (`forward_fill_expired`) only; raises no alert |
| Destructive upsert | `backend/src/analytics/store/raw-history-store.ts:67-69` — `ON CONFLICT (date, indicator) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source` | no audit trail; nothing records when a row was last checked, so "never verified" and "verified and confirmed" are indistinguishable |

Three specifics matter more than the table conveys.

**The calendar guard is offline and mostly permissive.**
`sourceCalendar()` (`floor-seed-calendar.ts:44-54`) returns one of three values.
`ICSA` is `weekly_saturday`; every other `fred` source and every non-crypto
`yahoo` symbol is `business_day`; **everything else is `"any"`** — all
coinmetrics / blockchain\_com / defillama sources, both crypto Yahoo tickers,
`SHILLER_CAPE`, and `NEW_TOKENS`. `validateFloorCalendar` skips `"any"` outright
(`:89`), and `filterCalendarValid` returns the rows untouched (`:105`). The
predicate itself is nothing more than UTC day-of-week (`dayOfWeek`, `:59-61`;
`isCalendarValidDate`, `:63-69`) — it knows nothing about holidays, and it makes
no network call by design (`"Pure — no network, no SQL"`, `:16`). Its callers
are the seed generator, the one-time production cleanup in
`backend/src/analytics/store/seed-provenance.ts`, and the CI guard test. **None
of those is a standing check against the production floor.**

**EDGAR is the only real reconciliation loop in the system, and it covers one
indicator.** `selectEdgarRefreshTier(asOf)` picks `full` on one configured
weekday and `incremental` otherwise (`edgar-incremental-refresh.ts:101-107`) —
the incremental-daily / full-weekly cadence this design borrows in §6.1. The
`#509` guard, `assessEdgarBatchDivergence`
(`edgar-fetch-plan.ts:309-368`), is the only place in the repo that refuses to
overwrite a persisted floor on the grounds that the *fetch* looks wrong rather
than the *row*.

**`remediationClass` has zero behavioural consumers.** The field is declared in
`ops/series-registry.ts` on PR #615's branch and appears only there, as a
passthrough into `GapReport`, and in the DTO. `detectAllGaps` has exactly one
caller: the read-only `GET /api/admin/gaps` route. *(Verified negatively here:
`grep -rn remediationClass backend/src contract/src` returns nothing in this
checkout, because #615 is unmerged. The positive claims about its contents are
inherited from Plan A's inspection of that branch and are **unverified** against
`main`.)*

This is a pattern, not an accident. `backend/scripts/seed-provenance-verify.ts`
has a real executed CI test (`backend/tests/seed-provenance-verify.test.ts:5`
imports its `main`) and **no production caller** — no boot path, deploy gate, or
cron (filed as #638). `forward_fill_expired` is computed and shipped in a DTO
and alarms nothing. This codebase repeatedly ships a correct mechanism and never
wires it up, which is the failure mode this design must not repeat: **every
acceptance criterion should assert the caller, not just the mechanism.**

### 3.1 Where the source plans are now tracked

The wallet/AUM half of this design came from a project plan that has since been
**split into three workstreams**, and only one of them is this document's
subject. The split is worth stating precisely, because two of the three are
already filed and must not be re-specified here.

| Workstream | Contents | Tracking |
|---|---|---|
| **Backfill capability** — the subject of §6.3 | block-addressable reads, date→block resolution, historical prices, RPC batching, the repair driver | **Unfiled.** Four code issues plus a `decision:` issue, all gated on that decision (§11). |
| **v0.2.2 release nits** | undeliverable env vars, the `BUYBACK_FROM_BLOCK` constant, runbook verification gaps, #614's AC4 discrepancy | **#647** (parent) with subtasks **#639–#646**, filed 2026-08-15. Explicitly **not** part of the backfill project. |
| **Research engine cleanup** | the shared `chart-theme.js` category-axis defect and the regime charts | **#624**. Not part of the backfill project. |

The continuous-reconciliation half — the audit's D5 recommendations (§1) and the
Class A reconciler of §6.1 — is **unfiled in every part**; a `gh issue list`
search on 2026-08-15 found no issue covering a freshness assertion against
source, a reconciliation job, or a testable persisted-floor invariant.

Two of the filed nits are load-bearing for this design rather than incidental,
and are treated where they belong: the compose-allowlist defect class in §8.1,
and #645's closure in §11.

### 3.2 Step 0 — merge and deploy PR #615, and prove the clamp self-heals

Everything in §6 assumes PR #615's baseline: the gap detector, the series
registry, `remediationClass`, the `'backfilled'` provenance value, and the
scheduler-wedge clamp all live on that unmerged branch. Merging and deploying it
is step 0 of any sequencing built from this document, and it is the step that
stops the AUM hole widening.

One verification at that step cannot be skipped. **The wedged schedules live in
an external Postgres that survives every teardown**, so redeploying does not
reset them. It must be shown explicitly that the clamp **self-heals rows that
are already pinned**, on its first tick, rather than only preventing future
wedges — a fix with only the second property ships green while production stays
frozen. That is an assertion against the persisted rows, not a code reading.

## 4. Architecture — three detectors, one dispatcher, per-class executors

```
detectors                                  dispatcher                executors
─────────────────────────────────────      ──────────────            ─────────────────────
gap detector      (absent)          ─┐
calendar guard    (impossible date) ─┼──►  remediationClass   ──►    A: re-fetch source
source reconciler (present, wrong)  ─┘     dispatch + guard          B: recompute
                                                                     C: archive read @ block
```

Two rules follow from that picture, and both are there to prevent a specific
predictable mistake.

**There must be exactly one remediation dispatcher.** The two source plans each
independently proposed wiring `remediationClass` to something that repairs. If
both are built, the repo acquires two dispatchers with two different notions of
what a repair is, and the blast-radius guard ends up implemented twice and
differently. Whichever work lands first builds the dispatcher, generically
enough for the other to plug into; the second **must not fork a parallel one**.
If the repair driver lands first, the reconciler contributes a divergence
trigger plus the five-verdict classifier and consumes the dispatcher unchanged.

**The blast-radius guard sits in front of the executors, not inside a
detector.** Put it in a detector and each detector gets its own half-guard: the
chain backfill would be guarded on absence heuristics and the Class A repair on
divergence heuristics, and neither would protect the other's writes. In front of
the executors, one guard sees every proposed mutation regardless of which
detector proposed it.

Detectors are pure and read-only. Executors are the only things that write.
The dispatcher's job is to map `(series, verdict, defect class)` to an executor
and to refuse when the guard says no.

## 5. The five verdicts

Every persisted key inside a verification window classifies as exactly one of
five verdicts. The classifier is pure: it takes the persisted rows, the source
response, and the series' declared calendar, and returns verdicts. It does not
write.

| Verdict | Meaning | Action |
|---|---|---|
| `confirmed` | source has the key; value matches within tolerance | stamp `last_verified_at`; **no write to `value`** |
| `revised` | source has the key; value differs | **repair** — upsert the source value; this is exactly the existing documented *"fetched wins on overlap so source corrections / revisions land"* contract, applied on a schedule rather than only on the daily fetch |
| `fabricated` | source lacks the key **and** the declared calendar says the source could never publish that date | **quarantine**, reversibly; never hard-delete |
| `unexplained_absent` | source lacks the key but the calendar permits it — holiday, degraded source, vendor outage | **never touch**; count, and alarm once it persists across N consecutive runs |
| `unverifiable` | key predates the source's re-servable window (D7's `HY_OAS`) | leave, count, disclose |

### Why `unexplained_absent` is the whole safety argument

The difference between a self-healer and a self-destroyer is one bad inference:
*the source didn't give me this key, therefore this key is fake.*

That inference is wrong whenever the source is degraded rather than
authoritative. A vendor returning **HTTP 200 with a truncated window** is the
canonical case — well-formed, parseable, no error to catch, and simply missing
half of history. Classify that as `fabricated` and the system deletes correct
data at scale, in a single automated batch, with the audit trail saying it was
repairing itself.

So `fabricated` requires **two** independent conditions, not one: the source
must lack the key, *and* the declared publication calendar must say the source
could never have published that date. Non-Saturday `ICSA` rows satisfy both, and
that is exactly the audit's structural proof — FRED's ICSA has observations only
on Saturdays, 867 of 867 since 2010, so *"dates without observations cannot be
revised — they never existed."* A missing Tuesday `DXY` row satisfies only the
first, and lands in `unexplained_absent`, where nothing touches it.

Two further guardrails on the classifier, both drawn directly from the audit:

- **Do not equate repeated values with fabricated rows.** The audit is explicit:
  in the vendored seed, the 125 `ICSA` rows carrying `215000` classify as 110
  source-absent, 13 genuine observations, and 2 source-overlap rows that live
  refresh corrects. `119.2868` is `DTWEXBGS`'s genuine value for Friday
  2026-05-22. *"The values are real; only their dates are fabricated."*
  Classification is by **source key**, never by value repetition.
- **A truncated window classifies as a window, not as rows.** If the source's
  response is short or degenerate, the whole compared window goes to
  `unexplained_absent` and the batch mutates nothing — see §7.3.

## 6. Per-class treatment

`remediationClass` partitions series by *how* a wrong row can be corrected. The
three classes need genuinely different executors.

### 6.1 Class A — `raw_indicator_history`, re-fetchable

This is where the defect class actually occurred and where every source is an
ordinary HTTP re-fetch the pipeline already performs. It gets **full comparative
reconciliation**: re-fetch the source's re-servable window, classify every
persisted key against it, repair `revised`, quarantine `fabricated`, leave the
rest.

Design points specific to Class A:

- **Cadence tolerance replaces row count as the freshness test.** Each series
  asserts its last *real* observation is within its declared publication
  cadence. This is the audit's highest-value recommendation ("cheapest first")
  and catches D1, D2, and D3 in one check. D2 is the shape it catches:
  `SHILLER_CAPE` frozen at 2023-09-01 while the fetch summary prints a healthy
  tick because 1,713 rows came back. Row count is not freshness. The same
  pattern is live in v1's own extractor — `backend/src/analytics/extract/sources.ts:113-116`
  logs `EMPTY` versus `ok` purely on `data.length === 0`.
- **Reconciliation fetches must bypass the TTL cache**
  (`backend/src/analytics/extract/fetch-cache.ts`), or the loop compares
  persisted state against our own cached copy of it and always agrees.
- **Cadence must be declared once.** It is currently declared twice and the two
  already disagree: `backend/src/analytics/analyze/indicators.ts:113` says
  `DTWEXBGS` is *"Published weekly (not the daily DXY ICE futures index)"*,
  while `floor-seed-calendar.ts:48` classifies every `fred` source
  `business_day`. The audit's structural proof — `DTWEXBGS` publishes business
  days only, so v0's weekend rows are fabricated — and FRED's `D`-prefix
  convention both say `business_day` is correct, so **the prose is wrong and the
  code copy is the one driving production deletes** (`store/seed-provenance.ts:58-61`
  issues `DELETE FROM raw_indicator_history … AND source = 'seed'`). Promoting
  cadence to single-source-of-truth registry metadata, consumed by the calendar
  validator rather than restated in it, makes the contradiction
  unrepresentable. Tracked as **#637**.
- **Cadence: incremental daily over a trailing window, full weekly**, mirroring
  `selectEdgarRefreshTier` (`edgar-incremental-refresh.ts:101-107`). Whatever
  producer kind carries it must be added to `checkArmedSchedules`'s kind list
  (`backend/src/producer/index.ts:216`, today `["regime", "research"]`) or
  liveness will not cover it — the scheduler-wedge class of failure, invisible
  by default.

### 6.2 Class B — `research_signals`, recompute-and-compare

Class B rows are derived from inputs we still hold, so the executor is
**recompute the signal for the day and compare against what is persisted**,
rather than re-fetch. A divergence means either an input changed (legitimate —
repair) or the computation changed (a methodology change, which must not be
silently backfilled over history; that is a version-relock decision, not a
repair).

One integration hazard to record now: **the existing producer catch-up computes
its own missing-days set and does not consume the gap detector.** Plan A
describes a 14-day catch-up window on PR #615's branch making `research_signals`
the only series that genuinely self-heals today. Two independent notions of
"which days are missing" will drift. Unifying them — the catch-up consuming the
detector rather than duplicating it — is the right shape, and is *unverified*
here because that catch-up is not in `main` (`grep -rn "research_signals"
backend/src/producer/*.ts` returns nothing in this checkout).

### 6.3 Class C — chain-derived, repairable but not continuously reconcilable

**Gated on a `decision:` issue that is still unfiled as of 2026-08-15 (§3.1,
§11). Nothing in this subsection should be built before that issue is settled.**

Three recorded decisions currently assert this data is unreachable:

1. [decisions.md D16](../decisions.md) rejects *"an archive indexer to
   reconstruct gap-free pre-launch history"* as out of scope for #84.
2. `backend/src/chain/token-prices.ts:10-15` states that historical valuation
   comes from the persisted `wallet_balance_samples` series, *"NOT from a
   re-fetched OHLCV series, which resolves Open Question 9"*.
3. #294's out-of-scope list — *"the indexer accumulates forward only."*
   *(unverified here — issue text, not code.)*

The empirical finding that motivates revisiting them: `https://mainnet.base.org`
— the default `BASE_RPC_URL` — **answers archive state queries.** Plan A
verified this directly against the prop wallet: `eth_getBalance` and
`eth_call balanceOf` return genuinely different values at 40 / 90 / 180 / 365-day
depth, block 2,000,000 correctly returns `"0x"` for a pre-deployment USDC read
(a correct archive answer, not a `latest` fallback), and the production
Multicall3 read path returned `success: true` for all sub-calls at latest, 40d,
and 90d. Caveats stand: undocumented free-tier behaviour, no SLA, real rate
limiting (`-32016`), and no load test of a sustained 40-day sweep.

The code change is small in *diff* terms but not in *blast radius*, and the two
must not be confused. Exactly two hardcoded `"latest"` strings exist in the
backend — `backend/src/chain/base-rpc-client.ts:374` (`ethCall`) and `:483`
(`eth_getBalance`) — and neither takes a block-tag parameter today. Every read
already threads a shared `RpcCallOptions` (`base-rpc-client.ts:184`), so a
`blockTag` field is inherited by all the exported wrappers with zero signature
changes and zero change to callers that keep reading latest.

**That inheritance is exactly why this is not a call-site tweak.** D17
established `base-rpc-client.ts` as the *single shared RPC transport* for every
live chain feed — vault economics, wallet balances, wallet sleeves, buyback
logs, token metrics. Adding block-addressing changes that transport, so a defect
in the change reaches every live chain surface simultaneously, not just the
backfill that motivated it. The mitigation is that the default must remain
`opts.blockTag ?? "latest"`, byte-for-byte preserving current behaviour for every
caller that passes nothing — but the review burden is transport-wide, and the
work should be scoped, tested, and reviewed on that basis.

Threading it through `readChainAmountsBatched`
(`backend/src/chain/wallet-valuation.ts:172`, via `rpcOpts()` at `:137`) reaches
its two callers, `backend/src/chain/wallet-balances.ts:85` and
`backend/src/chain/wallet-sleeves.ts:57`. The job-payload pattern already exists
unwired: `backend/src/worker/handlers/analytics.ts:24-25` reads
`payload.asof ?? new Date()`.

**The argument to put to the decision** is that this is *not* what D16 rejected.
An archive *indexer* means ingesting and persisting chain history yourself. This
is a block tag on reads the app already makes, against a node that already
answers — no indexer, no new vendor, no new stored chain events. The historical
*price* resolver genuinely does reverse point (2), however, and that reversal
must be made explicitly rather than smuggled in. The repo uses
`decision:`-prefixed issues for exactly this.

**So Class C is repairable but not continuously reconcilable — on cost grounds,
not impossibility.** Plan A's measurements, taken against the public endpoint:

- Structural batch cap of 10; an oversized batch fails wholesale with
  `{"error":{"code":-32014,"message":"maximum 10 calls in 1 batch"}}`.
- **The limiter meters per sub-call, not per HTTP request** — a 10-item batch
  returned exactly the first 5 results, three times running. Batching saves
  HTTP/TLS overhead and retry cycles, not throughput.
- Budget ≈ **5-token bucket, ~0.55 calls/s** refill. No `Retry-After` header.
- **Multicall3 is the real leverage:** the limiter charges per `eth_call`, not
  per inner read, so one `aggregate3` with 27 inner reads costs one token.
  Validated at 540 logical reads in 38.2s, zero errors, at batch 5 / in-flight 1
  / 9s spacing.

The limit is **per-IP at the provider**, so in-process isolation cannot create
budget. A backfill running at 0.55/s leaves the every-minute live sampler
(~0.033 calls/s, ~6%) zero headroom and will 429 it — *causing* new gaps while
fixing old ones. Ranked options: a separate `BASE_RPC_BACKFILL_URL` on a keyed
provider (the only true isolation); one shared **priority-aware** bucket where
sampler requests pre-empt and backfill is capped below ~0.4/s; or running
backfill in a sampler-quiet window. **Never give the backfill its own
independent limiter** — two limiters against one per-IP bucket sum to 2× and
guarantee 429s. Note also that what exists today
(the `acquireSlot`/`releaseSlot` gate at `base-rpc-client.ts:243-256`, sized by
`BASE_RPC_MAX_CONCURRENCY`, default 4, at `:230`) bounds
*concurrency* but not *rate*, which is why production saw a `Base RPC HTTP 429`
storm on 2026-08-10.

A bounded one-time backfill of 40 days is therefore a completely different cost
problem from re-verifying every chain day forever. Class C gets an executor;
it does not get a standing reconciliation loop until there is a keyed provider.

**The irony worth recording:** a chain read at a **pinned immutable block** is,
in principle, the most deterministically verifiable data in the system — more so
than a live-sampled macro row, which can never be re-derived at all once its
vendor window rolls off. Two independent readers at the same block must agree,
forever. The rate limit is the only thing standing between that property and a
continuous verifier.

## 7. Safety properties

### 7.1 The append-only tension, met head-on

Any quarantine mechanism collides with an existing, explicitly stated invariant,
and the collision must be argued rather than skated past.
`backend/src/analytics/store/raw-history-store.ts:1-6` does not merely *describe*
the floor as append-only — it makes never-deleting the **stated basis of the
honesty guarantee**, verbatim:

> Store stage: the append-only persisted-real floor for raw indicator inputs.
> `raw_indicator_history` holds one row per (date, indicator); the orchestrator
> loads this floor, merges freshly-fetched points over it (fetched wins on
> overlap, never deletes — see mergeSeries), and writes the merged result back.
> **This is what keeps the pipeline honest: a failed/empty fetch degrades to real
> persisted history, never to synthetic data.**

Four observations resolve this, in order.

**1. The comment's own justification is a threat model about an absent answer,
not a universal retention rule.** The stated harm is *"a failed/empty fetch"*
erasing real history and leaving synthetic data in its place. That is a claim
about what must survive a **degraded source**. It is not a claim that a row which
was **never an observation** must be retained forever — and it cannot be, because
the rows in question are precisely the ones the comment is defending *against*
("never to synthetic data"). Quarantining a calendar-invalid row serves the
comment's goal rather than violating it: it removes synthetic data from the read
path while leaving every real persisted observation exactly where it was.

**2. The executed guard for that threat model must not weaken, and does not.**
`backend/tests/analytics-suite.test.ts:148` is the test that encodes it —
*"append-only raw floor persisted; a later EMPTY fetch never erases it"* — and it
re-runs the pipeline with an `AnalyticsDataSource` returning `[]` for every
indicator, asserting the persisted floor survives (`:155-160`). **Hard invariant
this design preserves: an empty or failed fetch must still never remove
anything.** That is exactly why the classifier requires two independent
conditions for `fabricated` (§5) and why a degenerate response sends its whole
window to `unexplained_absent` (§7.3). A quarantine triggered by source absence
alone would break this test, and breaking this test means the design is wrong,
not the test.

**3. "Append-only" already has a shipped exception in code.** `--purge`
full-universe seed regeneration (#616, merged in `03a2b01`) is non-additive by
construction: `backend/scripts/floor-seed-regenerate.ts:49-59` invokes
`generateFullUniversePurge`, and
`backend/src/analytics/extract/floor-seed-generator.ts:111-119` states the floor
is *"fully purged — only freshly fetched rows survive"*. It carries both of the
guards this design generalizes — a source-calendar validity filter
(`filterCalendarValid` on both the preserved and fetched sides, `:176-177`) and
refuse-if-zero-rows (`:173`, *"refusing a purge that would delete its entire
history"*; plus `:185-186`, refusing to write if any calendar-invalid row
survived filtering, and `:83` for the per-indicator path). So the precedent for
"remove a row that the source calendar says was never an observation, under a
refuse-on-degeneracy guard" is already merged. Quarantine is a *weaker*
operation than `--purge`: reversible, per-key, and read-path-scoped rather than
whole-artifact.

**4. The canonical prose describing that exception is already stale.**
[architecture.md](../architecture.md) §"Regime raw floor seed (issue #400)" still
describes `floor-seed:regenerate` as only additive and per-indicator —
`docs/architecture.md:780-787`, *"additively merges it into the existing
committed floor (`mergeSeries` — fetched wins on overlap)"* — with no mention of
`--purge`, the full-universe mode, or the calendar filter. That prose predates
#616/#630 and does not describe current behaviour. **Recorded here as a
discrepancy only; this document does not edit `architecture.md`.** Whoever files
the reconciliation work should also file the doc correction, because a reader who
consults architecture.md today will conclude that a non-additive floor rewrite
has no precedent, which is the exact reasoning this subsection exists to
forestall.

### 7.2 Quarantine, never hard-delete

Repaired-away rows are moved or flagged **reversibly** and excluded from every
read path. No path hard-deletes. This is not squeamishness: the classifier's
`fabricated` verdict is an inference about a vendor's publication calendar, and
if that inference is wrong the only thing standing between a bug and permanent
data loss is the reversibility of the operation. Quarantine also makes the
repair auditable — an operator can ask what was removed and why, which a
`DELETE` cannot answer.

The current destructive path is the counter-example to design against:
`raw-history-store.ts:67-69` upserts with
`DO UPDATE SET value = EXCLUDED.value`, and `store/seed-provenance.ts:58-61`
issues a real `DELETE`. Neither leaves a trace of what was there before.
Relatedly, `raw_indicator_history` needs a `last_verified_at` column so an
unchecked row is distinguishable from a confirmed one; today the table is
`(date, indicator, value, source)` only
(`backend/migrations/0009_analytics_v2.sql:29-33` plus
`0024_analytics_provenance_source.sql:21`). The next migration ordinal in this
checkout is `0032` (highest present is `0031_swarm_member_handle_namespace.sql`).

### 7.3 The blast-radius guard

Generalize `assessEdgarBatchDivergence` (`edgar-fetch-plan.ts:309-368`) from one
indicator to the registry. Its three checks, as implemented, are exactly the
three a reconciler needs:

1. **Degeneracy** (`:325-335`) — an all-zero or near-all-zero batch is refused:
   *"answered well-formed but empty, refusing to overwrite the persisted floor."*
   This is the HTTP-200-but-broken case.
2. **Rewrite ratio** (`:339-347`) — if the batch would rewrite more than a
   declared fraction of the already-persisted keys it compared, it is *"a bulk
   rewrite, not a revision"* and is refused whole.
3. **Aggregate drift** (`:348-364`) — if `|Σfresh − Σprior| / Σprior` exceeds
   its bound, refuse.

Two properties of that implementation carry over and should not be lost. The
ratio checks apply only to **reconciliation-sized batches** (`compared.length >=
minComparable`, `:338`), so a small legitimate correction is not blocked by a
percentage rule that is meaningless at n=2. And the batch is refused **whole and
alarmed** — never partially applied — so a guard trip cannot leave the floor in
a half-repaired state that the next run reads as the new baseline.

### 7.4 Enforcement is server-side

The guard is enforced in the API process, **not** in the producer. The producer
is a client across the issue **#106** persistence boundary and holds no
`DATABASE_URL`: per [architecture.md](../architecture.md), the orchestrator
never writes SQL, every analytics read/write goes through the
`AnalyticsPersistence` port, and the independent `analytics-producer` submits
through authenticated typed routes. A guard living in the producer is a guard
the database does not have. Validation runs **before the transaction opens** —
`contract/src/routes.js:205-209` states the boundary contract: *"Mutations
validate the whole payload before opening a transaction and are idempotent on
their natural keys. There is NO generic SQL-over-HTTP endpoint."*

No quarantine or delete route exists today. The analytics verbs are
`readiness`, `rawHistory` (GET/POST), `rawHistorySeed`, `regimeSnapshots`, and
`researchSignals` (`contract/src/routes.js:210-216`), all upsert-shaped. A
reconciliation report plus proposed repairs needs a new authenticated verb in
that namespace, not a new surface beside it.

**A worker-side implementation is foreclosed at the database, not merely by
convention.** `backend/tests/analytics-worker-role.test.ts:101` asserts that
`rm_worker` receives Postgres error `42501` (insufficient privilege) on
`DELETE FROM raw_indicator_history`, alongside the same assertion for `INSERT`
(`:93`) and `UPDATE` (`:97`), and for `regime_snapshots` and `research_signals`.
The role can still `SELECT` (`:107-110`). So **the quarantine writer must run as
the API role.** This is consistent with the #106 API-owned boundary —
`raw-history-store.ts:8-12` marks the module API-OWNED and names
`tests/analytics-api-boundary.test.ts` as the enforcer — but it is worth stating
as a design constraint in its own right, because it rules out the otherwise
natural implementation of putting the repair executor in a worker job next to
the sampler that produced the data.

### 7.5 Day-atomicity and per-day checkpointing

For the Class C backfill specifically:

- **A day is atomic.** Never write a day whose round-1 read partially failed,
  because round 2 (`convertToAssets` NAV per vault,
  `wallet-valuation.ts:263+`) depends on round 1's output. A half-read day
  produces a plausible, wrong total.
- **Checkpoint per day for resumability**, following the `buyback_scan_state`
  precedent (`backend/migrations/0015_buyback_swaps.sql:42-46`: a single-row
  table holding the highest block already scanned, `id int PRIMARY KEY DEFAULT 1
  CHECK (id = 1)`). This is a cost optimisation, not a correctness requirement —
  the upsert is already idempotent — but committing per day means an
  interruption loses at most one day of work.

### 7.6 The unknown-provenance hazard

**An unrecognised provenance value renders as unbadged and fully live.** This is
the most misleading direction a failure can fail in, and it is live today.

`WalletHoldingProvenance` is `"live" | "stub" | "stale" | "seed"`
(`contract/src/dashboards.d.ts:80`), and the frontend switches on it by
equality:
`frontend/public/assets/js/app/alpine/views/allocation.js:112` tests
`h.provenance === "stub"` and `:115` tests `h.provenance === "stale"`. Any value
that is neither — including a new one the backend starts writing — takes no
branch, gets no badge, and is presented to the user as ordinary live data.

`provenance` has **no CHECK constraint** on any table
(`0014_wallet_balance_samples.sql:30` declares it `text NOT NULL DEFAULT 'live'`
with the permitted values in a *comment*), so a new value needs no migration —
which is precisely the trap. **Any new provenance value must land in the DTO
union and the renderer in the same change as the writer.** A quarantine state
and a `'backfilled'` state each need this treatment.

Stated precisely, because the distinction matters: Plan A says #615 "already
added `'backfilled'` to the union" — that is **true of PR #615's unmerged
branch and false of `main`.** The union in this checkout is still the four
original values (`dashboards.d.ts:80`), so anything written today with
`provenance: 'backfilled'` would render unbadged and fully live. Whether the
value is available is a function of whether #615 has merged, and must be
re-checked against `main` rather than assumed.

## 8. The silent-zero defect class

The same defect keeps appearing on unrelated rails, and it is worth naming as a
class because a fix on one rail teaches nothing about the others unless the
shared shape is stated. The shape is **a wrong computation that reports
success**, and it has two sub-forms:

- **An absent answer decodes as a real value** — the chain and extract rails
  below.
- **Unreachable configuration degrades silently while still reporting success**
  — the config rail, §8.1.

The generalization matters to this design specifically. **A reconciliation loop
that only compares persisted values against sources catches neither sub-form.**
The first produces a value the source will happily agree with; the second
produces a value with no source to compare against at all. Both require the
value to carry *whether it was computable*, not merely what it was — which is
the same property §5 requires of `unexplained_absent`, and the reason every
executor in §6 must be able to fail a key rather than write a plausible one.

**Chain rail.** `decodeUint256("0x")` returns `0n`
(`base-rpc-client.ts:48-52`). Its own comment is honest about the trade —
*"An empty `0x` (e.g. a call to an address with no code) decodes to 0n rather
than throwing — callers decide from context whether 0n means 'really zero' or
'unreachable'"* — but no caller currently decides. Multicall3 returns
`success: true` with `returnData: "0x"` for an address with no code, so there is
no revert to catch. On the live path this is harmless: the contracts are all
deployed. On a **block-addressed historical** read it is not: a contract
deployed *after* the target date decodes to a clean, fabricated `0`, which then
becomes a plausible-looking AUM row. Block-addressed reads must let callers
distinguish empty-return from genuine zero, must treat
`success === true && returnData === "0x"` as a **hard failure for that day**,
and should carry a per-address earliest-valid-block floor so days preceding a
target's deployment are skipped rather than zeroed. Live-path semantics must not
change.

**Extract rail.** `fetchAll` wraps each source in a `try` and returns `[ind.id,
[]]` on any error (`backend/src/analytics/extract/sources.ts:104-108`), so a
**failed** fetch and a genuinely **empty** one are indistinguishable
downstream; `mergeSeries` then silently prefers whatever arrived. The run log
prints the failure, but nothing structural consumes it, and the fetch summary
immediately after (`:113-116`) reduces the outcome to `rows=0`. For a
reconciler this is fatal: an empty array from a failed fetch, compared against a
healthy persisted floor, means *every* persisted key looks source-absent. That
is exactly the input that must classify `unexplained_absent` and trip the
degeneracy guard — never `fabricated`.

### 8.1 The config rail — undeliverable variables that fail silently

The mechanism here is a delivery boundary rather than a decoder, but the outcome
is identical: a live code path computes a wrong answer and reports it as `ok`.

**The compose `environment:` block is a test-enforced allowlist.** The `api`
service's block (`docker-compose.yml:170`) says so in its own comment
(`:170-177`): there is no `env_file:` in any compose file and `backend/Dockerfile`
sets no `ENV`, so **a variable not named there never reaches the container.**
That premise is asserted rather than assumed —
`scripts/tests/integration/demo-compose-config.test.ts:520-529` greps all three
compose files for `env_file:` and the Dockerfile for `^ENV `, requiring `false`
for all four. **#641** records that roughly twenty variables read by
`backend/src/config.ts` sit in that undeliverable bucket, and **#643** proposes
the generalizing guard: a test that fails on any env name read on a live path
under `backend/src/` and absent from every compose `environment:` block, unless
explicitly listed as intentionally host-side-only. *(The allowlist mechanism and
its guard test are verified in this checkout; the ~20-variable count is #641's
and was not re-counted here.)*

Three filed instances, each a different route from that boundary to a quietly
wrong number:

- **`BUYBACK_FROM_BLOCK` (#640) — a typo permanently disables the indexer with
  no warning.** `backend/src/chain/buyback-logs.ts:215` reads
  `Number(process.env.BUYBACK_FROM_BLOCK ?? "0")`, and the only diagnostic is
  guarded by `floor <= 0` (`:216`, warning at `:222-224`). A typo such as
  `43,741,600` makes `Number()` return `NaN`; `NaN <= 0` is **false**, so the
  warning is skipped. `floor` then feeds `let from = Math.max(…)` at `:242-245`,
  whose two arms fall back to `floor` when the persisted scan cursor and
  `MAX(block_number)` are null — so on a fresh database `from` is `NaN`,
  `from <= latest` at `:253` is false, and the chunk loop never executes. Zero
  work, no warning, indefinitely. *(Code verified in this checkout.)*
- **`STRATEGY_VAULT_*_ADDRESS` (#642) — wrong numbers live in production now.**
  All five keys (`backend/src/config.ts:246-251`) are undeliverable, and
  `resolveStrategyVaults()` (`:253`) returns an empty list by default, so
  ZYFAI-SS1 and GIZA-SS1 NAV is permanently pinned to the documented degraded
  idle-USDC-only mode. The maintenance mechanism the #120/#145 design depends on
  — an owner-maintained vault list, opt-in per vault, because *"the agent
  rotates vaults every 1-2 days"* — cannot be operated in a containerized
  deployment at all, so the accepted "drift risk" is in fact the guaranteed and
  only behaviour. *(The key list and the empty-by-default resolver are verified
  here; the characterization of the live production impact is **#642's finding**,
  not an independent verification by this document.)*
- **SP500 sizing (#641) — a plausible dollar figure with no staleness signal.**
  `readChainAmounts` sets `{ ok: true, amount: resolveSp500().size }`
  unconditionally for the `config` valuation kind
  (`backend/src/chain/wallet-balances.ts:80`, inside `:74-89`), so an unset or
  stale `SP500_SIZE` never degrades to `stale` the way a failed chain read does.
  The default is a hardcoded `0.6330` (`backend/src/config.ts:267-273`).
  *(Verified in this checkout.)*

**Why this belongs here rather than only in #647.** Each of the three produces a
value that a source comparison either cannot see — SP500's *size* has no source
to compare against, which is the same fact that makes it unbackfillable (§10) —
or would misread as a genuine observation, since `indexed: 0` is a true
statement about an indexer that never ran. The design consequence is exactly the
one §5 draws for `unexplained_absent`: **what a detector consumes must carry
whether the value was computable, not just what the value was.** An `ok: true`
that means "we did not even try" is indistinguishable from a real read at every
layer above it, and no amount of comparing numbers to sources recovers the
difference.

## 9. Constraints inherited from the existing system

These are not negotiable within this design; a proposal that violates one is
proposing a different change.

- **The issue #106 persistence boundary.** The producer holds no `DATABASE_URL`
  and submits through authenticated typed routes. Any new write path is a new
  typed verb under `/api/analytics/*` with server-side validation before the
  transaction opens, not a script with a connection string.
- **Keyless sources only, GeckoTerminal and Yahoo hosts only.**
  `backend/src/chain/token-prices.ts:3-8` is explicit: *"this file reaches ONLY
  the GeckoTerminal (crypto) and Yahoo (SP500) hosts … No Alchemy/DexScreener/
  CoinGecko/Dune/Supabase host or import."* CoinGecko is reachable and **banned**.
  New GeckoTerminal *endpoint* code is explicitly permitted (`:6-8`), so a daily
  OHLCV fetcher is in bounds — but `runGeckoBatch` must not be reused: it is
  address-keyed with no time dimension and targets a spot-only endpoint. Copy
  the pattern, not the code.
- **Pool addresses are derived, never configured.** The OHLCV endpoint is keyed
  by *pool*, not by the token addresses the spot path uses. An earlier draft of
  the wallet plan called populating `WETH_POOL_ID` / `ROBOTMONEY_POOL_ID` /
  `BNKR_POOL_ID` a blocker on historical prices; **the revised plan retracts
  that** — those vars are dead and there is nothing to populate. Pools are
  resolved at use time via `GET /networks/base/tokens/{addr}/pools` (keyless),
  and two properties of that resolution are load-bearing. Sort candidates by
  **24h volume, not reserve**: a decoy `Bnb / WETH` pool reports ~$7.68B reserve
  against zero volume and wins a `max(reserve_in_usd)` selector outright. And
  **resolve once, then cache the pool id** — a keyless 429 was observed on the
  6th call in ~15s, against an endpoint the repo has already tuned to conserve
  quota (`token-prices.ts:63-70`, the micro-batching serializer from #202).
  *(Both measured in the 2026-08-15 investigation; **unverified** here — see
  §12.)*

  The dead-code claim needs stating more precisely than **#639**'s title does,
  since that title says "zero readers" and the env vars *are* read: `config.ts`
  reads all three (`:182`, `:187`, `:189`, `:201`, and `resolveWeth()` at
  `:297`) and assigns them into `TrackedAsset.poolId` (`:157`). It is **`poolId`
  that has no readers** — `grep -rn poolId` outside `backend/src/config.ts`
  returns nothing anywhere in the repo. #639's remedy is unaffected, because it
  deletes the whole chain: the three vars, the field, `resolveWeth()`'s half of
  it, and the unconsumed `config.weth`. *(Verified in this checkout.)*
- **The D15/D16 honesty invariant, whose enumeration is closed.**
  [decisions.md D16](../decisions.md) at `docs/decisions.md:372-374` states it as
  a **closed list**: *"a value is either a real read, a labelled stub, or the
  last-persisted sample marked `stale`/`seed` — never presented as live."* Three
  admitted states, joined by "either/or". A quarantined or reconciled row is a
  **fourth state the list does not admit**, so the tension must be resolved
  explicitly rather than left implicit.

  **The resolution: the enumeration governs what is *presented*.** A quarantined
  row is excluded from every read path, so it is never presented as anything at
  all — it is outside the enumeration's scope rather than a violation of it. The
  invariant constrains the DTO surface, not the storage layer; nothing in D16
  says the database may hold only those three kinds of row. A `revised` row, by
  contrast, is squarely inside the enumeration: it *is* a real read, freshly
  re-fetched from source, and needs no accommodation.

  **The hard consequence:** if a quarantined row ever does reach a DTO — an
  operator surface that lists what was quarantined, say, or a per-point flag
  that survives into a chart payload — then it is being presented, the
  read-path-exclusion argument evaporates, and **the enumeration must be
  extended in a decision entry first**, not in the same PR that ships the
  renderer. This design extends the invariant from write time to standing
  verification; it does not weaken it.
- **Cadence declared once, not restated** (#637) — see §6.1.
- **No new operator surface.** Verdicts and freshness alerts land in the
  existing `GET /api/admin/overview` alerts feed
  (`backend/src/admin/overview.ts:47`, `AlertLevel`), not a parallel dashboard.

## 10. What will remain imperfect

Stating these up front prevents the design being read as a promise it cannot
keep.

- **SP500 has no position history, so it must be skipped, not approximated.**
  The price is recoverable from Yahoo — `fetchYahoo(symbol, startUnix, endUnix,
  timeoutMs)` (`backend/src/analytics/extract/yahoo.ts:44`) already takes a
  range — but the position *size* is a single present-tense constant,
  `resolveSp500()` reading `SP500_SIZE` (`backend/src/config.ts:267-273`), with
  no history and no positions API. Multiplying today's size by a past price
  **fabricates a quantity**. Skip it. (A 365-day `^GSPC` call returned 252
  points: weekends and holidays are absent and would need forward-filling
  anyway.)
- **`2026-03-24` and `2026-06-04` stay missing.** They are literal omissions
  from the seed constant: `LABELS` in
  `backend/src/chain/wallet-history-seed.ts:17` jumps `"Mar 23","Mar 25"` and
  `"Jun 3","Jun 5"`. The surrounding days are unreconciled baked UI constants,
  so splicing archive-derived values between them mixes two incompatible bases.
  Leave them, or interpolate from neighbours and label `'seed'` — a judgement
  call, not a correctness question.
- **`NEW_TOKENS` accumulates forward by design**, per its own registry entry
  (`indicators.ts:317`) and the calendar guard's comment describing it as *"the
  single-point-per-run NEW_TOKENS accumulator"*
  (`floor-seed-calendar.ts:41-42`). It has no re-servable window; it is
  permanently `unverifiable`.
- **`HY_OAS` pre-history is unrecoverable** (D7). FRED serves `BAMLH0A0HYM2`
  only as a trailing ~3y window; the `cosd=2010` workaround `fred.js` documents
  as the fix does not work for this series. Its 1095-day percentile window sits
  exactly at the edge of what the source can re-serve, and the two
  implementations' different spans measurably changed panel weights. Disclose,
  never repair.
- **Four incompatible provenance vocabularies, none CHECK-constrained.**
  `WalletHoldingProvenance` is `"live" | "stub" | "stale" | "seed"`
  (`dashboards.d.ts:80`); `AnalyticsProvenance` is
  `"live" | "hermetic" | "fixture" | "seed"` (`dashboards.d.ts:146`); the SQL
  columns constrain nothing. **Six persisted series carry no provenance column
  at all** — `research_signals`, `vault_share_price_history`, and the four
  `daily_*_snapshots`. *(Column-absence count inherited from the reconciliation
  doc; **unverified** here.)* Unifying these should be its own issue, taken
  **before** a third vocabulary is added, not after.

## 11. Open questions

- **The archive-read `decision:` issue has still not been filed** (re-checked
  against `gh` on 2026-08-15). It blocks all of §6.3 and nothing else — the rest
  of the source plan has since been filed elsewhere (§3.1), so this is now the
  single unfiled prerequisite in front of the backfill workstream rather than
  one gap among many. But the decision-level work is smaller and better targeted
  than "reverse D16", and it splits into two questions with different answers.

  **D16 needs a clarifying cross-reference, not a superseding entry.** Its
  rejection names a *component* — *"an archive indexer to reconstruct gap-free
  pre-launch history"*, `docs/decisions.md:368-371` — and scopes it *"explicitly
  out of scope for #84"*. A block tag on reads the app already issues is not
  that component: no ingestion, no new persisted chain events, no new vendor.
  What the 2026-08-15 archive finding actually contests is the **unstated
  premise** inside *"a full indexer is more machinery than the feature needs"* —
  namely that reaching this data requires a full indexer at all. That premise is
  false, and saying so is a clarification.

  **A new ADR becomes required only if historical reads are used to backfill
  `wallet_balance_samples`.** That crosses from clarification into reversal,
  because D16 commits to a specific shape for that table
  (`docs/decisions.md:339-345`): *"seeded once with a pre-launch history
  backfilled from the retired baked constants (`chain/wallet-history-seed.ts`,
  marked `provenance: 'seed'`, never `'live'`)"*, then accumulated forward by the
  per-minute sampler. Writing archive-derived rows into it changes both the
  seeded-once-then-accumulate-forward shape and the `provenance: 'seed'`
  labelling contract. **Read-only gap detection using historical reads does
  not** — it writes nothing and changes no committed shape, so it can proceed on
  the clarification alone.

- **"Open Question 9" has no canonical record anywhere, which makes its
  reversal a hard requirement rather than a courtesy.** `grep -rn "Open
  Question" docs/` returns nothing but this document. Its resolution exists at
  exactly one place in the repo: the comment at
  `backend/src/chain/token-prices.ts:10-15`, asserting that historical valuation
  comes from persisted samples *"NOT from a re-fetched OHLCV series, which
  resolves Open Question 9"*. So a historical price resolver genuinely reverses
  it, and **cannot be recorded as superseding any numbered decision, because
  there is no numbered decision to supersede.** It needs its own decision entry.
  And any such change **must edit that comment in the same diff**, or it leaves
  an actively false statement at the exact spot a future reader will consult
  when asking whether historical prices may be re-fetched.
- **Is a keyed RPC provider acquired?** This is the difference between Class C
  getting a bounded one-time executor and Class C getting a standing verifier.
  It is a spend decision, not an engineering one.
- **Resolved, and not in the direction an earlier draft assumed: `source:
  "live"` on the wallet-balances DTO is not a defect.** It was filed as **#645**
  and **closed NOT_PLANNED on 2026-08-15T18:39Z**, on the grounds that the
  issue's premise was wrong. The ~99 seed points in the wallet history are
  **genuine observed data from v0's production wallet-balance crons** — not
  fabricated, not forward-filled. The decisive evidence in the closing comment:
  v0's separately recorded `totalAum[]` array, dropped during the port to
  `backend/src/chain/wallet-history-seed.ts` and never previously used as a
  cross-check, agrees with the sum of the eight rounded per-asset legs to within
  $2 on **99 of 99 days** (exact on 43) — the arithmetic signature of one
  full-precision dataset totalled and then rounded, which no fill or synthesis
  produces. `resolveBaseRpcSource()` (`backend/src/config.ts:25`, consumed at
  `backend/src/chain/wallet-balances.ts:186` and `:228`) reports which *reader*
  the deployment is configured against and makes no claim about history
  composition, so it is truthful on its own terms.

  **The design consequence: a `seed` row is genuine history, not a defect.**
  Nothing in this document should treat provenance `seed` as a synonym for
  suspect, and the two seeds in play are unrelated — the *analytics floor* seed
  of §1 genuinely inherited 110 source-absent `ICSA` keys (audit D6), while the
  *wallet history* seed did not. What #645 leaves behind is a **disclosure** gap,
  not a data-quality one: `loadHistory()`
  (`backend/src/chain/wallet-balances.ts:155-159`) selects only `sample_date,
  symbol, value_usd` and discards the `provenance` column the schema stores, so
  on `main` no consumer can tell seed from live at any granularity. PR #615
  fixes exactly that, with per-point provenance, a count map, and a seam banner.
  *(Issue state and closing comment read from `gh` on 2026-08-15; the v0
  `totalAum[]` reconstruction is #645's own work and is **unverified** here.)*
- **Rate limits need re-measuring from the production droplet.** The ~5-token /
  ~0.55-per-second figures were measured from a different IP. Shared NAT could
  make production strictly worse, and every §6.3 cost conclusion depends on
  them.
- **How production v1 escaped the polluted seed is unresolved** (audit §12).
  `applyRawFloorSeed` preserves source-absent seed keys, yet the captured output
  matched the source-date-cleaned model in 74 indicator-day comparisons across
  59 unique dates. Do not infer startup self-healing from the clean output. If
  production *did* self-heal by some path, that path is worth finding before
  building a second one.
- **Unquantified:** what fraction of the current production floor would classify
  `fabricated` on first run. Until that is measured against real production
  data, the rewrite-ratio bound in §7.3 cannot be set to a defensible number.

## 12. Provenance of the claims in this document

Precision about what is known versus inferred matters more here than usual,
because this design proposes automated deletion-shaped operations on production
data.

**Measured directly against live systems** (Plan A investigation, 2026-08-14/15;
not re-verified in this checkout):

- Archive RPC behaviour at `https://mainnet.base.org` — differing balances at
  40 / 90 / 180 / 365-day depth, the correct `"0x"` at a pre-deployment block,
  and the Multicall3 read path succeeding historically.
- The batching and rate-limit numbers — the batch cap of 10, per-sub-call
  metering, the ~5-token / ~0.55-per-second bucket, the 27:1 Multicall3 leverage,
  and the 540-reads-in-38.2s validation.
- Production database state — the wedged schedules, the DB bootstrap timestamp,
  and the 42 absent AUM days, read read-only from the production droplet.
- GeckoTerminal endpoint behaviour — UTC-midnight-aligned daily candles, the
  ~6-month server window, volume-sort versus reserve-sort pool selection, and a
  keyless 429 observed on the 6th call in ~15s.

**Read from code and verified in this worktree** at
`adhoc/20260815-173700-data-integrity-self-healing-design`: every `path:line`
citation in §3, §5, §6.1, §6.3, §7, §8, §9, and §10 was opened and checked.
Notably confirmed by absence: `ops/series-registry.ts`, `ops/gap-detector.ts`,
`/api/admin/gaps`, and the `research_signals` producer catch-up are **not in
`main`** — they live on PR #615's unmerged branch, so every claim about their
contents is inherited, not verified. Also confirmed: `WalletHoldingProvenance`
in this checkout is still the original four values, and the `*_POOL_ID` env vars
are assigned into `TrackedAsset.poolId` in `config.ts` and read **nowhere else**
in `backend/src`.

Verified for §8.1 in this checkout on 2026-08-15: the compose allowlist premise
(no `env_file:` in any of the three compose files, no `ENV` in
`backend/Dockerfile`) and its guard test at
`demo-compose-config.test.ts:520-529`; the `BUYBACK_FROM_BLOCK` `NaN` path
through `buyback-logs.ts:215`, `:216`, `:242-245` and `:253`; the five
`STRATEGY_VAULT_*_ADDRESS` keys and the empty-by-default
`resolveStrategyVaults()`; and the unconditional `{ ok: true }` for the `config`
valuation kind at `wallet-balances.ts:80`. **Not** verified here and attributed
to their issues: #641's ~20-variable count, #642's characterization of the live
production impact on `/allocation` and `/performance`, and #645's reconstruction
of v0's `totalAum[]` cross-check.

**Read from GitHub** on 2026-08-15 with `gh issue view`: the state and titles of
#639–#647 and #624, #645's NOT_PLANNED closure and its closing comment, and the
absence of any `decision:` issue for archive-capable reads. Issue state is used
here only for *what is tracked where*, never as evidence that code exists — see
the standing warning below.

**Inherited from the audit** and not independently re-derived: the D1 mechanism
and its numeric attribution, the D6 source-key classification counts (110 / 14
source-absent keys), the D7 FRED truncation finding, and the 74/74 clean-model
match. The audit's own caveat applies with full force and is repeated here
because it is easy to lose in a summary: **the dated captures are observations,
not timeless constants.** In its words, *"These are dated observations, not
stable live constants"*, and *"current values must be re-fetched and separately
timestamped rather than compared with the historical capture as if all inputs
shared a vintage."* Any acceptance test written against a specific decimal from
that review will be flaky by construction; write tests against the *structural*
claims — Saturdays-only for `ICSA`, business-days-only for `DTWEXBGS` — which
are the parts immune to revision or vintage.

**A standing warning on verification method**, from the same investigation:
issue #344 is a confirmed instance of an issue closed COMPLETED with nothing
delivered. Verify deliverables against `main`, never against issue status — a
ticked acceptance criterion is not evidence that the code exists.
