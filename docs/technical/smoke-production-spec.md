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
>
> **Scope.** This specification governs every service the stack runs: `api`,
> `website-server`, `system-scheduler`, `analytics-producer`, the pipeline
> worker, local Postgres, and the participants. Amended 2026-09-24 (§12).

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

Every run acts on one named deployment instance. Production is `rm_prod`. On stage, precedence is: `--instance <name>`; then CI job identity (`naming.ts` `class: "ci"`, hashed from the run's identity vars, never from persisted state); then the name persisted by a previous local run; then a fresh local name, persisted. State directories live under `$HOME/.local/state/robotmoney-smoke/<instance>` (or under an absolute `RM_SMOKE_STATE_ROOT`), never inside a checkout: they hold generated passwords, service tokens and the journal, and `git clean` or a worktree switch must not be able to lose or leak them. Nothing in repository source holds a secret or an env file a deployment reads. State directories are scoped per instance, so a CI job cannot inherit a standing stage's instance and concurrent CI jobs stay distinct with prior state present. `smoke:status`, `smoke:down`, `volume` reuse (§5), and journal resume all select by instance name.

### 1.2 Plan and locks

Before any mutation smoke prints a redacted **plan**: instance, resolved target (§4), image source identities and digests, participant roster (§6), configuration, and every mutation it intends (`--migrate`, `--seed`, `--spoof-keys`). The plan's content hash is the **plan id**. The hash covers exactly: the instance name; the target's identity (host, port and database name, or the local mode and volume name) and its `deployment_identity` kind; each image's source identity, the Git tree hash of its build context, not its built digest, which changes on every rebuild and is recorded in the receipt instead; the roster's names, roles and public-key fingerprints; every non-secret configuration value; and the requested mutations. It excludes secret values, timestamps, and any state a journaled phase itself changes, such as the schema version a completed migration moved.

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

One protocol for every tool that mutates or deploys against a database: `bun smoke`, `bun run migrate`, `--spoof-keys`, and the production-initialization commands (§9).

**Invariant.** Loss of the coordinating lock never lets a competing tool overlap a mutation still executing. A cancellation request is not evidence the mutation stopped.

- **Coordination.** The tool opens one dedicated connection and takes a session-level `pg_advisory_lock` on one constant key. Postgres already scopes advisory locks to a single database, so every tool that reaches the same database contends, whatever hostname it used. The connection is direct, never through a transaction-mode pooler, which silently breaks session locks. Smoke holds it from acquisition through preflight, replacement, and readiness, so a standalone migration cannot land between preflight and the new containers starting. It is released explicitly on exit.
- **Fencing.** Every mutation (migration, grant reconciliation, seed, key rebind, token provisioning, identity write) runs in a transaction that first takes `pg_advisory_xact_lock` on the same key, on the connection performing it. A competitor that wins the session lock after the coordinator's connection died still blocks on the xact lock until the in-flight mutation commits or aborts.
- **Acquisition.** After any local database is created or restored, before the first read used for a decision.
- **Revalidation.** After acquiring, the tool re-reads `deployment_identity`, the ledger, and the schema manifest and re-runs the plan against them. A mismatch refuses.
- **Contention.** A tool that finds the lock held waits with a timeout, then refuses naming the holder.
- **Connection loss.** Detected at every phase boundary; the tool journals the phase and exits non-zero. No phase proceeds on a lock the tool cannot prove it still holds.

## 3. Roles and credentials

**Roles:** `rm_owner` (owns the schema, the migration login), `rm_app`, `rm_worker`, `rm_readonly`. There is no `rm_migrator`.

**`doadmin`** is cluster provisioning only: it creates the four roles on a fresh cluster and performs the one-time `rm_owner` transition on an existing one (§9.1). `rm_owner` never holds `CREATEROLE`.

**`rm_owner` is `LOGIN`.** Its password is typed at the terminal for the one run that needs it and never stored.

**`~/.env`** is the deploying user's home-directory file, outside every checkout. It holds exactly these keys and nothing else: the remote connection (host, port, dbname); the runtime role passwords `rm_app`, `rm_worker` and `rm_readonly`; `RM_ENV`; and `RM_CREDENTIALS`. It must not contain `rm_owner`, `doadmin`, a superuser token, a service token, a signing key or a model key; preflight enforces the list (§7 check 4). Args override env: any `--local` mode (§5) makes smoke ignore every remote connection value.

**Participant credentials** live in `credential.json` (§6.1), never in `~/.env`. Each entry holds that participant's signing key, its API bearer token and its model key.

**Service tokens.** Three holders call the API with a service token: `system-scheduler` (read subjects and sessions, perform lifecycle transitions), `analytics-producer` (the analytics ingestion routes), and the operator (the admin routes; this replaces the `ADMIN_TOKEN` environment variable). `system-scheduler` and `analytics-producer` hold one API credential and no other kind (scheduler spec §7). Every service token is issued by the API's own automation-token store: a row holding the token's hash and its rights, written by the same authorized preparation that writes `deployment_identity`. The API validates a presented token against that row; a file on disk establishes nothing by itself. The analytics token stops being a shared secret file the API compares against and is validated like the others. Each secret is handed to its holder the way a participant's key is handed to its container — a file the boot places in the instance's state directory, named per instance and per holder, never in `~/.env` and never in an image. In production the tokens are provisioned once at initialization (§9.1). In rehearsal they are provisioned by preparation (§5), unattended. Each instance holds its own tokens, so provisioning one never invalidates another's. Rotation is a re-provision and a container restart.

**Why this shape.** Every credential lives in exactly one place, and that place is the least-privileged one that can hold it. `rm_owner` can rewrite the schema, so it is never on disk: typed for the one run that needs it, gone after. Runtime role passwords are in `~/.env` because the services need them at every boot and none of them can do DDL. Signing keys are in `credential.json` and each container receives only its own, so a compromised agent holds one key, not the roster. Service tokens are stored only as hashes in the database, so a leaked dump holds no usable token. Preflight refuses a `~/.env` that holds `rm_owner` or `doadmin` because a host that keeps an owner password on disk has no reason left to type one.

**No container holds a Docker socket.** Not a participant, and not `api`, `worker` or `system-scheduler` either. The socket is root on the host — it has no read-only mode and no capability to drop — so a service holding it puts root behind every request it handles. This design never needs one: `bun smoke` starts every container from the host and exits, Docker restarts them, and participants are standing containers that reach the API over HTTP only (§6.2). Nothing spawns a container at runtime, so nothing needs the means to.

**What this replaces.** `#1014` (`a9f2008b`) delivered the judge's credential by a different route. One `agent-launcher` service held the Docker socket and the judge's `OPENCODE_API_KEY`, and injected that key into a short-lived judge container it spawned for each judging. That is credential management by socket, and it is reversed: the launcher, its socket mount and its per-request injection are gone, and the judge receives its key the way every participant does, from `credential.json`. `scripts/tests/integration/no-docker-socket-compose-config.test.ts` asserts that no service in any composition mounts the socket, and proves itself with a planted mount.

## 4. Environment and target

### 4.1 `RM_ENV` (policy)

Values: `prod`, `stage`. Stage, test, and CI are isomorphic and share `stage`. `RM_ENV` is policy only; it does not name the instance (§1.1).

### 4.2 `deployment_identity` (target enrollment)

A one-row table in the database, `deployment_identity.kind ∈ {production, rehearsal}`, writable only by `rm_owner`. `production` is written once by production initialization (§9.1). `rehearsal` is written by every `--local blank` bootstrap, every `--local dump` restore, and every restore of a production dump into a remote database, which must end by writing `rehearsal` through `rm_owner` before any stage tool connects.

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

There is no `docker-compose.smoke.yml`. Its one surviving knob is an explicit flag, `--allow-insecure`, that is a refusal when `RM_ENV=prod`. There is no `--schedules-off`: scheduling has no off state. Stage runs the real `system-scheduler` against subjects whose epoch and judging durations were set short through the admin API ([`system-scheduler-spec.md`](./system-scheduler-spec.md) §2.3, §8). Parity with production is a tested property.

## 5. Local Postgres (stage override)

`--local <mode>` starts a Postgres container that smoke owns. In `blank` and `dump` modes smoke generates the four role passwords and saves them in the instance's state directory beside the volume; `volume` mode reuses them. No terminal prompt exists in local modes.

**Service tokens in rehearsal.** In `blank` and `dump` modes, preparation also provisions the three service tokens (§3) for the rehearsal target — same rights, same delivery, same file locations as production — and journals that phase like any other. `volume` mode reuses the instance's saved tokens. A rerun under the same plan id reuses a completed provisioning rather than silently rotating it (§1.3). A remote rehearsal target uses tokens provisioned for that enrolled target by the same procedure, run explicitly. In every environment `system-scheduler` and `analytics-producer` each receive only their API credential; no database or signing credential is ever introduced for them.

| mode | start state |
|---|---|
| `blank` | empty database bootstrapped from the snapshot (§8.1): schema, bootstrap data, ledger baselined to the snapshot's filename list, manifest written, `deployment_identity = rehearsal` |
| `dump[=<path>]` | restored from a production `pg_dump`, then `deployment_identity = rehearsal`; `bun smoke:capture` (read-only, `rm_readonly`, against a node that serves reads; a standby that serves none does not qualify) takes a fresh dump |
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

Path: `RM_CREDENTIALS=<path>` in `~/.env` or `--credentials <path>`; arg overrides. Agents and judges are distinct namespaces with distinct keys. Several judges are allowed; zero agents with several judges is valid. Each entry carries the participant's member id, signing key, API bearer token and model key, and each container receives only its own entry. An `agents` entry must be a member with role `member` and a `judges` entry a member with role `judge` (D48, amendment for issue 812); a mismatch with the database refuses the boot and names the entry.

**Desired state.** A run makes the running participants equal the file: named ones are started or kept, unnamed running ones are stopped. A changed file is a roster change and appears in the plan.

**A missing file is never an instruction.** A configured path that is missing, unreadable, or malformed refuses and leaves running participants untouched. Removing every participant requires an explicit empty roster `{ "agents": {}, "judges": {} }`. With no path configured, smoke proceeds with no participants only if none are running; otherwise it refuses and names them.

### 6.2 Standing participant containers

Each roster entry is one long-lived container (`restart: unless-stopped`) that behaves like a third-party deployment. What every participant shares: a standing container, a participant-held signing key, HTTP interaction with the API only, model work run as a one-shot process in a fresh per-item workspace with a timeout and process-group cleanup, and no database credential or Docker socket (§3). What differs is how each kind discovers its work:

- **Agents poll.** An agent polls the API for `collecting` sessions it has not yet taken, submits, and sleeps.
- **Judges subscribe.** A judge holds an authenticated stream to the API and receives judging requests created by the scheduler's request-judging transition (scheduler spec §4.4). The request is state, not a fleeting event: on every connect or reconnect the API serves every session in `judging` for which this judge has not yet submitted, so a judge that was down when the request was created still obtains it if it returns before the deadline. The judge performs its model work and submits its judgement through the participant API. Redelivery can never change an outcome: a submission after finalize is recorded as late evidence (scheduler spec §4.4). The deadline and finalization belong to the scheduler, never to the judge, so an absent judge delays nothing and yields `no_consensus`. Readiness (§6.3) never requires a judge to be connected or a consensus to exist.

**Idempotent submission, one final take.** A submission is identified by its signed `nonce`. A participant writes its signed submission into its workspace before sending it, so a crash-restart resends the same bytes. A resubmission whose nonce is already recorded for that member and session is a retry: it returns the existing record and the participant treats it as success. A new nonce is an intentional amendment, allowed while the window is open: each is its own signed row, and accepting one marks it final and unsets the member's previous one ([D51](../decisions.md#d51)). A partial unique index on `(session, member) WHERE final` makes two final takes impossible even when two submissions race, and `rm_app` may `UPDATE` only the `final` column of that table. An old and a new container overlapping during a roster change can therefore produce an amendment, never a second final take. One take in flight per participant.

**The judge is a participant** exactly like an agent. No component of the stack judges inline, and nothing but the admin route writes `swarm_judge_config`.

**Third-party gate.** A judgement from a judge whose member `operator` is `robotmoney` is in-house and is accepted whatever `swarm_judge_config.third_party_enabled` says. A judgement from any other judge is refused while that flag is false.

### 6.3 Sessions are independent

Sessions are timed by `system-scheduler`, per subject, in epochs — [`system-scheduler-spec.md`](./system-scheduler-spec.md) owns that entirely. They run whether or not this host runs any participant; third parties may supply every participant.

**There is nothing to enable.** A subject's scheduling columns — epoch duration, epoch anchor and judging duration (scheduler spec §2.2) — are the whole schedule: set by bootstrap data on a blank database, changed afterwards only through the admin API, and never disabled. Sessions have no schedule rows, no cron strings, no `next_run_at`, and no enable command. The pipeline worker's `job_schedules` rows for the vault, wallet, buyback and project jobs are unrelated to sessions and are bootstrap data (§8.1). A plain restart never rewrites operator state, and `system-scheduler` rebuilds its timers from the API on every start.

**Preflight vs readiness.** Preflight checks that every active subject has its scheduling columns (§7 check 6). It does not require an open epoch before the scheduler starts. Readiness checks first-epoch creation and scheduler health after startup.

**Scheduler readiness** requires all of: the scheduler authenticated to the API; its stream established and synchronized (scheduler spec §3.1); its initial rebuild complete, meaning timers reconstructed and recoverable work resumed, not that any settlement has finished; and every active subject holding a `collecting` session. A scheduler reporting exhausted work (scheduler spec §4.6) is not ready. `collecting` rows alone establish nothing, since an exhausted turnover leaves such a row in place. Smoke reads this from the scheduler's health endpoint and records the result in the receipt. `smoke:status` and the TUI show the receipt as history and the health endpoint as now, side by side, including any degradation with its subject or session and last error. A session waiting on its judging deadline, or published `no_consensus`, is not a health failure. Recovery from exhausted work is a restart of that instance's scheduler container (`docker restart` of the instance's `system-scheduler`) after the failing dependency is back; smoke never restarts it on its own.

**Other services' readiness.** Readiness also requires `api`'s `/health` to answer ok, the pipeline worker to have passed its startup checks (§7.2), and `analytics-producer` to have authenticated with its token and completed its seed command. Smoke records each result in the receipt.

### 6.4 Spoofed keys

`--spoof-keys [names]` generates fresh keypairs and bearer tokens for the named in-house members (default: every member with `operator = robotmoney`) so a production-shaped database can be driven without real keys. It exists for twins.

Order: (1) write the generation to an instance-scoped file in the state directory, never the `RM_CREDENTIALS` path (equal paths refuse); (2) rebind every named member's key in one fenced transaction, keyed by member id; (3) stop every running participant holding an older generation; (4) start them from the new file. A retry reads the persisted generation and reuses it. Historical verification keys are preserved.

This is recoverable, not atomic. Between (2) and (4) a container may hold the old key; the server rejects submissions signed with a superseded key, so the worst case is a refused take. A crash between (2) and (4) is recovered by rerunning `--spoof-keys`, which finds the database already at the persisted generation and performs only (3)–(4).

**Roster precedence.** While a spoof generation exists for an instance, reconciliation (§6.1) takes the named members' entries from the generation file instead of `RM_CREDENTIALS`. A later plain boot therefore keeps those members on the keys the database accepts.

Any one of these refuses: `RM_ENV = prod`; `deployment_identity ≠ rehearsal`; no `rm_owner` credential (generated by smoke in local modes, typed on a remote connection); flag not explicit.

## 7. Preflight

Boot order: config validation → plan and deployment lock → database create/restore (local) → target lock (§2) → identity matrix (§4.3) → authorized preparation → **preflight** → containers → readiness → receipt. Preflight is read-only and refuses the boot on any failure.

**Checks, against any database including production:**

1. Every role password smoke will hand to a container authenticates.
2. Each role holds every privilege the registry (§7.1) says its programs need, and none from the denylist: superuser; `CREATEROLE`; membership in `rm_owner`; ownership of any application object; DDL; `DELETE`/`TRUNCATE` on append-only tables. Checked through catalog queries (`has_table_privilege`, `pg_has_role`, `pg_class.relowner`), never by executing application statements. A grant absent from the registry is not forbidden by that fact alone. Append-only protection is both absent privilege and the existing triggers.
3. Schema, two questions against the installed version M:
   (a) **integrity** — live definitions of every object class in §8.1 match the manifest for M stored in the database (§8.3), excluding the provider list. Genuine drift fails here whatever code is booting.
   (b) **compatibility** — the booting code supports M (§8.4). An additive change to an existing table passes: (a) compares against M's manifest, which includes it; (b) reads the migration's declaration.
4. `~/.env` holds only the keys §3 lists. Any other key warns on `stage` and refuses on `prod`; an `rm_owner`, `doadmin` or superuser credential is named in the message.
5. `RM_ENV` × `deployment_identity` resolve per §4.3.
6. Every active subject has its epoch duration, epoch anchor and judging duration. (Whether it has an open epoch is a readiness check, not a preflight one — §6.3.)

### 7.1 Registry, enforced structurally

All database access goes through one registered query interface that declares `(role, object, privilege)` at the call site. CI forbids raw `sql` outside it, so the registry cannot drift into a hand-maintained list. It is the input to check 2. It is not a runtime proof: execution under each role against a disposable database is a separate CI test.

### 7.2 One library, three callers

- **Smoke** runs the full preflight and refuses the cluster.
- **The database-holding containers** — `api`, and the pipeline worker running the vault, wallet, buyback and project jobs as `rm_worker` — run checks 1–3 at startup against their own credential, log, and refuse to serve or claim work on failure. `system-scheduler` and `analytics-producer` hold no database credential (scheduler spec §7). The research worker lane serves only retired rows and is removed.
- **Participants** hold no database credential. Their startup diagnostic is HTTP: API reachable, token valid, identity matches the roster entry.

### 7.3 CI isomorphism

CI end-to-end runs use the production roles and the production preflight. There is no superuser test database. The local container's superuser does only what `doadmin` does in production: it creates the four roles and the database, once. `rm_owner` then provisions the schema, tests connect as `rm_app`/`rm_worker`/`rm_readonly`, and nothing uses the superuser again.

## 8. Schema

### 8.1 Snapshot

A hand-maintained file in three parts, carrying the exact filename list of the migrations it embodies (a number alone is not an identity) and an explicit exclusion list for provider-managed objects.

- **Schema declaration** — tables, constraints, indexes, functions, triggers, policies, ownership, default privileges. Canonical description and blank-database bootstrap. Never applied to a populated database.
- **Bootstrap data** — the operational rows the application needs to run: singletons; each subject's epoch duration, epoch anchor and judging duration (scheduler spec §2.3); and the pipeline worker's `job_schedules` rows for the vault, wallet, buyback and project jobs. There are no session schedule rows. Distinct from `--seed` demo data.
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

**Order.** When every pending migration is `additive`, the operator runs `bun run migrate` against the running stack, then `bun smoke --static-port` with the new images; the old code keeps serving because it supports the additive state (§8.4). When any pending migration is `breaking`, the operator runs `bun smoke:down`, then `bun run migrate`, then `bun smoke --static-port`, so no old service runs against the breaking state. The release's runbook names which case applies.

`--migrate` is a convenience for stage, test, and CI, where the database and the boot happen in one step. It refuses on `RM_ENV=prod` or `deployment_identity ≠ rehearsal`. In local modes it uses the owner password smoke generated. On a remote connection it prompts for `rm_owner`, warns, and asks `y/n`. It runs the migrate run of §8.3.

## 9. Production

### 9.1 One-time initialization (receipted, never via `bun smoke`)

1. `rm_owner LOGIN` — via `doadmin`: `ALTER ROLE rm_owner LOGIN PASSWORD …`, then a verification login. Migration 0053's `NOLOGIN` lines change for fresh databases; existing databases need this step because the runner skips recorded files.
2. Baseline — compare production's live schema with the snapshot for its installed filename list. Any difference is repaired by a migration first; the first `bun run migrate` publishes a manifest only when the live schema matches.
3. Grant transition — a migration revoking `DELETE`/`TRUNCATE` on append-only tables from `rm_app`/`rm_worker` (0053 granted `DELETE` on all tables). Check 2 fails until it lands.
4. `deployment_identity = production` — via `rm_owner`.
5. Provision the three service tokens (§3).
6. Rebind each seated member to its `credential.json` key through the admin `rotate-key` route, one member at a time, writing each returned bearer token into that member's entry.

### 9.2 Every boot

1. Host: `RM_ENV=prod`; `~/.env` with the §3 keys only; `RM_CREDENTIALS` pointing at the credential file (today: agents `athena`, `noop-analyst`, `robot-money`; judge `themis`).
2. `bun smoke --static-port`
3. Plan printed, locks taken, preflight passes or the boot stops with the reason. On success smoke exits; the stack runs under Docker.
4. Observe with `bun smoke:status`. Stop only with `bun smoke:down`.

### 9.3 Transition from the current host

The production host runs `RM_ENV=smoke` under the overlay, so no `prod` guard has ever been armed, the three seated agents hold the committed fixture keys, and sessions are driven by an in-process smoke driver rather than a scheduler. Cutover: set `RM_ENV=prod`, provision the credential file, run §9.1 (its step 6 rotates the three members fixture → real by member id), then §9.2.

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
- Restart after a subject's window instant has passed: the boundary fires once on rebuild (scheduler spec §3.2).
- `volume` reuse after restart.
- Receipt read by `smoke:status`.
- Overlay-free stage boots with the real `system-scheduler` against short epoch durations.
- A fresh `--local blank` boot authenticates the real scheduler with no production initialization; `--local dump` yields a token that works against the restored rehearsal; `volume` reuse and an interrupted-then-retried preparation keep the same token; two concurrent CI instances never share a token file.
- With `collecting` rows already present, a scheduler that cannot authenticate or synchronize fails readiness. Exhaust turnover retries: degradation is visible in `smoke:status` with subject and last error. Restore the dependency and restart the scheduler: degradation clears and the boundary fires once.
- Disconnect a judge at the judging request, reconnect it before the deadline: it obtains the pending request. Leave it disconnected: the session publishes `no_consensus` and readiness still passes.
- A subject with a duration and no epoch passes preflight, then gains its first epoch from the scheduler before readiness passes; a subject missing its duration fails preflight.
- A rebuild from unchanged sources keeps the plan id; a changed source changes it.
- A `~/.env` key outside §3's list refuses on `prod`.
- Readiness fails while `analytics-producer` has not completed its seed command, or while the pipeline worker has failed its startup checks.
- A blank bootstrap seeds the pipeline worker's schedule rows and no session schedule row.

**W2 schema and privilege verification**
- `RM_ENV=stage` + typed owner password against `deployment_identity = production` refuses; plain stage boot incl. `--allow-insecure` against production identity refuses.
- Snapshot bootstrap then `--migrate`; snapshot bootstrap boots without `--seed`.
- Old code boots after an additive change to an existing table while genuine drift on the same database still fails.
- Old release reads compat metadata written by a newer one and refuses unknown `metadata_version`.
- Migrate fails between commits and during grant reconciliation; rerun reaches a verified final state.
- Denylist: runtime role with `rm_owner` membership, object ownership, or DELETE on an append-only table fails preflight.
- `rm_app` can `UPDATE` only the `final` column of the takes table.
- Production baseline: a live schema that differs from the snapshot blocks the first manifest publication.
- Registry structurally enforced; execution under each role on a disposable database.
- Test database off superuser.
- Unattended CI boot `--local blank --migrate --seed`.

**W3 participants**
- Judge runs as a participant; nothing judges inline.
- Participant crash after submit: the resend is a retry and adds no row.
- Roster change with overlapping containers: at most one final take per member.
- Two amendments racing leave exactly one final take.
- A roster entry whose role disagrees with the database refuses the boot.
- A judgement from a judge whose operator is not `robotmoney` is refused while `third_party_enabled` is false; the in-house judge's is accepted.
- After `--spoof-keys`, a plain boot keeps the spoofed members on their spoofed keys.
- Configured credential file disappears while participants run: refuse, participants untouched.
- `--spoof-keys` with `RM_CREDENTIALS` set writes elsewhere; interrupted rebind then rerun; crash after rebind commit before container replacement recovers.

## 11. Out of scope

The design does not specify an admin UI for judge settings. D48 owns the accepted judge-mode decision and its replay prerequisite; only the admin route writes `swarm_judge_config`.

## 12. Amendments (2026-09-24)

Decided with the owner on 2026-09-24. Each row records what changed so the edit is auditable from this document alone.

| clause | said before | says now |
|---|---|---|
| header | scope implied: swarm services | governs every service the stack runs, including `analytics-producer` and the pipeline worker |
| §1.1 | state directory location unstated | state lives under the deploying user's home, never in a checkout or in repository source |
| §1.2 | "the plan's content hash is the plan id" | the hash's fields are listed; images hash by source, not built digest |
| §2 | lock keyed on database identity; fenced list includes "schedule write" | one constant key over a direct connection; fenced list names token provisioning and the identity write |
| §3 | `~/.env` holds connection + role passwords "only"; one scheduler token; participant keys | `~/.env` is the home-directory file with an exact key list; three service tokens, one store-and-file model; each `credential.json` entry carries signing key, bearer and model key |
| §4.2 | "the documented remote-twin restore procedure" | any remote restore must write `rehearsal` before a stage tool connects |
| §6.1 | roles implied by namespace | roster role must match the member's database role or the boot refuses |
| §6.2 | retry vs amendment undefined | a retry resends the same signed nonce; a partial unique index keeps one final take; the in-house judge passes the third-party gate |
| §6.3 | no schedule rows anywhere; readiness covers the scheduler | the ban covers sessions only; readiness also covers `api`, the pipeline worker and `analytics-producer` |
| §6.4 | roster reads `RM_CREDENTIALS` after a spoof | the spoof generation file wins for the named members |
| §7 | locks before create/restore; check 4 a denylist; analytics and research workers keep credentials | target lock after create/restore; check 4 an allowlist; the pipeline worker holds `rm_worker`, the research lane is removed; the local superuser only creates roles |
| §8.1 | "there are no schedule rows" | bootstrap data seeds the pipeline worker's schedule rows and each subject's three scheduling columns |
| §8.5 | upgrade order unstated | additive: migrate then boot; breaking: down, migrate, boot |
| §9.1 | four steps | adds a schema baseline before the first manifest, three service tokens, and rotating seated members through `rotate-key` |

