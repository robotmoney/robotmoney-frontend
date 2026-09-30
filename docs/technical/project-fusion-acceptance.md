# Project Fusion End-to-End Acceptance

This is the durable acceptance contract for Project Fusion. The active
engineering checklist and evidence links live in
[frontend issue #1054](https://github.com/robotmoney/robotmoney-frontend/issues/1054).
The test driver and staging instructions remain with the owning code and
deployment tools.

## Acceptance sequence

1. **Produce a real receipt.** Run a real staged swarm session with valid signed
   analyst takes and an adopted judge opinion. Retain the public receipt URL,
   session and receipt IDs, payload digest, judge provenance, signature set,
   and four-vault vector totaling exactly 10,000 bps.
2. **Verify independently.** Have core fetch the exact public bytes and verify
   the schema, canonical representation, digest, receipt ID, analyst
   signatures, bucket set, and weight total. A tampered or malformed copy must
   fail before a transaction is broadcast.
3. **Record the receipt.** Record it using the authorized submitter through the
   gateway. Retain the transaction, event, and stored record; prove an
   unauthorized submitter cannot record it.
4. **Release under administration.** Release through the rehearsal or
   production Safe and `TimelockController`, according to the environment.
   Retain schedule and execution evidence and prove that release does not
   change router weights. For a Safe-backed run, verify the deployed Safe's
   canonical proxy and singleton, owner set, threshold, modules, guard, and
   fallback handler. Show that one owner signature and other invalid signer
   sets cannot execute, while the configured threshold can.
5. **Derive the proposal.** Build a draft from the released on-chain receipt.
   It must refetch and reverify the receipt, check vault eligibility, use the
   canonical bucket mapping, and produce proposal calldata matching the
   receipt exactly. Preserve the draft for human review.
6. **Submit under the authorized path.** Submit the reviewed proposal through
   the configured Safe/Timelock path. Retain its proposal ID and prove its
   stored vaults and weights match the receipt.
7. **Prove independent approval.** Show the committee submitter and committee
   agents are disjoint from governance voters. Prove one vote is insufficient
   where the configured quorum requires multiple voters, and that the
   independent votes reach quorum.
8. **Execute the update.** Complete the voting period and execution delay, call
   `RouterGovernance.execute`, and prove the resulting `PortfolioRouter`
   weights equal the mapped receipt vector. No earlier step may change those
   weights.
9. **Retain evidence and destroy keys.** Keep the receipt URL and digest,
   transactions and decoded events, proposal transitions, before/after weights,
   and negative-control results. Destroy ephemeral submitter, approver, and
   voter keys, then scan the evidence bundle for key material.

## Required negative controls

At minimum, evidence must show that invalid analyst signatures, changed receipt
bytes or digest, malformed schema, unsupported bucket or vault mapping,
unauthorized record or release, duplicate receipt, ineligible vault,
committee/voter overlap, and insufficient quorum cannot produce an unauthorized
weight update. Each control must identify the rejected step and show that
router weights remain unchanged.

## Evidence quality

Every accepted run identifies the exact frontend and core candidates, the
deployment/chain identity, and the receipt bytes by digest. Chain evidence
includes transaction hashes, decoded events, contract addresses, proposal
state transitions, and before/after router weights. Frontend evidence ties the
published receipt back to the frozen session and the verified take set.

A local or staging run proves the behavior only in that environment. A
staging Safe with throwaway keys proves quorum enforcement, not production key
custody. Production claims require evidence from the actual production
authority topology and custody process, including its signer custody process.

## Related implementation records

- [Frontend Project Fusion tracker](https://github.com/robotmoney/robotmoney-frontend/issues/1054)
- [Core governance-path work](https://github.com/robotmoney/robotmoney-core/issues/1447)
- [Core receipt anchoring](https://github.com/robotmoney/robotmoney-core/issues/1247)
- [Core governance handoff](https://github.com/robotmoney/robotmoney-core/issues/1248)
