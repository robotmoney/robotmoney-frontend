# Referral specification

**Status: PROPOSED — initial specification, not accepted and not shipped.**
The requirements below are concrete recommendations for owner review. “Must”
describes the proposed implementation contract; it does not record approval.
Acceptance requires the decisions in §11 to be resolved and an accepted document
revision recorded in the implementation issue. Existing architecture and accepted
decisions retain authority until then. This document defines durable behavior;
[specification #1358](https://github.com/robotmoney/robotmoney-frontend/issues/1358)
and [implementation #1371](https://github.com/robotmoney/robotmoney-frontend/issues/1371)
own execution status.

## 1. Goals, meaning and boundaries

A depositor can identify the member or team channel that referred them, attach
that choice to a deposit they authorize. Administrators can inspect code state.
Operators can reproduce a historical report and, on request, explain any one
wallet's or transaction's result from verifiable evidence. No self-serve
attribution view exists for depositors or members.

**Attribution** means associating one wallet with one referral code. It creates
no payment, fee rebate, reward entitlement or promise of yield. There is no
qualified-capital or commission metric in this release. Optional position totals
are descriptive holdings and must carry that label. They include transferred-in
shares and subsequent deposits and decrease on withdrawal; those movements do
not prove referred capital and do not change an existing binding.

The owner accepted attribution-only for this repository on 2026-10-16. A fee
or payout, if one is ever introduced, lives outside `robotmoney-frontend` and
consumes the attribution report as its input. No fee, payout or reward logic
belongs in this repository's referral specification or code.

Proposed scope is Base mainnet, chain ID 8453, with explicit historical vault
coverage. Attribution identity is the depositing wallet address, not a natural
person or an account across wallets. Members and team channels may receive
codes. A **team channel** is a named source the Robot Money team uses to track
where depositors come from, such as `site`. It is a short name in the registry,
not a swarm member, table or identity, and it accepts no terms. There is no
self-referral check: a member's own wallet may use that member's code, and no
list of member-controlled wallets is kept (owner, 2026-10-16).

Referrals must work for deposits through the router as well as direct vault
deposits. The signer has no effect: an EOA, a Safe or other multisig, a smart
account, a delegated EOA, a hardware wallet or any wallet vendor gets the same
attribution for the same deposit (owner, 2026-10-16). How the chosen code is
carried on chain is decided by `robotmoney-core` (§3), not by this repository.

This repository proposes no contract changes, payouts, public attribution
leaderboard, editable admin code registry, automatic discretionary credit,
cross-chain identity, or database migration. A CLI report reconstructs evidence; public API requests
must not trigger chain scans. If correctness requires a new persistence or
contract boundary, amend this specification before implementing that expansion.

## 2. Eligibility and event ordering

A **qualifying deposit** is a successful, positive-asset deposit in the coverage
manifest whose execution proves the wallet authorized the deposit and funded
assets for its own shares. Receiver and proven payer must be that wallet. An
approval or a transfer somewhere in a receipt is insufficient: the amount, token,
vault, executed call and Deposit event must correspond. A router deposit
qualifies the same way: the wallet funds the router and receives the shares of
every leg. One router deposit is one deposit authorization, whatever the number
of legs. The router's `depositFor` with a receiver other than the payer is a
gift to the receiver. The payer and receiver are the addresses that executed and
received the deposit, whatever signer or wallet stands behind them.
Zero-asset calls, gifted deposits, share transfers and failed transactions do not
start the clock. There is no other minimum amount in the proposed policy.

The first qualifying deposit across **all** manifest deployments starts a
30 × 24-hour window, using its block timestamp. A qualifying coded deposit is
eligible at `firstDepositTime <= time < firstDepositTime + 2592000 seconds` and
only at or after the configured launch block and while its code is active.
Exactly the expiry timestamp is late. An uncoded qualifying deposit starts the
clock. A gift 31 days earlier does not. All deposits, including uncoded ones,
need enough execution evidence to distinguish these cases.

Pre-launch and legacy qualifying deposits count when finding the first deposit;
launch and migration never reset the clock. A legacy holder whose first deposit
was more than 30 days before launch is ineligible. A legacy holder still within
the window can choose a code on a qualifying post-launch deposit. Incomplete
legacy coverage blocks a final eligibility decision; moving to a new vault is
not evidence of being a new depositor.

The earliest valid attribution wins across covered vaults and later deposits.
Order chain candidates by `(blockNumber, transactionIndex, logIndex)`; repeated
legs of the same deposit authorization cannot yield competing choices. Evaluate
code activity at execution block time, not lookup or signing time. A later code
never replaces an existing valid binding. Withdrawal, member departure, code
disabling and wallet inactivity do not remove the binding.

Missing earlier history blocks a final binding even if a later candidate is
fully readable. Unknown or undecodable evidence cannot be silently skipped to
award the next code. Reports may show a tentative candidate, clearly marked as
such, while withholding a final binding.

## 3. Consent, supported paths and the on-chain carrier

Attribution covers direct vault deposits and router deposits. It is independent
of the signer: Safe and other multisigs, ERC-4337 accounts, EIP-7702 delegated
EOAs, hardware wallets and wallet vendors are not separate cases and are not
unsupported. No path is excluded because of who or what signed it.

**The carrier belongs to `robotmoney-core`.** How a depositor's chosen code is
recorded on chain for a specific deposit is a core decision. Core has not
decided it, and this specification does not choose among implementations.
This repository consumes core's documented carrier once it ships. Until then,
the report's decoding of a code from chain evidence is unspecified, and launch
is blocked on it (§10). The earlier PRs' trailing-calldata envelope (ERC-8021
style) is reference material only; it is not pinned here.

This repository relies on the carrier for these properties, and §2, §7 and §9
assume them:

- It binds one code to one specific deposit authorization, so codes in one
  transaction cannot leak between depositors. Bundled deposits stay separable.
- It is readable from chain evidence for that deposit, alongside the payer, the
  receiver, the vault or router, and the amount.
- It records the code exactly as the depositor chose it, so this repository
  never repairs or substitutes a code.

If core's carrier lacks one of these properties, amend this specification
before implementing.

**Code format belongs to this repository.** The public lookup, the skill and
the report share one normalizer. Normalize user input by trimming surrounding
whitespace and lowercasing ASCII. Require `^rm_[a-z0-9]+(?:-[a-z0-9]+)*$`, at
most 32 ASCII characters total. Interior whitespace and non-ASCII characters
are invalid, never removed. A carrier value that does not normalize to itself
is `invalid_code`. No owner-requested code may be silently changed to another
code by normalization or parser recovery.

## 4. Manual claims and corrections

**Manual attribution and discretionary overrides are excluded from the initial
release.** Do not load or evaluate the earlier PR's manual-credit config entries.
An arbitrary message/signature or reviewer assertion cannot create a binding.
The consequences are explicit: a deposit made without the code in core's carrier
does not receive manual backfill; operators explain the limitation to the
depositor.

A future manual-claim extension must define an exact signed domain and payload
including chain, wallet, code, deposit transaction/event, expiry and nonce; EOA
and smart-wallet verification; replay protection; who verifies and publishes
proof; and chronological ordering with chain evidence. It must define when a
claim becomes effective and exclude it from earlier report cutoffs. No such
extension is authorized by this document.

Corrections repair invalid evidence or implementation errors, not depositor
choice. Preserve the original report and publish a separately identified
superseding report with reason, changed rows, rule/config revisions and owner
approval. A previously *valid* binding cannot be reassigned as a correction.
If invalid evidence is removed, recompute from complete history and explain any
changed attribution. Reports are never edited in place to hide this history.

## 5. Code registry and lifecycle

Codes are versioned, reviewed backend configuration, not bearer secrets. An
operator issues a code by a reviewed change to that configuration, and the code
reaches production only in a release. Each record contains normalized code,
immutable beneficiary kind and ID (a member ID, or a team channel name),
display snapshot, terms version, activation time,
and disabling time. Times are ISO 8601 UTC strings, compared as Unix seconds
against block timestamps. One global launch block and the deployment manifest
are versioned alongside the rules. No environment variable grants
attribution or changes policy silently.

States at timestamp `t` are `draft` (no activation), `scheduled` (activation is
future), `active` (`enabledAt <= t` and no disable or `t < disabledAt`), and
`disabled` (`disabledAt <= t`). A member code needs a terms version before activation; the reviewed change that
records it is the evidence of acceptance. A team channel code has no terms
version.
Code strings are globally unique and never reassigned, including after deletion
of a beneficiary. Activation intervals are half-open and may not overlap for
the same beneficiary; a replacement may start exactly when the old one stops.

A draft may acquire its first prospective activation time through review.
Scheduled records may be cancelled before activation with retained history.
Once active, identity, terms and activation are immutable; disabling must be
prospective when approved. Rejoining uses a new code and accepted terms. Registry
validation compares against the previous accepted revision, which is the
registry at the last production version tag (production runs only by rc tags,
[D64](../decisions.md#d64--stage-runs-a-release-branch-commit-once-it-passes-the-rc-tag-is-cut-there-and-production-runs-only-by-that-rc-tag-refines-policy-3-and-d61-owner-2026-10-10), [D70](../decisions.md#d70)), rejecting deleted
history, reassignment, retroactive interval edits and overlapping intervals.
Time passing between approval and deployment must not make a purportedly
prospective change retroactive: activation requires a deployed revision before
its effective time, or it must be rescheduled through review.

Members are never deleted at runtime: no runtime role holds `DELETE`
([D55 decision 6](../decisions.md#d55)), so a departing member is deactivated.
Member departure requires prospective disabling of the code before or with
deactivation. A deactivated member's code is unavailable publicly. A missing
member row can only result from a manual `rm_owner` run; an active code whose
member row is missing is unavailable publicly and generates an operational
integrity error. Existing historical bindings retain beneficiary ID and
historical display snapshot; deactivation or removal of a member does not erase
attribution history. Admin projection selects the code active **now**;
if none, select the nearest scheduled activation, else most recently disabled,
else draft, with code lexical order breaking otherwise equal ties. Expose state
and timestamps so a future code cannot masquerade as the current active code.

## 6. Public, admin and deposit contracts

Proposed public route: `GET /api/referrals/codes/:code`, unauthenticated. The
shared normalizer above applies. Exact success bodies are:

```json
{ "code": "rm_alice", "member": { "handle": "alice", "name": "Alice" } }
```

```json
{ "code": "rm_team", "channel": "team" }
```

Unknown, malformed, draft, scheduled, disabled, deactivated-member and
missing-member codes return 404 with identical `{ "error": "not found" }`
bodies. No list, prefix search or wildcard route exists. 200 and 404 use
`Cache-Control: public, max-age=60`; responses must not depend on cookies or
authorization. Per trusted client IP, allow 100 requests per 60-second window,
then 429 `{ "error": "rate limit exceeded" }` with integer `Retry-After` seconds and
`Cache-Control: no-store`. The window is the existing sliding-window
`createRateLimiter` (`backend/src/api/rate-limit.ts`) with its own instance for
this route: per process, in memory, `Retry-After` until the oldest request in
the window ages out. It matches the public analytics routes' 100-per-minute
precedent (`backend/src/api/routes/public-analytics.ts`). Use the existing
trusted-proxy/IP boundary (`backend/src/api/client-ip.ts`); clients cannot
select their identity through arbitrary forwarding headers. Dependency failures
return 503 `{ "error": "service unavailable" }`, `Cache-Control: no-store`.
These bodies use the API's existing `{ "error": "<string>" }` envelope
(`backend/src/api/index.ts`) and the same strings as the public analytics
routes.

The lookup identifies a currently active code. It says nothing about wallet
eligibility, launch status, supported execution, future activity, or earned
credit. The 60-second cache delays both directions: a cached success can
outlive disabling, and a cached 404 can hide a newly activated code, each by up
to 60 seconds. Codes and member
identity may be discoverable through predictable strings, calldata and public
lookup. No bulk listing and uniform misses do **not** promise secrecy or prevent
enumeration. Use synthetic codes in goldens; do not publish private report data
in public API responses.

Admin member DTO adds `referral: null | { code, state, enabled, termsVersion,
enabledAt, disabledAt }`, with `enabled` exactly `state === "active"`. The admin
member page displays the code, state, terms and dates, and explains that it is
read-only. Public swarm member DTOs remain free of referral fields. Registry
history remains operator configuration, not a new public/admin write API.

The deposit skill takes a code only from the wallet owner's explicit request;
it cannot invent, infer from a page, or substitute a referral. The preview names
the normalized code and beneficiary and says “code will be recorded; attribution
is evaluated after execution.” It never promises a reward or successful credit.
A requested referral is a condition of proceeding: an invalid code, a lookup
failure, or a transaction that would not carry the code through core's carrier
stops before submission and explains the cause. `confirm` off does not permit
omission. The owner may explicitly authorize proceeding without the code in a
new instruction. An ordinary deposit with no requested code continues normally.
The skill offers referrals the same way for every signer it supports, direct or
through the router.

Recheck code state immediately before signing/submission; a delay can still
cause expiry. A multisig waiting for signatures can execute after a code is
disabled; the preview says so. Once signed or submitted, do not rewrite the
transaction. A later disable makes the referral ineligible at execution and must
be reported honestly; funds can still deposit successfully. The result
distinguishes transaction success, the observed recorded code, pending
evidence, and finalized attribution.

## 7. Reporting, completeness and operations

The versioned manifest lists chain, asset, every covered vault/router address,
ABI/bytecode version, deployment/start/end blocks, and legacy relationships.
Historical entries survive replacement of current vault addresses. The legacy
entry is the v0 rmUSDC vault in `config.vault` (`backend/src/config.ts`), read
as ERC-4626 ([vault-and-wallet §10](../architecture/vault-and-wallet.md)).
The closed reporting PR (1386) started its scan at deployment 2's first block
and skipped v0; this specification counts v0 history.
The candidate current entries are core's deployment 2 on Base: the router plus
rmUSDC, rmPROTO, rmAGENT and rmRWA, as listed in #1356. Resolve v0 and
four-vault coverage against actual deployments before launch; #1356 and #1090
are integration references, not proof those dependencies are delivered.

A report uses a single recorded finalized block number **and hash** for both
attribution and optional valuation. Resolve the RPC `finalized` head once; an
explicit cutoff must be at or before it and canonical. Do not equate 32-block
depth with finality. If the provider cannot establish finality, canonicality or
historical state, the report is incomplete. Non-finalized diagnostics must be
separately labeled and cannot be exported as final attribution.

Scan all manifest history through that cutoff. Fetch required transaction,
receipt and block evidence through the shared RPC transport and rate budget.
Historical state reads use the transport's `blockTag` option and its one shared
token bucket, with no second limiter; a block-addressed `success: true` with
`returnData: "0x"` is a failure, never a zero ([D36](../decisions.md#d36--a-block-tag-on-the-reads-we-already-issue-not-the-archive-indexer-d16-rejected-issue-709-clarifies-d16-reverses-open-question-9)).
Deduplicate by `(chainId, transactionHash, logIndex)`, verify receipt success,
block consistency and event identity, then apply deterministic ordering. Pin
all balance and conversion calls to the recorded block and verify its hash
before and after collection. Archive-state failures mean unavailable valuation,
never zero. A reorg or changed hash invalidates publication and requires a new
scan; preserve the invalidated artifact with its explanation.

Null input, missing receipt, truncated log ranges, unavailable historical
manifest data, unknown call execution or inconsistent results are **unknown**,
never “no referral”. Retry through bounded transport policy. Exhaustion records
the affected range/wallet and marks the report incomplete; if the affected
wallets cannot be determined, all bindings are provisional. Unrelated fully
proven rows may remain visible but the overall export cannot claim completeness.
Separate attribution completeness from valuation completeness and require both
for a combined complete report.

Each JSON report records chain ID, cutoff number/hash/timestamp, finalized-head
reference, launch block, coverage manifest digest, exact config and rules Git
revisions, registry digest, evidence digest, per-range coverage, completeness,
errors, and run time. Rows carry wallet, beneficiary/code or null, first
qualifying deposit, chosen event identity, binding status, candidate outcomes
and reasons. Reasons include `bound`, `already_bound`, `uncoded`, `late`,
`before_launch`, `code_inactive`, `gift`, `invalid_code`, and
`evidence_unavailable`. Observations can be known
while final eligibility remains unknown; do not collapse those dimensions.
CSV exports carry a manifest identifier and accompanying JSON provenance file.
Optional holdings read each vault's `balanceOf` and then `convertToAssets` at
the pinned block, as raw integer quantities with explicit decimals; rounded
presentation is not an attribution input. The report has a per-wallet and a
per-transaction explain mode, which is how an operator answers a depositor's or
member's question.

For the same cutoff/hash, manifest, evidence, registry and rules, attribution and
valuation payloads must match byte-for-byte after canonical serialization.
Canonical serialization and every digest reuse the repository's existing
helpers, `canonicalStringify` (recursively sorted object keys) and `sha256Hex`
(`backend/src/analytics/run-ledger.ts`); the report builder sorts arrays into
the deterministic order above before serializing. Exclude run time and
diagnostics timing from that digest. Later withdrawals or
new deposits cannot change the historical payload. A different config revision
is a different report input, never an invisible update to the original.

The report is a committed script run by an agent from the control machine over
SSH, never typed by hand on a host, and it writes a receipt
([D61](../decisions.md#d61)). Its scan checkpoints are local files of the CLI
run, not a persisted chain-event store or database table; D36 keeps rejecting
an archive indexer.

Operator procedure: select accepted revisions and manifest; resolve finalized
cutoff; scan with bounded ranges and checkpoint by hash/revision; retry incomplete
ranges; verify coverage/canonicality; produce provisional diagnostics or complete
export; archive provenance/evidence and restrict report access to authorized
operators. Do not log private keys or wallet authorization secrets. Full wallet
reports are private operational artifacts, not preview assets or public goldens.

Performance acceptance uses a manifest-complete launch-range scan with recorded
RPC count, elapsed time, peak memory and provider budget, plus an interrupted
scan resumed without rescanning completed canonical ranges or duplicating rows.
The operator must approve an explicit run-time/RPC budget based on that measured
range before launch. Hitting a limit must stop with an incomplete artifact and
resumable checkpoint, never silently shorten history.

## 8. Integration points and architecture boundaries

| Surface | Proposed change and existing boundary |
|---|---|
| `backend/src/config.ts` | Versioned registry, launch and historical manifest; validation compares prior accepted history. Existing configuration delivery remains authoritative. |
| `backend/src/chain/base-rpc-client.ts` | Transaction/receipt/finalized-block reads and pinned historical calls through the existing transport, retries and shared budget. No second RPC client or external chain SDK implied. |
| `backend/src/referrals/` and report CLI | Pure code-format/lifecycle/attribution rules, a decoder for core's carrier once it ships, an evidence collector and reproducible private exports; paths are proposed new implementation touchpoints. |
| `robotmoney-core` | Owns the on-chain carrier for a deposit's code, for direct and router deposits and every signer (§3). This repository consumes it and changes no contract. |
| Backend routes and registered queries | One-code lookup; member identity reads use the registered query boundary. No chain scans on request paths. Rate limiting reuses `backend/src/api/rate-limit.ts` and `client-ip.ts`. |
| `backend/src/analytics/run-ledger.ts` | Existing `canonicalStringify` and `sha256Hex` serve the report's canonical payloads and digests; no new canonical-JSON helper. |
| `contract/` | Route catalogue, public DTO and admin DTO. Contract sync produces frontend artifacts during implementation, not this docs PR. |
| `frontend/public/skill.md` and deposit flow | Owner-authorized referral choice, stop behavior, previews and results for direct and router deposits and every supported signer; integrate with the eventual deposit skill path from #1090. |
| `frontend/public/views/admin/swarm-member.html` and its controller | Read-only referral projection with state and timestamps, following the established admin auth and buildless frontend. |
| Agent catalogue and goldens | Document the callable lookup and use fixture-only code identities; keep public/private shapes distinct. |
| Existing Postgres schema | Member identity remains in `swarm_members`; no referral table, grant or migration proposed. Derived reports are not a new request-path index. |

The current architecture's API credential ownership, registered-query policy,
buildless frontend, contract boundary and dashboard indexing behavior remain in
force. The private operator scan does not authorize adding live chain reads to
existing dashboard handlers. A future hosted report API would need a separate
persistence, authorization and retention design.

## 9. Adversarial acceptance matrix

These are implementation acceptance requirements, not tests executed by this
documentation change. Fixtures must include full transaction/receipt/block and
registry inputs and expected explanations, not just isolated parser outputs.

| Case | Required outcome and evidence |
|---|---|
| Alice coded, Bob uncoded in one bundle | Alice binds to her code; Bob stays uncoded. The carrier ties each code to its own deposit; Alice's code is never copied to Bob. |
| Code bytes elsewhere in the transaction; conflicting codes for one deposit | Only core's carrier for that deposit counts. Conflicting codes for one deposit yield no final award, with an explained reason. |
| Same coded router deposit from an EOA, a Safe, a 4337 account and a 7702 EOA | Identical attribution outcome in every case; the signer type is not an input. |
| Router deposit across four legs | One deposit authorization; one candidate; legs never compete. |
| Router `depositFor` paid by Bob for Alice | Gift to Alice; does not start her clock or bind Bob's code to her. |
| Gift to Alice; 31 days later her own coded deposit | Gift does not start her clock. Her proven self-funded deposit can bind if all other conditions hold. Include uncoded gift evidence. |
| Uncoded self-funded deposit; coded at +30 days | Clock starts on uncoded deposit; exact boundary is late. +30 days minus one second remains eligible. |
| Arbitrary manual message, `0x00` signature, unrelated hash | No manual input is accepted and no binding exists without supported chain evidence. |
| Earlier manual A, later chain B | Manual records are unsupported and rejected as input; no report can claim A from them. A future extension must settle precedence before use. |
| Missing input/receipt followed by valid code B | Incomplete history, unknown eligibility, B provisional; never “no code” for the missing observation. |
| October cutoff rerun after November withdrawal | Identical holdings and attribution payload at the same October block/hash and pinned revisions; all reads prove the same snapshot. |
| Hash changes; provider lacks finalized or archive reads | Publication blocked or explicit incomplete diagnostics; no fabricated zero and no depth-based finality claim. |
| Draft activation; scheduled disable/replacement; rejoin | Validate prospective history and non-overlap; exact adjacent boundaries allowed; admin selects active code over future replacement. |
| Member deactivated, or row removed by a manual `rm_owner` run, while code active | Public uniform 404; a missing row also raises an operational error; historical binding retains beneficiary snapshot. |
| Lookup timeout with requested code, including confirm off | Stop before submission; explain retry or explicit owner choice to proceed uncoded. |
| Code disabled after lookup/signing | Deposit may execute; execution-time attribution fails as inactive. Preview never guaranteed credit. |
| ` RM_ALICE ` versus `rm_a lice` | First normalizes to `rm_alice`; second fails unchanged. Public, skill and report share fixtures. |
| Active code but late, pre-launch, or already bound | Lookup succeeds; reporting explains actual eligibility independently; existing binding persists. |
| Legacy v0 holder migrates; deployment addresses replaced | First qualifying historical deposit retained; no new clock. Missing legacy coverage blocks final report. |
| Member's own wallet, team channel, transferred shares | A member's own wallet may bind to that member's code; eligible team code works; holdings are descriptive, not qualified capital. |
| Repeated legs, duplicate logs, interrupted scans | Stable deduplication and ordering; no duplicate attribution; checkpoint resumes under identical revisions/hash. |
| Public lookup/admin/public member DTOs | Exact shapes and errors; rate/cache behavior; no bulk route, private wallet list or public member referral field. |

## 10. Rollout and evidence gates

Acceptance of this specification is separate from implementation and launch.
Implementation of the report's code decoding and the skill's code recording is
blocked until `robotmoney-core` documents its carrier. Code lifecycle, the
public lookup and the admin projection do not depend on it. Implementation
requires the accepted revision, full contract and carrier fixtures,
registry history validation, call/event evidence tests, historical report reruns,
public/admin privacy checks and deposit-flow failure coverage. Demonstrate an
actual coded deposit against each intended deployment, direct and through the
router, from an EOA and from a multisig, with preserved inputs/receipt and
owner-authorized funds; offline fixtures alone do not establish contract
compatibility.

Before activation, run a read-only manifest-complete scan, resolve legacy
coverage, approve the measured operator budget, demonstrate incomplete-data and
resume behavior, and reconcile an independently reproduced historical export.
Keep every code draft until owner acceptance of policy and rollout evidence.
Activate prospectively only after backend, contract, skill and admin UI agree.
Disabling new attribution uses prospective registry changes and preserves history;
rollback must retain the decoder/rules needed to reproduce earlier reports.

## 11. Owner decisions and canonical-document review

The product owner accepting #1358 must expressly accept or amend these proposals:

| Decision | Recommendation and consequence |
|---|---|
| Product meaning | **Accepted by the owner, 2026-10-16.** Attribution only in this repository; descriptive holdings confer no reward or qualified-capital claim. Any future fee lives outside this repository and consumes the report. |
| Clock and legacy | 30 days from first self-funded positive deposit, including pre-launch/v0 history; no migration reset. Older existing holders cannot join. |
| Supported launch paths | **Accepted by the owner, 2026-10-16.** Direct and router deposits; the signer and wallet vendor have no effect. |
| Encoding | **Owned by `robotmoney-core`; pending.** This repository waits for core's carrier and pins only the code format (§3). |
| Manual/correction policy | No manual awards or discretionary overrides; evidence corrections preserve supersession history. |
| Identity and lifecycle | Wallet identity, no self-referral check (**accepted by the owner, 2026-10-16**), immutable code ownership and prospective reviewed lifecycle. |
| Experience and disclosure | Requested code blocks submission on failure; codes are discoverable; admin projection includes explicit state. |
| Report authority | One finalized snapshot, complete legacy manifest, pinned revisions, private exports and measured operator budget. |

The implementation owner supplies the exact deployment manifest, verifies the
carrier against core's documentation and the deployed contracts, and proposes
the measured scan budget. These are acceptance/launch inputs, not facts inferred from
the closed PRs. Any policy change returns to owner review before implementation
can claim compliance.

Canonical-document integration is deliberately limited while this is proposed:

| Document | Treatment |
|---|---|
| `docs/architecture/README.md` | Discoverable proposed-spec entry, separate from accepted authorities. |
| `investment-swarm.md` | Link proposed code/identity policy; preserve signed-recommendation roles. |
| `vault-and-wallet.md` | Link consent and snapshot policy; preserve existing dashboard indexing and RPC transport. |
| `backend.md` | Link lookup/operator boundaries; no claim that routes or RPC helpers shipped. |
| `admin-surface.md` | Link proposed read-only code projection and required frontend completion. |
| `configuration-delivery.md` | Link proposed versioned registry; preserve configuration delivery and no implicit new env/grant. |
| `data-model.md` | Link no-new-schema proposal; preserve existing schema as truth. |
| `docs/decisions.md` | No accepted decision added while proposal is unapproved. On acceptance, record policy authority and any explicitly changed boundary. |
| `docs/architecture.md` | Existing redirect to the architecture map remains sufficient. |

## 12. Research references

Closed proposals are reference material, not accepted behavior or merge
prerequisites: [#1370](https://github.com/robotmoney/robotmoney-frontend/pull/1370)
(`bb5f01dc27ea0240a4b13f95eb0eb6e24d6c348b`, encoding/config/rules),
[#1372](https://github.com/robotmoney/robotmoney-frontend/pull/1372)
(`ff29b2af157f8c83e2545550e58b4b97558e43c3`, lookup/admin/RPC),
[#1385](https://github.com/robotmoney/robotmoney-frontend/pull/1385)
(`9b2d3ebc25b0c9b6a1760fa88ebe75aae33e5d4d`, skill), and
[#1386](https://github.com/robotmoney/robotmoney-frontend/pull/1386)
(`6b3a04426762cff2bf1ff5f70c3aafeb07f5cef5`, reporting).
The adversarial examples originated in offline review of those proposals; they
are not evidence of production exploits or implemented functionality.
