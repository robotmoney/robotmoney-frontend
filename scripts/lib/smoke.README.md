# Smoke

> **Status: summary of the adopted design, not yet shipped.**
> [Smoke production spec](../../docs/technical/smoke-production-spec.md) is the sole
> authority; this summary adds no requirements. It replaces the legacy
> `--smoke`/`--db`/`--agents`/`--twin` model and `smoke:archive`/`smoke:stage`.
> Check the exact release code and `package.json` for available commands until
> implementation lands. [Release policy](../../docs/technical/release-runbooks.md)
> still governs cutover gates.

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
(host/port/dbname plus one `role = password` line per runtime role). That
file lives in the deploying user's home directory, never in a checkout, and it
holds only those lines plus `RM_ENV` and `RM_CREDENTIALS`. Per-instance state
(generated passwords, service tokens, the journal and receipt) lives under
`$HOME/.local/state/robotmoney-smoke/<instance>`, also outside the checkout.

Pass `--local <mode>` to use a local container smoke owns instead:

- **`--local blank`** — an empty database, bootstrapped from the schema
  snapshot. Seeding is a separate step (`--seed`).
- **`--local dump[=<path>]`** — restored from a production `pg_dump`. This is
  the **twin** use case: a production-shaped database safe to experiment on.
  `bun smoke:capture` takes a fresh dump (read-only, as `rm_readonly`, off a
  node that serves reads).
- **`--local volume[=<name>]`** — reattaches a Docker volume from a previous
  local run, so you can restart where you left off.

A twin is a use case — it is what `--local dump` usually gives you.
It can also be a remote connection to a database that was itself restored;
remote-vs-local never decides whether something is a twin.

## Helpers

- **`--seed`** — fill an empty database with demo data. Refuses a populated
  database. Only valid on a rehearsal target (see Environment below).
- **`--migrate`** — apply pending migrations before boot. A convenience for
  stage/test/CI, where standing the database up and migrating it happen in
  one step. Refused in production: a production upgrade is always its own
  operator step (`bun run migrate`), never part of a boot.
- **`--spoof-keys [names]`** — generate fresh signing keys and bearer tokens
  for the named in-house committee members (default: all of them) and rebind
  them in the database. While that generation exists it is the roster for
  those members. For twins only: it lets a production-shaped database be driven
  without anyone's real key.

## Participants: the credential file is the roster

There are no `--agents`/`--judges` flags. The committee this host runs is
whatever `credential.json` names:

```json
{ "agents": { "athena": {...}, "noop-analyst": {...}, "robot-money": {...} },
  "judges": { "themis": {...} } }
```

Path: `RM_CREDENTIALS=<path>` in `$HOME/.env`, or `--credentials <path>`
(the flag wins). Each entry carries that participant's member id, signing
key, bearer token and model key, and each container gets only its own entry.
Agents and judges are separate namespaces with separate keys, and each entry's
role must match the member's role in the database — several judges are allowed, and zero agents with judges running is a
valid shape. A run makes the running participants match the file: naming
fewer than are currently running stops the rest. An explicit empty file
(`{"agents":{},"judges":{}}`) is how you remove everyone; a missing or
unreadable configured file refuses the boot rather than silently emptying
the roster.

Sessions run in epochs that close on a fixed per-subject grid, timed by `system-scheduler`
(`docs/technical/system-scheduler-spec.md`), whether or not this host runs
any participant — third parties may run every one of them. The credential file
selects in-house participant containers; `--seed` adds demo data only to an
eligible blank rehearsal database. Neither controls session cadence.

## Environment

`RM_ENV` stays `prod` or `stage` (stage covers today's test/CI too — they run
identically). Alongside it, every database carries a `deployment_identity`
row (`production` or `rehearsal`) written once when the database is stood
up. `--migrate`, `--seed`, and `--spoof-keys` all require a `rehearsal`
target in addition to `RM_ENV=stage`. The policy/identity matrix applies even
to an ordinary boot: stage against production identity refuses, production
against rehearsal identity refuses, and production with `--local` refuses.
Unset `RM_ENV` refuses on a remote target and defaults to stage only for local modes.

## Credentials

A remote database is reached with the roles in `$HOME/.env`: `rm_app`,
`rm_worker`, `rm_readonly`. `rm_owner` — the schema owner and the only
migration login — is never in that file; its password is typed at the
terminal for the one run that needs it. A local database uses passwords
smoke generates itself, so no prompt is needed there.

`$HOME/.env` on a production host must hold nothing beyond its listed keys —
no `rm_owner`, `doadmin` or superuser credential, no service token, signing key
or model key. The boot's preflight refuses any other key on production.

Three service tokens — `system-scheduler`'s, `analytics-producer`'s and the
operator's admin token — are per-instance files in the state directory. The
API stores only their hashes. Participants' credentials live in
`credential.json`.

## Preflight

After local database creation/restore and explicitly authorized preparation,
every boot runs a read-only preflight before application services start. It
refuses on failure: each runtime credential authenticates; required privileges
are present and denied privileges absent (no superuser, `CREATEROLE`, membership
in `rm_owner`, application-object ownership, DDL, or delete/truncate on an
append-only table). An unregistered grant is not forbidden merely by omission.
Preflight also checks the live schema against the installed version's manifest,
code compatibility, and the environment's credential restrictions. The same check runs inside `api` and the pipeline worker at their own
startup, against their own credential; `system-scheduler` and
`analytics-producer` hold no database credential.

## Supporting commands

| Command | What it does |
|---|---|
| `bun smoke:status` | Show the running stack. |
| `bun smoke:down` | Stop the stack, keep its data. |
| `bun smoke:clean` | Delete local database volumes. Never touches a remote database. |
| `bun smoke:reap` | Sweep orphaned containers and networks. |
| `bun smoke:capture` | Take a fresh production dump, read-only, off a node that serves reads. |
| `bun run migrate` | The production upgrade tool. Prompts for `rm_owner`. Never run as part of a boot. |

## Examples

| Goal | Command |
|---|---|
| Local dev from an empty database | `bun smoke --local blank --seed` |
| Restart a local database from a saved volume | `bun smoke --local volume` |
| Rehearse against a copy of real data, full committee | `bun smoke --local dump --credentials rehearsal-creds.json --spoof-keys` |
| Bring up production | `bun smoke --static-port` |
| Upgrade production's schema, additive release | `bun run migrate`, then `bun smoke --static-port` |
| Upgrade production's schema, breaking release | `bun smoke:down`, `bun run migrate`, then `bun smoke --static-port` |

For the full design — the plan/lock/journal model, the schema snapshot,
target enrollment, and every acceptance case — see the
[smoke production spec](../../docs/technical/smoke-production-spec.md).
