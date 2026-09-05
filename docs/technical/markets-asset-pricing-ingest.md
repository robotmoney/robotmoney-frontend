# Markets and asset pricing — ingest, audit, repair

How market data (chain balances, asset prices, and the AUM series derived from
them) is **loaded** in ordinary operation, **audited** on a standing schedule,
and **repaired** when the audit finds a hole.

This document replaces the retired `data-self-healing.md` for everything market-data
shaped. That document's macro-indicator half (Class A `raw_indicator_history`,
Class B `research_signals`) and its publication-versioning model moved to
[`regime-engine.md`](./regime-engine.md); its config-delivery rail moved to
[`../architecture.md`](../architecture.md).

**Baseline.** Written against `main` at `6f9c070`, the squash-merge of #745,
which shipped the token-addressed price path and the quarantine migrations
described below, and re-checked against `main` at `7fb823c` under #750 — which
folded in #749's unified GeckoTerminal limiter, its `*/5` repair cadence and its
per-slot `deployedAt` manifest resolution, and #751's `demo` → `smoke` rename. Following the convention of
[`20260823-review-data-integrity-aum-correctness.md`](../code-review/20260823-review-data-integrity-aum-correctness.md),
**uncommitted working-copy edits are not treated as shipped** — where a
capability exists only as a dirty-tree draft it is named in §8, never described
here as behaviour. Citations use `path::symbol` rather than `path:line` where a
line number would rot; §9 records what was verified and what was inherited.

**The `markets §X` shorthand.** Source comments across `backend/` cite this
document by section as `markets §5.2`, and `regime-engine.md` §11 does the same
as `[markets §5.2]`. Both mean a section of this file. The convention exists
because the full filename does not fit a wrapped code comment.

## Contents

1. [The contract](#1-the-contract)
2. [What is ingested, and from where](#2-what-is-ingested-and-from-where)
3. [Ordinary operation](#3-ordinary-operation)
4. [Audit](#4-audit)
5. [Repair](#5-repair)
6. [Safety properties](#6-safety-properties)
7. [The batching pattern](#7-the-batching-pattern)
8. [Known gaps and open decisions](#8-known-gaps-and-open-decisions)
9. [Provenance of the claims here](#9-provenance-of-the-claims-here)

---

## 1. The contract

Five properties, in dependency order. Each is a thing a served AUM number must
satisfy; the later ones are worthless without the earlier ones.

- **Truth** — evidence that a quote is for the *declared asset*, at the
  *declared observation time*, in the *declared currency*, from an *identified
  source and configuration*. A finite, plausible number is not truth. This is
  the property the 2026-08-23 incident violated: a WETH holding valued at
  ~$60,000 was finite, plausible, and cbBTC's price.
- **Correctness** — the quote passes identity and time semantics and the
  arithmetic is valid: positive finite price, `amount x price = value`, no
  fabricated zero, no substituted asset.
- **Consistency** — every leg in one published AUM point comes from *one*
  coherent snapshot (asset set, time, currency, source identity, state), not
  from whatever row happened to be latest per symbol.
- **Completeness** — every symbol expected for that snapshot has a valid value,
  or the snapshot explicitly records the symbol as missing. **A date with one
  row is not a complete AUM snapshot.**
- **Repairability** — a rejected or quarantined observation stays queryable as
  evidence, counts as missing, and can be retried or adjudicated without manual
  key deletion and without a terminal state that suppresses future repair.

**Completeness is subordinate to truth.** A complete series of wrong numbers is
worse than a gappy series of right ones, because a gap is visible and a wrong
number is not. Any tradeoff between the two resolves toward the gap.

### 1.1 Two time bases, never mixed

| Basis | Amount | Price | Key |
|---|---|---|---|
| **live** | latest chain read | current spot | wall-clock `sampled_at` |
| **utc-daily-close** | read at that UTC day's resolved closing block | that day's UTC daily candle close | the UTC calendar day |

A repair must not mix today's spot, a different UTC day, and a different block
into one point. The two bases share a table but are not interchangeable rows: a
`live` row is as honest as it claims and merely current; a `utc-daily-close` row
is a settled historical fact and must be reproducible from its block.

GeckoTerminal daily candles are **exactly UTC-midnight aligned**, which is the
same day key the live sampler writes as `sampleDate`
(`backend/src/worker/handlers/wallet.ts`). No boundary reconciliation is needed
between the two, and none is performed.

---

## 2. What is ingested, and from where

Two axes, metered separately, with completely different failure modes. Conflating
them is a recurring source of confusion, so state it plainly: **amounts are chain
reads; prices are not.**

| Leg | Source | Transport | Metered by |
|---|---|---|---|
| ERC-20 balances, native ETH | Base RPC (`BASE_RPC_URL`, default `mainnet.base.org`) | `chain/base-rpc-client.ts`, Multicall3 `aggregate3` | shared per-IP token bucket |
| Strategy NAV (`convertToAssets`) | Base RPC | same | same |
| Crypto spot price | GeckoTerminal `token_price` (keyless) | `chain/token-prices.ts` | GeckoTerminal serializer |
| Crypto daily close | GeckoTerminal `/pools/{pool}/ohlcv/day` (keyless) | `chain/historical-prices.ts` | GeckoTerminal serializer |
| USDC, both strategy sleeves | pinned $1, no fetch | — | — |
| SP500 | config-valued size x Yahoo `^GSPC` | `chain/token-prices.ts` | Yahoo |

There is **no on-chain oracle and no pool spot read over RPC**. Every price in
this system is an off-chain vendor HTTP response.

**Vendor constraint, inherited and non-negotiable.** `chain/token-prices.ts`'s
header permits only the GeckoTerminal and Yahoo hosts. CoinGecko is reachable
and banned. New GeckoTerminal *endpoint* code is explicitly permitted — the
daily-OHLCV reader is in bounds on that basis — but `runGeckoBatch` must not be
reused for it: that runner is address-keyed with no time dimension and targets a
spot-only endpoint. Copy the pattern, not the code.

**USDC and both sleeves are pinned $1 and cost no request.** ZYFAI-SS1 and
GIZA-SS1 are **not** share tokens: `backend/src/config.ts` documents them as the
agent's delegated smart-account wallets on Base, valued at NAV in underlying
USDC (`valuationKind: "strategy"`, `priceKind: "usdc"`).

---

## 3. Ordinary operation

### 3.1 The live sampler

Valuation happens **on the worker schedule, never on the request path**. The
per-minute `wallet.sample_balances` job drives `sampleWalletBalances()`; the
sleeve sampler follows the same shape in the same handler. `GET
/api/dashboards/wallet-balances` is served purely from the last persisted
per-symbol samples — zero RPC on the request path, so a client request can never
reach the rate-limited public node.

All on-chain amounts of a sample are fetched in at most **two `aggregate3`
batches**: one `balanceOf`/`getEthBalance` sub-call per asset x wallet, then one
`convertToAssets()` round for strategy NAVs. Round 2 depends on round 1's
output, which is why a partially-failed sample must never be written (§6.2).

### 3.2 The quote path

This is the section the 2026-08-23 incident rewrote, and the policy is now:

**Every price request names its token.** Both pool-addressed OHLCV builders send
`&token=<address>&currency=usd` — `chain/historical-prices.ts::fetchDailyCloses`
for the backfill, and `chain/token-prices.ts::fetchGeckoDailyCloseUsd` for
buyback `value_usd`. Absent `token=`, the endpoint answers for the pool's **base**
side, which for a token sitting on the quote side is a different asset entirely.
`currency=usd` likewise states the denomination rather than leaving it to the
pool.

**Orientation is asserted in-band, and what cannot be proven is refused.**
`chain/historical-prices.ts::assertPoolOrientation` compares `meta.base.address`
against the requested token and raises `PoolOrientationError` on mismatch **or on
absent `meta`**. `token=` fixes *what* is priced; the assertion catches the price
silently changing *which asset it describes*. A refused day becomes a disclosed
gap, never a substituted price.

**The pool is pinned per asset, not ranked per run.** `PINNED_GECKO_POOLS` /
`pinnedPoolForToken` in `backend/src/config.ts` pins WETH (and therefore native
ETH, which shares WETH's pricing address) to the WETH/USDC pool.
`resolvePoolForToken`'s 24h-volume ranking survives as a **logged fallback for
unpinned tokens only**.

> **This reverses the retired `data-self-healing.md` §6.5.2 and §11**, which stated *"Pool
> addresses are derived, never configured"* and prescribed the volume ranking as
> the mechanism. That ranking is precisely what produced the incident: for WETH
> on Base it is a ~9% near-tie between `WETH / USDC 0.3%` (WETH base, correct)
> and `cbBTC / WETH 0.05%` (WETH quote, cbBTC's price), so which asset the series
> described was decided by a measurement that moves day to day. **A pin buys
> determinism; the `token=` parameter buys correctness.** Pinning alone would not
> have been sufficient, and the ranking alone was not safe.

**Sort by volume, not reserve** — for the fallback that remains. A
`max(reserve_in_usd)` selector picks a decoy for WETH: an observed `Bnb / WETH`
pool reports ~$7.68B reserve against `volume.h1 = 0.0` and wins a reserve sort
outright.

**Resolve once, then cache for the process.** The pinned pools seed that cache
at first use (`chain/historical-prices.ts::seedPoolCache`), so a pinned token
pays no resolution request even on a cold start. Re-discovering a pool per run
is what burns the keyless quota.

**A zero or negative close is refused, not stored.** `Number(null)` is `0` and
`0` is finite, so the check must precede coercion. No token this table prices is
worth nothing, so a zero close is a defect in the candle; believing it writes
`value_usd = 0` for every holding of that asset — a one-day crash to zero that
recovers the next day, recorded as a settled day no repair pass will revisit.

**SP500 is deliberately absent from the historical path.**
`loadHistoricalPrices` throws rather than resolve a non-Gecko asset. It is not a
chain read at all (`valuationKind: 'config'`), and #648 records that the column
splices two different measurements. The product decision — historical Yahoo
close, explicit unavailable leg, or a separate config-time series — is open
(§8).

> **D41 changes where this output lands, not how it is fetched.** Everything in
> this subsection — naming the token, asserting orientation, pinning the pool,
> refusing a zero close — is unchanged by the split. What changes is that the
> resulting price is written to its own series rather than onto a holding's row.
> See §5.6.

### 3.3 Provenance, and what each value promises

| Value | Meaning |
|---|---|
| `live` | real chain read + real price read |
| `stub` | hermetic `BASE_RPC_SOURCE`/`PRICE_SOURCE=stub` fixture |
| `stale` | a degraded leg reusing an older persisted value |
| `seed` | pre-launch history ported from v0's production crons — **genuine observed data, not a defect** |
| `backfilled` | a real chain read at a resolved historical block; as honest as `live`, only late |

`backfilled-quarantined` is a **storage-only** value, deliberately outside the
`Provenance` union in `chain/wallet-valuation.ts` so that the compiler refuses
to let it reach a DTO. Every read of `wallet_balance_samples` /
`wallet_sleeve_samples` excludes it.

**A value is never fabricated and never silently frozen.** Failure isolation is
layered: a reverted sub-call inside a successful batch, or a failed price fetch,
degrades only *that* holding; a whole-batch RPC failure degrades all chain-read
legs of that sample together.

**Any new provenance value must land in the DTO union and the renderer in the
same change as the writer.** `provenance` has no CHECK constraint on any table —
migration 0014 documents the vocabulary in a comment only — so a new value needs
no migration, which is exactly the trap. The frontend switches on the value by
equality, and **an unrecognised value renders unbadged and fully live**: the most
misleading direction a failure can fail in.

### 3.4 Budgets

Two independent limiters. They must never be confused, and neither may be
duplicated.

**Base RPC** — one shared token bucket in `chain/base-rpc-client.ts`, default
`DEFAULT_RATE_PER_SEC = 0.25` and `DEFAULT_RATE_BURST = 5`
(`BASE_RPC_MAX_CALLS_PER_SEC`, `BASE_RPC_RATE_BURST`). The default is
conservative: half the measured ~0.55/s refill. Setting the rate `<= 0` is the
explicit opt-out and makes `ops.repair_gaps` refuse to dispatch rather than run
unpaced.

- The limit is **per-IP at the provider**, so in-process isolation cannot create
  budget. **Never give the backfill its own limiter** — two limiters against one
  per-IP bucket sum to 2x and guarantee 429s.
- What exists in addition bounds *concurrency*, not rate
  (`BASE_RPC_MAX_CONCURRENCY`, default 4) — which is why production saw the
  2026-08-10 HTTP 429 storm.
- Structural batch cap of **10** calls per POST; an oversized batch is refused
  with HTTP **200** and an error object, not a per-item error array.

**GeckoTerminal** — one process-wide serializer in `chain/gecko-rate-limit.ts`,
shared by the spot path (`chain/token-prices.ts`) and the daily-OHLCV path
(`chain/historical-prices.ts`) because both reach the same host from the same IP
against the same keyless quota. `DEFAULT_MIN_INTERVAL_MS = 6_000` — at most 10
requests a minute, which is the keyless per-IP quota — read from
`GECKO_MIN_INTERVAL_MS`, falling back to the historical path's older
`GECKO_OHLCV_MIN_INTERVAL_MS`. A keyless 429 was observed on the **sixth call in
~15s**. One OHLCV request serves up to ~181 daily candles, so prices are an
O(1)-per-pool-per-window cost and are *not* the rate-limit concern a repair run
has to engineer around; the RPC bucket is.

> **The same rule applies here as to the RPC bucket: one limiter per metered
> per-IP quota, never one per module.** Until #749 there were two — the spot path
> had mutual exclusion and no spacing, the historical path had 3 000 ms — and
> concurrent sampler and backfill load could exceed 10/min between them without
> either limiter observing a violation.

**A served price may be stale, but only briefly.**
`persistedFallbackWalletPriceReader` falls back to a persisted per-symbol price
when the live read fails, bounded by `MAX_PERSISTED_PRICE_AGE_MS` (5 minutes,
~5x the 1-minute sampler cadence). The chain *amount* is always the caller's
fresh read; only the price falls back, and it is relabelled `stale` with the
sample's real `sampledAt` — never `live`. Quarantined rows are excluded from
that fallback by predicate, not by luck of the age bound.

---

## 4. Audit

### 4.1 One work list

**There is exactly one notion of "which days are missing".** The gap detector is
it. The operator surface (`GET /api/admin/gaps`) and the repair planner read the
same function over the same registry. Two notions drift, and then the dashboard
starts disagreeing with the thing that is supposed to be fixing it.

### 4.2 What "covered" means

`ops/series-registry.ts` declares each series' table, date column, cadence,
series start, and `remediationClass`. Market-data series additionally declare:

- **`uncounted`** — rows that exist but do not count as coverage. A row the
  serving layer may not serve covers nothing, so quarantined rows are filtered
  out of the detector exactly as they are filtered out of the API. Without this,
  the detector reads presence off the table while the API reads it off a filtered
  view of the same table.
- **`expectedKeys`** — the natural keys that must **all** exist before a slot
  counts as covered. Wallet balances and sleeves use this stronger contract
  because a partial AUM point is a plausible but wrong total. Extra keys are
  tolerated; a missing expected key makes the whole slot a gap.

`ops/gap-detector.ts::detectGaps` reports **interior gaps** (holes the series
jumped over) and a **stale head** separately, per series. The expected/observed
diff is computed in JS from explicit UTC methods rather than a SQL
`generate_series`, so the answer does not depend on the Postgres session's
`TimeZone`.

> **The manifest is resolved per slot, from active configuration.** Since #749
> the detector calls `expectedKeys.resolve(slotDate)` for each slot, and
> `ops/wallet-snapshot-manifest.ts::resolveWalletSnapshotManifest` filters to
> assets whose `TrackedAsset.deployedAt` falls on or before that day — so a day
> that predates an asset's addition is complete without it. SP500, added
> 2026-05-01, is the live case: the March and April days are complete at seven
> symbols rather than permanently short one.
>
> What still does not exist is a **versioned** manifest — one that records what
> was expected on that day rather than deriving it from today's configuration.
> An asset removed, re-pointed to a new address, or re-dated leaves no trace, and
> the derived answer changes underneath every historical day at once. See §8.1.

> **D41 removes this question for prices and leaves it for amounts.** A dense
> price series is complete or not on its own terms — expected days minus
> persisted days, per symbol — so it needs no manifest at all. Amounts still
> do, because a sample missing a leg still understates a sum. See §5.6.

### 4.3 Quarantine

**Quarantine, never hard-delete.** The wrong values are the evidence: the
incident's reconstruction depends on them, adjudication needs them, and a number
nobody can look at afterwards cannot be checked.

Migration `0036_quarantine_backfilled_samples.sql` moved every
`provenance='backfilled'` row in both sample tables to
`backfilled-quarantined`, and deleted `wallet_backfill_state` rows with
`status='exhausted'` so the planner re-plans days the old writer gave up on.

**Scope is all backfilled rows, not just WETH/ETH.** Wrongness arrived in
run-sized blocks — the pool was resolved once per process and one request
prefetched ~180 days — and the blocks cannot be reconstructed afterwards,
because the backfill stamps `sampled_at` as the sample day's 23:59 rather than
the write time. Neither a date cutoff nor a run cutoff separates good rows from
bad, so every backfilled row is presumed guilty and adjudicated individually.

Migration `0037_aum_repairable_quarantine.sql` then moves the affected rows into
typed **evidence tables** (`wallet_balance_sample_evidence`,
`wallet_sleeve_sample_evidence`), preserving every original field and the
original row id, so the active natural keys are free for a verified replacement.
Evidence rows are immutable: statement triggers refuse `UPDATE`/`DELETE`/
`TRUNCATE` and row triggers cover replication paths.

**A quarantine makes the whole date unpublishable.** Both migration 0037 and the
serving layer drop the entire date, not just the quarantined rows: each point's
`totalUsd` is a sum across that day's symbols, so excluding the bad rows alone
would serve an understated total that looks like a real number and is disclosed
as nothing. That is precisely the substitution quarantine exists to stop.

---

## 5. Repair

### 5.1 The dispatcher

`ops.repair_gaps` is an ordinary seeded cron row (`*/5 * * * *`,
`backend/src/db/seed.ts`) claimed by the analytics lane like any other producer.
It re-derives the work list from the **data** on every run, so a gap that appears
for any reason — a wedged scheduler, an RPC outage, a fresh database whose
bootstrap postdates the series start — is found and closed by the running
system. **Nothing about repair lives in a migration or a one-shot script.**

It enqueues **one window job, not N day jobs**
(`wallet.backfill_window`), because the provider meters HTTP POSTs and both of a
day's costs are shareable. No `dedupe_key`: that index is unique across the whole
jobs table including terminal rows, so a dedupe key would make a day that once
failed permanently un-retryable.

**Convergence, not a burst.** One run enqueues at most
`WALLET_BACKFILL_MAX_DAYS_PER_RUN` days (`DEFAULT_MAX_DAYS_PER_RUN = 10`). A wide
gap closes over successive runs, and what a run deferred is reported in its
output rather than silently dropped. Against the `*/5` cron that is a nominal
ceiling of 10 days per five minutes, but the dispatcher enqueues nothing while a
`wallet.backfill_window` job is still `pending` or `running`, so the real rate is
**10 days per completed window**: a slow window throttles the next dispatch
instead of stacking work behind it. See §8.

Classes the dispatcher does not execute are **named, not omitted**, so an
undispatched class is as visible as an unrepaired day.

### 5.2 The window executor

`ops/wallet-backfill.ts::backfillWalletWindow` is the only executor;
`backfillWalletDay` is its N=1 case, not a second implementation. Two executors
are two sets of invariants to keep honest, and the day-atomic write path is the
last place to accept that.

Order of operations for a window:

1. **Skip days that have not closed** — the current day belongs to the live
   sampler.
2. **Resolve every day's block in lockstep.** Per-day binary search is serial
   *within* a day and independent *across* days, so `chain/block-resolver.ts::resolveDayBlocks`
   advances all days one probe at a time and ships each round as one POST.
   Sequential depth stays ~3-8 rounds whether one day is resolving or fifty. A
   past UTC midnight's block is immutable, so the `chain_day_blocks` cache is
   permanent and a second run over the same window costs zero resolver calls.
3. **Load prices for the whole window in one range load.** `loadHistoricalPrices`
   has taken a date range all along; the most visible failure of 2026-08-22 was a
   price-feed 429 caused purely by a per-day fan-out against a range-capable API.
4. **Read every day's legs at its own block**, `strictEmptyReturn: true` (§6.1).
5. **Commit each day in its own transaction**, under a per-date advisory lock,
   after validating completeness.

### 5.3 Failure accounting

Four outcomes, and the distinction between them is load-bearing.

| Outcome | When | Attempt charged? | Re-planned? |
|---|---|---|---|
| `failDay` | attributable to **that day** — its block unreadable, its legs unreadable, its own assets unpriced | yes; `exhausted` at `WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY` (default 3) | until exhausted |
| `deferDay` | a **shared leg** failed and took the window with it — the price load, the whole-window chain read, a pool-level refusal, block resolution's head probe | **no** | always, unless it crosses the leg breaker below |
| `blocked` | the same shared leg refused **`WALLET_BACKFILL_LEG_TERMINAL_THRESHOLD` (default 3) consecutive, separate** times | **no** | after `WALLET_BACKFILL_LEG_RETRY_COOLDOWN_MINUTES` (default 60) |
| `skipDay` | the day is not this executor's to write | no | n/a |

The `deferDay` distinction exists because once the window became the unit, three
shared legs began failing every day at once. Charging each of them to every day
turned a single transient into a ten-day-wide charge, and the queue's own
degraded retry lands three of those inside about ten seconds — so roughly ten
seconds of provider trouble retired ten days permanently, recoverable only by
hand-written SQL.

A **pool-level refusal** is a shared leg by construction: the pool is the same
for every day in the window, and the module's contract is that retrying returns
the same refusal. Charging it per day means a mistyped pin retires the whole
window permanently and fixing the pin no longer repairs it.

**An `exhausted` day is still a gap.** What has stopped is the spending, not the
disclosure; it remains reported by `GET /api/admin/gaps`.

**Issue #761 — the shared-leg circuit breaker.** `deferDay` never advancing the
attempt counter is correct for a *transient* shared leg and was wrong for a
*permanent* one: with no counter at all, a mistyped pin or a delisted pool
refused identically on every retry, and the planner takes the oldest missing
days first, so the same days were re-selected on every scheduled run forever —
at #749's five-minute cadence, twelve wasted runs an hour rather than one, and
every other missing day starved behind them. `wallet_backfill_state` now
carries `defer_leg` (a stable identity for which shared leg failed — not the
raw error text, so a 429 one run and a timeout the next still count as the same
leg misbehaving), `defer_streak` (consecutive, *separate* refusals of that
leg), and `defer_leg_at`. Two defers of the same leg landing within
`WALLET_BACKFILL_LEG_DEBOUNCE_MS` (default 60s — well above the queue's own
retry burst, well below the dispatcher's cadence) count as ONE incident, so the
existing transient protection is unchanged. Crossing the threshold moves the
day to `blocked`: still a disclosed gap (`GET /api/admin/gaps` derives from the
sample tables, never from this ledger), excluded from `selectBackfillDays()`
like `exhausted`, but — unlike `exhausted` — retried automatically once its
cooldown elapses, and any day-specific outcome (a fill, a skip, or a `failDay`
attributable to that day alone) clears the streak outright. That is what makes
a corrected pin repair its days again with no hand-written SQL. The dispatcher
(`repair.ts::repairGaps`) names every currently-blocked day and its leg on
every run, not just the run that tripped it.

> **D41 retires the price-side third of this table.** A pool-level refusal stops
> being a shared leg of the *holdings* window once prices are their own series;
> what remains is block resolution and the multicall pass, which are genuinely
> shared across a window and still need `deferDay` (and the breaker above). See
> §5.6.

### 5.4 Evidence-preserving replacement

Inside the per-day transaction:

- Take the advisory lock for the date (`lockWalletSnapshotDate`). Row locks
  cannot protect a natural key that does not exist yet: without this, a live
  INSERT could commit after repair copied the old rows but before its DELETE, and
  that row would be deleted without ever reaching evidence.
- Inspect the date against the manifest, locking the rows that may be archived.
- If the day is **already complete**, write the checkpoint and stop. The executor
  never rewrites a complete day.
- Otherwise **copy every original row to evidence** — quarantined rows get the
  more specific `quarantined-replacement` reason, the rest
  `incomplete-snapshot-replacement` — then rebuild the date and re-validate
  completeness before the checkpoint is written.
- `filled` is written **only after** both key sets passed validation, and it
  commits with the evidence and replacement rows.

Any failure rolls the whole day back and defers it.

### 5.5 Snapshot identity

Migration `0038_wallet_aum_snapshot_foundation.sql` adds
`wallet_aum_snapshot_runs`: an immutable, append-only header per publication
attempt, carrying a manifest hash, a config identity, expected/present/missing
key sets, block proof (closing block **and** the first block on or after the next
UTC midnight), source and price evidence, and an explicit producer revision.
Sample rows carry `snapshot_run_id` plus observation timestamps; a `complete` or
`degraded` header can only be inserted once its constituent rows are staged, and
once inserted no row may join, leave, or mutate the run.

`resolveAumProducerRevision` deliberately has **no** package-version, wall-clock,
branch, or `"unknown"` fallback: those look like identity while being unable to
reproduce a producer. Absent an explicit revision, a run is recorded as
`unavailable` with a reason rather than published.

**Status: foundation only.** No publisher writes `wallet_aum_snapshot_runs`
yet — legacy rows keep NULL snapshot identity, and the constraint shape is
enforced but unexercised. This is P1 scaffolding landed early, not a live
mechanism.

### 5.6 Target shape — the price series is separate from the holdings series

**Decided in [D41](../decisions.md), filed as #762, not yet built.** Nothing
described in this subsection exists in the tree; §5.1–§5.5 above remain the
behaviour. It is
recorded here because the sections above describe machinery whose *reason for
existing* this supersedes, and a reader needs to know which parts are load-
bearing and which are consequences of a shape that is going away.

`wallet_balance_samples` fuses two different kinds of fact on two different
clocks: `amount` is chain state at one block, and `price_usd` is a sample of a
vendor time series that exists whether or not the fund held anything. Three
consequences follow, and #742 hit all three — a missing price discards chain
reads that succeeded; "is this day complete" depends on what the fund held; and
prices cannot be reconciled against the vendor because they are welded to
holdings.

The split gives prices their own dense per-day table, `asset_prices`, keyed
`(price_date, symbol)` and carrying the full quote record §8.1 asks for. Then:

- **Gap detection for prices** is expected days minus distinct persisted days,
  per symbol. No manifest, no per-slot expected-key sets.
- **Repair for prices** is one OHLCV range call per pool/token key. There are
  three — WETH and native ETH share a pricing address, then ROBOTMONEY and
  BNKR — so a full year costs roughly ten requests. The three `usdc`-priced
  assets are written as real rows with `source = 'pinned'` so the join has no
  special cases, and SP500 stays out (§3.2).
- **`value_usd` for a closed day** becomes a read-time join. A thin price day is
  then a disclosed gap in one series rather than a poisoned snapshot in another.

Four properties have to hold for that to be safe, and each is easy to lose:

1. **The two time bases must not be joined.** The live sampler writes a spot
   price at a wall-clock instant; `asset_prices` holds UTC daily closes. Closed
   days join to the table; **today's point keeps its fused live row**, where
   amount and price were genuinely read at the same instant (§1.1). Do not
   `COALESCE` the two — that is the substitution this document exists to refuse.
2. **"Dense" is bounded by a per-symbol first-priceable day.** ROBOTMONEY and
   BNKR have inception dates and their pools carry no candles before them.
   Without a floor, the split manufactures permanent unfillable gaps — the same
   noisy-report problem `expectedKeys` created on the sleeve series (§8.1).
   `fetchDailyCloses` already folds `oldestSec` and `floorProven` across pages,
   so the first range call for a pool reports that floor; persist it.
3. **The join is the candidate; 0038 is the freeze point.** A read-time join
   restates every historical total whenever `asset_prices` changes, which is
   what repair needs and what frozen publication forbids. `wallet_aum_snapshot_runs`
   already hashes price evidence alongside its constituent rows, so a published
   snapshot stays reproducible from its own evidence after the price series is
   repaired underneath it (§5.5).
4. **Seed the table from `live` and `seed` rows only.** Quarantined rows are
   exactly the ones whose price describes a different asset (§4.3); backfilling
   from them would re-admit the defect the quarantine contains.

**What the split does not remove.** Amounts still need expected-key sets, and
`deployedAt` stays — it is what makes a per-slot expected-key set answerable at
all (§4.2), and it was always an amounts concern, never a price one. `deferDay` survives on the amounts side too, because block
resolution and the multicall pass are still shared legs across a window (§5.3).
The win is narrower than "the manifest goes away" and more valuable than it
sounds: **one failure source per series.** A vendor problem can no longer void a
chain read, and a chain problem can no longer void a price.

`wallet_sleeve_samples` carries the identical fusion and is covered by the same
table — a second join, not a second design.

**Shape.** Sketch, not a migration — the columns that carry the four properties
above are the point, and the cheap version of this table gets two of them wrong:

```sql
CREATE TABLE asset_prices (
  price_date      date        NOT NULL,
  symbol          text        NOT NULL,
  -- Present so a second basis cannot be added invisibly. The table holds
  -- settled closes; a live spot belongs on the live sample row, not here.
  time_basis      text        NOT NULL CHECK (time_basis IN ('utc-daily-close')),
  price_usd       numeric     NOT NULL CHECK (price_usd > 0),   -- §3.2 refuses 0
  currency        text        NOT NULL CHECK (currency = 'USD'),
  -- The PROVIDER, not the provenance. 'live'/'stale'/'seed' describe how a
  -- HOLDING was read and have no meaning for a settled close.
  provider        text        NOT NULL,   -- 'geckoterminal' | 'pinned'
  pool_key        text,                   -- which pool answered; NULL when pinned
  token_address   text,                   -- what `token=` named; NULL when pinned
  observed_at     timestamptz NOT NULL,   -- the candle's own UTC close
  fetched_at      timestamptz NOT NULL,   -- when we asked
  response_hash   text,                   -- replayable source identity
  config_identity text        NOT NULL,   -- which pin/config produced it
  PRIMARY KEY (price_date, symbol, time_basis)
);
```

An index on `(symbol, price_date)` serves the per-symbol gap query and the
history join. Volume is not a concern at this scale — seven symbols over a
series measured in months — but the join replaces a single-table read on the
history path, so the read-path change wants a plan check rather than an
assumption.

**Cutover** is five phases — create and seed, dual-write and verify, switch the
read path, stop writing the old column, then simplify the price-side driver —
with the seed taking `live`/`seed` rows only and an explicit conflict rule.
[D41](../decisions.md) carries the sequence, the two traps it must avoid, and
why "clear the gap first, refactor after" is a judgement call rather than a
dependency.

---

## 6. Safety properties

### 6.1 The silent-zero rail

The recurring shape is **a wrong computation that reports success**.

`decodeUint256("0x")` returns `0n`, and Multicall3 returns `success: true` with
`returnData: "0x"` for an address with no code — so there is no revert to catch.
On the live path this is harmless: the contracts are all deployed. On a
**block-addressed historical** read it is not: a contract deployed *after* the
target date decodes to a clean, fabricated `0`, which becomes a plausible AUM
row.

The rule, and it is not optional:

- Block-addressed reads must distinguish empty return from genuine zero
  (`base-rpc-client.ts::isEmptyReturnData`, surfaced as the `strictEmptyReturn`
  read option).
- `success === true && returnData === "0x"` is a **hard failure for that day**,
  never a zero.
- A per-address **earliest-valid-block floor** must skip days preceding a
  target's deployment rather than failing them repeatedly (issue #760).
  `chain/address-floor-resolver.ts` binary-searches `eth_getCode` to find the
  exact block at which an address first has on-chain code — a CHAIN fact,
  cached forever in `chain_address_floors` (migration 0045) — and
  `ops/wallet-backfill.ts::backfillWalletWindow` consults it, per tracked
  address, before either the shared price load or the shared chain read is
  issued for a day. A day below the floor is written `skipped`, never
  `failed`, so no attempt is charged; `GET /api/admin/gaps` is unaffected — it
  derives from the sample tables via `expectedKeys`/`deployedAt`, never from
  `wallet_backfill_state`, so a genuinely uncovered day still shows as a gap.

  This is distinct from `TrackedAsset.deployedAt` (§4.2, config.ts) — a
  CONFIGURATION fact, the calendar day an asset was first tracked — and from
  D41's per-symbol first-priceable day (§5.6) — a fact about when a pool
  started trading. Three different facts about three different series: one is
  "the contract did not exist yet", one is "we were not tracking it yet", and
  one is "the pool had not traded yet". None substitutes for another.
- **Live-path semantics must not change.** `strictEmptyReturn` is off by default.

### 6.2 Day-atomicity and per-day checkpointing

**A day is atomic.** A day whose round-1 read partially failed must never be
written, because round 2 (`convertToAssets` NAV per vault) depends on round 1's
output and a half-read day produces a plausible, wrong total.

**Progress is checkpointed per day**, so an interruption loses at most one day.
This is a cost optimisation rather than a correctness requirement — the write is
idempotent — but it is what makes a wide gap survivable.

### 6.3 A batching unit is not a blast radius

Batching changes *how work is fetched*. It must not change how work is committed
or how failure is scoped:

- each day is written in its own transaction with its own checkpoint;
- each day fails alone;
- a day is day-atomic;
- shared work fails **exactly as widely as it was shared** — one price load
  covers N days, so its failure fails those N days and writes none of them.

Per-entry results make this expressible rather than aspirational:
`rpcBatchRequest` returns `{ok}` per call and `aggregate3` returns `{success}`
per sub-call, so "one bad item" never has to mean "throw the batch". **A driver
that catches at the batch level has thrown that away.**

### 6.4 The blast-radius guard

Generalised from `assessEdgarBatchDivergence`, and it belongs **in front of the
executors, not inside a detector** — put it in a detector and each detector gets
its own half-guard. Three checks:

1. **Degeneracy** — an all-zero or near-all-zero batch is refused: answered
   well-formed but empty.
2. **Rewrite ratio** — a batch that would rewrite more than a declared fraction
   of the keys it compared is a bulk rewrite, not a revision.
3. **Aggregate drift** — refuse when `|sum(fresh) - sum(prior)| / sum(prior)` exceeds its
   bound.

Two properties must not be lost: the ratio checks apply only to
reconciliation-sized batches, so a small legitimate correction is not blocked by
a percentage rule meaningless at n=2; and a batch is refused **whole and
alarmed**, never partially applied, so a guard trip cannot leave a half-repaired
floor that the next run reads as the new baseline.

> **Continuity bands are anomaly signals, never proof of truth**, and must not
> become hard database triggers: an ordinary large market move is real. Record it
> as an anomaly; do not reject it.

### 6.5 The append-only boundary

`wallet_balance_samples` and `wallet_sleeve_samples` are deliberately **not** in
migration 0032's protected list (`db/append-only-guard.ts::APPEND_ONLY_TABLES`),
so `UPDATE` and `DELETE` against them are physically possible. The restraint is
the point, not the permission — and it means the static repo guard
(`backend/tests/append-only-no-new-deletes.test.ts`) does **not** cover the tables AUM is
served from. Any new destructive path against them is reviewed by humans or not
at all (§8).

The evidence tables and `wallet_aum_snapshot_runs` carry their own immutability
triggers, enabled `ALWAYS` so they survive replication.

---

## 7. The batching pattern

For whoever repairs the next series. The reasoning matters more than the code.

**Batch on the axis the provider meters, and nothing else.** The unit of cost is
the HTTP POST, so the question is "what work can share a POST?" — never "how do I
make this concurrent?"

| Mechanism | Merges | Cannot merge |
|---|---|---|
| Multicall3 `aggregate3` | many contract reads **at one block** | anything at another block; any node method |
| JSON-RPC array batching | up to **10** calls of any kind, any block | — (capped at 10) |

They compose and a repair driver needs both: `aggregate3` collapses one day's
reads into one sub-call, and array batching puts ten *days* of those into one
POST. Block resolution can only ever use the second.

**Find the sequential depth, then run the independent axis in lockstep.** The
question to ask of any serial-looking loop is which of its dimensions is actually
independent.

**Share the off-chain fan-out too.** Before optimising the metered path, check
whether a per-item loop is calling a range-capable API one item at a time.

**Measure the provider before designing against it — and validate the bodies.**
An oversized batch is refused with HTTP 200 and an error object, so a benchmark
that checks only the status measures the speed of being rejected. Use unique keys
so a cache cannot flatter one arm, interleave the arms so ordering cannot, and
count *delivered results* rather than absent errors. Benchmarks are committed at
`backend/scripts/bench-rpc-batching.ts`, `bench-rpc-cache-control.ts` and
`bench-rpc-cap-shape.ts` so the numbers can be re-run rather than believed.

---

## 8. Known gaps and open decisions

Stated up front so this document is not read as a promise it cannot keep.

### 8.1 Specified but not implemented

Each item below is either a filed issue or an explicit decline. Nothing here is
left as prose with no owner.

- **A versioned point-in-time expected-key manifest (§4.2) — declined, and here
  is the reason.** Since #749 the detector resolves `expectedKeys` per slot and
  filters by `TrackedAsset.deployedAt`, so the operational symptom this item was
  filed against — historical days permanently short an asset added later — is
  gone, and #709's retry loop with it. What is left is the *versioned* form: a
  record of what was expected on that day rather than a derivation from today's
  configuration, which would additionally survive an asset being removed,
  re-pointed to a new address, or re-dated.

  It is declined for now on three grounds. The repository has no instance of the
  configuration change it would protect against, so the design would be written
  against a hypothesis. D41 removes the question entirely for prices — a dense
  price series is complete on its own terms — leaving a smaller amounts-only
  problem whose shape depends on how #762 lands. And migration 0038's
  `wallet_aum_snapshot_runs` already persists an expected/present/missing key set
  and a manifest hash *per publication*, which is the same fact recorded at the
  moment it is true; a versioned manifest built before that header has a live
  publisher (§5.5) would be a second answer to a question 0038 is already
  positioned to answer. **Revisit when a tracked asset is first removed or
  re-pointed, or when 0038 gains a publisher — whichever comes first.**

  One consequence stays live and is not a manifest problem: nothing seeds
  `wallet_sleeve_samples` — only the live sampler and the backfill write it — so
  every day from the registry's `seriesStart` to the database's bootstrap is an
  interior gap on that series until repair reaches it, and the operator gap
  report stays noisy while it does.
- **One shared quote record (P2) — decided in D41, filed as #762.** Asset
  identity, observation time / UTC day, currency, value, source, pool or ticker,
  response identity, and config identity in one record used by both the live and
  historical callers. Today the live and historical paths implement the same
  policy twice, in two files, and neither persists a replayable source identity.
  **Vetted pool policy must be explicit per asset; the WETH pin is repeatability,
  not identity proof.** [D41](../decisions.md) settles the shape: this record is
  the `asset_prices` table of §5.6. It does not settle the *policy* — which pool
  is the economically intended market for each asset remains an open decision
  (§8.2), and persisting the pool that answered is evidence of what happened,
  not proof that it was the right venue.
- **A destructive-path guard for the sample tables (§6.5) — declined, with the
  reason.** `wallet_balance_samples` and `wallet_sleeve_samples` are outside
  `APPEND_ONLY_TABLES`, so neither migration 0032's runtime trigger nor the
  static repo guard (`backend/tests/append-only-no-new-deletes.test.ts`, which
  imports that same list) covers the two tables AUM is served from. That is not
  an oversight: §5.4's repair path **must** delete from them — it copies a day's
  rows to evidence and rebuilds the date — so a blanket refusal would break the
  mechanism this document is about. Immutability is enforced one layer over, on
  the evidence tables and `wallet_aum_snapshot_runs`, which is where the record
  that must survive actually lives.

  What is left is narrower than "these tables are unguarded": a *new* destructive
  path against them is reviewed by humans or not at all. Filing that as an issue
  would be filing "write a guard that permits the one caller allowed to delete",
  which is a review-time judgement wearing a test's clothes. Revisit if a second
  legitimate deleter ever appears — two callers is the point at which the
  permitted set is worth writing down.

### 8.2 Open product decisions

- **SP500 in the historical path** — skip, explicit unavailable leg, historical
  Yahoo close, or a separate config-time series. The frontend currently
  interprets an absent asset inside an *existing* point as zero, so "omit" is not
  a neutral default.
- **Vetted pool policy, per asset.** WETH is pinned to its USDC pool, which buys
  determinism and availability. It does not establish that the pinned pool is the
  *economically intended market* for the asset, and no decision records why that
  venue rather than another. ROBOTMONEY and BNKR are not pinned at all and still
  fall back to the 24h-volume ranking — safe only because the orientation
  assertion turns a bad pool into a refusal rather than a wrong price (§3.2).
  Persisting the pool that answered (§5.6) is evidence of what happened, never
  proof that it was the right venue.
- **Re-admission of quarantined rows (P5).** Every quarantined row must be
  adjudicated individually against the new quote rules; none has been. Re-admit
  only on evidence, and record the decision and source identity per row.
- **A keyed RPC provider.** Class C gets an executor; it does **not** get a
  standing reconciliation loop until there is a keyed provider. A chain read at a
  pinned immutable block is in principle the most deterministically verifiable
  data in the system — two readers at the same block must agree, forever. The
  rate limit is the only thing standing between that property and a continuous
  verifier.
- **Rate limits re-measured from the production droplet.** The ~5-token /
  ~0.55-per-second figures were measured from a different IP; shared NAT could
  make production strictly worse.

### 8.3 In flight, not shipped

As of the original baseline, drafts existed — unmerged — of a per-quote evidence
envelope, a Yahoo `^GSPC` historical leg, and a historical snapshot publisher.
None had landed on `main` at `7fb823c`, and the drafts themselves were not
re-opened under #750, so their state is inherited rather than re-checked.
**None is described as behaviour anywhere above.** The Yahoo leg in particular
would amend the vendor constraint in §2, and needs that stated in the same
change rather than assumed. Update this section, not just the prose above, when
any of them lands.

---

## 9. Provenance of the claims here

Precision about known versus inferred matters more here than usual, because this
document governs automated write paths against production data.

**Verified in this checkout** at `fix/aum-correctness` `6f30005`, by opening the
files: the `token=`/`currency=usd` request shape and `assertPoolOrientation` in
`chain/historical-prices.ts`; `PINNED_GECKO_POOLS`/`pinnedPoolForToken` and the
tracked-asset table in `config.ts`; `QUARANTINED_PROVENANCE`, `SLEEVE_DEFS` and
`MAX_PERSISTED_PRICE_AGE_MS` in `chain/wallet-valuation.ts`; the `uncounted` and
`expectedKeys` declarations in `ops/series-registry.ts` and their consumption in
`ops/gap-detector.ts`; the dispatcher, per-run cap and cron row in
`worker/handlers/repair.ts` and `db/seed.ts`; the executor's lock/archive/delete/
rebuild/validate sequence and the three failure paths in `ops/wallet-backfill.ts`;
`DEFAULT_RATE_PER_SEC = 0.25`, `DEFAULT_RATE_BURST = 5`, the two `?? "latest"`
defaults, `isEmptyReturnData`, `rpcBatchRequest`, `ethCallBatch` and
`ethGetBlockByNumberBatch` in `chain/base-rpc-client.ts`;
`DEFAULT_MIN_INTERVAL_MS = 3_000`; `APPEND_ONLY_TABLES`; and migrations 0036,
0037 and 0038 in full.

**Re-checked at `main` `7fb823c` under #750**, by opening the files again after
#749 and #751 landed: the shared GeckoTerminal serializer and its
`DEFAULT_MIN_INTERVAL_MS = 6_000` in `chain/gecko-rate-limit.ts`, consumed by
both `token-prices.ts` and `historical-prices.ts`; `seedPoolCache` in
`historical-prices.ts`; `TrackedAsset.deployedAt` in `config.ts` and its per-slot
use through `resolveWalletSnapshotManifest(…, asOf)` and
`gap-detector.ts::detectGaps`; the `*/5 * * * *` `ops.repair_gaps` row in
`db/seed.ts` and the matching `NEW_SCHEDULE_CRON` in the 0.2.2→0.3.0 release
script; and the dispatcher's in-flight-window check in `worker/handlers/repair.ts`.
The rest of §1–§7 was re-read against the same checkout and needed no change.

**Carried forward from the retired `data-self-healing.md` and not re-verified here**: the
GeckoTerminal measurements (UTC-midnight alignment, the ~6-month/~181-candle
server window, the keyless 429 on the sixth call in ~15s, the reserve-sort decoy
pool), the RPC batching and rate-limit numbers (cap of 10, the ~5-token /
~0.55-per-second bucket, the 27:1 Multicall3 leverage), and the date-to-block
arithmetic. These are 2026-08-15 and 2026-08-22 investigation results. The
2026-08-22 re-measurement supersedes the original "meters per sub-call" claim: it
meters per POST, and batching is worth up to 10x, not more.

**Which of those are worth re-running, and which stay marked unverified.** #750
deliberately re-ran none of them, and none is upgraded to verified above.

- **The RPC bucket (~5 tokens, ~0.55/s).** Worth re-measuring — but **not from
  here**. §8.2 already records that the original figure came from a developer IP
  and that shared NAT could make production strictly worse, so a second
  developer-IP measurement would reproduce the flaw rather than close it. It
  stays inherited until someone measures from the production droplet, which is
  the whole content of that §8.2 item.
- **The keyless GeckoTerminal 429 (sixth call in ~15s) and the ~181-candle
  window.** Not worth re-running, and partly superseded already: #749 replaced
  the 3 000 ms spacing with 6 000 ms derived from the ~10 requests/minute quota
  the same investigation implies. Both remain vendor-side facts nobody controls,
  so a fresh reading dates as fast as the old one; the structural claims — one
  request serves a range, a pool prices one side of its pair — are what the code
  and the tests are written against.
- **The batch cap of 10 and the 27:1 Multicall3 leverage.** Structural rather
  than dated, and already re-runnable on demand through the committed benchmarks
  in §7. Re-running them needs live provider access, so it is a deliberate
  operator action, not something a docs pass should quietly assert it did.
- **The date-to-block arithmetic (2s blocks, 43 200/day).** A chain constant, not
  a measurement of ours; the code does not depend on the constant being exact,
  because `resolveDayBlocks` binary-searches and verifies. Left inherited.

**Dated observations are not timeless constants.** Any test written against a
specific decimal from an investigation capture will be flaky by construction;
write tests against the *structural* claims — that a pool prices one side of its
pair, that a candle is UTC-aligned, that an empty return is not a zero.

**Decided but not built** — §5.6 and its supporting notes in §3.2, §4.2, §5.3
and §8.1 describe [D41](../decisions.md), which no code implements. Every claim
in §5.6 about *current* behaviour is a claim about what the split replaces, and
those are verified above; every claim about what the split does is a design
commitment, not an observation. The four safety properties in §5.6 are
derivations from this document's own contract (§1) rather than measurements, and
the request-cost figure — three pool/token keys, roughly ten requests a year —
follows from the asset table in `config.ts` plus the ~181-candle window recorded
below as inherited and unverified.

**A standing warning on method.** Verify deliverables against the tree, never
against issue status: a ticked acceptance criterion is not evidence that the code
exists, and this repository has at least one confirmed instance of an issue
closed COMPLETED with nothing delivered. Where a claim drives a design decision,
verify it or mark it unverified — attributing a claim to its issue is weaker than
checking it, and an attributed claim still gets repeated as fact downstream.
