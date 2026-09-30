# Investment Committee to Router Weights

How analyst takes become `PortfolioRouter` weights. Delivery checklist:
[issue #1054](https://github.com/robotmoney/robotmoney-frontend/issues/1054).
Acceptance steps: [project-fusion-acceptance.md](./project-fusion-acceptance.md).

## Pipeline

```
analysts sign takes -> mean -> judge prose -> publish -> receipt (off chain)
  -> rmpc receipt submit -> Gateway.consensusRecordReceipt (anchor)
  -> Timelock releaseReceipt -> rmpc governance draft-proposal (human review)
  -> RouterGovernance.propose -> votes to quorum -> execute -> PortfolioRouter.setWeights
```

Only the last step changes weights. Everything before it is signalling.

## Components

| Step | Component | What it does | Authority |
| --- | --- | --- | --- |
| Take | `backend/src/swarm/domain.ts` | Accepts one signed take per analyst: stance, confidence, and a weight vector over the 4 buckets. Up to 5 revisions. Rejects replayed nonces and late takes. | Analyst Ed25519 key |
| Mean | `aggregateSession()` | Normalizes each vector to 1, averages per bucket, rounds to 8 decimals. Unweighted: confidence and stance do not affect weights. | None (code) |
| Judge | `judge.ts` | Writes prose only: rationale, disagreements, `release_safety` (`safe` or `hold`). Rejects any model output containing weights. Does not sign. | None |
| Receipt | `consensus-receipt.ts` | Builds schema-1.0 receipt from a `published` session. Immutable once stored. | None (code) |
| Anchor | `rmpc receipt submit` | Verifies the receipt offline, then calls `Gateway.consensusRecordReceipt(receiptId, digest, uri)`. | EOA with `AGENT_ROLE` and `COMMITTEE_AGENT_ROLE` |
| Register | `ConsensusRecommendationReceipt` | Stores id, digest, URI, submitter. Stores no weights. One record per `receiptId`. | Gateway only |
| Release | `releaseReceipt` | Sets `released`. Called directly, not through the gateway. | `ADMIN_ROLE` (Timelock) |
| Draft | `rmpc governance draft-proposal` | Builds `propose(vaults, bps)` calldata from a released receipt. Never signs or broadcasts. | None |
| Propose | `RouterGovernance.propose` | Snapshots quorum, opens voting. One Active or Queued proposal at a time. | `ADMIN_ROLE` |
| Vote | `RouterGovernance.vote` | For-only, one vote per address, power is admin-assigned. | Nonzero voting power |
| Execute | `RouterGovernance.execute` | Anyone can call after the delay. Calls `router.setWeights`. | Anyone |

## Reaching consensus: what the code does and does not do

- **Disagreement becomes an average.** No median, trimming, or outlier rejection.
- **No minimum take count is enforced.** One signed take can publish. The judge sets `hold` below 3 takes (`min_takes`), and that is advice only.
- **Release is a human call.** A `hold` receipt can still be released. `draft-proposal` does not read `release_safety`.
- **Judge opinion is required.** Assembly needs an adopted `enforce`-mode, model-authored judgement over the current takes. A fallback or stale judgement blocks the receipt.
- **A weightless take ruins the session.** Every take must carry the 4-bucket vector. The fix is the audited forced excuse (`roster_excuse_forced`).

## Receipt format

- Fields, in canonical order: `schema_version`, `session_id`, `subject_id`, `created_at`, `prompt_hash`, `inputs_digest`, `quorum`, `stances`, `judge`, `analyst_signatures`, `weights`.
- Bytes: `"robotmoney:consensus-receipt:v1\n"` + compact JSON in that key order + `"\n"`.
- `payloadDigest = keccak256(bytes)`. `receiptId = keccak256("robotmoney:consensus-receipt-id:v1\n" + session_id + "\n" + subject_id)`.
- Bucket order: `agent_tokens`, `conservative_defi_yield`, `protocol_tokens`, `real_world_assets`.
- Shares to bps: largest-remainder in IEEE-754 binary64. Total is exactly 10,000. Do not recompute in decimal: the two can differ by 1 bp per bucket.
- Served at `GET /api/swarm/sessions/:id/consensus-receipt`. Fixtures are mirrored in `contract/src/__fixtures__/` and `robotmoney-core/tests/fixtures/`.

| Bucket | Vault |
| --- | --- |
| `conservative_defi_yield` | `rmUSDC` |
| `protocol_tokens` | `rmPROTO` |
| `agent_tokens` | `rmAGENT` |
| `real_world_assets` | `rmRWA` |

Vault addresses come from the deployment's `vault_addresses` manifest only.

## Governance parameters

- Quorum: absolute sum of voting power. Floor of 2 in bytecode. Deploy default 2.
- Voting period: floor and deploy default 1 hour. Execution delay: same, counted from the voting deadline.
- Checks at `propose` and `setWeights`: lengths match, sum is 10,000, each vault is active and router-eligible.
- Not enforced: per-vault min or max, max change per proposal, duplicate vaults, proposal expiry.
- Production values are not recorded in the repo. Fill them in here once they are set.

## Trust boundaries and open issues

1. **Chain does not verify signatures.** It checks only that an allowlisted submitter recorded `(id, digest, uri)`. `rmpc` and the indexer verify Ed25519 off chain.
2. **Embedded keys are self-declared.** `rmpc` verifies against the key inside the receipt. A compromised submitter could fabricate analysts. No roster check was found in `rmpc`.
3. **Wrong digest blocks the right one.** `receiptId` does not cover the digest. A bad anchor needs a new session id and a public correction.
4. **Weights sit outside signatures.** Analyst signatures cover only each take. The digest is the only binding on `weights` and `judge`.
5. **No staleness gate.** `created_at` is publish time. Architecture §4.9 says stale receipts are never drafted. No code enforces that.
6. **No receipt-to-proposal link on chain.** One released receipt can be drafted again after a proposal is cancelled or defeated.
7. **Draft can differ from receipt.** If a vault is ineligible, `draft-proposal` redistributes its bps and reports `fallback_applied`. Its rounding is still the old settle-the-last rule.
8. **Queued proposals never expire.** They revert at `execute` if a vault becomes ineligible. `ADMIN_ROLE` can cancel.
9. **Committee and voter separation is tested, not enforced.** Only `GovernanceSeparationInvariant.t.sol` checks it.
10. **Admin custody is operational.** Timelock as `ADMIN_ROLE`, and `RouterGovernance` as sole router admin, are runbook rules. Production submitter custody requirements C-1 to C-6 are unmet.
11. **Anchoring is devnet-only.** Do not call the record tamper-proof before mainnet.

## References

- Producer: `backend/src/swarm/`, `backend/src/api/routes/swarm/receipts.ts`, `contract/src/consensus-receipt.js`
- Submitter and draft: `robotmoney-core/clients/rust-payment-client/src/commands/receipt.rs`, `governance_draft.rs`
- Contracts: `robotmoney-core/contracts/` (`RobotMoneyGateway`, `ConsensusRecommendationReceipt`, `RouterGovernance`, `PortfolioRouter`)
- Design: `robotmoney-core/docs/architecture.md` §§4.8–4.9
