# Deposit flow API

The flow indexer scans the configured Base fund and queue from the earliest
contract deployment block. It uses confirmed blocks and records block hashes,
transaction logs, and checkpoints through the existing pipeline API. A reorg
marks orphaned blocks and logs noncanonical before replay. The worker does not
hold a database credential.

Configure `FLOW_QUEUE_ADDRESS` and `FLOW_FUND_ADDRESS` for the API and worker.
The worker discovers the first block containing code at either address and
stores those floors using the existing address-floor cache. An optional
`FLOW_INDEX_DEPLOY_BLOCK` overrides the earliest block; an operator supplying
it must ensure it is no later than either deployment. The `flow.index` job is
seeded disabled and must be enabled after deployment configuration is installed.
The index is bound to one pair of addresses; changing either requires a
deliberate reindex and is refused by the worker. A configured job with missing
or invalid addresses fails rather than claiming it indexed anything.

Public GET routes under `/api/public/flow/`:

- `vault`: fund NAV, supply, caps, current holdings and target weights, queue
  liveness, epoch timing and a non-binding share price. NAV has its own
  `navObservedAt`; cap room is explicitly relative to that last good NAV.
- `owners/{address}`: paginated request-creation events for an owner.
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
