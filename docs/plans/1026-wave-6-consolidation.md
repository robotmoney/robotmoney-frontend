# Issue 1026, wave 6: consolidate every open criterion

Status: draft, 2026-09-28. Governs the work that closes issue #1026.

## Why this plan exists

Waves 1 to 5 left acceptance criteria unchecked and unowned. Wave 6 was scoped to the D55 items only. This plan folds every open criterion into wave 6, so nothing is left without an owner.

Rule: wave 6 is the last wave. The issue closes when every box is checked, each backed by the named test.

## Step 0: reconcile the checklist (first commit, no code)

Run `cd backend && bun test` and `bun test scripts/tests/integration`. Tick each box below marked "likely done" only when its named test passes. Record the result in the issue.

Likely done, per the 2026-09-28 audit (verify, then tick):

- Epoch grid columns: migration 0073 adds `epoch_anchor` and `judging_duration` [epoch-duration]
- Epoch lifecycle routes require `lifecycle_transitions` [automation-token, epoch-turnover]
- `PARTICIPANT_PENDING_PATH` comes from `ROUTES` (contract half of the client-side criterion) [participant-judge-runner]
- `api` and the pipeline worker call `runStartupPreflight` [db-preflight-checks]
- `db-registry-execution.test.ts` exists [db-registry-execution]
- No `worker-swarm` service, and `system-scheduler` has no `DATABASE_URL` [no-db-credential-outside-api-compose-config]
- Judge fault switch is gone from compose (migration and route still to verify) [no-judge-fault-injection]
- `registerQuery` has 199 call sites, so the "zero call sites" wording is stale [db-registry]

## Work packages

Each package lists its open criteria and the test that closes it. Packages are ordered by dependency.

### P1. Compose cleanup (no dependencies)

- Delete `docker-compose.smoke.yml`. Make `--allow-insecure` refuse on prod. [smoke-compose-config, smoke-compose-env]
- Remove the `research` lane, `worker-research` and its compose service. [worker-lanes, smoke-compose-config]
- Add `restart: unless-stopped` to every service. Confirm sessions and participants outlive the terminal. [smoke-compose-config, e2e]
- D55 (1): remove the `_static` mount and the `static` field from `/version` and `/health`. [smoke-compose-config, api-version-endpoint]

### P2. Registry and test database (no dependencies)

- Register the epoch code through `src/db/registry.ts`. Fix the `schema-snapshot.test.ts` fixture gap first. [db-registry, schema-snapshot]
- Make the registry structural: declare `(role, object, privilege)` at each call site. Make CI forbid raw `sql` outside it, including tagged templates with a type argument. Retire the grandfather list. [db-registry]
- D55 (13): add the object-less statement kind as a closed, equality-pinned list. Delete registered functions with no production caller. [db-registry]
- Move the test database off superuser. Roles and database come from the local superuser, schema from `rm_owner`, tests connect as runtime roles, `rolsuper` is false. Remove the nine self-provisioning harnesses. [preload]

### P3. Judge as a participant (needs P2)

- Judge runs from `credentials.judges`. Its judgement arrives over HTTP, signed with that key. Nothing judges inline. Add the server seam the runner submits into. [swarm-judge, no-inline-judge]
- Client side: a judge container subscribes and submits through the routes. Readiness passes with the judge absent. [participant-judge-runner, smoke-readiness]
- D55 (3): forward migration drops `swarm_judge_fault_injection`. Its `audit_log` rows and judgements stay readable. Delete the arm route, the admin control and the env flags. The participant judge reports usage. The api writes the judge spend columns. [no-judge-fault-injection, judge-spend]
- D52: each `credential.json` entry carries member id, signing key, bearer token and model key. An `agents` entry without role `member` or a `judges` entry without role `judge` refuses the boot, naming it. [credential-file]

### P4. Spoofed keys (needs P3)

- D52: `--spoof-keys` defaults to members with `operator = robotmoney`. It refuses without the explicit flag. It mints bearer tokens with the keys. While its generation exists, a plain boot takes those entries from it. [spoof-keys]
- An interrupted rebind, and a crash after commit before container replacement, both recover to the persisted generation. [spoof-keys-recovery]

### P5. Lifecycle, scheduler and preflight (needs P1, P2)

- Wire the real `bun smoke --local blank` under `RM_ENV=stage`. It writes a plan, a journal with every §1.3 phase, a receipt and reconciled participants. `smoke-status.ts` reads the receipt. [smoke-lifecycle]
- Per-instance service tokens: provisioned unattended in `blank` and `dump`, reused by `volume`, never rotated on a same-plan-id rerun, never shared by two CI instances. Blank and dump boots reach readiness with the real scheduler. [smoke-state, smoke-journal, e2e]
- Scheduler health: unhealthy when the API is unreachable and, separately, when the token is rejected. The health endpoint reports authenticated, synchronized, rebuilt, and each exhausted item with subject and last error. No service other than `api` and the pipeline worker holds a database credential. [no-db-credential-outside-api-compose-config]
- Preflight checks 1 to 3 run at `api` startup against its own credential. Check 4 fires in production. The scheduler runs an HTTP check. [db-preflight-checks]
- Blank boot gives every subject all three scheduling columns. A populated boot changes none. A NULL or non-positive duration is rejected. The admin route is the only writer. A change publishes `subject.changed`. A duration change re-anchors the grid in one transaction. [epoch-duration]
- D55 (4): no operator early-turnover path in code, contract or admin UI. [automation-token, epoch-turnover]
- D55 (10): the twin tooling and every stage tool refuse a remote target with no `deployment_identity` table. They name the runbook intervention. [smoke-twin-remote-refusal]

### P6. End-to-end and gates (needs P1 to P5)

- End to end with duration N: readiness only after the real scheduler opens an epoch for every active subject. Removing the token file fails readiness naming it. After 2N there are exactly two sessions: the first `published`, the second `collecting`. [e2e, smoke-readiness-scheduler]
- Unattended CI `bun smoke --local blank --migrate --seed` under stage reaches readiness with no prompt. [e2e]
- CI test executes each role's registered queries as that role against a disposable database. [db-registry-execution]
- Named suites green: unit, integration, backend.
- Full-stack smoke step: exit 0 at readiness, receipt present, scheduler healthy, participants and judge running, one turnover observed, then `smoke:down`.
- Full gate green is the push condition for every PR in this issue.

## Traceability

Every unchecked box in the issue body maps to exactly one package above. Step 0 adds a table to the issue with three columns: box text, package, closing test. A box that maps to no package blocks the merge of wave 6.

## Exit

Close the issue when Step 0's table shows every box checked and P6's full gate is green on the merge commit.
