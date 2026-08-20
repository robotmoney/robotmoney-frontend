# `stack` orchestrator — field guide

How [bozemanpass/stack](https://github.com/bozemanpass/stack) behaves when driven
against *this* application. **Every claim here was executed, not read.** Where
the upstream documentation and the tool disagree, the tool is recorded and the
disagreement noted — several of these differences fail *silently*, which is the
reason this document exists.

- **Tool version:** `stack 2.0.0-1177d1b-202608201522`
- **Verified against:** k3s `v1.36.2+k3s1`, single node, `local-path` default StorageClass
- **Date:** 2026-08-20
- **Environment:** [`../../.stack-env/README.md`](../../.stack-env/README.md)

**This document is a reference, not a plan.** It records how the tool behaves.
What we intend to do about it is [`../plans/stack-k8s-staging-deployment.md`](../plans/stack-k8s-staging-deployment.md);
how it meets the release policy is
[`stack-runbook-reconciliation.md`](./stack-runbook-reconciliation.md).

---

# A. Authoring a stack for this repo

## 1. Every path in `stack.yml` is repo-root-relative

Both `containers[].path` and `pods[].path` resolve against the **repository
root**, never against `stack.yml`'s own directory. Ours lives at
`stacks/robotmoney/stack.yml`, so:

```yaml
containers:
  - name: robotmoney/robotmoney-api
    path: ./stacks/robotmoney/containers/api   # NOT ./containers/api
pods:
  - name: data
    path: ./stacks/robotmoney/pods/data
```

The upstream skill states the rule outright, and `stack validate` catches the
pod case cleanly:

```
error: pod 'data' names no readable pod file
  (looked at <repo>/pods/data/composefile.yml) [pod-file-missing]
```

There is no convention requiring a particular directory name. `stack-files/` is
the only name the tool looks for on its own — see §2.

## 2. A build script is named in `container.yml`, never in `stack.yml`

This cost the most time, because the failure is silent exactly where you look
first.

A `stack.yml` container entry carries **only** `name`, `ref`, `path`, `wrapper`,
`wrapper-ref`, `content-root` (`build_util.py:37-51`). There is **no `build`
field**. Writing one there is neither an error nor a warning — it is dropped, and
`prepare` falls back to `default-build.sh`, which expects a `Dockerfile` in
`path`:

```
ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory
ERROR: .../container-build/default-build.sh robotmoney/api:stack .../containers/api failed with rc=1
```

`build` *is* a `ContainerSpec` field (`build_util.py:78`), read from exactly one
place: a `container.yml` in the container's `path` (`build_util.py:122`). So the
working shape is two files:

```yaml
# stacks/robotmoney/stack.yml — where the recipe lives
containers:
  - name: robotmoney/robotmoney-api
    path: ./stacks/robotmoney/containers/api
```
```yaml
# stacks/robotmoney/containers/api/container.yml — what the recipe is
container:
  name: robotmoney/robotmoney-api
  build: build.sh          # resolved against THIS file's directory
  content-root: .
```

`container.yml` keys are `name`, `ref`, `build`, `wrapper`, `wrapper-ref`,
`content-root`, under a required top-level `container:` section — a missing
section is the one case that errors loudly (`build_util.py:116`).

There is also a **convention path** that needs no `container.yml`:
`<repo>/stack-files/containers/<name-with-slashes-as-dashes>/build.sh`
(`constants.py:81`, `build_containers.py:140-146`). We use the explicit
`container.yml` instead, because it keeps the recipe beside the stack that owns
it.

### Why we need a build script at all

`backend/Dockerfile` copies `contract/` — the shared HTTP contract — from
**outside** `backend/`, so its build context must be the repo root while its
recipe lives at `backend/Dockerfile`. `content-root` cannot express "recipe here,
context there"; `build_util.py:65-74` documents that exact split in its own
docstring. The contract a build script honours:

| Variable | Meaning |
|---|---|
| `STACK_CONTAINER_BUILD_WORK_DIR` | docker build context |
| `STACK_CONTAINER_BUILD_CONTAINERFILE` | `-f` |
| `STACK_CONTAINER_BUILD_TAG` | image tag, `<name>:stack` |
| `STACK_CONTAINER_BASE_DIR` | where `build-base.sh` lives; source it first |

## 3. Composefiles reference built images by tag, never `build:`

The single biggest shape difference from `docker-compose.yml`:

```yaml
services:
  api:
    image: robotmoney/robotmoney-api:stack     # NOT `build:`
```

The `:stack` tag is the contract linking `stack.yml` to the composefile, and
`stack validate` checks it. Off-the-shelf images (`postgres:17-alpine`) need
**no** `containers:` entry at all — they are digest-locked into `stack.lock` on
first prepare:

```
Locking postgres:17-alpine to sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
```

## 4. Container names: shared namespace, project-specific name

A name is `<namespace>/<name>`. The **namespace is the image-registry namespace**
— for a GitHub-hosted project, the owning organization, so `robotmoney` is
correct. The **name half must be project-specific**: the namespace is shared by
every repo in the org, so `robotmoney/api` is the anti-pattern the upstream skill
names explicitly. Nothing validates it; getting it wrong simply yields an image
nobody can find again.

> **Pending change.** Our definition currently declares `robotmoney/api`. It
> should be `robotmoney/robotmoney-api`. Renaming means a rebuild and a re-push,
> so it is scheduled with the other definition corrections rather than done in
> passing.

## 5. Composefile rules that differ from our compose habits

- **`ports:` is not what makes a service addressable.** Every service answers to
  its own name across pods on both targets — on k8s via a headless Service when
  no port is declared. Publishing a port merely to obtain a hostname is a
  mistake, and on compose `--map-ports-to-host` would then expose it. Declare a
  port only where something must actually reach it (for us: `api`).
- **List container ports bare** (`- "8787"`). Host mapping is decided at `init`
  time by `--map-ports-to-host`; never hardcode a host port.
- **Env precedence is `config.env` → `env_file:` → inline `environment:`, later
  wins.** An inline literal therefore **beats** anything the deployer passes with
  `--config`. Anything an operator should choose must be *forwarded* —
  `SOME_VAR=${SOME_VAR}` — not defaulted. `stack deploy` warns when an inline
  literal shadows a differing `config.env` key.
- **Secrets are not composefile environment entries.** Declare them in
  `stack.yml`; stack delivers them to every container. Declaring a secret also
  strips any leftover hardcoded default for it from the deployed composefile.

---

# B. What `stack init` generates

## 6. Secrets: `generate` vs `external`, and a wider blast radius

```yaml
secrets:
  POSTGRES_PASSWORD:        # generated per deployment
  OPENCODE_API_KEY:
    external: true          # must be supplied: --secret NAME=env:CI_VAR
```

`external: true` means the counterpart lives outside the deployment, so a
generated value would be useless; it must be given a reference at `init`.
Everything else stack generates per deployment, which is strictly better than a
hand-set `ADMIN_TOKEN`.

**The blast radius is wider than ours is today.** `docker-compose.yml`'s
`environment:` blocks are an explicit allowlist — no `env_file:`, no `ENV` in the
Dockerfile — so a variable not named in a service's block never reaches it.
stack inverts this: a declared secret reaches *every* container. Consequences:

- `analytics-producer` no longer needs `ANALYTICS_TOKEN_FILE`; it gets
  `ANALYTICS_TOKEN` by injection, and `backend/src/producer/index.ts:23` already
  accepts either form.
- The worker lanes now receive `ADMIN_TOKEN` although only `api` authenticates
  HTTP. Not a vulnerability, but strictly wider — a conscious acceptance, not a
  discovery.

## 7. Ingress routes come from a trailing comment, and cross pod boundaries

```yaml
    ports:
      - "8787"   # @stack http-proxy /
```

Declared in `pods/app/composefile.yml`, it resolves against the whole deployment
— the generated spec names the service without qualifying it by pod:

```yaml
network:
  http-proxy:
   - host-name: rm-adhoc.localhost
     routes:
      - path: /
        proxy-to: api:8787
```

Confirming that pods share one service namespace, which is what lets
`analytics-producer` (workers pod) reach `http://api:8787` (app pod) unchanged.

## 8. Backup annotations are position-sensitive and fail silently

`@stack backup-exclude` **must trail the volume line**. On its own line above it,
it parses as an ordinary comment, is dropped, and `init` emits an empty exclude
list without complaint:

```yaml
# WRONG — silently ignored, produces `backup: exclude: []`
volumes:
  # @stack backup-exclude
  - pgdata:/var/lib/postgresql/data

# RIGHT
volumes:
  - pgdata:/var/lib/postgresql/data   # @stack backup-exclude
```

Not cosmetic: without the exclusion K8up file-copies a **live** Postgres data
directory, and the repository accumulates snapshots that look restorable and are
not. The real artifact is the logical dump, whose annotations attach to the
service and are position-independent:

```yaml
    # @stack backup-command pg_dump -U robotmoney -d robotmoney --clean --if-exists
    # @stack backup-file-extension sql
```

**Read the generated spec after every `init`.** It is the only place that shows
whether an annotation landed:

```yaml
backup:
  exclude:
   - pgdata            # <- if this is [], the annotation did not land
```

## 9. `--http-proxy-clusterissuer` defaults to `letsencrypt-prod`

Omitting the flag does **not** mean "no issuer". `init` writes
`cluster-issuer: letsencrypt-prod` — on a cluster with cert-manager, a request to
the production Let's Encrypt endpoint, with production rate limits. Pass
`--http-proxy-clusterissuer ""` to omit the key entirely, which is what an ad-hoc
deployment wants until DNS actually resolves. Provisioned clusters carry both a
production and a staging ClusterIssuer (§22).

---

# C. What the Kubernetes translation actually does

Read off live objects in namespace `stack-d6b992128bd8e312`, from a deployment
reaching `{"status":"ok","db":"up"}`.

## 10. `API_PORT` — the one that bites hardest

**Kubernetes injects legacy service-link environment variables** named
`<SERVICE>_PORT` for every Service in the namespace. Our api Service is called
`api`, so every container receives:

```
API_PORT=tcp://10.43.230.60:8787
POSTGRES_PORT=tcp://10.43.240.132:5432
```

`backend/src/config.ts:553` is `Number(process.env.API_PORT ?? 8787)`. `??` only
catches `null`/`undefined`; `Number("tcp://10.43.230.60:8787")` is `NaN`, so Bun
binds a **random** port — observed `:34529` — while the Service still targets
8787. Nothing routes, ever, and the failure is invisible:

```
NAME                          READY   STATUS    RESTARTS   AGE
deploy-api-857f4d847d-rwzxm   1/1     Running   0          66s
```

Fix: declare `API_PORT: "8787"` explicitly in the composefile — an explicitly
declared env var wins over a service link. This **contradicts
`docker-compose.yml`**, which deliberately removed `API_PORT` because there it
made a host `.env` value look effective while compose overrode it. Both decisions
are right for their target; the reason must be written in both places or someone
will "clean up" the k8s one.

> **App-side follow-up, independent of stack.** `Number(...)` on an unvalidated
> env var that Kubernetes is known to populate is a footgun. A `Number.isFinite`
> guard in `config.ts` turns a silent mis-bind into a loud refusal, which is this
> repo's house style anyway.

## 11. `command:` becomes `args:`, and `$` is treated differently per field

Compose `command:` lands in the container's **`args`**, with `command` left
`null` so the image `ENTRYPOINT` stands.

| Field | Compose `${VAR}` substituted at manifest-generation time? |
|---|---|
| `environment:` values | **Yes** |
| `command:` values | **No** — passed through literally |

That combination is a trap. A secret referenced from `environment:` is
substituted *at generation time*, when the secret does not exist yet, so it
renders **empty**:

```yaml
# WRONG — becomes postgres://robotmoney:@postgres:5432/robotmoney
environment:
  DATABASE_URL: postgres://robotmoney:${POSTGRES_PASSWORD}@postgres:5432/robotmoney
```

Secrets arrive as `secretKeyRef`, resolved by the kubelet at container start,
long after the manifest was written. The two never meet. This is by design — the
upstream skill says plainly: "have the app read it from the environment rather
than embedding a password in a connection URL."

`backend/src/config.ts:552` takes `DATABASE_URL` as `required(...)` and accepts
no `PGHOST`/`PGUSER`/`PGPASSWORD` parts, so *for us* the URL must be assembled in
the container, in `command:`, where `$` survives:

```yaml
command:
  - sh
  - -c
  - |
    export DATABASE_URL="postgres://robotmoney:${POSTGRES_PASSWORD}@postgres:5432/robotmoney"
    exec bun run src/api/index.ts
```

**Do not write `$$` here.** Compose's usual escape is not unescaped by this
translation — `$${POSTGRES_PASSWORD}` reaches the container verbatim, where `sh`
reads `$$` as its own PID and builds a garbage URL. Verified both ways.

## 12. `healthcheck:` becomes a livenessProbe — and only that

```yaml
healthcheck:
  test: ["CMD", "bun", "-e", "..."]
  interval: 15s
  timeout: 5s
  retries: 3
  start_period: 40s
```
```json
"livenessProbe": {
  "exec": {"command": ["bun", "-e", "..."]},
  "periodSeconds": 15, "timeoutSeconds": 5,
  "failureThreshold": 3, "initialDelaySeconds": 40
}
```

`readinessProbe` and `startupProbe` are **absent**. Two consequences to decide
about before staging:

- **No readiness gate.** A pod joins its Service's endpoints as soon as the
  container starts, so traffic can arrive before the api can serve it. Under
  compose this did not matter — the api was the only thing behind the port.
- **`start_period` maps to `initialDelaySeconds` on liveness**, strictly weaker
  than a `startupProbe`: a boot slower than 40s is killed rather than granted
  more time.

`depends_on: condition: service_healthy` has no k8s equivalent and is dropped. In
practice api and workers crash-loop until Postgres answers — it works, but it is
noisy, and migrations must not rely on the ordering ("Still open", item 1).

## 13. Secrets land as `secretKeyRef`, never as literals

```
POSTGRES_PASSWORD = {'secretKeyRef': {'key': 'POSTGRES_PASSWORD', 'name': 'stack-secrets'}}
ADMIN_TOKEN       = {'secretKeyRef': {'key': 'ADMIN_TOKEN', 'name': 'stack-secrets'}}
```

One `stack-secrets` Secret per namespace holds all seven of ours — four
generated, three external. Generated values are real; `POSTGRES_PASSWORD` came
out 32 bytes. The secret handling is sound; it simply cannot participate in
YAML-time string building (§11).

## 14. Volumes become PVCs, 2G by default

`pgdata` bound on the `local-path` default StorageClass at **2G** — the
documented default when the spec gives no
`resources.volumes.<name>.reservations.storage`. On a remote cluster `init`
leaves volumes unmapped and the default StorageClass decides where data lives.

## 15. `_static` must be baked into the image

With no bind mount, `/srv/frontend` is empty. The api starts happily, logs
`serving static frontend from /srv/frontend`, and then:

```
GET /health -> {"status":"ok","env":"demo","db":"up", ...}
GET /       -> HTTP 500
```

The assembled `_static` has to be a layer in the api image, not a mount.

## 16. `RM_ENV` has no `staging` value

`backend/src/config.ts:539` pins `VALID_ENVS = ["ephemeral", "demo", "prod"]` and
throws otherwise:

```
error: invalid RM_ENV "staging" — expected one of ephemeral | demo | prod
```

The staging environment must run **`RM_ENV=prod`** semantics, including
`PROJECTS_SOURCE=live`, which prod fails closed without. The ad-hoc box runs
`demo` deliberately, to stay off those fail-closed paths.

---

# D. Lifecycle

## 17. `deploy` and `start` do different jobs

`stack deploy` materializes a **deployment directory** and does not touch the
cluster:

```
rm-adhoc/
  deployment.yml        # just `cluster-id: stack-18ea628b5d60d628`
  spec.yml              # the spec, copied in
  stack.yml             # the stack definition, copied in
  kubeconfig.yml        # copied in, because --kube-config was a bare path
  config.env            # empty for us
  compose/composefile-{data,app,workers}.yml
```

Composefiles are copied **verbatim**, comments and all — no translation happens
here. For a k8s target there is no `secrets.env` on disk; values live in the
cluster Secret. The translation happens at `stack manage start`, so **`deploy`
succeeding tells you nothing about whether the manifests are valid.**

The `cluster-id` is identity: it determines the namespace *and* the restic
repository path. Every `deploy` mints a new one — see
[`stack-runbook-reconciliation.md`](./stack-runbook-reconciliation.md) §4.1 for
why that matters to a release pipeline. `stop` halts workloads and keeps the
deployment; `destroy` ends it, and only `destroy --delete-volumes` removes the
namespace.

## 18. A reachable registry is mandatory for a k8s target

`init` only warns:

```
WARN: --image-registry not specified: locally built images can only be deployed
if they are published to a container registry the cluster can reach
```

`start` then refuses outright:

```
ERROR: Cannot resolve image robotmoney/api:stack for deployment: it is not
published to a registry and the spec has no image-registry to stage it through.
```

**Importing into the cluster's containerd does not help.**
`docker save … | k3s ctr images import -` succeeds, `k3s ctr images ls` lists
it, and `start` still refuses — the check is in the tool, not a pull failure in
the cluster.

## 19. Image identity is commit-addressed, and discovery needs no configuration

This is the mechanism that makes releases and rollbacks work, and it is easy to
miss because the *unpublished* path behaves differently.

**Publishing** is one flag on the build:

```sh
stack prepare --stack ./stacks/robotmoney --publish-images --image-registry ghcr.io
```

**Pulling needs no configuration on the deploying side.** Discovery is a lookup
on two things:

- the **name** — taken verbatim from `stack.yml` with the registry host prefixed,
  the registry inferred from the recipe repo's git host (`github.com` → `ghcr.io`);
- the **tag** — the **commit hash of the recipe repo**, which for a project
  carrying its own stack directory is simply this repo.

So `prepare` computes the hash of the checkout in front of it, looks for
`ghcr.io/<container-name>:<hash>`, pulls it if present and builds only if not —
the default `as-needed` build policy. A production host that must never build
uses **`--build-policy prebuilt-remote`**, which fails rather than falling back.

Repo identity lives entirely in the tag, which is why the name is free-form and
why one commit can produce several images.

A **clean** checkout with a committed lock file yields that plain commit hash; a
dirty tree or uncommitted lock yields a `stackdev-<hash>` derived from the lock
content (`build_util.py:216-234`). **Committing `stack.lock` is what stabilizes
the version to a commit hash** — so a release build must run from a clean tree.

**The unpublished path is different and mutable.** When no published image
exists, `push-images` stages the local build under a private per-deployment tag,
`…/robotmoney/api:deploy-<id>`. Only `("local", "stack")` are treated as locally
built (`deploy/images.py:31`); every other reference passes through verbatim.
That distinction decides upgrade blast radius — §20.

## 20. `update` is content-only, and the image reference decides its blast radius

`stack manage --dir <d> update` converges the running deployment on its
deployment directory. It applies **image references, environment values and
secret values, and nothing else.** Structural change — services added or removed,
ports, volume mounts, resource requests/limits, replicas — is refused outright,
with the whole diff computed before anything is written:

```
ERROR: update only applies image, environment and secret changes, but the
deployment's shape has changed:
  deploy-api: containers changed
Re-create the deployment to apply these.
```

Skipping the push is caught rather than silently deploying stale code: *"The
local build of X is newer than the staged image: run '… push-images' and update
again to deploy it."* A changed secret restarts every service
(`secrets: changed; restarting all services`). Rollouts use the Deployment's
normal rolling update via a `restartedAt` annotation that is *merged*, not
assigned, so it does not strip the K8up backup annotations.

| Image reference | `update` behaviour |
|---|---|
| `robotmoney/robotmoney-api:stack`, unpublished | Rewritten to the mutable `…:deploy-<id>` staging tag. Content arrives under an unchanged reference, so **every** update — including a no-op — forces a re-pull and restarts the whole app tier. Nothing earlier to roll back to. |
| A published, commit-addressed reference (§19) | Verbatim and digest-locked. A no-op reports `unchanged`; only genuinely changed services roll; rollback is a pointer change. |

Verified, switching a service between two immutable tags:

```
### roll FORWARD
deploy-api: image …/robotmoney/api:v0-2-2 -> …/robotmoney/api:v0-2-3
### ROLL BACK — no rebuild
deploy-api: image …/robotmoney/api:v0-2-3 -> …/robotmoney/api:v0-2-2
### no-op
deploy-api: unchanged
```

For a release process, deploy published images (§19). The staging tag is a
development convenience.

---

# E. The wider toolchain

## 21. The upstream skills are authoritative — install them

`bozemanpass/no-paas` is a Claude Code plugin marketplace, and
`bozemanpass/stack` carries `skills/deploy-with-stack/SKILL.md`.

```
/plugin marketplace add bozemanpass/no-paas
/plugin install bpi-stack@no-paas
/plugin install stirlingbridge-machine@no-paas
/plugin install machine-provisioning@no-paas
/plugin install no-paas-toolchain@no-paas
```

The skill confirms the repo-root path rule (§1), deployment-wide secrets (§6),
cross-pod service DNS (§7), and the no-secrets-in-URLs design (§11). It is the
source for §4 (naming), §5 (composefile rules) and §19 (image discovery), all of
which corrected earlier assumptions in this branch.

## 22. Cluster prerequisites come from `machine-provisioning`, not from stack

stack **emits** ingress and backup resources; it does not install the controllers
they need. `stirlingbridge/machine-provisioning`'s `scripts/k3s-node.sh` installs
k3s together with:

- **cert-manager** and Let's Encrypt ClusterIssuers (production and staging)
- **K8up** — required for backups; a backup-enabled deploy to a cluster without
  it fails recognizably at deploy time
- **the Gateway API**, keeping k3s's bundled Traefik as the implementation, with
  a Gateway named **`stack-gateway`** in `kube-system` for workloads to attach
  HTTPRoutes to
- `--nginx-ingress` instead provisions the legacy Ingress API; ingress-nginx is
  noted upstream as retired, so the Gateway API is the default path

This explains the ad-hoc cluster's failure mode: `stack manage start` exits
non-zero with a bare `404 page not found` **after** applying every workload,
because the CRDs exist but no Gateway does.

```
ERROR: Exception thrown bringing stack up: (404)
HTTP response body: 404 page not found
```

Deployments, Services, Secret and PVC are all created regardless. **Treat a 404
from `start` as "ingress not published", not "deployment failed"** — but check,
because the exit code cannot distinguish them.

The full toolchain is `stirlingbridge/machine` (create the VM — DigitalOcean
among its targets) → `machine-provisioning` (make it a Docker host or a k8s
node) → `stack` (deploy onto it).

---

# Appendix — command surface, and rough edges

Corrections to the upstream docs summary, from the binary itself:

- `--deploy-to` accepts **`compose | k8s | k8s-kind`** (the docs show two).
- `--map-ports-to-host` has **six** modes: `any-variable-random` (docker
  default), `localhost-same`, `any-same`, `localhost-fixed-random`,
  `any-fixed-random`, `k8s-clusterip-same` (k8s default).
- `--secret NAME=REFERENCE`, reference being
  `generate | env:VAR | file:PATH | env-file:VAR | exec:COMMAND`.
- `--kube-config` takes the same reference forms, so CI can pass
  `env:KUBECONFIG_DATA` rather than a file.
- `stack fetch repo <host>/<org>/<repo>` clones to
  `$STACK_REPO_BASE_DIR/<host>/<org>/<repo>`.
- Both `stack prepare` and `stack build containers` build; the skill's pipeline
  is `build containers` → `init` → `deploy` → `manage`.

**`stack chart` crashes** with an unhandled `FileNotFoundError` traceback when a
pod file is missing, where `validate` reports the same condition cleanly. Run
`validate` first and treat a `chart` traceback as "go read the validate output".

**Unimplemented upstream**, so not available to a runbook that assumes them:
`backup status`, `backup prune`, `backup check`, and
`backup list --from <deployment>`.

---

# Still open

1. **Migrations.** Demonstrated, not resolved: the api boots against a database
   with no `schema_migrations` table and serves anyway, logging `this boot is
   UNCHECKED`. `pre_start_command` / `post_start_command` are host-side scripts
   run by the *deployer* and cannot reach a cluster-internal Postgres. Candidate
   shapes are in the plan, §5.
2. **Ingress and TLS.** Needs a cluster provisioned per §22. Nothing here has
   served over TLS yet.
3. **Backups.** Needs K8up. The annotations are correct in the spec (§8), but
   nothing has been backed up or restored — and a backup is not proven until
   something has been restored from it.
4. **Readiness.** Whether to declare explicit probes rather than accept
   liveness-only (§12).
