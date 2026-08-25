# AUM correctness and repairability: current architecture and plan

Status: the original pool-orientation incident is contained, but the AUM
contract is not yet complete. This document describes the current tree; dirty
working-copy edits are not treated as shipped.

## Contract

For this review:

- **Truth** means evidence that a quote is for the declared asset, at the
  declared observation time, in the declared currency, from an identified
  source/configuration. A finite, plausible number is not truth.
- **Correctness** means the quote passes identity and time semantics and the
  derived arithmetic is valid: positive finite price, amount × price = value,
  and no fabricated zero or substitute asset.
- **Consistency** means all legs in one published AUM point use one coherent
  snapshot (asset set, time, currency, source/config identity, and state), not
  the latest row independently available for each symbol.
- **Completeness** means every symbol expected for that snapshot has a valid
  value, or the snapshot explicitly records the missing symbol/state. A date
  with one row is not a complete AUM snapshot.
- **Repairability** means a rejected or quarantined observation remains
  evidence, is counted as missing, and can be retried/adjudicated without
  manual key deletion or a terminal state that suppresses future repair.

Time has two explicit meanings. **Live** is a latest chain read plus a current
spot quote, with `sampled_at` recording when that read occurred; it is not a
historical close. **UTC daily-close** is the settled close for one UTC calendar
day, joined to that day's UTC key and, for chain balances, that day's resolved
block. A daily repair must not mix today's spot, a different UTC day, and a
different block into one point.

## Current architecture

### Live flow

`worker/handlers/wallet.ts:34-80` runs the daily sampler, reads latest Base
balances through `fetchWalletBalances`, derives the UTC `sampleDate`, and
upserts `(sample_date, symbol)`. The sleeve sampler follows the same pattern at
`worker/handlers/wallet.ts:91-149`. `wallet-balances.ts:288-305` reads all
current legs and prices each asset independently; `token-prices.ts:412-429`
uses $1 for USDC, Yahoo for SP500, and token-addressed Gecko spot for crypto.

On provider failure, `wallet-balances.ts:184-217` falls back to a prior holding
as `stale`; the worker persists rows with `ON CONFLICT ... DO UPDATE`
(`worker/handlers/wallet.ts:67-79`). The request projection is not a snapshot:
`wallet-balances.ts:343-353` selects the latest row per symbol, sums those
holdings at `:388`, and labels the response with the freshest `sampled_at` over
all selected rows at `:392-399`. Sleeves independently do the same at
`wallet-sleeves.ts:92-156`.

### Historical and backfill flow

`worker/handlers/repair.ts:71-165` calls the date-level gap detector and
dispatches wallet Class-C repair. `ops/wallet-backfill.ts:251-317` derives
closed missing dates, then excludes statuses `filled`, `skipped`, and
`exhausted`; only an undefined or `failed` date is planned. For each day,
`ops/wallet-backfill.ts:742-839` resolves that day's block, reads all chain legs
at that block, loads daily prices, and refuses a missing leg before the write.
The intended day-atomic transaction is at `:844-921`, but its occupancy checks
count every row, including quarantined rows (`:850-865`), and its
`ON CONFLICT DO NOTHING` writes no replacement (`:867-902`).

`chain/historical-prices.ts:405-494` fetches token-addressed Gecko daily
OHLCV, verifies response orientation, and keys closes by UTC day.
`loadHistoricalPrices` deliberately throws for non-Gecko historical assets,
including SP500 (`:563-600`); `SP500` is therefore absent from a repaired day,
while `frontend/public/assets/js/app/alpine/views/wallet-perf.js:69-103`
interprets an absent asset inside an existing point as zero.

### Protections already shipped

- Both pool-OHLCV builders require `token=` and `currency=usd`: historical
  `chain/historical-prices.ts:424-431` and buyback daily close
  `chain/token-prices.ts:275-308`. `backend/tests/ohlcv-orientation.test.ts`
  covers both request shapes and recorded response behavior.
- Both paths assert the in-band `meta.base.address` matches the requested
  token (`token-prices.ts:245-273`; `historical-prices.ts:335-370`) and refuse
  an unorientable or opposite-side response.
- WETH/native ETH have a configured historical pool pin at
  `config.ts:450-495`. This improves repeatability and availability, but does
  not prove that the configured pool is the economically intended market.
- Historical coverage caches the range actually observed, not merely the
  requested range (`historical-prices.ts:372-494`, with cache stitching at
  `:235-273`), so truncated responses remain retryable.
- Migration `0036_quarantine_backfilled_samples.sql:43-80` preserves suspect
  rows as `backfilled-quarantined`; `series-registry.ts:81-101` and
  `gap-detector.ts:54-82` exclude them from coverage, and serving readers
  exclude them (`wallet-balances.ts:166-174, 343-351`; `wallet-sleeves.ts:92-100`).
  The whole affected day is omitted from history (`wallet-balances.ts:239-283`).
- The frontend renders absent calendar days as `null`, uses
  `spanGaps:false`, and discloses gap counts (`wallet-perf.js:49-73,
  90-103, 133-169`). This is a shipped display safeguard, not API completeness.

## Remaining defects

1. **Quarantine is not repairable by the normal path.** The detector counts a
   quarantined key as missing, but the planner/executor treats its occupied
   natural key as a populated day and records `skipped`; `selectBackfillDays`
   then treats `skipped` as settled (`wallet-backfill.ts:296-315,
   :850-919`). P0 must replace this with explicit quarantine replacement and
   evidence-preserving state transitions.
2. **AUM mixes snapshots.** Latest-per-symbol selection and “freshest row”
   `asOf` (`wallet-balances.ts:343-399`) can combine different dates,
   provenance, source, and stale ages while presenting one total.
3. **Stale fallback lacks immutable quote identity.** The fallback carries only
   a value and timestamp (`wallet-valuation.ts:132-175`), while same-day
   upserts replace the natural-key row (`worker/handlers/wallet.ts:67-79`). A
   later write can therefore make a stale-derived row look fresh without a
   reproducible quote/source/snapshot record.
4. **Completeness is date-only.** The registry explicitly defines coverage as
   “at least one row for a slot,” not date × expected-symbol
   (`series-registry.ts:16-27`); the detector selects distinct dates
   (`gap-detector.ts:65-82`). It cannot prove a full wallet/sleeve snapshot.
5. **Historical SP500 is omitted, then rendered as zero** in an otherwise
   present day (`historical-prices.ts:536-540`; `wallet-perf.js:69-73`). The
   product must choose explicit skip/unknown/config-time behavior.
6. **Provenance is not reproducible enough.** Tables retain a coarse
   `provenance` and `sampled_at` but no source response identity, block/config
   identity, currency, or quote identity (`migrations/0014_wallet_balance_samples.sql:23-33`,
   `migrations/0021_chain_indexer_samples.sql:7-18`). History collapses all
   row provenance to one dominant label per date (`wallet-balances.ts:261-280`),
   and completeness is not served; `/api/admin/gaps` exposes date slots only
   (`api/routes/admin.ts:288-296`).

`#743` is separate unless future evidence links it to one of these defects.

## Phased plan, in priority order

### P0 — Make quarantined gaps repairable and commit only complete snapshots

Files: `ops/wallet-backfill.ts`, `ops/gap-detector.ts`,
`ops/series-registry.ts`, migration(s) for repair state/evidence, and the
wallet backfill/quarantine tests.

Replace occupied-key skipping with an explicit adjudication/replacement path:
retain the quarantined row, insert a verified replacement under a controlled
state transition (or record an explicit unresolved row), and keep retries
eligible. A repair transaction must validate the complete expected aggregate
and sleeve symbol set before committing either snapshot; partial rows and a
“filled” checkpoint are forbidden.

Done when: a quarantined fixture is counted missing, repaired without manual
deletion, old evidence remains queryable, an incomplete fixture commits no
snapshot, and a complete fixture commits exactly one complete snapshot with a
retryable failure state. Test with `wallet-backfill.test.ts`, quarantine
integration tests, and a transaction rollback test. Do not count the dirty
working-copy plausibility rail as shipped.

### P1 — Define coherent time, snapshot, and completeness semantics

Files: `chain/wallet-balances.ts`, `chain/wallet-sleeves.ts`,
`worker/handlers/wallet.ts`, `ops/series-registry.ts`, contract DTOs, and the
frontend wallet-performance view/tests.

Introduce an explicit snapshot identity and expected-symbol manifest. Live
responses use one live observation window; historical responses use one UTC
daily-close key plus that day's block. Decide and encode SP500 behavior (a
historical Yahoo close, an explicit unavailable leg, or a separate config-time
series); never turn omission into zero.

Done when: every served total points to one snapshot/time basis, every expected
symbol is present or explicitly missing, mixed-date rows cannot form a total,
and SP500 behavior is asserted in API, backfill, and browser tests.

### P2 — One quote interface and auditable source policy

Files: `chain/token-prices.ts`, `chain/historical-prices.ts`,
`chain/wallet-valuation.ts`, `config.ts`, `buyback-logs.ts`, plus quote
fixtures/tests.

Create one shared quote record/interface containing asset identity, observation
time/UTC day, currency, value, source/provider, pool or ticker, response
identity, and config identity. Make live and historical callers use the same
request/orientation policy. Vetted pool/source policy must be explicit per
asset; WETH pinning is not sufficient identity proof. Independent sources are
useful corroboration and a degradation signal, but agreement is not
mathematical truth and disagreement must produce an explicit degraded/missing
state rather than an arbitrary winner.

Done when one interface covers spot and daily close, source/pool/config identity
is persisted and replayable, and tests cover right asset, wrong side, wrong
currency, stale fallback, source disagreement, and provider outage.

### P3 — Structural and application validation

Files: new wallet-snapshot/quote migrations, `ops/wallet-backfill.ts`, worker
writers, and database/application validation tests.

Add database constraints and application checks for positive finite values,
`value = amount × price`, asset/currency identity, valid timestamps, legal
provenance/state transitions, and complete snapshots. Continuity bands remain
anomaly signals and test inputs only: they are never proof of truth and must
not become hard database triggers for ordinary market discontinuities.

Done when raw invalid inserts and illegal state transitions fail, arithmetic and
identity mismatches fail before commit, a complete snapshot is the only
publishable state, and a legitimate large market move is recorded as an
anomaly rather than rejected by a hard continuity trigger.

### P4 — Serve completeness/provenance and grade values

Files: dashboard DTOs/routes, `api/routes/admin.ts`, repair/postflight gates,
`wallet-perf.js`, and API/browser/gate tests.

Serve snapshot completeness (expected/present/missing symbols), time basis,
provenance/source identity, degraded state, and per-point evidence. Update
repair completion and postflight to grade values, identity, arithmetic, and
completeness—not merely row existence—and make missing data visible to clients.

Done when an API consumer can distinguish complete, incomplete, stale,
quarantined, and degraded points without database access; gates fail on a
wrong-but-plausible value and on a partial snapshot; browser tests preserve
visible gaps and never coerce missing legs to zero.

### P5 — Adjudicate all quarantined rows and prove end-to-end repair

Files: an operator-safe adjudication job/CLI under `ops/`, repair migrations if
needed, runbook, and integration/stage tests.

Re-evaluate every quarantined balance and sleeve row individually against the
new quote record and snapshot rules. Re-admit only evidence that passes; leave
the rest disclosed and let P0 repair it. Record the decision and source
identity for every row.

Done when no quarantined row is unadjudicated, evidence counts reconcile before
and after, a deliberately broken quote remains a gap, a correct quote repairs
both aggregate and sleeve snapshots, and an end-to-end run proves the API and
frontend show the repaired complete snapshot.

## Disposition of the old T0.1–T5.3 plan

| Task | Disposition | Current status |
|---|---|---|
| T0.1 | Keep | Shipped: cutover hold/preconditions. |
| T0.2 | Keep | Shipped: quarantine preserves rows and excludes them from serving/coverage. |
| T0.3 | Keep | Shipped: exhausted state reset is migration-backed. |
| T1.1 | Keep | Shipped: both OHLCV paths name token and USD. |
| T1.2 | Keep | Shipped: in-band orientation refusal. |
| T1.3 | Replace/extend | Incomplete: only the WETH address is pinned (native ETH shares that address); pinning gives repeatability/availability, not identity correctness. |
| T1.4 | Keep | Shipped: actual-response coverage is cached and retryable. |
| T1.5 | Keep | Needed: one shared quote interface/request policy is not present. |
| T2.1 | Replace | Uncommitted draft only — not shipped; replace its hard ×/÷2 rail with anomaly evidence and explicit adjudication. |
| T2.2 | Replace | Hard continuity DB trigger is the wrong design; use structural validation plus anomaly signals. |
| T2.3 | Keep/reframe | Independent source is helpful corroboration/degradation evidence, not mathematical truth. |
| T3.1 | Keep | Shipped: request-shape contract coverage. |
| T3.2 | Keep/complete | Incomplete end-to-end: extend golden tests through write, arithmetic, identity, and snapshot commit. |
| T3.3 | Keep | Needed: anomaly/property testing. |
| T3.4 | Keep/reframe | Open: the suite-wide preload still disables the shipped pacing default; keep dedicated limiter tests, but scope the opt-out rather than treating pacing as proof of AUM truth. |
| T3.5 | Keep | Shipped: tests assert consequences, not only statuses. |
| T4.1 | Keep | Needed: continuity/anomaly checks across provenance boundaries, plus value/identity/completeness postflight grading. |
| T4.2 | Keep | Needed: repair-completion must grade values, not row existence. |
| T4.3 | Keep | Needed: completeness must be per expected symbol and served. |
| T5.1 | Keep | Highest repair blocker: adjudicate/re-admit every quarantined row. |
| T5.2 | Keep/complete | Incomplete: API needs snapshot completeness and reproducible provenance. |
| T5.3 | Keep | Shipped: frontend renders calendar gaps as gaps. |

No uncommitted change is marked shipped above.
