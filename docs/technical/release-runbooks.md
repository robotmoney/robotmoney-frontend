# Release process — branches, runbooks, and tracking issues

> **Status: standing convention, partially followed today.** This describes
> how a release is *meant* to ship — a release branch, a runbook committed to
> it, and a GitHub tracking issue with preflight/postflight checklists. The
> v0.2.2 rollout, the one release currently in flight, deviates from part of
> it: its tracking issue (#660) states explicitly that rollout work is on
> `release/v0.2.2-rollout`, not a `releases-0.2.x` branch, and flags that as a
> known deviation rather than a change to the convention. No `releases-A.B.x`
> branch exists in this repo as of this writing. Treat the branch-naming rule
> below as the target, not a claim that it is in effect right now.

This is not the process for landing ordinary feature work — that is PR review
against `main`, covered by [CONTRIBUTING.md](../../CONTRIBUTING.md) and the CI
taxonomy. This document is specifically about the step where a set of
already-merged `main` history is packaged, gated, and cut over into
production.

## 1. Release branch

Each release ships from a branch named `releases-A.B.x`:

- literal, plural **`releases`** (not `release`),
- `A.B` are the integer major and minor version being released,
- a literal trailing **`x`** where the patch number would go — the patch
  number is deliberately left blank, because the branch holds the whole
  `A.B` line, patches included.

Example: `releases-0.2.x` for the 0.2 line (currently the branch cutting v0.2.2).

Feature PRs never target `releases-A.B.x` directly — ordinary feature work is
reviewed and merged via PR against `main`, exactly as this document's intro
paragraph says. Once a release's scope is decided, the branch receives only
(a) the specific commits cherry-picked from `main` that the release needs,
and (b) small incidental nit-fix commits made directly on the branch while
getting it out the door (see §5, Backporting). A release is **never tagged
directly on `main`** — the tag lands on the `releases-A.B.x` branch, so
`main` keeps moving with ordinary merges while the release line is frozen
except for the fixes it specifically needs.

## 2. Per-release runbook

Each release has an operator runbook committed under `docs/runbooks/`. The
current example is
[`docs/runbooks/v0-2-2-rollout.md`](../runbooks/v0-2-2-rollout.md) — roughly
1,600 lines, structured as: release identity and delta (§1), go/no-go gates,
a preflight script, step-by-step cutover commands (destructive/irreversible
steps explicitly marked), and post-cutover verification. It is written, in
its own words, "to be executed top to bottom at 3am" — every command
copy-pasteable, every claim verified against a specific commit SHA rather
than described from memory.

The runbook is the **definitive, agent-executable procedure** for that
release — not the tracking issue (§3), and not tribal knowledge held by
whoever last did a rollout. The tracking issue's checklists exist to gate
progress through the runbook, not to duplicate or replace its content. By
convention the runbook lives on the release's `releases-A.B.x` branch,
alongside the code it describes cutting over to, so a runbook change and the
release content it documents move together.

Filenames under `docs/runbooks/` are kebab-case
(`scripts/lint-docs.sh` enforces this repo-wide for `docs/*.md` and
`docs/runbooks/*.md`) — note the existing runbook is named `v0-2-2-rollout.md`,
not `v0.2.2-rollout.md`, precisely because a `.` in the filename stem fails
that check.

## 3. Per-release GitHub tracking issue

Each release has one GitHub tracking issue carrying the label
`release:vX.Y.Z` — for example #660 (`release:v0.2.2`) and #661
(`release:v0.3.0`), the two currently open. The tracking issue states the
release's **objective**: the end state the upgrade is meant to reach —
which features should be live, what state the database should be in — not
just a list of merged PRs.

The issue carries two GitHub-checkbox checklists:

- a **preflight checklist**, mirroring the runbook's go/no-go gates and
  dry-run steps,
- a **postflight checklist**, mirroring the runbook's post-cutover
  verification steps.

Checking a box on the tracking issue is a claim that the corresponding gate
in the runbook was actually executed and passed — the issue is a state
summary derived from real runbook execution, never ticked off independent of
it.

(#660 and #661 both carry the release-tracking-issue *shape* inherited from
the Release → Phase → Feature hierarchy that superseded the old monolithic
Plan issue #15. #660 (`release:v0.2.2`) is now a live example of the full
convention described here: it carries Objective, Preflight checklist,
Postflight checklist, and Tracking authority note sections in addition to
its Phases list. #661 (`release:v0.3.0`) has not started and, as of this
writing, is still Phase-only — Objective and the two checklists get added
once its rollout begins.)

## 4. Process flow

In order:

1. **Preflight.** An agent dry-runs the runbook against production,
   read-only wherever the runbook allows it. Any bug the dry-run turns up —
   a wrong command, a stale assumption, a missing step — gets fixed with a
   commit directly to the `releases-A.B.x` branch (updating the runbook, or
   the code it exercises), not deferred to a follow-up. As each preflight
   gate passes for real, its box gets checked on the tracking issue.
2. **Cutover.** Only once every preflight box on the tracking issue is
   checked does an agent execute the actual production cutover, following
   the runbook step by step. This is the only step of the three that
   touches production write paths.
3. **Postflight.** An agent confirms three things against the live system:
   every feature the release's objective (§3) called for is actually
   present, no damage was done to the database, and the database is in the
   state the objective describes. Each postflight box on the tracking issue
   gets checked as its corresponding verification passes.

The entire upgrade — preflight, cutover, and postflight — is **agent-executed
end to end**. No human runs commands against the production server directly;
a human's role is authorizing the release and reading the tracking issue's
checklists, not typing commands into a production shell.

## 5. Backporting

Fixes discovered directly on the `releases-A.B.x` branch during rollout —
during preflight dry-runs or the cutover itself — get merged back to `main`.
This is not a new rule invented for releases: it is the same standing
project convention that any code improvement lands on `main` and only what a
release specifically needs is carried onto its release branch (see §1) —
applied in the direction that matters once a fix is made *on* the branch
instead of on `main` first. A fix discovered on `releases-A.B.x` is exactly
the kind of "nit" §1 already expects the branch to accumulate; backporting it
is what keeps that branch's fixes from being silently lost the moment the
branch is done being the active release line.
