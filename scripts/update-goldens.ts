// Capture / refresh the preview goldens (goldens/api-goldens.json) from a REAL
// running system — a deployed test cluster or a local `bun run smoke` stack.
//
//   BACKEND_URL=http://127.0.0.1:<smoke api port> bun run goldens:update
//
// BACKEND_URL is REQUIRED in practice: `bun run smoke` draws its host port free
// on every run, so the 48787 default below is correct only for a `bun run smoke
// -- --stage` boot (the one sanctioned pin — the cloudflared tunnel origin).
// Read the port off the smoke's startup line or `bun run smoke:status`.
//
// Goldens are mock API responses the client-side preview wrapper replays inside
// an iframe. Their VALUES may be point-in-time, but their FIELD SHAPES must
// match the real system — so they are captured from a running backend with real
// analytics, NOT hand-written and NOT generated from other fixtures.
//
// Goldens freshness is ENTIRELY the responsibility of the agent making the
// system change. A CI drift gate is wired into scripts/tests/unit/goldens-drift.test.ts,
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

// Research signal keys + comment threads the site mounts (mirror of the smoke).
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
  routes[ROUTES.dashboards.entities] = await get(ROUTES.dashboards.entities);
  routes[ROUTES.dashboards.overview] = await get(ROUTES.dashboards.overview);
  routes[ROUTES.dashboards.agents] = await get(ROUTES.dashboards.agents);
  routes[ROUTES.projects.list] = await get(ROUTES.projects.list);
  // Issue #389 (/projects/:slug ProjectProfile): discovered from the list
  // capture just above, same pattern as the swarm member/session/subject
  // routes below — captures the profile DTO for every project the directory
  // currently lists (empty on a fresh/dev-seed-less deploy, never an error).
  const projectSlugs = ((routes[ROUTES.projects.list] as { projects?: { slug: string }[] })?.projects ?? []).map((p) => p.slug);
  for (const slug of projectSlugs) {
    const p = expand(ROUTES.projects.detail, { slug });
    routes[p] = await get(p);
  }
  for (const key of RESEARCH_KEYS) {
    const p = expand(ROUTES.dashboards.researchSignal, { key });
    routes[p] = await get(p);
  }
  routes[ROUTES.swarm.sessions] = await get(ROUTES.swarm.sessions);
  routes[ROUTES.swarm.members] = await get(ROUTES.swarm.members);
  for (const page of COMMENT_PAGES) routes[ROUTES.comments.list] = await get(`${ROUTES.comments.list}?page=${page}`);

  // Parameterised routes, discovered from the lists just captured.
  const members = ((routes[ROUTES.swarm.members] as { members?: { id: string }[] })?.members) ?? [];
  for (const m of members) routes[expand(ROUTES.swarm.member, { id: m.id })] = await get(expand(ROUTES.swarm.member, { id: m.id }));
  const sessions = ((routes[ROUTES.swarm.sessions] as { sessions?: { date: string; subjectId: string }[] })?.sessions) ?? [];
  for (const s of sessions) {
    const p = expand(ROUTES.swarm.session, { date: s.date, subject: s.subjectId });
    routes[p] = await get(p);
    routes[ROUTES.swarm.brief] = await get(`${ROUTES.swarm.brief}?date=${s.date}&subject=${s.subjectId}`);
  }
  // Per-subject routes the session detail page fetches for the portfolio donut +
  // thesis (loadApi → subject + snapshots). Discovered from the sessions list.
  const subjectIds = [...new Set(sessions.map((s) => s.subjectId))];
  for (const id of subjectIds) {
    routes[expand(ROUTES.swarm.subject, { id })] = await get(expand(ROUTES.swarm.subject, { id }));
    routes[expand(ROUTES.swarm.subjectSnapshots, { id })] = await get(expand(ROUTES.swarm.subjectSnapshots, { id }));
  }
  // /agents/:id "Money-agent dossier" (issue #390, §5.8, P3.2), discovered
  // from the agents directory list just captured above.
  const agentIds = ((routes[ROUTES.dashboards.agents] as { agents?: { id: string }[] })?.agents) ?? [];
  for (const a of agentIds) {
    const p = expand(ROUTES.dashboards.agentDetail, { id: a.id });
    routes[p] = await get(p);
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
