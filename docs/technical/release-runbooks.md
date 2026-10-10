# Release process — foundational runbook policy

> **Agent Note:** To find info quickly, see the TOC below. §9 explains when to create a release-specific runbook. There is no active unnumbered deployment plan in this document.
>
> **Table of Contents:**
> - [1. Scope and authority](#1-scope-and-authority)
> - [2. Release branch](#2-release-branch)
> - [3. Version tags and release candidates](#3-version-tags-and-release-candidates)
> - [4. Foundational release workflow](#4-foundational-release-workflow)
> - [5. Per-release runbook format](#5-per-release-runbook-format)
> - [6. Per-release GitHub tracking issue](#6-per-release-github-tracking-issue)
> - [7. Backporting](#7-backporting)
> - [8. Compatibility contract](#8-compatibility-contract)
> - [9. Tracking upcoming releases](#9-tracking-upcoming-releases)

> **Status: in effect.** This document defines the foundational release-runbook
> policy for future per-release runbooks. It is not itself a runnable checklist.
> Historical per-release procedures were retired during the 2026-09-23 docs
> cleanup; recover them from Git if an audit requires the exact record. Create a
> new runbook only when a release is scheduled and the tools exist at its target
> commit (see §§5, 9).

This is not the process for landing ordinary feature work — that is PR review
against `main`, covered by [CONTRIBUTING.md](../../CONTRIBUTING.md) and the CI
taxonomy. This document is specifically about the step where a set of
already-merged `main` history is packaged, gated, and cut over into
production.

## 1. Scope and authority

**Deployment mechanism:** [Smoke production spec](./smoke-production-spec.md)
is the sole adopted design (D47; approved for implementation, not yet shipped).
This document owns release policy: gates, phases, evidence and approval. The
retired D46 mechanism and external `stack`/Kubernetes proposals are not alternate
ways to implement that design. Release-specific commands must identify the
implementation and exact commit they exercise. The mechanism updates below do
not waive any release gate.

Every production rollout of a numbered release must be planned, rehearsed, and
executed from a per-release runbook that conforms to this policy. The
per-release runbook is the **definitive, agent-executable procedure** for that
release — not the tracking issue (§6), and not tribal knowledge held by
whoever last did a rollout. The tracking issue's checklists exist to gate
progress through the runbook, not to duplicate or replace its content.

**Agent-executed, end to end ([D61](../decisions.md#d61), owner 2026-10-08).** Four rules bind
every runbook. (1) No human in the loop: an agent executes every step, and the operator's
authority is one recorded go given before the run. (2) The production runbook is rehearsed
unmodified on stage: the same runner, commit and step list, with only the target file
different. (3) Every database operation is a committed script with a receipt. (4) Everything
runs from the control machine over SSH with `bun run release:run`; no step asks a person to log
in to a host and type. A step that breaks a rule is a `gap` that blocks the release.

No release may skip a gate described here unless the release tracking issue
explicitly records the exception, the reason for it, and operator sign-off.

**Two layers of runbook, and the second adds to the first.** The global
[standing runbook](../runbooks/release-standing-runbook.md) lists the checks every
release runs, by phase, and is cumulative: a check enters it when a release needs
it and leaves only by a recorded owner decision. A per-release runbook
inherits all of it and adds its own release-specific checks. It never copies a
standing check, never replaces one, and records any exception (reason, approving
owner, issue that restores it). A release whose runbook omits a standing check
without an exception is not ready.

## 2. Release branch

Each release ships from a branch named `releases-A.B.x`:

- literal, plural **`releases`** (not `release`),
- `A.B` are the integer major and minor version being released,
- a literal trailing **`x`** where the patch number would go — the patch
  number is deliberately left blank, because the branch holds the whole
  `A.B` line, patches included.

Example: `releases-0.2.x` for the 0.2 line.

Feature PRs never target `releases-A.B.x` directly — ordinary feature work is
reviewed and merged via PR against `main`, exactly as this document's intro
paragraph says. Once a release's scope is decided, the branch receives changes
only by these routes (owner, 2026-10-09, D62):
(a) default: the fix lands on `main` by PR, then reaches `releases-A.B.x` by
cherry-pick or merge from `main`;
(b) exception: a PR from the `qa/A.B.x-<YYYY-MM-DD>` branch directly onto
`releases-A.B.x`, allowed only when the change is incompatible with `main` or
fixes a regression that exists on `main`. The PR body names which of those two
conditions applies (§4.6).
No commit lands on the release branch during a QA session. A release branch is
force-pushed only on an explicit owner instruction, after the archive tag
`archive/releases-A.B.x-<YYYY-MM-DD>` is pushed first. A release is **never tagged
directly on `main`** — the tag lands on the `releases-A.B.x` branch, so
`main` keeps moving with ordinary merges while the release line is frozen
except for the fixes it specifically needs. This applies to every tag the
release produces, release candidates included (§3).

Cherry-picking is what the branch needs *once `main` has moved past the
release scope*. A branch cut while the release scope is still exactly "all of
`main`" is legitimately cut whole and kept in step by fast-forward. Selective
cherry-pick starts at the point the branch and `main` must diverge, not at
the cut.

## 3. Version tags and release candidates

A version tag `vA.B.C` names what production runs. A commit that reached
production gets the version tag unless the release was rolled back. A failed
postflight or watch does not withhold the tag: each failure is ticketed against
the next patch version ([D63](../decisions.md), owner, 2026-10-10). Before the
deploy, a commit is a release candidate, tagged `vA.B.C-rc.N`, `N` counting
from 0.

> **Revised 2026-09-11, effective from v0.5.0.** Through v0.4.0 the rc tag was
> cut FIRST — "at the tip you intend to ship" — and stage preflight/rehearsal
> ran against that already-tagged commit. As of v0.5.0 the order is reversed:
> stage preflight and rehearsal run against the untagged tip, and the rc tag
> is cut only once both pass. An rc tag therefore now means "this exact commit
> has already cleared stage," not "this is a candidate to be tested" — see
> the superseded-precedent note below. `backend/scripts/upgrades/0.4.0-to-0.5.0/steps.ts`'s
> `P6.rc-tag` requiring `P4.preflight-live` and `P5.rehearsal` is the
> mechanical form of this paragraph; `rollout-where.ts`'s `NEXT` is what
> actually enforces it, by manifest order.

The cycle, run entirely on the release's `releases-A.B.x` branch (§2):

1. Prepare the tip you intend to ship, on `releases-A.B.x`, untagged.
2. Run stage preflight and stage rehearsal against that commit. **Either
   fails** → fix, return to step 2 against the corrected commit. A stage
   failure consumes no rc number — nothing has been tagged yet to increment.
3. **Both pass** → cut `vA.B.C-rc.N` at that exact commit (`N` counting from
   0), and deploy that rc to production.
4. Run postflight and the watch.
5. **Not rolled back** → tag `vA.B.C` at the exact commit that is running in
   production, the deployed rc's commit, whether postflight and the watch
   passed or not. Open an issue for every failed check, against the next patch
   version `vA.B.(C+1)`. Its fixes start at `vA.B.(C+1)-rc.0`.
6. **Rolled back** → no `vA.B.C` tag. Production runs the previous version.
   Fix, return to step 2, and cut `vA.B.C-rc.(N+1)`.

Three consequences, stated outright because each one looks like a mistake and
none is:

- **`vA.B.C` and the final `vA.B.C-rc.N` point at the same commit.** That is
  expected and correct, not duplication to clean up. Step 5 has no other
  commit available to it — the version tag names what production is running.
- **`vA.B.C` can never be cut at a commit that was not actually deployed.** A
  fix that lands after the deploy belongs to the next patch version; it cannot
  be "rolled into the final tag."
- **Production never runs an untagged commit after a release.** Withholding
  the tag after a deploy would leave production on a commit no version names.
  Only a rollback withholds it, because then production runs the previous
  version again.
- **An rc number now only ever counts rollbacks, never stage failures or
  postflight failures.** Under the pre-v0.5.0 order a rejected stage rehearsal
  still consumed an rc number (the tag already existed); under this order it
  does not, because step 2 can repeat freely before anything is tagged. A
  release that needed five stage attempts and shipped clean on its first
  deploy is `rc.0`, not `rc.4`.

rc tags obey §2's branch rule exactly as the release tag does: they are cut on
`releases-A.B.x`, never on `main`.

### Precedent — v0.2.1 through v0.4.0 (superseded 2026-09-11)

This was a newly written-down convention, not a newly invented one, when v0.2.1
first ran it (tag-then-validate), undocumented (`git log -1 --format='%h %ci %s' <tag>`):

- `v0.2.1-rc.0` → `c2b9afc`, 2026-08-07
- `v0.2.1-rc.1` → `5970f2d`, 2026-08-08
- `v0.2.1` → `5970f2d`, 2026-08-08 — **the same commit as `rc.1`**

That shared-commit final tag is still the norm §3 describes, unchanged by the
2026-09-11 revision above — only the ORDER of "cut the rc" versus "run stage
preflight/rehearsal" reversed, not the final-tag mechanics. One honest limit
on the precedent, unaffected either way: v0.2.1 predates the `releases-A.B.x`
convention and is reachable from `main`
(`git merge-base --is-ancestor v0.2.1 origin/main` succeeds, as it does for
both rc tags). It is precedent for the **rc numbering**, not for the branch
placement rule — that rule starts with v0.2.2.

## 4. Foundational release workflow

Every per-release runbook must implement the following workflow, in order.
Each gate is blocking: the runbook must stop and escalate if a gate fails,
and no later gate may be started until the current one is satisfied or
explicitly waived by the operator with a written reason.

### 4.1. Code-readiness gate

Before any rollout activity, verify both of the following:

1. The release tracking issue is closed/complete — every Phase and feature
   issue linked from its Phases tasklist is closed, and the objective is
   clearly stated (§6).
2. Every commit expected to ship in this release is present on the release
   branch. Prefer merging to `main` first and cherry-picking to
   `releases-A.B.x`; verify with a diff or log inspection that no expected
   change is missing from the branch.

Do not begin preflight, rehearsal, or any other rollout step while either of
the above is incomplete.

### 4.2. Pre-upgrade baseline

Before the upgrade changes any production state, record the production
database state using a read-only user or cluster node. Capture especially the
properties that the upgrade will change or correct — schemas, reference data,
configuration values, row counts, checksums, or any other state the objective
identifies as changing.

Save this baseline artifact next to the pre-upgrade backup with a clear
filename and timestamp. It must be available for comparison during postflight
and for use during rollback if needed.

### 4.3. Backup and restore proof

Before rehearsal, create a fresh backup from the approved read-only source and
restore it to an isolated rehearsal target. The release runbook must name the
exact command and tool versions verified at the release commit. The proof must
record source identity, replica/read-only confirmation, backup checksum, server
and client versions, and successful restore. Never point rehearsal preparation
at the production database.

The adopted [smoke production spec](./smoke-production-spec.md) defines
`bun smoke:capture` as the read-only replica capture path. A future runbook may
use it only after confirming that the release code implements that interface.

**Fresh dump rule (owner, 2026-10-06).** Unless the operator names a specific dump, every
rehearsal starts from a dump captured from production for that run: `bun smoke:capture --out
<new directory>` on the capture host, then `--local dump=<that directory>`. Never restore
whatever dump or twin happens to be on the host. Reusing an existing copy (`--reuse`,
`--local volume`, or an earlier capture) is allowed only for a rapid turnaround between test
runs, and only while that copy's capture (`manifest.json` `capturedAt`) is at most 24 hours
old. Past 24 hours, capture again. The rehearsal report names the dump's stamp and capture time.

### 4.4. Isolated release rehearsal

Rehearse the release twice, on two kinds of target. **The cutover rehearsal** runs the
production step list unmodified (D61 rule 2) with `bun run release:run --target stage` against
the production-shaped stage target ([`stage-target.md`](../runbooks/stage-target.md)): a remote
Postgres restored from a fresh production dump, with the legacy release running against it the
way production runs it. **The twin rehearsal** uses the adopted
[local dump](./smoke-production-spec.md#5-local-postgres-stage-override) path for the checks
that need a seated roster and an accelerated schedule. The runbook must identify the exact
release commit, target identity, operator actions, migration and initialization
steps, and all checks exercised. It must cover:

- the W1 lifecycle, target-lock and interruption gates relevant to the release;
- W2 schema integrity, compatibility, migration recovery and privilege checks;
- W3 participant roster and submission behavior when the release affects
  participants;
- product verification and evidence of any approved exceptions.

On a twin the rehearsal deploys the system against the restored copy (never the remote
database), seats every active member on a spoofed key as its own participant container, and,
once the checks that need production's schedule are recorded, runs the sessions on an
accelerated schedule: short epochs set through the admin API (`bun run twin:accelerate`,
standing check SR.9), so the lifecycle checks see sessions publish and the judge judge within
minutes.

A restored rehearsal target is disposable by explicit operator action; the
smoke boot itself exits after readiness and leaves services running. Capture
service evidence for the rehearsal window where available, and report missing
coverage plainly. A green check run under broader database privileges than
production does not prove the release's production grant path.

Legacy `--db smoke-twin`, host-driven agents, and teardown-on-exit behavior are
historical implementation details. Do not copy them into a new release runbook.
No adopted-design command may be used before its implementation exists at the
release commit. The future per-release runbook must use the tool interfaces
actually implemented at its exact SHA.

### 4.5. Stage rehearsal report

The report must include the release commit, source backup and restore evidence,
resolved plan and plan id, deployment identity, migration/initialization
receipts, preflight and readiness results, participant roster and results,
product verification, service evidence, any issues and their resolution, and a
go/no-go decision with operator sign-off.

The gate passes only when required checks pass and the operator has signed off.
Missing, unimplemented, or unverified checks are blocking unless the operator
records a specific written exception under §1. Reference generated artifacts
instead of restating their values.
### 4.6. Fix loop

If the isolated rehearsal or stage report finds an issue that affects
production safety or acceptance criteria, do not proceed to production
execution. Fix it as follows, then follow §3's tag sequence.

A fix is developed in a development environment and never on a rehearsal,
stage or production host. A host runs a clean checkout of a pushed commit
(`git status --porcelain` empty, no host-side commits). A rehearsal on a host
whose code differs from the branch under test is not evidence for the release.

**QA branch rule (owner, 2026-10-06).** A QA session never commits to the
release branch or to `main`. Both stay clean for the whole session.

1. At the start of the session, cut one QA branch from the release branch tip:
   `qa/A.B.x-<YYYY-MM-DD>` (example: `qa/0.6.x-2026-10-06`). Push it. Every
   patch of the session lands there, and nowhere else.

   **A pushed QA branch is never rewritten (owner, 2026-10-07).** No force
   push, no reset, no rebase. If the session needs a different base (the
   release branch tip moved, or the branch was cut from the wrong commit), cut
   a NEW QA branch from the new base and push it. A second branch on the same
   day takes a suffix: `qa/A.B.x-<YYYY-MM-DD>-2`, then `-3`. Leave the old
   branch as it is, and name in the session report which branch each piece of
   evidence ran on. Switch the stage host to the new branch (step 2). Seen
   2026-10-07: `releases-0.6.x` was reset to `main` after
   `qa/0.6.x-2026-10-07` was cut, and the QA branch was force-pushed to match
   instead of a new branch being cut.
2. Switch the development checkout and the stage host to the QA branch. The
   stage host runs a clean checkout of the QA branch tip, never a fix branch.
3. Develop and test each fix in a local worktree branched from the QA branch.
   Open the PR into the QA branch and merge it there. Runbook and doc
   corrections found during the session land there too. A change to a
   supported baseline needs the owner's decision first (D55 (8)).
4. Redeploy a clean checkout of the new QA branch tip to the stage host and
   repeat the affected stage steps. A stage failure does not consume an rc
   number.
5. When the session ends, the owner decides which QA commits reach the release
   branch and which reach `main`. Only then does a PR carry them. The default
   route is a PR to `main`, then a cherry-pick or merge to the release branch.
   A PR from the QA branch directly onto the release branch is allowed only when
   the change is incompatible with `main` or fixes a regression on `main`, and
   its body names which condition applies (D62). The rc tag is
   cut on the release branch after that merge, and stage is re-run on that tip
   if its tree differs from the tree that passed on the QA branch.
6. Resume the sequence in §3 at the applicable step.

Runbook corrections that change release instructions must be committed and
reviewed on the QA branch during a session, and reach the release branch by the
route in step 5 on the owner's merge decision. Re-run any gate whose evidence or operator
action the correction affects. Rc numbering follows §3: stage-only retries and
documentation fixes do not consume an rc; a corrected candidate consumes the
next rc only after a deployed candidate fails postflight.

### 4.7. Production execution

Once the stage rehearsal gate passes, run the actual cutover and postflight
on a production machine. Follow the per-release runbook step by step. Every
destructive or irreversible step must be explicitly marked in the runbook. The operator
authorizes the run once, with a recorded go that names the release, the commit and the target
(D61). The runner refuses to start without it, and stops at the first failed step.

**The cutover is a sequence of receipted steps with credentials limited to the
step's job.** The adopted [smoke production spec](./smoke-production-spec.md)
separates production migration and initialization from boot, then requires
preflight, readiness and durable evidence. Production migration reads
`rm_owner` from the host's `~/.env` (D61); boot receives runtime credentials only. The old separate migration
role, `migrate:external`, ownership-based auto-migration and `smoke:archive` plans are
deprecated and must not guide new implementation. A legacy release procedure must
state its exact code identity and limitations; it is not a second target design.

Preflight must be re-run or re-confirmed on production before the cutover
begins, even if the isolated rehearsal passed, to ensure the production
environment matches the rehearsal assumptions.

The upgrade is agent-executed through the verified runbook, with one operator go and
receipt review (D61). The privileged credentials (`rm_owner`, `doadmin`) are lines in the
host's `~/.env`. A write names its target with `--confirm-target`, and the command refuses a
target that differs from the one it resolved. No container receives a privileged credential,
and no receipt, journal or log line prints one. Production runs only after a stage run of the
same step list at the same commit passed (standing check SP.8).

### 4.7.1. Product verification (separate from postflight, and from the deploy)

**Postflight and verification answer different questions, so they are different
steps.** Postflight asks *did the migration land* — migrations recorded, tables
present, flags at their shipped defaults. Verification asks *is the product
doing what it claims* — the pipeline produced decisions, and the artifacts it
published are internally consistent.

This distinction is written down because losing it has a specific failure
shape: a release certified green on schema alone, with every product invariant
unexamined. That is what v0.5.0's postflight was until 2026-09-18 — eight
checks, four of which restated what the migration runner already reported.

**Verification runs as a SEPARATE PROCESS against an already-live stack**, not
inside the deploy. Under the adopted design, `bun smoke` boots and checks
readiness; production migration is separate. Product verification is still its
own job and must not be silently omitted by either a standing boot or a cutover.
`scripts/verify-live.ts` attaches over HTTP after liveness and reports in the
standard check format, emitting the same receipt JSON the rollout probe reads.

**Tiering is a safety rule, not a convenience.** A `readonly` leg issues GETs;
a `full` leg drives the product — publishes sessions, spends inference, sends
mail. Only `readonly` may run against production: a `full` leg there would
manufacture the very history the readonly legs exist to audit. The default is
`readonly` so the destructive direction has to be asked for explicitly.

**Reading the result.** A WARN is not a pass — an invariant with nothing to
check is unverified, not satisfied, and a release runbook must say which
invariants a given target cannot yet exercise. And "the product is wrong"
(exit 1) must stay distinguishable from "nothing was asserted" (exit 2);
collapsing them lets an unreachable stack read as a product failure.

### 4.7.2. Log gates

`verify:live` reads the product over HTTP and cannot see a log. The log gates
do: `bun run twin:gate` grades a twin rehearsal and `bun run prod:gate` grades
production, before (`--mode baseline`) and after (`--mode post-release`) the
cutover. Each selects its stack by `--instance` and that instance's stack
record, reads every container's log (participants included), and reads the
database read-only through the api container. Neither needs an admin token.

The rule is default deny. Every distinct error in every log must match a
classification in `scripts/lib/gate/log-classifications.json` with a written
reason, or the gate fails. A new failure mode is added to that file only with
evidence and a reason, never to make a run pass. A model timeout or a rejected
take is a model outcome and is reported. A session that publishes
`no_consensus` is an acceptable outcome (owner, 2026-10-06): the gates list it as
a warning and never count it as a good session. The scheduler also publishes
`no_consensus` when the judge is disconnected at the deadline
([smoke production spec](./smoke-production-spec.md) §10), so a dead judge is
caught by the other checks, not by that outcome: every subject still needs its
minimum of good sessions (judged, with an applied judgement and a receipt), a
session published as `not_judged`, or `judged` without a judgement or a
receipt, fails, and the judge participant must be running and never restarted.

### 4.8. Recovery and rollback

The release runbook must define recovery for each destructive or partially
committed phase. It must distinguish resuming a journaled operation, restoring
database state from a verified backup, and recovering service availability.
Do not assume the previous services remain available after replacement begins,
or that the deployment tool automatically rolls back.

Rehearse the named recovery path on the isolated target. Production recovery
requires the operator's recorded decision and sign-off, including any deviation
from the rehearsed path. Report the final database and service state, evidence
used, and remaining risk.
### 4.9. Production rollout report

After a successful cutover (or after rollback), produce a final production
rollout report covering at least:

- the release candidate deployed,
- cutover and postflight results (or rollback results),
- any issues encountered and their resolution,
- the final version tag applied (every deploy that was not rolled back),
- the issues opened against the next patch version for failed checks,
- backport TODOs (§7),
- operator sign-off.

The report is the closing artifact of the release. The release tracking issue
is closed only after this report is filed and the final tag exists on the
release branch.

## 5. Per-release runbook format

Each release has an operator runbook committed under `docs/runbooks/`. The
runbook must:

- open with an **Inherits the standing runbook** section that names the commit of
  [`release-standing-runbook.md`](../runbooks/release-standing-runbook.md) it was
  written against and lists every **Exception** with reason, approving owner and
  restoring issue (§1). Standing checks are cited by ID, never restated,
- add only **release-specific** checks of its own, each placed after the standing
  check of the same phase,
- state the release identity and the delta it introduces,
- list go/no-go gates that map directly to §4,
- provide a preflight script or checklist,
- provide step-by-step cutover commands, with destructive or irreversible
  steps explicitly marked,
- provide post-cutover verification steps,
- be executed by `bun run release:run` from the control machine (D61). The runbook describes
  the runner's steps; it lists no command for a person to paste on a host. Every step names
  its script, its standing check IDs, and whether it is irreversible. Every claim is
  verified against a specific commit SHA rather than described from memory,
- run every database operation through a committed script with a receipt. A hand-written
  `psql` line is a missing script,
- **use the adopted spec's database interface for new tooling**, rather than
  reconstructing a rehearsal with ad hoc lower-level commands. Remote connection
  is the default; `--local blank|dump|volume` selects local state. A twin is a use
  case, not a `--db` mode. Legacy release commands remain tied to their exact code
  version and must not be copied forward as design requirements,
- **sequence tools; never let one tool stand in for another.** A runbook names
  which tool performs each step and which role it holds
  ([smoke production spec](./smoke-production-spec.md)). A step the runbook cannot name a tool for —
  "watch the logs", "confirm it migrated" — is a tool that is missing, and the
  runbook says so rather than asking an operator to do it by eye.

By convention the runbook lives on the release's `releases-A.B.x` branch,
alongside the code it describes cutting over to, so a runbook change and the
release content it documents move together.

Filenames under `docs/runbooks/` are kebab-case
(`scripts/lint-docs.sh` enforces this repo-wide for `docs/*.md` and
`docs/runbooks/*.md`).

## 6. Per-release GitHub tracking issue

Each release has one GitHub tracking issue carrying the label
`release:vX.Y.Z`. The tracking issue states the release's **objective**: the
end state the upgrade is meant to reach — which features should be live, what
state the database should be in — not just a list of merged PRs.

The issue carries two GitHub-checkbox checklists:

- a **preflight checklist**, mirroring the runbook's go/no-go gates and
  dry-run steps,
- a **postflight checklist**, mirroring the runbook's post-cutover
  verification steps.

Checking a box on the tracking issue is a claim that the corresponding gate
in the runbook was actually executed and passed — the issue is a state
summary derived from real runbook execution, never ticked off independent of
it.

The Phases tasklist is not just status tracking: it is the hard precondition
checked before preflight is allowed to start — see §4.1.

## 7. Backporting

**Not a go/no-go gate.** §4's workflow never checks backport debt, and an
outstanding backport is never a reason to hold up, fail, or re-run any step
of the rollout. Backporting is engineering hygiene owed once `vA.B.C` is
tagged and `releases-A.B.x` stops being the active release line — it is a
concern for whoever picks up work on `main` next, not for the agent executing
the rollout.

Any fix discovered on the `releases-A.B.x` branch during rollout is carried
back to `main` outside this runbook's flow, by whoever picks up work on
`main` next. It is never assumed for `main`: `main` may have moved past that
release's lifecycle. Only after stage has proven the fix, a separate PR
evaluates the cherry-pick onto `main`.

---

## 8. Compatibility contract

Database schema identity, manifest integrity, migration metadata and code/schema
compatibility are defined by [smoke production spec §§8–9](./smoke-production-spec.md#8-schema).
This policy preserves release gates and the evidence needed to judge a change; it
does not define a second migration runner or deployment order.

### 8.1 Database compatibility

Every migration declares compatibility metadata that the deployed code
understands. “Additive” means older supported code preserves its query behavior,
data meaning, bootstrap assumptions and required grants. Adding a column alone
does not establish compatibility. The adopted spec's manifest and migration
ledger are the source for schema identity and compatibility checks.

A breaking migration needs an explicit release plan that identifies affected
code, data and privileges, the order of changes, verification, and a rehearsed
recovery path. Do not assume the database may safely run ahead of every code
version. Do not use ordering discipline as a replacement for runtime integrity
or compatibility checks. Migrations run transactionally as specified in §8.3;
the old `-- no-transaction` proposal is retired.

The release runbook must cite the CI evidence required by the adopted spec:
snapshot/migration equivalence, supported populated upgrades, and compatibility
of older supported code with additive changes. It must not claim those checks
passed unless the corresponding implementation and evidence exist at the release
commit.

### 8.2 API and consumer compatibility

Keep API response changes additive where possible. A consumer must not send a
new request field until the accepting API is deployed. If a breaking route or
field change is necessary, the release plan must identify affected clients and
workers, the replacement contract, and how old consumers are handled. These are
release compatibility principles; they do not authorize the Kubernetes/Pages
topology or deployment sequencer described in retired proposals.

### 8.3 Authority

[Smoke production spec](./smoke-production-spec.md) owns deployment, migration,
target identity and schema-preflight mechanics. This document owns release gates,
phases, reports, approval and compatibility evidence. The exact implementation
and its status are determined by the code at the release commit.

## 9. Tracking upcoming releases

The GitHub Plan issue is the canonical execution queue; this document does not
create a parallel `next` deployment plan. Adoption of the smoke production
specification does not schedule implementation or establish that its interfaces
exist.

Create a release-specific runbook when a release is scheduled and its tools are
implemented. It must name the exact code commit and commands it verifies, follow
this policy's gates, and agree with the adopted specification. Do not copy
commands, migration procedures, or runbook templates from retired release
runbooks. If a required tool or gate is not implemented, record that gap and
keep the production cutover blocked.
