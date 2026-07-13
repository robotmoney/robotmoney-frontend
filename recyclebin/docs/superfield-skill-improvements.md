# Superfield loop — skill/script improvement proposals

Source: one real `superfield-auto` session's manual-intervention log (8 items).
Goal: encode each intervention into the tooling so the loop needs fewer human
touches. Tooling install analysed at `AGENTS=/home/lucas/.agents` (not a git
repo — a plain install tree). No commits made.

## Prioritized summary

| # | Friction | Affected files | Fix type | Impact × Confidence | Priority |
|---|----------|----------------|----------|---------------------|----------|
| 1 | Primary self-merge races the coordinator merge-train | `worker-prompts/develop-issue.md`, `skills/superfield-auto/SKILL.md`, `skills/_shared/merge-gate.md` | Prompt: single owner of `main` | High × High | **P0** |
| 2 | CI-watcher fires on stale checks after force-push | `scripts/auto/pr-status.sh`, `merge-ready.sh` + new `await-ci.sh` | Script: durable head-pinned CI wait | High × High | **P0** |
| 7 | Infra-flake mis-read as red; manual rerun | new `scripts/auto/classify-checks.sh`, `superfield-auto.md` Phase 1 | Script: shared flake classifier + auto-rerun | High × Med-High | **P1** |
| 3 | Intra-phase merge order not encoded (59 before 58) | `scripts/auto/merge-ready.sh` | Script: gate on issue-level `dependencies[]` | Med-High × High | **P1** |
| 4 | `merge-pr.sh` leaves branch+worktree when branch checked out | `scripts/auto/merge-pr.sh` | Script: worktree-aware cleanup | Med × High | **P1** |
| 6 | No poll for issues filed after loop start | `skills/superfield-auto.md` Phase 6 / stop condition | Prompt: new-issue reconciliation before stop | Med-High × Med | **P2** |
| 8 | `task-compliance` `verdict` field returned prose | `worker-prompts/task-compliance.md`, optional CLI derive | Prompt + optional guard | Med × High | **P2** |
| 5 | Phase-6 backlog GENERATION fired mid-train | `skills/superfield-auto.md` Phase 1 / Phase 6 | Prompt: gate generation on train-idle | Med × Med | **P2** |

Cross-cutting themes (detailed at the end): **(A) single owner of `main`
advancement**, **(B) a reusable durable "wait for CI on this exact head"
primitive**, **(C) a shared check classifier** that both distinguishes stale
checks and infra-flakes.

---

## 1. Primary self-merge thrashes the coordinator merge-train  (P0)

**Affected files**
- `worker-prompts/develop-issue.md` lines 10–49 (primary role, step 3
  "Compliance gate, then merge" — calls `merge-pr.sh` itself).
- `skills/superfield-auto/SKILL.md` lines 62–118 (Phase 1 serial merge train,
  esp. lines 103–109 "Serial merge train").

**Diagnosis**
Two independent actors advance `main`. `develop-issue.md`'s **primary** role
runs its own compliance gate and calls `merge-pr.sh` (lines 22–44), while
`superfield-auto.md` Phase 1 runs a coordinator-driven serial train over all
ready PRs (lines 103–109). Under strict branch protection with no merge queue,
whichever actor merges first pushes every other rebased-and-green PR
`branch-behind-base`, forcing the coordinator to re-rebase → re-CI →
re-compliance. This session paid that cost twice (PRs 73 and 72). Nothing
declares a single owner of `main` advancement. The primary worker's self-merge
buys nothing the coordinator train doesn't already do — the coordinator *must*
run its own train anyway for speculative PRs — so the primary's merge authority
is pure downside during an active train.

**Proposed change (recommended: strip merge authority from the worker; the
coordinator is the sole merger).**
The speculative role already exits at "PR marked ready" and lets the outer loop
merge. Make **primary** do the same: drive to green + compliance-ready, then
hand the actual `merge-pr.sh` call to the coordinator's Phase 1. This makes the
coordinator the single owner of `main`.

Patch `worker-prompts/develop-issue.md`, primary role step 3 (lines 20–44):

```diff
-3. **Compliance gate, then merge** — the moment `merge-ready.sh` returns
-   `ready: true`, do NOT call `merge-pr.sh` directly. A primary worker must
-   never self-merge without an independent compliance pass. Follow
-   `"$AGENTS"/skills/_shared/merge-gate.md`:
-   - Run `bun "$AGENTS/agent-core/src/cli.ts" auto compliance-check {pr_number}`.
-     ...
-   - Merge: `merge-pr.sh {pr_number}` (it independently re-verifies a fresh
-     compliance marker before merging, as a safety net).
+3. **Drive to merge-ready, then hand off — never merge yourself.** The moment
+   `merge-ready.sh` returns `ready: true`, the primary worker's job is done:
+   the coordinator is the SINGLE owner of `main` advancement and runs one
+   serial merge train (Phase 1). A worker that self-merges while that train is
+   rebasing another PR pushes it `branch-behind-base` and forces a wasted
+   re-rebase/re-CI/re-compliance cycle. So:
+   - Ensure the PR is undrafted (`mark-pr-ready.sh {pr_number}`) and green.
+   - Do NOT call `merge-pr.sh`, and do NOT dispatch the compliance worker
+     yourself — the coordinator dispatches compliance and merges in Phase 1,
+     per `_shared/merge-gate.md`.
+   - Report "ready for merge-gate" and exit, exactly like the speculative role.
```

Then simplify the primary/speculative distinction: both now "drive to
merge-ready and exit"; the only difference left is that primary owns CI-fixing
until green whereas speculative exits at "ready" without waiting for CI. Update
the role summary (lines 10–14 and 51–56) accordingly, and the Workflow step 7
(lines 169–172) to "hand off to the coordinator's merge-gate; do not merge."

**Alternative (if you want to keep worker self-merge for the no-speculative,
no-train case):** add a coordination lock. Before `merge-pr.sh`, any actor must
acquire a `main`-advance lock (a file in `.agents/cache/` or a `gh` label on the
Plan). The train and the primary contend for the same lock, so only one advances
`main` at a time; losers re-rebase once. This is more machinery and still
incurs one rebase; **recommended is the strip-authority option** — it is
simpler and removes the race entirely.

**Recommendation:** Adopt strip-authority. It makes the merge-gate contract
single-writer, matches how speculative already behaves, and deletes ~25 lines of
duplicated compliance-gate prose from the worker prompt (the coordinator already
owns that path via `_shared/merge-gate.md`).

---

## 2. CI-watcher stale-check race after force-push  (P0)

**Affected files**
- `scripts/auto/pr-status.sh` lines 12–17, 47–54 (fetches `gh pr checks` with
  **no** head SHA and **no** per-check timestamps).
- `scripts/auto/merge-ready.sh` lines 24–27 (`checks-not-green` reads
  `checks.all_green`, which is computed from whatever `gh pr checks` returned —
  possibly the previous run's rollup).
- No `await-ci` / `wait`/`watch`/`poll` script exists in `scripts/auto/`
  (confirmed by directory listing).

**Diagnosis**
After a rebase force-push, GitHub briefly still reports the **previous** run's
`SUCCESS` checks before the new run registers. `pr-status.sh` requests
`name,state,bucket,workflow,link` — it never fetches `headRefOid` nor each
check's `startedAt`/`completedAt`, so `checks.all_green` cannot tell "green on
the current head" from "green on the pre-push head." `merge-ready.sh` inherits
this blind spot. The coordinator hand-rolled the same guard (~5 times this
session): pin to current head SHA, require `total >= 2`, require checks started
after the push. There is no reusable durable-wait primitive.

**Proposed change — two parts.**

**(2a) Teach `pr-status.sh` the current head SHA and check timing** so
downstream consumers can detect staleness. Add `headRefOid` to the PR view and
`startedAt,completedAt` to the checks query, and surface them:

```diff
-  PR_JSON="$(gh pr view "$TARGET" --repo "$REPO" --json number,title,url,body,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,mergedAt)"
-  CHECKS_JSON="$(gh pr checks "$TARGET" --repo "$REPO" --json name,state,bucket,workflow,link 2>/dev/null || echo '[]')"
+  PR_JSON="$(gh pr view "$TARGET" --repo "$REPO" --json number,title,url,body,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,mergedAt)"
+  CHECKS_JSON="$(gh pr checks "$TARGET" --repo "$REPO" --json name,state,bucket,workflow,link,startedAt,completedAt 2>/dev/null || echo '[]')"
```

and in the emitted JSON add `head_sha: $pr.headRefOid` at the top level (next to
`head_ref`, line 39). (Apply the same two-field addition to the no-arg branch,
lines 12–13.)

**(2b) Add a durable, head-pinned CI-wait primitive** `scripts/auto/await-ci.sh`
that encapsulates the guards the coordinator wrote by hand, so no skill re-rolls
them. Sketch:

```bash
#!/usr/bin/env bash
# await-ci.sh <pr> [--min-checks N] [--since <ISO8601>] [--timeout-secs S]
# Prints JSON: {status: green|red|pending|stale, head_sha, checks_total, ...}
# Guarantees the reported checks belong to the PR's CURRENT head:
#   1. read head_sha via pr-status.sh
#   2. require checks.total >= min-checks (default 2) — a lone/zero rollup is
#      treated as `stale`, never green
#   3. if --since given, require every non-skipped check's startedAt >= since
#      (checks from before the push are stale)
#   4. re-read head_sha at the end; if it changed mid-wait, return `stale`
#      (someone pushed again) rather than a verdict pinned to a moved head
# Bounded poll (default 20 min), fixed sleep interval; exits with an explicit
# terminal status the outer loop consumes — never tight-loops or relies on a
# session auto-wake.
```

Then in `superfield-auto.md` Phase 1, replace the ad-hoc "arm the background CI
watcher" language (line 73 and 111–118) with "run `await-ci.sh {pr} --since
{push-time} --min-checks 2`; treat `stale` as keep-waiting, `green` →
re-run `merge-ready.sh`, `red` → classify (see item 7)."

**Recommendation:** Do both. 2a is a two-line, zero-risk data enrichment that
also unblocks item 7's classifier (which needs `startedAt` to know a check ran
against the current head). 2b is the reusable primitive whose absence caused the
same bespoke bash to be rewritten ~5 times — highest de-duplication value in the
log.

---

## 3. Intra-phase merge ordering not encoded  (P1)

**Affected files**
- `scripts/auto/merge-ready.sh` lines 94–170 (predecessor gate is **phase-level
  only**: it computes `phase_depends_on` → `phase-predecessor-not-complete`, and
  never consults the issue-level `dependencies[]` array).
- `scripts/auto/parallel-eligible.sh` lines 204–219 (this script **does** read
  `.dependencies[]` for *eligibility*, but only for speculative slot selection —
  not for merge ordering).
- `skills/superfield-auto/SKILL.md` lines 62–66, 103–109 (Phase-1 train uses
  "Plan order").

**Diagnosis**
The correct merge order was 59 (unhangs `bun demo`) before 58 (hardens the demo
gate that *depends on* the demo booting). That coupling was expressible as an
issue-level dependency (58 `dependencies: [59]`), and `parallel-eligible.sh`
already parses `dependencies[]`. But `merge-ready.sh`'s predecessor gate is
purely *phase*-scoped — two issues in the **same** phase have no
`phase_depends_on` relationship, so nothing stops 58 from reporting
`ready: true` before 59 merges. The Phase-1 train then follows raw Plan list
order (58 before 59), and a human had to intervene.

**Proposed change.** Add an issue-level dependency gate to `merge-ready.sh`,
mirroring the `phase-predecessor-not-complete` block but reading the linked
issue's own `dependencies[]` from the Plan entries. Insert after the phase gate
(after line 170), reusing `PLAN_ENTRIES_JSON` already computed at line 109:

```bash
# Issue-level dependency gate: a PR may not merge while any issue its linked
# issue directly depends on is still OPEN. parallel-eligible.sh uses the same
# dependencies[] array for slot eligibility; this makes it a MERGE-ORDER gate
# too, so the Phase-1 train cannot land a dependent before its dependency.
if [[ -n "$linked_issue" && -n "${PLAN_ENTRIES_JSON:-}" ]]; then
  dep_open=false
  while IFS= read -r dep; do
    [[ -n "$dep" ]] || continue
    st="$(gh issue view "$dep" --repo "$TASKS_REPO" --json state -q .state)"
    [[ "$st" == "CLOSED" ]] || { dep_open=true; break; }
  done < <(jq -r --argjson n "$linked_issue" \
      '.[] | select(.number == $n) | .dependencies[]?' <<<"$PLAN_ENTRIES_JSON")
  if [[ "$dep_open" == "true" ]]; then
    ready=false
    reasons="$(jq -c '. + ["issue-dependency-not-complete"]' <<<"$reasons")"
  fi
fi
```

Route `issue-dependency-not-complete` in Phase 1 exactly like
`wait-predecessor` (line 76): expected, skip to the next PR in the train.

**Design note / dependency on data quality.** This only fires if the Plan
actually records `58 dependencies: [59]`. The friction log says the coupling was
"hinted at" by coupling_risks/dependencies metadata, so the data likely exists;
if it is only in `coupling_risks` prose and not the machine `dependencies[]`
array, the real fix is upstream — `phase-replan.md` / `replan-evaluate.md` must
promote a hard "must merge after" coupling into `dependencies[]`. **Recommend:**
add the `merge-ready.sh` gate now (cheap, correct, no-op when data absent) AND
add a one-line instruction to the replan prompts to encode
"unhangs/depends-on-runtime-of" couplings as `dependencies[]`, not just prose.

**Recommendation:** Adopt. The gate is a faithful mirror of an existing block
and makes merge order a deterministic function of declared dependencies instead
of Plan list order.

---

## 4. `merge-pr.sh` leaves branch + worktree when the branch is checked out  (P1)

**Affected files**
- `scripts/auto/merge-pr.sh` line 39 (`gh pr merge ... --delete-branch`).

**Diagnosis**
`gh pr merge --delete-branch` tries to delete the local branch, but the branch
is checked out in the PR's worktree, so git refuses: `failed to delete local
branch <b>: ... checked out at <worktree>`. Non-fatal, but the remote branch,
local branch, and worktree are all left behind, and the coordinator manually ran
`git worktree remove --force`, `git branch -D`, `git push origin --delete` after
every merge (3+ times this session). The script knows the PR number and can
locate its worktree (`find-issue-worktree.sh` exists in the tree).

**Proposed change.** After a successful `gh pr merge`, remove the worktree
first, then let branch deletion succeed. Patch lines 37–39:

```diff
 MERGE_STRATEGY="$(git config auto.mergeStrategy 2>/dev/null || echo "squash")"
 case "$MERGE_STRATEGY" in rebase) MERGE_FLAG="--rebase" ;; *) MERGE_FLAG="--squash" ;; esac
-gh pr merge "$PR_NUMBER" "$MERGE_FLAG" --delete-branch
+
+# Determine the head branch + its worktree BEFORE merging so we can clean up
+# after. gh's --delete-branch fails to delete a LOCAL branch that is checked
+# out in a worktree, silently leaving the worktree + local + (sometimes) remote
+# branch behind. Remove the worktree first, then merge with remote-branch
+# deletion, then prune the local branch.
+HEAD_BRANCH="$(gh pr view "$PR_NUMBER" --json headRefName -q .headRefName 2>/dev/null || echo "")"
+WT_PATH="$("$SCRIPT_DIR/find-issue-worktree.sh" --branch "$HEAD_BRANCH" 2>/dev/null | jq -r '.worktree_path // empty' 2>/dev/null || echo "")"
+
+gh pr merge "$PR_NUMBER" "$MERGE_FLAG" --delete-branch
+
+# Post-merge local cleanup (best-effort; never fail the merge on cleanup).
+if [[ -n "$WT_PATH" && -d "$WT_PATH" ]]; then
+  git worktree remove --force "$WT_PATH" 2>/dev/null || true
+fi
+if [[ -n "$HEAD_BRANCH" ]]; then
+  git worktree prune 2>/dev/null || true
+  git branch -D "$HEAD_BRANCH" 2>/dev/null || true
+fi
```

Verify `find-issue-worktree.sh`'s actual flag/output shape before wiring
(the `--branch`/`.worktree_path` names above are assumed — adjust to its real
interface; if it only takes an issue number, resolve the issue from the PR
first). If that script's interface doesn't fit, inline the lookup:
`git worktree list --porcelain | awk` matching `branch refs/heads/$HEAD_BRANCH`.

**Recommendation:** Adopt. Fully deterministic, eliminates a per-merge manual
cleanup, and keeps `cleanup-stale-worktrees.sh` as a backstop rather than the
primary mechanism.

---

## 5. Phase-6 backlog GENERATION fired during an active merge train  (P2)

**Affected files**
- `skills/superfield-auto/SKILL.md` lines 111–118 ("Waiting on CI ... fall
  through to Phase 2 and dispatch every worker"), lines 191–210 (Phase 6),
  lines 231–237 (Stop condition).

**Diagnosis**
Phase 6 is documented as reachable "only when nothing is plannable, parked, or
remediable" (line 192). But the Phase-1 "fall through to Phase 2 and dispatch
every worker" language (line 116) plus a "more agents is better" impulse blurred
"fill idle **Phase-4 dev** slots with already-eligible work" (fine) into
"**Phase-6 garden** to GENERATE new backlog" (premature mid-train). The skill
never states that backlog *generation* is forbidden while a merge train or dev
workers are in flight.

**Proposed change.** Add an explicit guard at the top of Phase 6 (after line
192):

```diff
 ### Phase 6 — Idle (backlog generation)

-Only reached when nothing is plannable, parked, or remediable. Every idle pass, first run
+Only reached when nothing is plannable, parked, or remediable. **Backlog
+GENERATION (garden discovery, `idle-work.sh`) is forbidden while any merge
+train PR is open or any dev worker is in flight — even when a dev slot is
+momentarily free.** Filling an idle Phase-4 slot with *already-eligible* Plan
+work is not Phase 6 and is always allowed; SPAWNING NEW backlog is Phase 6 and
+requires a fully quiescent factory (no open PRs, no in-flight workers, empty
+eligible/parked/remediable sets). If any PR is still open or any worker is
+running, do not enter Phase 6 — return to Phase 1. Every idle pass, first run
```

Also tighten the Phase-1 fall-through (line 116) to name the distinction:
"dispatch every worker the free dev slots allow **from already-eligible Plan
work** (Phase 2 selection) — never Phase-6 backlog generation, which is gated on
a quiescent factory."

**Recommendation:** Adopt. Pure clarification of an existing invariant; low risk.
The "quiescent factory" precondition also naturally cooperates with item 6.

---

## 6. No keep-polling for issues filed AFTER loop start  (P2)

**Affected files**
- `skills/superfield-auto/SKILL.md` lines 210 (`factory-clean` → stop),
  231–237 (Stop condition), 191–210 (Phase 6).
- `scripts/auto/idle-work.sh` (routes to `factory-clean`), `github-snapshot.sh`
  (the snapshot the loop reads).

**Diagnosis**
The backlog drained to in-flight PRs; without a human nudge the loop would head
to `factory-clean` and stop, silently missing issues 75/76/77 filed via feature
intake **while the loop ran**. Neither the stop condition nor Phase 6 treats "new
issues have appeared since the last snapshot" as loop work, and no long-lived
new-issue poll exists.

**Proposed change — recommended: a reconciliation gate before `factory-clean`.**
Make `factory-clean` conditional on "no open non-Plan issue is unaccounted for."
Concretely, before honoring `factory-clean`, re-run `github-snapshot.sh` and
compare open issues to the Plan; any open issue not in the Plan (e.g. freshly
filed by feature intake) is loop work → replan → Phase 1, not a stop.

Patch the `factory-clean` route (line 210) and the Stop condition (231–237):

```diff
-- `factory-clean` → **stop.** The only legitimate stop.
+- `factory-clean` → **reconcile before stopping.** Re-run `github-snapshot.sh`
+  and list open issues (excluding the Plan and closed items). If ANY open issue
+  is absent from the Plan — e.g. filed by feature intake *after* the loop
+  started — it is unstarted loop work: replan to register it, then return to
+  Phase 1. Only when every open issue is already CLOSED or in the Plan and fully
+  processed is `factory-clean` a real **stop** (the only legitimate stop).
```

and in Stop condition (line 233):

```diff
-Stop only on `factory-clean` or user interrupt. Empty selection, merge blockers,
+Stop only on a RECONCILED `factory-clean` (no open issue is missing from the
+Plan) or user interrupt. A new issue appearing since the last snapshot is loop
+work, not a stop. Empty selection, merge blockers,
```

**Design option — a bounded long-poll instead of a one-shot reconcile.** If the
desire is for the loop to *keep running* and pick up issues filed minutes later
(not just those already present at drain time), add a bounded wait in
`idle-work.sh`: before returning `factory-clean`, poll `github-snapshot.sh` for
up to `git config auto.idlePollSecs` (default e.g. 300s) and return
`new-issues` if any appear. This is more machinery and risks never stopping on a
busy repo; the **one-shot reconcile is recommended** as it closes the observed
gap (issues that already existed at drain) without an unbounded idle loop. If a
true daemon mode is wanted, make it opt-in via config.

**Recommendation:** Adopt the one-shot reconcile. It directly prevents the
silent miss with a bounded, deterministic check and no new long-lived process.

---

## 7. Infra-flake classification + rerun was manual  (P1)

**Affected files**
- `skills/superfield-auto/SKILL.md` Phase 1 (lines 62–101 route a failing check
  straight to `dispatch-worker` with no flake triage).
- No classifier / rerun script exists (`scripts/auto/` has no `flake`/`rerun`).
- `scripts/auto/pr-status.sh` (checks include `link`/`workflow` but not the
  failed-job log needed to classify).

**Diagnosis**
PR 74's `e2e` check failed on a buildkit daemon EOF during docker image build
(`target mcp: failed to receive status: rpc error: code = Unavailable ... EOF`,
`compose build failed`) **before the PR's code compiled**, while
`backend-integration` (which compiles+tests the code) was green. The coordinator
manually read the log, classified it as infra (not a regression), and ran
`gh run rerun --failed`; it went green. There is a known transient-flake class
(this buildkit EOF; a live-Base-RPC `429` — the latter is already noted in
MEMORY) but Phase 1 has no shared classifier that auto-distinguishes infra flake
from real red before treating a check as failing.

**Proposed change.** Add `scripts/auto/classify-checks.sh <pr>` that reads each
failing check's run log and matches a maintained infra-flake signature list,
returning per-check `{name, verdict: infra-flake|real|unknown, matched_pattern}`
plus a top-level `rerunnable` boolean. Signatures (extensible, one per line in a
committed `flake-signatures.txt`):

```
rpc error: code = Unavailable.*EOF          # buildkit daemon EOF
compose build failed                        # docker compose build infra
429 Too Many Requests                        # live Base RPC rate limit
i/o timeout|TLS handshake timeout|no space left on device
runner .* lost communication|The runner has received a shutdown signal
```

Classifier logic: pull the failed run's log
(`gh run view <run-id> --log-failed`), and — critically — only classify a
failure as `infra-flake` when the failure occurs **before** the code's own
test/compile step ran (e.g. during image build/setup) OR a sibling
code-executing check on the same head is green. That guard prevents masking a
real regression as a flake.

Then in Phase 1, before routing a failing PR to `dispatch-worker`, insert:

```diff
-`dispatch-worker` fires only for a check that **actually failed**
-(`checks.failing > 0`) or `has-action-errors`.
+When `checks.failing > 0`, first run `classify-checks.sh {pr}`. If every
+failing check is `infra-flake` and `rerunnable: true`, run
+`gh run rerun --failed` for those runs ONCE, then re-arm `await-ci.sh` (item 2)
+— do NOT dispatch a fix worker for an infra flake. Only a `real` or `unknown`
+failure (or a second failure of the same check after one rerun) routes to
+`dispatch-worker`. `dispatch-worker` fires only for a check that **actually
+failed** with a `real`/`unknown` classification, or `has-action-errors`.
```

**Recommendation:** Adopt, with the "rerun at most once, and only when a sibling
code check is green or the failure preceded code execution" guard so a genuine
red is never silently rerun into a false green (this respects the
test-coverage-policy "loud-skip" spirit). Highest-value after items 1–2 because
infra flakes recur (buildkit EOF, RPC 429 are both already documented) and each
one currently costs a manual log-read + rerun.

---

## 8. `task-compliance` verdict field returned prose, not the enum  (P2)

**Affected files**
- `worker-prompts/task-compliance.md` lines 242–271 (Step 5 output contract).
- `agent-core/src/cli.ts` lines 1130–1150 (`compliance-record` — already
  *rejects* a non-enum `--verdict` flag at line 1134).

**Diagnosis**
The CLI already enforces the enum on the `--verdict` **flag** (cli.ts:1134
`if (verdict !== "pass" && ... ) fail("usage", ...)`), so a prose verdict can
never be *recorded*. The failure was upstream: the worker's returned JSON
`verdict` field held a paragraph, so the coordinator couldn't map the worker's
answer to a flag value and had to infer "advisory" from
`compliant:true` + non-empty `advisory_findings`. Step 5 documents the enum
(lines 256–261) but nothing makes the machine-consumed field self-validating or
gives the coordinator a deterministic fallback.

**Proposed change — two small, independent hardenings.**

**(8a) Make the worker output contract stricter and self-checking.** Amend Step
5 (after line 261):

```diff
 - `"advisory"` — no blocking findings but advisory findings exist; orchestrator
   posts them as a PR comment, then merges.
+
+**The `verdict` field MUST be exactly one of the three bare tokens `pass`,
+`advisory`, or `fail` — no prose, punctuation, or explanation in that field
+(put all reasoning in `blocking_findings`/`advisory_findings`).** It is
+consumed verbatim as the `--verdict` flag, which the CLI rejects if it is not
+one of the three tokens. Before emitting, self-check: `verdict` must satisfy
+`verdict == "fail"` iff `blocking_findings` is non-empty; else
+`verdict == "advisory"` iff `advisory_findings` is non-empty; else
+`verdict == "pass"`. If your prose doesn't fit a token, you have not finished
+the review — resolve it to a token.
```

**(8b) Give the coordinator a deterministic derive rule** so a malformed field
never needs human inference. Add to `_shared/merge-gate.md` (after the record
step, ~line 63):

```diff
+If the worker's `verdict` field is missing or not one of the three tokens,
+DERIVE it deterministically from the finding arrays (do not guess from prose):
+non-empty `blocking_findings` → `fail`; else non-empty `advisory_findings` →
+`advisory`; else `pass`. Record the derived token. This is the same invariant
+the worker self-checks in task-compliance Step 5, so the two always agree.
```

**Optional (8c) enforce at the CLI** by adding a `--from-json <file>` mode to
`compliance-record` that reads the worker's JSON and applies the 8b derive rule
server-side, removing the coordinator's mapping step entirely. Higher effort;
only worth it if the prose-verdict recurs after 8a/8b.

**Recommendation:** Adopt 8a + 8b (both are prose, zero code risk, and together
give a strict contract *and* a deterministic fallback). Defer 8c unless the
issue recurs.

---

## Cross-cutting themes

**(A) Single owner of `main` advancement.** Items 1 (and partly 3, 4) all stem
from more than one actor mutating `main` / its branches. Making the coordinator
the sole merger (item 1), gating merge order deterministically (item 3), and
owning worktree/branch cleanup at the single merge choke-point (item 4) together
make `main` advancement single-writer and fully scripted. This is the highest-
leverage structural change: it removes an entire class of rebase-thrash.

**(B) A reusable durable "wait for CI on this exact head" primitive.** Item 2's
`await-ci.sh` — pinning to `head_sha`, requiring a minimum check count, and
requiring checks to have started after the push — is the missing primitive the
coordinator re-implemented ~5 times. Items 7 (rerun then re-await) and the
Phase-1 "Waiting on CI" language (SKILL.md 111–118) should both call it. Build it
once; delete every bespoke poll loop.

**(C) A shared check classifier.** `pr-status.sh` today collapses everything to
`bucket: pass|fail|pending` with no notion of *stale* (item 2) or *infra-flake*
(item 7). Enriching `pr-status.sh` with `head_sha` + check timestamps (2a) is the
shared substrate; `classify-checks.sh` (7) is the shared consumer that turns a
raw red into `real | infra-flake | stale` so the loop reruns flakes, keeps
waiting on stale, and only dispatches fix workers for genuine reds.

**(D) Generation vs. selection discipline.** Items 5 and 6 are two sides of the
same "when is the factory actually idle?" question. A single "quiescent factory"
predicate (no open PRs, no in-flight workers, no eligible/parked/remediable, and
no unaccounted open issue) should gate *both* Phase-6 backlog generation (don't
start early — item 5) and `factory-clean` (don't stop early — item 6).

---

### Bullet summary

- **P0 item 1** (biggest single win): make the coordinator the *sole* merger —
  strip `merge-pr.sh` authority from the primary `develop-issue` worker so it,
  like speculative, drives to merge-ready and hands off; kills the merge-train
  rebase-thrash race.
- **P0 item 2**: add `head_sha` + check `startedAt` to `pr-status.sh` and a
  reusable `await-ci.sh` that pins CI verdicts to the current head — ends the
  stale-green race and the ~5× re-rolled poll loop.
- **P1 items 3/4/7**: gate `merge-ready.sh` on issue-level `dependencies[]`
  (deterministic merge order); make `merge-pr.sh` remove the worktree before
  branch delete; add a shared `classify-checks.sh` + one-shot rerun for known
  infra flakes (buildkit EOF, RPC 429).
- **P2 items 5/6/8**: one "quiescent factory" predicate to gate *both* Phase-6
  generation (don't start early) and `factory-clean` (reconcile new issues
  before stopping); tighten the `task-compliance` `verdict` field to a bare
  enum with a coordinator-side derive fallback.
- Cross-cutting: **single owner of `main`**, a **durable head-pinned CI-wait
  primitive**, a **shared stale/flake check classifier**, and a **generation-vs-
  stop idle predicate**.
