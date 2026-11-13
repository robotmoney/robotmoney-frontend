# Web serving architecture

This document specifies how the website is built, served, released and rolled back. It states what the system must
do. It does not describe the current implementation or the work to reach this state.

## 1. Purpose

The site hosts dapp surfaces: pages where a visitor connects a wallet and signs transactions. On such a page the
JavaScript we serve decides what the visitor signs. A changed file can move a visitor's funds. The web deployment
is therefore held to the same standard as the backend.

Three goals follow:

1. **Traceable.** What production serves traces back to one reviewed commit.
2. **Tamper-evident.** No person and no script can change the served files after they are checked.
3. **Reversible.** A bad release is undone by one command with a known target.

## 2. Requirements

| Id | Requirement |
|---|---|
| R1 | Each web release is one signed, versioned bundle |
| R2 | The bundle is built and signed on the control machine, never on a serving host |
| R3 | The served files live inside the serving container. There is no host mount |
| R4 | A container is static. Nothing is copied into it after it starts |
| R5 | A container maps to exactly one web version, readable from the container |
| R6 | One container role serves the site, proxies the API and holds the public port |
| R7 | One external server component. No second proxy or web server |
| R8 | A release needs no change to the Cloudflare tunnel |
| R9 | A new image is checked before it takes traffic |
| R10 | A failed check after the swap reverts to the previous image |
| R11 | A swap may drop requests for a short, measured gap, and at no other time |
| R12 | The web server caches no API response. The API caches its own answers |
| R13 | Stage and production deploy the same bundle bytes |
| R14 | An agent runs every release step from a runbook. No step needs a person on a host |

## 3. Components

```
control machine (release commit)     serving host
┌──────────────────────┐            ┌───────────────────────────────────────┐
│ assemble the site    │            │ verify signature + digest + apiRange  │
│ pack the bundle      │  bundle    │ build the image (bundle baked in)     │
│ digest + sign        │ ─────────► │ check a throwaway copy                │
│ send over SSH        │            │ swap the container on the public port │
└──────────────────────┘            │ check the public site, revert if bad  │
                                    └───────────────────────────────────────┘

Cloudflare tunnel ─► website-server (one container, immutable)
                       ├─ static files, from the baked bundle
                       ├─ headers and routes, from the platform's server config
                       ├─ /api/, /health, /version ─► api
                       └─ maintenance answer when the api is down
```

### 3.1 The bundle

- One file per web release: `robotmoney-web-<version>-<commit>.tar.gz`.
- Its content is the output of `scripts/static-assembly.sh` for the release commit.
- It is deterministic. Packing the same tree twice gives the same bytes.
- It carries `version.json`, which names the version, the commit and the `apiRange`. The file name matches it.
- It carries a manifest, `.rm-bundle-manifest.json`, that lists every other file with its sha256.
- It is built on the control machine, the machine every release runs from.
- It has a sha256 digest and a signature.
- Its digest is the file `<bundle>.sha256`, which names the tarball's sha256 and its file name.
- The signature is `<bundle>.sha256.sig`, an SSH signature over the digest file made with an ed25519 key
  (`ssh-keygen -Y sign`) in the namespace `robotmoney-web-bundle@v1`. That namespace is used only for web
  bundles. A signature in any other namespace fails verification.
- `scripts/lib/web-bundle.ts` packs, signs and verifies a bundle. Verification writes nothing unless the name,
  the digest, the signature, the manifest and `version.json` all check out.
- The private key is held on the control machine and nowhere else. It signs bundles and does nothing else.
- The public key is committed to the repository as `website-server/allowed-signers`. Each line in it is scoped
  to `robotmoney-web-bundle@v1`. A host verifies a bundle against that file only (`ssh-keygen -Y verify`).
- A host's allowed-signers file comes from the platform release the host runs. A web release never sends or
  changes it. A key is added, replaced or removed only by a platform release.
- It reaches a host from the control machine over SSH.
- CI builds, signs and deploys nothing. It runs the checks that gate a release commit.
- It is built for the release commit before stage runs (R13).
- The `web-vA.B.C` release carries the bundle, its digest and its signature.

What the signature proves: the bytes a host serves are the bytes the control machine signed, and they did not
change in transit or at rest. What it does not prove: that the control machine itself is honest. The control
machine holds both the signing key and the deploy access, so it is the root of trust for a release.

### 3.2 The image and the container

- The `website-server` image is the platform's server image plus exactly one verified bundle.
- The server image holds the server and its config. It belongs to the platform release the host runs.
- The image carries no Bun or Node runtime.
- The base image is pinned by digest.
- The container has no volume.
- The container's root filesystem is read-only. The server's scratch paths are in-memory mounts.
- The container runs as a non-root user, with every capability dropped and no privilege escalation.
- The container's labels name the web tag, the commit, the bundle digest and the platform commit of the server
  image (R5).
- The served root of a running container never differs from its image (R4).
- The container listens on port 8080 and holds the published origin port.

### 3.3 The server

The server is Caddy, with its admin API and automatic HTTPS turned off. It has these duties and no others:

| Duty | Rule |
|---|---|
| Static files | Serve the bundle's files |
| Fallback | A path with no file extension falls back to its `index.html`, then to `_shell.html` |
| Missing asset | A path with a file extension and no file answers 404, never the shell |
| Cache headers | HTML answers `Cache-Control: no-cache`. Assets answer the value in `static-asset-cache.md` |
| Security headers | CSP, `Permissions-Policy`, `Referrer-Policy` and `X-Content-Type-Options` on every answer |
| Page-scoped CSP | A dapp page may carry a wider CSP. Every other page keeps the default |
| API proxy | `/api/`, `/health` and `/version` go to the API with the original Host header |
| Client identity | `X-Client-IP` and `CF-Connecting-IP` are set on every proxied request. A caller-sent value is replaced |
| Maintenance | With the API down, `/api/status/maintenance` answers the maintenance body. Other `/api/` paths answer 503 JSON with `Retry-After: 60` |
| Compression | The server does not compress. The Cloudflare edge does |
| Health | The container health check reads `/` on port 8080 |

The server config belongs to the platform. A bundle holds site files only, never a header or a route rule. A
change to a header, such as a dapp page's CSP, is a platform release.

Scripts load only from our own origin, and a third-party library is vendored into the bundle. Two exceptions
apply to every page, dapp pages included: `'unsafe-eval'`, which Alpine needs, and Cloudflare's challenge script
(`https://challenges.cloudflare.com`). No other script source is allowed.

### 3.4 The API cache boundary

The web server stores no API response (R12). The API caches its public analytics answers in process:

- The store is keyed by request URL and has a fixed memory cap.
- Identical requests that arrive together share one database query.
- An entry is never served past the `max-age` its route set.
- Every answer carries `X-Cache-Status` with `HIT` or `MISS`.
- The store is empty after every API start, so no answer outlives the code that computed it.

## 4. Release and rollback

`bun smoke:web` is the one command that changes what a host serves. It runs on the control machine and drives
the host over SSH. One run holds the host's deployment lock, so two runs never overlap. For a named bundle it
runs these steps in order:

1. Verify the signature, the digest and `version.json`. Refuse a bundle whose `apiRange` excludes the running API.
2. Build the image.
3. Start a throwaway copy on a spare port. Check that `/version.json` names the release and that the route and
   header table passes. Remove the copy.
4. Stop the running container. Start the new one on the public port.
5. Check that `/version.json`, read through the public origin, names the release.
6. If step 5 fails, start the previous image on the public port and exit non-zero.
7. If step 5 passes, keep the previous image as the rollback target.

`bun smoke:web --rollback` refuses a previous image whose `apiRange` excludes the running API. Otherwise it
runs steps 3 to 5 with the previous image.

Rules:

- A bundle that fails step 1 or step 3 never reaches the public port.
- The throwaway copy is a valid check because it runs the same image that will serve.
- A host always holds exactly one previous image: the image that served before the last swap, whatever caused
  that swap. A release is refused when there is none.
- A container that restarts, or a host that reboots, serves the same image again.
- Any signed bundle can be deployed again by name. That is how a host returns to a version older than its
  previous image.
- Every run writes a receipt: the bundle digest, the old and new container ids, each check's result and the gap.
- A web release restarts no backend service and writes no database row.
- A web release installs no dependency on a serving host. It needs Docker and OpenSSH there, and nothing else.

### 4.1 The gap

Docker gives a published port to one container at a time. Between step 4's stop and start nothing listens, so
requests fail. API calls fail in that gap too, because the same container proxies them. This is accepted (R11).

- The gap runs from the stop of the old container to the first good answer from the new one on the public port.
- The gap is measured on every swap and recorded in the receipt, in milliseconds.
- A gap over three seconds fails the release.
- A failed request outside the gap fails the release.
- A rollback has its own gap, under the same limit.

### 4.2 A breaking platform cutover

A platform release that declares a maintenance window stops every service except `website-server`
(`bun smoke:down --keep-web`, issue 1501). During the window the site keeps answering 200 on `/` and
`/version.json`. The API answers the maintenance JSON: `/api/status/maintenance` serves `maintenance.json`, and
every other `/api/` path gets a 503 maintenance body with `Retry-After: 60`. A visitor never gets a 502. The
release probe grade fails any non-200 site answer inside the window, and fails a window in which no answer
announced the active maintenance window.

## 5. The runbook

Releases are run by an agent from a runbook. The rules are in [release-runbooks.md](./release-runbooks.md). This
design depends on these:

- **An agent executes every step.** The operator gives one recorded go before the run. Everything runs from the
  control machine over SSH.
- **The runbook is a YAML step list.** Each step has an id, a command, an expected exit and receipts. A run keeps a
  journal. A rerun continues at the first step that is not done.
- **Stage first, with the same steps.** Production runs what stage passed, unchanged.
- **A check with no tool is a gap.** A gap is closed by a pull request to the runbook, never by a hand-run command.
- **A failure reverts by a step.** The runbook names the rollback command. No step relies on judgement.

Every part of this design is therefore a command with a pass or fail answer and a receipt.

### 5.1 Web content release steps

The web content runbook is `scripts/release/runbooks/web-content.yaml`, run by `bun run release:web`.

| Step | What it does |
|---|---|
| W01-preflight | Checks each named commit is eligible. Reads the running container's labels and the previous image. Refuses with no rollback target |
| W02-branch | Pushes the release commit to `web/releases-A.B.x` as a fast-forward |
| W03-gate | The web client checks and the end-to-end checks pass on the release commit. The runner then packs and signs the bundle on the control machine |
| W04-stage-up | Brings the stage target up at production's running commit, from a fresh production dump |
| W05-stage-deploy | Sends the bundle to stage and runs `bun smoke:web` with it |
| W06-stage-check | Runs the live check against the stage origin. Records a pass for the bundle digest |
| W07-tag | Pushes the tag `web-vA.B.C`. The tag is never moved or deleted |
| W08-tag-guard | The tag rule passes for the tag |
| W09-host-ready | Confirms the production host holds the server image, the allowed-signers file and a previous image. It installs nothing |
| W10-deploy | Refuses a bundle whose digest is not the stage-passed digest. Sends it to production and runs `bun smoke:web` with it |
| W11-live-check | Runs the live check against the public origin. On a failure it runs `bun smoke:web --rollback` and exits non-zero |
| W12-release | Publishes the release notes with the bundle, its digest and its signature |

No step from W07 on writes unless a stage pass is recorded for the same bundle digest.

### 5.2 The live check

W06 and W11 run the same check:

1. `/version.json` names the release's version and commit.
2. The running container's labels equal the bundle's tag, commit and digest.
3. Every served file equals its entry in the bundle's manifest, by sha256.
4. The route and header table passes through the origin, including each dapp page's CSP. A web release leaves
   every header unchanged.
5. Every sitemap route answers 200.
6. The `api` and worker container ids and `/api/version` are unchanged.

### 5.3 Platform releases

- A platform release keeps the bundle the host serves, unless its runbook names a signed bundle to deploy.
- A bundle a platform release names passes that release's own stage run, by digest, before production gets it.
- A platform release that changes the server image rebuilds `website-server` with the bundle already serving,
  by the same swap and the same checks.
- Every change to the site goes through `bun smoke:web`.
- A probe runs around every swap. Its grade excuses exactly the gap in the release receipt.
- In a declared maintenance window the grade requires the maintenance answer, and fails any other failure.
- The log verdict classifies the server's access log in its own format.

### 5.4 Faults and the checks that catch them

| Fault | Check | Where |
|---|---|---|
| The bundle changed after it was signed | Signature and digest | `smoke:web` step 1 |
| The site needs a newer API than the host runs | `apiRange` against `/api/version` | `smoke:web` step 1 |
| The image serves wrong routes or headers | Route and header table on the throwaway copy | `smoke:web` step 3 |
| A CSP change blocks a dapp page | Header table through the origin | Live check 4 |
| The host serves bytes that differ from the release | Served bytes against the manifest | Live check 3 |
| The running container is not the released version | Labels against the bundle digest | Live check 2 |
| Stage and production got different bytes | Stage pass recorded by digest | W06, W10 |
| The swap takes too long | Gap limit of three seconds | `smoke:web` step 4 |
| Requests fail outside the swap | Probe grade | Probe |
| A web release restarted the backend | Container ids unchanged | Live check 6 |
| The public site is broken after the swap | Automatic rollback, non-zero exit | `smoke:web` step 6, W11 |
| A file in the container changed after start | Read-only root filesystem. Served bytes against the manifest | Container, live check 3 |

## 6. Design rationale

| Choice | Reason |
|---|---|
| One container role, not a front door plus web containers | One role is simpler to run and to reason about. The cost is the gap, which is short |
| A swap, not a copy into a running container | A container must map to one version (R5) |
| A measured gap, not zero downtime | Zero downtime needs a second component that holds the port, or a change to the tunnel or the host firewall |
| Server config belongs to the platform | Headers and routes are a security boundary. They take the full platform rehearsal |
| A platform release keeps the serving bundle | The site ships on its own schedule. A platform release must not undo a web release |
| The API owns its cache | Caching is the API's business logic. A cache in the web server can outlive a deploy and serve old answers |
| Build on the control machine, not on the host | A dependency install must not run beside live services, and stage and production must get the same bytes |
| SSH signatures with an ed25519 key | OpenSSH is already on the control machine and every host, so signing adds no component |
| Sign on the control machine, not in CI | The control machine already holds release authority. CI holds no signing key and no deploy credential |

## 7. Deferred review

- **Script policy on dapp pages.** Dapp pages keep the two script exceptions in section 3.3. Whether a page that
  signs transactions should forbid `eval` and every third-party script is reviewed once the wallet kit's needs
  are known.

## 8. Related

- `docs/decisions.md` D54 (the site is its own release unit), D61 (agent-executed releases), D70, D81 (the web
  release line)
- `docs/technical/static-asset-cache.md` (cache layers and header values)
- `docs/technical/release-runbooks.md` (release rules and the web content release)
- `docs/technical/smoke-production-spec.md` (`bun smoke:web`)
