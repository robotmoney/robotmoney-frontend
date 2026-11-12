# Web serving architecture: signed bundles in one immutable container

Status: decided 2026-11-12 (owner design review). **Not implemented yet.** Today's mechanism (section 2) stays in
force until the work in section 10 lands. Open questions are in section 11.

## 1. Why this changes now

The site will host dapp surfaces: pages where a visitor connects a wallet and signs transactions (the deposit page is
the first). On such a page the JavaScript we serve decides what the visitor signs. A changed file can move a
visitor's funds. So the web deployment needs the same care as the backend:

- What production serves must trace back to one reviewed commit.
- Nobody, and no script, may change the served files after they are checked.
- A bad release must be easy to undo.

Today's mechanism does not meet these. This document records the design the owner chose to replace it.

## 2. What we have today

| Part | Today |
|---|---|
| Server | `website-server` is `nginx:1.27-alpine` with `website-server/nginx.conf` |
| Site files | Built **on the production host** at deploy time by `scripts/static-assembly.sh`, after `bun install` there |
| Where files live | A host directory, bind-mounted read-only into the container at `/srv/web` |
| Deploy | `bun smoke:web` installs `web/<version>-<commit>/`, swaps the `web/current` symlink, runs `nginx -s reload` |
| Integrity | None. The files are not signed. The container id says nothing about which site it serves |
| Other nginx duties | Proxies `/api/`, `/health` and `/version`; sets the client IP; caches `/api/public/analytics/*`; serves the maintenance answer |

Weak points for a dapp surface:

1. **The build runs on the production host.** A dependency install runs next to live services.
2. **The served directory is mutable.** Anything with host access can change a file with no trace.
3. **No signature.** We cannot prove that the served site equals a tagged commit.
4. **The container is not the version.** Two hosts with the same image can serve different sites.

## 3. Decisions

Each line is an owner decision from the 2026-11-12 review.

1. **Signed, versioned bundles.** Each web release is one `robotmoney-web-<version>-<commit>.tar.gz`, built once in
   CI, with a sha256 digest and a signature.
2. **No nginx.** One small static server replaces it.
3. **Files live in the container.** No host mount.
4. **Containers are static.** Nothing is copied into a running container. A container id maps to one web version.
5. **One container role.** The same container serves the site, proxies the API and holds the public port. There is
   no second front-door container.
6. **One external server component.** Not nginx plus another server.
7. **No change to the Cloudflare tunnel.** It keeps forwarding to the same origin port.
8. **A short gap per release is accepted.** Swapping the container drops requests for a moment (section 7).
9. **The API owns its own cache.** The analytics response cache moves out of the web server and into the API. The
   cache empties on every API start, and that is wanted.

The proposed server is **Caddy**, pinned by image digest, with its admin API and automatic HTTPS turned off. It is
one Go binary, so the image still carries no Bun or Node runtime (issue 892). This choice is a proposal until the
route and header test in section 10 passes against it.

## 4. The design

```
CI (release commit)                  production host
┌──────────────────────┐            ┌───────────────────────────────────────┐
│ static-assembly.sh   │            │ verify signature + digest + apiRange  │
│ pack bundle          │  bundle    │ build image (bundle baked in)         │
│ digest + sign        │ ─────────► │ check a throwaway copy                │
│ attach to release    │            │ swap the container on the public port │
└──────────────────────┘            │ check the public site, revert if bad  │
                                    └───────────────────────────────────────┘

Cloudflare tunnel ─► website-server (one container, immutable)
                       ├─ static files and headers, from the baked bundle
                       ├─ /api/, /health, /version ─► api
                       └─ maintenance answer when the api is down
```

### 4.1 The bundle

- Built in CI from the output of `scripts/static-assembly.sh`. Never built on the production host.
- Deterministic: packing the same tree twice gives the same bytes.
- Its `version.json` names the version, commit and `apiRange`. The file name must match it.
- Built for the release commit, before stage runs, so stage and production deploy the same bytes (section 6.2).
- Attached with its digest and signature to the `web-vA.B.C` release once the tag is cut.

### 4.2 The container

- Its image bakes exactly one verified bundle.
- Labels name the web tag, the commit and the bundle digest.
- No volume. Nothing is written into it after it starts.
- It holds the public port (8080 inside the container).

### 4.3 What happens to each nginx duty

| Duty in `nginx.conf` today | Owner after the change |
|---|---|
| Static files, the fallback chain to `_shell.html`, the missing-asset 404 rule | The new server's config |
| `Cache-Control` values, CSP and security headers | The new server's config |
| `/version.json`, `sitemap.xml`, prerendered routes | Files in the bundle |
| Proxy of `/api/`, `/health`, `/version` (keeps the Host header for WebAuthn) | The new server's config |
| Client IP headers (`X-Client-IP`, `CF-Connecting-IP`) | The new server's config |
| Maintenance answer and 503 with `Retry-After` when the api is down | The new server's config |
| Response cache for `/api/public/analytics/*` | **The API** (section 8) |
| Graceful reload on a site switch | Replaced by the container swap (section 5) |

## 5. Release and rollback

`bun smoke:web` runs these steps for a named bundle:

1. Verify the signature, the digest and `version.json`. Check `apiRange` against the running API (D54).
2. Build the image.
3. Start a throwaway copy on a spare port. Check that `/version.json` names the tag and that the route and header
   test passes. Remove the copy.
4. Stop the old container. Start the new one on the public port.
5. Check through the public origin.
6. If step 5 fails, start the previous image on the public port and exit non-zero.
7. If step 5 passes, keep the previous image as the rollback target.

`bun smoke:web --rollback` runs steps 3 to 5 with the previous image.

Why the throwaway copy is a valid check: it runs the same image as the container that will serve. The image cannot
change between the check and the swap.

## 6. The runbook: how an agent ships it

Releases here are run by an agent from a runbook, not by a person from memory. That is how we ship, and this design
is built to fit it. The rules live in [release-runbooks.md](./release-runbooks.md). The ones that shape this design:

- **An agent executes every step** (D61). The operator gives one recorded go before the run. No step asks a person
  to log in to a host. Everything runs from the control machine over SSH.
- **The runbook is a YAML step list.** Each step has an id, a command, an expected exit and receipts. A run keeps a
  journal. A rerun continues at the first step that is not done.
- **Stage first, with the same steps.** Production runs what stage passed, unchanged.
- **A check with no tool is a gap.** A gap is closed by a pull request to the runbook, never by a hand-run command.
- **A failure reverts by a step,** not by judgement: the runbook names the rollback command.

A design that needs a person to inspect, decide or type on a host does not fit. Each part of this design is
therefore a command with a pass or fail answer and a receipt.

### 6.1 The two web runbooks today

| Runbook | Runner | Used for |
|---|---|---|
| `scripts/release/runbooks/web-content.yaml` (W01 to W12) | `bun run release:web` | A content-only release cut from `main` commits (D81) |
| `scripts/release/runbooks/templates/web.yaml` (Q and C steps) | `bun run release:run` | A platform release that ships only the website (v0.7.4 was the first) |

The full platform template, `kitchen-sink.yaml`, also switches the site (Q24-site on stage, C12-site on
production). All three call `bun smoke:web`, so one change to that command reaches all of them.

### 6.2 What the new design gives the runbook

1. **Stage tests the exact bytes production gets.** Today stage and production each build the site on their own
   host, so the two builds can differ. With a bundle, stage deploys a digest, and production deploys the same
   digest. The stage pass is recorded for that digest.
2. **Checks compare against a signed reference.** Today the live check compares served files with the host's own
   copy. After the change it compares them with the signed bundle's manifest.
3. **The agent can prove what runs.** The container's labels name the tag, the commit and the bundle digest. One
   read-only command answers "what is production serving".
4. **Rollback is one command with a known target.** The previous image already passed its checks.
5. **No build on a host.** The site build and its dependency install leave the production host.

### 6.3 How the web content steps change

This table is a proposal. The step ids stay; the work inside each step changes.

| Step | Today | After the change |
|---|---|---|
| W01-preflight | Reads `web/current` and `web/previous` on the host. Refuses with no rollback target | Reads the running container's labels and the kept previous image. Refuses with no rollback target |
| W02-branch | Pushes the cherry-picked commit to `web/releases-A.B.x` | Unchanged |
| W03-gate | `web-client` and `e2e-web` pass on the release commit | The same, and CI packs, signs and publishes the bundle for the release commit |
| W04-stage-up | Stage target at production's commit, from a fresh production dump | Unchanged |
| W05-stage-deploy | Checkout, `bun install`, then `smoke:web` builds the site on the stage host | `smoke:web` verifies the bundle, builds the image, checks a copy and swaps the container |
| W06-stage-check | Live check against the stage origin. Records a pass for the commit | Live check against the bundle's manifest. Records a pass for the bundle digest |
| W07-tag | Pushes `web-vA.B.C` | Unchanged. The tag's release carries the stage-passed bundle, digest and signature |
| W08-tag-guard | Tag rule passes | The same, and the attached bundle's digest equals the stage-passed digest |
| W09-checkout | Checkout and `bun install` on the production host | Checkout of the release tooling only. No site build |
| W10-deploy | `smoke:web` builds the site, swaps the symlink, reloads nginx | The release flow in section 5, with the gap measured and recorded |
| W11-live-check | `/version.json`, served bytes against the host's copy, sitemap routes, backend unchanged | `/version.json`, served bytes against the bundle's manifest, container labels equal the bundle digest, the header table, sitemap routes, `api` and workers unchanged |
| W12-release | GitHub release notes | The same, naming the bundle digest |

A failure in W11 runs `bun smoke:web --rollback`, as today. No step from W07 on writes unless a stage pass is
recorded for the same bundle digest.

### 6.4 What changes in the platform runbooks

- **Site step (Q24-site, C12-site).** It deploys a named bundle through the same `smoke:web`. Which bundle a
  platform release deploys is an open question (section 11).
- **Probe (Q17 and Q25, C04 and C13).** The probe runs around the swap. Its grade excuses exactly the declared
  swap gap, read from the release receipt, and fails any failed request outside it.
- **Breaking cutover (C05b-smoke-down).** It stops every service except `website-server`, so the probe sees the
  maintenance answer and not a 502. The grade requires that answer inside the window.
- **Log verdict.** The gate's nginx access-log classes are replaced by the new server's log format.

### 6.5 Faults the runbook must catch

Each row is a check the runbook runs. A row with no tool today is a gap to close before the design ships.

| Fault | Step that catches it | Tool today |
|---|---|---|
| The bundle was changed after CI built it | Signature and digest check before the image is built | Gap |
| The site needs a newer API than production runs | `apiRange` check in `smoke:web` | Exists |
| The new image serves wrong routes or headers | Check of the throwaway copy, before any traffic | Gap |
| A CSP change blocks a dapp page | The header table in the live check | Gap |
| Production serves bytes that differ from the release | Served bytes against the bundle manifest | Exists, against the host's copy |
| The running container is not the released version | Container labels against the bundle digest | Gap |
| The swap takes too long | Measured gap over three seconds fails the step | Gap |
| A web release restarted the backend | `api` and worker container ids unchanged | Exists |
| The public check fails after the swap | Automatic rollback, then a non-zero exit | Exists, by symlink |

### 6.6 Runner defects to fix first

The runbook is only as good as its runner. Recent runs failed more often on the runner than on the product, and
each false failure ends in an accepted step. These are open and should land before this design:

- The probe grade on production reads the skipped stage step and excuses nothing (issue 1502).
- A breaking cutover serves a 502 where the maintenance page should be (issue 1501).
- A stage resume at a new commit leaves the old checkout in place (issue 1585).
- `analytics-load-check.ts` passes and then never exits (issue 1597).

Two were fixed on 2026-11-12 (PR 1618): a retried run's stale probe, and the web template's log window.

## 7. The accepted gap

Docker gives a published port to one container at a time. So between "stop old" and "start new" nothing listens, and
requests fail. API calls fail in that gap too, because the same container proxies them.

- The gap is expected to be one to two seconds. **This is an estimate and has not been measured.**
- A test fails the release tooling if the gap exceeds three seconds, or if any request fails outside the gap.
- Every release receipt records the measured gap.
- A rollback costs a second gap.

If the measured gap proves harmful to member agents, a small port-holding proxy can be added later. The image does
not change in that case.

## 8. The API owns its cache

nginx stores answers for `/api/public/analytics/*` on disk for up to seven days. It also makes identical cold
requests wait for one database query. The API already sets `Cache-Control` and `ETag` on these routes; nginx only
obeys them.

After the change the API does both jobs in process:

- A small store keyed by request URL, with a fixed memory cap.
- One shared database query for identical requests that arrive together.
- `X-Cache-Status` still says `HIT` or `MISS`.

The cache is empty after every API start. That is the wanted behaviour: a disk cache that outlives a deploy can
serve answers computed by the old code.

This work ships in a platform release **before** nginx is removed.

## 9. Options considered and rejected

| Option | Why not |
|---|---|
| Keep nginx as a proxy, add a second server for files | Two external components. Over-engineered for this site |
| A `front` container that holds the port, plus `web` containers behind it (zero gap) | A second container role and a pointer to track. The short gap is acceptable |
| Copy each new bundle into one long-lived container | The container would no longer map to one version. Containers must be static |
| Change the published port of a running container | Docker cannot do this. Ports are fixed when a container is created |
| Swap a Docker network name behind a containerized Cloudflare tunnel | Needs changes to the tunnel setup |
| Host networking with a shared port | Loses Docker's network isolation. Both versions would answer during the overlap |
| A firewall redirect on the host | Needs root on the production host |

## 10. Order of work

1. **API cache.** The API caches its public analytics answers; the nginx cache is removed (platform release).
2. **Route and header test.** One table test that passes against today's nginx image. It is the contract the new
   server must meet unchanged: `/`, a prerendered route, a client route from `_shell.html`, an asset, a missing
   asset, `/version.json`, `/sitemap.xml`, the CSP and the security headers.
3. **Bundle.** Pack, digest, sign and verify in CI for the release commit.
4. **New server.** It replaces nginx in the image and passes the test from step 2.
5. **Baked bundle and swap.** The image bakes the bundle; `bun smoke:web` swaps containers, measures the gap and
   reverts on a failed check.
6. **Cleanup.** Delete the bind mount and the nginx leftovers. Update the runbooks, D54 and D81.

A breaking platform cutover must keep this container running while the rest of the stack is down, so visitors get
the maintenance page and not a 502 (issue 1501).

## 11. Open questions

- **Signing scheme.** Proposed: cosign keyless through GitHub OIDC, so no private key is stored. Not decided.
- **How many old images to keep for rollback.** Proposed: one. Not decided.
- **The release tooling still installs on the host.** `bun smoke:web` runs from a checkout on the host after
  `bun install`. The site build leaves the host; the tooling install does not. Whether to remove it is not decided.
- **Does a platform release still deploy the site?** Today its site step redeploys the platform tree's `frontend/`
  and can undo a newer web release. Tracked by the research issue on platform and web tags (1598).
- **Headers and routes are not web content today.** The server config is outside `WEB_CONTENT_PATHS`, so a CSP
  change needs a platform release. Whether the config ships with the bundle is not decided.

## 12. Related

- `docs/decisions.md` D54 (the site is its own release unit), D61, D70, D81 (the web release line)
- `docs/technical/static-asset-cache.md` (cache layers and header values)
- `docs/technical/release-runbooks.md` section 12 (web content releases)
- `docs/technical/smoke-production-spec.md` section 13 (`bun smoke:web`)
- Issues: signed bundles (1605), cutover 502 (1501), platform and web tags (1598), wallet kit CSP (1615)
