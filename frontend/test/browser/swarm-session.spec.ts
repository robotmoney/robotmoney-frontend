import { expect, test, type Page } from "@playwright/test";

// Issue #498 — browser coverage for the session-page data defects the v0
// archive backport exposed. The first two were previously proven only by an
// ad-hoc headless sweep over the imported archive; a sweep is not a CI check,
// so the behaviours are pinned here as executed assertions. DEFECTS 3 and 4
// come from the review-data-integrity pass on this PR (F2 and F4) — both are
// about a true value being rendered as a claim it does not support.
//
// DEFECT 1 — the target was missing. `bucket_weights` sessions drew
// "Recommended" alone: a session proposing 97/3 against a published 95/5
// target rendered as two bars with nothing to compare them to, so a reader
// could not see it deviated at all. The framework lives in
// /api/dashboards/allocation and the session view never fetched it.
//
// DEFECT 2 — five real sessions rendered "Session not found". The view carried
// two hardcoded archive boundaries that disagreed (archivePreferred() said
// "< 2026-07-01", the static archive ends at ARCHIVE_LAST_DATE = 2026-06-25),
// and the catch block deliberately did NOT retry the API for an
// archive-preferred date. Every date now goes to the API first and the static
// archive is a fallback, so 2026-06-26..06-30 — dates the database holds and
// the archive does not — reach their session.
//
// DEFECT 3 — every archived take was described as a failed signature check.
// `verified: false` had exactly one wording behind it ("this take's signature
// did not check out … treat it as unattributed"), and the 216 backported takes
// were never member-signed at all, so nothing was ever checked. Archival is now
// its own state, and both wordings are asserted below.
//
// DEFECT 4 — historical sessions were graded against today's target.
// /api/dashboards/allocation serves the single CURRENT framework row, so a
// 2026-05-25 session was being flagged "⚠ deviates from target" against a
// target published 2026-06-02 — and an admin edit rewrote that verdict
// retroactively.
//
// WHY THE API IS MOCKED. These are assertions about the RENDER, not about what
// the demo stack happens to have seeded: the exact bucket weights and the
// published allocation framework of a live session are not a stable thing to
// assert numbers against, and a session's takes are written by live inference.
// Each test therefore serves the session, the roster and the framework itself
// and asserts the shipped Alpine view (static-views.js's icSessionDetail) draws
// them. Everything else — the SPA shell, /config.js, the static-archive JSON
// under /data/swarm/** — is served by the real backend at baseURL, which is
// why this spec lives in the `e2e` workflow's `test:browser` step (the whole
// frontend/test/browser/ directory) and not in the standalone `frontend`
// workflow, exactly like swarm-index.spec.ts and swarm-subject.spec.ts.

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const notFound = { status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) };

const MEMBERS = {
  members: [
    { id: "athena", status: "active", name: "Athena", lens: "macro" },
    { id: "draco", status: "active", name: "Draco", lens: "risk" },
    { id: "vesta", status: "active", name: "Vesta", lens: "yield" },
  ],
};

// Shaped like the API's session-detail takes (snake_case, real take ids, and
// verified:false + archival:true — which is exactly what the v0 archival import
// produces: the takes were published before member key registration existed, so
// they were never member-signed and their signing key is deliberately not in
// swarm_member_keys).
const TAKES = [
  { id: "take-athena", member_id: "athena", member_name: "Athena", stance: "hold", confidence: 0.7, body: "ARCHIVE IMPORT MARKER — athena take body.", verified: false, archival: true },
  { id: "take-draco", member_id: "draco", member_name: "Draco", stance: "trim", confidence: 0.55, body: "ARCHIVE IMPORT MARKER — draco take body.", verified: false, archival: true },
  { id: "take-vesta", member_id: "vesta", member_name: "Vesta", stance: "hold", confidence: 0.6, body: "ARCHIVE IMPORT MARKER — vesta take body.", verified: false, archival: true },
];

// A LIVE member submission whose signature genuinely failed to verify. Same
// verified:false as the archive rows above, and a completely different claim
// about why — which is the distinction this spec exists to pin.
const FAILED_TAKES = [
  { id: "take-athena", member_id: "athena", member_name: "Athena", stance: "hold", confidence: 0.7, body: "LIVE SUBMISSION MARKER — athena take body.", verified: false, archival: false },
];

// The published framework /api/dashboards/allocation serves. Note the spelling:
// "Conservative DeFi Yield" has an inner capital that humanize() of the bucket
// id `conservative_defi_yield` cannot reproduce — the two sides are matched on
// letters-and-digits only, and the framework's own spelling is what renders.
const ALLOCATION = {
  // The framework is a SINGLE CURRENT row with no history, so `asOf` is the
  // only handle a reader has on when the target being drawn was set. 2026-06-02
  // is the seeded value, which postdates the earliest archived sessions.
  asOf: "2026-06-02",
  strategy: [
    { label: "Conservative DeFi Yield", targetPct: 95 },
    { label: "Directional Crypto", targetPct: 5 },
    { label: "Opportunistic", targetPct: 0 },
    { label: "Cash", targetPct: 0 },
  ],
};

function bucketSession(date: string, weights: Record<string, number>) {
  return {
    id: `${date}-robotmoney-allocation`,
    date,
    subject_id: "robotmoney-allocation",
    subject_name: "Robot Money Allocation",
    state: "published",
    swarm_recommendation: {
      type: "bucket_weights",
      weights,
      quorum: { active: 3, submitted: 3, absent: 0, participation: 1 },
      stances: { hold: 2, trim: 1 },
      meanConfidence: 0.62,
      absent: [],
      consensus: [],
      disagreements: [],
    },
    generated_at: `${date}T11:00:00Z`,
  };
}

function positionSession(date: string, subjectId: string, subjectName: string) {
  return {
    id: `${date}-${subjectId}`,
    date,
    subject_id: subjectId,
    subject_name: subjectName,
    state: "published",
    swarm_recommendation: {
      type: "position_actions",
      quorum: { active: 3, submitted: 3, absent: 0, participation: 1 },
      stances: { hold: 2, trim: 1 },
      meanConfidence: 0.62,
      absent: [],
      consensus: [],
      disagreements: [],
      actions: [],
    },
    generated_at: `${date}T11:00:00Z`,
  };
}

// Serves exactly three things — the roster, the session detail, and (when
// asked) the allocation framework. Every other /api/swarm/** call 404s, which
// is the guarded-side-fetch path the view already tolerates. Non-/api requests
// (the SPA shell, /config.js, /data/swarm/** archive JSON) are left alone so
// the real static-archive fallback is reachable — the point of the
// "not found" test below.
async function mockSessionApi(
  page: Page,
  opts: { session: unknown; takes?: unknown[]; allocation?: unknown | null },
): Promise<void> {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/swarm/members") return route.fulfill(json(MEMBERS));
    if (/^\/api\/swarm\/sessions\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(pathname)) {
      return route.fulfill(json({ session: opts.session, takes: opts.takes ?? TAKES }));
    }
    if (pathname === "/api/dashboards/allocation") {
      return opts.allocation ? route.fulfill(json(opts.allocation)) : route.fulfill(notFound);
    }
    if (pathname.startsWith("/api/swarm/")) return route.fulfill(notFound);
    return route.continue();
  });
}

// The bucket chart is inline SVG injected with x-html; its labels are <text>
// nodes, which have textContent but no innerText, so assertions read the
// container's textContent rather than using a text engine.
async function bucketChartText(page: Page): Promise<string> {
  await expect(page.locator(".sv__bucket-bars-svg svg")).toBeVisible();
  return (await page.locator(".sv__bucket-bars-svg").textContent()) ?? "";
}

test("bucket_weights session draws Target bars from the allocation framework and flags the deviation", async ({ page }) => {
  // 97/3/0/0 recommended against the published 95/5/0/0 target — the exact
  // figures /swarm/2026-08-03/robotmoney-allocation carries, and the case that
  // rendered as bare "Recommended" bars before the framework was wired in.
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", {
      conservative_defi_yield: 0.97,
      directional_crypto: 0.03,
      opportunistic: 0,
      cash: 0,
    }),
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  // .sv__error is x-show (always in the DOM, toggled by CSS) on this view.
  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".sv__detail-title")).toHaveText("Robot Money Allocation");

  const chart = await bucketChartText(page);
  // Target series present, per bucket, alongside Recommended.
  expect(chart).toContain("T 95");
  expect(chart).toContain("R 97");
  expect(chart).toContain("T 5");
  expect(chart).toContain("R 3");
  // The framework's own spelling wins over humanize("conservative_defi_yield"),
  // which cannot recover DeFi's inner capital.
  expect(chart).toContain("Conservative DeFi Yield");
  expect(chart).not.toContain("Conservative Defi Yield");
  await expect(page.locator('.sv__bucket-bars-svg svg')).toHaveAttribute("aria-label", /vs target/);

  // The caption names the series actually drawn. Each clause is an x-show span,
  // so it stays in the DOM and is toggled by CSS — textContent would read the
  // hidden clauses too. useInnerText makes the assertion "what the caption
  // reads on screen", which is the property under test. The match is
  // case-insensitive because the caption is uppercased by CSS text-transform,
  // which innerText (unlike textContent) applies.
  await expect(page.locator(".sv__bucket-bars .sv__panel-sub").first()).toContainText(/target open/i, { useInnerText: true });

  // The finding a reader is here for.
  await expect(page.locator(".sv__deviates")).toBeVisible();
  await expect(page.locator(".sv__deviates")).toContainText("deviates from target");
});

test("bucket_weights session that matches its target draws Target bars and no deviation flag", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-06-05", {
      conservative_defi_yield: 0.95,
      directional_crypto: 0.05,
      opportunistic: 0,
      cash: 0,
    }),
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-05/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  const chart = await bucketChartText(page);
  expect(chart).toContain("T 95");
  expect(chart).toContain("R 95");
  // Same target, same recommendation — the indicator must stay off, otherwise
  // it says nothing when it does appear.
  await expect(page.locator(".sv__deviates")).toBeHidden();
});

test("bucket_weights session degrades to Recommended-only when the framework is unavailable", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", { conservative_defi_yield: 0.97, directional_crypto: 0.03 }),
    allocation: null, // /api/dashboards/allocation 404s
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  // A missing framework degrades the chart, never the page.
  await expect(page.locator(".sv__error")).toBeHidden();
  const chart = await bucketChartText(page);
  expect(chart).toContain("R 97");
  expect(chart).not.toContain("T 95");
  await expect(page.locator('.sv__bucket-bars-svg svg')).not.toHaveAttribute("aria-label", /vs target/);
  // Same x-show caption as above: useInnerText, so a clause that is present in
  // the DOM but display:none correctly reads as "not on screen".
  await expect(page.locator(".sv__bucket-bars .sv__panel-sub").first()).not.toContainText(/target open/i, { useInnerText: true });
  await expect(page.locator(".sv__deviates")).toBeHidden();
});

// 2026-06-26 … 06-30: after ARCHIVE_LAST_DATE (2026-06-25) and before the old
// hardcoded 2026-07-01 archive-preference boundary. The static archive under
// /data/swarm/sessions/ genuinely carries no file for these dates — those
// requests are NOT mocked here, so they 404 against the real backend exactly
// as they do in production. Before the fix the view routed the date to the
// archive, missed, and rethrew instead of retrying the API: "Session not
// found" for a session the API answered 200 for.
for (const [date, subjectId, subjectName] of [
  ["2026-06-26", "robotmoney-vault", "Robot Money Vault"],
  ["2026-06-30", "robotmoney-vault", "Robot Money Vault"],
] as const) {
  test(`session on ${date} — past the static archive's last date — renders its takes, not "Session not found"`, async ({ page }) => {
    await mockSessionApi(page, { session: positionSession(date, subjectId, subjectName), allocation: ALLOCATION });

    await page.goto(`/swarm/${date}/${subjectId}`);

    await expect(page.locator(".sv__detail-title")).toHaveText(subjectName);
    await expect(page.locator(".sv__error")).toBeHidden();
    await expect(page.locator(".sv__take")).toHaveCount(3);
    await expect(page.locator(".sv__take-body").first()).toContainText("ARCHIVE IMPORT MARKER");
    // Takes imported from the v0 archive are ARCHIVED, not unverified: the
    // page must not claim a verification it cannot make, and must not claim a
    // signature check that never happened either.
    await expect(page.locator("[data-verified-badge]").first()).toHaveAttribute("data-verified-state", /archived/i);
  });
}

// review-data-integrity F2. verified:false carried one sentence — "This take's
// signature did not check out against the member's public key. Treat it as
// unattributed." — and the archive backport routed 216 takes that were never
// member-signed straight into it. The badge STATE was already asserted above;
// the state was never the wrong part. The copy was. Both cases are asserted
// here, in the same render, because the bug is that one wording served two
// incompatible meanings.
test("an archival take is labelled archived and never described as a failed signature check", async ({ page }) => {
  await mockSessionApi(page, { session: positionSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"), allocation: ALLOCATION });

  await page.goto("/swarm/2026-06-26/robotmoney-vault");

  const badge = page.locator("[data-verified-badge]").first();
  await expect(badge).toHaveAttribute("data-verified-state", "archived");
  // aria-label carries the full sentence, so this is the text a screen-reader
  // user is actually given — not a hover-only tooltip.
  const label = await badge.getAttribute("aria-label");
  expect(label).toContain("never member-signed");
  expect(label).toContain("not a failed signature check");
  expect(label).not.toContain("did not check out");
  expect(label).not.toContain("unattributed");
  // The visible tooltip says the same thing as the aria-label.
  await expect(page.locator(".sv__vfy-tip").first()).toContainText("never member-signed");
  // And it is not styled as a failure.
  await expect(badge).toHaveClass(/sv__vfy--arch/);
  await expect(badge).not.toHaveClass(/sv__vfy--bad/);
});

test("a live submission whose signature failed still gets the failed-check wording", async ({ page }) => {
  await mockSessionApi(page, {
    session: positionSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"),
    takes: FAILED_TAKES,
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-26/robotmoney-vault");

  const badge = page.locator("[data-verified-badge]").first();
  await expect(badge).toHaveAttribute("data-verified-state", "unverified");
  const label = await badge.getAttribute("aria-label");
  expect(label).toContain("did not check out");
  expect(label).toContain("unattributed");
  await expect(badge).toHaveClass(/sv__vfy--bad/);
  await expect(badge).not.toHaveClass(/sv__vfy--arch/);
});

// review-data-integrity F4. /api/dashboards/allocation serves the single
// CURRENT allocation_framework row, and it is admin-editable. Joining a
// historical session against it measures the swarm against a target that did
// not exist yet, and lets an edit today silently rewrite yesterday's verdict.
// The bars still draw — the comparison is informative — but the ⚠ finding is
// withheld and the caption names the target's own asOf.
test("a session that predates the published framework draws the target for reference and withholds the deviation verdict", async ({ page }) => {
  // 2026-05-25 is the archive's first session; ALLOCATION.asOf is 2026-06-02.
  await mockSessionApi(page, {
    session: bucketSession("2026-05-25", { conservative_defi_yield: 0.97, directional_crypto: 0.03 }),
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-05-25/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  const chart = await bucketChartText(page);
  expect(chart).toContain("T 95");
  expect(chart).toContain("R 97");
  // 97 vs 95 is a two-point gap — well past the 0.005 tolerance — so this is
  // suppressed BECAUSE of the date, not because the numbers agree.
  await expect(page.locator(".sv__deviates")).toBeHidden();
  // Case-insensitive: the caption is uppercased by CSS text-transform, which
  // innerText (unlike textContent) applies — same convention as the bucket
  // caption assertions above.
  await expect(page.locator("[data-target-asof]")).toContainText(/target as published/i, { useInnerText: true });
  await expect(page.locator("[data-target-asof]")).toContainText(/after this session, so it is shown for reference only/i, { useInnerText: true });
});

test("a session dated after the published framework still gets the deviation verdict, captioned with the target's date", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", { conservative_defi_yield: 0.97, directional_crypto: 0.03 }),
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  await expect(page.locator(".sv__deviates")).toBeVisible();
  await expect(page.locator("[data-target-asof]")).toContainText(/target as published/i, { useInnerText: true });
  // The reference-only clause is an x-show span: present in the DOM, hidden by
  // CSS, so useInnerText is what makes this "not on screen".
  await expect(page.locator("[data-target-asof]")).not.toContainText(/reference only/i, { useInnerText: true });
});

test("a date the static archive DOES cover is read from the API, not from the checked-in archive", async ({ page }) => {
  // 2026-06-25/woon is the archive's last session and a file that really
  // exists under /data/swarm/sessions/. The view used to prefer that file over
  // the database for any covered date, so the feed showed one copy of the
  // session and the page showed another. The take body below exists only in
  // the API response; seeing it proves the API won.
  await mockSessionApi(page, { session: positionSession("2026-06-25", "woon", "Woon"), allocation: ALLOCATION });

  await page.goto("/swarm/2026-06-25/woon");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".sv__take-body").first()).toContainText("ARCHIVE IMPORT MARKER");
  await expect(page.locator(".sv__take")).toHaveCount(3);
  // Verification-receipt links are rendered only on the API path
  // (x-show="source === 'api'"), so a visible one is a direct assertion that
  // the page did not fall back to the archive.
  await expect(page.locator("[data-take-permalink]").first()).toBeVisible();
  await expect(page.locator("[data-take-permalink]").first()).toHaveAttribute("href", "/swarm/takes/take-athena");
});
