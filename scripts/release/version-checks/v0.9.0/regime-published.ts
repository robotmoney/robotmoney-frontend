// Q43-regime-published/C31-regime-published (PR 1646, issue 1182, D83): the regime history serves each
// day's PUBLISHED figure, selected from the frozen ledger, never the newest run's recomputation.
// Read-only: the ledger's metadata and the chosen rows as rm_readonly, and one GET through the public origin.
//
// WHAT IT REQUIRES, against the target's OWN ledger (./_regime.ts states the rule):
//   - GET /api/dashboards/regime-snapshots says `source: "ledger"`;
//   - its history holds exactly the published days: every day before the ledger start (from the first
//     artifact) and every day from the start that an artifact published, up to today; a gap day is absent;
//   - each published day's composite and regime equal that day's row in the artifact the rule chose (today's
//     row is compared only when no regime artifact landed while the check read);
//   - on a ledger that starts on 2026-09-21 (production's, and stage's, which is a production dump), the
//     figures D83 and issue 1182 record from the production replica: 2026-09-21 published risk_on at
//     0.5759, 2026-09-26 and 2026-09-27 published risk_on (they were served neutral before the fix),
//     2026-09-28 published (by the first run after the outage), and 2026-09-29 a gap.
// `found.recomputedDiffers` counts the days where the newest run's recomputation differs from what is served:
// the days the fix keeps from moving.
import type { VersionCheck } from "../../version-check.ts";
import { MAX_RANGE, newestArtifactId, readArtifactRows, readArtifacts, readServed, selectPublished, type Point, type Selection } from "./_regime.ts";

/** Production's ledger start and the figures recorded from it (D83; issue 1182, 2026-11-14 replica table). */
export const PRODUCTION_LEDGER_START = "2026-09-21";
export const PINNED: readonly { readonly date: string; readonly regime?: string; readonly composite4?: string; readonly absent?: true }[] = [
  { date: "2026-09-21", regime: "risk_on", composite4: "0.5759" },
  { date: "2026-09-26", regime: "risk_on" },
  { date: "2026-09-27", regime: "risk_on" },
  { date: "2026-09-28" },
  { date: "2026-09-29", absent: true },
];

/** PURE. Why the served history is not the ledger's published line; empty when it is. `rows` holds the chosen rows by day. */
export function publishedProblems(sel: Selection, beforeRows: ReadonlyMap<string, Point>, rows: ReadonlyMap<string, Point>, served: { today: string; source: string | null; history: readonly Point[] }, compareToday: boolean): string[] {
  const out: string[] = [];
  if (sel.start === null) return ["the ledger holds no regime artifact that carries its as-of day, so nothing has been published to check"];
  if (served.source !== "ledger") out.push(`the endpoint serves source ${JSON.stringify(served.source)}, not the ledger's published figures`);
  const expected = new Set<string>([...beforeRows.keys(), ...[...sel.byDay.keys()].filter((d) => d <= served.today)]);
  const window = served.history.length >= MAX_RANGE ? served.history[0]?.date ?? "" : "";
  const want = [...expected].filter((d) => d >= window).sort();
  const got = served.history.map((p) => p.date);
  const gotSet = new Set(got);
  const missing = want.filter((d) => !gotSet.has(d));
  const extra = got.filter((d) => !expected.has(d));
  if (missing.length > 0) out.push(`${missing.length} published day(s) are not served: ${missing.slice(0, 5).join(", ")}`);
  if (extra.length > 0) out.push(`${extra.length} served day(s) no artifact published (a gap filled by a recomputation): ${extra.slice(0, 5).join(", ")}`);
  if (new Set(got).size !== got.length) out.push("the served history lists a day twice");
  let moved = 0;
  const examples: string[] = [];
  for (const p of served.history) {
    if (p.date === served.today && !compareToday) continue;
    const want = p.date < (sel.start ?? "") ? beforeRows.get(p.date) : rows.get(p.date);
    if (want === undefined) continue;
    if (want.composite !== p.composite || want.regime !== p.regime) {
      moved += 1;
      if (examples.length < 5) examples.push(`${p.date} served ${p.composite} ${p.regime}, published ${want.composite} ${want.regime}`);
    }
  }
  if (moved > 0) out.push(`${moved} day(s) serve a figure other than the one published: ${examples.join("; ")}`);
  return out;
}

/** PURE. Where production's recorded figures are not served; only for a ledger that starts on production's start day. */
export function pinnedProblems(start: string | null, history: readonly Point[]): string[] {
  if (start !== PRODUCTION_LEDGER_START) return [];
  const byDay = new Map(history.map((p) => [p.date, p]));
  const out: string[] = [];
  for (const pin of PINNED) {
    const p = byDay.get(pin.date);
    if (pin.absent) {
      if (p !== undefined) out.push(`${pin.date} is served (${p.composite} ${p.regime}); no run published it, so it is a gap`);
      continue;
    }
    if (p === undefined) { out.push(`${pin.date} is not served; it was published`); continue; }
    if (pin.regime !== undefined && p.regime !== pin.regime) out.push(`${pin.date} is served ${p.regime}, published ${pin.regime}`);
    if (pin.composite4 !== undefined && (p.composite === null || p.composite.toFixed(4) !== pin.composite4)) out.push(`${pin.date} is served composite ${p.composite}, published ${pin.composite4}`);
  }
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const newestBefore = await newestArtifactId(db);
  const artifacts = await readArtifacts(db);
  const served = await readServed(ctx);
  if ("error" in served) return { found: {}, problems: [served.error] };
  const compareToday = (await newestArtifactId(db)) === newestBefore;
  const sel = selectPublished(artifacts, served.today);
  if (sel.start === null || sel.first === null) return { found: { artifacts: artifacts.length }, problems: publishedProblems(sel, new Map(), new Map(), served, compareToday) };
  const beforeRows = await readArtifactRows(db, sel.first.id, { before: sel.start });
  const byArtifact = new Map<number, string[]>();
  for (const [day, a] of sel.byDay) byArtifact.set(a.id, [...(byArtifact.get(a.id) ?? []), day]);
  const rows = new Map<string, Point>();
  for (const [id, days] of byArtifact) for (const [d, p] of await readArtifactRows(db, id, { days })) if (days.includes(d)) rows.set(d, p);
  // The newest artifact's recomputation of the same days: what a reader would see without the fix.
  const newest = [...artifacts].sort((a, b) => b.id - a.id)[0]!;
  const recomputed = await readArtifactRows(db, newest.id, { days: served.history.filter((p) => p.date < served.today).map((p) => p.date).slice(-120) });
  const recomputedDiffers = [...recomputed.values()].filter((r) => { const s = served.history.find((p) => p.date === r.date); return s !== undefined && (s.composite !== r.composite || s.regime !== r.regime); }).length;
  return {
    found: {
      artifacts: artifacts.length, ledgerStart: sel.start, publishedDays: sel.byDay.size, gaps: sel.gaps, beforeStartDays: beforeRows.size,
      served: served.history.length, source: served.source, today: served.today, comparedToday: compareToday,
      newestArtifact: newest.id, recomputedDiffersOfLast120: recomputedDiffers,
      pinned: Object.fromEntries(PINNED.map((p) => [p.date, served.history.find((h) => h.date === p.date) ?? null])),
    },
    problems: [...publishedProblems(sel, beforeRows, rows, served, compareToday), ...pinnedProblems(sel.start, served.history)],
  };
}) satisfies VersionCheck;
