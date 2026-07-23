// Capture / refresh the preview goldens (goldens/api-goldens.json) from a REAL
// running system — a deployed test cluster or a local `bun run demo` stack.
//
//   BACKEND_URL=http://127.0.0.1:48787 bun run goldens:update
//
// Goldens are mock API responses the client-side preview wrapper replays inside
// an iframe. Their VALUES may be point-in-time, but their FIELD SHAPES must
// match the real system — so they are captured from a running backend with real
// analytics, NOT hand-written and NOT generated from other fixtures.
//
// Goldens freshness is ENTIRELY the responsibility of the agent making the
// system change. A CI drift gate is wired into scripts/tests/goldens-drift.test.ts,
// which blocks a PR if goldens have drifted from the code (route set or field
// shapes no longer match). Rerun this capture whenever a change alters an API
// shape, and the test will enforce the update before merge.
//
// For full details on the preview contract, goldens layout, and the drift gate,
// see docs/architecture.md's preview section.
//
// It walks every route the frontend requests, fetches each from BACKEND_URL,
// and rewrites the single goldens file with stable key order. Any route that
// fails fails the capture loudly — a golden must never silently go missing.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES, path as expand } from "../frontend/public/assets/js/app/contract/routes.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repoRoot, "goldens/api-goldens.json");
const backend = (process.env.BACKEND_URL ?? "http://127.0.0.1:48787").replace(/\/$/, "");

// Research signal keys + comment threads the site mounts (mirror of the demo).
const RESEARCH_KEYS = ["channel-divergence", "late-cycle-signals"];
const COMMENT_PAGES = ["home"];

async function get(url: string): Promise<unknown> {
  const res = await fetch(backend + url);
  if (!res.ok) throw new Error(`capture: GET ${url} -> HTTP ${res.status} (cannot freeze a broken route)`);
  return res.json();
}

async function main(): Promise<void> {
  console.log(`[goldens] capturing from ${backend} …`);
  const routes: Record<string, unknown> = {};

  // Static routes.
  routes[ROUTES.health] = await get(ROUTES.health);
  routes[ROUTES.dashboards.regimeSnapshots] = await get(`${ROUTES.dashboards.regimeSnapshots}?range=180`);
  routes[ROUTES.dashboards.vaultEconomics] = await get(ROUTES.dashboards.vaultEconomics);
  routes[ROUTES.dashboards.walletBalances] = await get(ROUTES.dashboards.walletBalances);
  routes[ROUTES.dashboards.buybacks] = await get(ROUTES.dashboards.buybacks);
  routes[ROUTES.dashboards.tokenMetrics] = await get(ROUTES.dashboards.tokenMetrics);
  routes[ROUTES.dashboards.walletSleeves] = await get(ROUTES.dashboards.walletSleeves);
  routes[ROUTES.dashboards.allocation] = await get(ROUTES.dashboards.allocation);
  routes[ROUTES.projects.list] = await get(ROUTES.projects.list);
  for (const key of RESEARCH_KEYS) {
    const p = expand(ROUTES.dashboards.researchSignal, { key });
    routes[p] = await get(p);
  }
  routes[ROUTES.committee.sessions] = await get(ROUTES.committee.sessions);
  routes[ROUTES.committee.members] = await get(ROUTES.committee.members);
  for (const page of COMMENT_PAGES) routes[ROUTES.comments.list] = await get(`${ROUTES.comments.list}?page=${page}`);

  // Parameterised routes, discovered from the lists just captured.
  const members = ((routes[ROUTES.committee.members] as { members?: { id: string }[] })?.members) ?? [];
  for (const m of members) routes[expand(ROUTES.committee.member, { id: m.id })] = await get(expand(ROUTES.committee.member, { id: m.id }));
  const sessions = ((routes[ROUTES.committee.sessions] as { sessions?: { date: string; subjectId: string }[] })?.sessions) ?? [];
  for (const s of sessions) {
    const p = expand(ROUTES.committee.session, { date: s.date, subject: s.subjectId });
    routes[p] = await get(p);
    routes[ROUTES.committee.brief] = await get(`${ROUTES.committee.brief}?date=${s.date}&subject=${s.subjectId}`);
  }
  // Per-subject routes the session detail page fetches for the portfolio donut +
  // thesis (loadApi → subject + snapshots). Discovered from the sessions list.
  const subjectIds = [...new Set(sessions.map((s) => s.subjectId))];
  for (const id of subjectIds) {
    routes[expand(ROUTES.committee.subject, { id })] = await get(expand(ROUTES.committee.subject, { id }));
    routes[expand(ROUTES.committee.subjectSnapshots, { id })] = await get(expand(ROUTES.committee.subjectSnapshots, { id }));
  }

  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(routes).sort()) ordered[k] = routes[k];
  const doc = {
    version: 1,
    source: `capture:${backend}`,
    note: "Field shapes are captured from a real running system; VALUES are point-in-time. Recapture with `bun run goldens:update`.",
    routes: ordered,
  };
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`[goldens] wrote ${Object.keys(ordered).length} routes → ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
