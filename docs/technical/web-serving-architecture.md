# Web serving architecture: signed bundles in one immutable container

Status: decided 2026-11-12 (owner design review). **Not implemented yet.** Today's mechanism (section 2) stays in
force until the work in section 9 lands. Open questions are in section 10.

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
8. **A short gap per release is accepted.** Swapping the container drops requests for a moment (section 6).
9. **The API owns its own cache.** The analytics response cache moves out of the web server and into the API. The
   cache empties on every API start, and that is wanted.

The proposed server is **Caddy**, pinned by image digest, with its admin API and automatic HTTPS turned off. It is
one Go binary, so the image still carries no Bun or Node runtime (issue 892). This choice is a proposal until the
route and header test in section 9 passes against it.

## 4. The design

```
CI (web-v* tag)                      production host
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
- Published with its digest and signature on the `web-vA.B.C` release.

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
| Response cache for `/api/public/analytics/*` | **The API** (section 7) |
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

## 6. The accepted gap

Docker gives a published port to one container at a time. So between "stop old" and "start new" nothing listens, and
requests fail. API calls fail in that gap too, because the same container proxies them.

- The gap is expected to be one to two seconds. **This is an estimate and has not been measured.**
- A test fails the release tooling if the gap exceeds three seconds, or if any request fails outside the gap.
- Every release receipt records the measured gap.
- A rollback costs a second gap.

If the measured gap proves harmful to member agents, a small port-holding proxy can be added later. The image does
not change in that case.

## 7. The API owns its cache

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

## 8. Options considered and rejected

| Option | Why not |
|---|---|
| Keep nginx as a proxy, add a second server for files | Two external components. Over-engineered for this site |
| A `front` container that holds the port, plus `web` containers behind it (zero gap) | A second container role and a pointer to track. The short gap is acceptable |
| Copy each new bundle into one long-lived container | The container would no longer map to one version. Containers must be static |
| Change the published port of a running container | Docker cannot do this. Ports are fixed when a container is created |
| Swap a Docker network name behind a containerized Cloudflare tunnel | Needs changes to the tunnel setup |
| Host networking with a shared port | Loses Docker's network isolation. Both versions would answer during the overlap |
| A firewall redirect on the host | Needs root on the production host |

## 9. Order of work

1. **API cache.** The API caches its public analytics answers; the nginx cache is removed (platform release).
2. **Route and header test.** One table test that passes against today's nginx image. It is the contract the new
   server must meet unchanged: `/`, a prerendered route, a client route from `_shell.html`, an asset, a missing
   asset, `/version.json`, `/sitemap.xml`, the CSP and the security headers.
3. **Bundle.** Pack, digest, sign and verify in CI on a `web-v*` tag.
4. **New server.** It replaces nginx in the image and passes the test from step 2.
5. **Baked bundle and swap.** The image bakes the bundle; `bun smoke:web` swaps containers, measures the gap and
   reverts on a failed check.
6. **Cleanup.** Delete the bind mount and the nginx leftovers. Update the runbooks, D54 and D81.

A breaking platform cutover must keep this container running while the rest of the stack is down, so visitors get
the maintenance page and not a 502 (issue 1501).

## 10. Open questions

- **Signing scheme.** Proposed: cosign keyless through GitHub OIDC, so no private key is stored. Not decided.
- **How many old images to keep for rollback.** Proposed: one. Not decided.
- **Does a platform release still deploy the site?** Today its site step redeploys the platform tree's `frontend/`
  and can undo a newer web release. Tracked by the research issue on platform and web tags (1598).
- **Headers and routes are not web content today.** The server config is outside `WEB_CONTENT_PATHS`, so a CSP
  change needs a platform release. Whether the config ships with the bundle is not decided.

## 11. Related

- `docs/decisions.md` D54 (the site is its own release unit), D61, D70, D81 (the web release line)
- `docs/technical/static-asset-cache.md` (cache layers and header values)
- `docs/technical/release-runbooks.md` section 12 (web content releases)
- `docs/technical/smoke-production-spec.md` section 13 (`bun smoke:web`)
- Issues: signed bundles (1605), cutover 502 (1501), platform and web tags (1598), wallet kit CSP (1615)
