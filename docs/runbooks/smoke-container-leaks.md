# Runbook — leaked smoke/CI containers on the shared host

The host that serves `stage.robotmoney-labs.dev` is also the self-hosted GitHub
Actions runner and the box operators run local evals on. Four families spawn
containers on it (`scripts/stack/naming.ts`): the smoke **stack**, the onboarding
**eval**, the rails-check **infra** test, and the backend suite's **pgtest**
postgres. A container that outlives the job that started it holds host ports and
compose networks, and on this host that is a live-site outage.

## Symptom → first move

| Symptom | First move |
|---|---|
| `stage.robotmoney-labs.dev` 502s, or `bun run smoke -- --static-port` refuses to start because `:48787` is held | `docker ps --filter publish=48787` — read the container's `robotmoney.env` label |
| A CI teardown step failed with `TEARDOWN INCOMPLETE` | run the three commands that step printed, in order |
| `docker ps -a` shows old `rm_ci_*` containers | `bun run smoke:reap -- --env-class ci --dry-run` |

**Read the label, not the name.** `robotmoney.env=local` means the standing stage
smoke or an operator's shell — never sweep it from CI. `robotmoney.env=ci` means a
CI run; anything of that class older than one job's ceiling (105 min) is a leak.

```bash
docker ps -a --filter label=robotmoney.env=ci \
  --format '{{.Names}}\t{{.CreatedAt}}\t{{.Status}}\t{{.Label "robotmoney.smoke.project"}}'
```

## Clearing one known project

Strictly scoped; safe to run while the standing smoke is up.

```bash
docker compose -p <project> -f docker-compose.yml -f docker-compose.smoke.yml \
  down -v --remove-orphans           # WEB_PORT/POSTGRES_PORT below are interpolation-only
bun run scripts/smoke-clean.ts --project <project>
```

`docker-compose.yml`'s port lines are `${WEB_PORT:?…}` / `${POSTGRES_PORT:?…}`, so
compose refuses to resolve without values. `down` publishes nothing, so any
values will do: `WEB_PORT=1 POSTGRES_PORT=1 docker compose …`.

## Sweeping everything stale

```bash
bun run smoke:reap -- --dry-run                     # ALWAYS first: reads only, mutates nothing
bun run smoke:reap -- --env-class ci --dry-run      # CI leftovers only
bun run smoke:reap -- --older-than 30m --dry-run    # widen the window, still read-only
bun run smoke:reap                                   # apply (default: all classes, older than 6h)
```

The reaper selects by the `robotmoney.env` / `robotmoney.env.hash` **labels**,
never by name substring — a name glob on this host is how the live site gets
taken down. Three guards refuse to act (`scripts/lib/smoke-reap.ts`; asserted in
`scripts/tests/unit/smoke-reap.test.ts`):

- **G1** the project named in `.agents/smoke-state.json` is never touched.
- **G2** a non-CI project with a running container that is healthcheck-healthy or
  publishing a host port is never touched, at any age. This exists because G1's
  state file **goes stale** — on 2026-07-29 it named a dead project while a
  different stack served `:48787`.
- **G3** under Actions, this job's own `robotmoney.env.hash` is never touched.

G2 deliberately does **not** exempt `robotmoney.env=ci`: no CI job outlives the
threshold, so a still-healthy CI stack past it *is* the leak. Every removal and
every refusal is printed with its reason.

Never reach for `docker system prune`, `docker container prune`, or a name glob
on this host. They cannot tell the standing smoke from a CI orphan.

## Never do this while the stage smoke is up

- `docker compose down` with no `-p` (adopts whatever project the cwd implies).
- `docker rm -f $(docker ps -aq)`.
- `docker volume prune`, `docker network prune`, `docker system prune -a`.

## Why the CI teardown looks the way it does

e2e run **30406428674** was cancelled mid-boot. Its in-process
`docker compose down` never ran, so the stack survived; the `if: always()`
backstop of the day ran `smoke:clean` **alone**, which removes volumes only. It
found the pgdata volume still referenced by a live container, printed
`SKIPPED 1 volume(s)` — and **exited 0**. The step reported success over a live
leak, and the surviving api container held `:48787` for over an hour. Nothing
reaped prior runs' orphans either, so the host had accumulated containers up to
four days old.

Three fixes, in `.github/workflows/e2e.yml` (they were also in
`swarm-opencode-nightly.yml`, which issue #373 retired — `e2e.yml` now
carries that workflow's nightly slot as well as its push-to-`main` run):

1. the always() step runs `docker compose -p "$SMOKE_PROJECT" down -v
   --remove-orphans` **before** `smoke:clean`;
2. `smoke:clean --project` **exits non-zero** on any surviving resource (bare
   `bun run smoke:clean` still exits 0 — a running smoke is not an error);
3. an always() `smoke:reap --env-class ci --older-than 6h` step clears prior runs'
   orphans, non-blocking.

See `docs/architecture.md` §"Smoke Specification" (c) for the normative version.
