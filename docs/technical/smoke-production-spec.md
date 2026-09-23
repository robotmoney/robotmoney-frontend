# Smoke production spec

> **Status: adopted design, approved for implementation, not yet shipped.**
> Adopted 2026-09-22 after adversarial review; recorded in
> [D47](../decisions.md#d47). This is the **sole deployment-design authority**.
> The former upgrade-deployment specification, its engineering plan, historical
> release procedures, and unadopted external-stack proposals were removed from
> the documentation tree on 2026-09-23. Recover historical versions from Git.
>
> Three workstreams, each landable alone, each with its own gates (§10): **W1
> deployment lifecycle** (§§1, 2, 4, 5, 9), **W2 schema and privilege
> verification** (§§3, 7, 8), **W3 participants** (§6). The production
> sequence (§9) requires all three. Adoption does not establish implementation
> status or schedule the work; do not use the retired engineering plan as a backlog.

## Document authority

| Document | Authority and limits |
|---|---|
| **This specification** | Adopted deployment mechanism, credentials, lifecycle, participants and acceptance gates. |
| [Release-runbook policy](./release-runbooks.md) | Standing release gates, phases, evidence and approval; it does not select a competing deployment mechanism. |
| [Smoke summary](../../scripts/lib/smoke.README.md) | Non-authoritative summary of this adopted design, not a claim that it has shipped. |
| Historical deployment and per-release runbooks | Removed from the documentation tree. Recover from Git for audit only; they are not new-design templates. |
| [Decision ledger D48](../decisions.md#d48) | Accepted judge-mode product behavior; this specification owns the deployment lifecycle and participant boundary. |
| Old upgrade design and engineering plan | Removed from the documentation tree. D47 and this specification replace them in full; no old phase is approved for implementation. |
| External stack and Kubernetes proposals | Not adopted and removed from the documentation tree. Recover from Git for historical research; they are not current tooling or a scheduled next step. |

Where an older document conflicts on deployment design, this specification wins.
The implemented behavior still comes from the exact code being run; no legacy
command is made safe, and no proposed command becomes executable, by this
precedence rule. The release policy's gates remain mandatory. `scripts/stack/`
is the repository's existing Compose library, not the external `stack` tool.

---

## 1. Boot

`bun smoke --static-port` brings up the production cluster and **exits**. Containers stay up under Docker (`restart: unless-stopped`). `bun smoke:down` is the only way to stop them. `bun smoke:status` and `bun smoke:tui` observe a running stack from another terminal; `bun smoke` never draws a TUI.

`--static-port` is the one option production passes. Retired with no alias: `SMOKE_PROJECT`, `--no-tui`, `--agents`, `--smoke`, `--db`, `--pg-data`, `--twin`, `smoke:archive`, `smoke:stage`.

### 1.1 Instance

Every run acts on one named deployment instance. Production is `rm_prod`. On stage, precedence is: `--instance <name>`; then CI job identity (`naming.ts` `class: "ci"`, hashed from the run's identity vars, never from persisted state); then the name persisted by a previous local run; then a fresh local name, persisted. State directories are scoped per instance, so a CI job cannot inherit a standing stage's instance and concurrent CI jobs stay distinct with prior state present. `smoke:status`, `smoke:down`, `volume` reuse (§5), and journal resume all select by instance name.

### 1.2 Plan and locks

Before any mutation smoke prints a redacted **plan**: instance, resolved target (§4), image digests, participant roster (§6), configuration, and every mutation it intends (`--migrate`, `--seed`, `--spoof-keys`). The plan's content hash is the **plan id**.

It then holds two locks for the whole run: a **deployment lock** on the instance (a second `bun smoke` against a locked instance refuses) and a **target lock** on the database (§2).

### 1.3 Journal

Phases: plan → prepare (each committed preparation recorded separately) → preflight → replace service 1..n → participants → readiness. The journal is written before each phase and marked after. It separates the operator's **desired plan** (plan id), the **state expectations** recorded when a phase began, and the **outcomes** it committed.

- A rerun resumes a journal only when the plan id matches. The journal's own committed work (a migration it applied, a manifest it wrote) never invalidates its resume.
- A different plan id (roster, digest, or target changed) closes the old journal, reports what it reached, and starts a fresh reconciliation from current state. Completed phases are never reused under a different plan.
- State changed by another operation fails the expectation check and refuses.

### 1.4 Interruption and receipt

Ctrl-C stops at the next phase boundary.
- Before the *replace* phase, application-service replacement has not begun. Preparation may already have changed database state and participant containers; those changes are journaled, not undone, and a rerun sees them.
- After replacement began, the stack stays in the journaled state with no guarantee the old services survive. `smoke:status` reports the phase and which services are new versus old; rerun resumes; `smoke:down` stops everything.

At readiness smoke writes a durable **receipt** (resolved plan, schema identity, preflight and readiness results) beside the journal. `smoke:status`, rollback, and incident work read the receipt when present, the journal when not.

## 2. Target-lock protocol

One protocol for every tool that mutates or deploys against a database: `bun smoke`, `bun run migrate`, `bun run schedules:enable`, `--spoof-keys`, and the production-initialization commands (§9).

**Invariant.** Loss of the coordinating lock never lets a competing tool overlap a mutation still executing. A cancellation request is not evidence the mutation stopped.

- **Coordination.** The tool opens one dedicated connection and takes a session-level `pg_advisory_lock` keyed on the database identity (not the compose project). Smoke holds it from acquisition through preflight, replacement, and readiness, so a standalone migration cannot land between preflight and the new containers starting. It is released explicitly on exit.
- **Fencing.** Every mutation (migration, grant reconciliation, seed, key rebind, schedule write) runs in a transaction that first takes `pg_advisory_xact_lock` on the same key, on the connection performing it. A competitor that wins the session lock after the coordinator's connection died still blocks on the xact lock until the in-flight mutation commits or aborts.
- **Acquisition.** After any local database is created or restored, before the first read used for a decision.
- **Revalidation.** After acquiring, the tool re-reads `deployment_identity`, the ledger, and the schema manifest and re-runs the plan against them. A mismatch refuses.
- **Contention.** A tool that finds the lock held waits with a timeout, then refuses naming the holder.
- **Connection loss.** Detected at every phase boundary; the tool journals the phase and exits non-zero. No phase proceeds on a lock the tool cannot prove it still holds.

## 3. Roles and credentials

**Roles:** `rm_owner` (owns the schema, the migration login), `rm_app`, `rm_worker`, `rm_readonly`. There is no `rm_migrator`.

**`doadmin`** is cluster provisioning only: it creates the four roles on a fresh cluster and performs the one-time `rm_owner` transition on an existing one (§9.1). `rm_owner` never holds `CREATEROLE`.

**`rm_owner` is `LOGIN`.** Its password is typed at the terminal for the one run that needs it and never stored.

**`~/.env`** holds the remote connection (host/port/dbname) and the runtime tokens only: `rm_app = …`, `rm_worker = …`, `rm_readonly = …`. It must not contain `rm_owner`, `doadmin`, or any superuser token; preflight enforces this (§7). Args override env: any `--local` mode (§5) makes smoke ignore every remote connection value.

**Participant keys** live in `credential.json` (§6.1), never in `~/.env`.

## 4. Environment and target

### 4.1 `RM_ENV` (policy)

Values: `prod`, `stage`. Stage, test, and CI are isomorphic and share `stage`. `RM_ENV` is policy only; it does not name the instance (§1.1).

### 4.2 `deployment_identity` (target enrollment)

A one-row table in the database, `deployment_identity.kind ∈ {production, rehearsal}`, writable only by `rm_owner`. `production` is written once by production initialization (§9.1). `rehearsal` is written by every `--local blank` bootstrap, every `--local dump` restore, and the documented remote-twin restore procedure.

It marks what the target is enrolled for. It is an accidental-target safeguard, not proof the data is disposable: its protection rests on the write restriction and on the restore procedure being pointed at the right database.

### 4.3 Policy × identity matrix (enforced before any service starts)

| `RM_ENV` | connection | identity row | result |
|---|---|---|---|
| `prod` | remote | `production` | production guards armed |
| `prod` | remote | anything else | refuse |
| `prod` | `--local` | any | refuse |
| `stage` | remote | `rehearsal` | stage |
| `stage` | remote | anything else | refuse; stage policy (incl. `--allow-insecure`) never touches production data |
| `stage` | `--local blank`/`dump` | written by smoke as `rehearsal` | stage |
| `stage` | `--local volume` | `rehearsal` | stage |
| `stage` | `--local volume` | anything else | refuse; a reattached volume gets no weaker policy than a remote |
| unset | remote | any | refuse |
| unset | `--local` | as `stage` | warn `RM_ENV not set, running as stage`, proceed |
| other | any | any | refuse |

**Rehearsal-only preparation:** `--migrate`, `--seed`, `--spoof-keys` require `rehearsal` in addition to their own guards.

**Production initialization** (§9.1) is a set of separate commands allowed on `production`, each gated by `RM_ENV=prod`, typed `rm_owner`, `y/n`, and a receipt. None is reachable through `bun smoke`.

### 4.4 No smoke overlay

There is no `docker-compose.smoke.yml`. Each former overlay knob is an explicit flag (`--allow-insecure`, `--schedules-off`) that is a refusal when `RM_ENV=prod`. Stage runs the real scheduler with accelerated `SWARM_*_CRON` values. Parity with production is a tested property.

## 5. Local Postgres (stage override)

`--local <mode>` starts a Postgres container that smoke owns. In `blank` and `dump` modes smoke generates the four role passwords and saves them in the instance's state directory beside the volume; `volume` mode reuses them. No terminal prompt exists in local modes.

| mode | start state |
|---|---|
| `blank` | empty database bootstrapped from the snapshot (§8.1): schema, bootstrap data, ledger baselined to the snapshot's filename list, manifest written, `deployment_identity = rehearsal` |
| `dump[=<path>]` | restored from a production `pg_dump`, then `deployment_identity = rehearsal`; `bun smoke:capture` (read-only, replica, `rm_readonly`) takes a fresh dump |
| `volume[=<name>]` | reattaches a Docker volume from a previous run of this instance with its saved credentials |

A **twin** is a use case, not a mode: a production-shaped database used for rehearsal, usually `--local dump`, sometimes a remote connection to a restored database.

`--seed` creates demo data on a blank database. It is explicit, refuses a populated database, requires `rehearsal`, and is never implied by any mode.

## 6. Participants (agents and judges)

### 6.1 The credential file is the roster

The in-house roster for a host is the contents of its credential file:

```json
{ "agents": { "athena": { … }, "noop-analyst": { … }, "robot-money": { … } },
  "judges": { "themis": { … } } }
```

Path: `RM_CREDENTIALS=<path>` in `~/.env` or `--credentials <path>`; arg overrides. Agents and judges are distinct namespaces with distinct keys. Several judges are allowed; zero agents with several judges is valid. Each container receives only its own key.

**Desired state.** A run makes the running participants equal the file: named ones are started or kept, unnamed running ones are stopped. A changed file is a roster change and appears in the plan.

**A missing file is never an instruction.** A configured path that is missing, unreadable, or malformed refuses and leaves running participants untouched. Removing every participant requires an explicit empty roster `{ "agents": {}, "judges": {} }`. With no path configured, smoke proceeds with no participants only if none are running; otherwise it refuses and names them.

### 6.2 Standing participant containers

Each roster entry is one long-lived container (`restart: unless-stopped`) that behaves like a third-party deployment: it polls the API over HTTP for sessions that need it, runs each take as a one-shot process in a fresh per-take workspace with a timeout and process-group cleanup, reports, and sleeps. No participant container holds a database credential or a Docker socket.

**Idempotent submission.** Take identity is `(session, member)`, unique server-side. A resubmission on an existing key returns the existing record and the participant treats it as success, so a crash after submit or an old/new container overlap during a roster change produces at most a redundant request, never a second take. One take in flight per participant.

**The judge is a participant** exactly like an agent. No component of the stack judges inline, and nothing but the admin route writes `swarm_judge_config`.

### 6.3 Sessions are independent

`worker-swarm` schedules sessions from `job_schedules` rows on their cadence whether or not this host runs any participant. Third parties may supply every participant.

**Schedule enablement** is a production-initialization command (`bun run schedules:enable`, §9.1), not a restart side-effect. It sets the five `swarm.*` rows enabled and never touches `next_run_at`. A plain restart never rewrites operator state.

**Preflight vs readiness.** Preflight verifies the rows are enabled and their cron strings parse. It does not require a future `next_run_at`: `NULL` and overdue rows are the scheduler's to initialize or drain per `catchup_policy`, and refusing to start the worker that advances them would block recovery after downtime. Readiness, after `worker` is up, checks every enabled row has been initialized or advanced per its policy.

### 6.4 Spoofed keys

`--spoof-keys [names]` generates fresh keypairs for the named in-house members (default: every member with `operator = robotmoney`) so a production-shaped database can be driven without real keys. It exists for twins.

Order: (1) write the generation to an instance-scoped file in the state directory, never the `RM_CREDENTIALS` path (equal paths refuse); (2) rebind every named member's key in one fenced transaction, keyed by member id; (3) stop every running participant holding an older generation; (4) start them from the new file. A retry reads the persisted generation and reuses it. Historical verification keys are preserved.

This is recoverable, not atomic. Between (2) and (4) a container may hold the old key; the server rejects submissions signed with a superseded key, so the worst case is a refused take. A crash between (2) and (4) is recovered by rerunning `--spoof-keys`, which finds the database already at the persisted generation and performs only (3)–(4).

Any one of these refuses: `RM_ENV = prod`; `deployment_identity ≠ rehearsal`; no `rm_owner` credential (generated by smoke in local modes, typed on a remote connection); flag not explicit.

## 7. Preflight

Boot order: config validation → plan and locks → database create/restore (local) → identity matrix (§4.3) → authorized preparation → **preflight** → containers → readiness → receipt. Preflight is read-only and refuses the boot on any failure.

**Checks, against any database including production:**

1. Every role token smoke will hand to a container authenticates.
2. Each role holds every privilege the registry (§7.1) says its programs need, and none from the denylist: superuser; `CREATEROLE`; membership in `rm_owner`; ownership of any application object; DDL; `DELETE`/`TRUNCATE` on append-only tables. Checked through catalog queries (`has_table_privilege`, `pg_has_role`, `pg_class.relowner`), never by executing application statements. A grant absent from the registry is not forbidden by that fact alone. Append-only protection is both absent privilege and the existing triggers.
3. Schema, two questions against the installed version M:
   (a) **integrity** — live definitions of every object class in §8.1 match the manifest for M stored in the database (§8.3), excluding the provider list. Genuine drift fails here whatever code is booting.
   (b) **compatibility** — the booting code supports M (§8.4). An additive change to an existing table passes: (a) compares against M's manifest, which includes it; (b) reads the migration's declaration.
4. `~/.env` holds no dangerous credential (`rm_owner`, `doadmin`, superuser): warn on `stage`, refuse on `prod`.
5. `RM_ENV` × `deployment_identity` resolve per §4.3.
6. On `prod`: the five `swarm.*` schedule rows are enabled and their cron strings parse.

### 7.1 Registry, enforced structurally

All database access goes through one registered query interface that declares `(role, object, privilege)` at the call site. CI forbids raw `sql` outside it, so the registry cannot drift into a hand-maintained list. It is the input to check 2. It is not a runtime proof: execution under each role against a disposable database is a separate CI test.

### 7.2 One library, three callers

- **Smoke** runs the full preflight and refuses the cluster.
- **Database-holding containers** (`api`, `worker`, `worker-swarm`) run checks 1–3 at startup against their own credential, log, and refuse to serve on failure.
- **Participants** hold no database credential. Their startup diagnostic is HTTP: API reachable, token valid, identity matches the roster entry.

### 7.3 CI isomorphism

CI end-to-end runs use the production roles and the production preflight. There is no superuser test database: the test database is provisioned by `rm_owner` and tests connect as `rm_app`/`rm_worker`/`rm_readonly`.

## 8. Schema

### 8.1 Snapshot

A hand-maintained file in three parts, carrying the exact filename list of the migrations it embodies (a number alone is not an identity) and an explicit exclusion list for provider-managed objects.

- **Schema declaration** — tables, constraints, indexes, functions, triggers, policies, ownership, default privileges. Canonical description and blank-database bootstrap. Never applied to a populated database.
- **Bootstrap data** — the operational rows the application needs to run (singletons, seed schedules). Distinct from `--seed` demo data.
- **Roles and grants** — idempotent grant reconciliation for objects `rm_owner` owns. Applied only inside the migrate step, against the snapshot's own version. Role creation is not part of it.

### 8.2 Migrations

Numbered forward-only migrations are the only way to move a populated database. Every migration lands with the matching snapshot change and declares itself `additive` or `breaking` in a header the runner parses. On apply the runner records `compat` and `metadata_version` in `schema_migrations`; that is how an older image learns about migrations it does not contain. Blank bootstrap writes ledger rows for the snapshot's filename list, so `--migrate` never replays history.

### 8.3 Manifest and the migrate run

A one-row `schema_manifest` table holds the declared schema for the installed version: the serialized declaration, the filename list, a content hash, and a format version. Blank bootstrap writes it from the snapshot. Only `rm_owner` may write it or the ledger's `compat`/`metadata_version` columns; they are trusted inputs to boot decisions. A manifest whose hash does not match the ledger's filename list, or whose format version is unknown, refuses.

A migrate run is: fence (§2) → apply pending migrations, one transaction each → roles-and-grants reconciliation (always, even with nothing pending) → publish the manifest for the final state in the reconciliation's transaction. Between the first commit and publication the database is *in progress*, ledger ahead of manifest: application boot refuses it (check 3a), and the migrate tool recognizes it, validates committed work against each migration's expected post-state, and resumes from the first unapplied step without replaying or accepting drift.

### 8.4 Compatibility

Code built for snapshot N boots against a database at M > N only if every ledger row outside its own filename list carries `compat = additive` and a `metadata_version` it understands. A `NULL` compat, an unknown version, or `breaking` refuses. This keeps code-only rollback alive after an additive migration and closes it after a breaking one, explicitly.

**`additive`** means old code's supported behavior is preserved across schema, data, and grants: every query the older registry declares still succeeds with the same semantics, no bootstrap row it relies on is removed or reshaped, no privilege it needs is revoked. Adding SQL objects is necessary, not sufficient. The declaration is a reviewed claim, backed by the CI proof below.

**CI proves:** blank + all migrations = snapshot; snapshot N + migrations = snapshot N+1; a snapshot-created database boots and passes preflight without `--seed`; an upgrade from a populated database of each supported release passes its data assertions; code at N boots against N+additive.

### 8.5 `--migrate` and production upgrades

In production an upgrade is an operator intervention: `bun run migrate`, prompting for `rm_owner`, planned per release, receipted. It is never part of the boot.

`--migrate` is a convenience for stage, test, and CI, where the database and the boot happen in one step. It refuses on `RM_ENV=prod` or `deployment_identity ≠ rehearsal`. In local modes it uses the owner password smoke generated. On a remote connection it prompts for `rm_owner`, warns, and asks `y/n`. It runs the migrate run of §8.3.

## 9. Production

### 9.1 One-time initialization (receipted, never via `bun smoke`)

1. `rm_owner LOGIN` — via `doadmin`: `ALTER ROLE rm_owner LOGIN PASSWORD …`, then a verification login. Migration 0053's `NOLOGIN` lines change for fresh databases; existing databases need this step because the runner skips recorded files.
2. Grant transition — a migration revoking `DELETE`/`TRUNCATE` on append-only tables from `rm_app`/`rm_worker` (0053 granted `DELETE` on all tables). Check 2 fails until it lands.
3. `deployment_identity = production` — via `rm_owner`.
4. `bun run schedules:enable` (§6.3).

### 9.2 Every boot

1. Host: `RM_ENV=prod`; `~/.env` with `rm_app`/`rm_worker`/`rm_readonly` only; `RM_CREDENTIALS` pointing at the credential file (today: agents `athena`, `noop-analyst`, `robot-money`; judge `themis`).
2. `bun smoke --static-port`
3. Plan printed, locks taken, preflight passes or the boot stops with the reason. On success smoke exits; the stack runs under Docker.
4. Observe with `bun smoke:status`. Stop only with `bun smoke:down`.

### 9.3 Transition from the current host

The production host runs `RM_ENV=smoke` under the overlay, so no `prod` guard has ever been armed, the three seated agents hold the committed fixture keys, and `job_schedules` rows are disabled. Cutover: set `RM_ENV=prod`, provision the credential file (the first boot rotates the three members fixture → real by member id), run §9.1, then §9.2.

## 10. Acceptance gates

Each is an executable release gate. Cutover requires all three workstreams green.

**W1 deployment lifecycle**
- Unset `RM_ENV` against a remote target refuses.
- Concurrent CI jobs plus a standing stage select distinct instances with prior state present.
- Second `bun smoke` against a locked instance refuses.
- Two instances preparing the same remote database serialize on the target lock.
- Kill the lock connection mid-migration, start a second mutation tool: no overlap.
- Standalone `bun run migrate` and `bun smoke` contend on the target lock, including connection loss mid-phase.
- Ctrl-C before replace: services not replaced, committed preparation journaled not undone. Ctrl-C after: journal reported, rerun resumes.
- Resume after committed preparation under the same plan id succeeds; changed roster/image/target does not reuse completed phases.
- Sessions and participants survive the invoking terminal's exit.
- Restart after schedules become overdue.
- `volume` reuse after restart.
- Receipt read by `smoke:status`.
- Overlay-free stage boots with the real scheduler.

**W2 schema and privilege verification**
- `RM_ENV=stage` + typed owner password against `deployment_identity = production` refuses; plain stage boot incl. `--allow-insecure` against production identity refuses.
- Snapshot bootstrap then `--migrate`; snapshot bootstrap boots without `--seed`.
- Old code boots after an additive change to an existing table while genuine drift on the same database still fails.
- Old release reads compat metadata written by a newer one and refuses unknown `metadata_version`.
- Migrate fails between commits and during grant reconciliation; rerun reaches a verified final state.
- Denylist: runtime role with `rm_owner` membership, object ownership, or DELETE on an append-only table fails preflight.
- Registry structurally enforced; execution under each role on a disposable database.
- Test database off superuser.
- Unattended CI boot `--local blank --migrate --seed`.

**W3 participants**
- Judge runs as a participant; nothing judges inline.
- Participant crash after submit: one take.
- Roster change with overlapping containers: one take.
- Configured credential file disappears while participants run: refuse, participants untouched.
- `--spoof-keys` with `RM_CREDENTIALS` set writes elsewhere; interrupted rebind then rerun; crash after rebind commit before container replacement recovers.

## 11. Out of scope

The design does not specify an admin UI for judge settings. D48 owns the accepted judge-mode decision and its replay prerequisite; only the admin route writes `swarm_judge_config`.
