// Q41-regime-v5/C29-regime-v5 (PR 1665, issue 1652, D86; PR 1672): the regime runs methodology v5, and its published label is cut on
// the composite, not on a second ranking of it. Read-only: the ledger's methodology rows as rm_readonly and one GET through the
// public origin.
//
// WHAT IT REQUIRES:
//   - the newest ledger run is stamped v5 (v3 is never stamped again), and a v5 run succeeded;
//   - the served regime history holds, from the first v5 run's as-of day on, a label equal to the composite's bucket
//     (risk_off below the cut, risk_on above, neutral between; the cuts are the snapshot's bucketThresholds, else 0.33 and
//     0.67) on every day whose bucket has held CONFIRM_READINGS (5) consecutive days, the engine's own confirmation rule.
//     A label cut on the composite's rank would differ from the bucket on such days. Days before the first v5 run
//     are frozen (D83) and keep the label they were published under, so they are not graded;
//   - the served composite is on its own 0 to 1 scale.
// The check waits (polls the ledger) for the first v5 run: stage runs analytics hourly (D87), production every 3 hours,
// so the first v5 run is at most one slot after the boot. It gives up at --wait-minutes.
import type { VersionCheck } from "../../version-check.ts";
import { MAX_RANGE, readServed, type Point } from "../v0.9.0/_regime.ts";

export const CONFIRM_READINGS = 5;
export const DEFAULT_CUTS: { riskOff: number; riskOn: number } = { riskOff: 0.33, riskOn: 0.67 };

export type Bucket = "risk_off" | "neutral" | "risk_on";

/** PURE. The composite's bucket under the cuts. */
export function bucketOf(composite: number, cuts: { riskOff: number; riskOn: number } = DEFAULT_CUTS): Bucket {
  return composite < cuts.riskOff ? "risk_off" : composite > cuts.riskOn ? "risk_on" : "neutral";
}

/** PURE. The cuts a snapshot carries, or the defaults when it carries none or implausible ones. */
export function cutsOf(t: unknown): { riskOff: number; riskOn: number } {
  const o = (t ?? {}) as { risk_off?: unknown; risk_on?: unknown };
  const lo = Number(o.risk_off);
  const hi = Number(o.risk_on);
  return lo > 0 && hi > lo && hi < 1 ? { riskOff: lo, riskOn: hi } : { ...DEFAULT_CUTS };
}

const DAY = 86_400_000;
const nextDay = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** PURE. Why the served labels are not cut on the composite from `v5Start` on; empty when they are. `history` is oldest first. */
export function labelProblems(history: readonly Point[], v5Start: string, cuts: { riskOff: number; riskOn: number } = DEFAULT_CUTS): { problems: string[]; graded: number } {
  const out: string[] = [];
  let graded = 0;
  let run = 0;
  let prev: Bucket | null = null;
  let prevDate: string | null = null;
  for (const p of history) {
    if (p.composite === null) {
      run = 0;
      prev = null;
      prevDate = p.date;
      continue;
    }
    if (p.composite < 0 || p.composite > 1) out.push(`${p.date}: composite ${p.composite} is outside 0 to 1`);
    const b = bucketOf(p.composite, cuts);
    // The engine confirms a bucket on the v5 composite series. Days before the first v5 run carry the frozen v3 composite (D83),
    // which is not that series, so a streak never counts them (stage run 20261119T152050Z: 51 frozen neutral days, first v5 day risk_off).
    run = p.date >= v5Start && prev === b && prevDate !== null && prevDate >= v5Start && nextDay(prevDate) === p.date ? run + 1 : 1;
    prev = b;
    prevDate = p.date;
    if (p.date >= v5Start && run >= CONFIRM_READINGS) {
      graded += 1;
      if (p.regime !== b) out.push(`${p.date}: composite ${p.composite} has been ${b} for ${run} days, the label is ${p.regime}`);
    }
  }
  return { problems: out, graded };
}

export interface LedgerRead {
  /** The newest run's methodology label, or null when the ledger holds no run. */
  readonly newestLabel: string | null;
  /** The as-of day of the first succeeded v5 run, or null when none has. */
  readonly v5Start: string | null;
}

export async function readLedger(db: { query<T>(text: string): Promise<T[]> }): Promise<LedgerRead> {
  const [newest] = await db.query<{ label: string }>("SELECT m.version_label AS label FROM analytics_ledger_runs r JOIN analytics_ledger_methodology_versions m ON m.id = r.methodology_version_id ORDER BY r.id DESC LIMIT 1");
  const [first] = await db.query<{ asof: string | null }>("SELECT min(r.asof)::text AS asof FROM analytics_ledger_runs r JOIN analytics_ledger_methodology_versions m ON m.id = r.methodology_version_id WHERE m.version_label = 'v5' AND EXISTS (SELECT 1 FROM analytics_ledger_run_events e WHERE e.run_id = r.id AND e.event_type = 'succeeded')");
  return { newestLabel: newest?.label ?? null, v5Start: first?.asof ?? null };
}

/** PURE. Why the ledger does not show methodology v5 running; empty when it does. */
export function ledgerProblems(l: LedgerRead): string[] {
  const out: string[] = [];
  if (l.newestLabel !== "v5") out.push(`the newest ledger run is stamped ${l.newestLabel ?? "(none)"}, not v5`);
  if (l.v5Start === null) out.push("no v5 run has succeeded");
  return out;
}

const flag = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export default (async (ctx) => {
  const db = await ctx.db();
  const deadline = Date.now() + flag("--wait-minutes", 200) * 60_000;
  let ledger = await readLedger(db);
  while (ledger.v5Start === null && Date.now() < deadline) {
    await Bun.sleep(5 * 60_000);
    ledger = await readLedger(db);
  }
  const problems = ledgerProblems(ledger);
  let graded = 0;
  if (ledger.v5Start !== null) {
    const served = await readServed(ctx);
    if ("error" in served) problems.push(served.error);
    else {
      const res = await ctx.http(`/api/dashboards/regime-snapshots?range=${MAX_RANGE}&rm-v0100-regime=${Date.now()}`);
      let cuts = { ...DEFAULT_CUTS };
      try {
        cuts = cutsOf((JSON.parse(res.text) as { latest?: { bucketThresholds?: unknown } }).latest?.bucketThresholds);
      } catch {
        // the defaults stand
      }
      const r = labelProblems([...served.history].sort((a, b) => (a.date < b.date ? -1 : 1)), ledger.v5Start, cuts);
      graded = r.graded;
      problems.push(...r.problems);
    }
  }
  return { found: { ...ledger, gradedDays: graded }, problems };
}) satisfies VersionCheck;
