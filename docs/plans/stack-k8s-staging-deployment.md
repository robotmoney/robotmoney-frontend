# Deployment plan — `stack` on Kubernetes, staging first

Standing up a professional deployment environment for robotmoney using
[bozemanpass/stack](https://github.com/bozemanpass/stack), targeting Kubernetes,
with Postgres owned by the deployment and backed up by stack's restic/K8up path.

**Scope decisions taken (2026-08-20):**

| Fork | Decision |
|---|---|
| Target | Kubernetes — `stack init --deploy-to k8s` |
| Reach | **Staging only, in parallel.** Production stays on the current SSH + `docker compose up -d` path until staging has run several releases |
| Postgres | **stack owns it** — in-deployment, on a PVC, backed up via K8up/restic |

Companion to [`../runbooks/deployment.md`](../runbooks/deployment.md) (the
standing credential + topology reference, which this plan does **not** replace)
and [`../architecture.md`](../architecture.md).

---

## 0. Naming — two things are called "stack"

`scripts/stack/` is **ours**: the compose bring-up behind `bun run demo`
(`stack.ts`, `ports.ts`, `config.ts`). bozemanpass `stack` is the **tool** this
plan adopts. They are unrelated and both will exist in this repo.

Convention for this work: the tool is always written as **`stack(bp)`** in prose
and invoked as `stack` only inside fenced commands. Our module is always
`scripts/stack/`. Do not rename either — renaming `scripts/stack/` touches the
port-policy tests, the demo TUI, and the lifecycle-order test for no benefit.

---

## 1. Why this is worth doing

The current staging deploy is `ssh droplet && docker compose pull && docker
compose up -d` (`deployment.md` §4.4). It works, and it has three properties we
would rather not keep:

- **The deploy is a shell verb, not an artifact.** There is no versioned object
  describing what staging *is*. Recreating staging means replaying a runbook.
- **No rollback primitive.** Rollback is "pull the old tag and hope the
  migrations were backward-compatible."
- **Backups are unowned.** `pgdata` on a droplet has no snapshot story of its
  own; the managed-PG story in §4.3 only covers boxes that use managed PG.

`stack(bp)` gives us a **spec file** (the artifact), a **deployment directory**
(the instance), and `backup restore` (the recovery primitive) — and the k8s
target adds rolling restarts and cert-manager TLS, which retires the
cloudflared tunnel + pinned-48787 arrangement entirely.

---

## 2. The gap — what does not survive the move to k8s

This is the real work. Our `docker-compose.yml` is written as a *single-box
compose* file and says so in its header. Several of its load-bearing choices are
compose-only.

| Today | On k8s | Work |
|---|---|---|
| `./_static:/srv/frontend:ro` bind mount | **No bind mounts.** Volume-name-contains-`config` → ConfigMap, but `_static` is the whole SPA + assets — far past the 1MB ConfigMap limit | **Bake `_static` into the api image.** §3.1 |
| docker `secrets:` → `/run/secrets/analytics_token` | stack(bp) secrets are **env vars** | Drop the file secret; use `ANALYTICS_TOKEN`. The producer already accepts either — `backend/src/producer/index.ts:23` requires "`ANALYTICS_TOKEN` **or** a non-empty `ANALYTICS_TOKEN_FILE`" |
| `ports: - "8787"` (Docker picks the host port) | Ports are cluster-internal; ingress fronts them | The entire `ports.ts` random-port doctrine becomes **moot in prod**. It stays load-bearing for `bun run demo` |
| `docker-compose.stage.yml` `!override` pin to 48787 + cloudflared | Ingress + cert-manager | Stage overlay and the tunnel are **not carried over**. Keep the file — it still serves `bun run demo -- --stage` |
| `depends_on: condition: service_healthy` | No k8s equivalent | api/workers must tolerate Postgres being briefly absent. CrashLoopBackOff covers it, but see §5 for why migration ordering can't rely on it |
| `healthcheck:` blocks (api `bun -e fetch /health`; workers `src/ops/healthcheck.ts`) | Should become liveness/readiness probes | **Translation is undocumented** in stack(bp)'s k8s notes — Phase 0 verifies whether `init` emits probes or drops them. If dropped, declare probes in the spec |
| YAML anchors (`*worker-base`, `*worker-env`, `*default-logging`) | Fine — anchors expand at parse time | No work |
| `logging: json-file 10m×3` | Ignored; cluster log rotation applies | Drop from the k8s pod composefile |
| `restart: unless-stopped` | Default `Always` | No work |

**One more, easy to miss:** `postgres:17-alpine` is pinned to 17 *deliberately*,
because it owns a persistent data directory the demo resumes across boots. Prod
parity is 18.6 (DO Managed). Staging under this plan runs **stack-owned**
Postgres — so pin it to the major staging should rehearse, decide that once, and
write the reason next to the pin. A later major bump is a dump-and-restore, not
a string edit.

---

## 3. Target shape

### 3.1 Images

Two images, both built by `stack prepare` from `backend/Dockerfile`:

- **`robotmoney/api`** — must now contain `_static`. Add to the Dockerfile,
  after the source copy:

  ```dockerfile
  COPY frontend/ /app/frontend/
  COPY scripts/prerender.ts scripts/static-assembly.sh /app/scripts/
  RUN bun scripts/static-assembly.sh /srv/frontend
  ENV STATIC_DIR=/srv/frontend
  ```

  The build context is already the repo root, and the base is `oven/bun`, so
  the assembly runs in-build with no new toolchain. This makes the image
  self-describing: a running api can no longer be serving stale prerendered
  HTML from a host directory nobody re-assembled. **That is a genuine
  improvement over the bind mount**, independent of k8s.

  Consequence: `docs/runbooks/deployment.md` §2.1's "a hand-run `docker compose
  up -d` must run `bun run static:assemble` first" stays true for the compose
  path and becomes false for the k8s path. Say so in both places.

- **`robotmoney/worker`** — same Dockerfile, no `_static` layer needed. Can be
  the same image with a different command; keep it one image unless the static
  layer's size becomes a push-time problem.

Registry: **DO Container Registry**, `--image-registry registry.digitalocean.com/robotmoney`.
`DO_API_TOKEN` already authenticates `doctl registry login` (§4.1).

### 3.2 Stack definition — in-repo

```
stacks/robotmoney/
  stack.yml
  pods/
    data/composefile.yml        # postgres
    app/composefile.yml         # api
    workers/composefile.yml     # 3 lanes + analytics-producer
```

**Three pods, not one.** The split is the exit door: when production eventually
moves, the `data` pod is simply not deployed and `DATABASE_URL` points at the
managed HA cluster. Same stack definition, different spec. One monolithic pod
would make that a rewrite.

```yaml
name: robotmoney
description: "Robot Money — API, worker lanes, analytics producer, Postgres"

containers:
  - name: robotmoney/api
    path: ./backend          # content-root is the repo root (Dockerfile needs contract/)
  - name: robotmoney/worker
    path: ./backend

pods:
  - name: data
    path: ./pods/data
  - name: app
    path: ./pods/app
  - name: workers
    path: ./pods/workers

secrets:
  POSTGRES_PASSWORD:                 # generated
  ADMIN_TOKEN:                       # generated
  AUTOMATION_TOKEN:                  # generated
  ANALYTICS_TOKEN:                   # generated
  OPENCODE_API_KEY:
    external: true
  FRED_API_KEY:
    external: true
  BASE_RPC_URL:
    external: true
```

Generated-vs-external is the meaningful line: anything whose counterpart lives
outside the deployment (a vendor key) is `external: true` and supplied at init
with `--secret NAME=env:CI_VAR`. Everything else stack(bp) generates per
deployment, which is strictly better than today's hand-set `ADMIN_TOKEN`.

### 3.3 Cluster prerequisites

stack(bp) **emits** resources for these; it does not install them. A
backup-enabled deploy to a cluster without K8up "fails recognizably at deploy
time." Provision on the DOKS cluster before Phase 2:

- ingress-nginx (or Gateway API)
- cert-manager + a ClusterIssuer (`--http-proxy-clusterissuer`)
- **K8up** — required by the backup decision
- `do-block-storage` default StorageClass (DOKS default; confirm)

---

## 4. Backups — the reason stack-owned Postgres is defensible

File-copying a live Postgres data directory produces unrestorable snapshots.
stack(bp)'s answer is a **logical dump command whose stdout *is* the artifact**,
annotated in the composefile:

```yaml
services:
  postgres:
    volumes:
      - "pgdata:/var/lib/postgresql/data"   # @stack backup-exclude
    # @stack backup-command pg_dump -U robotmoney -d robotmoney --clean --if-exists
    # @stack backup-file-extension sql
```

`backup-exclude` on the volume is **not optional** — without it K8up also
file-copies the live data dir and the repository grows a snapshot that looks
restorable and is not.

Configuration (ambient, set once per environment): `backup=true`,
`backup-s3-endpoint`/`-bucket`/`-key-id`/`-key` → **DO Spaces** (we already
issue Spaces keys in §4.2), `backup-restic-password`, default schedule
`0 3 * * *`, retention `--keep-daily 7 --keep-weekly 4 --keep-monthly 6`.

> **The restic password cannot be ephemeral.** Lose it and every encrypted
> snapshot is permanently unrecoverable. It goes in the escrow path *before*
> the first backup runs, not after. This is the single highest-consequence
> item in the plan.

Operationally: `stack manage --dir <d> backup now | list | restore`. Restore is
**not** orchestrated — stopping the deployment first is the operator's job, and
restoring onto live volumes corrupts data. Phase 3 writes that as a runbook with
the stop/restore/start sequence spelled out, because the tool will not enforce
it.

Repositories are interchangeable between compose and k8s targets, which is what
makes a later prod-on-compose or prod-on-k8s decision reversible.

---

## 5. Migrations — the open design question

Today: a **one-shot container** runs `bun run src/db/migrate.ts`
(`scripts/stack/config.ts:289`), gated by a refuse-hook that can abort the boot
before anything is written, ordered before services start.

k8s has no clean equivalent, and stack(bp)'s pod `pre_start_command` /
`post_start_command` are **shell scripts run by the deployer**, not in-cluster
steps — a `pre_start_command` on the CI runner cannot reach a Postgres that
lives on a cluster-internal Service. Three options:

1. **`post_start_command` that execs into the api pod** — closest to today's
   separation; keeps the refuse-hook meaningful. Needs `kubectl` on the runner
   and pod-readiness handling in a shell script.
2. **Migrate-on-start in the api entrypoint**, guarded by a Postgres advisory
   lock so concurrent replicas serialize. Simplest and k8s-idiomatic; **loses
   the pre-write abort gate**, which the v0.2.2 rollout leaned on.
3. **A k8s Job** emitted alongside the deployment — the textbook answer, but
   there is no documented way to make stack(bp) emit one, so it means an
   out-of-band `kubectl apply` and the deploy stops being one artifact.

**Recommendation: (1) for staging**, because it preserves the abort gate that
`v0-2-2-rollout.md`'s go/no-go depends on, and staging is where we find out
whether the exec dance is tolerable. Revisit before any production cutover.

This is the item most likely to change the plan's shape. It should be settled by
a spike in Phase 0, not by argument.

---

## 6. Ingress & TLS

Routes are declared as **comment annotations in the composefile**, which `init`
parses:

```yaml
    ports:
      - "8787"   # @stack http-proxy /
```

Then `stack init --http-proxy-fqdn swarm.staging.robotmoney.net
--http-proxy-clusterissuer letsencrypt`. cert-manager issues the certificate;
the Cloudflare **Origin CA cert** (§3.4) and the pinned-port tunnel are both
retired on this path. Cloudflare keeps its D13 role — DNS + health checks —
unchanged.

Only `api` is exposed. Postgres and every worker stay cluster-internal;
`analytics-producer` reaches the API at `http://api:8787` over Service DNS, which
works unchanged.

---

## 7. Phasing

Each phase has an exit gate. Do not start the next phase until the gate is green.

**Phase 0 — spikes (no CI, no cluster changes).** Answer the three unknowns:
does `stack init` emit probes from our `healthcheck:` blocks; does the migration
exec path (§5) work; does the `_static`-baked image build and serve prerendered
HTML. Run against a local `k8s-kind` target, which stack(bp) supports and which
costs nothing.
*Gate: all three answered in writing, §5 decided.*

**Phase 1 — definition + image.** Land `stacks/robotmoney/`, the Dockerfile
static layer, and the compose→k8s deltas from §2. `stack validate` and
`stack check` pass. Nothing deploys.
*Gate: `bun run demo` still green — the compose path must not regress, since
`_static` now exists both baked and bind-mounted.*

**Phase 2 — staging cluster, manual.** Provision DOKS + the four prerequisites
(§3.3). Deploy by hand from a workstation. Prove: ingress + TLS, secrets
delivery, migrations, `backup now`, and a **real restore into a scratch
deployment** — the backup is not proven until something has been restored from
it.
*Gate: staging serves over TLS at its FQDN, and a restore has been performed.*

**Phase 3 — CI + runbook.** GitHub Actions job on merge to `dev`:
`prepare → push-images → manage update`. Kubeconfig via `--kube-config
env:KUBECONFIG_DATA` from a GitHub Environment secret. Write the
stop/restore/start runbook (§4) and the rollback procedure.
*Gate: three consecutive releases deploy through CI with no manual step.*

**Phase 4 — soak.** Staging runs on stack(bp) for several release cycles.
Production is untouched throughout. A production cutover is a **separate plan**
written after this one has evidence.

---

## 8. Risks and accepted tradeoffs

- **Staging stops rehearsing production's data path.** This is the direct cost of
  the stack-owned-Postgres decision: prod is DO Managed HA (`sslmode=require`,
  port 25060, PgBouncer pool URI). Staging on an in-cluster PVC exercises none
  of that. **Mitigation:** keep a second spec variant that supplies
  `DATABASE_URL` as an external secret and omits the `data` pod — the §3.2 pod
  split exists precisely so this is a spec change, not a rewrite. Run it
  periodically against the staging managed instance.
- **Migration abort gate may weaken** (§5). Consequential because
  `v0-2-2-rollout.md`'s go/no-go gates assume it.
- **Two "stacks" in one repo** (§0) — a documentation hazard more than a
  technical one.
- **Restic password loss = total backup loss** (§4). Escrow before first backup.
- **Undocumented k8s translation surface.** stack(bp)'s k8s notes cover node
  affinity and RuntimeClass; they do **not** document probes, `depends_on`,
  restart policy, resource limits, or replicas. Phase 0 exists to convert those
  unknowns into facts rather than discovering them during a deploy.
- **Do not overlap with the v0.2.2 production rollout.** Changing the deploy
  mechanism and executing a gated production upgrade in the same window is how
  both go wrong.

## 9. Explicitly not in scope

- Any production change. Prod stays on SSH + compose.
- Retiring `scripts/stack/` or changing `bun run demo`.
- Moving the marketing static tier off its current path (D13's Spaces CDN
  end-state is unaffected).
- Horizontal scaling or HPA — one replica per service until there is a reason.
