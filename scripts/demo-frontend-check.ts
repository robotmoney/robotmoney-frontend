// Hermetic frontend-rendering check. Runs after the E2E committee session
// completes but while the stack is live. Fetches the raw SPA view HTML files
// and verifies their structure — cataches missing template elements, broken
// Alpine.js directives, and regressions in the view contract.
//
// Uses fetch + string matching only (no headless browser). The SPA views are
// buildless static HTML with Alpine.js directives; as long as the view file
// is served and contains the expected x-data / template structure, the
// client-side render will produce correct output.
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
    "session?.subject_name",
    "session?.state",
    "cv__verified",
    "cv__memo-link",  // memoUrl rendering (Phase 3)
    "takes.length",
    "aggregate.absent",
  ]);
  await checkView("/views/regime.html", [
    "x-data=\"regimeView()\"",
    "latest.composite",
    "regime-pill",
    "rv__indicators",
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

  // Check the SPA shell (index.html) has the nav links and Alpine bootstrap.
  await checkView("/", [
    "x-data",
    "Alpine",
    "router.js",
    "views.js",
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
