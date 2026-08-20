# Data self-healing — detecting and repairing bad persisted state

> **Status: design proposal — now the single document for this work.** Nothing
> here is ratified in [decisions.md](../decisions.md) — no accepted decision
> backs this document, and that includes **PD10**, whose ratification as a `v4`
> entry is still owed (§9.3). None of the **repair** mechanisms it proposes exists
> in `main` today — but the detectors and guards it builds on partly do (§3), and
> §9's `version` column and daily full-history recompute already exist (§9.2).
> **PR #615 merged 2026-08-15T19:01:49Z** (`7b92a8c`), closing **#614** as
> COMPLETED: the gap detector, the series registry, `remediationClass`,
> `GET /api/admin/gaps`, the `worker/handlers/slot.ts` decline path,
> `'backfilled'` in the wallet provenance union, and the `/performance` seam
> banner are all now in `main`, and every citation of them below was re-verified
> against `main` for this revision. It merges two previously separate plans — a
> wallet/AUM history
> reconstruction project and a continuous source-reconciliation issue — into one
> design so they cannot build two competing repair pipelines, and it now carries
> **both of their full specifications** (§6.4, §6.5) rather than pointing at
> working drafts: the three drafts it absorbed are listed in §3.3 and are no
> longer maintained. Since this document's first draft the wallet plan has been
> **split into three workstreams and most of it filed** (§3.1): the v0.2.2
> release nits as **#647** with subtasks **#639–#646**, the shared chart-axis
> defect with **#624**, and only the backfill capability itself — four code
> issues plus a `decision:` issue — still unfiled. The continuous-reconciliation
> half remains unfiled in every part. **Settled:** the defect taxonomy (§2), the
> three-detector / one-dispatcher shape (§4), the five verdicts (§5), and the
> safety properties of §7.3–§7.6 — these were argued from the audit evidence and
> from code that exists. §7.1 and §7.2 are argued to the same standard but await
> ratification (PD5 and PD4, and for the published-version case PD15). **Open:**
> every scheduling, storage-layout, and API-surface choice, the thirteen open
> items in *Pending decisions* below, and the two genuinely unanswered items in
> §13 (its other two entries are settled residue — #645's resolution and a
> measurement task). **Decided:** the publication model — historical reports are frozen,
> versioned, and published by an explicit admin action (product owner,
> 2026-08-15; PD10 and §9), which is the one part of this document that is
> settled at the product level rather than argued from evidence.
> **Gated:** the Class C archive-read direction depends on a `decision:` issue
> that **has still not been filed** (re-checked against `gh issue list` on
> 2026-08-15: no `decision:` issue for archive-capable reads exists); three
> recorded decisions currently read as asserting that data is unreachable, and
> nothing in §6.3 or §6.5 (§6.5.3 excepted — it makes no archive read) should be
> built until that is settled — **PD1**. Where
> a claim below could not be verified against this checkout it is marked
> *unverified* inline.

## Contents

- **Pending decisions** — the PD1–PD15 register, with a summary table
- **§1 Purpose** — what "self-healing" means here, and its scope boundary
- **§2 The defect taxonomy** — the four ways persisted state can be wrong
- **§3 What exists today** — current mechanisms and their blind spots
- **§4 Architecture** — three detectors, one dispatcher, per-class executors
- **§5 The five verdicts** — the pure classifier
- **§6 Per-class treatment** — Classes A/B/C, the two specifications, sequencing
- **§7 Safety properties** — append-only, quarantine, guards, provenance
- **§8 Disclosure of corrections** — revision log, audiences, amplification
- **§9 Frozen, versioned publication** — the decided model
- **§10 The silent-zero defect class**
- **§11 Constraints inherited from the existing system**
- **§12 What will remain imperfect**
- **§13 Open questions and settled residue**
- **§14 Provenance of the claims in this document**

## Pending decisions

Thirteen choices are outstanding and two are settled. None of them is an
implementation detail that can be decided inside a pull request. They are
numbered **PD1–PD15** and referenced by those tags throughout the rest of the
document. Each states what must be decided, what is blocked until it is, the
options with their consequences, and a recommendation. The landscape first, in
one table; the detail follows.

| PD | Question | Status | Recommendation |
|---|---|---|---|
| PD1 | File the archive-read `decision:` issue? | FILED — **#709**, awaiting resolution | File it |
| PD2 | D16: clarifying note, or superseding ADR? | OPEN | Clarifying cross-reference |
| PD3 | How to record the Open Question 9 reversal? | OPEN | New `decisions.md` entry |
| PD4 | Is quarantine compatible with D16's closed enumeration? | OPEN | Ratify the presentation-only reading |
| PD5 | What does "append-only" permit? | OPEN | Ratify the §7.1 reading |
| PD6 | RPC budget: backfill vs the live sampler | OPEN | Keyed provider |
| PD7 | SP500 in the backfill? | OPEN | Skip, do not approximate |
| PD8 | Fill the two seed-omission days? | OPEN | Leave them |
| PD9 | Who builds the remediation dispatcher? | OPEN | The Class A reconciler |
| PD10 | Restate, or freeze, published reports? | DECIDED | Frozen, versioned, publish-gated; ratify as `v4` |
| PD11 | Version granularity | OPEN | Whole snapshot series |
| PD12 | Retain and serve superseded versions? | OPEN | Retain unbounded |
| PD13 | Candidate recompute: scheduled, or on demand? | OPEN | Scheduled, never auto-publishing |
| PD14 | Is the version always displayed? | DECIDED (§9.1) | Always displayed |
| PD15 | A published version built on later-quarantined data? | OPEN | Serve with a correction banner |

**PD10 is DECIDED** — the product owner settled the restate-versus-freeze
question on 2026-08-15 in favour of frozen, versioned publication with an
explicit publish gate. It stays in this register so the decision is visible, and
it is marked resolved so nobody re-opens it. Its model is §9; PD11–PD13 are the
sub-questions it does **not** settle, and PD15 is the retrospective question its
own model opens. PD14 is settled by the decision's own statement (§9.1).

The rest are not equally urgent, and the shape of the dependency matters:

- **PD1 blocks code.** Three of §6.5's four unfiled issues cannot start until it
  lands; §6.5.3 is the exception, because it makes no archive read.
- **PD2 and PD3 block nothing today, and surface as a reviewer's objection at
  merge time** — the most expensive moment — if left unresolved. Each is a
  recorded statement that the design contradicts or extends.
- **PD4 and PD5 gate identified halves of the reconciler**, stated precisely in
  §6.4: PD5 gates its mutating half (the quarantine executor and storage) and
  PD4 its operator-facing surface. Both therefore block the first repair
  executor — specifically, not vaguely — while the detection, classification,
  and alerting halves proceed.
- **PD6 and PD9 are shape decisions that get more expensive with delay.** PD6
  fixes the RPC budget before a limiter is written; PD9 names the dispatcher's
  owner before two of them exist. Both are cheap to honour up front and mean
  rework afterwards — and PD6 additionally carries a spend question that only its
  recommended option answers.
- **PD7 and PD8 are scoping judgements** on individual series; both are cheap,
  and both default to *do less*.
- **PD11 and PD12 are schema decisions and must be taken before the migration
  is written**, since both change what a row's key is. PD13 is cheap and
  reversible, and is listed only so it is chosen rather than defaulted; PD14 is
  closed, because §9.1's decided model already answers it.
- **PD15 is a product-level question** opened by PD10's own model, and it awaits
  the product owner the way PD10 did.

### PD1 — File the `decision:` issue for archive-capable chain reads

**What must be decided.** Whether the backend may pass a historical block tag on
RPC reads it already issues, in order to reconstruct chain-derived history.

**Blocked until it is.** The whole of §6.3 and three of the four work items in
§6.5 — block-addressable reads (§6.5.1), historical price resolution (§6.5.2),
and the repair driver (§6.5.4). §6.5.3, the RPC batching and rate limiting, is
**not** blocked: it makes no archive read and independently improves the live
path. That is the archive-specific backfill workstream, and it is the only work
this decision blocks: the Class A reconciler (§6.4) makes no chain read and is
independent of the outcome either way.

**Status — FILED as #709 (2026-08-20), awaiting resolution.** It carries the
argument below, the scope fence (no indexer, no new vendor, no standing
reconciliation loop, no independent RPC limiter, no live-path change), and the
required failure semantics. What it still owes is the decision itself: an
explicit approve/reject in the issue, and — on approval — a `docs/decisions.md`
entry that also settles **PD2** (D16 clarification) and **PD3** (the
Open-Question-9 reversal). Until that entry exists the implementation stands on
an unratified premise, and should be read that way.

**Verified state at filing time.** Re-checked with `gh issue list` on
2026-08-15: **no `decision:` issue for archive-capable reads existed.** The open
`decision:` issues were **#623** (docs-diff whitespace CI check) and **#629**
(Cloudflare dashboard access); the closed ones are #621, #583, #524, #520, #502,
#447, #342, #228, #163, #145, and #99. None concerns chain reads.

**Why it is a decision and not a task.** Three recorded statements currently read
as asserting this data is unreachable, so an implementer who simply writes the
code is contradicting the written record in three places at once:

1. **D16** rejects *"An archive indexer to reconstruct gap-free pre-launch
   history"* as *"explicitly out of scope for #84"* (`docs/decisions.md:368-371`).
2. `backend/src/chain/token-prices.ts:10-15` states historical valuation comes
   from the persisted `wallet_balance_samples` series, *"NOT from a re-fetched
   OHLCV series, which resolves Open Question 9"*.
3. **#294**'s out-of-scope list — *"the indexer accumulates forward only."*
   *(unverified here — issue text, not re-read in this checkout.)*

**The counter-argument to put to the decision.** An archive *indexer* means
ingesting and persisting chain history yourself. What §6.5.1 proposes is a block
tag on reads the app already makes, against a node that already answers — no
indexer, no new vendor, no new persisted chain events, and no change whatsoever
to any caller that keeps reading `latest`. The empirical basis is in §6.3:
`https://mainnet.base.org`, the default `BASE_RPC_URL`, answers archive state
queries at 40 / 90 / 180 / 365-day depth, and returns a correct `"0x"` rather
than a `latest` fallback at a pre-deployment block.

**Options.**

- **File it, settle it, then build** — one issue of cost, and it converts three
  standing contradictions into one recorded position. It also forces the
  distinction the work depends on (PD2): read-only historical *reads* versus
  writing archive-derived rows into `wallet_balance_samples`.
- **Build first and record afterwards** — cheapest this week and the most
  expensive later. Three decisions contradict the work, so the change arrives at
  review with the written record against it; the likely outcome is the work is
  blocked at merge, which is where it is hardest to unwind.
- **Abandon Class C repair and disclose the hole permanently** — coherent, but
  it makes the AUM gap (42 days as of 2026-08-15) permanent *and* growing: the
  hole's width is (DB bootstrap date) − 2026-06-26, so it re-opens wider on
  every database rebuild (§3.2).

**Recommendation: file it.** It is the single unfiled prerequisite in front of
three issues, its cost is one issue body, and the argument for it is already
written (above, and §6.3). Filing it also produces the artifact PD2 and PD3
need, since the decision issue is the natural place to record both the D16
clarification and the Open-Question-9 reversal.

### PD2 — D16: a clarifying cross-reference, or a superseding entry?

**What must be decided.** Whether D16 needs only a clarifying note, or a real
superseding ADR.

**Blocked until it is.** Nothing immediately — but §6.5.4's repair driver writes
rows into `wallet_balance_samples`, and that is precisely the operation whose
legitimacy turns on the answer. Deciding late means deciding under deadline.

**Options and consequences.**

- **A clarifying cross-reference on D16.** D16's rejection names a *component* —
  *"an archive indexer to reconstruct gap-free pre-launch history"* — and scopes
  it *"explicitly out of scope for #84"* (`docs/decisions.md:368-371`). A block
  tag on reads the app already issues is not that component. What the 2026-08-15
  archive finding actually contests is the **unstated premise** inside *"a full
  indexer is more machinery than the feature needs"*: namely that reaching this
  data requires a full indexer at all. Saying so is a clarification, and it costs
  a paragraph.
- **A superseding entry.** Heavier, and it overstates what changed: D16's
  reasoning about #84's scope was correct on its own terms and is not being
  reversed.

**Recommendation: a clarifying cross-reference** — on the reasoning above, which
is already the position this document has argued since its first draft.

**The threshold that flips this, stated so it is not crossed by accident.** Using
historical reads to **backfill `wallet_balance_samples`** does need a real ADR,
because D16 commits that table to a specific shape (`docs/decisions.md:339-345`):
*"seeded once with a pre-launch history backfilled from the retired baked
constants (`chain/wallet-history-seed.ts`, marked `provenance: 'seed'`, never
`'live'`)"*, then accumulated forward by the per-minute sampler. Writing
archive-derived rows into it changes both the seeded-once-then-accumulate-forward
shape and the `provenance: 'seed'` labelling contract. **Read-only gap detection
using historical reads does not cross that threshold** — it writes nothing and
changes no committed shape, so it can proceed on the clarification alone.

### PD3 — "Open Question 9" needs a new decision entry, because it has no canonical record

**What must be decided.** How to record the reversal of a resolution that exists
nowhere except a source comment.

**Blocked until it is.** §6.5.2, historical price resolution — the one work item
that genuinely reverses the recorded position rather than clarifying it.

**The problem.** `grep -rn "Open Question" docs/` returns nothing but this
document. Open Question 9's resolution lives at exactly one place in the repo:
`backend/src/chain/token-prices.ts:10-15`, asserting historical valuation comes
from persisted samples *"NOT from a re-fetched OHLCV series, which resolves Open
Question 9"*. So a historical price resolver **cannot be recorded as superseding
any numbered decision, because there is no numbered decision to supersede.**

**Options.**

- **A new decision entry in `decisions.md`** that states the position, cites the
  comment it displaces, and gives the reason (the OHLCV endpoint does reach back
  far enough for the target window; §6.5.2). Costs a paragraph, and leaves the
  repo with a canonical record where it currently has none.
- **Amend only the source comment.** Cheaper, and it recreates the exact defect:
  a load-bearing position recorded in one comment that no `docs/` reader can
  find.
- **Fold it into PD1's issue and never promote it to `decisions.md`.** An issue
  is not canon; the next reader greps `docs/` and finds the old position.

**Recommendation: a new decision entry**, and a hard requirement on any change
that reverses it — **it must edit `token-prices.ts:10-15` in the same diff.**
Leaving that comment intact leaves an actively false statement at the exact spot
a future reader will consult when asking whether historical prices may be
re-fetched. The comment's stated reason (*"GeckoTerminal OHLCV may not reach back
to Mar 18 for illiquid ROBOTMONEY/BNKR"*) is an empirical claim, and §6.5.2's
measured ~6-month server window is the evidence that decides it.

### PD4 — D16's honesty enumeration is closed; a quarantined row is a fourth state

**What must be decided.** Whether quarantine (§7.2) is compatible with D16's
enumeration as written, or requires that enumeration to be extended.

**Blocked until it is.** Nothing in the storage layer, but the reconciler's
whole operator-facing surface — anything that would *show* what was quarantined
(§6.4 states the reconciler's gating precisely).

**The tension, and the evidence.** D16 states the honesty invariant as a
**closed list** of three admitted states, and a quarantined row is a fourth
thing the list does not admit. The full quotation, the presentation-only
reading, and its consequences are stated once, in **§11**'s D15/D16 bullet —
this register entry carries the decision and points there for the argument.

**Options.**

- **Ratify the presentation-only reading** (§11): the enumeration governs what
  is *presented*; a quarantined row is excluded from every candidate computation
  and read path, so it is not presented as anything; a `revised` row needs no
  accommodation, being a real read. Cost: one sentence of ratification. Risk:
  the reading is only sound while the exclusion is total.
- **Extend the enumeration by a decision entry now.** More durable, and it
  pre-authorizes an operator surface nobody has yet designed — which is how
  enumerations acquire states that never ship.

**Recommendation: ratify the presentation-only reading**, and treat the second
option as **required, not optional, the moment a quarantined row reaches a
DTO** — an operator surface listing what was quarantined, or a per-point flag
that survives into a chart payload. At that point it is being presented, the
read-path-exclusion argument evaporates, and the enumeration must be extended in
a decision entry **first**, not in the same PR that ships the renderer.

**Scope qualifier — the argument holds prospectively only.** The
presentation-only reading covers rows quarantined *before* they reach any
published version. It does not cover the retrospective case: a version already
**published** from figures computed with the row, then retained and served
under PD12, keeps presenting figures derived from it — there the exclusion is
not total, and the reading above does not apply. That case is **PD15**, and
ratifying PD4 does not settle it.

### PD5 — Ratify what "append-only" means before quarantine is built

**What must be decided.** Whether removing a row from the read path is compatible
with the append-only invariant, explicitly, rather than by implication.

**Blocked until it is.** §7.2's quarantine storage, and therefore the `fabricated`
verdict's executor — which is to say, the half of the reconciler that mutates
anything.

**The tension, and the evidence.** `raw-history-store.ts:1-6` makes
never-deleting the **stated basis of the honesty guarantee**, not a mere
description. The verbatim quotation, the four observations that resolve the
tension, the `--purge` shipped precedent, and the stale-`architecture.md` note
are all stated once, in **§7.1** — this register entry carries the decision and
points there for the argument.

**Options.**

- **Ratify the reading §7.1 argues.** The comment's justification is a threat
  model about an *absent answer*, not a universal retention rule: the harm it
  names is a failed or empty fetch erasing real history. Quarantining a
  calendar-invalid row serves that goal rather than violating it, because those
  rows are the synthetic data the comment defends against. Cheap, and it leaves
  the executed guard (`backend/tests/analytics-suite.test.ts:148`) untouched and
  binding.
- **Rewrite the comment and the invariant.** Heavier, and it risks weakening the
  guarantee that is actually load-bearing.
- **Leave it implicit.** The cheapest today, and it guarantees the argument is
  re-litigated in review of the first PR that deletes anything.

**PD10 lowers the stakes here without removing them.** Under frozen publication a
repair to the raw floor no longer silently moves a published number — it moves a
*candidate*, which someone must choose to publish. That removes the reader-facing
harm; it does not remove the storage-layer question, which is what this item is
about.

**Recommendation: ratify the §7.1 reading**, on the two pieces of evidence §7.1
lays out with their `path:line` anchors: the `--purge` shipped precedent (#616 —
a merged, guarded, non-additive floor rewrite of which quarantine is a strictly
weaker operation), and the fact that `docs/architecture.md:780-787` still
describes the pre-`--purge` behaviour. **Whoever ratifies should file the
architecture.md correction in the same breath**; this document does not edit it.

The hard invariant that survives either way, and must be stated in the ratifying
text: **an empty or failed fetch must still never remove anything** — the
two-condition `fabricated` rule and the degenerate-window rule that enforce it
are §5 and §7.3.

### PD6 — Class C continuous reconciliation needs an RPC budget decision

**What must be decided.** How the backfill's RPC consumption coexists with the
live per-minute sampler — and, downstream of that, whether Class C ever gets a
standing verifier or only a bounded one-time executor.

**Blocked until it is.** §6.5.3's limiter design, and the sizing of any
production backfill run. Getting this wrong does not merely slow the backfill: it
**causes new gaps while fixing old ones**, by 429-ing the live sampler.

**The measured constraint** (§6.3; measured from a developer IP, **not**
re-measured from the production droplet — see the closing note of this item): a ~**5-token bucket refilling at
~0.55 calls/s**, metered **per-IP at the provider** and **per sub-call, not per
HTTP request**. The live sampler consumes ~0.033 calls/s (~6%), so a backfill run
at the full 0.55/s leaves it zero headroom. In-process isolation cannot create
budget, because the limit is not in our process.

**Options, and what each costs.**

- **A separate `BASE_RPC_BACKFILL_URL` on a keyed provider.** The only *true*
  isolation — a different key is a different bucket, so the sampler is untouched
  by construction and Class C becomes eligible for a standing verifier rather
  than a one-shot run. Cost: a spend decision, plus one env var that must be
  genuinely deliverable (§10.1 — a variable absent from the compose
  `environment:` allowlist never reaches the container, so this one fails
  silently if added carelessly).
- **One shared priority-aware bucket**, sampler requests pre-empting, backfill
  capped below ~0.4 calls/s. No spend, and it is the more complex code: a
  priority queue in front of the transport, correct under concurrency, with the
  sampler's latency now coupled to backfill scheduling. A full-gap sweep also
  takes proportionally longer.
- **An offline sampler-quiet window.** No spend and no new code, but it requires
  an operator to stop and restart the sampler around the run, which reintroduces
  exactly the "someone remembers to run a script" property §1 rules out — and
  the quiet window is itself a gap in the live series.

**The hard warning, which applies to all three: never give the backfill its own
independent limiter.** The full statement — why two limiters against one per-IP
bucket sum to 2× and guarantee 429s, and why today's gate bounds *concurrency*
and not *rate* (the 2026-08-10 429 storm) — is stated once, with its `path:line`
anchors, in **§6.5.3**.

**Recommendation: the keyed provider.** It is the only option that makes the
sampler safe by construction rather than by tuning, it is the one that converts
Class C from "repairable once" into "continuously verifiable" — and a chain read
at a pinned immutable block is in principle the most deterministically verifiable
data in the system (§6.3). The other two options are contingency plans if the
spend is refused, and of those, the shared priority-aware bucket is preferable to
the quiet window because it does not require an operator in the loop.

**Before sizing any run**, re-measure from the production droplet. The ~5-token /
~0.55-per-second figures were measured from a different IP; shared NAT could make
production strictly worse, and every cost conclusion in §6.3 and §6.5.3 depends
on them.

### PD7 — SP500 in the backfill: skip, or approximate?

**What must be decided.** Whether the SP500 leg is included when chain-derived
history is reconstructed.

**Blocked until it is.** §6.5.2's scope, and §6.5.4's per-day completeness rule —
a day is atomic (§7.5), so "which legs must be present for a day to count" has to
be settled before the driver is written.

**The asymmetry that decides it.** The *price* is recoverable: `fetchYahoo(symbol,
startUnix, endUnix, timeoutMs)` (`backend/src/analytics/extract/yahoo.ts:44`)
already takes a range. The *position size* is not: it is the committed
`SP500_SIZE` constant (`backend/src/config.ts`, since #641), a single
present-tense value with no history and no positions API to derive one from. Multiplying
today's size by a past price does not approximate a past value — it **fabricates
a quantity** and then presents it beside genuinely-read legs.

**Options.** Skip the leg and leave the day's SP500 value absent; or synthesize
`today's size × historical price` and label it. The second produces a number that
is wrong in an unbounded and unknowable way (the size has changed however many
times it has changed), and §10's whole argument is that a plausible fabricated
value is worse than an absent one.

**Recommendation: skip, do not approximate.** Two further facts support it. A
365-day `^GSPC` call returned 252 points, so weekends and holidays are absent and
would need forward-filling on top of the fabricated quantity. And **#648** (OPEN)
records that the SP500 column is *already* a splice of two different
measurements — v0 derived it from a Hyperliquid perpetual, v1 from Yahoo
`^GSPC` via `resolveSp500().ticker` (consumed at `token-prices.ts:270`) — with
the parity report marking it PROVEN-DIFFERENT and noting *"No decision record
found."* Backfilling a third derivation into a column whose existing two are
unreconciled compounds the problem it would appear to fix. #648's own body
already states the backfill is out of scope for this reason.

### PD8 — The two seed-omission days: leave them, or interpolate?

**What must be decided.** Whether `2026-03-24` and `2026-06-04` are filled.

**Blocked until it is.** Nothing — this is the smallest item here, and it is
listed because the source plan explicitly flags it as a judgement call rather
than a correctness question, which means it will otherwise be decided silently by
whoever writes the driver.

**The facts.** They are literal omissions from the seed constant: `LABELS` in
`backend/src/chain/wallet-history-seed.ts:17` jumps `"Mar 23","Mar 25"` and
`"Jun 3","Jun 5"`. They were already missing in the v0 source the seed was ported
from, so nothing was lost in the port. The surrounding days are unreconciled
baked UI constants, so splicing archive-derived values between them mixes two
incompatible bases.

**Options.** Leave them absent, and let #615's merged dense calendar render them
as a two-day break; or interpolate from neighbours and label the result `'seed'`.

**Recommendation: leave them.** Three reasons, in increasing weight. Two days out
of a 146-day window render as a hairline break, not a visible defect. An
interpolated row labelled `'seed'` would be **indistinguishable from the ~99
genuine v0 observations that carry the same label** — #645 established those are
real production wallet-balance cron output, not fabrications (§13), so
introducing one synthetic `'seed'` row destroys the one property that currently
makes that label trustworthy. And the composition of that same seeded span is
itself under review in **#648** (PD7): interpolating across a series whose
instrument definition is an open question is fabricating on top of an unresolved
base. If the break is ever judged unacceptable cosmetically, the honest fix is a
new provenance value handled per §7.6 — not a `'seed'` row that is not seed data.

### PD9 — Who builds the remediation dispatcher

**What must be decided.** Which workstream owns building the single dispatcher,
and how the other is bound to consume it.

**Blocked until it is.** Nothing blocks — which is the hazard. Both workstreams
independently propose wiring `remediationClass` to something that repairs (§4),
so absent a decision the default outcome is two dispatchers with two different
notions of what a repair is, and a blast-radius guard implemented twice and
differently.

**Options.**

- **The Class A reconciler (§6.4) builds it.** It is the only one of the two
  that can start today: PD1 gates the backfill and does not gate the reconciler
  (whose own gating — PD5 on its mutating half, PD4 on its operator surface — is
  stated in §6.4 and does not block a dispatcher). If the reconciler builds the
  dispatcher, the schedule risk is zero.
- **The repair driver (§6.5.4) builds it.** Defensible on the grounds that Class
  C's needs are the more demanding, but it is gated on PD1, so the dispatcher
  inherits that gate — and the reconciler, which is ready to proceed, either
  waits or forks one.
- **A standalone dispatcher issue up front.** Clean in principle; in practice it
  means specifying a dispatch interface with no executor to test it against,
  which is how a mechanism ships unwired — the failure mode §3 documents this
  codebase repeating.

**Recommendation: assign it to the Class A reconciler**, because it is ungated
on PD1 and can start now, and bind the second issue explicitly. The rule that must
appear **in the issue body of whichever is filed second**: *consumes the existing
dispatcher; must not add a parallel one.* If circumstances invert the ordering,
the rule follows the ordering rather than the workstream — whichever lands first
builds the dispatcher, generically enough for the other to plug into. If the
repair driver does land first, the reconciler contributes a divergence trigger
plus the five-verdict classifier and consumes the dispatcher unchanged.

### PD10 — DECIDED: frozen, versioned publication with an explicit publish gate

**Status: decided by the product owner, 2026-08-15.** Recorded here so it is not
mistaken for an open question; the full treatment is §9.

**The question it answers.** Whether a published historical figure may be
restated silently when reconciliation, repair, or recomputation changes it. The
answer is no: **historical reports are frozen.**

**The decided model.** Published figures do not change under readers. Reports are
versioned and the version is displayed. An admin may refresh calculations, which
computes a **next** version; computing it does **not** publish it, and publishing
is a separate explicit admin action. A newly computed version identical to the
prior one is a **noop** — equivalent to a passing audit, and the normal expected
outcome.

**What this unblocks.** §8.2 and §8.3: a restatement signal for API consumers, a
version to show dashboard readers, and a diff that expresses a correction at the
level of the published figure rather than the raw row — both largely
impracticable without it. It does **not** unblock (and is not needed by) §8.1:
the revision log is a prerequisite of quarantine itself, independent of
publication — §7.2 and §6.4 both state it must not be deferred.

**Remaining recommendation, since the decision itself is settled: ratify it as a
`docs/decisions.md` entry tagged v4.** Today `version` is a *methodology* tag and
v3 explicitly disclaims freezing (`regime-versions.ts:1-7`), so this changes what
a published number means and is not a mere workflow addition. Recording it only
in this document would recreate the PD3 problem — a load-bearing position with no
canonical record — and the entry must edit the `regime-versions.ts` comment in
the same diff, or the repo ships a `v4` whose own version file still says there
is no frozen lockout. Reasoning and evidence: §9.3.

**Adjustments this decision makes elsewhere in this register.** It strengthens
PD4 prospectively (a row quarantined before publication is doubly unpresented —
excluded from every candidate computation *and* unable to move a published
figure until a publish action), while its own retention model opens the
retrospective case PD4 cannot cover — a version already published from the row,
which is **PD15**. And it lowers, without removing, the risk PD5 weighs (a
repair to the raw floor no longer silently moves published numbers).

### PD11 — Version granularity: whole snapshot series, or per-series?

**What must be decided.** Whether a version identifies one publication of the
whole regime snapshot history, or is tracked independently per series.

**Blocked until it is.** The migration. This decides the table's key, so it
cannot be deferred past the schema change §9.2 already requires.

**Options.**

- **Whole snapshot series** — one version per publication, covering every figure
  in that publication.
- **Per-series versions** — each indicator or panel carries its own.

**Recommendation: whole snapshot series.** Two reasons, both structural rather
than aesthetic. First, §8.3: a single raw revision moves the indicator
percentile, the panel index, the composite, and potentially the regime label
together, because they are one fold and not independent computations —
per-series versioning would fragment one logical restatement into many and make
*"which version was I reading"* unanswerable for any composite figure, which is
the figure readers actually cite. Second, it does not match the storage shape:
`regime_snapshots` holds one row per date carrying every panel
(`backend/migrations/0002_dashboards.sql:52-62` plus 0009's added columns), so
per-series versions would require decomposing a table that is deliberately
row-per-date. Per-series versioning is the right answer only for series that are
computed independently, and these are not.

### PD12 — Are superseded versions retained and served?

**What must be decided.** Whether a version that has been replaced remains
resolvable, and whether it is served.

**Blocked until it is.** The same migration as PD11, and §9.4's resolvability
property — which does not hold at all if the answer is no.

**The constraint.** `regime_snapshots` **cannot currently hold two versions of
the same date** — the schema evidence is §9.2. Retention is a schema change
either way: a wider key, or a separate published-versions table.

**Options.** Retain and serve every published version; retain a bounded number
(the N most recent) and serve those; or retain only the current one and keep the
diff.

**Recommendation: retain and serve every published version, unbounded.** An
external citation of a figure — in a report, a post, another system's stored
copy — is meaningful only if the version it was read under can still be resolved
to the figures it published (§9.4); retaining only the current version makes
every prior citation unverifiable, which forfeits most of what freezing buys.
**Bounding to the N most recent self-defeats on the same argument**: a citation
older than N becomes unresolvable, and §9.4 states resolvability
unconditionally. The growth concern does not justify it: the storage cost is one
full history per *publication*, and publication is gated behind a deliberate
admin action, so growth is a function of how often someone chooses to publish —
rare by construction — not of how often anything recomputes. If retention is
ever bounded anyway, the eviction needs an explicit contract — a **tombstone**
that identifies a published-then-evicted version, never a 404 and never a silent
fall-through to current figures — and §9.4's resolvability property must be
weakened to match, in the same change. Retaining only the diff is the false
economy: reconstructing a historical figure by replaying diffs is exactly the
forensics exercise §8.1 argues against building later instead of recording now.

**Interaction with PD15.** A retained superseded version is exactly the artifact
PD15 is about: whatever is retained and served must also carry the correction
state PD15 decides, so the two must be settled compatibly — retention without a
correction marker is option (a) of PD15 by default.

### PD13 — Does the candidate recompute run on a schedule, or only on demand?

**What must be decided.** Whether the next-version computation is triggered by a
cron or only by an admin.

**Blocked until it is.** Nothing structural — but it decides whether §9.4's
noop-as-audit is a standing check or an occasional one, which is the difference
between the two things §1 distinguishes.

**Options.** Scheduled candidate recompute with diffing, never auto-publishing;
or admin-triggered only.

**Recommendation: scheduled, and never auto-publishing.** A scheduled candidate
diff *is* the audit (§9.4), and it is the only mechanism in this design that
covers the computation layer at all. An on-demand-only recompute runs when
someone already suspects something, which makes it *"a tool that would find the
defect if someone ran it"* — a forensics aid rather than self-healing, in the
terms of §1's **detection** property. The appeal is to that property alone, and
deliberately not to §1's whole definition: §1's scope boundary places
*publication* outside the operator-free claim, so the human publish gate does
not count against the scheduled option — it is the standing *comparison* that
must not depend on an operator remembering to run it. The incremental cost is
close to zero, because the full-history recompute **already runs daily**:
`regime-versions.ts:1-7` states that under v3 *"every run recomputes the full
history on best-available raw data"*. If the candidate producer is a new
producer kind, it must join the producer's armed-schedule liveness check — the
requirement, with its `path:line` anchor and the scheduler-wedge failure class
it guards against, is stated once in §6.4's scope list.

### PD14 — DECIDED by §9.1: the version is always displayed

**Status: closed as decided, not open.** §9.1's decided model states
unconditionally that reports are versioned *"and the version is DISPLAYED"* —
the product owner's statement carries no once-more-than-one-exists qualifier,
and a policy that hides the tag until a second version exists would be a
different model from the one that was decided. An earlier draft listed this as
an open display-policy choice; it re-opened a settled point, and it is kept in
the register only so the question is visibly answered rather than silently
dropped.

The rationale, kept as commentary because it explains why the unconditional
reading is also the right one: showing the tag conditionally means the UI's
*shape* changes at the first restatement, simultaneously with its numbers — at
exactly the moment a reader most needs the surface to be stable and the change
to be attributable to data rather than to the page. It also makes "no version
shown" ambiguous between "there is only one" and "this surface is unversioned",
which is the same failure mode as §7.6's unrecognised provenance rendering as
ordinary live data: absence of a marker reading as a positive claim. The cost of
always showing it is one label.

### PD15 — What happens to a version already published from data later quarantined?

**Status: OPEN — a product-level question, and it awaits the product owner the
way PD10 did.** It is the one honesty question PD10's model creates rather than
solves.

**What must be decided.** A version is published. The reconciler later
quarantines, as `fabricated`, a raw row that version's figures were computed
from. The version is frozen (PD10) and — per PD12's recommendation — retained
and served. What does a reader who resolves that version now see?

**Why the register needs it: PD4 and PD12 are mutually incompatible as
written.** PD4's D16 argument rests on *a quarantined row is excluded from every
read path, so it is never presented as anything*. PD12 recommends retaining and
serving superseded versions. A superseded version computed **with** the
fabricated row keeps presenting figures derived from it — the exclusion is not
total, and PD4's presentation-only reading covers only the prospective case
(PD4's own scope qualifier). Freezing cuts both ways: it protects readers from
silent change, and it protects a wrong figure from correction.

**Options.**

- **(a) Leave the version frozen and unannotated.** Maximally stable, and
  simplest — and it knowingly continues to serve a figure the system has since
  proven wrong, with nothing at the point of the number to say so. That is the
  §8 honesty failure in its most deliberate form.
- **(b) Serve it with a correction notice pointing at the superseding
  version.** The frozen figures themselves stay byte-stable, so external
  citations still resolve; the reader is told, at the point of the number, that
  the figure has been superseded and why (the §8.1 revision records supply the
  why). This is the same in-place disclosure discipline §8.2 requires, in the
  seam-banner vocabulary rather than a new one.
- **(c) Withdraw the version from resolution.** Honest about the defect, and it
  breaks every external citation of that version — the exact property §9.4
  names as the point of retention, and the failure PD12's tombstone contract
  exists to avoid.

**Recommendation: (b).** It is the only option that preserves both properties at
once — the citation remains resolvable, and the error is admitted where the
number is read. The decision is the product owner's to take, because it trades
directly against PD10's "published figures do not change under readers"
guarantee: the figures still do not change, but the *page* around them does.

## 1. Purpose

**Self-healing** here means one specific thing, and not a looser one: *the
system notices that its own persisted state disagrees with reality, and repairs
it, without an operator remembering to run a script.* Three properties are load-
bearing in that sentence.

- **Notices.** The comparison is performed on a standing schedule, not on
  demand. A tool that would find the defect if someone ran it is not
  self-healing; it is a forensics aid.
- **Its own persisted state.** The subject is what is already in the database,
  not what is about to be written. Write-time validation cannot repair a row
  that was written correctly under a rule we later discovered was wrong.
- **Repairs.** Detection that dead-ends at a read-only report is not healing.
  This is the specific failure the repo keeps repeating (§3).

One scope boundary belongs in this definition, because PD13 leans on it and
because the design's own publication layer would otherwise violate it: the
operator-free property applies to **detection** and to **repair of persisted
state**. It deliberately does not extend to **publication** of corrected
figures, which is human-gated under the decided model (PD10, §9) — freezing is a
product guarantee to readers, and it outranks automation. A repaired candidate
waiting on an explicit publish action is not a forensics aid in the sense the
first bullet rules out: the standing comparison still runs and still alarms on
its own schedule; only the reader-facing restatement waits for a human.

The requirement driving this is that **bad data may be ingested through our own
bug or a vendor's**, so correctness cannot rest on write-time care alone. That
is not hypothetical. The originating audit,
[`docs/code-review/20260814-review-data-integrity-macro-index-discrepancy.md`](../code-review/20260814-review-data-integrity-macro-index-discrepancy.md),
documents a defect in v0 (`agentjuno/robotmoney`) where the pipeline persisted
its own forward-filled values back into its raw floor and read them next run as
genuine source observations. Because FRED never re-publishes weekends and
non-publication days, the fabricated rows could never be corrected by any
subsequent fetch: the merge contract is *fetched wins on overlap*, and there was
never an overlap. The audit's finding **D1** rates this CRITICAL and measures
its effect — the macro index moved `0.610602 → 0.653632` when the input floor
alone was source-date-cleaned, with `ICSA` contributing `+0.039932` of the
`0.046607` v1-v0 gap in the first captured run.

v1's storage shape is structurally immune to that particular feedback loop: it
persists sparse real observations and forward-fills at read time. But **D6**
records that v1's vendored floor-seed fixture inherited 110 source-absent `ICSA`
keys and 14 source-absent `DXY` keys from v0's floor, and that the DB-rows-win
seed path retains them indefinitely, because refresh has no matching key to
overwrite. Immunity to the *mechanism* did not confer immunity to the *data*.

And **D5** (MEDIUM, both repos) states the gap this document exists to close:
*"No cross-implementation reconciliation check; a 0.05 divergence ran
undetected."* Its three recommendations — a freshness assertion against source,
a reconciliation job, and a testable persisted-floor invariant — were never
filed as issues.

## 2. The defect taxonomy

Persisted state can be wrong in four distinct ways. They are separated here
because **three of the four need a different detector each, and the fourth needs
a label rather than a detector** — and conflating them is how a self-healer
becomes a self-destroyer.

| Class | Shape | Canonical instance | Detector needed |
|---|---|---|---|
| **Absent** | the row should exist and does not | 42 missing AUM days on `/performance` | gap detector — enumerate expected keys, diff against persisted |
| **Structurally impossible** | a row exists on a date the source could never publish | v0's ICSA rows on non-Saturdays; DXY weekend rows (D1) | calendar validator — pure, offline, needs no network |
| **Present and wrong** | right shape, right date, wrong value | a vendor revision we never re-fetched; a correctly-labelled `live` row carrying a stale carry | source reconciler — re-fetch and compare key-by-key |
| **Unverifiable** | outside what the source can still re-serve | `HY_OAS` pre-history (D7): FRED serves `BAMLH0A0HYM2` only as a trailing ~3y window, and the `cosd=2010` workaround does not work for this series | none possible — disclose, never repair |

The state of play is uneven and worth stating bluntly:

- **Absent** has partial machinery: a gap detector is merged in `main`
  (`backend/src/ops/gap-detector.ts`), read-only, with no repair path.
- **Structurally impossible** has partial machinery: a calendar validator is
  merged, but runs offline against a committed fixture and classifies most of
  the registry as unconstrained.
- **Present and wrong** has **none**. Nothing in this repo ever re-asks a source
  about a date it already gave us. A persisted row that is present,
  calendar-valid, and simply wrong is invisible forever.
- **Unverifiable** has no machinery and needs none, but it needs a *label*, so
  that "we checked and it was fine" and "we cannot check" are distinguishable.

## 3. What exists today, and what each layer is blind to

Every integrity mechanism this repo has is write-time or absence-shaped.

| Layer | Where | Blind to |
|---|---|---|
| Provenance labels (`live`/`stub`/`stale`/`seed`, plus `backfilled` since #615) | `backend/migrations/0014_wallet_balance_samples.sql:30`, `backend/migrations/0024_analytics_provenance_source.sql:21` | a row correctly labelled `live` whose **value** is wrong |
| Calendar guard (#616/#630) | `backend/src/analytics/extract/floor-seed-calendar.ts:85` (`validateFloorCalendar`) | anything on a calendar-legal date; every source it classifies `"any"`; and it never runs against production data |
| Gap detection (#614, CLOSED/COMPLETED) | `backend/src/ops/gap-detector.ts:99` (`detectAllGaps`), `backend/src/ops/series-registry.ts` — merged in `main` via #615 | present-but-wrong rows — absence-only by construction; dead-ends at a read-only `GET /api/admin/gaps` |
| EDGAR two-tier refresh (#488/#509) | `backend/src/analytics/edgar-incremental-refresh.ts:101` (`selectEdgarRefreshTier`), `backend/src/analytics/extract/edgar-fetch-plan.ts:309` (`assessEdgarBatchDivergence`) | everything outside the single EDGAR indicator |
| Forward-fill cap (#402) | `backend/src/analytics/transform/math.ts:302` (`MAX_FORWARD_FILL_DAYS = 120`), surfaced at `backend/src/analytics/index.ts:531` | emits a DTO field (`forward_fill_expired`, `:547`) only; raises no alert |
| Destructive upsert | `backend/src/analytics/store/raw-history-store.ts:67-69` — `ON CONFLICT (date, indicator) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source` | no audit trail; nothing records when a row was last checked, so "never verified" and "verified and confirmed" are indistinguishable |

Three specifics matter more than the table conveys.

**The calendar guard is offline and mostly permissive.**
`sourceCalendar()` (`floor-seed-calendar.ts:44-54`) returns one of three values.
`ICSA` is `weekly_saturday`; every other `fred` source and every non-crypto
`yahoo` symbol is `business_day`; **everything else is `"any"`** — all
coinmetrics / blockchain\_com / defillama sources, both crypto Yahoo tickers,
`SHILLER_CAPE`, and `NEW_TOKENS`. `validateFloorCalendar` skips `"any"` outright
(`:89`), and `filterCalendarValid` returns the rows untouched (`:105`). The
predicate itself is nothing more than UTC day-of-week (`dayOfWeek`, `:59-61`;
`isCalendarValidDate`, `:63-69`) — it knows nothing about holidays, and it makes
no network call by design (`"Pure — no network, no SQL"`, `:16`). Its callers
are the seed generator, the one-time production cleanup in
`backend/src/analytics/store/seed-provenance.ts`, and the CI guard test. **None
of those is a standing check against the production floor.**

**EDGAR is the only real reconciliation loop in the system, and it covers one
indicator.** `selectEdgarRefreshTier(asOf)` picks `full` on one configured
weekday and `incremental` otherwise (`edgar-incremental-refresh.ts:101-107`) —
the incremental-daily / full-weekly cadence this design borrows in §6.1. The
`#509` guard, `assessEdgarBatchDivergence`
(`edgar-fetch-plan.ts:309-368`), is the only place in the repo that refuses to
overwrite a persisted floor on the grounds that the *fetch* looks wrong rather
than the *row*.

**`remediationClass` has zero behavioural consumers.** The field is declared in
`backend/src/ops/series-registry.ts:47` and assigned per series (`:60`–`:150`,
ten registered series: eight `"C"`, one `"B"`, one `"A"`); it is copied straight
through into `GapReport` (`backend/src/ops/gap-detector.ts:28`, populated at
`:85`) and re-declared on the DTO (`contract/src/admin.d.ts:108`). Those are its
only non-test sites. `detectAllGaps` (`backend/src/ops/gap-detector.ts:99`) has
exactly one production caller: `backend/src/api/routes/admin.ts:296`, the
read-only `GET /api/admin/gaps` route registered at `contract/src/routes.js:250`.
The only other references are assertions in `backend/tests/gap-detector.test.ts`
and `backend/tests/api/admin-surface.test.ts:165`, which check the value is one
of `A`/`B`/`C` — not that anything acts on it. *(Verified against `main` at
`7b92a8c`: `grep -rn remediationClass backend/src contract/src`.)*

This is a pattern, not an accident. `backend/scripts/seed-provenance-verify.ts`
has a real executed CI test (`backend/tests/seed-provenance-verify.test.ts:5`
imports its `main`) and **no production caller** — no boot path, deploy gate, or
cron (filed as #638). `forward_fill_expired` is computed and shipped in a DTO
and alarms nothing. This codebase repeatedly ships a correct mechanism and never
wires it up, which is the failure mode this design must not repeat: **every
acceptance criterion should assert the caller, not just the mechanism.**

### 3.1 Where the source plans are now tracked

The wallet/AUM half of this design came from a project plan that has since been
**split into three workstreams**, and only one of them is this document's
subject. The split is worth stating precisely, because two of the three are
already filed and must not be re-specified here.

| Workstream | Contents | Tracking |
|---|---|---|
| **Backfill capability** — the subject of §6.3, specified in §6.5 | block-addressable reads, date→block resolution, historical prices, RPC batching, the repair driver | **Unfiled.** Four code issues plus a `decision:` issue; all but the RPC batching are gated on that decision (PD1). |
| **v0.2.2 release nits** | undeliverable env vars, the `BUYBACK_FROM_BLOCK` constant, runbook verification gaps, the AC4 discrepancy inherited from the now-closed #614 | **#647** (parent) with subtasks **#639–#646**, filed 2026-08-15. Explicitly **not** part of the backfill project. |
| **Research engine cleanup** | the shared `chart-theme.js` category-axis defect and the regime charts | **#624**. Not part of the backfill project. |

The continuous-reconciliation half — the audit's D5 recommendations (§1) and the
Class A reconciler of §6.1 — is **unfiled in every part**; a `gh issue list`
search on 2026-08-15 found no issue covering a freshness assertion against
source, a reconciliation job, or a testable persisted-floor invariant. Its full
specification is §6.4 of this document.

Two of the filed nits are load-bearing for this design rather than incidental,
and are treated where they belong: the compose-allowlist defect class in §10.1,
and #645's closure in §13. One issue filed after the split is load-bearing for a
pending decision: **#648** (OPEN) records that the SP500 column splices two
different measurements, which is a second and independent reason to keep SP500
out of the backfill — see PD7 and §12.

### 3.2 Step 0 — deploy #615, and prove the clamp self-heals the pinned rows

Everything in §6 assumes #615's baseline: the gap detector, the series registry,
`remediationClass`, the `'backfilled'` provenance value, and the scheduler-wedge
clamp. **The merge is done** — #615 landed on `main` as `7b92a8c` on
2026-08-15 and closed #614 COMPLETED — so half of step 0 is discharged, and
nothing in §6 is blocked on it any longer.

**The outstanding half is deploy, and the deploy carries an obligation nobody has
discharged yet.** A merge to `main` does not touch production, and it is
production where the AUM hole is still widening. The clamp only stops that
widening once it is running on the droplet.

That obligation is the one verification at this step that cannot be skipped, and
it does not follow from the merge. **The wedged schedules live in an external
Postgres that survives every teardown**, so redeploying does not reset them, and
a green CI run on `main` says nothing about them: CI starts from a clean
database, where no row is pinned. It must be shown explicitly, against the
production rows, that the clamp **self-heals schedules that are already pinned**,
on its first tick, rather than only preventing future wedges — a fix with only
the second property ships green while production stays frozen. That is an
assertion against the persisted rows, not a code reading and not a merge status.

### 3.3 Working drafts this document supersedes

This document absorbs three uncommitted working drafts and is now the single
specification for both workstreams. They are named here so a reader does not go
looking for a fuller version that no longer exists; none of them is tracked in
this repository, and **none of them is maintained.**

| Draft | What it held | Where it now lives |
|---|---|---|
| *Reconstruct Wallet History — Project Plan* (`reconstruct-wallet-project.md`, another session's scratch file) | the four backfill code issues, the archive-read decision argument, and the sequencing | §6.5 (the four issues), PD1 and §6.3 (the decision argument), §6.6 (sequencing) |
| *ISSUE-DRAFT-source-reconciliation.md* (unfiled issue draft) | the Class A reconciler's scope boundaries, acceptance criteria, and test plan | §6.4 |
| *RECONCILIATION-two-plans.md* (the reconciliation memo between the two) | the one-dispatcher / three-detector argument and the shared hazards | §4, PD9, §7.6, §12 |

Two contents of the wallet plan are **deliberately not carried forward**, and
must not be re-imported as live work from any copy of it: its Issue 6, the shared
`chart-theme.js` category-axis defect, moved to **#624**; and its Issue 7, the
`source: "live"` honesty question, filed as **#645** and **closed NOT_PLANNED**
on 2026-08-15 because its premise was wrong (§13).

Where the drafts and this document disagreed on a verifiable fact, this document
carries the value checked against this checkout. The one such correction worth
flagging: the wallet plan says fourteen exported RPC wrappers thread
`RpcCallOptions`; the verified count here is thirteen (§6.5.1).

**Naming.** Where a claim below is attributed to *"Plan A"*, that is the wallet
plan in the first row of the table — its investigation is the source of every
live-system measurement in this document, and §14 records which of them were
re-verified here and which were not.

## 4. Architecture — three detectors, one dispatcher, per-class executors

```
detectors                                  dispatcher                executors
─────────────────────────────────────      ──────────────            ─────────────────────
gap detector      (absent)          ─┐
calendar guard    (impossible date) ─┼──►  remediationClass   ──►    A: re-fetch source
source reconciler (present, wrong)  ─┘     dispatch + guard          B: recompute
                                                                     C: archive read @ block
```

Two rules follow from that picture, and both are there to prevent a specific
predictable mistake.

**There must be exactly one remediation dispatcher.** The two source plans each
independently proposed wiring `remediationClass` to something that repairs. If
both are built, the repo acquires two dispatchers with two different notions of
what a repair is, and the blast-radius guard ends up implemented twice and
differently. **The owner is assigned, not raced: that is PD9**, which recommends
the Class A reconciler. Merge order is the fallback, not the rule — if events
overtake the assignment, whichever work lands first builds the dispatcher,
generically enough for the other to plug into, and the second **must not fork a
parallel one**; if the repair driver lands first, the reconciler contributes a
divergence trigger plus the five-verdict classifier and consumes the dispatcher
unchanged.

**The blast-radius guard sits in front of the executors, not inside a
detector.** Put it in a detector and each detector gets its own half-guard: the
chain backfill would be guarded on absence heuristics and the Class A repair on
divergence heuristics, and neither would protect the other's writes. In front of
the executors, one guard sees every proposed mutation regardless of which
detector proposed it.

Detectors are pure and read-only. Executors are the only things that write.
The dispatcher's job is to map `(series, verdict, defect class)` to an executor
and to refuse when the guard says no.

## 5. The five verdicts

Every persisted key inside a verification window classifies as exactly one of
five verdicts. The classifier is pure: it takes the persisted rows, the source
response, and the series' declared calendar, and returns verdicts. It does not
write.

| Verdict | Meaning | Action |
|---|---|---|
| `confirmed` | source has the key; value matches within tolerance | stamp `last_verified_at`; **no write to `value`** |
| `revised` | source has the key; value differs | **repair** — upsert the source value; this is exactly the existing documented *"fetched wins on overlap so source corrections / revisions land"* contract, applied on a schedule rather than only on the daily fetch |
| `fabricated` | source lacks the key **and** the declared calendar says the source could never publish that date | **quarantine**, reversibly; never hard-delete |
| `unexplained_absent` | source lacks the key but the calendar permits it — holiday, degraded source, vendor outage | **never touch**; count, and alarm once it persists across N consecutive runs |
| `unverifiable` | key predates the source's re-servable window (D7's `HY_OAS`) | leave, count, disclose |

**A repair is not a republication.** Under the decided publication model (PD10,
§9), `revised` and `fabricated` change the persisted floor and therefore the
*next candidate* computation; they do not change a published figure until an
admin publishes that candidate. Every repair must also write an immutable
revision record — §8.1 — which is what makes the eventual version bump
explicable.

### 5.1 Why `unexplained_absent` is the whole safety argument

The difference between a self-healer and a self-destroyer is one bad inference:
*the source didn't give me this key, therefore this key is fake.*

That inference is wrong whenever the source is degraded rather than
authoritative. A vendor returning **HTTP 200 with a truncated window** is the
canonical case — well-formed, parseable, no error to catch, and simply missing
half of history. Classify that as `fabricated` and the system deletes correct
data at scale, in a single automated batch, with the audit trail saying it was
repairing itself.

So `fabricated` requires **two** independent conditions, not one: the source
must lack the key, *and* the declared publication calendar must say the source
could never have published that date. Non-Saturday `ICSA` rows satisfy both, and
that is exactly the audit's structural proof — FRED's ICSA has observations only
on Saturdays, 867 of 867 since 2010, so *"dates without observations cannot be
revised — they never existed."* A missing Tuesday `DXY` row satisfies only the
first, and lands in `unexplained_absent`, where nothing touches it.

Two further guardrails on the classifier, both drawn directly from the audit:

- **Do not equate repeated values with fabricated rows.** The audit is explicit:
  in the vendored seed, the 125 `ICSA` rows carrying `215000` classify as 110
  source-absent, 13 genuine observations, and 2 source-overlap rows that live
  refresh corrects. `119.2868` is `DTWEXBGS`'s genuine value for Friday
  2026-05-22. *"The values are real; only their dates are fabricated."*
  Classification is by **source key**, never by value repetition.
- **A truncated window classifies as a window, not as rows.** If the source's
  response is short or degenerate, the whole compared window goes to
  `unexplained_absent` and the batch mutates nothing — see §7.3.

## 6. Per-class treatment, and the two work specifications

`remediationClass` partitions series by *how* a wrong row can be corrected. It
is a different axis from §2's defect taxonomy, and the two must not be
conflated: a defect class says *how a row is wrong*, a remediation class says
*how its series can be fixed* — the remediation class is a fixed property of the
series' data source, while any defect class can occur in any series. The three
classes need genuinely different executors. §6.1–§6.3 set out what each class
needs and why; §6.4 and §6.5 are the two specifications ready to be filed as
issues, and §6.6 orders them.

### 6.1 Class A — `raw_indicator_history`, re-fetchable

This is where the defect class actually occurred and where every source is an
ordinary HTTP re-fetch the pipeline already performs. It gets **full comparative
reconciliation**: re-fetch the source's re-servable window, classify every
persisted key against it, repair `revised`, quarantine `fabricated`, leave the
rest.

Design points specific to Class A:

- **Cadence tolerance replaces row count as the freshness test.** Each series
  asserts its last *real* observation is within its declared publication
  cadence. This is the audit's highest-value recommendation ("cheapest first")
  and catches D1, D2, and D3 in one check. D2 is the shape it catches:
  `SHILLER_CAPE` frozen at 2023-09-01 while the fetch summary prints a healthy
  tick because 1,713 rows came back. Row count is not freshness. The same
  pattern is live in v1's own extractor — `backend/src/analytics/extract/sources.ts:113-116`
  logs `EMPTY` versus `ok` purely on `data.length === 0`.
- **Reconciliation fetches must bypass the TTL cache**
  (`backend/src/analytics/extract/fetch-cache.ts`), or the loop compares
  persisted state against our own cached copy of it and always agrees.
- **Cadence must be declared once.** It is currently declared twice and the two
  already disagree: `backend/src/analytics/analyze/indicators.ts:113` says
  `DTWEXBGS` is *"Published weekly (not the daily DXY ICE futures index)"*,
  while `floor-seed-calendar.ts:48` classifies every `fred` source
  `business_day`. The audit's structural proof — `DTWEXBGS` publishes business
  days only, so v0's weekend rows are fabricated — and FRED's `D`-prefix
  convention both say `business_day` is correct, so **the prose is wrong and the
  code copy is the one driving production deletes** (`store/seed-provenance.ts:58-61`
  issues `DELETE FROM raw_indicator_history … AND source = 'seed'`). Promoting
  cadence to single-source-of-truth registry metadata, consumed by the calendar
  validator rather than restated in it, makes the contradiction
  unrepresentable. Tracked as **#637**.
- **Cadence: incremental daily over a trailing window, full weekly**, mirroring
  `selectEdgarRefreshTier` (`edgar-incremental-refresh.ts:101-107`). Whatever
  producer kind carries it must join the producer's armed-schedule liveness
  check — the requirement, with its `path:line` anchor and the scheduler-wedge
  failure class it guards against, is stated once in §6.4's scope list.

### 6.2 Class B — `research_signals`, recompute-and-compare

Class B rows are derived from inputs we still hold, so the executor is
**recompute the signal for the day and compare against what is persisted**,
rather than re-fetch. A divergence means either an input changed (legitimate —
repair) or the computation changed (a methodology change, which must not be
silently backfilled over history; that is a version-relock decision, not a
repair).

One integration hazard to record now: **the existing producer catch-up computes
its own missing-days set and does not consume the gap detector.** That catch-up
is in `main`: `catchUpMissedResearchDays` (`backend/src/producer/index.ts:108`)
walks back `CATCHUP_WINDOW_DAYS = 14` (`:73`), asks
`GET /api/analytics/research-signals/dates?since=` which days already exist
(`:111`–`:117`), and re-runs the missing ones (`:123`) — on boot (`:262`) and
again on every daily `research` fire (`:229`). That makes `research_signals` the
only series that genuinely self-heals today. But it enumerates missing days by
its own presence query, not through `detectAllGaps`, so two independent notions
of "which days are missing" now exist in `main` and will drift. Unifying them —
the catch-up consuming the detector rather than duplicating it — is the right
shape. *(Verified against `main` at `7b92a8c`.)*

### 6.3 Class C — chain-derived, repairable but not continuously reconcilable

**Gated on a `decision:` issue that is still unfiled as of 2026-08-15 — PD1, and
§3.1 for where the workstream is tracked. Nothing in this subsection, and nothing
in §6.5 except §6.5.3 (which makes no archive read), should be built before that
issue is settled.**

Three recorded decisions currently assert this data is unreachable:

1. [decisions.md D16](../decisions.md) rejects *"an archive indexer to
   reconstruct gap-free pre-launch history"* as out of scope for #84.
2. `backend/src/chain/token-prices.ts:10-15` states that historical valuation
   comes from the persisted `wallet_balance_samples` series, *"NOT from a
   re-fetched OHLCV series, which resolves Open Question 9"*.
3. #294's out-of-scope list — *"the indexer accumulates forward only."*
   *(unverified here — issue text, not code.)*

The empirical finding that motivates revisiting them: `https://mainnet.base.org`
— the default `BASE_RPC_URL` — **answers archive state queries.** Plan A
verified this directly against the prop wallet: `eth_getBalance` and
`eth_call balanceOf` return genuinely different values at 40 / 90 / 180 / 365-day
depth, block 2,000,000 correctly returns `"0x"` for a pre-deployment USDC read
(a correct archive answer, not a `latest` fallback), and the production
Multicall3 read path returned `success: true` for all sub-calls at latest, 40d,
and 90d. Caveats stand: undocumented free-tier behaviour, no SLA, real rate
limiting (`-32016`), and no load test of a sustained full-gap sweep.

The code change is small in *diff* terms but not in *blast radius*, and the two
must not be confused. Exactly two hardcoded `"latest"` strings exist in the
backend — `backend/src/chain/base-rpc-client.ts:374` (`ethCall`) and `:483`
(`eth_getBalance`) — and neither takes a block-tag parameter today. Every read
already threads a shared `RpcCallOptions` (`base-rpc-client.ts:184`), so a
`blockTag` field is inherited by all the exported wrappers with zero signature
changes and zero change to callers that keep reading latest.

**That inheritance is exactly why this is not a call-site tweak.** D17
established `base-rpc-client.ts` as the *single shared RPC transport* for every
live chain feed — vault economics, wallet balances, wallet sleeves, buyback
logs, token metrics. Adding block-addressing changes that transport, so a defect
in the change reaches every live chain surface simultaneously, not just the
backfill that motivated it. The mitigation is that the default must remain
`opts.blockTag ?? "latest"`, byte-for-byte preserving current behaviour for every
caller that passes nothing — but the review burden is transport-wide, and the
work should be scoped, tested, and reviewed on that basis.

Threading it through `readChainAmountsBatched`
(`backend/src/chain/wallet-valuation.ts:178`, via `rpcOpts()` at `:143`) reaches
its two callers, `backend/src/chain/wallet-balances.ts:98` and
`backend/src/chain/wallet-sleeves.ts:57`. The job-payload pattern already exists
unwired: `backend/src/worker/handlers/analytics.ts:24-25` reads
`payload.asof ?? new Date()`.

**The argument to put to the decision** is that this is *not* what D16 rejected.
An archive *indexer* means ingesting and persisting chain history yourself. This
is a block tag on reads the app already makes, against a node that already
answers — no indexer, no new vendor, no new stored chain events. The historical
*price* resolver genuinely does reverse point (2), however, and that reversal
must be made explicitly rather than smuggled in. The repo uses
`decision:`-prefixed issues for exactly this.

**So Class C is repairable but not continuously reconcilable — on cost grounds,
not impossibility.** The measured budget is a ~5-token bucket refilling at
~0.55 calls/s, metered **per-IP at the provider** and **per sub-call rather than
per HTTP request**, against a structural batch cap of 10; Multicall3 is the only
real leverage, at 27 inner reads per charged token. The full measurements, and
what they imply for the limiter that must be built, are §6.5.3.

Two consequences are class-level rather than implementation detail. First,
because the limit is per-IP, **in-process isolation cannot create budget**: a
backfill running at the full 0.55/s leaves the every-minute live sampler
(~0.033 calls/s, ~6%) zero headroom and will 429 it — *causing* new gaps while
fixing old ones. Choosing between a keyed provider, a shared priority-aware
bucket, and an offline quiet window is **PD6**; the constraint that survives all
three — never give the backfill its own independent limiter — and the
concurrency-not-rate finding behind the 2026-08-10 429 storm are stated once,
with their `path:line` anchors, in **§6.5.3**.

Second, a bounded one-time backfill of the current gap (42 days as of
2026-08-15, widening on each DB rebuild — §3.2) is a completely different cost
problem from re-verifying every chain day forever. **Class C gets an executor; it
does not get a standing reconciliation loop until there is a keyed provider.**

**The irony worth recording:** a chain read at a **pinned immutable block** is,
in principle, the most deterministically verifiable data in the system — more so
than a live-sampled macro row, which can never be re-derived at all once its
vendor window rolls off. Two independent readers at the same block must agree,
forever. The rate limit is the only thing standing between that property and a
continuous verifier.

### 6.4 Specification — the Class A source reconciler

This is one issue, unfiled. Its gating, stated once and precisely because the
rest of the document refers here for it: **§6.4 is not gated on PD1** — Class A
sources are ordinary HTTP re-fetches the pipeline already performs, so nothing
here touches a chain read or depends on the archive-read decision landing either
way. **Its mutating half — the quarantine executor and quarantine storage — is
gated on PD5**, and **its operator-facing surface — anything that shows a
quarantined row — is gated on PD4.** The detection, classification, alerting,
revision-log, and dispatcher halves are gated on neither and can proceed. It is
the work that closes the audit's **D5** (§1) and, per PD9, the workstream that
should build the shared dispatcher.

Its canonical anchors are `docs/architecture.md`'s analytics pipeline and the
`AnalyticsPersistence` boundary (#106), and **D16**'s honesty invariant — which
this work extends from write time to standing verification (see PD4 for the one
place that extension needs ratifying).

**In scope.**

- Cadence and source-window verifiability promoted onto the indicator registry
  (`backend/src/analytics/analyze/indicators.ts`), with
  `sourceCalendar()` (`extract/floor-seed-calendar.ts:44-54`) reading that
  declaration rather than re-deriving it, and the `DTWEXBGS` weekly-versus-
  business-day contradiction resolved in favour of the structurally-proven
  calendar (§6.1, **#637**).
- A **pure** classifier producing the five verdicts of §5, reusing
  `validateFloorCalendar` / `filterCalendarValid` / `forwardFillAge` /
  `mergeSeries` rather than reimplementing them.
- A generalized batch-divergence guard modelled on `assessEdgarBatchDivergence`
  (`extract/edgar-fetch-plan.ts:309-368`), applied server-side before any repair
  commits (§7.3).
- Quarantine storage: repaired-away rows moved or flagged reversibly and excluded
  from every read path, plus a `last_verified_at` column on
  `raw_indicator_history` so an unchecked row is distinguishable from a confirmed
  one. Next migration ordinal in this checkout is `0032`.
- **An immutable revision log** (§8.1), written by every repair and every
  quarantine: series, natural key, prior value, new value, verdict, run,
  source evidence, timestamp. It is the same record quarantine needs to be
  genuinely reversible, and the same record that explains a version bump under
  PD10 — so it is one mechanism serving three purposes and must not be deferred
  to a follow-up.
- A new authenticated analytics verb for submitting a reconciliation report and
  its proposed repairs — none of the eight existing verbs
  (`contract/src/routes.js:210-228`) is delete- or quarantine-shaped — with
  validation and guards applied before the transaction opens.
- A `reconcile` producer kind on its own cron, incremental daily over a trailing
  window and full weekly, mirroring `selectEdgarRefreshTier`
  (`edgar-incremental-refresh.ts:101-107`), added to `checkArmedSchedules`'s kind
  list (`backend/src/producer/index.ts:317`, today `["regime", "research"]`) so
  liveness covers it. Reconciliation fetches must bypass the
  `extract/fetch-cache.ts` TTL cache.
- Class A execution across `raw_indicator_history` — every indicator, every
  source — which is where the defect class actually occurred.
- Integrity alerts joined into the existing `GET /api/admin/overview` alerts feed
  (`backend/src/admin/overview.ts:75`, `AlertLevel`), not a parallel dashboard.

**Out of scope**, each named so the boundary is deliberate rather than
accidental: Class B recompute-and-compare for `research_signals` (§6.2); **Class
C**, which is out of scope here on **cost** grounds and not impossibility (§6.3,
PD6) and is separately gated on PD1; backfilling `source` on the pre-`0024` NULL
rows; the six persisted series carrying no provenance column at all, and
`swarm/domain.ts:1285`'s synthetic `regime_snapshots` rows written with no
`source` in demo and stage *(both inherited from the draft; **unverified** here)*;
unifying the four provenance vocabularies or adding CHECK constraints to them
(§12); and any change to v0 (`agentjuno/robotmoney`).

**Acceptance criteria.** Each asserts a *caller*, not just a mechanism — the
failure mode §3 documents this codebase repeating.

- Publication cadence and source-window verifiability are declared once, on the
  indicator registry, and `sourceCalendar` derives from that declaration; the
  `DTWEXBGS` contradiction between `analyze/indicators.ts` and
  `extract/floor-seed-calendar.ts` is resolved in favour of the
  structurally-proven calendar.
- A pure classifier assigns every persisted key in a verification window exactly
  one of `confirmed` / `revised` / `fabricated` / `unexplained_absent` /
  `unverifiable`.
- A source returning a truncated or degenerate window classifies its **whole
  window** `unexplained_absent` and mutates nothing.
- `revised` keys are repaired by upsert to the source value; `fabricated` keys
  are quarantined reversibly and excluded from every read path; **no path
  hard-deletes.**
- The batch-divergence guard refuses an entire repair batch and raises an alert
  when the degeneracy, rewrite-ratio, or aggregate-drift bounds are exceeded, and
  the refusal is enforced in the API process rather than only in the producer.
- `raw_indicator_history` records when each row was last verified against source,
  so an unverified row is distinguishable from a confirmed one.
- Every repair and every quarantine writes an immutable revision record carrying
  its prior value, new value, verdict, run, and source evidence, and a
  quarantined row is restorable from that record alone.
- A refused batch raises an operator alert in `GET /api/admin/overview`, so a
  refusal is never indistinguishable from a clean run (§8.2).
- The producer submits reconciliation reports and proposed repairs only through
  the new authenticated analytics route, and acquires no `DATABASE_URL`.
- Reconciliation runs on its own cron — incremental daily, full weekly — and is
  included in the producer's armed-schedule liveness check.
- A series whose last real observation exceeds its declared cadence tolerance
  raises an alert in `GET /api/admin/overview` **regardless of how many rows it
  holds**.
- Running reconciliation twice with no source change makes no writes on the
  second run.

**Test plan.** All tests execute in the required backend job. DB-backed tests use
the same ephemeral Postgres as `backend/tests/floor-seed.test.ts`; a missing
fixture or an absent database **fails loudly and never skips**. The four
`source-reconciliation` suites below do not exist yet, so they are named
descriptively rather than by filename:
`scripts/tests/unit/test-path-citations.test.ts` requires every concrete test
path cited in `docs/**` to resolve on disk, and that gate cannot distinguish a
proposed path from a stale one.

- A **`source-reconciliation` classifier suite**, added under `backend/tests/`,
  executes the classifier over a recorded canonical FRED response plus a
  deliberately polluted floor, and asserts the known source-absent `ICSA`/`DXY`
  keys from the D6 inventory classify `fabricated` while genuine observations
  that merely repeat a value classify `confirmed` — the audit's explicit warning
  that repeated values can be genuine (§5).
- The same classifier suite asserts a revised source value is upserted, and that
  a key outside the source's re-servable window classifies `unverifiable` and is
  left untouched.
- A **`source-reconciliation` batch-guard suite**, added under `backend/tests/`,
  feeds a truncated response and a degenerate one, and asserts the batch is
  refused whole, an alert is raised, and both row count and values are unchanged.
- A **`source-reconciliation` repair suite**, added under `backend/tests/`, runs
  the repair against ephemeral Postgres and asserts quarantined rows disappear
  from the read path, remain recoverable, and that a second identical run writes
  nothing.
- A **`source-reconciliation` freshness suite**, added under `backend/tests/`,
  asserts a series with many rows but a stale last real observation raises a
  freshness alert — the D2/D3 shape.
- `backend/tests/api/analytics-write.test.ts` executes the new authenticated
  route and asserts an unauthenticated call is refused and that guard violations
  are rejected server-side.
- `backend/tests/producer-liveness.test.ts` asserts the reconcile cron is armed
  and covered by the producer's armed-schedule check.

### 6.5 Specification — the Class C backfill capability

Four code issues, none filed. **§6.5.1, §6.5.2 and §6.5.4 are gated on PD1;
§6.5.3 is not** — it makes no archive read, and its own rationale says it
improves the live path independently, so it can be filed and built before PD1
lands. §6.5.1–§6.5.3 are parallelisable with each other; §6.5.4 consumes all
three. Their shared baseline is #615, which is merged in `main` (§3.2).

#### 6.5.1 Block-addressable chain reads

**Scope.** Add `blockTag?: string` to `RpcCallOptions`
(`backend/src/chain/base-rpc-client.ts:184`, today `{ rpcUrl, timeoutMs? }`) and
use `opts.blockTag ?? "latest"` at the only two hardcoded sites in the backend:
`:374` (`ethCall`) and `:483` (`ethGetBalance`). **Thirteen** exported functions
take `RpcCallOptions` and inherit the field with zero signature changes and zero
change to callers that pass nothing — `rpcRequest` (`:310`), `ethCall` (`:373`),
`ethGetLogs` (`:402`), `ethBlockNumber` (`:410`), `ethGetBlockByNumber` (`:423`),
`callTotalAssets` (`:429`), `callTotalSupply` (`:433`), `callBalanceOf` (`:437`),
`callConvertToAssets` (`:444`), `callAsset` (`:454`), `callDecimals` (`:463`),
`multicall3Aggregate3` (`:473`), and `ethGetBalance` (`:482`). Multicall3
inherits it for free, because `multicall3Aggregate3` issues its batch through
`ethCall` at `:475`.

Thread an optional `blockTag` through `readChainAmountsBatched`
(`backend/src/chain/wallet-valuation.ts:178`) via `rpcOpts()` (`:143`, today
returning `{ rpcUrl: config.baseRpcUrl }` and nothing else), reaching its two
callers, `backend/src/chain/wallet-balances.ts:98` and
`backend/src/chain/wallet-sleeves.ts:57`.

**Review burden, stated separately from diff size** (§6.3): D17 established this
module as the *single shared RPC transport* for every live chain feed, so a
defect here reaches vault economics, wallet balances, sleeves, buyback logs and
token metrics simultaneously. The default must remain `opts.blockTag ?? "latest"`,
byte-for-byte preserving current behaviour; the change should nonetheless be
scoped, tested and reviewed as a transport change.

**The date→block resolver, and its cache.** Base blocks are exactly 2s, so
`block ≈ latest − days_ago × 43200` lands within about one block; refine with a
bounded walk against `ethGetBlockByNumber` (`:423`) comparing block timestamps
to the target UTC midnight. Budget **≤8 resolver calls per day** — roughly 340
for the current gap (42 days as of 2026-08-15, widening on each DB rebuild,
§3.2), scaling linearly with the window. **A past UTC midnight's block is
immutable, so the cache is permanent** —
a second run over the same window costs zero resolver calls. *(The 2s block time,
the 43200 constant and the ≤8-call bound are Plan A's arithmetic and are
**unverified** here.)*

**The silent-zero hazard must be handled in this issue, not deferred.** The
mechanism and the rule are stated once, with their `path:line` anchors, in
**§10**'s chain rail: block-addressed reads must let callers distinguish an
empty return (`success: true`, `returnData: "0x"` — a contract not yet deployed
at the target date) from a genuine zero, and **live-path semantics must not
change.**

**Acceptance.** An executed-in-CI test reading a known historical balance at a
pinned block; a test proving an empty `returnData` is distinguishable from a
genuine `0`; and a date→block test asserting the resolved block's timestamp
brackets the target UTC midnight.

**The job-payload pattern already exists, unwired.** Handlers take
`Record<string, unknown>` payloads, and
`backend/src/worker/handlers/analytics.ts:24-25` already reads
`(payload.asof as string) ?? new Date().toISOString().slice(0, 10)` — so an
`{asof}`-carrying job is the house shape, not a new one.

#### 6.5.2 Historical price resolution

**Scope.** Per-day USD prices for the market-priced symbols, for the days
§6.5.4 reconstructs. **This is the item that reverses Open Question 9 (PD3), and
the change must edit `token-prices.ts:10-15` in the same diff.**

- **GeckoTerminal daily OHLCV** — `/networks/base/pools/{addr}/ohlcv/day`,
  keyless. Candles are **exactly UTC-midnight aligned**, which matches the day
  key the sampler already writes: `backend/src/worker/handlers/wallet.ts:49`
  computes `new Date().toISOString().slice(0, 10)` as the `sampleDate`, so no
  boundary reconciliation is needed. A **~6-month server window caps each
  request** (`limit=1000` and `limit=500` both returned 181 candles); deeper
  windows need `before_timestamp` paging.
- **Yahoo** — `fetchYahoo(symbol, startUnix, endUnix, timeoutMs)`
  (`backend/src/analytics/extract/yahoo.ts:44`) already takes a range.
- **USDC and both sleeves are pinned $1** and need no fetch. ZYFAI-SS1 and
  GIZA-SS1 are **not** share tokens: `backend/src/config.ts:172-180` documents
  them as the agent's delegated smart-account wallets on Base, proven on-chain by
  #120, with `valuationKind: "strategy"` and `priceKind: "usdc"`.

**Cost is O(1) per pool per window** — one OHLCV request serves up to ~181
daily candles, so the whole current 42-day gap (§3.2) is about 4 requests
across the market-priced pools, and even a full year is ~10.
Prices are **not** the rate-limit concern; §6.5.3 is.

**Pool addresses are derived, never configured.** The OHLCV endpoint is keyed by
*pool*, not by the token addresses the spot path uses, and the three `*_POOL_ID`
env vars are dead (§11, **#639**) — there is nothing to populate. Resolve at use
time via `GET /networks/base/tokens/{addr}/pools` (keyless, 20 pools per page).
Two properties of that resolution are load-bearing:

- **Sort candidates by 24h volume, not by reserve.** A `max(reserve_in_usd)`
  selector picks a decoy for WETH — an observed `Bnb / WETH` pool reporting
  ~$7.68B reserve against `volume.h1 = 0.0` wins outright. Verified outcomes:
  ROBOTMONEY is unambiguous (top pool at ~$253k reserve against ~$4.9k for the
  runner-up); BNKR's top two disagree by sort key but are both real BNKR/WETH
  pools with a negligible price difference; WETH is the case where reserve-sort
  is unsafe and volume-sort is correct.
- **Resolve once, then cache the pool id.** A keyless 429 was observed on the
  6th call in ~15s, against an endpoint the repo has already tuned to conserve
  quota — the micro-batching serializer from #202
  (`backend/src/chain/token-prices.ts:63-70`). Do not re-discover per run.

A round trip confirmed the derived v4 pool id (a 32-byte hash, not a 20-byte
address) is accepted by the OHLCV endpoint, and its daily close is
**byte-identical** to what the existing `/simple/…/token_price/` path returns:
GeckoTerminal's token price *is* the top pool's price. *(All GeckoTerminal
measurements in this subsection are from the 2026-08-15 investigation and are
**unverified** in this checkout — see §14.)*

**Vendor constraint, inherited and non-negotiable** (§11).
`backend/src/chain/token-prices.ts:3-8` permits only the GeckoTerminal and Yahoo
hosts; CoinGecko is reachable and banned. New GeckoTerminal *endpoint* code is
explicitly permitted, so a daily OHLCV fetcher is in bounds — but **do not reuse
`runGeckoBatch`** (`token-prices.ts:203-224`): it is address-keyed with no time
dimension and targets a spot-only endpoint. Copy the pattern, not the code.

**SP500 is recommended skipped here, not approximated — pending PD7** (§12
carries the same recommendation). An implementer should read this as the
recommended scope, not a settled one, until PD7 is taken.

#### 6.5.3 RPC batching and rate limiting

**Independently valuable: it improves the live path too**, which is the reason
this item is worth filing even if the backfill slips.

**Measured facts** (§6.3; from a developer IP, **unverified** from production).
Base accepts JSON-RPC batch arrays *including* `eth_call` at different historical
blocks in one POST, but:

- **Structural cap of 10.** An oversized batch fails wholesale with an *object*
  body — `{"error":{"code":-32014,"message":"maximum 10 calls in 1 batch"},"id":null}`
  — not a per-item error array.
- **The limiter meters per sub-call, not per HTTP request.** A 10-item batch
  returned exactly the first 5 results, three times running. Batching saves
  HTTP/TLS overhead and retry cycles, **not throughput.**
- Budget ≈ a **5-token bucket refilling at ~0.55 calls/s**. No `Retry-After`
  header is sent.
- **Multicall3 is the real leverage.** The limiter charges per `eth_call`, not
  per inner read, so one `aggregate3` carrying 27 inner reads costs one token —
  27:1. Validated at **540 logical reads in 38.2s with zero errors**, at batch 5
  / in-flight 1 / 9s spacing.

**Scope.** A new `rpcBatchRequest(requests[], opts)`: an array body with unique
ids — the current transport hardcodes `id: 1`
(`base-rpc-client.ts:313`) and reads a scalar `parsed.result` — capped at 5,
**correlating responses by `id` and never by array index**, since ordering is not
guaranteed by the JSON-RPC spec. It must distinguish a top-level batch failure
from per-item errors, and classify transients per item (`-32016` and HTTP 429 are
equivalent). Reuse the existing concurrency gate, backoff, jitter and abort
plumbing (`:243-301`) verbatim rather than reimplementing it.

Add a real **token bucket**, its capacity and refill rate **configurable and
seeded from the measured values** (~5 tokens, ~0.55/s — measured from a
developer IP), **not hardcoded**: PD6 requires those figures re-measured from
the production droplet, so the bucket's parameters must be re-derived from that
measurement before any production run. What exists today bounds *concurrency*
and not *rate*: `acquireSlot`/`releaseSlot` at `:243-256`, sized by
`BASE_RPC_MAX_CONCURRENCY` (default 4, `:230`) — which is why production saw
the 2026-08-10 `Base RPC HTTP 429` storm.

**Live-sampler contention is the design question, and it is PD6**, not an
implementation choice to be made inside this issue. The limit is **per-IP at the
provider**, so in-process isolation cannot create budget. Whichever option PD6
settles on, the hard constraint holds: **never give the backfill its own
independent limiter** — two limiters against one per-IP bucket sum to 2× and
guarantee 429s.

#### 6.5.4 The repair driver

**This is the item that makes "self-healing" true**, and it is the one that turns
`remediationClass` from a label into behaviour. Today the field is declared on
`backend/src/ops/series-registry.ts:47`, appears as a passthrough into
`GapReport` (`backend/src/ops/gap-detector.ts:85`) and in the DTO
(`contract/src/admin.d.ts:108`), and has no behavioural consumer;
`detectAllGaps` (`backend/src/ops/gap-detector.ts:99`) has exactly one production
caller, `backend/src/api/routes/admin.ts:296` — the read-only
`GET /api/admin/gaps` (`contract/src/routes.js:250`).

**Scope.** The single dispatcher of §4 — subject to PD9 if the reconciler builds
it first — plus the Class C executor:

- **Class C becomes repairable** once §6.5.1 and §6.5.2 land: enqueue one
  `{asof}` job per missing day, resolve `asof`→block, read at that block, price
  at that date, upsert. This replaces the current past-dated-slot **decline**
  path, which is in `main`: `classifySlot` returns `"past-bucket"`
  (`backend/src/worker/handlers/slot.ts:74-76`) and the handler answers with
  `declineReplayedSlot` (`:98-108`) — see `worker/handlers/wallet.ts:44` and
  `:90`. The same-bucket case instead proceeds and tags the row `'backfilled'`
  rather than `'live'` (`worker/handlers/wallet.ts:59` and `:133`); the reasoning
  for the split is stated in the file header at `slot.ts:19-44`.
- **Class A gains the trigger it is missing.** The AC4 Class A bullet on the
  now-closed **#614** is ticked but unimplemented — carried forward as **#646**.
  Either the detection→re-fetch trigger is built, or the criterion is restated
  honestly in #646; a ticked criterion with no code is the exact pattern §14's
  standing warning is about, and #614 closing COMPLETED with that bullet ticked
  is a live instance of it, not a hypothetical.
- **Class B already works** via producer catch-up, but that catch-up computes its
  own missing-days set and does not consume the gap detector (§6.2). Unify rather
  than leave two notions of "which days are missing" to drift.

**Failure semantics — required, not advisory.**

- **A day is atomic.** Never write a day whose round-1 read partially failed:
  round 2 is `convertToAssets` NAV per vault
  (`backend/src/chain/wallet-valuation.ts:269`) and depends on round 1's output,
  so a half-read day produces a plausible, wrong total.
- **Treat `success === true && returnData === "0x"` as a hard failure for that
  day, never as a zero** (§10), and carry a per-address earliest-valid-block floor
  so days preceding a target's deployment are skipped rather than zeroed.
- **Checkpoint per day for resumability**, following the `buyback_scan_state`
  precedent — `backend/migrations/0015_buyback_swaps.sql:42-46`, a single-row
  table holding the highest block already scanned, `id int PRIMARY KEY DEFAULT 1
  CHECK (id = 1)`. This is a cost optimisation and not a correctness requirement,
  since the upsert is already idempotent; committing per day means an
  interruption loses at most one day of work.

**Provenance.** Backfilled rows must be distinguishable from `'live'`, and
`provenance` has no CHECK constraint on any table — so a new value needs no
migration, which is precisely the trap (§7.6). `WalletHoldingProvenance`
(`contract/src/dashboards.d.ts:89`) is switched on by the frontend, where an
unrecognised value renders **unbadged and fully live**. #615 added `'backfilled'`
to that union, and it is in `main`: the union is now the five values
`"live" | "stub" | "stale" | "seed" | "backfilled"`. The value is therefore
available to a repair driver without a further contract change — but the §7.6
hazard is unchanged for **the next** value this design adds (a quarantine state),
which must land in the DTO union and the renderer in the same change as the
writer.

### 6.6 Sequencing

The order below is the merged sequencing of both workstreams. Steps 0 and 1 are
prerequisites for the backfill; step 2 starts immediately and runs in parallel
with everything after it; steps 4a and 4b are genuinely parallel.

0. **Deploy #615** — the merge is done (`7b92a8c`) — and prove the clamp
   self-heals schedules that are already pinned in the external Postgres, §3.2.
   It is not part of either workstream, and everything in §6.4 and §6.5 assumes
   its baseline. The merge half no longer blocks anything; the deploy-and-prove
   half still does, because production is where the hole is widening.
1. **File and settle the archive-read `decision:` issue** — PD1. **Filed as
   #709 on 2026-08-20; not yet settled.** Nothing in §6.5 except §6.5.3 starts
   until it lands. §6.4 does not wait on it.
2. **The publication workstream (§9) — start now, in parallel with everything
   below.** It is not gated on PD1, it does not touch the dispatcher, and it
   makes §8's disclosure tractable rather than expensive — so the reconciler's
   repairs land into a frozen-and-gated world rather than one where each repair
   silently restates published figures. Its own order: settle PD11 and PD12
   (both schema, and compatibly with PD15), record the `v4` decision entry
   (PD10), then build the candidate/publish split, which §9.2 argues is far
   smaller than it sounds because the full-history recompute already runs
   daily. PD13 can be taken at any point before it ships.
3. Settle **PD9** by naming the dispatcher's owner before either issue is filed,
   so the constraint can be written into the second issue's body.
4. In parallel: **(a)** the Class A reconciler (§6.4) — ungated on PD1; its
   quarantine executor awaits PD5 and its operator surface PD4 (§6.4); **(b)**
   §6.5.1 and §6.5.2 once PD1 lands, plus §6.5.3, which need not wait for it.
5. **§6.5.4**, the repair driver, once 4(b) is complete.
6. **Re-measure the RPC rate limit from the production droplet** before sizing
   any backfill run — PD6.
7. Run the backfill; verify continuity through `GET /api/admin/gaps`.

Two corrections are owed to existing artifacts and should not be lost in the
sequencing. Both concern **#614, which is now CLOSED/COMPLETED** (closed
2026-08-15T19:01:50Z by #615's merge) — which changes how each is actioned, not
whether. A closed issue's body is a historical record: editing it silently
rewrites what the closure attested to. So neither correction is a scope edit any
more.

- **#614's `## Scope` section** still states that reconstructing this history is
  out of scope, on a premise its own later comment disproves. Left standing it
  will keep steering implementers away from the fix, because a closed issue is
  exactly what a future reader greps. Record the correction as a **closing
  comment on #614** pointing at this document, and let the body stand as what
  was believed at the time.
- **#614's AC4 Class A bullet is ticked but unimplemented.** The forward-looking
  work is already carried by **#646** and folded into §6.5.4; what is owed to
  #614 itself is the same closing comment noting that this one criterion closed
  ticked without code, so its COMPLETED status is not evidence that the Class A
  trigger exists (§14's standing warning).

## 7. Safety properties

### 7.1 The append-only tension, met head-on

Any quarantine mechanism collides with an existing, explicitly stated invariant,
and the collision must be argued rather than skated past. **Ratifying the reading
argued here is PD5** — the argument below is what PD5 recommends adopting, not
something this document can settle on its own.
`backend/src/analytics/store/raw-history-store.ts:1-6` does not merely *describe*
the floor as append-only — it makes never-deleting the **stated basis of the
honesty guarantee**, verbatim:

> Store stage: the append-only persisted-real floor for raw indicator inputs.
> `raw_indicator_history` holds one row per (date, indicator); the orchestrator
> loads this floor, merges freshly-fetched points over it (fetched wins on
> overlap, never deletes — see mergeSeries), and writes the merged result back.
> **This is what keeps the pipeline honest: a failed/empty fetch degrades to real
> persisted history, never to synthetic data.**

Four observations resolve this, in order.

**1. The comment's own justification is a threat model about an absent answer,
not a universal retention rule.** The stated harm is *"a failed/empty fetch"*
erasing real history and leaving synthetic data in its place. That is a claim
about what must survive a **degraded source**. It is not a claim that a row which
was **never an observation** must be retained forever — and it cannot be, because
the rows in question are precisely the ones the comment is defending *against*
("never to synthetic data"). Quarantining a calendar-invalid row serves the
comment's goal rather than violating it: it removes synthetic data from the read
path while leaving every real persisted observation exactly where it was.

**2. The executed guard for that threat model must not weaken, and does not.**
`backend/tests/analytics-suite.test.ts:148` is the test that encodes it —
*"append-only raw floor persisted; a later EMPTY fetch never erases it"* — and it
re-runs the pipeline with an `AnalyticsDataSource` returning `[]` for every
indicator (the stub is `:156-168`, the re-run `:169`), asserting the persisted
floor survives at `:170-171` — `expect(t10After).toBe(t10Rows)`, *"floor intact
— nothing erased by an empty fetch"*. **Hard invariant this design preserves: an
empty or failed fetch must still never remove anything.** That is exactly why
the classifier requires two independent
conditions for `fabricated` (§5) and why a degenerate response sends its whole
window to `unexplained_absent` (§7.3). A quarantine triggered by source absence
alone would break this test, and breaking this test means the design is wrong,
not the test.

**3. "Append-only" already has a shipped exception in code.** `--purge`
full-universe seed regeneration (#616, merged in `03a2b01`) is non-additive by
construction: `backend/scripts/floor-seed-regenerate.ts:49-59` invokes
`generateFullUniversePurge`, and
`backend/src/analytics/extract/floor-seed-generator.ts:111-119` states the floor
is *"fully purged — only freshly fetched rows survive"*. It carries both of the
guards this design generalizes — a source-calendar validity filter
(`filterCalendarValid` on both the preserved and fetched sides, `:176-177`) and
refuse-if-zero-rows (`:173`, *"refusing a purge that would delete its entire
history"*; plus `:185-186`, refusing to write if any calendar-invalid row
survived filtering, and `:83` for the per-indicator path). So the precedent for
"remove a row that the source calendar says was never an observation, under a
refuse-on-degeneracy guard" is already merged. Quarantine is a *weaker*
operation than `--purge`: reversible, per-key, and read-path-scoped rather than
whole-artifact.

**4. The canonical prose describing that exception is already stale.**
[architecture.md](../architecture.md) §"Regime raw floor seed (issue #400)" still
describes `floor-seed:regenerate` as only additive and per-indicator —
`docs/architecture.md:780-787`, *"additively merges it into the existing
committed floor (`mergeSeries` — fetched wins on overlap)"* — with no mention of
`--purge`, the full-universe mode, or the calendar filter. That prose predates
#616/#630 and does not describe current behaviour. **Recorded here as a
discrepancy only; this document does not edit `architecture.md`.** Whoever files
the reconciliation work should also file the doc correction, because a reader who
consults architecture.md today will conclude that a non-additive floor rewrite
has no precedent, which is the exact reasoning this subsection exists to
forestall.

### 7.2 Quarantine, never hard-delete

Repaired-away rows are moved or flagged **reversibly** and excluded from every
candidate computation and read path — and from published versions per **PD15**,
which governs the one place total exclusion is impossible: a version already
published from the row before it was quarantined stays frozen, so there the
exclusion gives way to disclosure. No path hard-deletes. This is not
squeamishness: the classifier's
`fabricated` verdict is an inference about a vendor's publication calendar, and
if that inference is wrong the only thing standing between a bug and permanent
data loss is the reversibility of the operation. Quarantine also makes the
repair auditable — an operator can ask what was removed and why, which a
`DELETE` cannot answer.

The current destructive path is the counter-example to design against:
`raw-history-store.ts:67-69` upserts with
`DO UPDATE SET value = EXCLUDED.value`, and `store/seed-provenance.ts:58-61`
issues a real `DELETE`. Neither leaves a trace of what was there before.
Reversibility is only as good as what was recorded, which is why §8.1's revision
log is a prerequisite of this mechanism rather than a companion to it: a flag
that hides a row without preserving its prior value, the evidence, and the run
that removed it is reversible in name only.

Relatedly, `raw_indicator_history` needs a `last_verified_at` column so an
unchecked row is distinguishable from a confirmed one; today the table is
`(date, indicator, value, source)` only
(`backend/migrations/0009_analytics_v2.sql:29-33` plus
`0024_analytics_provenance_source.sql:21`). The next migration ordinal in this
checkout is `0032` (highest present is `0031_swarm_member_handle_namespace.sql`).

### 7.3 The blast-radius guard

Generalize `assessEdgarBatchDivergence` (`edgar-fetch-plan.ts:309-368`) from one
indicator to the registry. Its three checks, as implemented, are exactly the
three a reconciler needs:

1. **Degeneracy** (`:325-335`) — an all-zero or near-all-zero batch is refused:
   *"answered well-formed but empty, refusing to overwrite the persisted floor."*
   This is the HTTP-200-but-broken case.
2. **Rewrite ratio** (`:339-347`) — if the batch would rewrite more than a
   declared fraction of the already-persisted keys it compared, it is *"a bulk
   rewrite, not a revision"* and is refused whole.
3. **Aggregate drift** (`:348-364`) — if `|Σfresh − Σprior| / Σprior` exceeds
   its bound, refuse.

Two properties of that implementation carry over and should not be lost. The
ratio checks apply only to **reconciliation-sized batches** (`compared.length >=
minComparable`, `:338`), so a small legitimate correction is not blocked by a
percentage rule that is meaningless at n=2. And the batch is refused **whole and
alarmed** — never partially applied — so a guard trip cannot leave the floor in
a half-repaired state that the next run reads as the new baseline.

### 7.4 Enforcement is server-side

The guard is enforced in the API process, **not** in the producer. The producer
is a client across the issue **#106** persistence boundary and holds no
`DATABASE_URL`: per [architecture.md](../architecture.md), the orchestrator
never writes SQL, every analytics read/write goes through the
`AnalyticsPersistence` port, and the independent `analytics-producer` submits
through authenticated typed routes. A guard living in the producer is a guard
the database does not have. Validation runs **before the transaction opens** —
`contract/src/routes.js:205-209` states the boundary contract: *"Mutations
validate the whole payload before opening a transaction and are idempotent on
their natural keys. There is NO generic SQL-over-HTTP endpoint."*

No quarantine or delete route exists today. The analytics namespace holds eight
verbs (`contract/src/routes.js:210-228`): `readiness`, `rawHistory` (GET/POST),
`rawHistorySeed`, `regimeSnapshots`, and `researchSignals` are the upsert-shaped
canonical writes; `researchSignalDates` (`:220`, added by #615) is a read-only
presence GET; `researchEligibility` (`:223`) is a retired path that answers 409
and mutates nothing; and `telemetry` (`:227`) is an append-only run-telemetry
submission. **Not one of the eight is delete- or quarantine-shaped.** A
reconciliation report plus proposed repairs needs a new authenticated verb in
that namespace, not a new surface beside it.

**A worker-side implementation is foreclosed at the database, not merely by
convention.** `backend/tests/analytics-worker-role.test.ts:101` asserts that
`rm_worker` receives Postgres error `42501` (insufficient privilege) on
`DELETE FROM raw_indicator_history`, alongside the same assertion for `INSERT`
(`:93`) and `UPDATE` (`:97`), and for `regime_snapshots` and `research_signals`.
The role can still `SELECT` (`:107-110`). So **the quarantine writer must run as
the API role.** This is consistent with the #106 API-owned boundary —
`raw-history-store.ts:8-12` marks the module API-OWNED and names
`tests/analytics-api-boundary.test.ts` as the enforcer — but it is worth stating
as a design constraint in its own right, because it rules out the otherwise
natural implementation of putting the repair executor in a worker job next to
the sampler that produced the data.

### 7.5 Day-atomicity and per-day checkpointing

Two properties belong to the Class C backfill specifically, and they are safety
properties rather than implementation preferences. **A day is atomic**: a day
whose round-1 read partially failed must never be written, because round 2
depends on round 1's output and a half-read day produces a plausible, wrong
total. And **progress is checkpointed per day**, so an interruption loses at most
one day of work. Both are specified, with their `path:line` anchors and the
`success === true && returnData === "0x"` hard-failure rule they depend on, in
§6.5.4.

### 7.6 The unknown-provenance hazard

**An unrecognised provenance value renders as unbadged and fully live.** This is
the most misleading direction a failure can fail in, and it is live today.

`WalletHoldingProvenance` is `"live" | "stub" | "stale" | "seed" | "backfilled"`
(`contract/src/dashboards.d.ts:89`), and the frontend switches on it by
equality:
`frontend/public/assets/js/app/alpine/views/allocation.js:112` tests
`h.provenance === "stub"`, `:115` tests `h.provenance === "stale"`, and `:123`
(added by #615) tests `h.provenance === "backfilled"`. Any value matching none of
them — including a new one the backend starts writing — takes no branch, gets no
badge, and is presented to the user as ordinary live data.

`provenance` has **no CHECK constraint** on any table
(`0014_wallet_balance_samples.sql:30` declares it `text NOT NULL DEFAULT 'live'`
with the permitted values in a *comment*), so a new value needs no migration —
which is precisely the trap. **Any new provenance value must land in the DTO
union and the renderer in the same change as the writer.** `'backfilled'` got
that treatment in #615 (union at `dashboards.d.ts:89`, renderer at
`allocation.js:123`); a quarantine state still needs it.

Stated precisely, because the distinction matters: Plan A says #615 "already
added `'backfilled'` to the union" — and since #615 merged (`7b92a8c`,
2026-08-15) that is now **true of `main`.** The union carries five values
(`dashboards.d.ts:89`), so a row written today with `provenance: 'backfilled'`
is a declared value rather than an unknown one. That closes the hazard for this
one value and for no other: the trap is structural, not specific to
`'backfilled'`, and the **next** value — a quarantine state — reopens it exactly
as described above unless the union and the renderer move in the same change as
the writer.

## 8. Disclosure of corrections

Everything in §5 through §7 is about changing numbers. A `revised` verdict
rewrites an observation; a `fabricated` verdict removes one. Both are correct
operations — and under the decided publication model (PD10, §9) **neither
touches a published figure directly**: a repair changes the *candidate*, and
published versions are frozen. §5 already states this as a rule — *a repair is
not a republication.* The reader who saw a figure yesterday and reloads today
into a silently different one, with no way to tell an honest correction from an
unstable methodology, a bug, or a system quietly editing its own history — that
failure is what the frozen model makes **impossible by construction**, not what
this section needs to warn against.

The magnitude such corrections can carry is still worth recording, and it is not
speculative. The originating audit measured it: cleaning v0's floor moved the
macro index from `0.610602` to `0.653632`, and `ICSA` alone contributed
`+0.039932` of the `0.046607` v1-v0 gap — **about 86% of it**, from one
indicator's source-absent keys. That restatement happened under v0's and v1's
**current, unfrozen** behaviour, where a recompute overwrites published state in
place (§9.3); it is the size of the thing the publish gate now stands in front
of, not an effect that can still occur silently here once §9 ships.

What the frozen model does **not** remove are two residual honesty risks, and
they are what this section is about:

- **A publish action that moves figures without saying which, and why.**
  Freezing relocates the restatement from every recompute to the moment an
  admin publishes a new version; it does not explain it. An unexplained version
  bump is the same honesty failure at a coarser grain — the reader can now see
  *that* something changed, and still cannot tell correction from bug from
  methodology drift. Disclosure is what closes that gap: the revision log
  (§8.1) records the causes, and the version diff carries them to each
  audience (§8.2, §8.3).
- **A published version left standing on data since proven fabricated.**
  Freezing cuts both ways: it protects readers from silent change, and it
  protects a wrong figure from correction. What happens to that version —
  annotate, or serve unmarked, or withdraw — is **PD15**.

Detection and repair without disclosure is still not self-healing — it is a
self-editing archive with a delay stage. The frozen model gives disclosure a
place to happen, at the publish gate; it does not perform it. This section
states what disclosure requires; §9 states the publication model itself.

### 8.1 A revision log is a hard prerequisite, and does not exist

`raw_indicator_history` is `(date, indicator, value, source)`
(`backend/migrations/0009_analytics_v2.sql:29-33` plus
`0024_analytics_provenance_source.sql:21`), and the writer is destructive:
`backend/src/analytics/store/raw-history-store.ts:68-69` issues

> `INSERT INTO raw_indicator_history … ON CONFLICT (date, indicator) DO UPDATE
> SET value = EXCLUDED.value, source = EXCLUDED.source`

with the module's own comment at `:45` noting that `ON CONFLICT` overwrites
`source` along with `value`. After that statement runs, **"this row changed" and
"this row was always this" are indistinguishable.** There is no prior value, no
timestamp, and nothing that records why.

So every repair must write an **immutable revision record**, and this is a
prerequisite of the repair executor rather than a follow-up to it. Each record
carries:

- the **series** and the **natural key** it applies to (for Class A, `(date,
  indicator)`);
- the **prior value** and the **new value** — or, for a quarantine, the prior
  value and the fact of removal;
- the **verdict** that produced it (§5);
- the **reconciliation run** that proposed it, so a batch is reconstructable as a
  batch and not only row by row;
- the **source evidence** that justified it — what the source returned for that
  key, at what time, from which endpoint;
- a **timestamp**.

**This is the same record quarantine needs to be genuinely reversible** (§7.2).
A quarantine that only sets a flag can be undone; a quarantine that can explain
what was removed, why, on whose evidence, and in which run is the thing an
operator can actually audit and revert. One mechanism, two uses — and building it
once avoids the alternative, which is a flag column now and a forensics
reconstruction later from data that was never kept.

Note also the interaction with `last_verified_at` (§7.2): that column answers
*when was this row last checked*, and the revision log answers *what has this row
been*. Neither substitutes for the other, and the second is the one disclosure
depends on.

### 8.2 Three audiences, three different needs

Disclosure is not one feature. Three consumers need different things from the
same event, and collapsing them produces a mechanism that serves none of them.

**Operators need to know a discrepancy was FOUND** — immediately, and
independently of whether anything was repaired. This explicitly includes the
cases the system **refuses** to act on: a batch refused by the blast-radius guard
(§7.3) means the reconciler saw something it could not safely touch, which is
strictly more urgent than a repair it could. A refusal that is silent is the
worst outcome available, because it looks identical to a clean run. Route this
through the existing alerts feed — `GET /api/admin/overview`
(`backend/src/admin/overview.ts:75`, `AlertLevel`) — per §11's no-new-operator-
surface constraint.

**API consumers need a machine-readable restatement signal.** A cache, a
downstream report, or an external agent must be able to distinguish *"the number
I already had has changed"* from *"I asked for a different window this time"*.
Without that signal the only way to detect a restatement from outside is to diff
two payloads and guess, which every consumer would then have to implement
separately and inconsistently. §9's published version is the natural carrier for
this, which is one of the reasons the frozen model makes the rest of this section
cheap rather than expensive.

**Dashboard readers need a plain explanation at the point of the number** — not
in a changelog, not on an admin page. **Use the seam-banner pattern #615
established for gaps** rather than inventing a second disclosure vocabulary: that
work already had to solve "explain, in place, why this series is not what you
expect", and a restated figure is the same problem with a different cause. Two
vocabularies for "this data is not straightforward" would be a worse outcome than
either alone. *(Verified in `main`: `seamMessage()` at
`frontend/public/assets/js/app/alpine/views/wallet-perf.js:124-137` composes at
most two sentences — a seed-share disclosure when `seedShare > 0.5` (`:126-131`)
and an unrecoverable-gap-day count when `gapDayCount > 0` (`:133-135`) — and
returns `null` when neither applies (`:136`). Its inputs are computed from the
endpoint's `historyProvenance` map and the dense calendar at `:87-92`; the banner
renders at `frontend/public/views/performance.html:50-53`, hidden by
`x-show="…&& seamMessage()"`. That "silent when there is nothing to say" property
is the part worth copying.)*

### 8.3 Derived-output amplification — disclose the figure, not the row

The most important property of a correction in this system is that **it does not
change one number.**

A raw revision changes every figure computed from that series, across the whole
window the computation spans. One corrected `ICSA` observation moves that
indicator's percentile, the macro panel index, the composite, and potentially the
**regime label** — for every date inside the 1095-day rolling window, not only
for the corrected date. The audit's measured `0.610602 → 0.653632` move is
exactly this effect: a set of raw keys changed, and a whole index moved. That
move describes v0's and v1's **current, unfrozen** behaviour, where the
recompute lands on readers directly; under §9 the identical cause produces a
**candidate version whose diff against the published one spans the same blast
radius**, waiting at the publish gate.

The consequence for disclosure is a rule, not a nuance: **the version diff must
be expressed at the level of the published FIGURE, not the raw row.** Saying
"one observation was corrected" while the diff moves an entire history of
composite figures is technically true and materially misleading — it invites
the reader to assume a localized fix. What a reader needs to know is which
published figures move between version N and N+1 and over what span, which is a
statement about outputs. The revision log (§8.1) records the causes; the
disclosure describes the effects; and the two are joined by §9's version diff,
which is the only artifact that actually knows the full blast radius of a
recompute.

## 9. Frozen, versioned publication

**Decided by the product owner on 2026-08-15** (PD10). This is settled, not
proposed. What follows states the model, what already exists, what it reverses,
and why it is a verification instrument and not merely a publishing workflow.

### 9.1 The model

- **Historical reports are FROZEN.** Published figures do not change under
  readers.
- They are **VERSIONED**, and the version is **DISPLAYED**.
- An admin may **refresh calculations**, which computes a **next** version.
- **Computing a next version does NOT publish it.** Publishing is a separate,
  explicit admin action.
- A newly computed version **identical to the prior one is a NOOP** — which is
  equivalent to a passing audit, and is the normal expected outcome.

That last property is the one to keep in view: under this model the *routine*
result of a refresh is "nothing changed", and a non-empty diff is the exception
that demands attention. That inverts today's arrangement, where a recompute
overwrites published state unconditionally and a change is invisible by
construction.

### 9.2 What already exists

`regime_snapshots` already carries a `version` column — `version text`, added by
`backend/migrations/0009_analytics_v2.sql:23`, and named in that migration's own
header (`:4`) as part of the ported `computeRegime` output. The value is
`CURRENT_REGIME_VERSION`, exported from
`backend/src/analytics/analyze/regime-versions.ts:8` as `"v3"`; it is stamped
onto every snapshot at `backend/src/analytics/index.ts:497`, written and read
through `backend/src/analytics/store/regime-store.ts` (`:39` in the insert column
list, `:46` in the bound values, `:67` as `version = EXCLUDED.version` on
conflict, `:99` when reading a row back), and reaches the DTO at
`contract/src/dashboards.d.ts:259` as `version?: string | null`.

**Most of the machinery is therefore already built, and this is the single most
important practical fact in this section.** `regime-versions.ts` states in its own
comment that under v3 *"every run recomputes the full history on best-available
raw data"* — so the **full-history recompute already runs, daily.** What the
decided model needs is not a new computation. It needs three things layered onto
one that already exists:

1. stop that recompute overwriting published state;
2. diff the candidate against the published version;
3. gate publication behind an explicit admin action.

**The cost is in the publish workflow, not in the computation.** Anyone sizing
this work from the words "versioned historical reports" will overestimate it
substantially.

One schema fact bounds the work in the other direction, and must not be missed:
**`regime_snapshots` cannot currently hold two versions of the same date.** Its
primary key is `date` alone (`backend/migrations/0002_dashboards.sql:53`), and the
upsert overwrites `version` in place (`regime-store.ts:67`). Holding a
computed-but-unpublished candidate alongside the published row is therefore a
schema change and not merely a code change — an unavoidable cost of the model —
and retaining a *superseded* version is a further one, which is PD12.

### 9.3 This reverses v3's stated semantics, and should be v4

Today `version` is a **methodology tag**: which algorithm produced the row. It is
not a publication vintage. `regime-versions.ts:1-7` says so directly — it
describes itself as a *"Methodology version tag stamped on every persisted regime
snapshot row"*, and v3 explicitly disclaims freezing:

> v3: point-in-time inverse-correlation weighting (trailing 3y window per day,
> 21-day refresh, 25% cap), **no frozen lockout** — every run recomputes the full
> history on best-available raw data. Raw inputs remain strictly append-only
> (`raw_indicator_history` via `mergeSeries`); only the DERIVED labels are
> recomputed.

**v0 was the frozen one.** Its `data/regime/regime-history.csv` is frozen-vintage
via `mergeFrozenIntoResult` (`update.js:131`), so a published row stayed as
published unless a deliberate relock was performed with `rebuild.js --version` —
and the audit's judgement on that arrangement is the relevant precedent here:
*"That is a product decision, not a code fix, and should be taken explicitly."*
The audit records elsewhere that v0 *"handles the point-in-time concern at the
publication layer instead (frozen `regime-history.csv`), which is a deliberate,
documented choice."* *(Both quoted from
`docs/code-review/20260814-review-data-integrity-macro-index-discrepancy.md`;
the v0 file and line are the audit's, **unverified** in this repository, which
does not contain v0.)*

So the decided model returns to freezing, and adds an explicit publish gate v0
did not have. Because that changes **what a published number means** — from "the
current best recomputation" to "the figure published as version N" — it is a
methodology-level change and should be tagged **v4**.

**Recommendation: record it as a `docs/decisions.md` entry, not only here.** A
change to the meaning of a published figure is exactly the class of thing
`decisions.md` exists for, and the negative example is already in this document:
"Open Question 9" is load-bearing and has no canonical record anywhere (PD3),
which is why reversing it is awkward. Do not create a second instance of that
problem. The entry should state the model of §9.1, tag the methodology `v4`, and
name the `regime-versions.ts` comment it displaces — which, as with PD3, **must
be edited in the same diff**, or the repo ships a `v4` whose own version file
still says there is no frozen lockout.

### 9.4 Noop-as-audit is a first-class verification instrument

The most valuable property of this model is not that readers get stable numbers.
It is that **comparing a candidate recompute against the published version
detects three distinct causes of change at once:**

1. **the source revised its data** — what the Class A reconciler (§6.4) is built
   to find;
2. **we repaired our own persisted data** — the reconciler's own writes, and the
   Class C backfill's;
3. **our own computation changed.**

**The third is invisible to a reconciler that only compares stored values against
sources**, and that blind spot is not hypothetical. A refactor that silently
shifts the composite — a changed window boundary, a reordered fold, a corrected-
looking rounding change — leaves every raw row exactly as the source has it. A
value-level reconciler compares those rows to the source, finds perfect
agreement, and reports a clean run while the published index has moved. Under
this model the same change surfaces immediately, as a **non-empty candidate diff
against an unchanged published version**: nothing in the inputs moved, so
anything that moved is us.

That makes the periodic candidate recompute a **standing verification of the
computation itself**, in the §1 sense — a comparison performed on a schedule
whose null result is meaningful. It is the only mechanism in this design that
covers the computation layer at all; §5's verdicts cover stored values, and §6.2's
Class B recompute covers one series' outputs against its own inputs, but neither
notices a methodology drift that is internally consistent.

Two design requirements follow.

**The revision log explains the version bump.** The diff between two versions says
*what* changed — which figures, over which span (§8.3). The revision records of
§8.1 say *why*: which source keys were revised or quarantined, on what evidence,
in which run. A version bump with a non-empty diff and no corresponding revision
records is precisely case 3 above, and should be read as such rather than
explained away.

**A published version must be resolvable.** An external citation of a figure —
in a report, a post, another system's stored copy — stays meaningful only if the
version it was read under can still be resolved to the figures it published.
Whether superseded versions are retained and served is PD12, and it is the
question that decides whether that property actually holds.

### 9.5 A trap: `analytics_submissions` is unrelated

`backend/migrations/0023_analytics_submissions.sql` looks like an existing
approval workflow to build on — its header comment even reads *"No auto-publish:
everything lands 'pending'"* (`:5`), and it carries a
`status … CHECK (status IN ('pending', 'accepted', 'rejected'))` (`:14`). **It is
not related.** The same header describes it as *"public, anonymous
agent-onboarding / community-commit submissions"* mirroring
`committee_applications` (`:1-4`); it moderates third-party submissions, not the
publication of computed analytics. The name and the no-auto-publish comment make
this a very plausible wrong connection, which is why it is recorded here.

## 10. The silent-zero defect class

The same defect keeps appearing on unrelated rails, and it is worth naming as a
class because a fix on one rail teaches nothing about the others unless the
shared shape is stated. The shape is **a wrong computation that reports
success**, and it has two sub-forms:

- **An absent answer decodes as a real value** — the chain and extract rails
  below.
- **Unreachable configuration degrades silently while still reporting success**
  — the config rail, §10.1.

The generalization matters to this design specifically. **A reconciliation loop
that only compares persisted values against sources catches neither sub-form.**
The first produces a value the source will happily agree with; the second
produces a value with no source to compare against at all. Both require the
value to carry *whether it was computable*, not merely what it was — which is
the same property §5 requires of `unexplained_absent`, and the reason every
executor in §6 must be able to fail a key rather than write a plausible one.

**Chain rail.** `decodeUint256("0x")` returns `0n`
(`base-rpc-client.ts:48-52`). Its own comment is honest about the trade —
*"An empty `0x` (e.g. a call to an address with no code) decodes to 0n rather
than throwing — callers decide from context whether 0n means 'really zero' or
'unreachable'"* — but no caller currently decides. Multicall3 returns
`success: true` with `returnData: "0x"` for an address with no code, so there is
no revert to catch. On the live path this is harmless: the contracts are all
deployed. On a **block-addressed historical** read it is not: a contract
deployed *after* the target date decodes to a clean, fabricated `0`, which then
becomes a plausible-looking AUM row. Block-addressed reads must let callers
distinguish empty-return from genuine zero, must treat
`success === true && returnData === "0x"` as a **hard failure for that day**,
and should carry a per-address earliest-valid-block floor so days preceding a
target's deployment are skipped rather than zeroed. Live-path semantics must not
change.

**Extract rail.** `fetchAll` wraps each source in a `try` and returns `[ind.id,
[]]` on any error (`backend/src/analytics/extract/sources.ts:104-108`), so a
**failed** fetch and a genuinely **empty** one are indistinguishable
downstream; `mergeSeries` then silently prefers whatever arrived. The run log
prints the failure, but nothing structural consumes it, and the fetch summary
immediately after (`:113-116`) reduces the outcome to `rows=0`. For a
reconciler this is fatal: an empty array from a failed fetch, compared against a
healthy persisted floor, means *every* persisted key looks source-absent. That
is exactly the input that must classify `unexplained_absent` and trip the
degeneracy guard — never `fabricated`.

### 10.1 The config rail — undeliverable variables that fail silently

The mechanism here is a delivery boundary rather than a decoder, but the outcome
is identical: a live code path computes a wrong answer and reports it as `ok`.

**The compose `environment:` block is a test-enforced allowlist.** The `api`
service's block (`docker-compose.yml:170`) says so in its own comment
(`:170-177`): there is no `env_file:` in any compose file and `backend/Dockerfile`
sets no `ENV`, so **a variable not named there never reaches the container.**
That premise is asserted rather than assumed —
`scripts/tests/integration/demo-compose-config.test.ts:520-529` greps all three
compose files for `env_file:` and the Dockerfile for `^ENV `, requiring `false`
for all four. **#641** records that roughly twenty variables read by
`backend/src/config.ts` sit in that undeliverable bucket, and **#643** proposes
the generalizing guard: a test that fails on any env name read on a live path
under `backend/src/` and absent from every compose `environment:` block, unless
explicitly listed as intentionally host-side-only. *(The allowlist mechanism and
its guard test are verified in this checkout; the ~20-variable count is #641's
and was not re-counted here.)*

Three filed instances, each a different route from that boundary to a quietly
wrong number:

- **`BUYBACK_FROM_BLOCK` (#640) — a typo permanently disables the indexer with
  no warning.** `backend/src/chain/buyback-logs.ts:215` reads
  `Number(process.env.BUYBACK_FROM_BLOCK ?? "0")`, and the only diagnostic is
  guarded by `floor <= 0` (`:216`, warning at `:222-224`). A typo such as
  `43,741,600` makes `Number()` return `NaN`; `NaN <= 0` is **false**, so the
  warning is skipped. `floor` then feeds `let from = Math.max(…)` at `:242-245`,
  whose two arms fall back to `floor` when the persisted scan cursor and
  `MAX(block_number)` are null — so on a fresh database `from` is `NaN`,
  `from <= latest` at `:253` is false, and the chunk loop never executes. Zero
  work, no warning, indefinitely. *(Code verified in this checkout.)*
- **`STRATEGY_VAULT_*_ADDRESS` (#642) — wrong numbers live in production now.**
  All five keys (`backend/src/config.ts:246-251`) are undeliverable, and
  `resolveStrategyVaults()` (`:253`) returns an empty list by default, so
  ZYFAI-SS1 and GIZA-SS1 NAV is permanently pinned to the documented degraded
  idle-USDC-only mode. The maintenance mechanism the #120/#145 design depends on
  — an owner-maintained vault list, opt-in per vault, because *"the agent
  rotates vaults every 1-2 days"* — cannot be operated in a containerized
  deployment at all, so the accepted "drift risk" is in fact the guaranteed and
  only behaviour. *(The key list and the empty-by-default resolver are verified
  here; the characterization of the live production impact is **#642's finding**,
  not an independent verification by this document.)*
- **SP500 sizing (#641) — a plausible dollar figure with no staleness signal.**
  `readChainAmounts` sets `{ ok: true, amount: SP500_SIZE }` unconditionally for
  the `config` valuation kind (`backend/src/chain/wallet-balances.ts`), so a
  stale size never degrades to `stale` the way a failed chain read does.
  *(Verified in this checkout.)* **#641 resolved only half of this**: it made
  `SP500_SIZE` a committed constant (`backend/src/config.ts`) and dropped the env
  override, which no container could receive anyway, so drift is now at least
  visible in a reviewed diff. The DTO still carries no signal distinguishing a
  stale size from a live read — deliberately, because an honest one needs a
  stated-at date to travel with the size (recorded at the `config` leg in
  `wallet-balances.ts`), which is a design question this section owns.

**Why this belongs here rather than only in #647.** Each of the three produces a
value that a source comparison either cannot see — SP500's *size* has no source
to compare against, which is the same fact that makes it unbackfillable (§12) —
or would misread as a genuine observation, since `indexed: 0` is a true
statement about an indexer that never ran. The design consequence is exactly the
one §5 draws for `unexplained_absent`: **what a detector consumes must carry
whether the value was computable, not just what the value was.** An `ok: true`
that means "we did not even try" is indistinguishable from a real read at every
layer above it, and no amount of comparing numbers to sources recovers the
difference.

## 11. Constraints inherited from the existing system

These are not negotiable within this design; a proposal that violates one is
proposing a different change.

- **The issue #106 persistence boundary.** The producer holds no `DATABASE_URL`
  and submits through authenticated typed routes. Any new write path is a new
  typed verb under `/api/analytics/*` with server-side validation before the
  transaction opens, not a script with a connection string.
- **Keyless sources only, GeckoTerminal and Yahoo hosts only.**
  `backend/src/chain/token-prices.ts:3-8` is explicit: *"this file reaches ONLY
  the GeckoTerminal (crypto) and Yahoo (SP500) hosts … No Alchemy/DexScreener/
  CoinGecko/Dune/Supabase host or import."* CoinGecko is reachable and **banned**.
  New GeckoTerminal *endpoint* code is explicitly permitted (`:6-8`), so a daily
  OHLCV fetcher is in bounds — but `runGeckoBatch` must not be reused: it is
  address-keyed with no time dimension and targets a spot-only endpoint. Copy
  the pattern, not the code.
- **Pool addresses are derived, never configured.** The OHLCV endpoint is keyed
  by *pool*, not by the token addresses the spot path uses. An earlier draft of
  the wallet plan called populating `WETH_POOL_ID` / `ROBOTMONEY_POOL_ID` /
  `BNKR_POOL_ID` a blocker on historical prices; **the revised plan retracts
  that** — those vars are dead and there is nothing to populate. The resolution
  mechanics and their two load-bearing properties (volume-sort, not
  reserve-sort; resolve once and cache) are specified once, in **§6.5.2**.

  The dead-code claim needs stating more precisely than **#639**'s title does,
  since that title says "zero readers" and the env vars *are* read: `config.ts`
  reads all three (`:182`, `:187`, `:189`, `:201`, and `resolveWeth()` at
  `:297`) and assigns them into `TrackedAsset.poolId` (`:157`). It is **`poolId`
  that has no readers** — `grep -rn poolId` outside `backend/src/config.ts`
  returns nothing anywhere in the repo. #639's remedy is unaffected, because it
  deletes the whole chain: the three vars, the field, `resolveWeth()`'s half of
  it, and the unconsumed `config.weth`. *(Verified in this checkout.)*
- **The D15/D16 honesty invariant, whose enumeration is closed.**
  [decisions.md D16](../decisions.md) at `docs/decisions.md:372-374` states it as
  a **closed list**: *"a value is either a real read, a labelled stub, or the
  last-persisted sample marked `stale`/`seed` — never presented as live."* Three
  admitted states, joined by "either/or". A quarantined or reconciled row is a
  **fourth state the list does not admit**, so the tension must be resolved
  explicitly rather than left implicit.

  **The resolution: the enumeration governs what is *presented*.** A quarantined
  row is excluded from every read path, so it is never presented as anything at
  all — it is outside the enumeration's scope rather than a violation of it. The
  invariant constrains the DTO surface, not the storage layer; nothing in D16
  says the database may hold only those three kinds of row. A `revised` row, by
  contrast, is squarely inside the enumeration: it *is* a real read, freshly
  re-fetched from source, and needs no accommodation.

  Adopting that reading is **PD4**, and **PD10** strengthens it prospectively:
  a row quarantined before publication cannot silently move a published figure
  either, so it is unpresented twice over. One case escapes both exclusions —
  a version already **published** from figures computed with the row, then
  retained and served under PD12, keeps presenting figures derived from it.
  That retrospective case is **PD15**, and the presentation-only reading does
  not cover it.

  **The hard consequence:** if a quarantined row ever does reach a DTO — an
  operator surface that lists what was quarantined, say, or a per-point flag
  that survives into a chart payload — then it is being presented, the
  read-path-exclusion argument evaporates, and **the enumeration must be
  extended in a decision entry first**, not in the same PR that ships the
  renderer. This design extends the invariant from write time to standing
  verification; it does not weaken it.
- **Cadence declared once, not restated** (#637) — see §6.1.
- **No new operator surface.** Verdicts and freshness alerts land in the
  existing `GET /api/admin/overview` alerts feed
  (`backend/src/admin/overview.ts:75`, `AlertLevel`), not a parallel dashboard.

## 12. What will remain imperfect

Stating these up front prevents the design being read as a promise it cannot
keep.

- **SP500 has no position history, so the recommendation — pending PD7 — is to
  skip it, not approximate.** The price is recoverable from Yahoo —
  `fetchYahoo(symbol, startUnix, endUnix,
  timeoutMs)` (`backend/src/analytics/extract/yahoo.ts:44`) already takes a
  range — but the position *size* is a single present-tense constant, the
  committed `SP500_SIZE` (`backend/src/config.ts`, since #641), with
  no history and no positions API. Multiplying today's size by a past price
  **fabricates a quantity**. (A 365-day `^GSPC` call returned 252
  points: weekends and holidays are absent and would need forward-filling
  anyway.) A second, independent reason arrived with **#648**: the column already
  splices a v0 Hyperliquid-perp-derived quantity onto v1's Yahoo `^GSPC` quote,
  with no seam marker and no decision record. The decision is **PD7**.
- **`2026-03-24` and `2026-06-04` are recommended — pending PD8 — to stay
  missing.** They are literal omissions
  from the seed constant: `LABELS` in
  `backend/src/chain/wallet-history-seed.ts:17` jumps `"Mar 23","Mar 25"` and
  `"Jun 3","Jun 5"`. The surrounding days are unreconciled baked UI constants,
  so splicing archive-derived values between them mixes two incompatible bases.
  Leave them, or interpolate from neighbours and label `'seed'` — a judgement
  call, not a correctness question. **PD8** takes it, and recommends leaving
  them.
- **`NEW_TOKENS` accumulates forward by design**, per its own registry entry
  (`indicators.ts:317`) and the calendar guard's comment describing it as *"the
  single-point-per-run NEW_TOKENS accumulator"*
  (`floor-seed-calendar.ts:41-42`). It has no re-servable window; it is
  permanently `unverifiable`.
- **`HY_OAS` pre-history is unrecoverable** (D7). FRED serves `BAMLH0A0HYM2`
  only as a trailing ~3y window; the `cosd=2010` workaround `fred.js` documents
  as the fix does not work for this series. Its 1095-day percentile window sits
  exactly at the edge of what the source can re-serve, and the two
  implementations' different spans measurably changed panel weights. Disclose,
  never repair.
- **Four incompatible provenance vocabularies, none CHECK-constrained.** All
  four, since naming only two invites the reader to assume the other two agree
  with them: **(1)** `WalletHoldingProvenance`,
  `"live" | "stub" | "stale" | "seed" | "backfilled"` (`dashboards.d.ts:89`);
  **(2)** `AnalyticsProvenance`, `"live" | "hermetic" | "fixture" | "seed"`
  (`dashboards.d.ts:173`) — same `"live"` and `"seed"` tokens, different
  meanings, no overlap on the rest; **(3)** the chain samplers' SQL vocabulary,
  declared only as the column comment `'live' | 'stub' | 'stale' | 'seed'` on
  `wallet_balance_samples.provenance`
  (`0014_wallet_balance_samples.sql:30`) — now also stale, since it predates
  `'backfilled'`; **(4)** the analytics tables' nullable `source` column
  (`0024_analytics_provenance_source.sql:21-22`), whose
  `live`/`hermetic`/`fixture`/`seed` values likewise live in a migration
  comment (`:10-20`), with NULL meaning genuinely-unknown pre-migration
  history. The SQL columns constrain nothing. **Six persisted series carry no
  provenance column at all** — `research_signals`, `vault_share_price_history`,
  and the four `daily_*_snapshots`. *(Column-absence count inherited from the
  reconciliation doc; **unverified** here.)* Unifying these should be its own
  issue, taken **before** a fifth vocabulary is added, not after.

## 13. Open questions and settled residue

The ones that are *decisions* — with options, consequences and a recommendation
each — are in **Pending decisions** at the top of this document, and are not
repeated here. In particular: the unfiled archive-read `decision:` issue is
**PD1**, the D16 clarification-versus-supersession question is **PD2**, the Open
Question 9 record is **PD3**, whether a keyed RPC provider is acquired is
**PD6**, and the sub-questions left open by the decided publication model are
**PD11–PD13** and **PD15** (PD14 is closed by §9.1's own statement). What
follows is the residue — of four entries, the first is settled (recorded so it
is not re-litigated), the second is a measurement task, and only the last two
are questions open because nobody has the answer yet rather than because nobody
has chosen.

- **Resolved, and not in the direction an earlier draft assumed: `source:
  "live"` on the wallet-balances DTO is not a defect.** It was filed as **#645**
  and **closed NOT_PLANNED on 2026-08-15T18:39Z**, on the grounds that the
  issue's premise was wrong. The ~99 seed points in the wallet history are
  **genuine observed data from v0's production wallet-balance crons** — not
  fabricated, not forward-filled. The decisive evidence in the closing comment:
  v0's separately recorded `totalAum[]` array, dropped during the port to
  `backend/src/chain/wallet-history-seed.ts` and never previously used as a
  cross-check, agrees with the sum of the eight rounded per-asset legs to within
  $2 on **99 of 99 days** (exact on 43) — the arithmetic signature of one
  full-precision dataset totalled and then rounded, which no fill or synthesis
  produces. `resolveBaseRpcSource()` (`backend/src/config.ts:25`, consumed at
  `backend/src/chain/wallet-balances.ts:221` and `:265`) reports which *reader*
  the deployment is configured against and makes no claim about history
  composition, so it is truthful on its own terms.

  **The design consequence: a `seed` row is genuine history, not a defect.**
  Nothing in this document should treat provenance `seed` as a synonym for
  suspect, and the two seeds in play are unrelated — the *analytics floor* seed
  of §1 genuinely inherited 110 source-absent `ICSA` keys (audit D6), while the
  *wallet history* seed did not. What #645 left behind was a **disclosure** gap,
  not a data-quality one — and **that gap has since closed on `main`.** When this
  was first written, `loadHistory()` selected only `sample_date, symbol,
  value_usd` and discarded the `provenance` column the schema stores, so no
  consumer could tell seed from live at any granularity. #615 fixed exactly that:
  `loadHistory()` is now at `backend/src/chain/wallet-balances.ts:181` and its
  query selects `provenance` (`:182-186`), the function returns a
  `historyProvenance` count map alongside the series, a per-point dominant value
  is resolved by `dominantProvenance` over the `PROVENANCE_PRIORITY` order
  `["live", "backfilled", "stale", "seed", "stub"]` (`:175-179`), the DTO carries
  `historyProvenance: Record<WalletHoldingProvenance, number>`
  (`contract/src/dashboards.d.ts:161`), and the seam banner (§8.2) renders it.
  **The remaining §13 item here is therefore the design consequence, not the
  defect:** a `seed` row is genuine history and must not be treated as suspect.
  *(Issue state and closing comment read from `gh` on 2026-08-15; the v0
  `totalAum[]` reconstruction is #645's own work and is **unverified** here. The
  `loadHistory` disclosure fix is verified against `main` at `7b92a8c`.)*
- **Rate limits need re-measuring from the production droplet.** The ~5-token /
  ~0.55-per-second figures were measured from a different IP. Shared NAT could
  make production strictly worse, and every §6.3 and §6.5.3 cost conclusion
  depends on them. This is a measurement task, not a decision — but PD6 cannot be
  sized without it.
- **How production v1 escaped the polluted seed is unresolved** (audit §12).
  `applyRawFloorSeed` preserves source-absent seed keys, yet the captured output
  matched the source-date-cleaned model in 74 indicator-day comparisons across
  59 unique dates. Do not infer startup self-healing from the clean output. If
  production *did* self-heal by some path, that path is worth finding before
  building a second one.
- **Unquantified:** what fraction of the current production floor would classify
  `fabricated` on first run. Until that is measured against real production
  data, the rewrite-ratio bound in §7.3 cannot be set to a defensible number.

## 14. Provenance of the claims in this document

Precision about what is known versus inferred matters more here than usual,
because this design proposes automated deletion-shaped operations on production
data.

**Measured directly against live systems** (Plan A investigation, 2026-08-14/15;
not re-verified in this checkout):

- Archive RPC behaviour at `https://mainnet.base.org` — differing balances at
  40 / 90 / 180 / 365-day depth, the correct `"0x"` at a pre-deployment block,
  and the Multicall3 read path succeeding historically.
- The batching and rate-limit numbers — the batch cap of 10, per-sub-call
  metering, the ~5-token / ~0.55-per-second bucket, the 27:1 Multicall3 leverage,
  and the 540-reads-in-38.2s validation.
- Production database state — the wedged schedules, the DB bootstrap timestamp,
  and the 42 absent AUM days, read read-only from the production droplet.
- GeckoTerminal endpoint behaviour — UTC-midnight-aligned daily candles, the
  ~6-month server window, volume-sort versus reserve-sort pool selection, and a
  keyless 429 observed on the 6th call in ~15s.

**Read from code and verified in this worktree** at
`adhoc/20260815-173700-data-integrity-self-healing-design`: every `path:line`
citation in the *Pending decisions* section and in §3, §5, §6.1, §6.3, §6.4,
§6.5, §7, §10, §11, and §12 was opened and checked. **This revision was rebased
onto `main` at `7b92a8c` (PR #615's merge commit) and re-checked against it.**
An earlier draft recorded `backend/src/ops/series-registry.ts`,
`backend/src/ops/gap-detector.ts`, `/api/admin/gaps`,
`backend/src/worker/handlers/slot.ts`, `'backfilled'` in
`WalletHoldingProvenance`, the `/performance` seam banner, and the
`research_signals` producer catch-up as *confirmed absent from `main`*. **That
was true of the pre-merge checkout and is false now** — all seven are in `main`,
and every claim about their contents above was read from the merged files rather
than inherited. Also confirmed here: the `*_POOL_ID` env vars are assigned into
`TrackedAsset.poolId` in `config.ts` and read **nowhere else** in `backend/src`.
This inversion is itself the §14 point: an absence verified against a checkout is
dated evidence, not a standing fact.

Verified for §8 and §9 on 2026-08-15: the destructive upsert at
`store/raw-history-store.ts:68-69` and its `source`-overwrite comment at `:45`;
`version text` on `regime_snapshots` at `0009_analytics_v2.sql:23` and its
mention in that migration's header at `:4`; `CURRENT_REGIME_VERSION = "v3"` at
`analyze/regime-versions.ts:8` with the v3 comment quoted verbatim from `:1-7`;
the stamp at `analytics/index.ts:497`; the four `regime-store.ts` sites (`:39`,
`:46`, `:67`, `:99`); the DTO field at `contract/src/dashboards.d.ts:259`;
`regime_snapshots`' `date`-only primary key at `0002_dashboards.sql:53` inside
the table at `:52-62` — from which the finding that **the table cannot hold two
versions of the same date** is derived here, not inherited; and the
`analytics_submissions` trap at `0023_analytics_submissions.sql:1-5` and `:14`,
whose header describes public anonymous agent-onboarding submissions mirroring
`committee_applications`. #615's seam banner was previously listed here as
unverifiable; it is now verified in `main` at
`frontend/public/assets/js/app/alpine/views/wallet-perf.js:124-137` and
`frontend/public/views/performance.html:50-53`. **Not** verified here: v0's
`mergeFrozenIntoResult` and `rebuild.js --version` (quoted from the audit; this
repository does not contain v0). The audit passages quoted in §9.3 were read from
`docs/code-review/20260814-review-data-integrity-macro-index-discrepancy.md` in
this checkout.

Verified for the absorbed specifications (§6.4, §6.5) on 2026-08-15: the two
hardcoded `"latest"` strings are the only two in `backend/src/chain/`
(`base-rpc-client.ts:374`, `:483`); **thirteen** exported functions take
`RpcCallOptions`, at the thirteen lines listed in §6.5.1 — the absorbed plan said
fourteen, and thirteen is the count in this checkout; `multicall3Aggregate3`
(`:473`) routes through `ethCall` (`:475`); the `id: 1` hardcode is at `:313`;
`rpcOpts()` (`wallet-valuation.ts:143`) returns `{ rpcUrl }` alone and round 2's
`convertToAssets` block begins at `:269`; `asofOf()`
(`worker/handlers/analytics.ts:24-25`) reads
`(payload.asof as string) ?? new Date().toISOString().slice(0, 10)`; the
`buyback_scan_state` single-row table is at `0015_buyback_swaps.sql:42-46`; the
sampler's UTC day key is `worker/handlers/wallet.ts:49`; `fetchYahoo`'s range
signature is `extract/yahoo.ts:44`; the ZYFAI/GIZA smart-account documentation and
their `strategy`/`usdc` kinds are `config.ts:172-180`; `resolveSp500()` is
`config.ts:267-273`, consumed for the ticker at `token-prices.ts:270`;
`runGeckoBatch` is `token-prices.ts:203-224`; and `LABELS`'s two omissions are at
`wallet-history-seed.ts:17`. **Not** verified here: every GeckoTerminal OHLCV and
pool-selection measurement, every RPC batching and rate-limit number, and the
date→block arithmetic (2s blocks, 43200/day, ≤8 calls per date) — all are
2026-08-15 investigation results, marked *unverified* where they appear.

Verified for §10.1 in this checkout on 2026-08-15: the compose allowlist premise
(no `env_file:` in any of the three compose files, no `ENV` in
`backend/Dockerfile`) and its guard test at
`demo-compose-config.test.ts:520-529`; the `BUYBACK_FROM_BLOCK` `NaN` path
through `buyback-logs.ts:215`, `:216`, `:242-245` and `:253`; the five
`STRATEGY_VAULT_*_ADDRESS` keys and the empty-by-default
`resolveStrategyVaults()`; and the unconditional `{ ok: true }` for the `config`
valuation kind at `wallet-balances.ts:93`. **Not** verified here and attributed
to their issues: #641's ~20-variable count, #642's characterization of the live
production impact on `/allocation` and `/performance`, and #645's reconstruction
of v0's `totalAum[]` cross-check.

**Read from GitHub** on 2026-08-15 with `gh issue list` and `gh issue view`: the
state and titles of #639–#648 and #624; #645's NOT_PLANNED closure and its
closing comment; #648's body, including its own statement that an SP500 backfill
is out of scope; and the **absence of any `decision:` issue for archive-capable
reads** — the only open `decision:` issues are #623 and #629, and the closed set
is #621, #583, #524, #520, #502, #447, #342, #228, #163, #145, #99. Issue state
is used here only for *what is tracked where*, never as evidence that code
exists — see the standing warning below.

**Inherited from the audit** and not independently re-derived: the D1 mechanism
and its numeric attribution, the D6 source-key classification counts (110 / 14
source-absent keys), the D7 FRED truncation finding, and the 74/74 clean-model
match. The audit's own caveat applies with full force and is repeated here
because it is easy to lose in a summary: **the dated captures are observations,
not timeless constants.** In its words, *"These are dated observations, not
stable live constants"*, and *"current values must be re-fetched and separately
timestamped rather than compared with the historical capture as if all inputs
shared a vintage."* Any acceptance test written against a specific decimal from
that review will be flaky by construction; write tests against the *structural*
claims — Saturdays-only for `ICSA`, business-days-only for `DTWEXBGS` — which
are the parts immune to revision or vintage.

**A standing warning on verification method**, from the same investigation:
issue #344 is a confirmed instance of an issue closed COMPLETED with nothing
delivered. Verify deliverables against `main`, never against issue status — a
ticked acceptance criterion is not evidence that the code exists.
