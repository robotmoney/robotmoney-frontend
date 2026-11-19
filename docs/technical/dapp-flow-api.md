# Deposit flow API

The flow indexer scans the configured Base fund and queue from the earliest
contract deployment block. It uses confirmed blocks and records block hashes,
transaction logs, and checkpoints through the existing pipeline API. A run reads a
window of up to 2,000 confirmed blocks in about five RPC calls: the window's
tip hash before and after its `eth_getLogs`, and one header batch for the
blocks that carry logs. Only those blocks and each window's tip are stored as
checkpoints. A reorg
marks orphaned blocks and logs noncanonical before replay. The worker does not
hold a database credential.

Configure `FLOW_QUEUE_ADDRESS` and `FLOW_FUND_ADDRESS` for the API and worker.
Optional `FLOW_EXPLORER_ADDRESSES` is a comma-separated list of additional
legacy explorer contracts; automatic registry discovery and legacy projections
are not yet implemented. The worker discovers the first block containing code at any configured address and
stores those floors using the existing address-floor cache. An optional
`FLOW_INDEX_DEPLOY_BLOCK` overrides the earliest block; an operator supplying
it must ensure it is no later than any configured deployment. The `flow.index` job is
seeded disabled and must be enabled after deployment configuration is installed.
The analytics worker claims `flow.%` jobs in a second drain loop of its own
(lane `flow`), so a long wallet backfill on its main loop never starves the
per-minute index.
The index is bound to the complete configured set; changing it requires a
deliberate reindex and is refused by the worker. A configured job with missing
or invalid addresses fails rather than claiming it indexed anything.

Public GET routes under `/api/public/flow/`:

- `health`: the indexed block, hash and time, `ageSeconds` since that block and
  `status`. `status` is `ok`, or `stale` once the block is older than
  `maxAgeSeconds` (300). It answers 503 with `status: "unavailable"` while the
  index is unconfigured, bound to other contracts or empty.
- `vault`: fund NAV, supply, caps, current holdings and target weights, queue
  liveness, epoch timing and a non-binding share price. NAV has its own
  `navObservedAt`; cap room is explicitly relative to that last good NAV.
- `owners/{address}`: paginated request-creation events for an owner.
- `owners/{address}/claims`: paginated owner-level `SharesDelivered`,
  `RedeemClaimed`, `CreditAdded`, `CreditWithdrawn` and `WindDownReleased`
  events in chain order. The queue emits claims per owner, not per request.
- `owners/{address}/position`: wallet, queued and ledger shares, credits and
  currently claimable quantities.
- `requests/{id}`: contract request status, pending and claimable quantities,
  snapshotted terms and the original epoch's cutoff.
- `requests/{id}/history`: paginated request-specific emitted events. Its
  `attribution` is `request-events-only`: lazy matched allocations and
  owner-level FIFO claims are not yet attributed to individual requests.
- `prices`: paginated settlement price events and their block times. A price is
  the contract's raw USDC/share ratio scaled by `priceScale` (10^36).
- `events`: paginated canonical queue and fund logs, including raw topics and
  data for events without a decoder.
- `transactions`: unsigned request, cancel, expiry, notice and claim calls.
  Pass `action`, `owner` and, where needed, `amount` or `requestId`; optional
  `sender` defaults to `owner`. Deposit and redemption requests include a
  token approval only when the sender's indexed-block allowance is too small.
  Claims consume the owner's oldest eligible claims, not necessarily the
  request named in the URL. The response reports that FIFO scope explicitly.

Amounts are decimal strings in base units. Request `amountUnit` identifies USDC
or share base units; owner position field names identify the unit. Every data
response names the indexed block, hash and time. Contract views used for vault,
position, request and transaction terms are read at that block and checked
against its canonical hash; they are not a guarantee about a future transaction.
An unavailable index, changed chain or failed contract view returns 503 rather
than invented state. List cursors use `afterBlock` and `afterLogIndex`.

## Smoke and CI

The v0.9 queue and fund are not on Base mainnet yet. A local `bun smoke` boot
that is neither the standing stack nor `RM_ENV=prod` therefore indexes the
live deploy-2 gateway and rmUSD vault as stand-ins, from 60 blocks below the
head the boot read (`scripts/lib/smoke-env.ts`). The public `mainnet.base.org` answers every
`eth_getLogs` with 429, so the stand-in scans through `FLOW_RPC_URL`
(`https://base-rpc.publicnode.com`) unless `BASE_RPC_URL` or `FLOW_RPC_URL` is
exported. `FLOW_RPC_URL` is optional everywhere; unset, the indexer uses
`BASE_RPC_URL`. The smoke seed enables the
`flow.index` schedule. The live-smoke check (`bun --no-env-file
scripts/smoke-ci-checks.ts --check live-smoke`, run by `e2e-swarm`) fails unless
`health` answers 200 with `status: "ok"`. The stand-ins exercise the deployed
scan, the migrated tables and the health route on the real chain, but not the
queue views. An exported `FLOW_QUEUE_ADDRESS` replaces the stand-ins, and a
standing or prod boot indexes only the addresses its operator exports.
