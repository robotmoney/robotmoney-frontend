// Frontend-structure check. Runs after the E2E swarm session while the
// stack is live and once at startup on local boots. It verifies route
// fragments and the API data they consume. Data-provenance expectations
// (issue #134) always assert LIVE provenance now — issue #147 removed
// DEMO_HERMETIC and the hermetic smoke path entirely, so there is only one
// supported smoke mode left.
//
// This is intentionally not a browser-rendering test; it guards the buildless
// view contract cheaply and rejects inline scripts that innerHTML would ignore.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "@robotmoney/contract";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const viewsDir = join(repoRoot, "frontend", "public", "views");

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const today = process.env.DEMO_DATE ?? new Date().toISOString().slice(0, 10);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

async function checkView(path: string, expectedPatterns: string[]) {
  const url = `${BACKEND}${path}`;
  const res = await fetch(url);
  for (const pattern of expectedPatterns) {
    const text = await res.clone().text();
    const ok = text.includes(pattern);
    checks.push({
      name: `${path} contains "${pattern}"`,
      ok,
      detail: ok ? "found" : `MISSING — expected "${pattern}" not found in ${url}`,
    });
  }
}

function checkLocalViewFile(filename: string, expectedPatterns: string[]) {
  const filePath = join(viewsDir, filename);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    checks.push({ name: `${filename} exists`, ok: false, detail: "file not found" });
    return;
  }
  checks.push({ name: `${filename} exists`, ok: true, detail: filePath });
  for (const pattern of expectedPatterns) {
    const ok = content.includes(pattern);
    checks.push({
      name: `${filename} contains "${pattern}"`,
      ok,
      detail: ok ? "found" : `MISSING`,
    });
  }
}

async function main() {
  console.log(`\n=== Frontend Checks (${BACKEND}) ===\n`);

  // Check that the view HTML files are served by the backend.
  // The SPA serves them as raw fragments that the router injects.
  // Swarm index leads with the members and what they review, then the
  // browsable sessions list. RM-100 retired the side-by-side members/subjects
  // rails and with them the `subjects()` helper: the coverage list is built by
  // `portfolios()`, which folds a framework subject into the vault it targets
  // so the page says 3 portfolios rather than 4 subjects. Signed takes + memo
  // links render on the session DETAIL page, checked below.
  await checkView("/views/swarm.html", [
    "x-data=\"swarmView()\"",
    "x-for=\"m in members\"",   // members table
    "portfolios()",             // what they review
    "publishedSessions()",      // browsable sessions list
    "sv__session-card",         // per-session card
    "stanceColor(",             // per-take stance dots on each session
  ]);
  await checkView("/views/regime.html", [
    "x-data=\"regimeView()\"",
    "latest.composite",
    "regimeLabel(latest.regime)",  // styled top-line regime label (pixel-parity rewrite)
    "rv__panels",                  // per-panel indicator tables section
  ]);
  // channel-divergence stays data-driven: the long-form restoration (#331/#333)
  // kept the live researchView payload (gauges + the three transmission-
  // indicator sparklines) and only renamed the chart container from the old
  // rs__chart to rs__series-canvas (wrapped in the new rs__figure prose block).
  await checkView("/views/research/channel-divergence.html", [
    "x-data=\"researchView('channel-divergence')\"",
    "payload.gauges",
    "rs__series-canvas",
  ]);
  // late-cycle-signals was fully converted to static long-form prose (#333):
  // no researchView wiring, no live payload, no chart — just the ported
  // write-up (four-gauge readings table + one stub__series block per gauge).
  await checkView("/views/research/late-cycle-signals.html", [
    "stub__title",
    "stub__table",
    "stub__series",
  ]);
  await checkView("/views/allocation.html", [
    "x-data=\"allocationView()\"",
    "alloc-tablecard",             // vault/wallet holdings table card
    "alloc-aum__value",            // hero Total AUM (live vault-economics binding, issue #40)
    "alloc-chip__value",           // 7-day APY chip (live vault-economics binding, issue #40)
    "walletNonLive()",             // live prop-wallet feed provenance badge (issue #84)
  ]);
  // The wallet-performance charts (walletPerfView(), formerly embedded in
  // allocation.html) moved to their own page under the pixel-perfect lift
  // (#39); "rm-chartcard" was renamed to "a2-card" in that same lift.
  await checkView("/views/performance.html", [
    "x-data=\"walletPerfView()\"",
    "a2-card",  // shared chart-card component
  ]);
  await checkView("/views/swarm/member.html", [
    "x-data=\"memberProfile()\"",
    "profile-name",  // e2e hook (spa.spec.ts asserts member name)
  ]);
  // Session detail renders the members' signed takes + memo links and the
  // e2e submissions table (spa.spec.ts asserts .session-submissions rows).
  // The reference-faithful member-opinion cards (issue #75) must survive: one
  // sv__take card per member with a role/lens line and a stance-confidence
  // badge — the surface spa.spec.ts asserts against for live smoke sessions.
  await checkView("/views/swarm/session.html", [
    "x-data=\"swarmSessionDetail()\"",
    "x-for=\"t in takes\"",  // renders the members' signed takes
    "sv__take",              // member-opinion card (issue #75 render surface)
    "sv__stance-badge",      // stance · confidence badge
    "sv__take-lens",         // member role/lens line
    "sv__memo-link",         // memoUrl rendering
    "session-submissions",   // compact submissions table (e2e hook)
  ]);

  // Router patterns and globally registered factories keep dynamic fragments
  // executable after innerHTML injection.
  checkLocalViewFile("../assets/js/app/routes.js", [
    "swarm\\/members\\/",
    "swarm\\/\\d{4}-\\d{2}-\\d{2}\\/",
  ]);
  checkLocalViewFile("../assets/js/app/router.js", [
    "AbortController",
  ]);
  checkLocalViewFile("../assets/js/app/alpine/static-views.js", [
    "memberProfile",
    "swarmSessionDetail",
  ]);

  for (const filename of new Bun.Glob("**/*.html").scanSync({ cwd: viewsDir })) {
    const source = readFileSync(join(viewsDir, filename), "utf8");
    const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
    const hasInlineScript = /<script(?:\s|>)/i.test(withoutComments);
    checks.push({
      name: `${filename} has no inline scripts`,
      ok: !hasInlineScript,
      detail: hasInlineScript ? "move behavior into assets/js/app/alpine" : "none",
    });
  }

  // Check the SPA shell (index.html) has the nav links and Alpine bootstrap.
  await checkView("/", [
    "x-data",
    "Alpine",
    "assets/js/app/main.js",  // module that registers Alpine factories + boots the router
    "/config.js",  // runtime config bootstrap
    "href=\"/swarm\"",
    "href=\"/regime\"",
  ]);

  // Live prop-wallet valuation feed (issue #84): the /allocation hero + the
  // /performance charts consume this endpoint. Every smoke boot is now LIVE
  // (issue #147 removed DEMO_HERMETIC and the hermetic path entirely), so the
  // expected provenance is always 'live'. 'stale'/'seed' are explicitly-ALLOWED
  // degrades (schedule not yet sampled at boot, or a degraded leg — values are
  // never fabricated), but they are loudly logged. Any OTHER provenance (e.g.
  // 'stub') is a genuine regression and fails the check.
  const expectedProvenance = "live";
  const allowedDegrades = ["stale", "seed"];
  const wbRes = await fetch(`${BACKEND}/api/dashboards/wallet-balances`);
  if (wbRes.ok) {
    const wb = await wbRes.json();
    const holdings: { symbol: string; provenance: string }[] = wb.holdings ?? [];
    const wrong = holdings.filter((h) => h.provenance !== expectedProvenance && !allowedDegrades.includes(h.provenance));
    const degraded = holdings.filter((h) => allowedDegrades.includes(h.provenance));
    if (degraded.length > 0) {
      console.log(`  ! wallet-balances degraded legs (allowed, non-${expectedProvenance}): ${degraded.map((h) => `${h.symbol}=${h.provenance}`).join(", ")}`);
    }
    const provenanceOk = holdings.length >= 8 && wrong.length === 0 && wb.source === expectedProvenance;
    checks.push({
      name: `GET /api/dashboards/wallet-balances returns ${expectedProvenance}-provenanced holdings + history (live boot)`,
      ok: provenanceOk && (wb.history?.length ?? 0) > 0 && typeof wb.totalUsd === "number",
      detail: `${holdings.length} holdings, ${wb.history?.length ?? 0} history days, source=${wb.source} (expected ${expectedProvenance})${wrong.length > 0 ? `, wrong-provenance legs: ${wrong.map((h) => `${h.symbol}=${h.provenance}`).join(", ")}` : ""}`,
    });
  } else {
    checks.push({ name: "GET /api/dashboards/wallet-balances returns data", ok: false, detail: `${wbRes.status}` });
  }

  // Check that the API serves data the views depend on (the swarm view
  // loads its data from these endpoints).
  const sessionsRes = await fetch(`${BACKEND}${ROUTES.swarm.sessions}`);
  if (sessionsRes.ok) {
    const sessions = await sessionsRes.json();
    checks.push({ name: `GET ${ROUTES.swarm.sessions} returns data`, ok: true, detail: `${sessions.sessions?.length ?? 0} sessions` });
  } else {
    checks.push({ name: `GET ${ROUTES.swarm.sessions} returns data`, ok: false, detail: `${sessionsRes.status}` });
  }

  // Report.
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length} checks · ${failed.length} failed\n`);
  for (const c of checks) {
    const icon = c.ok ? "✓" : "✗";
    console.log(`  ${icon} ${c.name}`);
    if (!c.ok) console.log(`      ${c.detail}`);
  }
  console.log();
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => { console.error("frontend-check error:", e); process.exit(1); });
