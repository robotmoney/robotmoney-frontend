# Stage target: production's pre-cutover shape on stage-2

> **Authority.** [D61](../decisions.md) rule 2: the production runbook is
> rehearsed unmodified on stage. Only the target file differs.
> Tool: `scripts/release/stage-target.ts`. Pure parts:
> `scripts/release/stage-target-lib.ts`, tested by
> `scripts/tests/unit/stage-target.test.ts`.

## What it is

The stage target is a copy of production as it stands before the v0.6.0 cutover.
It lives on `rm-frontend-stage-2`. The release runner runs the production step list
against it with `bun run release:run --target stage`. No step takes a stage-only path.

The target file names these fields:

| Field | Stage target | Production |
|---|---|---|
| host | `rm-frontend-stage-2` (user `stage-server`) | `rm-frontend-prod-1` (user `root`) |
| `HOME` | `/home/stage-server/stage-target` | `/root` |
| checkout | `/home/stage-server/rm-stage-target` | the release checkout |
| legacy checkout | `/home/stage-server/rm-stage-legacy` | `/root/robotmoney-frontend` |
| capture checkout | `/home/stage-server/rm-capture`, owned by the release runner, not by the stage target | the same folder on `rm-frontend-stage-2` |
| instance | `stage_target` | `rm_prod` |
| driver tmux session | `stage-driver` | `driver` |
| `RM_ENV` | `stage` | `prod` |

## What it builds

`bun scripts/release/stage-target.ts up --dump <dir>` runs on the control machine.
It copies itself to stage-2 and does the work there over ssh, with stdin closed.
It builds these pieces, in order:

1. **Two checkouts.** The legacy checkout sits at production's legacy commit
   `1cda4085` (v0.5.4). The v0.6.0 checkout sits at `a502de30`. The runner checks
   out the release commit itself.
2. **The database.** One Postgres 18 container, `rm-stage-target-pg`. It listens on
   `172.17.0.1:25060`. Its data lives in the named volume `rm-stage-target-pgdata`.
   It restarts with Docker.
3. **TLS.** The tool makes a self-signed certificate on the host. Every network
   login must use TLS and a password. The container superuser cannot log in over
   the network.
4. **Roles.** The tool reads the roles from the dump's own globals file. It keeps
   every role that is not a superuser, with DigitalOcean's exact attribute line.
   `doadmin` is `LOGIN CREATEROLE CREATEDB`, never a superuser. It holds ADMIN over
   `rm_owner`, `rm_app`, `rm_worker` and `rm_readonly`. `rm_owner` carries
   production's login attribute: `NOLOGIN` before `role-passwords` ever ran on
   production, `LOGIN` after (production, 2026-10-08). The check accepts either. The tool generates every password on the host.
   It holds the `doadmin` password in memory for the checks and then drops it:
   doadmin is stored in no file ([D61](../decisions.md), owner 2026-10-08).
5. **Owners and grants.** The capture carries no owners and no grants. So the tool
   replays production's 76 ledger files in a scratch database. It applies them the
   way the legacy runner did: as `doadmin`, with `SET LOCAL ROLE rm_owner` from 0054
   on. It then runs 0053 alone once more, with the two `rm_readonly` sequence
   grants, as `scripts/ops/provision-db-role-taxonomy.sh` did on production. That
   run is why production's `rm_app` holds UPDATE and DELETE on the analytics ledger
   tables, and why production's legacy boot passes its `analytics-ledger-guard`
   step. It copies the resulting owners, grants and default privileges onto the
   restored copy. It then compares the two line by line and stops on any difference.
6. **The data.** The tool decrypts the dump with the passphrase in the dump
   directory. It restores it with the same pipeline `bun smoke --local dump` uses
   (`restorePipelineArgv` in `scripts/lib/restore-container.ts`).
7. **The checks.** The ledger equals production's 76-name baseline. There is no
   `deployment_identity` table. `rm_owner` cannot log in. `doadmin` is not a
   superuser and holds `CREATEROLE`. Each login role connects over TLS from the
   host. A login without TLS fails. The tool writes no env file until every check
   passes.
8. **`~/.env`.** The file `/home/stage-server/stage-target/.env` has mode 0600. It
   holds production's key names in production's order: `rm_app`, `rm_worker`,
   `rm_readonly`, `SWARM_SCHEDULES_ENABLED`, `host`, `port`, `database`, `sslmode`,
   `OPENCODE_API_KEY`, `COINGECKO_API_KEY`. It has no `rm_owner` line and no
   `doadmin` line: that is production's state before `role-passwords` runs. The
   two model and data keys come from stage-2's own `~/.env`.
9. **The legacy checkout `.env`.** Production's legacy checkout holds a `.env`
   that Bun loads into the legacy driver. The stage copy has the same key names:
   `DATABASE_URL`, `WORKER_DATABASE_URL`, `username`, `password`, `host`, `port`,
   `database`, `sslmode`, `OPENCODE_API_KEY`, `SWARM_SCHEDULES_ENABLED` and
   `MIGRATE_DATABASE_URL` (a working `doadmin` URL, as on production: the v0.5.4
   boot runs its migrations through it). `stage-target doadmin` rotates the stage
   doadmin right after `up`, so that copy goes stale before the release runs.
10. **The legacy stack and its driver.** tmux session `stage-driver` runs
    `$HOME/legacy-launch.sh` in the legacy checkout. The script runs production's
    line: `SMOKE_PROJECT=stage_target bun run smoke:archive -- --no-tui`, piped
    through a timestamp to `$HOME/smoke-archive-v0.5.4.log`. That is the legacy
    `--smoke --static-port --db external` boot. It starts the compose stack and then
    drives sessions itself. The site answers on `:48787`. The compose project is
    `stage_target`. The boot writes `rm-stage-legacy/.agents/smoke-state.json`,
    as production's writes `/root/robotmoney-frontend/.agents/smoke-state.json`.
    `up` checks that the driver process is still running 90 seconds later.

`bun scripts/release/stage-target.ts status` reports each piece.
`bun scripts/release/stage-target.ts down` removes each piece.
`bun scripts/release/stage-target.ts doadmin` gives the stage `doadmin` a fresh
password and prints it, alone, to stdout, for a pipe into `role-passwords`. It
sets the password through the container's local superuser socket and writes it to
no file. It exists only because the stage database is disposable. Production has
no such command: there the admin types the doadmin password.

## How production runs the legacy stack

Read on 2026-10-08 from `rm-frontend-prod-1`, read-only:

- tmux session `driver` holds an interactive bash in `/root/robotmoney-frontend`.
- That bash runs `SMOKE_PROJECT=rm_prod bun run smoke:archive -- --no-tui`, piped
  through a timestamp to `tee /root/smoke-archive-v0.5.4.log`.
- `smoke:archive` is `bun scripts/smoke.ts --smoke --static-port --db external`.
- One process is both the stack's launcher and the host driver.
- The compose project is `rm_prod`. It runs six containers. The site is on `:48787`.
- The legacy smoke reads the database address and the `rm_app` password from
  `/root/.env`. It writes the overlay `.agents/smoke-rm_prod-external-pg.yml`.
- Bun loads `/root/robotmoney-frontend/.env` into the driver. That file supplies
  `WORKER_DATABASE_URL`, `MIGRATE_DATABASE_URL`, `OPENCODE_API_KEY` and
  `SWARM_SCHEDULES_ENABLED=0`.
- The droplet's `/etc/environment` exports `DATABASE_*`, a `doadmin` connection.
- The driver's shell exported `COINGECKO_API_KEY`.

## Rebuild it for each rehearsal

Each rehearsal rebuilds the target. By default it restores the newest production dump
already on stage-2 (`ls -d ~/rm-backup-prod-*`), if it is under 24 hours old (owner, 2026-10-08).
The release's own R2.1 still captures a new backup during the run.

1. Only when no dump on stage-2 is under 24 hours old, capture one. It reads production's replica as `rm_readonly`:

   ```bash
   ssh rm-frontend-stage-2 'cd ~/rm-060 && RM_ENV=stage bun smoke:capture --out ~/rm-backup-prod-$(date -u +%Y%m%dT%H%M%SZ)' </dev/null
   ```

2. Rebuild the target from the control machine:

   ```bash
   bun scripts/release/stage-target.ts up --dump /home/stage-server/rm-backup-prod-<stamp> --replace
   ```

3. Set the role passwords, the same precondition production runs before its release:

   ```bash
   bun scripts/release/stage-target.ts doadmin | bun run role-passwords --target stage --doadmin-stdin
   ```

   It keeps the working runtime lines, makes `rm_owner` LOGIN, generates its
   password and writes the `rm_owner` line into the stage `~/.env`. A rerun keeps
   every role.

4. Read `status`. Then run the release runner against the target.

`up` refuses a dump older than 24 hours. `up` refuses when any piece already exists,
unless `--replace` is given. `--replace` runs `down` first. `down` removes the
container, the volume, the legacy stack, both checkouts (`rm-stage-target` and
`rm-stage-legacy`, with any retired legacy checkout), the tmux session, the
target `HOME` and any v0.6 stack the instance booted. It never touches stage-2's
own `~/.env`, `~/rm-060`, the capture checkout `/home/stage-server/rm-capture`,
other checkouts or the dump directories.

The capture checkout belongs to the release runner, for both targets. Its R1.4
clones it when it is missing. `up` never creates it. `down` refuses to remove it, or
any folder holding it (`removalRefusal` in `stage-target-lib.ts`). See
[the capture checkout convention](release-run.md#capture-checkout-convention).

A full `up` takes about 15 minutes. The restore takes about 3. The legacy image
build takes most of the rest.

## What differs from production, and why

| Difference | Why |
|---|---|
| The certificate is self-signed. | No CA signs a stage container. Production's `~/.env` says `sslmode = require`, which does not verify the certificate either. |
| `host` is `172.17.0.1`, an address, not a hostname. | The containers and the host both reach the bridge address. A user without root cannot add a DNS name. |
| No DigitalOcean pooler, no replica, no `_dodb` or `postgres` superuser. | The release path uses the direct port only. The capture keeps reading production's own replica. The platform superusers belong to DigitalOcean. |
| Per-role settings and extension parameter grants (`pgaudit.*`, `anon.*`) are left out. | Those extensions do not exist in the stock image. |
| Owners and grants come from a replay of the 76 ledger files, then one provisioning run. | The capture is taken with `--no-owner --no-privileges`. The tool never reads production's catalog. It assumes the provisioning script ran after the last ledger file. Any other grant made on production by hand is not reproduced. |
| Extensions are owned by the container superuser. | `pg_restore` creates them. DigitalOcean's are owned by the role that created them. |
| `defaultdb` is owned by `doadmin`. | This is DigitalOcean's default. It was not read from production. |
| `/etc/environment` cannot be written without root. | `legacy-launch.sh` exports the same `DATABASE_*` names from the stage `~/.env` before it starts the driver. An ssh session on stage does not get them. An ssh session on production does. |
| The legacy checkout `.env` has mode 0600. | Production's has 0644. A stage file is not made weaker on purpose. |
| The stage `~/.env` has no `RM_ENV` line. | Production's has none either. The cutover adds it. |
| `legacy-launch.sh` exports an inert `DATABASE_PASSWORD`. | Production's `/etc/environment` holds the real doadmin password. Stage stores doadmin in no file (D61, owner 2026-10-08), so the script draws a random value doadmin does not have. The v0.5.4 driver builds its own container URLs and does not connect with it. |
| `stage-target doadmin` prints a doadmin password. | The stage database is disposable. Production has no such command; its admin types the password at `role-passwords`' hidden prompt. |
| The model key is stage-2's own key. | No production secret leaves production. |
| The container has 1 GB of shared memory and stage-2's 4 CPUs and 7 GB. | Production's managed primary is sized by DigitalOcean. |
