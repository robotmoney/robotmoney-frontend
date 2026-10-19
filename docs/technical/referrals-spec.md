# Referral attribution spec

> **Status: draft for acceptance under issue #1358, 2026-10-19. Prescriptive.**
> This document describes the referral behaviour the system is to have. It does
> not describe an implementation, and it does not inherit from the closed
> referral PRs (#1370, #1372, #1385, #1386); §15 records what they proposed and
> what changed. Where it conflicts with code, the code is what changes.
>
> **Authority.** Sections marked **Accepted (owner)** record product decisions
> the owner (David) accepted on 2026-10-19. Sections marked **Proposed
> (technical)** are drafted for the technical owner (Lucas) to correct and
> accept. The document is approved when both have accepted it and it is merged;
> issue #1371 then records the merged revision and implements it.

---

## 1. Scope

**Accepted (owner).** A referral is a statement that a depositing wallet came
to Robot Money through a particular swarm member or team channel. The system
records that statement and explains it. Nothing more:

- **Attribution only.** An attribution says "this wallet's deposits came
  through code X, from time T". It creates no entitlement of any kind. Any
  reward based on attribution is a separate decision, outside this document,
  and must not be inferred from it.
- **In scope:** referral codes and their lifecycle, how a depositor attaches a
  code to a deposit, how a code is matched to the deposit it was attached to,
  the attribution rules, admin corrections, the public code lookup, the
  deposit experience, and the attribution report.
- **Out of scope:** rewards and anything that values an attribution in money;
  a public list of codes or members; attribution for deposits outside the
  registered deployments (§12); on-chain registration of codes.

## 2. Terms

| Term | Meaning |
|---|---|
| **Code** | A string `rm_<slug>` that names one holder (§4). |
| **Holder** | The approved swarm member or the team channel a code belongs to. |
| **Deposit** | One ERC-4626 `Deposit` event emitted by a registered vault (§12). A router deposit produces one deposit per funded vault leg. |
| **Deposit call** | The call to a router or a vault whose execution emitted the deposit (§6). |
| **Caller** | The account that made the deposit call: the transaction sender for a direct call, the Safe for a Safe call. |
| **Receiver** | The deposit event's `owner`: the wallet that receives the shares. |
| **Self-funded deposit** | A deposit whose caller is its receiver: the wallet paid for its own shares. |
| **Coded deposit** | A deposit whose deposit call carries a referral suffix (§5). |
| **Attribution** | A wallet bound to a code, with the time it took effect and the evidence for it. |
| **Launch time** | The time from which codes count (§7.1). |
| **Correction** | An attribution an admin records without an on-chain code (§8). |
| **Snapshot block** | The block a report is evaluated at (§11). |

## 3. Product rules

**Accepted (owner), 2026-10-19.** The rest of this document makes these exact.

| # | Rule |
|---|---|
| R1 | Attribution only; no entitlement (§1). |
| R2 | Codes belong to approved swarm members who have accepted the referral terms, and to team channels, which only track a source. A member may use its own code on its own wallet. |
| R3 | A code attaches to one deposit call, not to a transaction. A code counts only for the deposits that call produced. When the system cannot tell which deposit a code belongs to, it counts for none, and the report says so. |
| R4 | Only a self-funded deposit can bind a wallet. A deposit someone else makes into a wallet (a gift, or `depositFor` from another account) never binds it and never starts its clock. |
| R5 | A wallet has 30 days from its first self-funded deposit to bind a code. A wallet that held a position before launch counts from launch. The window limits how late a code may arrive; there is no minimum holding time. |
| R6 | The first valid attribution is permanent. Later codes are ignored. Withdrawals and transfers do not remove it. It belongs to the wallet, not to its shares: a wallet that receives transferred shares is not attributed by that. |
| R7 | Every deposit after binding counts for the bound holder, coded or not. Repeating the same code changes nothing. |
| R8 | No minimum deposit amount. |
| R9 | Admins can record corrections, as verified depositor claims or as reasoned overrides, under the limits in §8. |
| R10 | A code has one lifecycle: draft, active, disabled. It is never reissued and never reassigned (§4). |
| R11 | Legacy v0 deposits never count. A new deployment is added next to the old one; attributions stay with the wallet (§12). |
| R12 | The public lookup checks one code at a time and returns its display name. Codes are not secret (§9). |
| R13 | A code is optional and never blocks a deposit. Attaching a code is not a promise of attribution (§10). |
| R14 | A report evaluates attributions and positions at one snapshot block, and reports missing evidence as unknown, never as "no code" (§11). |

## 4. Codes and their lifecycle

**Accepted (owner); field names proposed (technical).**

### 4.1 Format

- A code matches `^rm_[a-z0-9]+(-[a-z0-9]+)*$` and is at most 32 characters.
- A member's code is `rm_` followed by the member's handle at issuance,
  truncated to fit, with `-2`, `-3` appended on collision. A team channel's
  code is `rm_` followed by the channel's name.
- **Normalization** is trimming surrounding whitespace and lowercasing.
  Whitespace inside a code makes it invalid; nothing else is rewritten. Every
  surface (lookup, deposit clients, report) applies this one rule.

### 4.2 Record

Each code is one record:

| Field | Meaning | Change rule |
|---|---|---|
| `code` | The code string | Never changes. Never reused, even after the code is disabled. |
| `holder` | A member id, or a team channel name | Never changes. |
| `termsVersion` | The referral terms version the member accepted; none for a channel | Set before `activeFrom` for a member code. Never changes after `activeFrom`. |
| `issuedAt` | When the record was created | Never changes. |
| `activeFrom` | When the code starts counting | Set once. May be in the future. |
| `activeUntil` | When the code stops counting for new deposits | Set once, after `activeFrom`. May be in the future. |

### 4.3 States

| State | Condition | Counts for new deposits |
|---|---|---|
| draft | `activeFrom` unset, or in the future | No |
| active | `activeFrom` ≤ t, and `activeUntil` unset or later than t | Yes |
| disabled | `activeUntil` ≤ t | No |

A code is evaluated at the deposit's block time, never at the time a report
runs. Attributions a code made while active stay after it is disabled (R6).

### 4.4 Invariants

- **No reassignment, no reissue.** A code string identifies one holder
  forever. A string equal to any existing or past code is refused.
- **One code per member at a time.** Two codes of the same member must not
  have overlapping active intervals.
- **Rejoin.** A member who leaves gets `activeUntil` on its code. If it
  returns, it gets a new code; the old one stays disabled.
- **Member deletion.** Deleting a member sets `activeUntil` on its code at the
  deletion time if not already set. The record stays, so reports stay
  explainable.
- **Admin view.** For a member, admins see the code active now, any scheduled
  (draft) code, and the full history of the member's codes.

## 5. Consent encoding

**Proposed (technical).**

- A depositor attaches a code by appending an ERC-8021 schema 2 suffix to the
  **calldata of the deposit call** (§6): the bytes after the call's ABI-encoded
  arguments. The vaults and the router ignore those bytes (checked against
  core Deploy 2: no proxies, no ERC-2771, no `msg.data` reads).
- **Pinned format.** ERC-8021 is a draft. This spec pins the draft text of
  `ethereum/ERCs` pull request 1209 as of 2026-10-13; the technical owner
  records the exact commit here at acceptance. A later change to the draft
  does not change this format without a revision of this spec.
- **Payload.** Read from the end of the call data: the 16-byte marker
  `0x80218021802180218021802180218021`, the schema id `0x02`, a 2-byte
  big-endian length, and a CBOR map of that length equal to
  `{"m": {"rm": "<code>"}}`. The map may carry other keys (a wallet may add
  its own); only `m.rm` is read.
- **Golden vector.** For `rm_acme` the suffix is
  `0xa1616da162726d67726d5f61636d65000f0280218021802180218021802180218021`.
- **One code per call.** Only the suffix that ends the deposit call's own data
  counts. A suffix anywhere else in a transaction is ignored for attribution
  and may be reported as a diagnostic. Schema 0 and schema 1 codes are not
  read.

## 6. Matching a code to its deposits

**Accepted (owner): R3, R4. Mechanism proposed (technical).**

### 6.1 Supported paths

v1 attributes deposits made on these paths, and no others:

| Path | Deposit call | Caller |
|---|---|---|
| **P1 Direct** | The transaction calls the router or a registered vault directly. | The transaction sender |
| **P2 Safe, single call** | The transaction calls a Safe's `execTransaction` with `operation = CALL` to the router or a vault. | The Safe |
| **P3 Safe, batch** | A Safe `execTransaction` with `operation = DELEGATECALL` to a canonical `MultiSendCallOnly`; each packed entry that calls the router or a vault is a deposit call. | The Safe |

**Unsupported in v1:** ERC-4337 user operations, EIP-7702 and ERC-7821 batch
execution, ERC-5792 calls executed by smart accounts through either of those,
other contract wallets, and any third-party contract that calls the router or a
vault. A deposit on an unsupported path gets the status `unsupported_path`
(§7.3) even when its transaction carries a code. Its remedy is a verified
correction (§8).

### 6.2 From a deposit call to its deposits

For each deposit call, the matcher decodes the target and the arguments:

- **Vault `deposit(assets, receiver)`**: the call's deposit is the `Deposit`
  event from that vault with `sender` = the caller, `owner` = `receiver` and
  `assets` = `assets`.
- **Router `deposit(amount, minShares)`** and
  **`depositFor(receiver, amount, minShares)`**: the call's deposits are the
  `Deposit` events with `sender` = the router and `owner` = the receiver
  (`deposit`: the caller), one per funded leg, whose assets sum to `amount`,
  together with the router's `RouterDeposit` events for the same depositor.
- When several deposit calls in one transaction could match the same events
  (same target, receiver and amount), calls and events are paired in execution
  order. If the counts differ, or two such calls carry different codes, those
  deposits get `ambiguous`.
- A deposit no call could be matched to gets `ambiguous`.

### 6.3 Self-funding

A deposit is self-funded when its caller equals its receiver. For a vault
deposit the caller's USDC is pulled into the vault; for a router deposit the
router pulls it from the caller. So self-funding is decided from the call frame,
not from scanning the receipt for transfers.

## 7. Attribution rules

**Accepted (owner): R3 to R9. Mechanism proposed (technical).**

### 7.1 Launch

The launch time is a configured block. Coded deposits before it get
`before_launch`. Self-funded deposits before it put the wallet's clock at launch
(R5).

### 7.2 Order

All attribution events are put in one order by their **effective time**:

- an on-chain deposit: its block time, then block number, transaction index and
  log index;
- a correction: the time it was recorded (§8).

A deposit and a correction never take effect at the same instant: on a tie,
the on-chain deposit comes first. Because a correction takes effect only when
it is recorded, a correction recorded after a report's snapshot never changes
that report.

### 7.3 Statuses

Each coded deposit, and each deposit on an unsupported path, gets exactly one
status, evaluated in this order:

| Order | Status | When |
|---|---|---|
| 1 | `evidence_missing` | The transaction, its receipt, or its block could not be read. Never treated as uncoded. |
| 2 | `unsupported_path` | The deposit was made on a path outside §6.1. |
| 3 | `ambiguous` | The code cannot be tied to this deposit (§6.2). |
| 4 | `unknown_code` | The code is well formed but no record holds it, or it is malformed. |
| 5 | `before_launch` | The deposit is before launch. |
| 6 | `inactive_code` | The code was draft or disabled at the deposit's block time. |
| 7 | `gift` | The deposit is not self-funded (R4). |
| 8 | `already_attributed` | The wallet was bound earlier, by any code or correction (R6). Includes the same code repeated (R7). |
| 9 | `late` | The deposit's time is more than 30 days after the wallet's window start (§7.4). |
| 10 | `bound` | The wallet is bound to the code from this deposit's effective time. All deposits from the same deposit call share this status. |

Uncoded deposits get no status. They count for the holder of the wallet's
attribution if one exists at their time (R7), and self-funded ones set the
clock (§7.4).

### 7.4 The window

A wallet's window starts at the later of launch time and the time of its first
self-funded deposit on a supported path into any registered deployment. A
deposit on an unsupported path, or a gift, does not start it. The window ends 30
days after it starts. A code on a deposit after the window ends gets `late`.

## 8. Admin corrections

**Accepted (owner): R9. Details proposed (technical); the two marked items need
owner confirmation.**

A correction binds a wallet to a code when no valid on-chain code did.

| Kind | Evidence | Report label |
|---|---|---|
| **Verified** | A signature by the wallet over the correction payload, checked by the system | `verified_correction` |
| **Override** | An admin's written reason, for example "depositor confirmed in our 1:1 channel" | `override` |

**Limits, for both kinds:**

- The wallet must have no attribution at the correction's effective time. A
  correction never takes a wallet from another holder.
- The correction names one deposit by transaction hash and log index. That
  deposit must exist, be self-funded, have the wallet as its receiver, and fall
  inside the wallet's window (§7.4).
- **(Owner to confirm)** A correction can be recorded up to 90 days after the
  deposit it names.
- The code must have been active at that deposit's block time.
- A correction takes effect when it is recorded, never earlier (§7.2).

**Verified payload.** EIP-712 typed data with the domain
`{name: "Robot Money Referral", version: "1", chainId: 8453}` and the message
`{wallet, code, depositTx, issuedAt, nonce}`. An EOA signature is checked by
recovery; a Safe's by EIP-1271 `isValidSignature` at a block after `issuedAt`.
A nonce is used once per wallet. **(Owner to confirm)** Verified corrections are
the only kind for deposits on unsupported paths.

**Record and audit.** Every correction stores the kind, the admin who recorded
it, the time, the reason, the evidence, and the deposit it names. Records are
append-only.

**Revocation.** An admin can revoke a correction, with a reason. Revocation
takes effect when recorded: the wallet is unattributed from then on, and
reports before that time are unchanged. A revoked wallet can be bound again
only by a new correction.

## 9. Public code lookup

**Accepted (owner): R12. Contract proposed (technical).**

- `GET /api/referrals/codes/{code}`, no authentication.
- The path segment is normalized (§4.1). The answer is about the code's state
  at request time.
- **200** for an active code:
  `{"code": "rm_acme", "kind": "member" | "channel", "displayName": "Acme"}`.
- **404** with one identical body for every other case: unknown, draft,
  disabled, malformed, or a member record that no longer exists. The response
  never says which.
- Rate-limited like the other public swarm reads. `Cache-Control: public,
  max-age=60`.
- There is no endpoint that lists codes, members or holders.
- **Codes are not secret.** They follow from public handles, and every coded
  deposit puts its code on chain. The lookup's guarantee is that it lists
  nothing, not that active codes cannot be found.
- **A lookup is not eligibility.** An active code can still produce `gift`,
  `already_attributed`, `late` or `ambiguous` for a given deposit, and can be
  disabled before a delayed deposit executes.

## 10. Deposit experience

**Accepted (owner): R13. Client behaviour proposed (technical).** Applies to
every client that attaches codes, including the deposit skill (#1090).

- **Source.** A client uses a code only when the owner of the depositing wallet
  gave it directly. Never from a web page, message, search result, file or
  another agent. With confirmation off, only a code in the owner's instruction
  for that deposit.
- **Check.** The client normalizes the code, checks its format, and calls the
  lookup (§9).
  - Lookup says 404: deposit without a code and say so.
  - Lookup fails (timeout, error): with confirmation on, ask the owner whether
    to proceed without the code; with confirmation off, proceed without it and
    say so.
- **Unsupported path.** If the owner's wallet would deposit on an unsupported
  path (§6.1), the client does not attach the code and tells the owner that a
  verified correction is the way to record the referral.
- **Preview.** The preview names the holder and states that whether the code
  counts is decided after the deposit. It never promises attribution or
  anything that follows from it.
- **Delay.** A Safe deposit can execute long after it is prepared. The code is
  checked at preparation; if it is no longer active at execution, the deposit
  gets `inactive_code`. The Safe batch description names the code so signers
  see it.
- **After the deposit.** The client reports whether a code was attached, and if
  not, why.

## 11. The attribution report

**Accepted (owner): R14. Operation proposed (technical).**

- **Snapshot.** A report is evaluated at one snapshot block S. Periodic reports
  use the last block at or before the end of each calendar quarter (UTC). S must
  be at or below the chain's `finalized` block when the report runs; a fixed
  depth below the head is not treated as finality.
- **Scope.** Every deposit from every registered deployment (§12), from its
  start block through S. Attributions, corrections and their revocations are
  applied as of S (§7.2). Positions are read at S, not at the latest block.
- **Completeness.** A deposit whose transaction, receipt or block cannot be
  read gets `evidence_missing`. A report with any such deposit is marked
  incomplete, lists them, and is not used as final until a rerun completes.
- **Determinism.** The same chain, configuration, correction log and S produce
  the same report, byte for byte. Rows are ordered by effective time (§7.2).
- **Provenance.** Each report records: this spec's revision, the rules version,
  the revision of the code records and of the correction log, the deployments
  read, the chain id, S and its timestamp, the RPC endpoint's host, and the
  generation time.
- **Contents.** For each attributed wallet: holder, code, effective time,
  evidence kind, and positions per vault at S. For each coded deposit and each
  unsupported-path deposit: status and reason. Explanations by wallet and by
  transaction.
- **Current versus historical.** A query about "now" is a separate report with
  its own S, labelled as such. It never overwrites a periodic report.
- **Operation.** The operator runs the periodic report after S is final, and
  keeps the output with its provenance. A full rebuild over all registered
  deployments must finish within a working day on the configured RPC endpoint;
  caching is allowed only if it produces identical output.

## 12. Deployments and legacy

**Accepted (owner): R11. Registry proposed (technical).**

- A **registry** lists every deployment the report reads: name, chain id,
  router, vaults, start block, and an end block once retired.
- core's Deploy 2 rehearsal on Base (router
  `0xb3a8e66d9e2980b54ac0e70e0e236486d1dcb356`, start block 52,484,136) is the
  first entry. The final deployment is **added**, never swapped in.
- Attribution belongs to a wallet across all registered deployments: a wallet
  bound on one deployment stays bound on the next, and its window (§7.4) counts
  its first self-funded deposit on any of them.
- v0 rmUSDC (`0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd`) is not registered.
  Its deposits never count and never start a window. A v0 holder who moves to
  the new vaults is, for referrals, a new depositor.

## 13. Adversarial cases

Each case states the expected outcome. Cases A1 to A8 are the counterexamples
from the 2026-10-16 review of the closed PRs.

| # | Case | Expected outcome |
|---|---|---|
| A1 | Alice's coded deposit call and Bob's uncoded one share a transaction. | Alice's deposit: evaluated with her code. Bob's: uncoded; no status. |
| A2 | An unrelated contract's ERC-8021 suffix sits in the same transaction as an uncoded deposit. | The deposit is uncoded. The suffix is a diagnostic only (§5). |
| A3 | A third party deposits into Alice's wallet; 31 days later Alice makes her first self-funded coded deposit. | The first is `gift` and starts no clock. The second binds: `bound`. |
| A4 | A correction cites an unrelated message, a `0x00` signature and a made-up transaction hash. | Refused: verification fails, and the named deposit does not exist (§8). |
| A5 | A correction binds a wallet to A on day 10; on day 20 the wallet makes a coded deposit with B. | Stays with A. The day-20 deposit is `already_attributed`. Rerunning any report gives the same answer. |
| A6 | A correction recorded on day 50 names a deposit from day 5. | Effective from day 50. Reports with S before day 50 do not show it. |
| A7 | The RPC returns no input for a deposit transaction. | `evidence_missing`; the report is incomplete. Never reported as uncoded. |
| A8 | A report limited to block S reads positions at the latest block. | Not allowed. Positions are read at S (§11). |
| A9 | Mallory calls `depositFor(alice, 1 USDC)` with her own code before Alice deposits. | `gift`; Alice's wallet stays unbound and her window unstarted. |
| A10 | A router deposit with one code funds four vault legs. | All four deposits `bound`, one attribution. |
| A11 | Two deposit calls to the same vault, same receiver and amount, different codes, in one batch. | Both `ambiguous` unless execution order pairs them unambiguously (§6.2). |
| A12 | A Safe deposit is prepared with an active code that is disabled before the Safe executes. | `inactive_code`. |
| A13 | A deposit through an ERC-4337 smart account carries a code. | `unsupported_path`. Remedy: a verified correction. |
| A14 | A wallet's first deposits were on v0, and its first new-vault deposit is 60 days later with a code. | v0 is ignored, so the window starts at the new-vault deposit: `bound`. |
| A15 | A code arrives with an uppercase letter, or with a space inside it. | Uppercase is normalized and matches. A space makes it malformed: `unknown_code`. |
| A16 | A wallet bound on Deploy 2 deposits into the final deployment without a code. | Counts for its holder (R7, §12). |
| A17 | A member's code is disabled; a wallet it bound earlier deposits again. | The wallet stays bound; the new deposit counts for that holder (R6, R7). |
| A18 | An admin schedules a member's new code while the old one is still active, and the intervals overlap. | Refused (§4.4). |

## 14. Delivery boundaries

**Proposed (technical).** Implementation is issue #1371, after this spec is
accepted.

| Surface | Required |
|---|---|
| Code records | Storage with the change rules of §4.2 and the invariants of §4.4, and a history admins can read. |
| Correction log | Append-only storage for corrections and revocations (§8), signature verification for verified corrections, and an admin surface to record them. |
| Public lookup | §9. |
| Admin member view | The member's active, scheduled and past codes (§4.4). |
| Deposit clients | The deposit skill (#1090) per §10, on the supported paths of §6.1. |
| Report | §11 over the registry of §12, with by-wallet and by-transaction explanations. |

**Open for the technical owner:**

1. **Storage.** Code records could stay in configuration changed by PR, which
   gives review and git history. The correction log needs admin writes and
   signature checks, which conflicts with D66 (production data changes only
   through a migration) if it is a table written from the admin surface. Decide
   the storage for each, and record any decision change.
2. **Signature verification.** Verified corrections need secp256k1 recovery and
   EIP-1271 calls in the backend, which has no such library today. Decide the
   dependency.
3. **Matching.** Confirm the pairing rule of §6.2 against real Safe batches and
   router deposits, and whether execution-order pairing is safe.
4. **Finality.** Confirm the `finalized` tag on the configured Base endpoint,
   and the archive reads that positions at S require.
5. **RPC capacity.** On 2026-10-16 the public endpoint refused `eth_getLogs`
   from one host outright. Decide the endpoint the report runs against.
6. **Four-vault backend.** Align the registry with the four-vault work (#1356).

**Launch gates:**

- This spec accepted and merged.
- The referral terms text accepted by the owner.
- One real deposit on each supported path (P1, P2, P3) with a test code that
  only ever tracks a source, each producing the expected status.
- Two report runs at the same S produce identical output.

## 15. History: the closed PRs

These were proposals. They are research material only, not requirements.

| PR | Proposed | Changed here |
|---|---|---|
| #1370 | Suffix encoding and parsing, code config, credit rules | Codes are read per deposit call, not per transaction (§5, §6). The clock starts at the first self-funded deposit, not any deposit (§7.4). Corrections need verified evidence or an explicit override, and take effect when recorded (§8). Code lifecycle made exact (§4). |
| #1372 | Public lookup, admin projection, transaction and receipt reads | Lookup contract kept in substance; normalization made one rule (§4.1, §9). |
| #1385 | Deposit skill attaching codes | Lookup failure no longer silently drops the code when confirmation is on; unsupported paths named (§10). |
| #1386 | Report rebuilt from the chain | Missing evidence is reported, not treated as uncoded; one snapshot block for attributions and positions; finality by `finalized`, not fixed depth (§11). |
