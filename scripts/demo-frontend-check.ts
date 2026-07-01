// Hermetic frontend-structure check. Runs after the E2E committee session while
// the stack is live. It verifies route fragments and the API data they consume.
//
// This is intentionally not a browser-rendering test; it guards the buildless
// view contract cheaply and rejects inline scripts that innerHTML would ignore.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  await checkView("/views/committee.html", [
    "x-data=\"committeeView()\"",
    "session?.subjectName",
    "session?.state",
    "cv__verified",
    "cv__memo-link",  // memoUrl rendering (Phase 3)
    "x-for=\"t in takes\"",  // renders the members' signed takes
    "aggregate.absent",
  ]);
  await checkView("/views/regime.html", [
    "x-data=\"regimeView()\"",
    "latest.composite",
    "regimeLabel(latest.regime)",  // styled top-line regime label (pixel-parity rewrite)
    "rv__panels",                  // per-panel indicator tables section
  ]);
  await checkView("/views/research/channel-divergence.html", [
    "x-data=\"researchView('channel-divergence')\"",
    "payload.gauges",
    "rs__chart",
  ]);
  await checkView("/views/research/late-cycle-signals.html", [
    "x-data=\"researchView('late-cycle-signals')\"",
    "payload.gauges",
    "rs__chart",
  ]);
  await checkView("/views/allocation.html", [
    "x-data=\"allocationCharts()\"",
    "x-data=\"allocationKpis()\"",
  ]);
  await checkView("/views/committee/member.html", ["x-data=\"memberProfile()\""]);
  await checkView("/views/committee/session.html", ["x-data=\"icSessionDetail()\""]);

  // Router patterns and globally registered factories keep dynamic fragments
  // executable after innerHTML injection.
  checkLocalViewFile("../assets/js/app/routes.js", [
    "committee\\/members\\/",
    "committee\\/\\d{4}-\\d{2}-\\d{2}\\/",
  ]);
  checkLocalViewFile("../assets/js/app/router.js", [
    "AbortController",
  ]);
  checkLocalViewFile("../assets/js/app/alpine/static-views.js", [
    "memberProfile",
    "icSessionDetail",
    "allocationCharts",
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
    "href=\"/committee\"",
    "href=\"/regime\"",
  ]);

  // Check that the API serves data the views depend on (the committee view
  // loads its data from these endpoints).
  const sessionsRes = await fetch(`${BACKEND}/api/committee/sessions`);
  if (sessionsRes.ok) {
    const sessions = await sessionsRes.json();
    checks.push({ name: "GET /api/committee/sessions returns data", ok: true, detail: `${sessions.sessions?.length ?? 0} sessions` });
  } else {
    checks.push({ name: "GET /api/committee/sessions returns data", ok: false, detail: `${sessionsRes.status}` });
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
