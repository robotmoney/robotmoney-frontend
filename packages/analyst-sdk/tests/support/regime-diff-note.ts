// The diff note of issue 1741: how the v4 history on the committed SDK fixture
// moves when windows count observation days and a missing panel gives a NaN
// composite. "Before" is the old rule, run by the same code with the rule off
// (forward-filled windows, composite re-based onto the panels that are finite).
// "After" is the current v4. Pure: no clock. scripts/regime-diff-note.ts writes
// tests/golden/regime-diff-1741.json; tests/observation-windows.test.ts
// recomputes it and compares.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INDICATORS } from "../../src/analyze/indicators.ts";
import { computeRegime, regimeLabels } from "../../src/analyze/compute.ts";
import { parseRawHistory, toHistory } from "../../src/input/load.ts";
import { prepareRegimeInputs } from "../../src/prepare.ts";
import { BACKFILL_START } from "../../src/run.ts";
import { resolveInputHistory } from "../../src/series-ids.ts";
import { ratiosFromLegs } from "../../src/transform/ratios.ts";
import { PANELS } from "../../src/analyze/indicators.ts";

export const NOTE_PATH = join(import.meta.dir, "..", "golden", "regime-diff-1741.json");

export interface DiffNote {
  days: number;
  daysChanged: number;
  labelsChanged: number;
  largestCompositeChange: { date: string; before: number; after: number; abs: number };
  firstCompositeDay: { before: string | null; after: string | null };
  // Indicators whose last weight (and so its panel weight) is zero under one rule and not the other.
  weightFloorMoves: { id: string; before: number; after: number }[];
  // Indicators whose first ranked day moved.
  firstRankedDayMoves: { id: string; before: string | null; after: string | null }[];
}

const round = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);

export function computeDiffNote(): DiffNote {
  const fixture = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "..", "fixtures", "raw-indicator-history.csv"), "utf8")));
  const raw = ratiosFromLegs(fixture, resolveInputHistory(fixture));
  let asof = BACKFILL_START;
  for (const rows of Object.values(raw)) if (rows.length && rows[rows.length - 1]!.date > asof) asof = rows[rows.length - 1]!.date;

  const newIn = prepareRegimeInputs(raw, { start: BACKFILL_START, asof, version: "v4" });
  const after = computeRegime(newIn.transformed, newIn.dateAxis, [...PANELS], newIn.ages, undefined, "v4", undefined, undefined, undefined, newIn.carried);
  const oldIn = prepareRegimeInputs(raw, { start: BACKFILL_START, asof, version: "v4", observationDays: false });
  const before = computeRegime(oldIn.transformed, oldIn.dateAxis, [...PANELS], oldIn.ages, undefined, "v4");
  // The old composite re-bases onto the panels that are finite that day.
  const oldComposite = before.dateAxis.map((_, i) => {
    const vs = PANELS.map((p) => before.panelIndices[p]![i]!).filter(Number.isFinite);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN;
  });
  const oldLabels = regimeLabels(oldComposite, []);

  let daysChanged = 0;
  let labelsChanged = 0;
  let largest = { date: "", before: NaN, after: NaN, abs: 0 };
  let firstBefore: string | null = null;
  let firstAfter: string | null = null;
  for (let i = 0; i < after.dateAxis.length; i++) {
    const day = after.dateAxis[i]!;
    const a = after.composite[i]!;
    const b = oldComposite[i]!;
    if (firstBefore === null && Number.isFinite(b)) firstBefore = day;
    if (firstAfter === null && Number.isFinite(a)) firstAfter = day;
    const same = Object.is(round(a), round(b)) && after.regime[i] === oldLabels[i];
    if (!same) daysChanged++;
    if (after.regime[i] !== oldLabels[i]) labelsChanged++;
    const d = Math.abs(a - b);
    if (Number.isFinite(d) && d > largest.abs) largest = { date: day, before: round(b)!, after: round(a)!, abs: round(d)! };
  }
  const weightFloorMoves: DiffNote["weightFloorMoves"] = [];
  const firstRankedDayMoves: DiffNote["firstRankedDayMoves"] = [];
  const firstFinite = (xs: number[]) => {
    const k = xs.findIndex(Number.isFinite);
    return k < 0 ? null : after.dateAxis[k]!;
  };
  for (const ind of INDICATORS) {
    const wa = after.weightsByPanel[ind.panel]?.[ind.id];
    const wb = before.weightsByPanel[ind.panel]?.[ind.id];
    if (wa !== undefined && wb !== undefined && (wa === 0) !== (wb === 0)) weightFloorMoves.push({ id: ind.id, before: round(wb)!, after: round(wa)! });
    const fb = firstFinite(before.ranks[ind.id]!);
    const fa = firstFinite(after.ranks[ind.id]!);
    if (fb !== fa) firstRankedDayMoves.push({ id: ind.id, before: fb, after: fa });
  }
  return { days: after.dateAxis.length, daysChanged, labelsChanged, largestCompositeChange: largest, firstCompositeDay: { before: firstBefore, after: firstAfter }, weightFloorMoves, firstRankedDayMoves };
}
