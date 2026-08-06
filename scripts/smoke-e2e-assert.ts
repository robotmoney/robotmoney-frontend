// The smoke boot's END-TO-END verdict, read back over the real HTTP API
// (issue #537). Runs against the live stack `bun smoke` just booted, after
// the shared scenario/session pipeline published one new session.
//
// WHAT IT PROVES, in the order the operator cares about:
//
//   1. RESTORED SUBJECTS — the four subjects the production bootstrap brings
//      back are visible under their release names, and no fifth one is. The
//      subject list is derived from the sessions feed exactly as
//      frontend/public/assets/js/app/alpine/views/swarm.js's subjects() derives
//      it, so this asserts what the site actually shows.
//   2. RESTORED PERSONAS — the active roster is exactly the three archive
//      personas, by id AND display name.
//   3. IDENTITY CONTINUITY — the new published session carries a
//      non-archival, verified take from one of those personas. Non-archival is
//      the durable marker (#498/#499's nonce-derived projection), so this can
//      only be a take filed by this run.
//   4. HISTORY STILL VISIBLE — the oldest published session's takes are all
//      `archival: true` and `verified: false`. That is #498's semantics, read
//      through its own projection; this asserts the smoke boot did not disturb
//      it, and never re-implements it.
//
// NEVER SKIPS. Zero published sessions, an unreachable API, a missing roster, a
// missing persona, or a session detail that will not load all exit non-zero and
// name the missing thing. There is no "assume it is fine" branch.
import { ROUTES, path as routePath } from "@robotmoney/contract";
import { SMOKE_MEMBERS, SMOKE_SUBJECTS } from "./lib/smoke-mode.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
/** Hard cap on the sessions walked — the archive is 72 sessions plus this run's. */
const MAX_SESSIONS = 500;

const failures: string[] = [];
function check(ok: boolean, message: string): void {
  if (ok) console.log(`  ✓ ${message}`);
  else { console.log(`  ✗ ${message}`); failures.push(message); }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

// Session ids are UUIDs (migration 0022), never ordinals — ordering is by the
// (date, generatedAt, id) triple the backend itself orders and paginates by.
interface SessionListItem { id: string; date: string; subjectId: string; subjectName: string | null; state: string; generatedAt: string }
interface Take { memberId: string; memberName: string; archival?: boolean; verified?: boolean }
interface SessionDetail { session: { id: string; state: string }; takes: Take[] }
interface Member { id: string; name: string; status: string }

async function allSessions(): Promise<SessionListItem[]> {
  const out: SessionListItem[] = [];
  let cursor: string | null = null;
  while (out.length < MAX_SESSIONS) {
    // 100 is the route's documented maximum page size; state=published keeps
    // the walk to the sessions this script actually asserts about.
    const qs: string = `?state=published&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await getJson<{ sessions: SessionListItem[]; nextCursor: string | null }>(`${ROUTES.swarm.sessions}${qs}`);
    out.push(...page.sessions);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

function sortKey(s: SessionListItem): string {
  return `${s.date}#${s.generatedAt}#${s.id}`;
}

async function main(): Promise<void> {
  console.log(`\n=== smoke e2e assertions (${BACKEND}) ===`);
  // Stack.up owns readiness. This script only reads archive restoration and
  // committed-identity continuity back through the public API.

  const published = (await allSessions()).filter((s) => s.state === "published");
  console.log(`  published sessions: ${published.length}`);
  if (published.length === 0) {
    throw new Error("smoke-e2e-assert: zero published sessions — the production bootstrap imported no history and no new session completed.");
  }

  // 2. Exactly the four restored subjects, under their release names.
  const seen = new Map<string, string>();
  for (const s of published) if (!seen.has(s.subjectId)) seen.set(s.subjectId, s.subjectName ?? s.subjectId);
  const expectedSubjects = new Map(SMOKE_SUBJECTS.map((s) => [s.id, s.name]));
  check(
    [...seen.keys()].sort().join(",") === [...expectedSubjects.keys()].sort().join(","),
    `subject ids are exactly [${[...expectedSubjects.keys()].sort().join(", ")}] (got [${[...seen.keys()].sort().join(", ")}])`,
  );
  for (const [id, name] of expectedSubjects) {
    check(seen.get(id) === name, `subject ${id} is named "${name}" (got ${JSON.stringify(seen.get(id) ?? null)})`);
  }

  // 3. Exactly the three restored personas on the active roster.
  const roster = await getJson<{ members: Member[] }>(ROUTES.swarm.members);
  const active = roster.members.filter((m) => m.status === "active");
  const expectedMembers = new Map(SMOKE_MEMBERS.map((m) => [m.id, m.name]));
  check(
    active.map((m) => m.id).sort().join(",") === [...expectedMembers.keys()].sort().join(","),
    `active member ids are exactly [${[...expectedMembers.keys()].sort().join(", ")}] (got [${active.map((m) => m.id).sort().join(", ")}])`,
  );
  for (const [id, name] of expectedMembers) {
    const m = active.find((x) => x.id === id);
    check(m?.name === name, `member ${id} displays as "${name}" (got ${JSON.stringify(m?.name ?? null)})`);
  }

  const ordered = [...published].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const newest = ordered[ordered.length - 1];
  const oldest = ordered[0];

  // 4. At least one NEW completed session with a live take from a restored persona.
  const newestDetail = await getJson<SessionDetail>(routePath(ROUTES.swarm.sessionById, { id: newest.id }));
  const liveTakes = newestDetail.takes.filter((t) => t.archival !== true);
  check(
    liveTakes.length > 0,
    `newest published session ${newest.id} (${newest.date}/${newest.subjectId}) carries a live, non-archival take`,
  );
  check(
    liveTakes.some((t) => expectedMembers.has(t.memberId)),
    `that live take was submitted by a restored persona (got [${liveTakes.map((t) => t.memberId).join(", ") || "none"}])`,
  );
  check(
    liveTakes.every((t) => t.verified === true),
    "every live take on that session is signature-verified",
  );

  // 5. Imported history keeps #498's archival semantics.
  const oldestDetail = await getJson<SessionDetail>(routePath(ROUTES.swarm.sessionById, { id: oldest.id }));
  check(oldestDetail.takes.length > 0, `oldest published session ${oldest.id} (${oldest.date}/${oldest.subjectId}) still serves its imported takes`);
  check(
    oldestDetail.takes.every((t) => t.archival === true),
    "every imported take on that session reports archival: true",
  );
  check(
    oldestDetail.takes.every((t) => t.verified === false),
    "every imported take on that session reports verified: false (archival, never cryptographically verified)",
  );

  if (failures.length > 0) {
    throw new Error(`smoke-e2e-assert: ${failures.length} assertion(s) failed:\n  - ${failures.join("\n  - ")}`);
  }
  console.log("=== smoke e2e assertions passed ===\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
