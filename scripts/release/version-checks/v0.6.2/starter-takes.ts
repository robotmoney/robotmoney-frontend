// Q39-starter-takes/C26-starter-takes (PR 1334, issue 1268): the starter agent submits a take to
// every collecting session, not only the newest one.
//
// What 1334 shipped is the starter agent script (scripts/starter-swarm-agent.ts,
// which members run themselves; the in-house participants do not) and the
// published docs that tell an agent to poll `open-sessions`. The deploy carries
// the docs and the route the script reads, so this check reads those:
//   - GET /api/swarm/open-sessions answers 200 with exactly the sessions the
//     database holds as collecting (the list the script walks);
//   - the served api-reference and participation pages tell an agent to
//     "poll open-sessions", and no longer "poll open-session".
// Gap, stated: the script's own behaviour (a take to each listed session) is
// proven by CI's live-stack starter run (e2e-swarm, smoke-ci-checks.ts), not
// by the deploy. The in-house agents' takes are a different code path
// (scripts/agent/participant), so counting them would not test 1334.
import type { VersionCheck } from "../../version-check.ts";

export const DOC_PAGES: readonly string[] = Object.freeze([
  "/views/docs/investment-swarm/api-reference.html",
  "/views/docs/investment-swarm/participation.html",
]);

/** The polling advice 1334 wrote into both pages, and the one it replaced. (`open-session` itself is still named as a response shape.) */
export const NEW_ADVICE = "poll <code>open-sessions</code>";
export const OLD_ADVICE = "poll <code>open-session</code>";

export interface StarterObservation {
  readonly apiStatus: number;
  readonly apiIds: readonly string[];
  readonly dbIds: readonly string[];
  readonly docs: readonly { path: string; status: number; text: string }[];
}

/** PURE. Every way the open-sessions list or its docs are not what 1334 shipped. */
export function starterProblems(o: StarterObservation): string[] {
  const out: string[] = [];
  if (o.apiStatus !== 200) out.push(`GET /api/swarm/open-sessions answered ${o.apiStatus}`);
  else {
    const api = new Set(o.apiIds);
    const db = new Set(o.dbIds);
    for (const id of db) if (!api.has(id)) out.push(`collecting session ${id} is missing from open-sessions`);
    for (const id of api) if (!db.has(id)) out.push(`open-sessions lists ${id}, which the database does not hold as collecting`);
  }
  for (const d of o.docs) {
    if (d.status !== 200) { out.push(`${d.path} answered ${d.status}`); continue; }
    if (!d.text.includes(NEW_ADVICE)) out.push(`${d.path} does not tell an agent to ${NEW_ADVICE.replace(/<\/?code>/g, "")}`);
    if (d.text.includes(OLD_ADVICE)) out.push(`${d.path} still tells an agent to ${OLD_ADVICE.replace(/<\/?code>/g, "")} (the newest session only)`);
  }
  return out;
}

export default (async (ctx) => {
  const res = await ctx.http("/api/swarm/open-sessions");
  let apiIds: string[] = [];
  try {
    const body = JSON.parse(res.text) as { sessions?: { id?: unknown; sessionId?: unknown }[] };
    apiIds = (body.sessions ?? []).map((s) => String(s.id ?? s.sessionId ?? ""));
  } catch {
    apiIds = [];
  }
  const db = await ctx.db();
  const dbIds = (await db.query<{ id: string }>("SELECT id::text AS id FROM swarm_sessions WHERE state = 'collecting' ORDER BY id")).map((r) => r.id);
  const docs: { path: string; status: number; text: string }[] = [];
  for (const path of DOC_PAGES) {
    const r = await ctx.http(path);
    docs.push({ path, status: r.status, text: r.text });
  }
  return {
    found: {
      openSessions: { status: res.status, ids: apiIds },
      collectingInDb: dbIds,
      docs: docs.map((d) => ({ path: d.path, status: d.status, advisesOpenSessions: d.text.includes(NEW_ADVICE) })),
      gap: "the starter script's own behaviour is proven by CI's live-stack starter run, not by the deploy",
    },
    problems: starterProblems({ apiStatus: res.status, apiIds, dbIds, docs }),
  };
}) satisfies VersionCheck;
