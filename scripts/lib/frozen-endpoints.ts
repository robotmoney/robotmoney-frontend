// The bake plan: every API endpoint the buildless frontend requests, so the
// frozen static build can answer all of them offline. Kept in ONE place so
// a new frontend endpoint that isn't baked fails loudly (the "no silent gap"
// analog of the fidelity pattern) — scripts/tests/frozen-endpoints.test.ts
// cross-checks this plan against the actual api.get call sites in the app JS.
//
// The snapshots are written as static JSON keyed by request *pathname* only
// (query strings are dropped — a frozen snapshot is a single point in time) and
// served under STATIC_DATA_BASE (/data); lib/api.js resolves them in static mode.
// Every plan key below is therefore a pathname.
import { ROUTES, path } from "../../frontend/public/assets/js/app/contract/routes.js";

// The research signal keys the site exposes (nav + blog link to /research/<key>).
// Matches scripts/demo.ts researchKeys.
export const RESEARCH_KEYS = ["channel-divergence", "late-cycle-signals"] as const;

// Comment threads the frontend mounts (home.html: commentsThread('home')).
export const COMMENT_PAGES = ["home"] as const;

/**
 * GET route templates the frontend fetches (from the shared contract). Templates
 * with :params are expanded at bake time from discovered list data. This list is
 * the source of truth the completeness test asserts the app JS never exceeds.
 */
export const GET_ROUTE_TEMPLATES: readonly string[] = [
  ROUTES.health,
  ROUTES.dashboards.regimeSnapshots,
  ROUTES.dashboards.researchSignal, // :key
  ROUTES.committee.sessions,
  ROUTES.committee.session, // :date/:subject
  ROUTES.committee.members,
  ROUTES.committee.member, // :id
  ROUTES.committee.brief, // ?date=&subject=
];

/** POST routes the frontend calls — no-ops in a point-in-time frozen snapshot. */
export const WRITE_ROUTE_TEMPLATES: readonly string[] = [
  ROUTES.comments.create,
  ROUTES.committee.apply,
];

/**
 * Pathname keys that MUST exist in a completed bake regardless of discovered
 * data. Parameterised keys (member/:id, session/:date/:subject) are discovered
 * from the list endpoints and validated separately at bake time.
 */
export function requiredFrozenKeys(): string[] {
  return [
    ROUTES.health,
    ROUTES.dashboards.regimeSnapshots,
    ROUTES.committee.sessions,
    ROUTES.committee.members,
    ROUTES.comments.list,
    ...RESEARCH_KEYS.map((k) => path(ROUTES.dashboards.researchSignal, { key: k })),
  ];
}

/** A single endpoint to bake: the URL to fetch and the pathname key to store it under. */
export interface BakeTarget {
  key: string; // RM_FROZEN key (pathname only)
  url: string; // request URL (may carry a query the backend needs)
}

/** Static (non-parameterised) GET targets, always baked first. */
export function staticBakeTargets(): BakeTarget[] {
  const targets: BakeTarget[] = [
    { key: ROUTES.health, url: ROUTES.health },
    { key: ROUTES.dashboards.regimeSnapshots, url: `${ROUTES.dashboards.regimeSnapshots}?range=180` },
    { key: ROUTES.committee.sessions, url: ROUTES.committee.sessions },
    { key: ROUTES.committee.members, url: ROUTES.committee.members },
  ];
  for (const key of RESEARCH_KEYS) {
    const p = path(ROUTES.dashboards.researchSignal, { key });
    targets.push({ key: p, url: p });
  }
  for (const page of COMMENT_PAGES) {
    targets.push({ key: ROUTES.comments.list, url: `${ROUTES.comments.list}?page=${encodeURIComponent(page)}` });
  }
  return targets;
}

/** Per-member detail targets, from the discovered members list. */
export function memberBakeTargets(ids: string[]): BakeTarget[] {
  return ids.map((id) => {
    const p = path(ROUTES.committee.member, { id });
    return { key: p, url: p };
  });
}

/** Per-session detail + brief targets, from the discovered sessions list. */
export function sessionBakeTargets(sessions: { date: string; subject: string }[]): BakeTarget[] {
  const out: BakeTarget[] = [];
  for (const s of sessions) {
    out.push({ key: path(ROUTES.committee.session, { date: s.date, subject: s.subject }), url: path(ROUTES.committee.session, { date: s.date, subject: s.subject }) });
    // brief is query-keyed; the shim drops the query, so the LAST-written brief
    // wins for the pathname. That's fine for a point-in-time snapshot (the
    // committee view renders one session at a time).
    out.push({ key: ROUTES.committee.brief, url: `${ROUTES.committee.brief}?date=${encodeURIComponent(s.date)}&subject=${encodeURIComponent(s.subject)}` });
  }
  return out;
}
