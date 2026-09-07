// Issue #805 — split from #800's Cluster A: PR #774 replaced /allocation
// with /vault and left allocation-view.spec.ts driving the route it had
// deleted. That should have gone loud. It did not, because `e2e` was already
// red for other reasons and nobody read it. The guard that matters is not
// "keep e2e green" (#802) — it is "would a route rename be caught, on a
// branch, before it merges", independent of whatever else is red.
//
// This lives in scripts/tests/unit (not frontend/test/browser) on purpose:
// it is pure static analysis over source text, no server, no Docker, no
// browser — so it runs on the unit tier, which gates every branch before
// merge (unlike e2e, whose gating status is its own separate question, see
// #803). A route rename is caught here whether or not e2e is currently
// healthy.
//
// Two checks, both derived from the app's own routing table (routes.js's
// `viewFor`, single source of truth — same principle spa.spec.ts's
// HERO_ROUTES already applies to the nav: derive, don't hand-maintain):
//
// 1. Every literal route a browser spec drives via navigate()/page.goto()
//    must resolve, through the real `viewFor()` the app runs, to a fragment
//    that (a) exists on disk and (b) is not the NOT_FOUND fragment — unless
//    the enclosing test's own title says it expects not-found. A route
//    rename that orphans a spec (the file is still shipped and unreachable,
//    the way views/vault.html deliberately is) or repoints it at 404 turns
//    this red.
//
// 2. Every `checkView("/views/...")` target in scripts/smoke-frontend-check.ts
//    must be a fragment SOME live e2e route still resolves to — reusing the
//    exact set built in check 1 as proof of reachability. This is the other
//    half of the incident: smoke-frontend-check.ts was verifying
//    /views/allocation.html, a fragment no route resolved to, and passed on
//    every run because it fetched the file by URL directly rather than
//    through the app's own resolution.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_FOUND_VIEW, viewFor } from "../../../frontend/public/assets/js/app/routes.js";

const repoRoot = join(import.meta.dir, "../../..");
const browserDir = join(repoRoot, "frontend/test/browser");
const publicDir = join(repoRoot, "frontend/public");
const smokeCheckPath = join(repoRoot, "scripts/smoke-frontend-check.ts");

interface RouteRef {
  file: string;
  line: number;
  route: string;
  testTitle: string;
}

// Matches navigate(page, "...") and page.goto("...") with a plain
// double-quoted literal. Template-literal calls (e.g. navigate(page,
// `/projects/${SLUG}`)) are not statically resolvable and are skipped —
// every spec file still has plenty of plain-literal navigations covering its
// own route, so this is not a coverage cliff, just an acknowledged gap.
const CALL_PATTERN = /(?:navigate\(page,\s*|page\.goto\()"([^"]+)"/;
// The nearest preceding `test(...)`/`test.only(...)`/`test.skip(...)`
// declaration on or above a call's line is treated as its enclosing test.
// Every spec in this repo either declares tests flatly or wraps them in a
// plain `describe`/for-loop — no call in this suite sits between two test
// declarations that both claim it, so a simple "most recent title seen"
// scan is exact here, not just a heuristic.
const TEST_TITLE_PATTERN = /^\s*test(?:\.only|\.skip)?\(\s*(?:"([^"]*)"|`([^`]*)`)/;

function isRoutePath(route: string): boolean {
  // Real app routes only: absolute, not the bare shell "/", and not a raw
  // static asset (page.goto("/index.html") is a full-document reload before
  // client-side navigation kicks in — it is not itself a routed view).
  return route.startsWith("/") && route !== "/" && !/\.[a-z0-9]+$/i.test(route);
}

function extractSpecRouteRefs(): RouteRef[] {
  const refs: RouteRef[] = [];
  const files = readdirSync(browserDir).filter((f) => f.endsWith(".spec.ts"));
  for (const file of files) {
    const lines = readFileSync(join(browserDir, file), "utf8").split("\n");
    let currentTitle = "(no enclosing test( found above this call)";
    for (let i = 0; i < lines.length; i++) {
      const titleMatch = lines[i].match(TEST_TITLE_PATTERN);
      if (titleMatch) currentTitle = titleMatch[1] ?? titleMatch[2] ?? currentTitle;

      const callMatch = lines[i].match(CALL_PATTERN);
      if (!callMatch) continue;
      const route = callMatch[1];
      if (!isRoutePath(route)) continue;
      refs.push({ file, line: i + 1, route, testTitle: currentTitle });
    }
  }
  return refs;
}

function extractSmokeCheckFragments(): { path: string; line: number }[] {
  const lines = readFileSync(smokeCheckPath, "utf8").split("\n");
  const pattern = /checkView\(\s*"(\/views\/[^"]+)"/;
  const fragments: { path: string; line: number }[] = [];
  lines.forEach((line, idx) => {
    const m = line.match(pattern);
    if (m) fragments.push({ path: m[1], line: idx + 1 });
  });
  return fragments;
}

const specRefs = extractSpecRouteRefs();
const smokeFragments = extractSmokeCheckFragments();
// Every fragment SOME e2e-driven route resolves to right now — the
// reachability proof check 2 leans on.
const reachableFragments = new Set(specRefs.map((r) => viewFor(r.route)));

interface RouteCheckResult {
  ok: boolean;
  view: string;
  reason?: string;
}

// The pure decision behind check 1, pulled out so it can be exercised
// directly (see "route-liveness rule" below) as well as against every real
// reference extracted above. A route passes when its fragment exists on disk
// and — unless the enclosing test's own title says it expects this — is not
// the NOT_FOUND fragment.
function checkRouteRef(route: string, testTitle: string): RouteCheckResult {
  const view = viewFor(route);
  const fragmentPath = join(publicDir, `.${view}`);
  if (!existsSync(fragmentPath)) {
    return {
      ok: false,
      view,
      reason: `"${route}" resolves to ${view}, which does not exist on disk. This spec drives a route the app no longer serves.`,
    };
  }
  const expectsNotFound = /not[\s-]?found/i.test(testTitle);
  if (view === NOT_FOUND_VIEW && !expectsNotFound) {
    return {
      ok: false,
      view,
      reason:
        `"${route}" (in test "${testTitle}") resolves to the NOT_FOUND fragment (${NOT_FOUND_VIEW}). ` +
        `If this route was intentionally retired, this navigation belongs in a test whose own title says ` +
        `so (e.g. contains "not-found"), or the spec should be retired along with the route.`,
    };
  }
  return { ok: true, view };
}

describe("a route rename must turn e2e red on a branch (issue #805)", () => {
  // A derived list that silently derives to nothing would pass everything
  // below vacuously — the exact failure shape this issue is about (a check
  // whose subject silently stopped existing, still green).
  test("browser specs reference a real, non-trivial number of routes", () => {
    expect(specRefs.length).toBeGreaterThan(50);
  });

  // ── The rule itself, exercised directly (not just against the current
  // repo's specs) — this is the "negative: a legitimate route addition does
  // not trip it" case from the test plan, plus a permanent regression test
  // for the unlabeled-404 shape the mutation drills below reproduce live. ──
  describe("route-liveness rule", () => {
    test("a live route with a real fragment, referenced by an ordinary test, passes — a legitimate route addition does not trip this", () => {
      // /faq is a real, currently-served route (catch-all -> views/faq.html)
      // that no route repoints to NOT_FOUND. Standing in for "a new page just
      // shipped and its spec navigates to it": exactly the case that must
      // stay green.
      const result = checkRouteRef("/faq", "renders the FAQ page");
      expect(result.ok).toBe(true);
      expect(result.view).not.toBe(NOT_FOUND_VIEW);
    });

    test("a route pinned to NOT_FOUND, driven by a test whose title doesn't say so, fails", () => {
      // /vault is genuinely pinned to NOT_FOUND_VIEW in routes.js today. A
      // test that hits it without an ordinary, non-"not-found" title is
      // exactly Cluster A's shape: a rename repointed the route and the spec
      // never noticed.
      const result = checkRouteRef("/vault", "renders the vault dashboard");
      expect(result.ok).toBe(false);
      expect(result.view).toBe(NOT_FOUND_VIEW);
    });

    test("the same NOT_FOUND route passes when the test's own title says it expects that", () => {
      const result = checkRouteRef("/vault", "/vault renders not-found, not the retired page still sitting in views/");
      expect(result.ok).toBe(true);
    });

    test("a route resolving to a fragment missing from disk fails", () => {
      const result = checkRouteRef("/this-route-has-no-fragment-anywhere", "renders something");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("does not exist on disk");
    });
  });

  for (const ref of specRefs) {
    test(`${ref.file}:${ref.line} navigates to "${ref.route}", which the app must still resolve to a real, shipped fragment`, () => {
      const result = checkRouteRef(ref.route, ref.testTitle);
      expect(result.ok, result.reason).toBe(true);
    });
  }

  test("smoke-frontend-check.ts asserts at least one view fragment", () => {
    expect(smokeFragments.length).toBeGreaterThan(0);
  });

  for (const frag of smokeFragments) {
    test(`smoke-frontend-check.ts:${frag.line} checkView("${frag.path}") targets a fragment some live e2e route still resolves to`, () => {
      expect(
        reachableFragments.has(frag.path),
        `smoke-frontend-check.ts checks ${frag.path} directly by URL, but no browser spec's ` +
          `route resolves there anymore — the smoke-check-verifying-a-fragment-nobody-is-served ` +
          `class of bug this issue calls out (smoke-frontend-check.ts once verified ` +
          `/views/allocation.html, a fragment no route resolved to, and passed on every run).`,
      ).toBe(true);
    });
  }
});
