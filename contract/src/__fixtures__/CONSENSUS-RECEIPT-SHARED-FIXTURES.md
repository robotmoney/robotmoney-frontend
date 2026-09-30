# The cross-repo shared consensus-receipt fixtures

Eleven files in this directory are **byte-identical** to
`contract/src/__fixtures__/<same name>` in `robotmoney-frontend`. That identity
is the cross-repo pin (issue #1244 AC5, `AC-FMT-01`), and it is enforced twice:

| check | manifest it reads | what it can catch |
|---|---|---|
| `.github/scripts/check_consensus_receipt_schema.py` | `consensus-receipt.anchor-digest.json` → `shared_fixture_manifest` (authored **here**) | a fixture edited without updating its own row; the shared family gaining or losing a member |
| `.github/scripts/check_cross_repo_fixture_drift.py` | `shared-fixtures/vendored/robotmoney-frontend.manifest.json` (vendored from the **other** repo at a pinned commit) | a one-sided edit — the class that went green at `v0.4.0-rc.3` |

The first one alone is self-referential. At `v0.4.0-rc.3` eight of the nine
shared fixtures had drifted away from the frontend and it still exited 0
(`fusion-evidence/20260913T-run1/phase3/3.1-core-ci-fixture-check-GREEN-while-drifted.txt`).
`.github/scripts/test_cross_repo_fixture_drift.sh` reconstructs that exact state
and requires the second check to fail on it.

Changing any shared fixture is a coordinated cross-repo release, never a
drive-by edit: see
`docs/product/20260623-product-proposal-investment-committee-v0.md` §7.4.

## `consensus-receipt.envelope.json` — the read-time envelope, and the one unwrap rule (T24)

`robotmoney-frontend` serves the receipt at
`/api/swarm/sessions/:id/consensus-receipt` inside a **read-time verification
envelope**, not bare:

```
{sessionId, subjectId, schemaVersion, publishedAt, receipt,
 canonicalBytes, verified, signatures, unverifiedReasons}
```

This fixture is that shape, captured from the staging route, wrapping
`consensus-receipt.valid.json` with the golden text of
`consensus-receipt.valid.canonical.txt` in `canonicalBytes`. Before it existed,
the shape had **no pinned representation anywhere**: `rmpc`, the acceptance
gate (twice) and the dapp each invented their own inline literal, and the
literals already differed.

**The unwrap rule — one rule, every consumer, no exceptions:**

1. If the top-level object has `schema_version`, it **is** the receipt. Use it.
   A top level that is itself a receipt always wins, so the wrong object can
   never be picked silently.
2. Otherwise, if `.receipt` has `schema_version`, the body is an envelope: the
   receipt is `.receipt`.
3. Otherwise the body is neither. **Refuse** — never write `null`, never pass
   the envelope on as if it were a receipt.

Unwrapping cannot move a digest: the preimage was never the served bytes.
`canonical_bytes()` re-serializes the *parsed receipt* under the
canonicalization contract, so an envelope and a bare receipt carrying the same
object produce identical bytes — asserted directly against this fixture in
`clients/rust-payment-client/src/consensus_receipt.rs`.

Consumers that must read this file rather than an inline literal:

- `clients/rust-payment-client` (`rmpc`) — `ConsensusReceipt::from_json_slice`.
- `scripts/fusion/lib/receipt-envelope.sh` — the single shell implementation,
  used by both `devnet-acceptance.sh` stages that previously carried their own
  `jq` copy (the negative-stage copy had dropped the
  `.receipt | has("schema_version")` guard and wrote the literal `null` into
  `receipt.json` on a non-envelope body).
- the explorer indexer, which calls `rmpc` rather than reimplementing the rule.
- the dapp copy stays — different language, different repo boundary — but is
  driven from this same fixture.

## `consensus-receipt.unknown-fields-refused.json` — expected outcome: REFUSE (R27 / D11)

`consensus-receipt.valid.json` with two additive fields that no version of the
schema models:

- one **top level**: `experimental_confidence`
- one **nested**, inside `judge`: `fallback_reason`

The expected outcome in **every** consumer is `REFUSE` — decision R27/D11:
*unknown fields are refused, never dropped.* The name of the file is the
expectation, and it is not negotiable per-consumer: the `v0.4.0-rc.3` failure
was core silently **dropping** two fields the frontend **required**, so the two
repos hashed different preimages while both CIs were green and `rmpc` exited 0
(`C-16`). A consumer that accepts this fixture, or that accepts it after
discarding the two keys, has reproduced that failure.

A conforming refusal names the offending key. In core the error is
`ErrReceiptSchema`.
