# Using the `stack` orchestrator with this app

Working notes for driving [bozemanpass/stack](https://github.com/bozemanpass/stack)
against robotmoney. **Every claim here was executed, not read.** Where the
upstream documentation and the tool disagree, the tool is recorded and the
disagreement is noted, because several of these differences fail *silently*.

- **Tool version:** `stack 2.0.0-1177d1b-202608201522`
- **Verified against:** k3s `v1.36.2+k3s1`, single node, `local-path` default StorageClass
- **Date:** 2026-08-20
- **Environment:** see [`../../.stack-env/README.md`](../../.stack-env/README.md)

Companion to the plan in
[`../plans/stack-k8s-staging-deployment.md`](../plans/stack-k8s-staging-deployment.md).

---

## 1. Paths in `stack.yml` are repo-root-relative

Both `containers[].path` and `pods[].path` resolve against the **repo root**,
not against `stack.yml`'s own directory. Our `stack.yml` lives at
`stacks/robotmoney/stack.yml`, so its entries read:

```yaml
containers:
  - name: robotmoney/api
    path: ./stacks/robotmoney/containers/api   # NOT ./containers/api
pods:
  - name: data
    path: ./stacks/robotmoney/pods/data
```

This is consistent with the upstream todo example, where `stack.yml` sits in
`stacks/todo/` and the single pod is `path: .` — the repo root, where that
repo's `composefile.yml` actually lives.

Get it wrong for a pod and `stack validate` says so cleanly:

```
error: pod 'data' names no readable pod file
  (looked at <repo>/pods/data/composefile.yml) [pod-file-missing]
```

## 1a. A build script is named in `container.yml`, never in `stack.yml`

This one cost the most time, because the failure is silent in the place you
look first.

A stack.yml container entry carries **only** `name`, `ref`, `path`, `wrapper`,
`wrapper-ref`, `content-root` (`build_util.py:37-51`). There is **no `build`
field**. Writing one there is not an error and not a warning — it is simply
dropped, and `stack prepare` falls back to `default-build.sh`, which expects a
`Dockerfile` sitting in `path`:

```
ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory
ERROR: .../container-build/default-build.sh robotmoney/api:stack .../stacks/robotmoney/containers/api failed with rc=1
```

`build` **is** a field of `ContainerSpec` (`build_util.py:78`) and it is read
from exactly one place: a `container.yml` in the container's `path`
(`build_util.py:122`). So the working shape is two files:

```yaml
# stacks/robotmoney/stack.yml       — points at the recipe directory
containers:
  - name: robotmoney/api
    path: ./stacks/robotmoney/containers/api
```
```yaml
# stacks/robotmoney/containers/api/container.yml — names the recipe
container:
  name: robotmoney/api
  build: build.sh          # resolved against THIS file's directory
  content-root: .
```

`container.yml` keys are `name`, `ref`, `build`, `wrapper`, `wrapper-ref`,
`content-root`, all under a required top-level `container:` section — a missing
section is the one case that does error out loudly (`build_util.py:116`).

> **Rule of thumb:** `stack.yml` says *where the recipe lives*;
> `container.yml` says *what the recipe is*. Upstream `docs/stack-files.md`
> documents neither `build` nor this split.

## 2. Why we need `build:` at all

`backend/Dockerfile` copies `contract/` — the shared HTTP contract — from
**outside** `backend/`, so its build context must be the repo root while its
recipe lives at `backend/Dockerfile`. `content-root` cannot express "recipe
here, context there"; that is exactly the split
[`build_util.py:65-74`](https://github.com/bozemanpass/stack) documents in its
own docstring. So we hand `stack` a build script and set the context ourselves.

The contract a build script must honour (from
`bozemanpass/stack-wrapper-static-content/build.sh`):

| Variable | Meaning |
|---|---|
| `STACK_CONTAINER_BUILD_WORK_DIR` | docker build context |
| `STACK_CONTAINER_BUILD_CONTAINERFILE` | `-f` |
| `STACK_CONTAINER_BUILD_TAG` | image tag, `<name>:stack` |
| `STACK_CONTAINER_BASE_DIR` | where `build-base.sh` lives; source it first |

Ours is `stacks/robotmoney/containers/api/build.sh`.

## 3. Composefiles reference built images by tag, never `build:`

This is the single biggest shape difference from `docker-compose.yml`. `stack`
builds the container named in `stack.yml` and tags it; the pod composefile then
refers to that tag:

```yaml
services:
  api:
    image: robotmoney/api:stack     # NOT `build:`
```

`stack prepare` also writes a **`stack.lock`**, pinning external images to
digests — observed on our first run:

```
Locking postgres:17-alpine to sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
```

## 4. Backup annotations are position-sensitive and fail silently

`@stack backup-exclude` **must trail the volume line**. On its own line above
it, it parses as an ordinary comment, is dropped, and `stack init` emits an
empty exclude list without complaint:

```yaml
# WRONG — silently ignored, produces `backup: exclude: []`
volumes:
  # @stack backup-exclude
  - pgdata:/var/lib/postgresql/data

# RIGHT
volumes:
  - pgdata:/var/lib/postgresql/data   # @stack backup-exclude
```

The consequence is not cosmetic. Without the exclusion, K8up file-copies a
**live** Postgres data directory, and the repository accumulates snapshots that
look restorable and are not. The real artifact is the logical dump, and *those*
annotations are line-position-independent because they attach to the service:

```yaml
    # @stack backup-command pg_dump -U robotmoney -d robotmoney --clean --if-exists
    # @stack backup-file-extension sql
```

Verify by reading the generated spec, every time:

```yaml
backup:
  exclude:
   - pgdata            # <- if this is [], the annotation did not land
  commands:
    postgres:
      command: pg_dump -U robotmoney -d robotmoney --clean --if-exists
      file-extension: sql
```

## 5. `--http-proxy-clusterissuer` defaults to `letsencrypt-prod`

Omitting the flag does **not** mean "no issuer". `stack init` writes:

```yaml
     cluster-issuer: letsencrypt-prod
```

On a cluster with cert-manager installed, that is a request for a real
certificate from the production Let's Encrypt endpoint — with production rate
limits. Pass `--http-proxy-clusterissuer ""` to omit the key entirely, which is
what an ad-hoc or staging deployment wants until DNS actually resolves.

## 6. Ingress routes come from a comment, and cross pod boundaries

The `@stack http-proxy` annotation trails a `ports:` entry:

```yaml
    ports:
      - "8787"   # @stack http-proxy /
```

Declared in `pods/app/composefile.yml`, it resolves against the whole
deployment — the generated spec names the service without qualifying it by pod:

```yaml
network:
  http-proxy:
   - host-name: rm-adhoc.localhost
     routes:
      - path: /
        proxy-to: api:8787
```

That confirms pods share one service namespace, which is what lets
`analytics-producer` (workers pod) reach `http://api:8787` (app pod) unchanged.

## 7. Secrets are deployment-wide — a real change in blast radius

`docker-compose.yml`'s `environment:` blocks are an explicit **allowlist**: there
is no `env_file:`, `backend/Dockerfile` sets no `ENV`, so a variable not named
in a service's block never reaches that container. `stack` inverts this: a
declared secret is "delivered to every container of the deployment."

Practical consequences for us:

- `analytics-producer` no longer needs `ANALYTICS_TOKEN_FILE`. It gets
  `ANALYTICS_TOKEN` by injection, and `backend/src/producer/index.ts:23` already
  accepts either form.
- The worker lanes now receive `ADMIN_TOKEN` even though only `api`
  authenticates HTTP. Not a vulnerability, but it is strictly wider than today
  and should be a conscious acceptance, not a discovery.

`generate` vs `external` is the meaningful distinction:

```yaml
secrets:
  POSTGRES_PASSWORD:        # generated per deployment
  OPENCODE_API_KEY:
    external: true          # must be supplied: --secret NAME=env:CI_VAR
```

## 8. Rough edges worth knowing

- **`stack chart` crashes** with an unhandled `FileNotFoundError` traceback on a
  stack whose pod file is missing, where `stack validate` reports the same
  condition cleanly. Run `validate` first; treat a `chart` traceback as "go read
  the validate output", not as a broken stack.
- **`--image-registry` omission is a warning at `init` and a hard stop at
  `start`.** `stack init` only warns:
  `WARN: --image-registry not specified: locally built images can only be
  deployed if they are published to a container registry the cluster can reach`.
  `stack manage start` then refuses outright:

  ```
  ERROR: Cannot resolve image robotmoney/api:stack for deployment: it is not
  published to a registry and the spec has no image-registry to stage it through.
  ```

  **Importing the image into the cluster's containerd does not help.**
  `docker save robotmoney/api:stack | k3s ctr images import -` succeeds, the
  image is listed by `k3s ctr images ls`, and `start` still refuses — the check
  is in the tool, not a pull failure in the cluster. For a k8s target a
  reachable registry is mandatory, full stop.

## 10. `deploy` and `start` do different jobs

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

The composefiles are copied **verbatim**, comments and all — no translation
happens here. For a k8s target there is no `secrets.env` on disk (values live in
the cluster `stack-secrets` Secret), which is the behaviour upstream documents.

The k8s translation happens at `stack manage start`. That means **`deploy`
succeeding tells you nothing about whether the manifests are valid** — the
questions about probes and secret interpolation below cannot be answered until
`start` runs.

## 9. Command reference, as the binary actually reports it

Corrections to the upstream docs summary:

- `--deploy-to` accepts **`compose | k8s | k8s-kind`** (the docs show only the
  first two).
- `--map-ports-to-host` has **six** modes: `any-variable-random` (docker
  default), `localhost-same`, `any-same`, `localhost-fixed-random`,
  `any-fixed-random`, `k8s-clusterip-same` (k8s default).
- `--secret NAME=REFERENCE` where reference is
  `generate | env:VAR | file:PATH | env-file:VAR | exec:COMMAND`.
- `stack fetch repo <host>/<org>/<repo>` clones to
  `$STACK_REPO_BASE_DIR/<host>/<org>/<repo>`.

---

# Part II — what the k8s translation actually does

Everything below was read off live objects in namespace
`stack-d6b992128bd8e312` on the k3s cluster, from a deployment that reaches
`{"status":"ok","db":"up"}`.

## 11. `API_PORT` — the one that will bite hardest

**Kubernetes injects legacy service-link environment variables** named
`<SERVICE>_PORT` for every Service in the namespace. Our api Service is called
`api`, so every container in the deployment receives:

```
API_PORT=tcp://10.43.230.60:8787
POSTGRES_PORT=tcp://10.43.240.132:5432
```

`backend/src/config.ts:553` is:

```ts
apiPort: Number(process.env.API_PORT ?? 8787),
```

`??` only catches `null`/`undefined`. `Number("tcp://10.43.230.60:8787")` is
`NaN`, Bun binds a **random** port — observed `:34529` — while the Service still
targets 8787. Nothing routes, ever. And the failure is invisible:

```
NAME                          READY   STATUS    RESTARTS   AGE
deploy-api-857f4d847d-rwzxm   1/1     Running   0          66s
```

The fix is to declare `API_PORT: "8787"` explicitly in the composefile; an
explicitly declared env var wins over a service link. Note this **contradicts
`docker-compose.yml`**, which deliberately removed `API_PORT` because there it
made a host `.env` value look effective while compose overrode it. Both
decisions are right for their target; the reason has to be written down in both
places or someone will "clean up" the k8s one.

> Worth a follow-up in the app itself: `Number(...)` on an unvalidated env var
> that k8s is known to populate is a footgun independent of stack. A
> `Number.isFinite` guard in `config.ts` would turn a silent mis-bind into a
> loud refusal, which is this repo's house style anyway.

## 12. `command:` becomes `args:`, and `$` is treated differently there

Compose `command:` lands in the k8s container's **`args`**, with `command` left
`null` (the image `ENTRYPOINT` stands).

More important, **substitution rules differ by field**:

| Field | Compose `${VAR}` substitution at manifest-generation time? |
|---|---|
| `environment:` values | **Yes** |
| `command:` values | **No** — passed through literally |

That combination produces the trap below. A secret referenced in
`environment:` is substituted *at generation time*, when the secret does not
exist yet, so it renders **empty** — silently:

```yaml
# WRONG — becomes postgres://robotmoney:@postgres:5432/robotmoney
environment:
  DATABASE_URL: postgres://robotmoney:${POSTGRES_PASSWORD}@postgres:5432/robotmoney
```

Secrets arrive as `secretKeyRef`, resolved by the kubelet at container start —
long after the manifest was written. The two never meet. Assemble the URL in
the container instead, in `command:`, where `$` survives:

```yaml
# RIGHT — single $, in command:, expanded by the container's shell
command:
  - sh
  - -c
  - |
    export DATABASE_URL="postgres://robotmoney:${POSTGRES_PASSWORD}@postgres:5432/robotmoney"
    exec bun run src/api/index.ts
```

**Do not write `$$` here.** Compose's usual escape is *not* unescaped by this
translation — `$${POSTGRES_PASSWORD}` is delivered to the container verbatim,
where `sh` reads `$$` as its own PID and builds a garbage URL. Verified both
ways.

`backend/src/config.ts:552` takes `DATABASE_URL` as `required(...)` and accepts
no `PGHOST`/`PGUSER`/`PGPASSWORD` parts, so runtime assembly is the only option
for us.

## 13. `healthcheck:` becomes a livenessProbe — and *only* that

```yaml
healthcheck:
  test: ["CMD", "bun", "-e", "..."]
  interval: 15s
  timeout: 5s
  retries: 3
  start_period: 40s
```

becomes

```json
"livenessProbe": {
  "exec": {"command": ["bun", "-e", "..."]},
  "periodSeconds": 15, "timeoutSeconds": 5,
  "failureThreshold": 3, "initialDelaySeconds": 40
}
```

`readinessProbe` and `startupProbe` are **ABSENT**. Two consequences worth
deciding about before staging:

- **No readiness gate.** A pod joins its Service's endpoints as soon as the
  container starts, so traffic can arrive before the api can serve it. Under
  compose this did not matter; the api was the only thing behind the port.
- **`start_period` maps to `initialDelaySeconds` on liveness**, which is
  strictly weaker than a `startupProbe`: a boot slower than 40s gets killed
  rather than granted more time.

`depends_on: condition: service_healthy` has no k8s equivalent and is dropped —
as expected. In practice the api and workers crash-loop until Postgres answers,
which works but is noisy.

## 14. Secrets land as `secretKeyRef`, never as literals

The generated Deployment carries no secret values:

```
POSTGRES_PASSWORD = {'secretKeyRef': {'key': 'POSTGRES_PASSWORD', 'name': 'stack-secrets'}}
ADMIN_TOKEN       = {'secretKeyRef': {'key': 'ADMIN_TOKEN', 'name': 'stack-secrets'}}
```

One `stack-secrets` Secret per namespace holds all seven of ours (four
generated, three `external`). Generated values are real — `POSTGRES_PASSWORD`
came out 32 bytes. This is the good half of §12: the secret handling is sound,
it just cannot participate in YAML-time string building.

## 15. Volumes, and what `start` does with a 404

`pgdata` became a **bound PVC** on the `local-path` default StorageClass at
**2G** — the documented default when the spec gives no
`resources.volumes.<name>.reservations.storage`.

`stack manage start` **exits non-zero with a bare `404 page not found`** on this
cluster, *after* successfully applying every workload:

```
ERROR: Exception thrown bringing stack up: (404)
HTTP response body: 404 page not found
```

The cluster has Gateway API CRDs (from Traefik) and a `traefik` IngressClass,
but no configured Gateway, and stack's http-proxy publication fails against it.
The Deployments, Services, Secret and PVC are all created regardless. **Treat a
404 from `start` as "ingress not published", not "deployment failed"** — but
check, because the exit code cannot distinguish them.

## 16. `_static` must be baked into the image — confirmed

With no bind mount, `/srv/frontend` is empty in the container. The api starts
happily and logs `serving static frontend from /srv/frontend`, then answers:

```
GET /health -> {"status":"ok","env":"demo","db":"up", ...}
GET /       -> HTTP 500
```

So the plan's §3.1 conclusion holds, now with evidence: the assembled `_static`
has to be a layer in `robotmoney/api`, not a mount.

## 17. `RM_ENV` has no `staging` value

`backend/src/config.ts:539` pins `VALID_ENVS = ["ephemeral", "demo", "prod"]`
and throws otherwise:

```
error: invalid RM_ENV "staging" — expected one of ephemeral | demo | prod
```

The staging environment must therefore run **`RM_ENV=prod`** semantics —
including `PROJECTS_SOURCE=live`, which prod fails closed without. The ad-hoc
box here runs `demo` deliberately, to stay off those fail-closed paths.

## 18. Upgrades: `update` is content-only, and the image tag decides its blast radius

`stack manage --dir <d> update` converges the running deployment on its
deployment directory. It applies **image references, environment values and
secret values, and nothing else**. Structural change — services added or
removed, ports, volume mounts, resource requests/limits, replicas — is refused
outright, with the whole diff computed before anything is written:

```
ERROR: update only applies image, environment and secret changes, but the
deployment's shape has changed:
  deploy-api: containers changed
Re-create the deployment to apply these.
```

Skipping the push is caught rather than silently deploying stale code:
`The local build of X is newer than the staged image: run '… push-images' and
update again to deploy it.` A changed secret restarts every service, announced
as `secrets: changed; restarting all services`. Rollouts go through the
Deployment's normal rolling update via a `restartedAt` annotation that is
*merged*, not assigned, so it does not strip the K8up backup annotations.

**The consequential choice is the image tag**, because it decides whether an
upgrade is targeted or total:

| Composefile reference | `update` behaviour |
|---|---|
| `robotmoney/api:stack` | Rewritten to a mutable `…:deploy-<id>` staging tag. Content arrives under an unchanged reference, so **every** update — including a no-op — forces a re-pull and restarts the whole app tier. No earlier tag exists to roll back to. |
| `<registry>/robotmoney/api:<version>` | Passed through verbatim and digest-locked in `stack.lock`. A no-op reports `unchanged`; only genuinely changed services roll; rollback is a pointer change. |

Only `("local", "stack")` are treated as locally-built
(`deploy/images.py:31`); everything else is a published reference. For a release
process, reference a published version tag. See
[`stack-runbook-reconciliation.md`](./stack-runbook-reconciliation.md) §5.2.

Related: a **clean** checkout with a committed lock file yields a
commit-addressed image tag; a dirty tree or uncommitted lock yields a
`stackdev-<hash>` tag derived from the lock content (`build_util.py:216-234`).
Committing `stack.lock` is what stabilizes the version to a plain commit hash.

---

## Still open

1. **Migrations** — unresolved and now demonstrated: the api boots against a
   database with no `schema_migrations` table and serves anyway, logging
   `this boot is UNCHECKED`. `pre_start_command` / `post_start_command` run on
   the *deployer* and cannot reach a cluster-internal Postgres. See §5 of the
   plan for the three candidate shapes.
2. **Ingress** — needs a cluster with a working Gateway or a plain Ingress path
   (§15), plus cert-manager before TLS means anything.
3. **Backups** — needs K8up on the cluster. The annotations are correct in the
   spec (§4); nothing has been backed up or restored yet, and per the plan a
   backup is not proven until something has been restored from it.
4. **Readiness** — whether to add explicit probes to the spec (§13).
