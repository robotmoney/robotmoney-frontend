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
that choice to a deposit they authorize, and obtain an explainable attribution
record reconstructed from verifiable evidence. Administrators can inspect code
state and operators can reproduce a historical report.

**Attribution** means associating one wallet with one referral code. It creates
no payment, fee rebate, reward entitlement or promise of yield. There is no
qualified-capital or commission metric in this release. Optional position totals
are descriptive holdings and must carry that label. They include transferred-in
shares and subsequent deposits and decrease on withdrawal; those movements do
not prove referred capital and do not change an existing binding.

Proposed scope is Base mainnet, chain ID 8453, with explicit historical vault
coverage. Attribution identity is the depositing wallet address, not a natural
person or an account across wallets. Members and approved team channels may
receive codes. Known member-controlled wallets cannot use that member's code;
this is an auditable declared-address check, not a claim to detect common control
or prevent Sybil behavior. Team channels follow the same declared-control rule.

No contract changes, payouts, public attribution leaderboard, editable admin
code registry, automatic discretionary credit, cross-chain identity, or database
migration is proposed. A CLI report reconstructs evidence; public API requests
must not trigger chain scans. If correctness requires a new persistence or
contract boundary, amend this specification before implementing that expansion.

## 2. Eligibility and event ordering

A **qualifying deposit** is a successful, positive-asset deposit in the coverage
manifest whose execution proves the wallet authorized the deposit and funded
assets for its own shares. Receiver and proven payer must be that wallet. An
approval or a transfer somewhere in a receipt is insufficient: the amount, token,
vault, executed call and Deposit event must correspond. A supported router may
mediate the transfer only when its exact behavior and event mapping are proven.
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
fully readable. Unknown and unsupported evidence cannot be silently skipped to
award the next code. Reports may show a tentative candidate, clearly marked as
such, while withholding a final binding.

## 3. Consent, supported calls and encoding

Initial automatic attribution supports only a direct EOA transaction to a
manifest-approved vault `deposit(uint256,address)` with the EOA as receiver,
matching asset movement and a unique corresponding Deposit event. The deployed
bytecode/ABI and acceptance of trailing calldata must be verified for each
manifest entry. Do not infer this property from the closed PRs.

Safe, ERC-4337, EIP-7702 delegated execution, routers, multicalls and other
wrappers are initially **unsupported for automatic attribution**, including
otherwise simple-looking transactions from delegated EOAs. The skill must
identify unsupported paths before sending a requested referral. An operator
observing one records `unsupported_execution`, never copies a transaction-wide
code to every recipient. Adding a path requires an accepted extension identifying
wrapper versions, authorization boundaries, nested call decoding, event mapping
and independent fixtures. This deliberately limits launch coverage rather than
claiming wrapper support from a byte-pattern search.

Proposed wire profile **RM referral envelope v1** is pinned here, independently
of changes to the ERC-8021 draft used by the earlier PR:

- Normalize user input by trimming surrounding whitespace and lowercasing ASCII.
  Require `^rm_[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 32 ASCII characters total.
  Interior whitespace and non-ASCII characters are invalid, never removed.
- Append to the exact deposit call's ABI arguments the CBOR encoding of
  `{"m":{"rm":"<normalized-code>"}}`, followed by its two-byte unsigned
  big-endian length, byte `02`, and marker
  `80218021802180218021802180218021` (16 bytes).
- Use definite-length maps and text strings, exactly those keys and one code.
  For `rm_alice`, CBOR bytes are
  `a1616da162726d68726d5f616c696365`, followed by `001002` and the marker.
- Read only this exact profile at the end of the supported deposit call. Reject
  duplicate metadata keys, malformed lengths, extra envelopes, alternative
  schemas and noncanonical encodings as `invalid_envelope`. A marker elsewhere
  in transaction data is not a candidate. Other metadata profiles require an
  explicit extension; schemas 0 and 1 do not count in this release.

This profile is a project compatibility contract, not a claim of conformance to
a future ERC release. Contract acceptance of the bytes and round-trip fixtures
are implementation acceptance gates. No owner-requested code may be silently
changed to another code by normalization or parser recovery.

## 4. Manual claims and corrections

**Manual attribution and discretionary overrides are excluded from the initial
release.** Do not load or evaluate the earlier PR's manual-credit config entries.
An arbitrary message/signature or reviewer assertion cannot create a binding.
The consequences are explicit: missed referrals and unsupported signer paths do
not receive manual backfill; operators explain the limitation to the depositor.

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

Codes are versioned, reviewed backend configuration, not bearer secrets. Each
record contains normalized code, immutable beneficiary kind and ID (member ID
or team channel ID), display snapshot, terms version, activation time,
disabling time, and declared controlled wallets. Launch block and deployment
manifest are versioned alongside the rules. No environment variable grants
attribution or changes policy silently.

States at timestamp `t` are `draft` (no activation), `scheduled` (activation is
future), `active` (`enabledAt <= t` and no disable or `t < disabledAt`), and
`disabled` (`disabledAt <= t`). Terms acceptance is evidenced before activation.
Code strings are globally unique and never reassigned, including after deletion
of a beneficiary. Activation intervals are half-open and may not overlap for
the same beneficiary; a replacement may start exactly when the old one stops.

A draft may acquire its first prospective activation time through review.
Scheduled records may be cancelled before activation with retained history.
Once active, identity, terms and activation are immutable; disabling must be
prospective when approved. Rejoining uses a new code and accepted terms. Registry
validation compares against the previous accepted revision, rejecting deleted
history, reassignment, retroactive interval edits and overlapping intervals.
Time passing between approval and deployment must not make a purportedly
prospective change retroactive: activation requires a deployed revision before
its effective time, or it must be rescheduled through review.

Member departure requires prospective disabling before removing the public
member record. An active code with a missing member row is unavailable publicly
and generates an operational integrity error. Existing historical bindings
retain beneficiary ID and historical display snapshot; deleting a member does
not erase attribution history. Admin projection selects the code active **now**;
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

Unknown, malformed, draft, scheduled, disabled and missing-member codes return
404 with identical `{ "error": "not_found" }` bodies. No list, prefix search or
wildcard route exists. 200 and 404 use `Cache-Control: public, max-age=60`;
responses must not depend on cookies or authorization. Per trusted client IP,
allow 100 requests per 60-second fixed window, then 429
`{ "error": "rate_limited" }` with integer `Retry-After` seconds until reset and
`Cache-Control: no-store`. Use the existing trusted-proxy/IP boundary; clients
cannot select their identity through arbitrary forwarding headers. Dependency
failures return 503 `{ "error": "unavailable" }`, `Cache-Control: no-store`.
These JSON shapes must be reconciled with the common error envelope before
acceptance; any resulting revision belongs in this specification and contract.

The lookup identifies a currently active code. It says nothing about wallet
eligibility, launch status, supported execution, future activity, or earned
credit. Cached success can outlive disabling by 60 seconds. Codes and member
identity may be discoverable through predictable strings, calldata and public
lookup. No bulk listing and uniform misses do **not** promise secrecy or prevent
enumeration. Use synthetic codes in goldens; do not publish private report data
or controlled-wallet lists in public API responses.

Admin member DTO adds `referral: null | { code, state, enabled, termsVersion,
enabledAt, disabledAt }`, with `enabled` exactly `state === "active"`. The admin
member page displays the code, state, terms and dates, and explains that it is
read-only. Public swarm member DTOs remain free of referral fields. Registry
history remains operator configuration, not a new public/admin write API.

The deposit skill takes a code only from the wallet owner's explicit request;
it cannot invent, infer from a page, or substitute a referral. The preview names
the normalized code and beneficiary and says “code will be embedded; attribution
is evaluated after execution.” It never promises a reward or successful credit.
A requested referral is a condition of proceeding: invalid code, lookup failure,
unsupported wallet or path, or inability to preserve signed bytes stops before
submission and explains the cause. `confirm` off does not permit omission. The
owner may explicitly authorize proceeding without the code in a new instruction.
An ordinary deposit with no requested code continues normally.

Recheck code state immediately before signing/submission; a delay can still
cause expiry. Once signed or submitted, do not rewrite calldata. A later disable
makes the referral ineligible at execution and must be reported honestly; funds
can still deposit successfully. Unsupported delayed Safe execution is never
advertised as eligible in this release. The result distinguishes transaction
success, observed embedded bytes, pending evidence, and finalized attribution.

## 7. Reporting, completeness and operations

The versioned manifest lists chain, asset, every covered vault/router address,
ABI/bytecode version, deployment/start/end blocks, and legacy relationships.
Historical entries survive replacement of current vault addresses. Resolve v0
and four-vault coverage against actual deployments before launch; #1356 and
#1090 are integration references, not proof those dependencies are delivered.

A report uses a single recorded finalized block number **and hash** for both
attribution and optional valuation. Resolve the RPC `finalized` head once; an
explicit cutoff must be at or before it and canonical. Do not equate 32-block
depth with finality. If the provider cannot establish finality, canonicality or
historical state, the report is incomplete. Non-finalized diagnostics must be
separately labeled and cannot be exported as final attribution.

Scan all manifest history through that cutoff. Fetch required transaction,
receipt and block evidence through the shared RPC transport and rate budget.
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
for a combined complete report. Unsupported execution likewise withholds final
attribution for affected wallets if it could contain an earlier eligible event.

Each JSON report records chain ID, cutoff number/hash/timestamp, finalized-head
reference, launch block, coverage manifest digest, exact config and rules Git
revisions, registry digest, evidence digest, per-range coverage, completeness,
errors, and run time. Rows carry wallet, beneficiary/code or null, first
qualifying deposit, chosen event identity, binding status, candidate outcomes
and reasons. Reasons include `bound`, `already_bound`, `uncoded`, `late`,
`before_launch`, `code_inactive`, `self_referral`, `gift`, `invalid_envelope`,
`unsupported_execution`, and `evidence_unavailable`. Observations can be known
while final eligibility remains unknown; do not collapse those dimensions.
CSV exports carry a manifest identifier and accompanying JSON provenance file.
Optional holdings use raw integer quantities and explicit decimals; rounded
presentation is not an attribution input.

For the same cutoff/hash, manifest, evidence, registry and rules, attribution and
valuation payloads must match byte-for-byte after canonical serialization.
Exclude run time and diagnostics timing from that digest. Later withdrawals or
new deposits cannot change the historical payload. A different config revision
is a different report input, never an invisible update to the original.

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
| `backend/src/referrals/` and report CLI | Pure encoding/lifecycle/attribution rules plus evidence collector and reproducible private exports; paths are proposed new implementation touchpoints. |
| Backend routes and registered queries | One-code lookup; member identity reads use the registered query boundary. No chain scans on request paths. |
| `contract/` | Route catalogue, public DTO and admin DTO. Contract sync produces frontend artifacts during implementation, not this docs PR. |
| `frontend/public/skill.md` and deposit flow | Owner-authorized referral choice, stop behavior, previews and results; integrate with the eventual deposit skill path from #1090. |
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
| Alice coded, Bob uncoded in one bundle | Initial wrapper scope is unsupported; neither auto-binds. A future adapter must prove each signed call separately and never copy Alice's code to Bob. |
| Code in unrelated calldata; conflicting nested codes | No transaction-wide attribution; unsupported wrapper or invalid supported envelope, with no final award. |
| Gift to Alice; 31 days later her own coded deposit | Gift does not start her clock. Her proven self-funded deposit can bind if all other conditions hold. Include uncoded gift evidence. |
| Uncoded self-funded deposit; coded at +30 days | Clock starts on uncoded deposit; exact boundary is late. +30 days minus one second remains eligible. |
| Arbitrary manual message, `0x00` signature, unrelated hash | No manual input is accepted and no binding exists without supported chain evidence. |
| Earlier manual A, later chain B | Manual records are unsupported and rejected as input; no report can claim A from them. A future extension must settle precedence before use. |
| Missing input/receipt followed by valid code B | Incomplete history, unknown eligibility, B provisional; never “no code” for the missing observation. |
| October cutoff rerun after November withdrawal | Identical holdings and attribution payload at the same October block/hash and pinned revisions; all reads prove the same snapshot. |
| Hash changes; provider lacks finalized or archive reads | Publication blocked or explicit incomplete diagnostics; no fabricated zero and no depth-based finality claim. |
| Draft activation; scheduled disable/replacement; rejoin | Validate prospective history and non-overlap; exact adjacent boundaries allowed; admin selects active code over future replacement. |
| Member row removed while code active | Public uniform 404 plus operational error; historical binding retains beneficiary snapshot. |
| Lookup timeout with requested code, including confirm off | Stop before submission; explain retry or explicit owner choice to proceed uncoded. |
| Code disabled after lookup/signing | Deposit may execute; execution-time attribution fails as inactive. Preview never guaranteed credit. |
| ` RM_ALICE ` versus `rm_a lice` | First normalizes to `rm_alice`; second fails unchanged. Public, skill and report share fixtures. |
| Active code but late, pre-launch, or already bound | Lookup succeeds; reporting explains actual eligibility independently; existing binding persists. |
| Legacy v0 holder migrates; deployment addresses replaced | First qualifying historical deposit retained; no new clock. Missing legacy coverage blocks final report. |
| Member-controlled wallet, team channel, transferred shares | Declared self-referral rejected; eligible team code works; holdings are descriptive, not qualified capital. |
| Repeated legs, duplicate logs, interrupted scans | Stable deduplication and ordering; no duplicate attribution; checkpoint resumes under identical revisions/hash. |
| Public lookup/admin/public member DTOs | Exact shapes and errors; rate/cache behavior; no bulk route, private wallet list or public member referral field. |

## 10. Rollout and evidence gates

Acceptance of this specification is separate from implementation and launch.
Implementation requires the accepted revision, full contract/encoding fixtures,
registry history validation, call/event evidence tests, historical report reruns,
public/admin privacy checks and deposit-flow failure coverage. Demonstrate an
actual supported deposit against each intended deployed bytecode path with
preserved inputs/receipt and owner-authorized funds; offline fixtures alone do
not establish contract compatibility. Unsupported wallet paths must visibly stop
before submission when a referral is requested.

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
| Product meaning | Attribution only; descriptive holdings confer no reward or qualified-capital claim. |
| Clock and legacy | 30 days from first self-funded positive deposit, including pre-launch/v0 history; no migration reset. Older existing holders cannot join. |
| Supported launch paths | Direct EOA vault deposits only; Safe/4337/7702/router/batch users cannot obtain automatic attribution initially. |
| Encoding | Pin RM envelope v1 above; do not accept schema 0/1 or track a moving ERC draft. |
| Manual/correction policy | No manual awards or discretionary overrides; evidence corrections preserve supersession history. |
| Identity and lifecycle | Wallet identity, declared-control exclusion, immutable code ownership and prospective reviewed lifecycle. |
| Experience and disclosure | Requested code blocks submission on failure; codes are discoverable; admin projection includes explicit state. |
| Report authority | One finalized snapshot, complete legacy manifest, pinned revisions, private exports and measured operator budget. |

The implementation owner supplies the exact deployment manifest, verifies ABI
and bytecode acceptance, reconciles common API error shapes, and proposes the
measured scan budget. These are acceptance/launch inputs, not facts inferred from
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
