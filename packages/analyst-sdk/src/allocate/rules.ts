// Apply a rule file to a label and the fired tilts: the weights for one decision.
import type { RuleFile, State, Weights } from "./types.ts";

export class RuleFileError extends Error {}

export function validateRuleFile(r: RuleFile): void {
  for (const s of ["risk_off", "neutral", "risk_on"] as State[]) {
    const w = r.states[s];
    if (!w) throw new RuleFileError(`${r.id}: state ${s} missing`);
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 1e-6) throw new RuleFileError(`${r.id}: state ${s} sums to ${sum}, not 100`);
    for (const [k, v] of Object.entries(w)) if (v < 0) throw new RuleFileError(`${r.id}: ${s}.${k} is negative`);
  }
  for (const k of r.yieldBook) for (const s of ["risk_off", "neutral", "risk_on"] as State[])
    if (!(k in r.states[s])) throw new RuleFileError(`${r.id}: yieldBook series ${k} not in state ${s}`);
}

const lower: Record<State, State> = { risk_on: "neutral", neutral: "risk_off", risk_off: "risk_off" };

// Move `freed` points into the yield book, pro rata to the book's current weights.
function redistribute(w: Weights, book: string[], freed: number): void {
  const tot = book.reduce((a, k) => a + (w[k] ?? 0), 0);
  if (tot <= 0) throw new RuleFileError("yield book has zero weight; nowhere to put freed weight");
  for (const k of book) w[k] = (w[k] ?? 0) + (freed * (w[k] ?? 0)) / tot;
}

export function weightsFor(rule: RuleFile, label: State | null, tiltsFired: string[]): { state: State; weights: Weights } {
  const state: State = rule.frozen ?? label ?? "neutral";
  const w: Weights = { ...rule.states[state] };
  for (const t of rule.tilts ?? []) {
    if (!tiltsFired.includes(t.id)) continue;
    if (t.onlyIn && !t.onlyIn.includes(state)) continue;
    const cur = w[t.sleeve] ?? 0;
    let next = cur;
    if (t.action === "down_one_notch") next = rule.states[lower[state]][t.sleeve] ?? 0;
    else if (t.action === "halfway_to_neutral") next = cur + (((rule.states.neutral[t.sleeve] ?? 0) - cur) / 2);
    const freed = cur - next;
    if (freed === 0) continue;
    w[t.sleeve] = next;
    redistribute(w, rule.yieldBook, freed);
  }
  return { state, weights: w };
}

// One-sided turnover between two weight vectors, in percent of NAV.
export function turnover(a: Weights, b: Weights): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let s = 0;
  for (const k of keys) s += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return s / 2;
}
