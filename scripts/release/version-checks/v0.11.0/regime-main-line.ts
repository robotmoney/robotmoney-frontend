// Q41-regime-main-line/C29-regime-main-line (PR 1755, issue 1753, D96 proposed; PRs 1744 to 1747): the served regime line
// is still methodology v4 once v5 runs beside it. CURRENT_REGIME_VERSION stays v4 and the main-line response keeps its
// shape. Read-only: the ledger as rm_readonly and one GET through the public origin. It runs after
// Q40-regime-methodology (C28 on production), so a v5 run has already succeeded when it reads.
//
// WHAT IT REQUIRES:
//   - the newest succeeded main-line regime run (any methodology but v5) is stamped v4;
//   - GET /api/dashboards/regime-snapshots without `methodology` answers 200 with no `methodology` field, and its latest
//     snapshot is stamped v4 with a composite equal to the 1/n mean of its macro, onchain and factor indices (D89).
import type { VersionCheck } from "../../version-check.ts";
import { compositeMeanProblems } from "../v0.10.0/regime-v4.ts";

export interface MainLineRead {
  /** The newest succeeded non-v5 regime run's label, or null when there is none. */
  readonly newestLabel: string | null;
}

/** PURE. Why the ledger's main line is not v4; empty when it is. */
export function mainLineLedgerProblems(r: MainLineRead): string[] {
  if (r.newestLabel === null) return ["the ledger holds no succeeded main-line regime run"];
  return r.newestLabel === "v4" ? [] : [`the newest succeeded main-line regime run is stamped ${r.newestLabel}, not v4`];
}

/** PURE. Why the default regime-snapshots answer is not the unchanged v4 main line; empty when it is. */
export function mainLineAnswerProblems(res: { status: number; text: string }): string[] {
  if (res.status !== 200) return [`regime-snapshots answered ${res.status}, not 200`];
  let b: { methodology?: unknown; latest?: unknown };
  try {
    b = JSON.parse(res.text) as typeof b;
  } catch {
    return ["regime-snapshots is not JSON"];
  }
  const out: string[] = [];
  if ("methodology" in b) out.push(`the main-line answer carries a methodology field (${JSON.stringify(b.methodology)}): without the parameter the body is unchanged`);
  out.push(...compositeMeanProblems(b.latest));
  return out;
}

export async function readMainLine(db: { query<T>(text: string): Promise<T[]> }): Promise<MainLineRead> {
  const [r] = await db.query<{ label: string }>(
    "SELECT m.version_label AS label FROM analytics_ledger_runs r JOIN analytics_ledger_methodology_versions m ON m.id = r.methodology_version_id WHERE r.tool_id = 'regime' AND m.version_label <> 'v5' AND EXISTS (SELECT 1 FROM analytics_ledger_run_events e WHERE e.run_id = r.id AND e.event_type = 'succeeded') ORDER BY r.id DESC LIMIT 1",
  );
  return { newestLabel: r?.label ?? null };
}

export default (async (ctx) => {
  const db = await ctx.db();
  const ledger = await readMainLine(db);
  const res = await ctx.http(`/api/dashboards/regime-snapshots?range=30&rm-v0110-main=${Date.now()}`);
  const problems = [...mainLineLedgerProblems(ledger), ...mainLineAnswerProblems(res)];
  return { found: { ...ledger, status: res.status }, problems };
}) satisfies VersionCheck;
