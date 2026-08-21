# Deployment plan — `stack` on Kubernetes, staging first

> **Status: future-infrastructure proposal, not adopted.** `stack` is under
> evaluation for how deployment might work at some point in the future. Nothing
> in production uses it today, and no accepted decision in
> [`decisions.md`](../decisions.md) stands behind it. Current production
> procedure is [`docs/runbooks/rollout-procedure.md`](../runbooks/rollout-procedure.md)
> plus the release's own runbook. Read this as design work, not as instructions.


Standing up a professional deployment environment for robotmoney using
[bozemanpass/stack](https://github.com/bozemanpass/stack), targeting Kubernetes,
with Postgres owned by the deployment and backed up through K8up/restic.

**Scope decisions taken (2026-08-20):**

| Fork | Decision |
|---|---|
| Target | Kubernetes — `stack init --deploy-to k8s` |
| Reach | **Staging only, in parallel.** Production stays on the current SSH + `docker compose up -d` path until staging has run several releases |
| Postgres | **stack owns it** — in-deployment, on a PVC, backed up via K8up/restic |

**Status: verified by spike, not yet implemented.** A working deployment of this
app was driven onto a local k3s cluster — six pods, `/health` returning
`{"status":"ok","db":"up"}` — so the behaviour this plan relies on is observed
rather than assumed. **That spike definition was deliberately not merged**: it
carried the container-naming and env-forwarding mistakes the field guide
documents, and shipping a known-wrong definition to `main` would be an
attractive nuisance. Phase 1 authors the corrected one.

Three companions, each with a distinct job:

| Document | Job |
|---|---|
| [`../technical/stack-orchestrator.md`](../technical/stack-orchestrator.md) | **Field guide** — how the tool behaves. Mechanism lives there, not here. |
| [`../technical/stack-runbook-reconciliation.md`](../technical/stack-runbook-reconciliation.md) | **Policy bridge** — how this platform meets the release-runbook policy. |
| [`../runbooks/deployment.md`](../runbooks/deployment.md) | **Standing reference** — credentials and topology. This plan does not replace it. |

---

## 0. Naming — two things are called "stack"

`scripts/stack/` is **ours**: the compose bring-up behind `bun run demo`
(`stack.ts`, `ports.ts`, `config.ts`). bozemanpass `stack` is the **tool** this
plan adopts. They are unrelated and both will exist in this repo.

Convention: the tool is written **`stack(bp)`** in prose and invoked as `stack`
only inside fenced commands. Ours is always `scripts/stack/`. Do not rename
either — renaming `scripts/stack/` touches the port-policy tests, the demo TUI
and the lifecycle-order test for no benefit.

---

## 1. Why this is worth doing

The current staging deploy is `ssh droplet && docker compose pull && docker
compose up -d` (`deployment.md` §4.4). It works, and it has three properties we
would rather not keep:

- **The deploy is a shell verb, not an artifact.** Nothing describes what staging
  *is*. Recreating it means replaying a runbook.
- **No rollback primitive.** Rollback is "pull the old tag and hope the
  migrations were backward-compatible."
- **Backups are unowned.** `pgdata` on a droplet has no snapshot story of its
  own.

stack(bp) answers all three: a **spec file** is the artifact, a **deployment
directory** is the instance, `backup restore` is the recovery primitive, and
**commit-addressed published images** (field guide §19) make code rollback a
pointer change rather than a rebuild. The k8s target adds rolling restarts and
cert-manager TLS, retiring the cloudflared tunnel and the pinned-48787
arrangement entirely.

---

## 2. The gap — what does not survive the move to k8s

Our `docker-compose.yml` is written as a *single-box compose* file and says so in
its header. Several of its load-bearing choices are compose-only. Every row below
is verified; the field-guide section carries the evidence.

| Today | On k8s | Work | Ref |
|---|---|---|---|
| No `API_PORT` set, deliberately | k8s injects `API_PORT=tcp://…` as a **service-link variable**; `Number(…)` yields `NaN`; the api binds a random port and reports `1/1 Running` while nothing routes | **Set `API_PORT: "8787"` explicitly**, and guard `config.ts` with `Number.isFinite` | §10 |
| `DATABASE_URL` assembled in YAML | `${SECRET}` in `environment:` renders **empty** — secrets arrive later as `secretKeyRef` | Assemble the URL in `command:` at container start | §11 |
| `./_static:/srv/frontend:ro` bind mount | No bind mounts; far past the ConfigMap limit | **Bake `_static` into the api image** (§3.1) | §15 |
| docker `secrets:` → `/run/secrets/analytics_token` | stack(bp) secrets are env vars | Drop the file secret; `producer/index.ts:23` already accepts `ANALYTICS_TOKEN` | §6 |
| `RM_ENV` per environment | No `staging` value exists — `config.ts:539` throws | Staging runs **`RM_ENV=prod`** semantics, `PROJECTS_SOURCE=live` included | §16 |
| Inline `environment:` literals | Inline literals **beat** `--config` | Forward operator-facing values as `${VAR}`, don't default them | §5 |
| `healthcheck:` blocks | Become a **livenessProbe only** — no readiness, no startup probe | Decide whether liveness-only is acceptable | §12 |
| `ports: - "8787"` (Docker picks the host port) | Cluster-internal; ingress fronts them. A port is *not* needed for service DNS | Drop the stray `postgres` publish; `ports.ts` doctrine is moot in prod but stays load-bearing for `bun run demo` | §5 |
| `docker-compose.stage.yml` `!override` + cloudflared | Gateway API + cert-manager | Not carried over. Keep the file — it still serves `bun run demo -- --stage` | §22 |
| `depends_on: condition: service_healthy` | No equivalent; dropped | api/workers crash-loop until Postgres answers. Noisy but works — migrations must not rely on it | §12 |
| YAML anchors | Expand at parse time | No work | — |
| `logging: json-file 10m×3` | Ignored; cluster rotation applies | Drop from the k8s composefile | — |
| `restart: unless-stopped` | Default `Always` | No work | — |

**One more, easy to miss:** `postgres:17-alpine` is pinned to 17 *deliberately*,
because it owns a persistent data directory the demo resumes across boots. Prod
parity is 18.6 (DO Managed). Staging under this plan runs **stack-owned**
Postgres — so pin it to the major staging should rehearse, decide that once, and
write the reason beside the pin. A later major bump is a dump-and-restore, not a
string edit.

---

## 3. Target shape

### 3.1 One image, published to ghcr, commit-addressed

**One image, not two.** The api and every worker lane run the same image and
differ only by `command:`, exactly as `docker-compose.yml` already has it.

**Name it `robotmoney/robotmoney-api`.** The namespace is the registry namespace
(our GitHub org); the name half must be project-specific, because the namespace
is shared by every repo in the org. `robotmoney/api` — what the spike used — is
the named anti-pattern, and nothing objected to it (field guide §4).

**It must contain `_static`.** Add to `backend/Dockerfile` after the source copy:

```dockerfile
COPY frontend/ /app/frontend/
COPY scripts/prerender.ts scripts/static-assembly.sh /app/scripts/
RUN bun scripts/static-assembly.sh /srv/frontend
ENV STATIC_DIR=/srv/frontend
```

The build context is already the repo root and the base is `oven/bun`, so the
assembly runs in-build with no new toolchain. This makes the image
self-describing: a running api can no longer serve stale prerendered HTML from a
host directory nobody re-assembled. **A genuine improvement over the bind mount,
independent of Kubernetes.**

Consequence: `deployment.md` §2.1's "a hand-run `docker compose up -d` must run
`bun run static:assemble` first" stays true for compose and becomes false for
k8s. Say so in both places.

**Registry: `ghcr.io`, not DO Container Registry.** This reverses the plan's
original choice. Discovery is automatic only when the registry matches the git
host: `github.com` → `ghcr.io`, with the tag being the recipe repo's commit hash
(field guide §19). That buys immutable, commit-addressed images with no
configuration on the deploying side and no per-release composefile edit. DO CR
would work but forfeits all of it, and `GITHUB_TOKEN` already authenticates
ghcr in Actions.

Production hosts deploy with **`--build-policy prebuilt-remote`**, which fails
rather than silently building from source.

### 3.2 Stack definition — in-repo

```
stacks/robotmoney/
  stack.yml
  containers/api/
    container.yml            # names the build recipe
    build.sh                 # repo-root build context, backend/Dockerfile
  pods/
    data/composefile.yml     # postgres
    app/composefile.yml      # api
    workers/composefile.yml  # 3 lanes + analytics-producer
```

**Three pods, not one.** The split is the exit door: when production eventually
moves, the `data` pod is simply not deployed and `DATABASE_URL` points at the
managed HA cluster. Same definition, different spec. One monolithic pod would
make that a rewrite.

**`container.yml` is required**, because `build:` is not a `stack.yml` field and
is silently ignored there (field guide §2). **All `path` values are
repo-root-relative** (§1).

```yaml
name: robotmoney
description: "Robot Money — API, worker lanes, analytics producer, Postgres"

containers:
  - name: robotmoney/robotmoney-api
    path: ./stacks/robotmoney/containers/api

pods:
  - name: data
    path: ./stacks/robotmoney/pods/data
  - name: app
    path: ./stacks/robotmoney/pods/app
  - name: workers
    path: ./stacks/robotmoney/pods/workers

secrets:
  POSTGRES_PASSWORD:                 # generated
  ADMIN_TOKEN:                       # generated — but see reconciliation §4.4
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
outside the deployment is `external: true` and supplied at init with
`--secret NAME=env:CI_VAR`. Whether the four generated ones *should* be generated
here or stay owned by the credential doctor is an open decision — reconciliation
§4.4.

Postgres needs **no `containers:` entry**: off-the-shelf images are referenced
directly and digest-locked into `stack.lock`.

### 3.3 The cluster comes provisioned, not hand-assembled

stack(bp) emits ingress and backup resources; it does not install the controllers
they need. `stirlingbridge/machine-provisioning`'s `scripts/k3s-node.sh` installs
k3s together with **cert-manager** and both Let's Encrypt ClusterIssuers,
**K8up**, and **the Gateway API** with a Gateway named `stack-gateway` in
`kube-system` (field guide §22).

That collapses what this plan originally listed as four manual prerequisites into
one provisioning step, and it is why our ad-hoc cluster returns a bare `404` from
`start`: the CRDs exist, but no Gateway does.

Decide once: **DOKS, or a provisioned VM.** The `machine` → `machine-provisioning`
→ `stack` toolchain targets DigitalOcean droplets directly, which matches D13's
vendor split and is materially cheaper than DOKS for a single staging
environment. DOKS remains available and needs the same controllers installed by
other means.

---

## 4. Backups — the reason stack-owned Postgres is defensible

File-copying a live Postgres data directory produces unrestorable snapshots.
stack(bp)'s answer is a **logical dump command whose stdout *is* the artifact**.
The annotation syntax is position-sensitive and fails silently — field guide §8;
get it wrong and the spec shows `exclude: []` with no complaint.

Configuration is ambient, set once per environment: `backup=true`, the
`backup-s3-*` settings pointed at **DO Spaces** (we already issue Spaces keys),
`backup-restic-password`, schedule `0 3 * * *`, retention
`--keep-daily 7 --keep-weekly 4 --keep-monthly 6`.

> **The restic password cannot be ephemeral.** Lose it and every encrypted
> snapshot is permanently unrecoverable. It goes into escrow *before* the first
> backup runs, not after. **This remains the single highest-consequence item in
> the plan.**

Restore is **not orchestrated** — stopping the deployment first is the operator's
job, and restoring onto live volumes corrupts data. The stop/restore/start
sequence must be written into the runbook because the tool will not enforce it
(reconciliation §4.3).

Repositories are interchangeable between compose and k8s targets, which keeps a
later prod-on-compose or prod-on-k8s decision reversible.

---

## 5. Migrations — still the open design question

Today a **one-shot container** runs `bun run src/db/migrate.ts`
(`scripts/stack/config.ts:289`), gated by a refuse-hook that can abort the boot
before anything is written, ordered before services start.

Kubernetes has no clean equivalent. `pre_start_command` / `post_start_command`
are **host-side scripts run by the deployer** — confirmed by the upstream skill,
not merely inferred — so a `pre_start_command` on a CI runner cannot reach a
cluster-internal Postgres. Three options:

1. **`post_start_command` that execs into the api pod** — closest to today's
   separation; keeps the refuse-hook meaningful. Needs `kubectl` on the runner
   and pod-readiness handling in a shell script.
2. **Migrate-on-start in the api entrypoint**, guarded by a Postgres advisory
   lock so replicas serialize. Simplest and k8s-idiomatic; **loses the pre-write
   abort gate** that the v0.2.2 rollout leaned on.
3. **A Kubernetes Job** emitted alongside the deployment — textbook, but there is
   no documented way to make stack(bp) emit one, so it means an out-of-band
   `kubectl apply` and the deploy stops being one artifact.

**Recommendation: (1) for staging**, because it preserves the abort gate that
the rollout runbooks' go/no-go depends on, and staging is where we learn whether
the exec dance is tolerable. Revisit before any production cutover.

The cost of *not* deciding is already visible: the running deployment serves
happily against a database with no `schema_migrations` table, logging `this boot
is UNCHECKED`. Nothing stops a release from doing the same.

---

## 6. Ingress & TLS

Routes are declared as trailing comment annotations on a `ports:` entry and
resolve across the whole deployment (field guide §7):

```yaml
    ports:
      - "8787"   # @stack http-proxy /
```

```sh
stack init … --http-proxy-fqdn swarm.staging.robotmoney.net \
             --http-proxy-clusterissuer letsencrypt-prod
```

**Name the issuer explicitly.** Omitting the flag does not mean "no issuer" — it
defaults to `letsencrypt-prod` and will spend production rate limit against a
hostname that may not resolve yet (field guide §9). Provisioned clusters carry a
staging issuer too; use it until DNS is real.

cert-manager issues the certificate, so the Cloudflare **Origin CA cert** and the
pinned-port tunnel are both retired on this path. Cloudflare keeps its D13 role —
DNS and health checks — unchanged.

Only `api` is exposed. Postgres and every worker stay cluster-internal, and they
do not need a published port to be addressable.

---

## 7. Phasing

Each phase has a blocking exit gate.

**Phase 0 — spikes.** *Substantially complete.* The translation questions are
answered and recorded in the field guide: probes (§12), secret interpolation
(§11), image identity (§19), the `API_PORT` collision (§10), `_static` (§15).
*Gate: only the §5 migration decision remains. It is the one thing here that
should be settled by a spike rather than by argument.*

**Phase 1 — author the definition, and the image.** Land `stacks/robotmoney/`
per §3.1/§3.2 — nothing is committed today. Against the spike, that means the
corrected container name, the Dockerfile static layer, operator-facing env
forwarded rather than defaulted, `API_PORT` set explicitly, and no stray
`postgres` publish. Add the `Number.isFinite` guard to `config.ts`.
`stack validate` and `stack check` pass.
*Gate: `bun run demo` still green — the compose path must not regress, since
`_static` would then exist both baked and bind-mounted.*

**Phase 2 — a provisioned cluster.** Stand up staging with `k3s-node.sh` (or
DOKS plus the same controllers). Deploy by hand. Prove ingress and TLS, secrets
delivery, migrations, `backup now`, and a **real restore into a scratch
deployment** — a backup is not proven until something has been restored from it.
*Gate: staging serves over TLS at its FQDN, and a restore has been performed.*

**Phase 3 — CI and runbook.** GitHub Actions on merge to `dev`: publish images to
ghcr on every `main` build, then `manage update` against the durable deployment
directory. **CI never runs `deploy`** — that creates a second environment rather
than upgrading one (reconciliation §4.1). Kubeconfig via
`--kube-config env:KUBECONFIG_DATA`. Write the stop/restore/start runbook and the
two-axis rollback procedure.
*Gate: three consecutive releases deploy through CI with no manual step.*

**Phase 4 — soak.** Staging runs on stack(bp) for several release cycles.
Production is untouched throughout. A production cutover is a **separate plan**,
written once this one has evidence.

---

## 8. Risks and accepted tradeoffs

- **Staging stops rehearsing production's data path.** The direct cost of the
  stack-owned-Postgres decision: prod is DO Managed HA (`sslmode=require`, port
  25060, PgBouncer pool URI); an in-cluster PVC exercises none of it.
  **Mitigation:** keep a second spec variant supplying `DATABASE_URL` as an
  external secret and omitting the `data` pod — the §3.2 pod split exists
  precisely so this is a spec change, not a rewrite.
- **Restic password loss is total backup loss** (§4). Escrow before first backup.
- **The migration abort gate may weaken** (§5), which matters because
  the rollout runbooks' go/no-go gates assume it.
- **Liveness-only probes** (field guide §12) mean a pod takes traffic before it
  can serve. Acceptable at one replica; decide before scaling.
- **`deploy` is not idempotent** — it mints a new deployment identity, namespace
  and backup repository each time. A release pipeline that calls it stands up a
  second production rather than upgrading the first (reconciliation §4.1).
- **Silent-failure surface.** Four of the behaviours in the field guide fail with
  no error at all: a dropped `build:` key, a mispositioned backup annotation, an
  empty interpolated secret, and the `API_PORT` mis-bind. Each is a reason to
  read the generated spec and the live objects rather than trusting an exit code.
- **Two "stacks" in one repo** (§0) — a documentation hazard more than a
  technical one.
- **Do not overlap with the v0.2.2 production rollout.** Changing the deploy
  mechanism and executing a gated production upgrade in the same window is how
  both go wrong.

## 9. Explicitly not in scope

- Any production change. Prod stays on SSH + compose.
- Retiring `scripts/stack/` or changing `bun run demo`.
- Moving the marketing static tier off its current path (D13's Spaces CDN
  end-state is unaffected).
- Horizontal scaling or HPA — one replica per service until there is a reason.
