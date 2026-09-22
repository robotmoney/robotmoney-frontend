# Smoke

Smoke stands a full application environment up and proves it serves. It is one
composable tool: every invocation is `bun scripts/smoke.ts` with a combination
of flags. The named `smoke:*` scripts in `package.json` are shorthands for
common combinations, and each prints the exact equivalent flags it ran.

Smoke's one job is bring-up. It does not, by itself, change a database it does
not own: migrating and seeding are separate tools (see
[Migration and seeding](#migration-and-seeding)).

## Composable axes

| Axis | Flag | Choices |
|---|---|---|
| Where the database lives, and who owns it | `--db <mode>` | `ephemeral` · `external` · `smoke-twin` |
| Reuse a saved local volume | `--pg-data <dir>` | payload on `--db ephemeral` only |
| Scenario | `--smoke` | archive (production-shaped data) vs simulation fixtures |
| Host port | `--static-port` / `--stage` | the fixed tunnel port vs a Docker-assigned one |
| Write the schema / the data | `--migrate` / `--seed` | opt-in, `--db external` only |
| No live terminal UI | `--no-tui` | required for a real exit code in automation |

`--db` is the load-bearing choice. It answers two questions at once — where
Postgres lives, and who owns the data:

| `--db` | Postgres | Owns the data | Migrates + seeds by default |
|---|---|---|---|
| `ephemeral` | a container this boot starts | yes | yes |
| `smoke-twin` | a local container restored from a production dump | yes (a copy it created) | yes |
| `external` | a managed server addressed from `$HOME/.env` | **no** | **no** — opt in with `--migrate` / `--seed` |

`ownsData()` (`smoke-db-mode.ts`) is that ownership bit. A boot migrates and
seeds every time **iff** it owns the data; an `external` boot owns nothing, so
it writes only what its flags explicitly ask for.

## Use cases

| Use case | Command | `--db` | Credentials |
|---|---|---|---|
| **Production** | `SMOKE_PROJECT=rm_prod bun run smoke -- --db external --static-port --no-tui` | `external` | `rm_app` / `rm_worker` from `$HOME/.env` |
| **Stage** | `bun run smoke:stage` | `external` | `rm_app` / `rm_worker` from the stage host's `$HOME/.env` |
| **Blank local** | `bun run smoke` | `ephemeral` | the container's baked-in throwaway credentials |
| **Saved local volume** | `bun run smoke -- --db ephemeral --pg-data <dir>` | `ephemeral` | same; the volume persists across boots |
| **Twin** | `bun run smoke:twin` | `smoke-twin` | dumps the latest production database, restores it into a local container under throwaway credentials, and boots as-if-production |

`SMOKE_PROJECT` pins the Compose project name so a boot recreates a known stack
instead of a fresh random one; it is orthogonal to the data path.

Production and stage are the same `external` boot against different hosts'
`$HOME/.env`. The twin is the most-used: it restores a real production dump into
a container this boot created and may reclaim, which is why it is `--db
smoke-twin` and not `--db external` — the ownership bit is the whole difference.
The twin is the rehearsal gate (`docs/technical/release-runbooks.md` §4.4).

## Migration and seeding

Migration and seeding are separate tools, run against a database the way any
migration or seed is:

- **migrate** — `backend/src/db/migrate.ts` (`bun run migrate` in `backend/`).
  Applies pending migrations and records them in `schema_migrations`. Connects
  as the schema-owning migration login.
- **seed / initialize** — `backend/scripts/prod-bootstrap.ts`
  (`bun run prod-bootstrap`) for the archive adopt, or the producer seed for
  simulation fixtures.

`--migrate` and `--seed` are **conveniences that run those tools inline during a
boot**, and they are the only way an `external` boot writes to the database:

- `--migrate` runs the migration tool once, in an ephemeral container, before
  services start. It reads no credential from `.env`, a file, or argv: it
  prompts for the schema-owner password at the terminal, verifies it
  authenticates, uses it for that one run, and clears it
  (`smoke-external-migrate.ts`).
- `--seed` runs the initializer (archive adopt or simulation seed) and its
  database preflight.

Both are refused on `--db ephemeral` and `--db smoke-twin`, which own their data
and always migrate and seed. Absent both flags, an `external` boot runs on
`rm_app` / `rm_worker` alone and serves the schema and data already present —
this is a restart, and it needs no schema-owner credential.

## Supporting commands

| Command | Job |
|---|---|
| `bun run smoke:status` | Show the running stack (project, ports, data path). |
| `bun run smoke:down` | Stop the stack; keep its data. |
| `bun run smoke:clean` | Reclaim local Postgres volumes. Never touches an `external` server or a `--pg-data` host dir. |
| `bun run smoke:reap` | Sweep orphaned containers and Compose networks. |
| `bun run smoke:capture` | Produce the encrypted production dump a twin restores (read-only, replica, `rm_readonly`). |

## Credentials

Every command reads credentials from the single file at `$HOME/.env` (discrete
connection tokens plus one `role = password` line per role; see `.env.example`).
`ephemeral` and `smoke-twin` use throwaway local credentials instead. The
schema-owner credential is never stored in that file, a container, or an
environment variable for a runtime service; `--migrate` prompts for it
interactively for a single run.
