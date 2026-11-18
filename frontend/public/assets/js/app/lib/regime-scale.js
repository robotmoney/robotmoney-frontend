// The regime read on the composite itself, not on the composite's rank.
//
// The engine publishes two numbers. The composite is the mean of the macro and
// on-chain indices; each index is a weighted mean of its indicators'
// percentiles, so the composite is already on a 0 to 1 scale. The engine then
// ranks that composite again against its own last three years, and cuts the
// published label on the rank. Lex, 2026-11-17 (RM-209): the composite is the
// number, and the label is cut on it.
//
// STAND-IN. Until the engine publishes that label, this derives it from the
// snapshots the API already serves, so the pages can show the method before
// it lands. The swarm, the session pages and the backtests still carry the
// engine's label. Delete this module once `regime` in the API is cut on the
// composite, and read the API's label again.

/** @typedef {"risk_off" | "neutral" | "risk_on"} RegimeKey */
/** @typedef {{ riskOff: number, riskOn: number }} Cuts */

/** @type {Cuts} */
export const COMPOSITE_CUTS = { riskOff: 0.33, riskOn: 0.67 };
// A new label holds after this many readings in a row in its bucket, the
// engine's own confirmation rule. Its one-day 2σ switch is not reproduced.
export const CONFIRM_READINGS = 5;

/** @param {any} t a snapshot's bucketThresholds @returns {Cuts} */
export function cutsOf(t) {
  const lo = Number(t?.risk_off), hi = Number(t?.risk_on);
  return lo > 0 && hi > lo && hi < 1 ? { riskOff: lo, riskOn: hi } : COMPOSITE_CUTS;
}

/** @param {unknown} v @param {Cuts} [cuts] @returns {RegimeKey | null} */
export function bucketOf(v, cuts = COMPOSITE_CUTS) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return n < cuts.riskOff ? "risk_off" : n > cuts.riskOn ? "risk_on" : "neutral";
}

/**
 * The label for each reading, oldest first: the first reading's bucket, then a
 * switch only once the new bucket has held for CONFIRM_READINGS in a row. A
 * missing reading keeps the label it follows and does not count toward a run.
 * @param {(number | null | undefined)[]} values @param {Cuts} [cuts] @returns {(RegimeKey | null)[]}
 */
export function confirmedRegimes(values, cuts = COMPOSITE_CUTS) {
  /** @type {RegimeKey | null} */ let held = null;
  /** @type {RegimeKey | null} */ let pending = null;
  let run = 0;
  return values.map((v) => {
    const b = bucketOf(v, cuts);
    if (b == null) return held;
    if (held == null) { held = b; return held; }
    if (b === held) { pending = null; run = 0; return held; }
    if (b === pending) run++; else { pending = b; run = 1; }
    if (run >= CONFIRM_READINGS) { held = b; pending = null; run = 0; }
    return held;
  });
}

const PANELS = ["macro", "onchain", "factor"];

/** A snapshot row with each panel's label cut on its own index. @param {any} row @param {Cuts} cuts */
function panelsOnIndex(row, cuts) {
  const out = { ...row };
  for (const p of PANELS) {
    const b = bucketOf(row[`${p}Index`], cuts);
    if (b) out[`${p}Regime`] = b;
  }
  return out;
}

/**
 * The regime-snapshots response with every label cut on the composite: each
 * history row's `regime`, the latest one's, and each panel's on its index.
 * Nothing else is touched, so a caller reads it as it read the API's.
 * @template {{ latest?: any, history?: any[] }} T
 * @param {T} data @returns {T}
 */
export function readOnComposite(data) {
  if (!data || typeof data !== "object") return data;
  const cuts = cutsOf(data.latest?.bucketThresholds);
  const sorted = (data.history || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const labels = confirmedRegimes(sorted.map((r) => r.composite), cuts);
  const byDate = new Map(sorted.map((r, i) => [r.date, labels[i]]));
  const history = (data.history || []).map((r) => ({ ...panelsOnIndex(r, cuts), regime: byDate.get(r.date) ?? r.regime }));
  const l = data.latest;
  const latest = l ? { ...panelsOnIndex(l, cuts), regime: byDate.get(l.date) ?? bucketOf(l.composite, cuts) ?? l.regime } : l;
  return { ...data, latest, history };
}
