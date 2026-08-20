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

## Open — not yet verified

These are the questions the environment exists to answer. Nothing below should
be quoted as fact until it has an entry above.

1. **Do `healthcheck:` blocks become k8s probes?** Upstream
   `k8s-deployment-enhancements.md` documents node affinity and RuntimeClass and
   is silent on probes, `depends_on`, restart policy, resource limits, replicas.
2. **Does `${POSTGRES_PASSWORD}` interpolation inside a `DATABASE_URL` value
   survive the k8s translation**, where secrets become `secretKeyRef` rather
   than compose-level substitution? If not, the api and workers need the URL
   assembled at runtime instead.
3. **Migrations.** `pre_start_command` / `post_start_command` run on the
   *deployer*, so they cannot reach a cluster-internal Postgres. See §5 of the
   plan for the three candidate shapes.
4. **Getting images to k3s** — local registry, `k3s ctr images import`, or a
   real registry.
5. **Whether `_static` must be baked into the image** (expected: yes, no bind
   mounts on k8s) and what that does to image size and push time.
