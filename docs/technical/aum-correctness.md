# Making AUM and allocation complete and correct

Status: **Phase 1 SHIPPED 2026-08-24 (`de5cf06`) — T1.1-T1.4, T3.1, T3.2 done
and verified against the live vendor: the real path now prices WETH at
$1,917-$2,326 for 2026-08-18..20, inside the live sampler's $1,903-$2,514,
where it wrote ~$60,000 before.** Claims verified against code, git history,
the twin DB and the live vendor API (2026-08-23 review); tasks T0.1…T5.3 below.

**Still blocking cutover: T0.2** — every `backfilled` row already in the
database remains BTC-priced. Fixing the writer does not correct what it wrote.
The stage rehearsal has NOT validated any of this: it fails before the repair
checks run, on `no-wedge`, whose 150s budget no Gate C dump older than ~2.5
minutes can satisfy (ours was 35h old). Checks 2 and 3 never executed.
Written 2026-08-23 after a backfilled WETH holding was valued at **~25× its
true price** on a stage twin, silently, with every gate green. Cutover blockers
are marked on the tasks.

Two properties the AUM and allocation surfaces must have and currently do not:

* **Correct** — every value served is the value that was true at that moment, or
  is absent. Never a plausible substitute.
* **Complete** — every day the series claims to cover has a value, or is
  explicitly disclosed as missing.

They are separate properties with separate failure modes, and the second is
worthless without the first. A complete series of wrong numbers is worse than a
gappy series of right ones, because a gap is visible and a wrong number is not.

---

## 1. The defect

On the 2026-08-23 twin, `wallet_balance_samples` from 2026-06-27 onward:

| symbol | amount | price_usd written (range over the 50 backfilled rows) | live-sampled price, same asset |
|---|---|---|---|
| WETH | 15.4378 | **58 545.09 – 69 305.92** (2026-06-27 is 59 950.65) | **2 438.06** |
| ETH | 0.04996 | identical to WETH, day by day | — |

WETH and ETH carry an identical price because ETH resolves through WETH's pool.
~$60 000 is not an ETH price; it is a BTC-class one — **the holding was priced as
a different asset entirely.** The multiple depends on the reference: ~25× against
the same-asset live sample above, ~38× against the adjacent `seed` row for the
day before the boundary (which implies $1 567). The magnitude is a distraction
from the fact that the number is not a WETH price at all.

**Mechanism, confirmed against the live API on 2026-08-23** (not inferred).
`chain/historical-prices.ts:252` requests

```
/networks/base/pools/{pool}/ohlcv/day?aggregate=1&limit=1000&before_timestamp={ts}
```

with no `token=` and no `currency=usd`. Measured against the `cbBTC / WETH 0.05%`
pool (`0x42d4a22cad0f5a49681a5715ce994af73a43b76b`):

| request | close returned |
|---|---|
| exactly what our code sends today | **77 684.75** — cbBTC's price |
| `…&token=0x4200…0006&currency=usd` | **2 466.44** — WETH's price |

So the vendor semantics are settled: **absent `token=`, OHLCV describes the
pool's BASE token**, and `token=<address>&currency=usd` is the correct remedy.
The $2 466 figure agrees with our own live sampler's $2 438, which is the
independent corroboration that the remedy is right. (Re-verified independently
during the 2026-08-23 review: bare → 77 621.21, with `token=` → 2 460.91.)

The same response also **names both sides in-band**: `meta.base` and
`meta.quote` carry each side's symbol and address, and passing `token=` flips
which one is `base`. Orientation is therefore verifiable on the very response
that carries the price — the Phase 1 assertion (T1.2) needs no extra endpoint.

### 1.1 The bug is NON-DETERMINISTIC, and that is the important part

`resolvePoolForToken` selects the highest-24h-volume pool containing the target
token. For WETH on Base, that ranking is a near-tie between pools that mean
opposite things:

```
110,627,595   WETH / USDC 0.3%     WETH is BASE   -> correct price
101,261,626   cbBTC / WETH 0.05%   WETH is QUOTE  -> cbBTC's price
 86,171,193   cbBTC / WETH 0.01%   WETH is QUOTE  -> cbBTC's price
```

A **9% swing in relative volume** decides whether AUM is correct or ~25× high.
Nothing in the code notices the pool changed meaning; the price simply becomes a
different asset's.

Three consequences:

1. **A past correct reading is possible — and would not have been evidence of
   correctness.** The path returns the right price whenever the target token is
   the base side of the leading pool, so any test, rehearsal or eyeball check
   that passed may have passed by luck of that day's ranking. **Stated precisely,
   because the distinction matters:** the *mechanism* is demonstrably intermittent
   (the volume gap is 9%), but this document has **not** verified that the
   backfill ever actually priced WETH correctly. The known-good neighbouring
   values are `seed` rows written by `db/seed.ts`, not by this path. Do not read
   "it used to work" as established.
2. **Bisecting for the breaking commit would have found nothing** — there isn't
   one. The behaviour changed without the code changing.
3. **Quarantine cannot be scoped by date — and not by run either.** Wrongness
   arrives in large uniform blocks, not per-row salt-and-pepper: the pool is
   resolved once per process (`poolIdCache`) and one request prefetches ~180
   days (`PREFETCH_DAYS`), so a single wrong-side resolution poisons an entire
   window at once. On the 2026-08-23 twin **all 50** backfilled WETH/ETH rows
   sit in the BTC price range (58 545 – 69 306) — none correct — while
   BNKR/ROBOTMONEY backfilled prices overlap their live-sampled ranges. And the
   blocks cannot be reconstructed afterwards: the backfill stamps `sampled_at`
   as the *sample day's* 23:59, not the write time (`ops/wallet-backfill.ts:747`),
   so run boundaries are unrecoverable from the table. Every `backfilled` row
   must be re-checked individually (T5.1), not written off by range or by run.

---

## 2. The fetch audit

Prompted by the reasonable hypothesis that batching (#739) broke data fetching.
**It did not.** The evidence matters, because fixing batching would not have
fixed the number.

### 2.1 Provenance of the bug

`git log -L 250,254:backend/src/chain/historical-prices.ts` returns exactly one
commit: **`5788ba6` — the original gap-repair feature (#709/#711)**. That request
line has never been edited since it was written. It has never carried `token=`
or `currency=usd`. The pool-addressed pricing bug is as old as the backfill
itself.

### 2.2 What each fetch path actually does

| Path | Verdict | How it was established |
|---|---|---|
| Per-day block resolution | **Correct** | 113 filled days → 113 distinct blocks, spaced exactly 43200 blocks (86 400 s/day ÷ 2 s/block) |
| Batched multicall → per-block demux | **Correct** | `res[i]` ↔ `entries[i]` positionally, and `rpcBatchRequest` fills results by JSON-RPC **id**, not arrival order |
| Balance amounts | **Correct** | Backfilled amounts match live-sampled amounts exactly at the boundary (`16.2719…`, `11.1044…`). An out-of-band comparison: `UNIQUE (sample_date, symbol)` means the table never holds both provenances for one day, so this was checked across adjacent days, not same-day |
| Empty-return rail | **Correct** | `strictEmptyReturn` refuses `0x` rather than decoding it as a zero balance |
| **Historical price** | **WRONG** | live $2 438 vs backfilled $59 988 for the same asset |

**Balance fetching is sound. Every wrong number is a price.**

### 2.3 Why it looked like a batching regression

Two independent reasons, and the first is the one that matters.

**The path is capable of working, intermittently** (§1.1). It is correct
whenever the target token is the base side of whichever pool currently leads on
volume. So good numbers an operator saw earlier *may* have been genuine, with
the ranking — not the code — changing underneath. But per §1.1.1 this document
has not established that it ever did price WETH correctly, and on the twin no
backfilled WETH row is correct; "it worked before" remains an unverified
impression, which is precisely why it read as a regression.

**And throughput rose at the same time.** Batching let the repair cover ten days
per run instead of one; the cold-start job made it begin at boot rather than at
the next `:25`; and the frontier finally reached days the chart displays. A
writer that was already capable of producing wrong prices started producing many
more of them, in a visible range, the same week batching landed.

### 2.4 What batching *did* break

Real, but none of it produces a wrong value — all of it produces refusals:

1. **Shared-failure blast radius** — one shared leg failing charged an attempt to
   all ten days in the window, retiring them permanently. *Fixed 2026-08-23.*
2. **Request deadline consumed by the rate-token wait** — a paced request was
   reported as a transport timeout. *Fixed 2026-08-23.*
A third defect — **`poolCloses` caching the range it REQUESTED rather than the
range the provider actually covered**, so a truncated page becomes a permanent
"no price" for every older day for the life of the process — is *aggravated* by
window loads but was **not introduced by batching**: `historical-prices.ts` is
not in #739's diff either. Listing it as batching damage would repeat the
attribution error this section exists to correct. Tracked as T1.4. *Open.*

---

## 3. Root cause

**We fetch prices two different ways, and only one of them can be right by
construction.**

There are **three** price call sites, not two, and only one is safe by
construction:

| Call site | Used by | Endpoint | Addressed by | Can misattribute? |
|---|---|---|---|---|
| `token-prices.ts:326` `fetchGeckoTokenPriceUsd` | live sampler | `/simple/networks/base/token_price/{addrs}` | **token** | **No** — you name the token |
| `token-prices.ts:235` `fetchGeckoDailyCloseUsd` | buyback USD valuation (`buyback-logs.ts:282`) | `/networks/base/pools/{pool}/ohlcv/day` + `currency=usd` | **pool** | **Yes in principle** — right today only because its pool is a pinned constant (`WETH_USDC_POOL`) in which WETH happens to be the BASE side |
| `historical-prices.ts:252` | backfill (`ops/wallet-backfill.ts`) | `/networks/base/pools/{pool}/ohlcv/day` | **pool** | **Yes, actively** — the pool is chosen dynamically by volume, so the side can flip underneath it (§1.1) |

The middle row matters and the previous revision of this document got it wrong,
calling that module safe. `buyback_swaps.value_usd` comes from the same
pool-addressed pattern, carrying `currency=usd` but no `token=`. It is correct
today **by luck of the pinned pool's orientation**, not by design: repoint that
constant at a pool where WETH is the quote side and buyback values silently
become cbBTC-denominated. T1.1 must fix both call sites.

Everything downstream inherits this. Three writers populate
`wallet_balance_samples` — `worker/handlers/wallet.ts` (live),
`ops/wallet-backfill.ts` (backfilled), `db/seed.ts` (seed) — under five
provenance values, keyed `(sample_date, symbol)`, and **nothing asserts that a
value written by one writer is consistent with what another wrote for the
adjacent day.** That assertion is exactly what a 25× step would trip.

### 3.1 Why the tests could not see it

* `tests/wallet-backfill-window.test.ts:89` — the executor's injected
  `loadPrices` returns `2` for every asset, every day. The price is a fixture
  constant, so no pricing error is reachable.
* `tests/historical-prices.test.ts:155-170` — stubs `fetch`, matches on
  `String(url).includes("/ohlcv/")`, returns a canned candle, asserts **call
  counts**. A URL missing `token=` answers identically to a correct one.

Above the seam the price cannot be wrong; below it the request cannot be wrong.
Nothing crosses. And no test anywhere asserts that a written `price_usd` or
`value_usd` is plausible.

### 3.2 Why the gates could not see it

`repair-completion` asserts rows exist carrying `provenance='backfilled'`.
Postflight asserts tables exist, migrations applied, triggers live. §7.1 asserts
dispatch happened. **Not one of them looks at a number.**

---

## 4. Target properties, stated so they can be tested

> **P1 — One price path, token-addressed.** Exactly one module answers "USD price
> of token T at time t". Live is the `t = now` case, not a separate system. Any
> pool-addressed read must name the side it means and prove it.
>
> **P2 — No value is written that cannot be corroborated.** A writer that cannot
> corroborate a value writes nothing and discloses a gap.
>
> **P3 — Continuity is an invariant.** A day-over-day step in a holding's unit
> price beyond a configured band is a defect until proven otherwise, whichever
> writer produced it.
>
> **P4 — Provenance is served, not hidden.**
>
> **P5 — Completeness is measured and served**, so a chart can draw a gap rather
> than interpolate one.

---

## 5. Plan, as tasks

Ordered by risk. Phase 1 is the foundation the rest sits on. **Cutover blockers
are T0.1, T0.2, T1.1 and T1.2** — the rest makes the guarantee durable; those
make it stop being wrong. Every task names its files and a *done-when* that is
observable, because "a run looked right" is exactly the evidence §1.1 retired.

### Phase 0 — Contain

- [ ] **T0.1 — Hold the v0.3.0 cutover** until T1.1 + T1.2 are merged and T0.2
  has run. *(cutover blocker)* The repair is live-on-arrival:
  `worker/handlers/repair.ts::backfillEnabled` passes on shipped defaults
  (pacing defaults on; only `BASE_RPC_MAX_CALLS_PER_SEC=0` disables it), so
  first boot starts writing prices that may describe a different asset.
  *Done when:* docs/runbooks/v0-3-0-rollout.md lists T0.2/T1.1/T1.2 as
  preconditions of the cutover step.
- [ ] **T0.2 — Quarantine, don't delete.** *(cutover blocker)* Migration: move
  every existing `provenance='backfilled'` row in `wallet_balance_samples` and
  `wallet_sleeve_samples` to `provenance='backfilled-quarantined'`; the serving
  layer treats that value as absent. The table has no append-only trigger, so
  the UPDATE is possible; the wrong values are evidence, so no DELETE. Scope is
  **all** backfilled rows, not just WETH/ETH — runs are unrecoverable (§1.1.3)
  and re-admission is T5.1's job, not this migration's.
  *Done when:* no API response serves a value from a quarantined row, and the
  rows still exist with their original numbers.
- [ ] **T0.3 — Reset the `exhausted` days** after T1.1–T1.4 land: clear
  `wallet_backfill_state` rows with `status='exhausted'` so the planner retries
  them. They are terminal by design — `selectBackfillDays` treats
  `('filled','skipped','exhausted')` as settled — and will never retry on their
  own.
  *Done when:* the next repair run re-plans those days.

### Phase 1 — One token-addressed price path *(the foundation)*

- [x] **T1.1 — Make every price request name its token.** *(cutover blocker)*
  - `chain/historical-prices.ts:252` — append
    `&token=<tokenAddress>&currency=usd`; thread the token address through
    `poolCloses` → `fetchDailyCloses`, which are pool-keyed today.
  - `chain/token-prices.ts:235` (`fetchGeckoDailyCloseUsd`) — add `token=`; it
    already carries `currency=usd`. The signature gains the token address;
    `buyback-logs.ts:282` passes the WETH address. This is the call site that is
    right today only by the pinned pool's orientation (§3).
  **Verified against the live API** (§1): the same pool returns a cbBTC close
  without `token=` and WETH's with it, agreeing with our live sampler.
  *Done when:* T3.1's contract test passes, and a twin backfill writes WETH at a
  price adjacent to the seed-implied ~$1 567 series, not ~$60 000.
- [x] **T1.2 — Assert orientation in-band; refuse what cannot be proven.**
  *(cutover blocker)* The OHLCV response's `meta.base` / `meta.quote` carry both
  sides' addresses (§1, re-verified live). After T1.1, assert
  `meta.base.address` equals the requested token, case-insensitively; on
  mismatch or absent `meta`, throw — the day becomes a disclosed gap, never a
  substituted price. `token=` fixes the *denomination*; this fixes the
  *stability*: even when the volume ranking swaps pools between runs (§1.1),
  a price can no longer silently describe a different asset.
  *Done when:* T3.2's wrong-orientation fixture is refused.
- [x] **T1.3 — Pin the pool per asset.** Add a pinned-pool map for gecko-priced
  assets in `config.ts` (successor to the dead `*_POOL_ID` env vars, #639;
  `WETH_USDC_POOL` at config.ts:449 is the precedent), leaving
  `resolvePoolForToken`'s volume ranking as a *logged fallback* for unpinned
  assets only. With T1.2 in place a bad pool degrades to a refusal, not a wrong
  number — pinning restores *availability*; T1.2 owns *correctness*.
  *Done when:* WETH prices from the pinned WETH/USDC pool with zero resolver
  requests.
- [x] **T1.4 — Fix `poolCloses` coverage bookkeeping.** Cache the range a
  response *actually covered* (oldest candle observed — `fetchDailyCloses`
  already tracks `oldest`, it just doesn't return it), not the range requested.
  A requested-but-uncovered day is *not fetched* (retryable), never *no price*.
  Aggravated by window loads, not introduced by them (§2.4).
  *Done when:* a unit test with a truncated first page shows older days retried
  rather than permanently blank for the process lifetime.
- [ ] **T1.5 — Collapse the two modules onto one interface.** One module owns
  "USD price of token T at time t"; `token-prices.ts` (live spot + buyback
  daily close) and `historical-prices.ts` (backfill) share the request builder
  and the T1.2 assertion, differing only in *when* they price, never in *what a
  price means*. May land after cutover.
  *Done when:* exactly one function in the repo builds a pool-OHLCV URL
  (today there are two: §3's grep-verified inventory).

### Phase 2 — Refuse to write what cannot be corroborated

- [ ] **T2.1 — Plausibility rail at the write boundary.** In
  `ops/wallet-backfill.ts`, before the INSERT: compare each holding's unit price
  to the nearest accepted price for that symbol — live sample, seed-implied, or
  previously accepted backfilled day; a step beyond the band fails the day with
  a recorded reason and leaves a disclosed gap. Start with a fixed ×/÷2-per-
  calendar-day band, per-asset override in config; open question 1 narrows it
  later rather than blocking it. **This is the single highest-value item in the
  plan** — it is the only one that catches bugs nobody predicted.
  *Done when:* replaying the 2026-06-27 window against the *broken* fetch writes
  nothing and records the refusal.
- [ ] **T2.2 — Enforce the band where a future writer cannot forget it.**
  Trigger on `wallet_balance_samples` / `wallet_sleeve_samples` rejecting a row
  whose unit price steps beyond the band against the adjacent accepted day,
  absent an explicit override (session setting an operator must deliberately
  set).
  *Done when:* a raw SQL insert of a 25× step is rejected on the twin.
- [ ] **T2.3 — Corroborate across sources for backfilled days.** Blocked on open
  question 2 (a second, independent provider). If accepted: a backfilled day is
  written only when two sources agree within a band; otherwise it is a gap.

### Phase 3 — Tests that cross the seam

- [x] **T3.1 — Request-shape contract test.** Assert every OHLCV URL the repo
  builds carries `token=` and `currency=usd` — both call sites. Pure string
  assertion, no network; would have caught this at PR time.
- [x] **T3.2 — Golden tests through the real pricing path** against recorded
  provider responses *including `meta`*: a right-orientation fixture asserting
  the resulting `value_usd` (so a change in either the request or the
  arithmetic fails), and a wrong-orientation fixture asserting refusal (T1.2).
- [ ] **T3.3 — Plausibility property test** over generated holdings and price
  series: no generated discontinuous series survives the T2.1 rail.
- [ ] **T3.4 — Stop neutralising shipped defaults.** `tests/preload.ts:50` sets
  `BASE_RPC_MAX_CALLS_PER_SEC=0` suite-wide, so the shipped pacing default is
  executed by nothing; scope it to the files that need it.
- [ ] **T3.5 — Assert consequences, not statuses** — rows written, attempts
  charged, budget spent; never `ok: true` alone.

### Phase 4 — Gates that grade numbers

- [ ] **T4.1 — Postflight asserts AUM continuity across every provenance
  boundary** — day-over-day unit-price step within the band; the exact
  discontinuity that would have caught this before anyone opened a chart.
- [ ] **T4.2 — `repair-completion` grades plausibility, not row existence**
  (docs/runbooks/v0-3-0-rollout.md, check 3 — today it passes on any row
  carrying `provenance='backfilled'`, whatever the number says).
- [ ] **T4.3 — A completeness metric per series** — days covered ÷ days
  claimed, by provenance — served and monitored.

### Phase 5 — Re-verify, then serve honestly

- [ ] **T5.1 — Re-admit quarantined rows individually.** The T2.1 rail pointed
  backwards: check every quarantined row against a freshly fetched
  token-addressed price for its day; within band → restore to `backfilled`,
  outside → leave quarantined and let the repair refill the day under T1.
  Start from "assume all guilty" (§1.1.3). Expected on the twin: WETH/ETH rows
  refill with correct prices; BNKR/ROBOTMONEY and usdc-kind rows re-admit.
  *Done when:* zero quarantined rows remain unadjudicated.
- [ ] **T5.2 — Wallet-balance and allocation responses carry per-point
  provenance and a completeness summary.**
- [ ] **T5.3 — The frontend draws gaps as gaps** — never interpolates a missing
  day.

---

## 6. What this changes about how we work

* **A number nobody has corroborated is not data.** The repair's contract must
  move from "write what the provider said" to "write what two independent
  sources agree on, or write nothing".
* **Gaps are cheap; wrong values are expensive.** Every trade-off here resolves
  toward refusing to write.
* **Green gates are not evidence.** Every gate passed while AUM read 25× high.

---

## 7. Open questions for the decision

1. **Tolerance band** for P3 — fixed factor, volatility-scaled, or per-asset?
   Does not block T2.1, which starts from a fixed ×/÷2-per-day default; this
   question only narrows it.
2. **Is a second price source operationally acceptable?** Corroboration needs an
   independent reference: another provider, quota and failure mode. Blocks T2.3
   and nothing else.
3. ~~**How do we re-verify?**~~ **Settled by the twin evidence.** Not "how far
   back" — wrongness comes in run-sized blocks whose boundaries the table does
   not record (§1.1.3), so neither a date cutoff nor a run cutoff can separate
   them. Every `backfilled` row gets an individual plausibility check against an
   independent token-addressed price, starting from "assume all guilty" — the
   Phase 2 rail pointed backwards. That is T5.1, fed by T0.2's quarantine.
4. **How much of allocation inherits this?** Target weights come from
   `allocation_framework` (managed, no chain reads) and are sound, but the
   *realised* allocation view derives from the same holdings and inherits the
   price error.
