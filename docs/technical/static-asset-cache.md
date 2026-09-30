# Static asset caching: what caches what, and what we choose

Status: decided 2026-09-30 (owner), implemented by the PR that adds this file. Measurements below are from
`https://robotmoney.network` on 2026-09-30. Statements about Cloudflare's *defaults* come from Cloudflare's documented
behavior and are consistent with those measurements; **the Cloudflare dashboard has not been inspected** (see §7).

## 1. The problem in one paragraph

A release changes HTML, CSS and JavaScript together. The HTML is never cached, so a reader gets the new page at once.
If the page then loads an **old copy** of a script or stylesheet from a cache, the new markup runs against old code: a
component the new page names (`x-data="regimeView()"`) may not exist, or exists in an old shape. This happened on
2026-08-28 (new markup against the previous stylesheet) and is the standing risk for JavaScript, which is not yet
stamped. The fix is that **every URL whose bytes change is a new URL**, so no cache, at any layer, can serve an old
copy of it.

## 2. The layers

| Layer | What it does here | Who controls it |
|---|---|---|
| Browser | Keeps files for the `max-age` it is told | The `Cache-Control` header it receives |
| Cloudflare edge | `robotmoney.network` and `.net` are proxied DNS names and all traffic enters through a Cloudflare Tunnel (`cloudflared` on the production host forwards to `127.0.0.1:48787`). So every request passes through Cloudflare's edge, which applies its caching defaults | The Cloudflare zone's settings (not in this repo) |
| nginx (`website-server`) | The origin. Serves the assembled `_static/` from a read-only bind mount. Sends `Cache-Control` | `website-server/nginx.conf` (in this repo) |

The tunnel configuration (`cloudflared.config.example.yml`) routes hostnames to an origin port and contains **no caching
settings**. Caching is a property of the zone, not of the tunnel.

## 3. What we measured (2026-09-30)

What nginx sends (asked on the host, bypassing Cloudflare) against what a reader receives:

| Path | nginx sends | Cloudflare status | Browser is told |
|---|---|---|---|
| `/` and every page (`/regime`, …) | `no-cache` | `DYNAMIC` (not cached) | `no-cache` |
| `*.js`, `*.css` (for example `main.js`, `views.css`) | `public, max-age=300` | `HIT` on the second request | **`public, max-age=14400`** |
| `robots.txt` | `max-age=300` | `HIT` | `max-age=14400` |
| `*.json`, `*.xml`, `llms.txt` (`version.json`, `sitemap.xml`) | `public, max-age=300` | `DYNAMIC` | `max-age=300` |
| A `404` for a cacheable extension (`favicon.ico`, a not-yet-deployed `.jpg`) | none | `HIT` (the 404 itself is cached) | `max-age=14400` |

Reading the table:

1. **Cloudflare caches by file extension.** Static-looking extensions (`js`, `css`, images, fonts, …) are cached;
   `html`, `json`, `xml` and `txt` are not (`robots.txt` is the one `.txt` that is, which we cannot explain from
   outside). This is Cloudflare's default "Standard" cache level; no rule is needed for it.
2. **The 4 hours is Cloudflare's Browser Cache TTL, whose default is 4 hours**, applied as a minimum: nginx's 300 s
   becomes 14400 s for the files it caches. JSON, XML and HTML keep nginx's value because they are not cached.
3. **A 404 for a URL that does not exist yet is cached like a file.** A request for a new asset before its deploy (a
   bot, a link preview, a person) can leave a cached 404 behind for a short while.

## 4. Decisions

| # | Asset | Decision | Why |
|---|---|---|---|
| C1 | HTML pages and view fragments (`views/*.html`) | **Never cached**: `Cache-Control: no-cache` (`location /` in nginx.conf). Unchanged | A release is visible on the next navigation |
| C2 | Stylesheets | **The URL carries a content hash**: `…/views.css?v=<first 8 of the file's sha256>` in `index.html`. Already in place; `frontend/test/browser/spa.spec.ts` ("every stylesheet is cache-busted by its own content hash") keeps it honest. Regenerate with the snippet above that test | A changed stylesheet has a new URL |
| C3 | **Application JavaScript** (`assets/js/app/**`, 92 files) | **Every import carries one build stamp**: `…/main.js?v=<stamp>`, and every relative `import … from`, `export … from` and literal `import()` inside the assembled files ends in the same `?v=<stamp>`. The stamp is the first 8 hex characters of a sha256 over the application JavaScript tree (sorted paths and contents), so it changes **if and only if** some application script changes. Applied to the **assembled** site (`scripts/static-assembly.sh`), never to the source files | The scripts are ES modules; `main.js` imports about 30 files by relative path, so stamping only the entry point stamps nothing behind it. One stamp on all of them gives every module exactly one URL, which keeps each module a singleton |
| C4 | Vendor scripts (`assets/js/vendor/*`) | **No stamp; the version is in the file name** (`p5-1.11.2.min.js`). Upgrading a vendor library renames the file | The name already changes when the bytes do |
| C5 | `config.js` | **Not stamped.** It is per-environment configuration substituted at deploy (`API_BASE_URL`) and changes almost never. Changing it is a deploy plus a check that the public URL serves the new bytes | It cannot carry a content hash that the source tree knows |
| C6 | Images, icons, `og-image.png` | **Not stamped.** Convention: **a changed image gets a new file name.** Never overwrite an image in place | Images are a small, rarely edited set; renaming is the one rule that works at every layer |
| C7 | `*.json`, `*.xml`, `llms.txt`, `openapi.json`, `version.json` | **Not stamped.** nginx's 300 s applies because Cloudflare does not cache these extensions | They are data, read by agents and crawlers, and short staleness is acceptable |
| C8 | Cloudflare | **We do not configure the cache and do not depend on it.** Correctness comes from C2 and C3, which hold whatever the zone is set to. Recommended (owner action, not code): set the zone's **Browser Cache TTL to "Respect Existing Headers"**, so browsers follow nginx's 300 s instead of 4 hours | A dashboard setting can change without a release; a URL that changes cannot be served stale |
| C9 | Releases | **No cache purge step.** A release that needs a purge to be correct is a release that has an unstamped URL | A purge is manual, global and forgettable |

## 5. How the stamp works (C3)

`scripts/static-assembly.sh` assembles `_static/` from `frontend/public`, writes `version.json`, then prerenders every
route. The stamping step runs **after the copy and before the prerender**, so the prerendered pages, which are cut from
`_static/index.html`, carry the stamped entry point.

1. Compute the stamp over `_static/assets/js/app/**/*.js`.
2. Rewrite every relative module specifier in those files to append `?v=<stamp>`: `import x from "./a.js"`,
   `import { y } from "../b.js"`, `export * from "./c.js"`, `export { z } from "./d.js"`, and `import("./e.js")` with a
   string literal. Specifiers that are absolute URLs, bare names or already stamped are left alone.
3. In `_static/index.html`, stamp `<script type="module" src="/assets/js/app/main.js">`. Vendor scripts and `config.js`
   are not touched (C4, C5).
4. **Fail the assembly** if a dynamic `import()` has a non-literal argument, or a relative specifier does not resolve to
   a file in the tree. Such a module could not be stamped, and a graph that is stamped except for one module is the
   failure this design exists to prevent.

Today the JavaScript tree has 221 static relative imports, 7 dynamic `import()` calls (all string literals), one entry
point, no workers or service workers, no `import.meta.url` URL construction, and no `<script>` tags in view fragments.
The guard in step 4 is what keeps that true.

The preview server (`scripts/preview-server.ts`, used by the browser tests) serves the **source** tree, which is
unstamped; the stamping exists only in the assembled output.

## 6. Failure modes and what catches each

| Failure | Consequence | Caught by |
|---|---|---|
| One import left unstamped | The module loads under two URLs: two instances, broken shared state | `scripts/tests/unit/stamp-assets.test.ts`, and a verifier run over the real assembled site that checks every relative specifier is stamped and resolves |
| The stamp does not change when a script does | The old graph is served | The stamp is computed from content, and the test changes one byte and expects a new stamp |
| A new URL was requested before its deploy and a 404 was cached | Readers get the 404 until it expires | Stamped URLs are new by construction: nothing has requested `main.js?v=<new stamp>` yet |
| An image is overwritten in place | Stale image for up to the cache lifetime | Convention C6; there is no mechanical guard |
| New HTML against old script | A component the page names is missing | C3, which removes the cause |

## 7. What we have not verified

- **The Cloudflare zone's settings.** Everything in §3 is from response headers. Whether a Cache Rule exists, and who set
  the Browser Cache TTL, needs someone with dashboard access: Caching → Configuration, and Rules → Cache Rules.
- **`robots.txt` being cached** when other `.txt` files are not.
- **The `.net` zone.** Only `robotmoney.network` was measured.

## 8. Checking it yourself

```
# Is a file cached, and for how long? Ask twice on one connection; the second shows HIT and an age.
curl -sI https://robotmoney.network/assets/js/app/main.js https://robotmoney.network/assets/js/app/main.js \
  | grep -iE "^(HTTP|cf-cache-status|cache-control|age)"

# What nginx itself sends (on the host, bypassing Cloudflare)
curl -sI http://127.0.0.1:48787/assets/js/app/main.js | grep -i cache-control

# After a deploy: the page must name the stamped entry point, and every import must be stamped
curl -s https://robotmoney.network/ | grep -o 'assets/js/app/main.js[^"]*'
```
