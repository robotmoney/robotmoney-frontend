# Stage target: production's pre-cutover shape on stage-2

> **Authority.** [D61](../decisions.md) rule 2: the production runbook is
> rehearsed unmodified on stage. Only the target file differs.
> Tool: `scripts/release/stage-target.ts`. Pure parts:
> `scripts/release/stage-target-lib.ts`, tested by
> `scripts/tests/unit/stage-target.test.ts`.

## What it is

The stage target is a copy of production as it stands before the next patch. It lives on
`rm-frontend-stage-2`. The release runner runs the production step list against it with
`bun run release:run --target stage`. No step takes a stage-only path.

The tool holds no past-upgrade fact (issue 1272). The tag and commit come from production's
`/api/version`; the ledger comes from the dump itself; the stack is booted the production way
from a checkout at that tag. There is no previous commit, no fixed ledger list and no driver
script in `scripts/release/stage-target-lib.ts`; a unit test keeps the exported constants so.

The target file names these fields:

| Field | Stage target | Production |
|---|---|---|
| host | `rm-frontend-stage-2` (user `stage-server`) | `rm-frontend-prod-1` (user `root`) |
| `HOME` | `/home/stage-server/stage-target` | `/root` |
| checkout | `/home/stage-server/rm-stage-target` | the release checkout |
| running checkout (built by `up`, not a target field) | `/home/stage-server/rm-stage-running` at the tag production reports | the previous release's checkout, whatever `/api/version` reports |
| capture checkout | `/home/stage-server/rm-capture`, owned by the release runner, not by the stage target | the same folder on `rm-frontend-stage-2` |
| instance | `stage_target` | `rm_prod` |
| `RM_ENV` | `stage` | `prod` |

## What it builds

`bun scripts/release/stage-target.ts up --dump <dir>` runs on the control machine.
It copies itself to stage-2 and does the work there over ssh, with stdin closed.
It builds these pieces, in order:

1. **What production runs.** It reads `https://robotmoney.network/api/version` (the
   prod target file's `publicOrigin`) and takes the commit and, when the boot carried one,
   the tag. A body with `+dirty` or `+unknown` refuses.
2. **The running checkout.** `rm-stage-running`, detached at that tag (else that commit),
   with `bun install` in root and backend. It never creates the release checkout:
   R1.1 clones that one.
3. **The database.** One Postgres 18 container, `rm-stage-target-pg`. It listens on
   `172.17.0.1:25060`. Its data lives in the named volume `rm-stage-target-pgdata`.
   It restarts with Docker.
4. **TLS.** The tool makes a self-signed certificate on the host. Every network
   login must use TLS and a password. The container superuser cannot log in over
   the network.
5. **Roles.** The tool reads the roles from the dump's own globals file. It keeps
   every role that is not a superuser, with DigitalOcean's exact attribute line.
   `doadmin` is `LOGIN CREATEROLE CREATEDB`, never a superuser. It holds ADMIN over
   `rm_owner`, `rm_app`, `rm_worker` and `rm_readonly`. `rm_owner` carries
   production's login attribute. The tool generates every password on the host.
   It holds the `doadmin` password in memory for the checks and then drops it:
   doadmin is stored in no file ([D61](../decisions.md), owner 2026-10-08).
6. **The data.** The tool decrypts the dump with the passphrase in the dump
   directory. It restores it with the same pipeline `bun smoke --local dump` uses
   (`restorePipelineArgv` in `scripts/lib/restore-container.ts`). Then it reads the
   restored `schema_migrations` back, in applied order: that list is the dump's own
   ledger, and the only ledger the tool knows.
7. **Owners and grants.** The capture carries no owners and no grants. So the tool
   replays exactly the dump's ledger, in the dump's order, from the running checkout's
   `backend/migrations` in a scratch database, the way the migrate applied them: as
   `doadmin`, with `SET LOCAL ROLE rm_owner` from 0054 on (0053 created the role), then
   `backend/schema/grants.sql` as the migrate reconciles it. A ledger name the running
   checkout lacks refuses (`upPlan` in `stage-target-lib.ts`). It copies the resulting
   owners, grants and default privileges onto the restored copy, compares the two line by
   line and stops on any difference. The identity row is enrolled `rehearsal`.
8. **The checks.** The ledger equals what the replay applied. The `deployment_identity`
   table exists. `doadmin` is not a superuser and holds `CREATEROLE`. Each login role
   connects over TLS from the host. A login without TLS fails. The tool writes no env
   file until every check passes.
9. **`~/.env`.** The file `/home/stage-server/stage-target/.env` has mode 0600. It
   holds production's key names in production's order: `rm_app`, `rm_worker`,
   `rm_readonly`, `SWARM_SCHEDULES_ENABLED`, `host`, `port`, `database`, `sslmode`,
   `OPENCODE_API_KEY`, `COINGECKO_API_KEY`, plus the `rm_owner` line production's
   `role-passwords` wrote. The two model and data keys come from stage-2's own `~/.env`.
10. **The stack.** From the running checkout, under `env -i` with the stage `HOME`, the
    production boot sequence: the credential file for the in-house members
    (`scripts/release/credentials-init.ts`, fresh stage keys, `RM_CREDENTIALS` appended
    to `~/.env`), the env rewrite, the service tokens, `bun smoke --static-port --instance
    stage_target`, the rebind of the in-house members onto the stage keys (the dump holds
    production's), and a second boot. Docker keeps the stack running, as on production.
    The boot writes the instance's smoke state under `HOME`, which the release's rolling boot
    (R6.7a) replaces one service at a time.
    The site answers on `:48787`, and `/api/version` reports the tag and commit.

`bun scripts/release/stage-target.ts status` reports each piece.
`bun scripts/release/stage-target.ts down` removes each piece.
`bun scripts/release/stage-target.ts doadmin` gives the stage `doadmin` a fresh
password and prints it, alone, to stdout, for a pipe into `role-passwords`. It
sets the password through the container's local superuser socket and writes it to
no file. It exists only because the stage database is disposable. Production has
no such command: there the admin types the doadmin password.

## How production runs its stack

Since the v0.6.0 cutover (2026-10-08) production's stack is the one `bun smoke --static-port
--instance rm_prod` booted from the release checkout of the running version, with `HOME=/root`.
Docker keeps it running. Its smoke state lives under `/root/.local/state/robotmoney-smoke/rm_prod/`;
A release never stops it: R6.7a replaces its services one at a time and keeps website-server up
(release policy §4.7).
`/api/version` reports the commit and, for a boot at a tag, the tag. No tmux session drives it.

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
unless `--replace` is given. `--replace` runs `down` first. `down` stops the instance's
stack with `bun smoke:down`, then removes its containers, networks, volumes and images, the
Postgres container, the volume, the running checkout `rm-stage-running`, the release checkout
`rm-stage-target` and the target `HOME`. It never touches stage-2's own `~/.env`, `~/rm-060`,
the capture checkout `/home/stage-server/rm-capture`, other checkouts or the dump directories.

The capture checkout belongs to the release runner, for both targets. Its R1.4
clones it when it is missing. `up` never creates it. `down` refuses to remove it, or
any folder holding it (`removalRefusal` in `stage-target-lib.ts`). See
the capture checkout convention (`CAPTURE_CHECKOUT` in `scripts/release/target.ts`).

A full `up` takes about 15 minutes. The restore takes about 3. The image build and the
two boots take most of the rest.

## What differs from production, and why

| Difference | Why |
|---|---|
| The certificate is self-signed. | No CA signs a stage container. Production's `~/.env` says `sslmode = require`, which does not verify the certificate either. |
| `host` is `172.17.0.1`, an address, not a hostname. | The containers and the host both reach the bridge address. A user without root cannot add a DNS name. |
| No DigitalOcean pooler, no replica, no `_dodb` or `postgres` superuser. | The release path uses the direct port only. The capture keeps reading production's own replica. The platform superusers belong to DigitalOcean. |
| Per-role settings and extension parameter grants (`pgaudit.*`, `anon.*`) are left out. | Those extensions do not exist in the stock image. |
| Owners and grants come from a replay of the dump's ledger, then the grants reconcile. | The capture is taken with `--no-owner --no-privileges`. The tool never reads production's catalog. The migrate reconciles `grants.sql` at the end of every run, so the replay ends the same way. Any grant made on production by hand is not reproduced. |
| Extensions are owned by the container superuser. | `pg_restore` creates them. DigitalOcean's are owned by the role that created them. |
| `defaultdb` is owned by `doadmin`. | This is DigitalOcean's default. It was not read from production. |
| `/etc/environment` cannot be written without root. | Production's exports a `doadmin` `DATABASE_URL`; stage's exports nothing. Every release step runs under `env -i`, so neither host's login environment reaches a command. |
| The in-house members run on stage keys. | The dump holds production's member keys; `up` writes a fresh credential file and rebinds the in-house members onto it, so the stage agents can file. |
| `stage-target doadmin` prints a doadmin password. | The stage database is disposable. Production has no such command; its admin types the password at `role-passwords`' hidden prompt. |
| The model key is stage-2's own key. | No production secret leaves production. |
| The container has 1 GB of shared memory and stage-2's 4 CPUs and 7 GB. | Production's managed primary is sized by DigitalOcean. |
