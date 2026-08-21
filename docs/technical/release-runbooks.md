# Release process — foundational runbook policy

> **Status: in effect.** This document defines the foundational release-runbook
> policy that every per-release runbook must follow. It is not itself a
> runnable checklist; concrete rollouts are executed from per-release runbooks
> committed under `docs/runbooks/` (see §5). An example is
> [`docs/runbooks/v0-2-2-rollout.md`](../runbooks/v0-2-2-rollout.md), written
> against the `releases-0.2.x` branch.

This is not the process for landing ordinary feature work — that is PR review
against `main`, covered by [CONTRIBUTING.md](../../CONTRIBUTING.md) and the CI
taxonomy. This document is specifically about the step where a set of
already-merged `main` history is packaged, gated, and cut over into
production.

## 1. Scope and authority

Every production rollout of a numbered release must be planned, rehearsed, and
executed from a per-release runbook that conforms to this policy. The
per-release runbook is the **definitive, agent-executable procedure** for that
release — not the tracking issue (§6), and not tribal knowledge held by
whoever last did a rollout. The tracking issue's checklists exist to gate
progress through the runbook, not to duplicate or replace its content.

No release may skip a gate described here unless the release tracking issue
explicitly records the exception, the reason for it, and operator sign-off.

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
paragraph says. Once a release's scope is decided, the branch receives only
(a) the specific commits cherry-picked from `main` that the release needs,
and (b) small incidental nit-fix commits made directly on the branch while
getting it out the door (see §7, Backporting). A release is **never tagged
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

A version tag `vA.B.C` is **never** cut before **both** a completed preflight
and a completed postflight. The version tag records what has been *proven in
production*, not what is *intended for release*. Everything before that point
is a release candidate, tagged `vA.B.C-rc.N`, `N` counting from 0.

The cycle, run entirely on the release's `releases-A.B.x` branch (§2):

1. Cut `vA.B.C-rc.N` at the tip you intend to ship.
2. Run preflight against that rc. **Preflight fails** → fix, cut
   `vA.B.C-rc.(N+1)`, return to step 2.
3. **Preflight passes** → deploy that rc to production.
4. Run postflight. **Postflight fails** → patch, cut `vA.B.C-rc.(N+1)`, and go
   back through preflight (step 2) before deploying again. Every patch needed
   to reach a correct system consumes another rc number.
5. **Postflight clean** → tag `vA.B.C` at the exact commit that is running and
   verified in production — i.e. the final rc's commit.

Two consequences, stated outright because each one looks like a mistake and
neither is:

- **`vA.B.C` and the final `vA.B.C-rc.N` point at the same commit.** That is
  expected and correct, not duplication to clean up. Step 5 has no other
  commit available to it — the version tag names what production is running.
- **`vA.B.C` can never be cut at a commit that was not actually deployed and
  verified.** A fix that lands after the last deployed rc requires a new rc
  and another pass through steps 2–4; it cannot be "rolled into the final
  tag."

rc tags obey §2's branch rule exactly as the release tag does: they are cut on
`releases-A.B.x`, never on `main`.

### Precedent — v0.2.1

This is a newly written-down convention, not a newly invented one. v0.2.1
already ran it, undocumented (`git log -1 --format='%h %ci %s' <tag>`):

- `v0.2.1-rc.0` → `c2b9afc`, 2026-08-07
- `v0.2.1-rc.1` → `5970f2d`, 2026-08-08
- `v0.2.1` → `5970f2d`, 2026-08-08 — **the same commit as `rc.1`**

That shared-commit final tag is the norm this section describes, not an
anomaly in the tag history. One honest limit on the precedent: v0.2.1 predates
the `releases-A.B.x` convention and is reachable from `main`
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

### 4.3. Backup/restore smoke test

On a staging host inside the production database's private network, test
backup and restore of the production read-only database. The test must prove
that the backup tooling produces a restorable artifact and that the restore
procedure completes without error. Do not proceed to the digital-twin
rehearsal until this smoke test passes.

The repo ships both halves, and a runbook names them rather than restating
them:

```bash
bun run twin:capture     # rm_readonly -> replica; pg_dump + pg_dumpall, gpg-encrypted
```

`twin:capture` refuses to run against the primary (`pg_is_in_recovery()` must be
true), refuses the application's writer credential, refuses a `pg_dump` older
than the server, and refuses to write inside the checkout. It emits a
`manifest.json` recording what it captured and from where — §4.5 cites that file
instead of transcribing its contents.

### 4.4. Digital-twin rehearsal

Set up a digital twin by restoring the backup from §4.3 to a local Postgres
container (**not** a remote database) on a staging machine. Run the full upgrade
on the twin, including:

- preflight checks,
- the cutover step that applies the upgrade,
- postflight verification.

The twin must use the same release candidate that is planned for production.
Any failure, warning, or unexpected state change discovered on the twin is a
blocking issue.

The twin is a named data path, not an assembly:

```bash
bun smoke -- --db twin      # restore the backup, boot the real stack against it
bun run twin:rehearse       # the same boot, unattended, plus the frontend checks
```

"not a remote database" is now enforced rather than trusted: `--db twin`
restores into a local container and points the stack at it, and the mode enum
makes "twin" and "external" separate, non-substitutable choices.

**`twin:rehearse` covers restore + boot + serve, not the whole gate.** The
preflight and postflight steps above are version-specific and stay explicit
commands in the per-release runbook — the driver deliberately does not run them,
because what changes per release is exactly the part it would have to guess at.

### 4.5. Stage rehearsal report

After the digital-twin rehearsal, produce a written stage rehearsal report
that includes at least:

- twin setup summary (source backup, container details, RC used),
- preflight results,
- cutover steps executed and their results,
- postflight results,
- acceptance-criteria pass/fail status against the release objective,
- any issues found and how they were resolved,
- a go/no-go decision with operator sign-off.

The stage rehearsal gate passes only when this report exists, all acceptance
criteria pass, and the operator has signed off.

The twin setup summary should CITE the artifacts rather than restate them:
`manifest.json` in the backup directory records the source, role, replica proof
and server/client versions, and the boot banner records the container, the volume
and the backup stamp.

### 4.6. Fix loop

If the digital-twin rehearsal or stage report finds any issue that affects
production safety or acceptance criteria, do not proceed to production
execution. Instead:

1. Open PRs with fixes against `main`.
2. Merge the fixes to `main`.
3. Cherry-pick the merged fixes to the release branch (`releases-A.B.x`).
4. Cut a new release candidate (`vA.B.C-rc.(N+1)`) at the updated branch tip.
5. Restart the runbook from §4.1.

Runbook corrections that do not change deployed code (e.g., wording, command
corrections) may be committed directly to the release branch, but they still
cost a new rc and a fresh pass through §4.

### 4.7. Production execution

Once the stage rehearsal gate passes, run the actual cutover and postflight
on a production machine. Follow the per-release runbook step by step. Every
destructive or irreversible step must be explicitly marked in the runbook and
authorized by the operator before execution.

Preflight must be re-run or re-confirmed on production before the cutover
begins, even if the twin rehearsal passed, to ensure the production
environment matches the twin assumptions.

The entire upgrade — preflight, cutover, and postflight — is **agent-executed
end to end**. No human runs commands against the production server directly;
a human's role is authorizing the release and reading the tracking issue's
checklists, not typing commands into a production shell.

### 4.8. Rollback

A postflight failure on production defaults to a full rollback by restoring
the pre-upgrade dump from §4.2. The operator may override the default
rollback only by recording the override reason, the alternate remediation
plan, and a second sign-off in the production rollout report (§4.9).

The rollback procedure must be written into the per-release runbook and
rehearsed on the digital twin at least once before production execution.

### 4.9. Production rollout report

After a successful cutover (or after rollback), produce a final production
rollout report covering at least:

- the release candidate deployed,
- cutover and postflight results (or rollback results),
- any issues encountered and their resolution,
- the final version tag applied,
- backport TODOs (§7),
- operator sign-off.

The report is the closing artifact of the release. The release tracking issue
is closed only after this report is filed and the final tag exists on the
release branch.

## 5. Per-release runbook format

Each release has an operator runbook committed under `docs/runbooks/`. The
runbook must:

- state the release identity and the delta it introduces,
- list go/no-go gates that map directly to §4,
- provide a preflight script or checklist,
- provide step-by-step cutover commands, with destructive or irreversible
  steps explicitly marked,
- provide post-cutover verification steps,
- be written so it can be executed top to bottom, every command
  copy-pasteable, every claim verified against a specific commit SHA rather
  than described from memory,
- **name data paths by `--db <mode>`; never describe how to construct one.**
  There are three — `ephemeral` (the demo's own container), `external` (a managed
  server from `.env`), `twin` (a local restored copy of production) — and the
  tooling that builds each is shared and version-agnostic. A runbook that
  re-derives a twin out of lower-level flags is how the last one ended up
  pinned to a single release.

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

Fixes discovered directly on the `releases-A.B.x` branch during rollout —
during preflight dry-runs or the cutover itself — get merged back to `main`.
This is not a new rule invented for releases: it is the same standing
project convention that any code improvement lands on `main` and only what a
release specifically needs is carried onto its release branch (see §2) —
applied in the direction that matters once a fix is made *on* the branch
instead of on `main` first. A fix discovered on `releases-A.B.x` is exactly
the kind of "nit" §2 already expects the branch to accumulate; backporting it
is what keeps that branch's fixes from being silently lost the moment the
branch is done being the active release line.

The outstanding backport debt is a command, never a sentence in a document:

```bash
git log --oneline origin/main..origin/releases-A.B.x
```

Empty means the branch is a strict subset of `main` and nothing is owed.
Every commit listed is a fix that exists only on the release branch and must
be carried back to `main`.
