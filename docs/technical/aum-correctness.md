# Making AUM and allocation complete and correct

Status: **proposal, awaiting decision.** Written 2026-08-23 after a backfilled
WETH holding was valued at **~25× its true price** on a stage twin, silently,
with every gate green.

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

| symbol | amount | price_usd written | live-sampled price, same asset |
|---|---|---|---|
| WETH | 15.4378 | **59 988.51** | **2 438.06** |
| ETH | 0.04996 | **59 988.51** | — |

WETH and ETH carry an identical price because ETH resolves through WETH's pool.
~$60 000 is not an ETH price; it is a BTC-class one. AUM for those days reads
about 25× high, and the chart steps at the provenance boundary.

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
independent corroboration that the remedy is right.

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

1. **"It used to work" is true, and is not evidence of a fix.** The path was
   correct whenever WETH/USDC won the sort. Any test, rehearsal or manual check
   that passed did so by luck of the ranking on that day.
2. **Bisecting for the breaking commit would have found nothing** — there isn't
   one. The behaviour changed without the code changing.
3. **Quarantine cannot be scoped by date.** Some existing `backfilled` rows are
   correct and some are 25× high, interleaved by whichever pool ranked first when
   each window's prices were fetched. Every row must be re-checked individually,
   not written off by range.

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
| Per-day block resolution | **Correct** | 113 filled days → 113 distinct blocks, spaced exactly 43200 (2s × 86400s) |
| Batched multicall → per-block demux | **Correct** | `res[i]` ↔ `entries[i]` positionally, and `rpcBatchRequest` fills results by JSON-RPC **id**, not arrival order |
| Balance amounts | **Correct** | Backfilled amounts match live-sampled amounts exactly where the ranges overlap (`16.2719…`, `11.1044…`) |
| Empty-return rail | **Correct** | `strictEmptyReturn` refuses `0x` rather than decoding it as a zero balance |
| **Historical price** | **WRONG** | live $2 438 vs backfilled $59 988 for the same asset |

**Balance fetching is sound. Every wrong number is a price.**

### 2.3 Why it looked like a batching regression

Two independent reasons, and the first is the one that matters.

**The path really did work before, intermittently** (§1.1). It is correct
whenever the target token is the base side of whichever pool currently leads on
volume. So an operator who saw good numbers previously saw them genuinely — the
ranking, not the code, then changed underneath.

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
3. **`poolCloses` caches the range it REQUESTED, not the range the provider
   actually covered** — a truncated page becomes a permanent "no price" for
   every older day, for the life of the process. *Open.*

---

## 3. Root cause

**We fetch prices two different ways, and only one of them can be right by
construction.**

| Path | Used by | Endpoint | Addressed by | Can misattribute? |
|---|---|---|---|---|
| `chain/token-prices.ts` | live sampler (`worker/handlers/wallet.ts`) | `/simple/networks/base/token_price/{addrs}` | **token** | No — you name the token |
| `chain/historical-prices.ts` | backfill (`ops/wallet-backfill.ts`) | `/networks/base/pools/{pool}/ohlcv/day` | **pool** | **Yes** — must disambiguate the side, and does not |

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

## 5. Plan

Ordered by risk. Phase 1 is the foundation the rest sits on.

### Phase 0 — Contain

1. **Do not ship v0.3.0's repair as it stands.** On the live-on-arrival default
   it begins writing wrong prices to production on first boot. Cutover blocker.
2. **Quarantine, don't delete.** `wallet_balance_samples` is not under the
   append-only guard, so backfilled rows are correctable — but the wrong values
   are evidence. Mark them.
3. **Reset the `exhausted` days** once pricing is trustworthy; they are terminal
   by design and will never retry on their own.

### Phase 1 — One token-addressed price path *(the foundation)*

1. **Make every price request name its token.** Pass
   `token=<tokenAddress>&currency=usd` on the OHLCV request so candles are
   denominated for the token being priced, not the pool's base. **Verified
   against the live API** (§1): the same pool returns 77 684.75 without it and
   2 466.44 with it, the latter agreeing with our own live sampler.
2. **Refuse pools whose side cannot be established.** When resolving a pool for a
   token, record which side the token is on; if that cannot be determined, price
   nothing rather than guess.
3. **Collapse the two modules onto one interface.** `token-prices.ts` and
   `historical-prices.ts` must differ only in *when* they price, never in *what a
   price means*. One module owns "USD price of token T at time t".
4. **Fix `poolCloses` coverage bookkeeping** — cache the range actually covered
   (oldest candle observed), and treat requested-but-uncovered days as *not
   fetched* rather than *no price*.

### Phase 2 — Refuse to write what cannot be corroborated

1. **Plausibility rail at the write boundary.** Compare each holding's unit price
   against the nearest known-good price for that symbol; deviation beyond a
   configured band fails the day and leaves a disclosed gap. **This is the single
   highest-value item here** — it is the only one that catches bugs nobody
   predicted.
2. **Corroborate across sources** for backfilled days.
3. **Put the rail where a future writer cannot forget it** — a trigger rejecting
   a row whose unit price steps beyond the band without an explicit override.

### Phase 3 — Tests that cross the seam

1. **Request-shape contract** — assert the OHLCV URL carries `token=` and
   `currency=usd`. Pure string assertion, no network, would have caught this at
   PR time.
2. **One golden test through the real pricing path** against a recorded provider
   response, asserting the resulting `value_usd` — so a change in *either* the
   request or the arithmetic fails.
3. **Plausibility property test** over generated holdings and price series.
4. **Stop neutralising shipped defaults** — `tests/preload.ts:50` sets
   `BASE_RPC_MAX_CALLS_PER_SEC=0` suite-wide, so the shipped pacing default is
   executed by nothing.
5. **Assert consequences, not statuses** — rows written, attempts charged,
   budget spent.

### Phase 4 — Gates that grade numbers

1. Postflight asserts **AUM continuity across the provenance boundary** — the
   exact discontinuity that would have caught this before anyone opened a chart.
2. `repair-completion` grades plausibility, not row existence.
3. A **completeness metric per series**, served and monitored.

### Phase 5 — Serving-layer honesty

1. Wallet-balance and allocation responses carry per-point provenance and a
   completeness summary.
2. The frontend **draws gaps as gaps** — never interpolates a missing day.

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
2. **Is a second price source operationally acceptable?** Corroboration needs an
   independent reference: another provider, quota and failure mode.
3. **How do we re-verify?** Not "how far back" — §1.1 means correct and wrong
   rows are interleaved unpredictably, so a date cutoff cannot separate them.
   Every `backfilled` row needs an individual plausibility check against an
   independent price. That is the same machinery as Phase 2's rail, pointed
   backwards at existing data.
4. **How much of allocation inherits this?** Target weights come from
   `allocation_framework` (managed, no chain reads) and are sound, but the
   *realised* allocation view derives from the same holdings and inherits the
   price error.
