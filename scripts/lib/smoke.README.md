# Smoke

Smoke stands the application up against a database and checks that it serves.

Two choices decide what it runs against: **which database**, and **which
helpers**.

## Which database

By default, smoke connects to the **remote** database named in `$HOME/.env`.

Pass `--local` to use a local container instead:

- **`--local`** — a fresh local database.
- **`--local <path>`** — a local database that reuses a saved docker volume at
  `<path>`, so you can restart one that an earlier local run left behind.

## Helpers

Add any of these to a boot:

- **`--seed`** — fill an empty database with demo starting data. Fails if the
  database already has data.
- **`--migrate`** — apply any un-run migrations to the database smoke is
  connected to. A remote boot without `--migrate` **refuses to start** when the
  database has un-run migrations, rather than serving an out-of-date schema; run
  it with `--migrate` to catch the schema up.
- **`--twin`** — copy the latest real database into a fresh local one and rotate
  all of its keys so it is safe to work with. A twin is itself a local database,
  so it is used on its own, not with `--local`. You can `--migrate` a twin; you
  cannot `--seed` it, because it is already full.

## Examples

| Goal | Command |
|---|---|
| Local dev from an empty database | `bun run smoke --local --seed` |
| Restart a local database from a saved volume | `bun run smoke --local <path>` |
| Work against a copy of the real data | `bun run smoke --twin` |
| Restart production, changing nothing | `SMOKE_PROJECT=rm_prod bun run smoke --no-tui` |
| Apply new migrations to production | `SMOKE_PROJECT=rm_prod bun run smoke --migrate --no-tui` |

A production run pins the stack name with `SMOKE_PROJECT=rm_prod`, so it restarts
the existing stack instead of starting a new one, and passes `--no-tui` so the
command returns a real exit code. Neither is a database option; they are how a
boot is run.

## Credentials

A remote database is reached with the roles in `$HOME/.env` (the connection
tokens plus one `role = password` line per role). A local database uses
throwaway container credentials.

`--migrate` needs the schema-owner password. It asks for it at the terminal for
that one run and never writes it to a file or an environment variable. Nothing
else a boot does needs a privileged credential, so a plain restart needs only
the ordinary application roles.

## Supporting commands

| Command | What it does |
|---|---|
| `bun run smoke:status` | Show the running stack. |
| `bun run smoke:down` | Stop the stack, keep its data. |
| `bun run smoke:clean` | Delete local database volumes. Never touches a remote database. |
| `bun run smoke:reap` | Sweep orphaned containers and networks. |
