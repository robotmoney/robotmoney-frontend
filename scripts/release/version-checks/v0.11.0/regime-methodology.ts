// Q40-regime-methodology/C28-regime-methodology (PR 1755, issue 1753, D96 proposed): regime methodology v5 is computed
// beside the served line, stored under its own artifact kind, and served only behind `?methodology=`. Read-only: the
// ledger as rm_readonly and three GETs through the public origin.
//
// WHAT IT REQUIRES:
//   - a v5 regime run has succeeded (the check polls the ledger for the first one after the boot: stage ticks hourly
//     (D87), production every 3 hours; it gives up at --wait-minutes, default 200);
//   - every v5 run's `regime_snapshots` artifact is the empty list, and a succeeded v5 run froze a
//     `regime_beside_snapshots` artifact (migration 0136): nothing of v5 reaches the main line's kind;
//   - GET /api/dashboards/regime-snapshots?methodology=v5 answers 200 with `methodology: "v5"` and a latest snapshot
//     stamped v5;
//   - GET /api/dashboards/regime-snapshots?methodology=<no such version> answers 400 and names v5 among the allowed values.
import type { VersionCheck } from "../../version-check.ts";

export const BESIDE = "v5";

export interface BesideLedger {
  /** Succeeded v5 regime runs. */
  readonly succeeded: number;
  /** v5 runs whose regime_snapshots artifact holds a row. */
  readonly leaked: number;
  /** Succeeded v5 runs that froze a regime_beside_snapshots artifact. */
  readonly besideArtifacts: number;
}

/** PURE. Why the ledger does not show v5 beside the main line; empty when it does. */
export function besideLedgerProblems(l: BesideLedger): string[] {
  const out: string[] = [];
  if (l.succeeded === 0) out.push("no v5 regime run has succeeded");
  else if (l.besideArtifacts === 0) out.push("no succeeded v5 run froze a regime_beside_snapshots artifact");
  if (l.leaked > 0) out.push(`${l.leaked} v5 run(s) wrote rows into a regime_snapshots artifact (the main line's kind)`);
  return out;
}

/** PURE. Why the methodology parameter does not answer as PR 1755 declares; empty when it does. */
export function methodologyAnswerProblems(v5: { status: number; text: string }, unknown: { status: number; text: string }): string[] {
  const out: string[] = [];
  if (v5.status !== 200) out.push(`?methodology=v5 answered ${v5.status}, not 200`);
  else {
    try {
      const b = JSON.parse(v5.text) as { methodology?: unknown; latest?: { version?: unknown } | null };
      if (b.methodology !== BESIDE) out.push(`?methodology=v5 names methodology ${JSON.stringify(b.methodology)}, not "v5"`);
      if (!b.latest) out.push("?methodology=v5 serves no latest snapshot");
      else if (b.latest.version !== BESIDE) out.push(`?methodology=v5 serves a latest snapshot stamped ${String(b.latest.version)}, not v5`);
    } catch {
      out.push("?methodology=v5 is not JSON");
    }
  }
  if (unknown.status !== 400) out.push(`an unknown methodology answered ${unknown.status}, not 400`);
  else {
    try {
      const b = JSON.parse(unknown.text) as { allowed?: unknown };
      if (!Array.isArray(b.allowed) || !b.allowed.includes(BESIDE)) out.push(`the 400 for an unknown methodology does not name v5 among the allowed values (${JSON.stringify(b.allowed)})`);
    } catch {
      out.push("the 400 for an unknown methodology is not JSON");
    }
  }
  return out;
}

const RUNS_V5 = "FROM analytics_ledger_runs r JOIN analytics_ledger_methodology_versions m ON m.id = r.methodology_version_id WHERE m.version_label = 'v5' AND r.tool_id = 'regime'";
const SUCCEEDED = "EXISTS (SELECT 1 FROM analytics_ledger_run_events e WHERE e.run_id = r.id AND e.event_type = 'succeeded')";

export async function readBesideLedger(db: { query<T>(text: string): Promise<T[]> }): Promise<BesideLedger> {
  const [s] = await db.query<{ n: string }>(`SELECT count(*)::text AS n ${RUNS_V5} AND ${SUCCEEDED}`);
  const [l] = await db.query<{ n: string }>(`SELECT count(*)::text AS n ${RUNS_V5} AND EXISTS (SELECT 1 FROM analytics_output_snapshots o WHERE o.run_id = r.id AND o.artifact_kind = 'regime_snapshots' AND cardinality(o.natural_keys) > 0)`);
  const [b] = await db.query<{ n: string }>(`SELECT count(*)::text AS n ${RUNS_V5} AND ${SUCCEEDED} AND EXISTS (SELECT 1 FROM analytics_output_snapshots o WHERE o.run_id = r.id AND o.artifact_kind = 'regime_beside_snapshots')`);
  return { succeeded: Number(s?.n ?? 0), leaked: Number(l?.n ?? 0), besideArtifacts: Number(b?.n ?? 0) };
}

const flag = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export default (async (ctx) => {
  const db = await ctx.db();
  const deadline = Date.now() + flag("--wait-minutes", 200) * 60_000;
  let ledger = await readBesideLedger(db);
  while (ledger.succeeded === 0 && Date.now() < deadline) {
    await Bun.sleep(5 * 60_000);
    ledger = await readBesideLedger(db);
  }
  const problems = besideLedgerProblems(ledger);
  const v5 = await ctx.http(`/api/dashboards/regime-snapshots?methodology=v5&range=30&rm-v0110-methodology=${Date.now()}`);
  const unknown = await ctx.http(`/api/dashboards/regime-snapshots?methodology=v0&rm-v0110-methodology=${Date.now()}`);
  problems.push(...methodologyAnswerProblems(v5, unknown));
  return { found: { ...ledger, v5Status: v5.status, unknownStatus: unknown.status }, problems };
}) satisfies VersionCheck;
