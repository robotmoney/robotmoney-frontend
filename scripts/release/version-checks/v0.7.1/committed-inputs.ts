// Q38-committed-inputs/C26-committed-inputs (PR 1533, AN-16; PR 1536, issue 1534): the regime run
// computes from the ledger heads GET /api/analytics/committed-inputs reads, and freezes its vintage
// from exactly the versionIds that read returned.
//
// Two halves, both read-only:
//   1. The route answers on the target's api. Asked with no credential it answers 401 (the route
//      authenticates first); an api built before PR 1533 does not know the path and answers 404.
//      A new producer against such an api fails its regime run, which is why the rolling boot
//      replaces the api before analytics-producer (scripts/stack/stack.ts ROLLING_ORDER).
//   2. A regime run of this release went through it. The newest regime vintage
//      (analytics_data_vintages, read as rm_readonly) carries the commit /api/version reports. The
//      new producer reads committed-inputs before it computes, and a failed read or a refused
//      regimeVersionIds list (400) fails the run before its vintage is frozen, so a frozen vintage
//      of this commit is a run that read the route and whose read set the api accepted.
// A regime run starts at :30 every 3 hours (UTC). When the newest regime vintage predates the boot
// the check waits for one, polling every 5 minutes up to WAIT_MS; on stage, Q34a-analytics-load has
// already waited out a scheduled run, so it answers at once.
import { parseRunningVersion } from "../../ledger.ts";
import type { VersionCheck } from "../../version-check.ts";

export const ROUTE = "/api/analytics/committed-inputs";
/** The longest the check waits for a regime run of this release: one 3-hour cycle, the run itself, and margin. */
export const WAIT_MS = 200 * 60_000;
export const POLL_MS = 5 * 60_000;

/** PURE. Why the route's answer to a request with no credential does not show the route is there; empty when it does. */
export function routeProblems(status: number, body: string): string[] {
  if (status === 401) return [];
  if (status === 404) return [`GET ${ROUTE} answered 404: the api does not have the committed-inputs route (a build before PR 1533), so a new analytics-producer's regime run fails against it`];
  return [`GET ${ROUTE} with no credential answered ${status}, not 401 (the route authenticates first): ${body.slice(0, 200)}`];
}

export interface RegimeVintage {
  readonly id: string;
  readonly build_identity: string;
  readonly knowledge_time_cutoff: string;
  readonly created_at: string;
  readonly member_count: string;
}

/** PURE. Why the newest regime vintage is not one this release froze; empty when it is. */
export function vintageProblems(apiCommit: string | null, vintage: RegimeVintage | undefined): string[] {
  if (apiCommit === null) return ["/api/version reports no commit to compare with"];
  if (vintage === undefined) return ["the target holds no regime vintage"];
  if (vintage.build_identity === apiCommit) return [];
  return [`the newest regime vintage (${vintage.id}, frozen ${vintage.created_at}) carries build identity ${JSON.stringify(vintage.build_identity)}, /api/version reports ${apiCommit}: no regime run of this release has frozen a vintage within the wait`];
}

export interface CommittedInputsDeps {
  http(path: string, init?: RequestInit): Promise<{ status: number; text: string }>;
  newestRegimeVintage(): Promise<RegimeVintage | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(m: string): void;
  waitMs?: number;
  pollMs?: number;
}

export async function committedInputs(deps: CommittedInputsDeps): Promise<{ found: Record<string, unknown>; problems: string[] }> {
  const asof = new Date(deps.now()).toISOString().slice(0, 10);
  const route = await deps.http(`${ROUTE}?asof=${asof}`);
  const ver = await deps.http("/api/version");
  const running = parseRunningVersion(ver.status === 200 ? ver.text : null);
  const apiCommit = "error" in running ? null : running.commit;
  const deadline = deps.now() + (deps.waitMs ?? WAIT_MS);
  let vintage = await deps.newestRegimeVintage();
  let polls = 1;
  while (apiCommit !== null && vintage?.build_identity !== apiCommit && deps.now() < deadline) {
    deps.log(`[committed-inputs] newest regime vintage ${vintage?.id ?? "(none)"} carries ${vintage?.build_identity ?? "nothing"}, not ${apiCommit}; waiting for a regime run of this release`);
    await deps.sleep(deps.pollMs ?? POLL_MS);
    vintage = await deps.newestRegimeVintage();
    polls++;
  }
  return {
    found: { routeStatus: route.status, apiCommit, newestRegimeVintage: vintage ?? null, polls },
    problems: [...routeProblems(route.status, route.text), ...("error" in running ? [running.error] : []), ...vintageProblems(apiCommit, vintage)],
  };
}

export default (async (ctx) => {
  const db = await ctx.db();
  return committedInputs({
    http: ctx.http,
    newestRegimeVintage: async () => (await db.query<RegimeVintage>(
      "SELECT id::text AS id, build_identity, knowledge_time_cutoff::text AS knowledge_time_cutoff, created_at::text AS created_at, member_count::text AS member_count FROM analytics_data_vintages WHERE tool_id = 'regime' ORDER BY id DESC LIMIT 1",
    ))[0],
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  });
}) satisfies VersionCheck;
