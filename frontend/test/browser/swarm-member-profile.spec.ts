import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation.ts";

// Read-precedence coverage for the public member profile (/swarm/members/:ref),
// issue #595.
//
// memberProfile.init() used to read the shipped static manifest
// (/data/swarm/manifests/members/<id>.json) BEFORE the live API, so a renamed
// member served two contradictory public profiles: the handle URL missed the
// archive and rendered the live row, while the legacy-id URL hit the manifest
// and rendered the pre-rename record forever. Both returned 200. Migration
// 0030 keeps the legacy id resolving on purpose ("no URL that has ever been
// published stops working"), so that address is a first-class public one and
// its staleness is a stated-requirement gap.
//
// The two tests below are the two halves of the fix, and neither is meaningful
// without the other:
//   1. live-first — the LIVE record wins on BOTH addresses. The fixture is
//      deliberately DIFFERENT from the shipped manifest (asserted here, not
//      assumed) — a fixture that agreed with the manifest would pass under the
//      old archive-first ordering too and prove nothing.
//   2. archive-fallback — with the swarm API unreachable, all four shipped
//      manifests still render. This is the constraint that stops the fix from
//      being "delete the archive": the site is also published statically with
//      no backend behind it, and these manifests are what make that work.
//
// Follows swarm-subject.spec.ts's pattern: drive the real, shipped render path
// against the live SPA served at baseURL, and control the data path with
// page.route rather than depending on whatever the demo stack seeded.

// The browser (not app code) logs a console error for every non-2xx or failed
// network request, regardless of whether the app handled it. Both tests force
// swarm API calls to fail on purpose, and the archive path makes best-effort
// lookups that legitimately 404 — expected, browser-generated noise. Same
// exclusion swarm-subject.spec.ts carries, widened to cover `route.abort()`
// (net::ERR_FAILED), which is how the second test spells "no backend".
const EXPECTED_NETWORK_NOISE =
  /^console: Failed to load resource: (the server responded with a status of \d+|net::ERR_[A-Z_]+)/;

function failOnBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
  return errors;
}

async function expectNoBrowserErrors(errors: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors.filter((e) => !EXPECTED_NETWORK_NOISE.test(e))).toEqual([]);
}

// The four members with a manifest committed under
// frontend/public/data/swarm/manifests/members/. `athena` and `robotmoney` are
// also live seated members (backend/src/swarm/roster-seed.ts), which is exactly
// what made the stale shadow read reachable in production.
const SHIPPED_MANIFEST_IDS = ["athena", "robotmoney", "noop-analyst", "woon"] as const;

type Manifest = { name: string; tagline: string; lens: string; biases: string[]; handle?: string };

async function shippedManifest(page: Page, id: string): Promise<Manifest> {
  const res = await page.request.get(`/data/swarm/manifests/members/${id}.json`);
  expect(res.ok(), `shipped manifest for ${id} must be served`).toBe(true);
  return res.json();
}

// What the DATABASE holds for `athena` after an operator renames it: the
// immutable id is unchanged, the public handle is new, and the editable profile
// fields have moved on. Every displayed field differs from athena.json.
const RENAMED_ATHENA = {
  id: "athena",
  handle: "macro-desk",
  status: "active",
  name: "Macro Desk",
  tagline: "Renamed live record. Reads the composite from the macro desk.",
  lens: "macro regime",
  mandate: "Live mandate, edited after the rename and never written back to the shipped manifest.",
  biases: ["live-only-bias-a", "live-only-bias-b", "live-only-bias-c"],
  mode: "submit",
  operator: "live-operator",
};

// Everything the page renders off `member`, captured from the DOM so the two
// addresses can be compared as whole records rather than field by field.
async function renderedProfile(page: Page) {
  return {
    name: await page.locator(".profile-name").innerText(),
    tagline: await page.locator(".profile-role").innerText(),
    eyebrow: await page.locator(".cv--detail .sv__eyebrow").innerText(),
    mandate: await page.locator(".sv__panel", { hasText: "Mandate" }).locator(".sv__body-copy").innerText(),
    biases: await page.locator(".sv__panel", { hasText: "Biases" }).locator("li").allInnerTexts(),
    meta: await page.locator(".sv__plugin .sv__meta-grid dd").allInnerTexts(),
  };
}

test("a renamed member's legacy-id URL and handle URL both render the LIVE record, not the shipped manifest", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  // The fixture only proves something if it DISAGREES with the committed
  // manifest — under the old archive-first ordering the legacy-id page never
  // read the API at all, so a matching fixture would have passed unchanged.
  const manifest = await shippedManifest(page, "athena");
  expect(manifest.name).not.toBe(RENAMED_ATHENA.name);
  expect(manifest.tagline).not.toBe(RENAMED_ATHENA.tagline);
  expect(manifest.lens).not.toBe(RENAMED_ATHENA.lens);
  expect(manifest.biases).not.toEqual(RENAMED_ATHENA.biases);
  // The manifests predate the handle column entirely (#593), so the archive can
  // never even express the rename.
  expect(manifest.handle).toBeUndefined();

  // Serve the renamed row on BOTH public addresses, exactly as the backend does
  // (`WHERE m.handle = $1 OR m.id = $1`). Everything else on /api/swarm/** is
  // failed so no other live data can quietly satisfy an assertion.
  await page.route("**/api/swarm/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (/\/api\/swarm\/members\/(athena|macro-desk)$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RENAMED_ATHENA) });
    }
    if (/\/api\/swarm\/members\/(athena|macro-desk)\/takes$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ takes: [] }) });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  // The legacy id — the address with a shipped manifest sitting behind it, and
  // the one the migration deliberately keeps alive.
  await page.goto("/swarm/members/athena");
  await expect(page.locator(".profile-name")).toHaveText(RENAMED_ATHENA.name);
  const legacy = await renderedProfile(page);
  // Nothing from the pre-rename manifest survives anywhere on the page.
  await expect(page.locator(".cv--detail")).not.toContainText(manifest.name);
  await expect(page.locator(".cv--detail")).not.toContainText(manifest.tagline);
  for (const bias of manifest.biases) {
    await expect(page.locator(".sv__panel", { hasText: "Biases" })).not.toContainText(bias);
  }
  // The tab name is derived from the record too (route-level SEO otherwise
  // titleizes the raw URL segment). Polled: seo.js and memberProfile.init()
  // both write it, in that order.
  await expect.poll(() => page.title()).toContain(RENAMED_ATHENA.name);

  // The new public handle.
  await page.goto("/swarm/members/macro-desk");
  await expect(page.locator(".profile-name")).toHaveText(RENAMED_ATHENA.name);
  const handleUrl = await renderedProfile(page);

  // One member, one record, whichever of its two published URLs a reader has.
  expect(legacy).toEqual(handleUrl);
  expect(legacy.tagline).toBe(RENAMED_ATHENA.tagline);
  expect(legacy.mandate).toBe(RENAMED_ATHENA.mandate);
  expect(legacy.biases).toEqual(RENAMED_ATHENA.biases);
  expect(legacy.meta).toContain(RENAMED_ATHENA.operator);

  await expectNoBrowserErrors(errors);
});

test("with the swarm API unreachable, all four shipped manifests still render from the static archive", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  // `abort` rather than a 503 body: this is the statically-published checkout
  // with nothing behind /api at all. The member profile talks to no endpoint
  // outside /api/swarm/**, so failing that prefix is exactly "no backend
  // reachable" as far as this page is concerned.
  await page.route("**/api/swarm/**", (route) => route.abort("failed"));

  for (const id of SHIPPED_MANIFEST_IDS) {
    const manifest = await shippedManifest(page, id);
    await page.goto(`/swarm/members/${id}`);

    await expect(page.locator(".profile-name"), `${id} name`).toHaveText(manifest.name);
    await expect(page.locator(".profile-role"), `${id} tagline`).toHaveText(manifest.tagline);
    await expect(page.locator(".cv--detail .sv__eyebrow"), `${id} lens`).toContainText(manifest.lens);
    const biases = page.locator(".sv__panel", { hasText: "Biases" }).locator("li");
    await expect(biases, `${id} biases`).toHaveCount(manifest.biases.length);
    for (const bias of manifest.biases) {
      await expect(page.locator(".sv__panel", { hasText: "Biases" })).toContainText(bias);
    }
  }

  await expectNoBrowserErrors(errors);
});

// The other consequence of "no URL that has ever been published stops working":
// one member is TWO indexable URLs. The test above proves both render the same
// record — which is the thing that makes them duplicates rather than two pages.
// Only one of them may claim to be the address.
test("both of a member's public URLs name the handle form as canonical", async ({ page }) => {
  const errors = failOnBrowserErrors(page);

  await page.route("**/api/swarm/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (/\/api\/swarm\/members\/(athena|macro-desk)$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RENAMED_ATHENA) });
    }
    if (/\/api\/swarm\/members\/(athena|macro-desk)\/takes$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ takes: [] }) });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  const canonical = () => page.locator('link[rel="canonical"]').getAttribute("href");
  const ogUrl = () => page.locator('meta[property="og:url"]').getAttribute("content");
  const expected = "https://robotmoney.network/swarm/members/macro-desk";

  // Polled, not read once: applyRouteMeta() writes the VISITED url on
  // navigation and memberProfile.init() corrects it to the handle form after
  // the record arrives, so the assertion has to outlast the first write.
  //
  // The third address is the pre-rename product name. routes.js rewrites
  // /committee/** to /swarm/** and serves the same page, so it is a third
  // published URL for this one member and has to converge on the same answer.
  for (const address of ["/swarm/members/athena", "/swarm/members/macro-desk", "/committee/members/athena"]) {
    await page.goto(address);
    await expect(page.locator(".profile-name")).toHaveText(RENAMED_ATHENA.name);
    await expect.poll(canonical, { message: `canonical on ${address}` }).toBe(expected);
    await expect.poll(ogUrl, { message: `og:url on ${address}` }).toBe(expected);
  }

  await expectNoBrowserErrors(errors);
});

// The archive fallback carries no `handle` (the manifests predate the column),
// so there is no better address to point at than the one being visited. The
// correction must SKIP rather than emit `/swarm/members/undefined`.
test("a member served from the static archive keeps the visited URL as canonical", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  await page.route("**/api/swarm/**", (route) => route.abort("failed"));

  await page.goto("/swarm/members/noop-analyst");
  await expect(page.locator(".profile-name")).toBeVisible();
  await expect
    .poll(() => page.locator('link[rel="canonical"]').getAttribute("href"))
    .toBe("https://robotmoney.network/swarm/members/noop-analyst");

  await expectNoBrowserErrors(errors);
});

// memberProfile.init() names the page after the record it fetched, which means
// it writes AFTER an await. The router tears a view down on navigation but
// cannot cancel that in-flight fetch, so a slow member response would otherwise
// land its title and canonical on whatever route the visitor moved on to,
// leaving a real indexed page declaring itself a duplicate of a member profile.
// Same cross-route leak spa.spec.ts pins for the `robots` directive.
test("a slow member fetch does not stamp its identity on the route the visitor moved to", async ({ page }) => {
  const FETCH_DELAY_MS = 2500;

  await page.route("**/api/swarm/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (/\/api\/swarm\/members\/athena$/.test(pathname)) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RENAMED_ATHENA) });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  // Leave before the member resolves.
  await page.goto("/swarm/members/athena");
  await navigate(page, "/faq");

  const FAQ_URL = "https://robotmoney.network/faq";
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", FAQ_URL);
  const faqTitle = await page.title();
  expect(faqTitle).not.toContain(RENAMED_ATHENA.name);

  // Outlast the fetch, then confirm nothing moved. Read after the delay rather
  // than polling for a negative, which would pass simply by being early.
  await page.waitForTimeout(FETCH_DELAY_MS + 1500);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", FAQ_URL);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", FAQ_URL);
  expect(await page.title()).toBe(faqTitle);
});

// #687: a ref that resolves on neither the live API nor the static archive
// used to render a blank profile. It now renders the committee roster IN
// PLACE at the requested URL — no redirect, so the URL keeps the failed ref
// for a future "did you mean" affordance — while the API answers 404, not a
// silent 200 (the mistake #603 made). A ref that DOES resolve is the separate,
// unchanged code path the two tests above already cover.
const ROSTER_FIXTURE = [
  { id: "r1", handle: "robot-money", name: "Robot Money", lens: "macro regime", tagline: "Reads the composite." },
  { id: "r2", handle: "athena", name: "Athena", lens: "on-chain flow", tagline: "Reads wallet flow." },
];

test("an unresolvable member ref answers 404 and renders the committee roster in place, not a blank profile", async ({ page }) => {
  const errors = failOnBrowserErrors(page);
  let memberRouteStatus: number | null = null;

  await page.route("**/api/swarm/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/swarm/members") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ members: ROSTER_FIXTURE, rosterCap: 10, seatsFilled: 2, seatsAvailable: 8 }),
      });
    }
    if (pathname === "/api/swarm/members/not-a-real-member-anywhere") {
      memberRouteStatus = 404;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  // No shipped manifest exists for this ref, so the archive fallback also
  // legitimately misses (a real, expected 404 against /data/swarm/**).
  await page.goto("/swarm/members/not-a-real-member-anywhere");

  // The requested URL is unchanged — render in place, not a redirect.
  await expect(page).toHaveURL(/\/swarm\/members\/not-a-real-member-anywhere$/);
  expect(memberRouteStatus).toBe(404);

  // No blank/error profile: the committee roster renders instead, reachable
  // by each member's current handle (same link shape the /swarm directory's
  // Members panel uses).
  await expect(page.locator(".profile-name")).toHaveCount(0);
  await expect(page.locator(".sv__panel", { hasText: "Committee members" })).toContainText("not-a-real-member-anywhere");
  for (const m of ROSTER_FIXTURE) {
    const link = page.locator(`a.sv__row-title[href="/swarm/members/${m.handle}"]`);
    await expect(link).toHaveText(m.name);
  }

  await expectNoBrowserErrors(errors);
});
