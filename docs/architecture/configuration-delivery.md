# Configuration delivery

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 12. Configuration delivery — the compose allowlist rail

*Absorbed from the retired `docs/technical/data-self-healing.md` §10.1. It is one
half of the silent-zero defect class — a wrong computation that reports success —
whose chain-read half lives in
[`technical/markets-asset-pricing-ingest.md`](../technical/markets-asset-pricing-ingest.md) §6.1.*


The mechanism here is a delivery boundary rather than a decoder, but the outcome
is identical: a live code path computes a wrong answer and reports it as `ok`.

**The compose `environment:` block is a test-enforced allowlist.** The `api`
service's block (`docker-compose.yml:170`) says so in its own comment
(`:170-177`): there is no `env_file:` in any compose file and `backend/Dockerfile`
sets no `ENV`, so **a variable not named there never reaches the container.**
That premise is asserted rather than assumed —
`scripts/tests/integration/smoke-compose-config.test.ts:520-529` greps all three
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
- **`STRATEGY_VAULT_*_ADDRESS` (#642) — an undeliverable knob, and a false
  premise behind it.** *(Corrected 2026-08-16 — the original text of this bullet
  is retained below the correction, because how it went wrong is itself an
  instance of the failure mode this section is about.)*

  All five keys were undeliverable and `resolveStrategyVaults()` returned an
  empty list in every containerized deployment, so ZYFAI-SS1 and GIZA-SS1 NAV
  was pinned to idle-USDC-only. **That much held up.** What did not is the
  justification for the mechanism, and this document repeated it uncritically:
  *"the agent rotates vaults every 1-2 days"*. On-chain verification (Base
  mainnet, 2026-08-16) found no rotation — GIZA-SS1 holds `gtUSDCp`,
  `steakUSDC`, `aBasUSDC` and `cUSDCv3` **simultaneously**, which is a portfolio.
  The claim traces to the auto-loop's own default rationale in decision issue
  **#145**, whose checkboxes were never ticked; it was auto-applied at the
  seven-day timeout, then written into `backend/src/config.ts` citing "the #120
  investigation" as its source. #120 established no such thing.

  The corrected impact is also smaller than this bullet claimed. Both accounts
  are effectively empty: ZYFAI-SS1 holds 0.000044 USDC and no position at all;
  GIZA-SS1's positions are dust (`convertToAssets` returns 0 for both ERC-4626
  legs). **Present NAV impact ≈ $0** — it was a correctness defect, not
  "wrong numbers live in production now" as originally written here.

  Fixed by baking the verified addresses as constants (no env indirection, no
  new compose allowlist keys), splitting the ERC-4626 vault path from the
  underlying-denominated aToken path — `aBasUSDC` and `cUSDCv3` are **not**
  ERC-4626, so the original design would have reverted on them the moment the
  list was populated — and disclosing an idle-only NAV per leg as
  `WalletHolding.strategyNavIdleOnly`. See `docs/decisions.md` D35.

  *The lesson for this document: "cited in a source comment" is not
  verification. The original bullet correctly flagged its own live-impact claim
  as #642's finding rather than its own, but it passed the rotation claim
  through as fact because a code comment asserted it.*
- **SP500 sizing (#641) — a plausible dollar figure with no staleness signal.**
  `readChainAmounts` sets `{ ok: true, amount: SP500_SIZE }` unconditionally for
  the `config` valuation kind (`backend/src/chain/wallet-balances.ts`), so a
  stale size never degrades to `stale` the way a failed chain read does.
  *(Verified in this checkout.)* **#641 resolved only half of this**: it made
  `SP500_SIZE` a committed constant (`backend/src/config.ts`) and dropped the env
  override, which no container could receive anyway, so drift is now at least
  visible in a reviewed diff. The DTO still carries no signal distinguishing a
  stale size from a live read — deliberately, because an honest one needs a
  stated-at date to travel with the size (recorded at the `config` leg in
  `wallet-balances.ts`), which is a design question this section owns.

**Why this belongs here rather than only in #647.** Each of the three produces a
value that a source comparison either cannot see — SP500's *size* has no source
to compare against, which is the same fact that makes it unbackfillable
([`technical/markets-asset-pricing-ingest.md`](../technical/markets-asset-pricing-ingest.md) §8) —
or would misread as a genuine observation, since `indexed: 0` is a true
statement about an indexer that never ran. The design consequence is exactly the
one [`technical/regime-engine.md`](../technical/regime-engine.md) §11.2 draws for
`unexplained_absent`: **what a detector consumes must carry
whether the value was computable, not just what the value was.** An `ok: true`
that means "we did not even try" is indistinguishable from a real read at every
layer above it, and no amount of comparing numbers to sources recovers the
difference.


---
