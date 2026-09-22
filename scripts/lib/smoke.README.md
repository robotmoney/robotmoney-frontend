# Smoke

> **Status: target design, not yet shipped.** This document describes the
> smoke tool as it will work once `docs/technical/smoke-production-spec.md`
> lands. It replaces the `--smoke`/`--db`/`--agents`/`--twin` model and the
> `smoke:archive`/`smoke:stage` scripts described in older runbooks. Until the
> engineering that implements it lands, treat this file as the design to build
> toward, and check `package.json`'s actual `smoke:*` scripts for what runs
> today.

Smoke stands the application up against a database, checks that it serves,
and exits. The stack keeps running under Docker; smoke itself does not stay
up to supervise it.

```
bun smoke --static-port
```

is the whole production invocation. `--static-port` is the one option
production passes. `bun smoke:status` and `bun smoke:tui` observe a running
stack from another terminal — `bun smoke` never draws a TUI. `bun
smoke:down` is the only way to stop a stack it started.

## Which database

By default smoke connects to the **remote** database named in `$HOME/.env`
(host/port/dbname plus one `role = password` line per role).

Pass `--local <mode>` to use a local container smoke owns instead:

- **`--local blank`** — an empty database, bootstrapped from the schema
  snapshot. Seeding is a separate step (`--seed`).
- **`--local dump[=<path>]`** — restored from a production `pg_dump`. This is
  the **twin** use case: a production-shaped database safe to experiment on.
  `bun smoke:capture` takes a fresh dump (read-only, off a replica).
- **`--local volume[=<name>]`** — reattaches a Docker volume from a previous
  local run, so you can restart where you left off.

A twin is not a fourth mode — it is what `--local dump` (usually) gives you.
It can also be a remote connection to a database that was itself restored;
remote-vs-local never decides whether something is a twin.

## Helpers

- **`--seed`** — fill an empty database with demo data. Refuses a populated
  database. Only valid on a rehearsal target (see Environment below).
- **`--migrate`** — apply pending migrations before boot. A convenience for
  stage/test/CI, where standing the database up and migrating it happen in
  one step. Refused in production: a production upgrade is always its own
  operator step (`bun run migrate`), never part of a boot.
- **`--spoof-keys [names]`** — generate fresh signing keys for the named
  in-house committee members (default: all of them) and rebind them in the
  database. For twins only: it lets a production-shaped database be driven
  without anyone's real key.

## Participants: the credential file is the roster

There are no `--agents`/`--judges` flags. The committee this host runs is
whatever `credential.json` names:

```json
{ "agents": { "athena": {...}, "noop-analyst": {...}, "robot-money": {...} },
  "judges": { "themis": {...} } }
```

Path: `RM_CREDENTIALS=<path>` in `$HOME/.env`, or `--credentials <path>`
(the flag wins). Agents and judges are separate namespaces with separate
keys — several judges are allowed, and zero agents with judges running is a
valid shape. A run makes the running participants match the file: naming
fewer than are currently running stops the rest. An explicit empty file
(`{"agents":{},"judges":{}}`) is how you remove everyone; a missing or
unreadable configured file refuses the boot rather than silently emptying
the roster.

Sessions run on their normal schedule whether or not this host runs any
participant — third parties may run every one of them. `--agents`/`--seed`
are about which containers smoke starts, never about whether a session
happens.

## Environment

`RM_ENV` stays `prod` or `stage` (stage covers today's test/CI too — they run
identically). Alongside it, every database carries a `deployment_identity`
row (`production` or `rehearsal`) written once when the database is stood
up. `--migrate`, `--seed`, and `--spoof-keys` all require a `rehearsal`
target in addition to `RM_ENV=stage`, so a stage label pointed at a database
someone marked `production` still refuses.

## Credentials

A remote database is reached with the roles in `$HOME/.env`: `rm_app`,
`rm_worker`, `rm_readonly`. `rm_owner` — the schema owner and the only
migration login — is never in that file; its password is typed at the
terminal for the one run that needs it. A local database uses passwords
smoke generates itself, so no prompt is needed there.

`$HOME/.env` on a production host must never contain `rm_owner`, `doadmin`,
or any superuser credential — the boot's preflight check refuses if it finds
one.

## Preflight

Every boot runs a read-only check before anything starts, and refuses on any
failure: every credential authenticates; every role has exactly the
privileges its programs need and none it shouldn't (no superuser,
`CREATEROLE`, membership in `rm_owner`, or delete on an append-only table);
the live schema matches what's on record for the version installed, and the
code being booted is compatible with it; `$HOME/.env` carries no dangerous
credential. The same check runs inside `api`/`worker`/`worker-swarm` at their
own startup, against their own credential.

## Supporting commands

| Command | What it does |
|---|---|
| `bun smoke:status` | Show the running stack. |
| `bun smoke:down` | Stop the stack, keep its data. |
| `bun smoke:clean` | Delete local database volumes. Never touches a remote database. |
| `bun smoke:reap` | Sweep orphaned containers and networks. |
| `bun smoke:capture` | Take a fresh production dump, read-only, off a replica. |
| `bun run migrate` | The production upgrade tool. Prompts for `rm_owner`. Never run as part of a boot. |

## Examples

| Goal | Command |
|---|---|
| Local dev from an empty database | `bun smoke --local blank --seed` |
| Restart a local database from a saved volume | `bun smoke --local volume` |
| Rehearse against a copy of real data, full committee | `bun smoke --local dump --credentials rehearsal-creds.json --spoof-keys` |
| Bring up production | `bun smoke --static-port` |
| Upgrade production's schema | `bun run migrate` (its own step, before any `bun smoke`) |

For the full design — the plan/lock/journal model, the schema snapshot,
target enrollment, and every acceptance case — see
`docs/technical/smoke-production-spec.md`.
