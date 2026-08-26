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
// the smoke stack happens to have seeded: the exact bucket weights and the
// published allocation framework of a live session are not a stable thing to
// assert numbers against, and a session's takes are written by live inference.
// Each test therefore serves the session, the roster and the framework itself
// and asserts the shipped Alpine view (static-views.js's swarmSessionDetail) draws
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

// Issue #593 — a RENAMED member. `handle` is the public URL segment; `id` is
// the immutable name the take was signed under and is deliberately never
// rewritten, so after a rename the two differ. Every other roster fixture in
// this file (and in swarm-index.spec.ts) has an implicit handle equal to its
// id, which is exactly why camelMember/camelTake could drop the two fields
// entirely and still ship green: only the fallback branch was ever exercised.
// Draco is kept unrenamed here so both branches render in one page.
const RENAMED_MEMBERS = {
  members: [
    { id: "athena", handle: "macro-desk", status: "active", name: "Athena", lens: "macro" },
    { id: "draco", handle: "draco", status: "active", name: "Draco", lens: "risk" },
  ],
};

// Issue #598 — the SAME renamed member, now DEACTIVATED. `GET /api/swarm/members`
// serves the ACTIVE roster and nothing else (backend/src/swarm/domain.ts:
// `SELECT * FROM swarm_members WHERE status = 'active'`), so a deactivated
// member is not served with `status: "inactive"` — it is ABSENT from the
// payload, which is what this fixture reproduces. Draco stays active and
// unrenamed so the untouched path renders in the same page. This is the fixture
// the tree did not have: every earlier roster fixture holds every member the
// session's takes were written by, so the roster-only link path always found
// its member and the divergence could not appear.
const DEACTIVATED_ROSTER = {
  members: [
    { id: "draco", handle: "draco", status: "active", name: "Draco", lens: "risk" },
  ],
};

// Shaped like the API's session-detail takes after migration 0030: the signed
// `member_id` is untouched and `member_handle` rides beside it
// (backend/src/swarm/projections.ts). Deactivating the member does NOT strip it:
// domain.ts's withTakes joins swarm_members with no status filter, so the take
// of a deactivated author keeps carrying that author's current public handle —
// which is why the page can still resolve one when the roster has dropped it.
const RENAMED_TAKES = [
  { id: "take-athena", member_id: "athena", member_handle: "macro-desk", member_name: "Athena", stance: "hold", confidence: 0.7, body: "RENAME MARKER — athena take body.", verified: true, archival: false },
  { id: "take-draco", member_id: "draco", member_handle: "draco", member_name: "Draco", stance: "trim", confidence: 0.55, body: "RENAME MARKER — draco take body.", verified: true, archival: false },
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

// A session whose Disagreements panel quotes both members. Those positions
// carry ONLY the signed `member_id` — the payload has no handle in it anywhere —
// which is what makes the panel the second, independent link path that the two
// rename tests below compare against the take byline. Shared by both so they
// differ in exactly one thing: whether the renamed member is still on the
// active roster.
function disagreementSession(date: string, subjectId: string, subjectName: string) {
  const base = positionSession(date, subjectId, subjectName);
  return {
    ...base,
    swarm_recommendation: {
      ...base.swarm_recommendation,
      disagreements: [
        {
          topic: "duration risk",
          positions: [
            { member_id: "athena", view: "The long end is where this breaks." },
            { member_id: "draco", view: "Trim the tail first." },
          ],
        },
      ],
    },
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
  opts: { session: unknown; takes?: unknown[]; allocation?: unknown | null; snapshots?: unknown[]; members?: unknown },
): Promise<void> {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/swarm/members") return route.fulfill(json(opts.members ?? MEMBERS));
    if (/^\/api\/swarm\/sessions\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(pathname)) {
      return route.fulfill(json({ session: opts.session, takes: opts.takes ?? TAKES }));
    }
    if (pathname === "/api/dashboards/allocation") {
      return opts.allocation ? route.fulfill(json(opts.allocation)) : route.fulfill(notFound);
    }
    // The subject's snapshots, which are what "actual" is derived from — a
    // bucket's share of NAV is summed from the positions the framework assigns
    // to it. Left 404ing unless a test supplies them, matching the guarded
    // side-fetch every other case here relies on.
    if (opts.snapshots && /\/snapshots$/.test(pathname)) {
      return route.fulfill(json({ snapshots: opts.snapshots }));
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

// The series are named ONCE, in an HTML key under the figure, rather than on
// every bucket row — so which series are drawn is asserted here and not against
// the SVG's text. Reading the chart for "target" would now pass trivially
// whether or not the series is drawn, which is exactly the assertion the
// framework-unavailable test depends on.
async function bucketKeyText(page: Page): Promise<string> {
  return (await page.locator(".sv__bars-key").textContent()) ?? "";
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
  // Values carry their unit — they were "T 95"/"R 97", which asked the reader to
  // decode a key from elsewhere on the page and never said the number was a
  // percentage.
  expect(chart).toContain("95%");
  expect(chart).toContain("97%");
  expect(chart).toContain("5%");
  expect(chart).toContain("3%");
  // The value column is headed, so a bar length is readable as a quantity
  // rather than only comparable to its neighbour.
  expect(chart).toContain("% of NAV");
  // Target series present alongside Recommended, per the key under the figure.
  const key = await bucketKeyText(page);
  expect(key).toContain("target");
  expect(key).toContain("recommended");
  // The framework's own spelling wins over humanize("conservative_defi_yield"),
  // which cannot recover DeFi's inner capital.
  expect(chart).toContain("Conservative DeFi Yield");
  expect(chart).not.toContain("Conservative Defi Yield");
  await expect(page.locator('.sv__bucket-bars-svg svg')).toHaveAttribute("aria-label", /vs target/);

  // The recommendation as numbers, with the move it implies. The bars alone
  // cannot carry a 97/3/0/0 book — two of four rows round to no bar at all.
  const table = page.locator(".sv__bucket-table");
  await expect(table).toBeVisible();
  await expect(table.locator("thead")).toContainText(/target/i, { useInnerText: true });
  await expect(table.locator("thead")).toContainText(/recommended/i, { useInnerText: true });
  // Gap is against target here (no snapshot in this mock, so no actual), and
  // the heading says WHICH basis is on screen rather than a bare "Gap".
  await expect(table.locator("thead")).toContainText(/vs target/i, { useInnerText: true });
  await expect(table.locator("tbody tr").first()).toContainText("+2pp");

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
  expect(chart).toContain("95%");
  expect(await bucketKeyText(page)).toContain("target");
  // Same target, same recommendation — the indicator must stay off, otherwise
  // it says nothing when it does appear.
  await expect(page.locator(".sv__deviates")).toBeHidden();
  // …and the gap column agrees with it: a zero move reads "—", not "0pp".
  await expect(page.locator(".sv__bucket-table tbody tr").first().locator(".sv__gap")).toHaveText("—");
});

// "Actual" is the only figure on this panel that is DERIVED rather than
// published: the framework manifest says which tokens constitute each bucket,
// and the day's snapshot says what the book holds, so a bucket's actual weight
// is its tokens' share of NAV. Before this, `actual` was hardcoded null on the
// weights path and the column never rendered on any session — the panel showed
// four proposed numbers with nothing to measure them against.
test("bucket_weights session derives Actual from the snapshot and measures the gap against it", async ({ page }) => {
  await mockSessionApi(page, {
    // Recommended 97/3 against a book sitting entirely in Conservative DeFi.
    session: bucketSession("2026-08-03", {
      conservative_defi_yield: 0.97,
      agent_tokens: 0.03,
      protocol_tokens: 0,
      real_world_assets: 0,
    }),
    allocation: ALLOCATION,
    // AAVE/COMPOUND/MORPHO are all conservative_defi_yield tokens in the
    // committed manifest, so actual must come out 100/0/0/0 — and the gap must
    // flip to being measured against actual, not target.
    snapshots: [{
      date: "2026-08-03",
      total_value_usd: 150,
      positions: [
        { token: "AAVE", chain: "base", value_usd: 50 },
        { token: "COMPOUND", chain: "base", value_usd: 50 },
        { token: "MORPHO", chain: "base", value_usd: 50 },
      ],
    }],
  });

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  await expect(page.locator(".sv__error")).toBeHidden();
  const chart = await bucketChartText(page);
  expect(chart).toContain("100%");
  expect(await bucketKeyText(page)).toContain("actual");

  const table = page.locator(".sv__bucket-table");
  // Basis flips to actual the moment we know it: recommended-minus-actual is
  // the MOVE being asked for, which is the question a reader has.
  await expect(table.locator("thead")).toContainText(/vs actual/i, { useInnerText: true });
  const conservative = table.locator("tbody tr").filter({ hasText: "Conservative DeFi Yield" });
  await expect(conservative).toContainText("100%");
  // 97 recommended − 100 actual = trim 3 points.
  await expect(conservative.locator(".sv__gap")).toContainText("−3pp");
  const agent = table.locator("tbody tr").filter({ hasText: "Agent Tokens" });
  // 3 recommended − 0 actual = add 3. A bucket whose tokens are simply absent
  // from the book reads 0%, which is true — not "—", which would claim we do
  // not know.
  await expect(agent).toContainText("0%");
  await expect(agent.locator(".sv__gap")).toContainText("+3pp");
});

test("bucket_weights session degrades to Recommended-only when the framework is unavailable", async ({ page }) => {
  await mockSessionApi(page, {
    session: bucketSession("2026-08-03", { conservative_defi_yield: 0.97, directional_crypto: 0.03 }),
    allocation: null, // /api/dashboards/allocation 404s
  });
  // There are now TWO sources for a target: the dashboard endpoint above and
  // the committed framework manifest, which is what lets a backendless checkout
  // still draw one. 404ing only the endpoint no longer produces the
  // no-framework state this test exists to cover, so block both — otherwise the
  // test silently stops testing degradation and passes on the fallback.
  await page.route("**/data/swarm/manifests/allocation.json", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));

  await page.goto("/swarm/2026-08-03/robotmoney-allocation");

  // A missing framework degrades the chart, never the page.
  await expect(page.locator(".sv__error")).toBeHidden();
  const chart = await bucketChartText(page);
  expect(chart).toContain("97%");
  // Recommended alone: the key names it and nothing else, which is the whole
  // claim of this test.
  const key = await bucketKeyText(page);
  expect(key).toContain("recommended");
  expect(key).not.toContain("target");
  expect(key).not.toContain("actual");
  await expect(page.locator('.sv__bucket-bars-svg svg')).not.toHaveAttribute("aria-label", /vs target/);
  // With no basis to measure against, the gap column is withheld entirely
  // rather than printed as a row of em-dashes.
  await expect(page.locator(".sv__bucket-table thead")).not.toContainText(/vs target|vs actual/i, { useInnerText: true });
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
  expect(chart).toContain("95%");
  expect(chart).toContain("97%");
  expect(await bucketKeyText(page)).toContain("target");
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

// Issue #593 / review-data-integrity DI-594-001. The roster page (/swarm) links
// members at their public `handle`; this page linked them at the immutable id,
// because camelTake() dropped `member_handle` and camelMember() dropped
// `handle` — so `t.memberHandle` was always undefined and memberById()'s
// `m.handle === ref` branch was unreachable. Two public surfaces derived from
// the same API then published two different addresses for one member.
//
// The fixture has handle !== id, which is what makes this an assertion about
// the handle rather than about the fallback. Both link sources are covered in
// one render:
//   - the take byline/avatar, fed by camelTake's `memberHandle`;
//   - the disagreement panel, whose positions carry ONLY the signed
//     `member_id`, so it reaches a handle through camelMember's `handle` on the
//     roster. Since #598 that panel falls back to this session's takes when the
//     roster does not hold the member — the case the next test covers — so the
//     mapper-level guarantee that camelMember carries `handle` at all is pinned
//     directly in scripts/tests/unit/frontend-routes.test.ts.
test("a renamed member's session links address the public handle, never the id the take was signed under", async ({ page }) => {
  await mockSessionApi(page, {
    session: disagreementSession("2026-06-26", "robotmoney-vault", "Robot Money Vault"),
    takes: RENAMED_TAKES,
    members: RENAMED_MEMBERS,
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-26/robotmoney-vault");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".sv__take")).toHaveCount(2);

  // Take byline + avatar: the handle, not `athena`.
  const athenaTake = page.locator(".sv__take").filter({ hasText: "RENAME MARKER — athena take body." });
  await expect(athenaTake.locator(".sv__member-link")).toHaveAttribute("href", "/swarm/members/macro-desk");
  await expect(athenaTake.locator(".sv__avatar--mark")).toHaveAttribute("href", "/swarm/members/macro-desk");

  // The disagreement panel holds no handle of its own — only the signed
  // member_id — so a handle here proves the ROSTER carried it through
  // camelMember. This link was /swarm/members/athena before the fix.
  const athenaPosition = page.locator(".sv__disagreement li").filter({ hasText: "Athena" });
  await expect(athenaPosition.locator("a").first()).toHaveAttribute("href", "/swarm/members/macro-desk");

  // An unrenamed member (handle === id) is unaffected: the same address as
  // before migration 0030, which is what keeps every published link alive.
  const dracoTake = page.locator(".sv__take").filter({ hasText: "RENAME MARKER — draco take body." });
  await expect(dracoTake.locator(".sv__member-link")).toHaveAttribute("href", "/swarm/members/draco");

  // Nothing on the page still points at the legacy id for the renamed member.
  await expect(page.locator('a[href="/swarm/members/athena"]')).toHaveCount(0);
});

// Issue #598 / review-data-integrity DI-594-R2-001. The test above proves both
// link sites agree WHILE the renamed member is on the active roster. Deactivate
// that member and they stopped agreeing:
//
//   - the take byline carries `member_handle` in the take's own payload, so it
//     kept linking /swarm/members/macro-desk;
//   - a disagreement position carries only the signed `member_id`, so it could
//     reach a handle only through the roster — and `GET /api/swarm/members`
//     serves active members only, so `memberById()` returned null and the link
//     fell back to /swarm/members/athena.
//
// One page, two public addresses for one member. Neither 404s (the server
// resolves handle OR legacy id), which is exactly why nothing caught it: the
// only way to see it is a fixture where the renamed member is ABSENT from the
// roster, and none existed. memberHandleOf() now reads the roster first and this
// session's takes second, so both sites resolve through one lookup.
test("a renamed member that is later DEACTIVATED still gets one address from both link sites", async ({ page }) => {
  await mockSessionApi(page, {
    // Same session and same takes as the test above — only the roster differs.
    session: disagreementSession("2026-06-27", "robotmoney-vault", "Robot Money Vault"),
    takes: RENAMED_TAKES,
    members: DEACTIVATED_ROSTER,
    allocation: ALLOCATION,
  });

  await page.goto("/swarm/2026-06-27/robotmoney-vault");

  await expect(page.locator(".sv__error")).toBeHidden();
  await expect(page.locator(".sv__take")).toHaveCount(2);

  const athenaTake = page.locator(".sv__take").filter({ hasText: "RENAME MARKER — athena take body." });
  // THE FIXTURE IS IN THE DEFECT STATE. The lens line is roster-only data
  // (memberLens -> memberById), so its fallback wording is a direct assertion
  // that this page really is rendering a member the roster does not hold — the
  // condition the assertions below would silently stop testing if a future
  // fixture edit put Athena back on the roster.
  await expect(athenaTake.locator(".sv__take-lens")).toHaveText("swarm member");

  // Byline + avatar: the take's own handle.
  await expect(athenaTake.locator(".sv__member-link")).toHaveAttribute("href", "/swarm/members/macro-desk");
  await expect(athenaTake.locator(".sv__avatar--mark")).toHaveAttribute("href", "/swarm/members/macro-desk");

  // The disagreement position, found by its view text rather than by a member
  // name: the panel's label is roster-derived and falls back to the signed id
  // for a member the roster dropped. The href is what this issue is about.
  const athenaPosition = page.locator(".sv__disagreement li").filter({ hasText: "The long end is where this breaks." });
  await expect(athenaPosition.locator("a").first()).toHaveAttribute("href", "/swarm/members/macro-desk");

  // The unrenamed, still-active member is unaffected.
  const dracoTake = page.locator(".sv__take").filter({ hasText: "RENAME MARKER — draco take body." });
  await expect(dracoTake.locator(".sv__member-link")).toHaveAttribute("href", "/swarm/members/draco");
  const dracoPosition = page.locator(".sv__disagreement li").filter({ hasText: "Trim the tail first." });
  await expect(dracoPosition.locator("a").first()).toHaveAttribute("href", "/swarm/members/draco");

  // ONE ADDRESS PER MEMBER, stated as a set rather than as two separate
  // equalities: this fails if EITHER link site regresses to the legacy id,
  // including a regression that moved both sites onto the id together.
  const addresses = await page
    .locator(".sv__takes-section, .sv__disagreements")
    .locator('a[href^="/swarm/members/"]')
    .evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute("href")))].sort());
  expect(addresses).toEqual(["/swarm/members/draco", "/swarm/members/macro-desk"]);
});
