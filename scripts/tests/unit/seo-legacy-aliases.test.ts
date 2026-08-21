import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaFor, canonicalUrlFor } from "../../../frontend/public/assets/js/app/seo.js";
import { viewFor } from "../../../frontend/public/assets/js/app/routes.js";

// seo.js keeps its own copy of routes.js's legacy path rewrites (LEGACY_ALIASES),
// deliberately: seo.js is imported by the deploy-time prerenderer under Bun,
// where routes.js's browser-facing view resolution has no business running. The
// stated cost is that "the two lists must be kept in step" — and nothing was
// enforcing it. /allocation2 and /articles/treasury-allocation were rewritten by
// routes.js but absent from seo.js, so the full treasury-allocation blog post
// was served under `<title>Page Not Found</title>` and `noindex, follow`, on a
// URL that is still live on robotmoney.network and cited inline by the archived
// swarm sessions.
//
// The first two tests derive the alias set from routes.js's source, so a rewrite
// added there in future fails here until seo.js learns about it. The third pins
// the behaviour of the four that exist today.

const routesSrc = readFileSync(
  join(import.meta.dir, "../../../frontend/public/assets/js/app/routes.js"),
  "utf8",
);

test("every prefix rewrite in viewFor() is mirrored by seo.js", () => {
  // The rewrite block at the top of viewFor(): `pathname === "/old"` guarding a
  // `return viewFor("/new" + pathname.slice(...))`. Structurally uniform, which
  // is what makes it readable from source.
  const pairs = Array.from(
    routesSrc.matchAll(
      /pathname === "(\/[^"]+)"[^)]*\)\)\s*\{\s*return viewFor\("(\/[^"]+)" \+/g,
    ),
  ).map((m) => [m[1], m[2]] as [string, string]);

  expect(pairs.length).toBeGreaterThan(0); // the regex still matches the block
  for (const [from, to] of pairs) {
    expect({ from, canonical: canonicalUrlFor(from) })
      .toEqual({ from, canonical: canonicalUrlFor(to) });
  }
});

test("two ROUTES keys that render the same view declare one canonical between them", () => {
  const body = routesSrc.slice(routesSrc.indexOf("const ROUTES = {"));
  const keys = Array.from(
    body.slice(0, body.indexOf("\n};")).matchAll(/^\s*"(\/[^"]*)":/gm),
  ).map((m) => m[1]);
  expect(keys).toContain("/allocation2"); // the map is still shaped as assumed

  const byView = new Map<string, string[]>();
  for (const k of keys) {
    const v = viewFor(k);
    byView.set(v, [...(byView.get(v) ?? []), k]);
  }
  for (const [, sharing] of byView) {
    if (sharing.length < 2) continue;
    const canonicals = new Set(sharing.map(canonicalUrlFor));
    expect({ sharing, canonicals: canonicals.size }).toEqual({ sharing, canonicals: 1 });
  }
});

test("an aliased path inherits the renamed page's metadata rather than 404 metadata", () => {
  // One case per rename shape: the /committee -> /swarm tree rename (public and
  // admin halves), the doc tree's product-name path, the /allocation2 page
  // rename, and the /articles -> /blog move.
  const renames: [string, string][] = [
    ["/committee", "/swarm"],
    ["/admin/committee", "/admin/swarm"],
    ["/docs/investment-committee", "/docs/investment-swarm"],
    ["/allocation2", "/performance"],
    ["/articles/treasury-allocation", "/blog/treasury-allocation"],
  ];

  for (const [from, to] of renames) {
    // The premise: both addresses really do render the same page, and both 200.
    expect({ from, view: viewFor(from) }).toEqual({ from, view: viewFor(to) });
    // The fix: the old address points at the new one and inherits its metadata
    // — whatever that is — rather than describing itself.
    expect({ from, meta: metaFor(from) }).toEqual({ from, meta: metaFor(to) });
  }

  // And for the public ones, what it inherits is a real page. /admin/committee
  // is excluded on purpose: the admin tree is noindexed by the dashboard stub
  // prefixes, and inheriting THAT is the correct outcome for it.
  for (const [from] of renames.filter(([f]) => !f.startsWith("/admin"))) {
    expect({ from, robots: metaFor(from).robots ?? "index, follow" })
      .toEqual({ from, robots: "index, follow" });
  }
});
