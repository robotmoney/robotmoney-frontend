# Investment Swarm to On-Chain Governance

This document is the canonical cross-repository description of the boundary
between the Investment Swarm and Robot Money's contracts. The Project Fusion
delivery checklist lives in [frontend issue #1054](https://github.com/robotmoney/robotmoney-frontend/issues/1054).

## Two committee records

The on-chain `InvestmentCommitteePolicy` vote path and the Fusion consensus
receipt serve different purposes:

- A policy vote is an individual agent's per-vault signal. It is submitted
  through the gateway by an EVM agent identity and is recorded for public
  inspection. It does not aggregate the committee or change router weights.
- A consensus receipt is a session-scoped record of the swarm's recommendation.
  Analysts sign their individual takes with Ed25519 keys. The frontend derives
  the allocation from the deterministic mean of those takes and carries the
  judge's opinion and provenance in the receipt. A single authorized EVM
  submitter attests for the committee when it records the receipt on chain.

The Ed25519 signatures are receipt content verified off chain; they do not
authenticate the EVM transaction. The judge authors rationale and release
safety, not the weight vector, and does not sign the receipt. These are separate
identity systems with separate authority.

## Receipt production and cross-repository format

The frontend freezes a session's valid signed takes, computes
`meanTakeWeights`, converts the result to basis points under the schema's
canonical bucket order, builds the schema-1.0 receipt, and serves it at
`GET /api/swarm/receipts/{session_id}`. One receipt represents one session and
one subject. Its canonical bytes and digest bind the allocation, judge opinion,
and analyst signature material.

The four frontend allocation buckets map to core vault symbols as follows:

| Frontend bucket | Core vault |
| --- | --- |
| `conservative_defi_yield` | `rmUSDC` |
| `protocol_tokens` | `rmPROTO` |
| `agent_tokens` | `rmAGENT` |
| `real_world_assets` | `rmRWA` |

The mapping is symbolic and deployment-specific addresses come from that
deployment's complete `vault_addresses` manifest. Do not substitute global or
zero addresses. The canonicalization and bucket mapping fixtures are mirrored
between `robotmoney-frontend/contract/src/__fixtures__/` and
`robotmoney-core/tests/fixtures/`; their bytes are part of the cross-repo
contract. Core's fixture checker and the frontend's fixture tests guard the
shared format.

## Independent verification and anchoring

The core-side submitter fetches the public receipt and independently verifies
the schema, exact canonical bytes, digest, receipt identity, embedded analyst
signatures, judge fields, bucket set, bucket-to-vault mapping, and exact
10,000-bps total. It refuses malformed, changed, replayed, or otherwise
ineligible input before broadcasting a transaction.

An authorized submitter records the commitment through
`RobotMoneyGateway.consensusRecordReceipt` and
`ConsensusRecommendationReceipt`. The chain record makes the receipt
commitment publicly auditable; it does not make the contracts verify the
embedded Ed25519 signatures. The indexer and read surfaces must independently
verify those signatures and distinguish verified from unverified content.

Receipt release is a separate administrative action through the Safe and
`TimelockController`. Recording and releasing a receipt are signalling steps:
neither transfers assets nor changes router weights. The release event is the
handoff point from the committee record to the governance workflow.

## Governance handoff

After release, `rmpc governance draft-proposal` fetches the anchored URI again,
checks the anchored digest and analyst signatures, verifies vault eligibility,
maps the receipt's bucket weights to the deployment's vault addresses, and
produces exact `RouterGovernance.propose(vaults, bps)` calldata. The draft is
for human review. It must not silently submit a proposal or bypass the Safe and
Timelock authority path.

The proposal then follows the configured governance lifecycle: proposal,
independent voter approvals to quorum, voting period, execution delay, and
`RouterGovernance.execute`. Only successful execution updates
`PortfolioRouter` weights. The final router vector must equal the receipt's
mapped vector exactly.

Committee agents and addresses with non-zero `RouterGovernance` voting power
must be disjoint. A committee agent may recommend but may not approve its own
recommendation. The Safe/Timelock administrative path and the voter path are
distinct authorities, and the system retains a human approval step.

## References

- [Project Fusion delivery tracker](https://github.com/robotmoney/robotmoney-frontend/issues/1054)
- [Project Fusion end-to-end acceptance](./project-fusion-acceptance.md)
- Frontend producer and receipt implementation: `backend/src/swarm/`,
  `backend/src/api/routes/swarm*.ts`, and `contract/src/consensus-receipt.js`
- Core contract architecture: `robotmoney-core/docs/architecture.md` §§4.8–4.9
- Core receipt design record: `robotmoney-core/docs/product/20260623-product-proposal-investment-committee-v0.md`
- Shared receipt fixtures: `robotmoney-core/tests/fixtures/consensus-receipt.*`
  and `contract/src/__fixtures__/consensus-receipt.*`
