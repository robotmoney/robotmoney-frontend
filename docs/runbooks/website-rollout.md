# Website rollout, continuity and independent deployment

Supporting procedure for [v0.6.2](./v0-6-2-rollout.md), verified against `a0c8457d`.
The release delta inherits the standing runbook; this guide supplies the website
execution requirements. It does not waive gates or add a runner mode.

## 8. Website availability: mandatory preflight and cutover gates

The source at `a0c8457d` contains atomic website switches, graceful nginx reloads,
maintenance-file helpers, rollout-plan validation, a synthetic probe and an off-host
fallback asset. It does **not** connect those helpers to an unattended per-service
release cutover. `scripts/release/steps.ts` R6.1 invokes `stop-legacy.ts`, which invokes
`smoke:down` and proves all project containers stopped. A maintenance file cannot keep
HTTP available after nginx stops. Do not execute that list in production for v0.6.2.

| Gate | Required implementation and evidence | Current status / tracking |
|---|---|---|
| Z1. Actual cutover preserves website-server | Replace the whole-stack stop with scoped service operations. Validate the actual rendered plan with `rollout-probe.ts plan`; record nginx container ID/start time before and after. No `compose down`, `smoke:down`, or website recreation | gap, 1305 / deployment lifecycle phase 1027 |
| Z2. Unattended maintenance lifecycle | Committed steps announce/start the audited window, atomically write `web/maintenance.json` before API interruption, end the window and clear the file only after API readiness. Record receipts and recovery behavior | gap, 1305 / maintenance feature 1220 |
| Z3. Origin and public-edge continuity | Runner starts probes before any replacement and grades them through final readiness and rollback, copying receipts to the control journal. Add a faster concurrent route/asset probe for cutover gaps shorter than 15 s | gap, 1305; existing probe is a building block |
| Z4. Website-only runner | A dedicated step list must build/switch/verify/rollback only the site, and enforce the same-commit stage journal and one recorded go. The current runner has no website-only mode | gap, 1305; D54 deployment command already exists |
| Z5. Infrastructure prerequisites | Running nginx must already mount the instance web directory and support maintenance responses. Receipt the running image/config and verify the fallback is actually configured at Cloudflare | gap until deployment evidence exists, 1305 |

Adding an `ownerDecision` to a rollout plan is not permission to stop the website for
this release. A green plan validates ordering and declarations only; it does not prove
that execution follows the plan. An off-host error page also does not prove the normal
website stayed available.

The full-stack cutover must implement this sequence in the committed runner, then run
it unmodified on stage (SP.8, SR.10):

1. Run inherited preflight, baseline and backup/restore gates. Resolve the live API
   contract version and old/new site ranges; the site served during an API change must
   accept both versions. If no compatible bridge site exists, stop before cutover.
2. Start public and origin probes and record the window start in epoch milliseconds.
   Serve the compatible site by atomic switch; keep nginx and routing running.
3. Announce/start maintenance and persist the fallback maintenance JSON. Replace API
   and workers as individually scoped units, run the committed migration step, then
   replace participants, following the validated plan. Service dependencies must be
   rehearsed: no new worker or participant may write against an incompatible schema.
4. Require API/worker/participant readiness, end maintenance, clear its file, and
   verify `/api/status/maintenance` returns `state: "none"`. Run inherited postflight,
   this release's checks and the watch. Preserve both site trees for recovery.
5. Grade probes and write the production report. Website pages/assets must remain
   usable; API operations may show the planned maintenance state during backend work.

First-install constraint: v0.6.1 lacks migration `0120` and the maintenance routes.
Z2 must provide a rehearsed, scripted bootstrap path that can announce maintenance
through the static fallback before interrupting the old API, then receipt the audited
window once its schema/routes exist. Calling the new admin routes on the old API is
not a valid pre-cutover step. If the existing nginx lacks maintenance support, Z5
also needs a graceful configuration deployment proven under traffic before cutover.

The existing probe commands below run on the **control machine**, with the agent
managing the long-running probe and recording its process lifetime. Runner integration
must do this automatically; these commands alone do not close Z3:

```bash
bun scripts/rollout-probe.ts plan <rendered-rollout-plan.json>
bun scripts/rollout-probe.ts run https://robotmoney.network/ <public-probe.jsonl>
bun scripts/rollout-probe.ts grade <public-probe.jsonl> <start-epoch-ms> <end-epoch-ms>
```

Every recorded website response must be 200, with no connection errors. The current
15-second probe permits 2 seconds of scheduling jitter (17 seconds maximum gap).
Report that sampling limit honestly: it cannot establish the absence of a shorter
outage. The higher-frequency probe must cover `/`, changed routes, `/version.json`,
and referenced JS/CSS, including a page opened before the switch fetching its assets
afterwards. CDN caches must not conceal origin errors. Missing samples or missing
origin evidence fail the gate.

## 9. Independent website rollout and rollback

A website-only rollout may ship site changes from a commit that also contains backend
changes, because `smoke:web` assembles static files and reads the **running** API's
version; it does not deploy that commit's backend. Do not claim those backend changes
are live. A backend-only rollout still has to preserve the served site's API range.

Use the existing stack's instance state and Docker project, with a clean candidate
checkout on the same host and the same state-root/home as that stack. Production is
`rm_prod`; stage must name its own instance. Do not run `bun smoke` to prepare the
production site or use the full release list as a substitute for a site-only list.
No migrations, token provisioning, roster changes or API/worker restarts belong in
this mode. Website image/config changes require their own availability plan: static
`smoke:web` does not install a new nginx image or nginx config.

The dedicated runner's remote deployment step must execute the existing command
below over SSH from the control machine, from the clean checkout at the stage SHA
(stage) or its RC tag (production). These are step payloads, not instructions for a
person to log in to the host:

```bash
bun run smoke:web --instance <existing-instance>
bun run smoke:web --instance <existing-instance> --rollback
```

Before switching, assert the site's `apiRange` admits the live `/api/version` value;
never widen the range merely to bypass refusal. Keep the independent
`frontend/package.json` version and contract version distinct from the repository's
v0.6.2 release tag. Record all three identities in the report. Site-only identity
verification must check `/version.json` against the candidate while asserting that
`/api/version` is unchanged; the full-stack R7.1 check that demands one commit for both
would be wrong for this mode.

The operation builds into an isolated directory, installs an immutable site tree,
atomically switches `web/current`, records `web/previous`, reloads nginx gracefully,
and verifies the served identity. Archive `web/journal.jsonl` and `web/receipt.json`
from the resolved instance state directory (normally
`~/.local/state/robotmoney-smoke/<instance>/web`, subject to the tool's state-root
override); use the command's printed receipt path as authority. Record the site ID,
previous ID, digest, API version/range, source hashes and plan ID. Archive before a
rollback, which writes a new last receipt.

Rehearse deploy, rollback and redeploy under concurrent traffic on stage. Verify all
container IDs, start times and restart counts remain unchanged, as well as API
identity. Required existing integration coverage at the candidate commit:

```bash
bun test scripts/tests/integration/smoke-web-rolling.test.ts scripts/tests/integration/smoke-web-compat.test.ts scripts/tests/integration/smoke-web-lifecycle.test.ts
```

These tests use isolated Docker stacks. Run them only on a development/stage test
host; they supplement the production-shaped rehearsal rather than replace it.

If build or range validation fails, the old site remains current. If reload or served
identity validation fails **after** the switch, the new site may already be live and
there may be no new success receipt: inspect the journal and execute rollback
immediately through the runner. Rollback rechecks the previous site's range against
the live API. Missing previous state or an incompatible previous site blocks rollback;
fix forward with a rehearsed compatible site, keeping nginx running. Never resolve a
site-only failure by restarting the stack or restoring the database.

## 10. Execution, tagging and closing evidence

Prepare a reviewed merge from `main` into `releases-0.6.x` (D62); preserve branch
history. The scope observed on 2026-10-14 includes maintenance, schedule spacing,
dormancy counts, submission/open-session fixes, migration reconciliation, HTTP-cache
disk protection, runtime configuration changes, swarm skill/docs and member marks.
Record included commits and component deployment scope in tracking issue 1305.
Freeze a full SHA after all section 8 gaps are resolved and target files are reviewed.
For a site-only run, explicitly identify backend changes left undeployed.

The full-stack runner commands are valid interfaces at the inspected commit, but
production execution is blocked until its cutover satisfies section 8:

```bash
bun run release:run --target stage --preflight --go <stage-go-file>
bun run release:run --target stage --go <stage-go-file>
bun scripts/release/tag.ts rc --release v0.6.2 --commit <full-stage-passed-sha>
bun run release:run --target prod --preflight --go <prod-go-file> --stage-journal <passed-stage-run-dir>
bun run release:run --target prod --go <prod-go-file> --stage-journal <passed-stage-run-dir>
```

The stage go uses `commit: <full-sha>`; the production go uses `tag: v0.6.2-rc.N`.
Both name `release`, `target`, and the signed `recovery` matrix. A tooling, runbook or
candidate-tree change invalidates affected evidence: rerun stage at the final SHA.
A website-only run needs Z4's dedicated runner; the commands above deploy the full
system and must not be used for that mode. Do not invent a `--website-only` flag.

After the required postflight/watch, W3 creates the final tag at the deployed RC's
commit. Under D63, a deployed release retained in production receives its final tag
even if an owner explicitly accepts a later failed check with a follow-up issue;
record that exception and never describe it as a clean pass. A rollback withholds the
final tag. No tag is created on `main`, and existing tags are never moved.

The closing report links the frozen SHA/RC/final tag, scope, live site and API
identities, unchanged nginx evidence, maintenance lifecycle, probe grades and raw
receipts, stage journal/hash, migration receipts (full-stack only), product checks,
watch, recovery outcome, exceptions and follow-up issues. Close the tracking issue
only after that report and final tag exist. No production changes or tags are
performed merely by writing this runbook.
