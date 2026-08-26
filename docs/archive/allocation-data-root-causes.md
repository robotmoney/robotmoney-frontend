# Temporary: `/allocation` missing-data investigation

Investigation date: 2026-07-16 UTC  
Environment checked: `https://robotmonet.net/allocation` (`RM_ENV=smoke`)

## Revised finding

Three visible symptoms are present and they come from two failing live-chain
feeds:

1. The hero says `Partial total: one feed (wallet or vault) has not resolved`.
   The wallet half is present, but the vault half is null.
2. The Vault TVL table renders the `MORPHO`, `AAVE`, and `COMPOUND` row labels,
   while Balance, Price, and Value are all `—`.
3. The three Wallet Holdings (Sleeves) tables render their asset labels, while
   every Balance, Price, and Value is `—`.

The aggregate Agent Wallet table immediately above the sleeve tables is a
different, persisted feed. It currently renders eight positions and a total.
This distinction matters: the page's persisted wallet pipeline is healthy,
while both request-time Base RPC pipelines are degraded.

There is no evidence of a frontend binding failure. The UI faithfully renders
null values returned by the two degraded APIs.

## Rendered surfaces and dependencies

| Surface | Data dependency | Live observation |
|---|---|---|
| Hero Total AUM | `wallet-balances.totalUsd + vault-economics.tvlUsd` | Wallet value present; vault TVL null; partial warning shown |
| Vault TVL table | `vault-economics.adapters[]` | Three labels present; all numeric values null/`—` |
| Aggregate Agent Wallet | `wallet-balances.holdings[]` | Eight positions render; total was about `$56.4k` |
| Bankr Wallet Holdings sleeve | `wallet-sleeves.wallets[0]` | Five labels present; all numeric values null/`—` |
| Stablecoin Strategy 1 sleeve | `wallet-sleeves.wallets[1]` | `ZYFAI-SS1` label present; numeric values null/`—` |
| Stablecoin Strategy 2 sleeve | `wallet-sleeves.wallets[2]` | `GIZA-SS1` label present; numeric values null/`—` |
| Token Buybacks | `buybacks.rows[]` | Ten persisted rows render |
| Strategy target cards/pies | `allocation.strategy[]` and `buckets[]` | `95/5/0/0` and bucket contents render |

## API results

All endpoints returned HTTP 200, but HTTP success does not mean every feed has
usable data.

### `/api/dashboards/vault-economics`

The response had `source:"live"`, `stale:true`, and null values for `tvlUsd`,
`sharePrice`, `totalShares`, `idleUsdc`, `apy7d`, and every adapter's
`balanceUsd`.

### `/api/dashboards/wallet-sleeves`

The response had `source:"live"`, `stale:true`, three wallet records, and seven
holdings. Every holding had:

```json
{
  "amount": null,
  "priceUsd": null,
  "valueUsd": null,
  "provenance": "stale"
}
```

### `/api/dashboards/wallet-balances`

This separate aggregate endpoint returned eight holdings with values and a
non-null `totalUsd`. It serves the newest rows in `wallet_balance_samples`; it
does not perform Base RPC reads on the page-request path.

## Shared backend failure boundary

```text
                              +-> vault-economics -> several direct eth_call requests
public Base JSON-RPC transport|
                              +-> wallet-sleeves  -> one/two Multicall3 eth_call requests

wallet-balances -> wallet_balance_samples (persisted) -> continues to work
```

### Vault pipeline

```text
allocation.js
  -> GET /api/dashboards/vault-economics
  -> chain/vault-economics.ts::fetchVaultEconomics()
  -> Promise.all(
       vault totalAssets,
       vault totalSupply,
       vault USDC balance,
       Morpho/Aave/Compound totalAssets
     )
  -> on any thrown call, load vault_share_price_history fallback
```

A failure in any one call rejects the entire `Promise.all`. Per-adapter balances
are never persisted. Aggregate TVL/share data can fall back only if the hourly
sampler has successfully populated `vault_share_price_history` for the exact
configured vault address.

### Wallet Holdings (Sleeves) pipeline

```text
allocation.js
  -> GET /api/dashboards/wallet-sleeves
  -> chain/wallet-sleeves.ts::getWalletSleeves()
  -> wallet-valuation.ts::readChainAmountsBatched()
  -> Multicall3 aggregate3 eth_call
```

A reverted sub-call is isolated to one holding, but a transport-level or
JSON-RPC error on the outer Multicall3 request marks every holding stale. There
is no persisted per-wallet fallback because `wallet_balance_samples` is keyed
only by symbol and has no wallet dimension.

## Root causes, ranked

1. **Confirmed shared chain-data trigger: Base public RPC reports rate limiting as a
   successful HTTP 200 containing JSON-RPC error code `-32016` and message
   `over rate limit`.** This was reproduced directly while checking the same
   configured RPC and contracts.

2. **The transport retries HTTP 429 but does not retry JSON-RPC `-32016`.**
   `rpcRequest()` currently treats every JSON-RPC error as immediately fatal.
   The provider's actual rate-limit representation therefore bypasses the
   existing retry/backoff logic.

3. **Confirmed independent price-data trigger: GeckoTerminal is returning HTTP
   429 for WETH/ETH, ROBOTMONEY, and BNKR.** After hardening the Base transport
   in the adhoc worktree, chain amounts recovered, but these Bankr rows still
   degraded because their price fetches were throttled. The response included
   `Retry-After: 0` and remained throttled through bounded retries, indicating
   an exhausted shared keyless quota rather than a one-request blip.

4. **The sleeve request duplicates work already performed by the sampler.** The
   worker fetches and persists per-symbol prices every minute, but
   `/wallet-sleeves` independently calls GeckoTerminal again because it only
   uses persisted samples for the aggregate endpoint. The database cannot
   recover per-wallet amounts, but it can safely provide the latest per-symbol
   prices and avoid request-time price-provider pressure.

5. **Vault failure amplification.** The vault reader's all-or-nothing
   `Promise.all` means one rate-limited adapter removes otherwise successful
   vault totals and every adapter value.

6. **No usable vault fallback.** The all-null degraded response indicates no
   matching persisted share-price sample was available. Possible reasons are a
   failing/absent worker, failed `vault.sample_share_price` runs, an empty table,
   or a runtime `VAULT_ADDRESS` mismatch between producer and reader.

7. **No sleeve amount fallback by design.** A failed Multicall3 outer request empties
   all sleeve numbers because no persisted per-wallet sample exists.

8. **Configuration remains a secondary possibility.** A wrong `BASE_RPC_URL`,
   vault/token/adapter address, or incompatible contract can produce a similar
   degraded response, but it does not explain the reproduced `-32016` as well
   as the retry gap does.

## Debugging direction

1. Add bounded retry for provider-declared transient JSON-RPC rate-limit errors
   (at least code `-32016`) while preserving immediate failure for contract
   reverts and other hard JSON-RPC errors. **Implemented and covered in the
   adhoc worktree.**
2. Add transport tests for transient-then-success and exhausted `-32016`
   responses, plus a negative control proving `execution reverted` is not
   retried. **Implemented; passing.**
3. Deduplicate/cache same-address GeckoTerminal reads and bound transient HTTP
   429 retries. **Implemented experimentally; tests pass, but the live provider
   remains persistently quota-limited from this deployment/IP.**
4. Change wallet sleeves to reuse the latest persisted per-symbol price while
   continuing to read per-wallet amounts from chain. **Implemented**:
   `chain/wallet-valuation.ts::persistedFallbackWalletPriceReader` tries the
   live provider first, then falls back to the newest `wallet_balance_samples`
   row for that symbol when it is ≤5 minutes old (`MAX_PERSISTED_PRICE_AGE_MS`);
   the chain amount is always the fresh read, only the price falls back, and
   provenance is honestly `stale` (never relabelled `live`). Wired as
   `wallet-sleeves.ts`'s default `priceReader`. Covered by
   `tests/api/dashboards-live.test.ts` (fresh fallback, over-age exclusion,
   and no-sample exhaustion cases).
5. Independently inspect `vault.sample_share_price` job runs and
   `vault_share_price_history`. **Verified**: there is exactly one producer
   (`worker/handlers/vault.ts::sampleSharePrice`) and one schedule
   (`job_schedules` row `vault.sample_share_price`, hourly at minute zero,
   `db/seed.ts`). **Repaired**: `config.vault.address` was not normalized —
   an operator-supplied `VAULT_ADDRESS` could write/read under different
   casing than the compiled-in default, silently missing the fallback row.
   `config.vault.address` is now lowercased at load (`config.ts`), and every
   persisted-sample read additionally matches on `lower(vault_address)` to
   recognize any legacy mixed-case row (`chain/vault-economics.ts`).
6. Consider isolating vault calls or using Multicall3 so a single adapter
   failure cannot erase successful core vault values. **Implemented**: core
   and adapter reads are now settled independently
   (`Promise.allSettled`) in `fetchVaultEconomics`, and the default
   `VaultAdapterReader` isolates each adapter's `eth_call` the same way — a
   failed/reverted adapter degrades only that adapter's `balanceUsd` to
   `null`; live core totals and unrelated adapter values are preserved. The
   vault-wide aggregate persisted-sample fallback still applies, but only when
   the CORE read itself fails. Covered by `tests/vault-economics.test.ts`.

## Adhoc debugging status

Worktree/branch:

```text
/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260716-allocation-live-data-debug
adhoc/20260716-allocation-live-data-debug
```

Changes currently in the adhoc worktree:

- Base transport recognizes JSON-RPC `-32016` as transient and applies the
  existing bounded retry/backoff policy.
- Contract reverts and other hard JSON-RPC errors remain immediately fatal.
- GeckoTerminal price requests have bounded retry, same-address in-flight
  deduplication, short-lived caching, and serialized unique requests.
- Focused transport and price-resilience tests pass, as do the dashboard live
  DTO tests and TypeScript checking.

Live probing after these changes showed the Base chain reads recovering. It
also proved that GeckoTerminal's persistent HTTP 429 is a separate remaining
cause for the priced Bankr holdings. No production deployment has been changed.

## CI evidence: PR #174, e2e run 29508089249 (2026-07-16)

The required `e2e` job's "Full-stack smoke (smoke readiness gate)" step failed
after `scripts/smoke-live-smoke.ts` polled for its full `LIVE_SMOKE_DEADLINE_MS`
(240s) budget without reaching a clean LIVE steady state. This was investigated
to distinguish a regression in this PR's degrade path from a pre-existing
external-provider limitation (already documented above as "persistently
quota-limited from this deployment/IP").

Findings from the full job log
(`gh api repos/robotmoney/robotmoney-frontend/actions/jobs/87654037048/logs`):

- The poll trace shows the failing-check count fluctuating (5 → 4 → 2 → 1 →
  **6**) over the 240s window, bottoming out at a single outstanding check
  around the 130s mark before a fresh wave of `429`s pushed it back up to 6
  in the last ~60s. This is the signature of retries succeeding
  intermittently against a provider whose quota keeps re-triggering, not a
  code path that never recovers.
- Every failure at teardown was a **caught, logged degrade**, matching this
  PR's own new code paths exactly:
  - `worker-analytics-1 | wallet-balances: BNKR live read failed, degrading
    to last-persisted sample` — the persisted-fallback path added in
    `695bd22` (`chain/wallet-valuation.ts`), returning `{ok:false}` from
    `valueLeg()` rather than throwing uncaught (verified against
    `backend/src/chain/wallet-valuation.ts:333-354`).
  - `api-1 | vault-economics: adapter Aave read failed, degrading only that
    adapter` — the `Promise.allSettled` isolation added in `695bd22`
    (`chain/vault-economics.ts`).
  - `error: Base RPC HTTP 429` / `error: 429 Too Many Requests for
    api.geckoterminal.com` — the retry-then-throw contract in
    `base-rpc-client.ts::rpcRequest` and `token-prices.ts::
    fetchGeckoTokenPriceUsdUncached`, both added/hardened in `c5f86f7`,
    behaving exactly as documented: retries mask a transient blip, then
    throw so the caller degrades honestly. No unhandled rejection or
    container crash appears anywhere in the log.
- `smoke-live-smoke.ts` itself is working as designed (issue #128/#163): it
  requires `wallet-balances.source==='live'` and `vault-economics.stale===
  false` (see `evaluateWallet`/`evaluateVaultEconomics` in
  `scripts/smoke-live-smoke.ts`), treating any other outcome — including an
  honestly-degraded `stale` leg outside the documented `#120` allowlist — as
  a named, loud CI failure. The workflow's own header comment in
  `.github/workflows/e2e.yml` calls this out explicitly: "a genuinely-
  unreachable external provider after real retries is a legitimate external
  blocker, not a bug in this workflow — file it, don't silently skip the
  assertion." That is a deliberate, owner-approved architecture decision
  (issue #163), not a misclassification this PR should relax. Weakening the
  gate to accept `stale` provenance as success would hide the exact class of
  regression #128 exists to catch (a dead/blocked feed silently going stale
  on a LIVE boot).

**Conclusion**: this is the known, already-documented pre-existing
GeckoTerminal/Base-RPC quota exhaustion for this CI deployment/IP (see
"Root causes, ranked" #3 above), not a regression introduced by this PR —
the PR's own retry/backoff and fallback code is smokenstrably active and
correctly classified as caught degrade, not a crash. Consistent with this
repo's prior 429-flake precedent, the correct remedy is re-running the `e2e`
job for a fresh attempt against the live upstreams, not changing
`smoke-live-smoke.ts`'s pass/fail semantics.
