// Decision D78: compensated arithmetic moves published numbers in their
// last bits, so a report computed now is compared with an earlier one value by
// value instead of byte by byte. This walks two JSON texts in parallel and
// sorts every difference into one of three kinds:
//
//   structural  a key, key order, array length, type, string, boolean or null
//               differs. Labels (risk_on, ...) are strings, so a changed label
//               is structural.
//   discrete    a number moved by more than rounding could move it: a sign
//               change (including to or from zero), a change between two
//               integers, or |a - b| > DISCRETE_TOL * max(1, |a|, |b|). A
//               percentile rank stepping by 1/n, a flipped toFixed digit or a
//               diverged backtest all land here.
//   rounding    any other numeric change: the last-bit drift D78 expects.
//
// Every structural and discrete difference is listed with its JSON path.
// No bun:test import: backend scripts load this file too.

export const DISCRETE_TOL = 1e-9;

export interface Difference {
  path: string;
  kind: "structural" | "discrete";
  before: unknown;
  after: unknown;
}

export interface NumericDiff {
  numbers: number;
  changed: number;
  maxAbs: number;
  maxRel: number;
  maxAbsPath: string | null;
  maxRelPath: string | null;
  differences: Difference[];
}

function walk(a: unknown, b: unknown, path: string, out: NumericDiff): void {
  if (typeof a === "number" && typeof b === "number") {
    out.numbers++;
    if (Object.is(a, b)) return;
    out.changed++;
    const abs = Math.abs(a - b);
    const rel = abs / Math.max(Math.abs(a), Math.abs(b));
    if (abs > out.maxAbs) {
      out.maxAbs = abs;
      out.maxAbsPath = path;
    }
    if (rel > out.maxRel) {
      out.maxRel = rel;
      out.maxRelPath = path;
    }
    const signFlip = Math.sign(a) !== Math.sign(b);
    const integers = Number.isInteger(a) && Number.isInteger(b);
    if (signFlip || integers || abs > DISCRETE_TOL * Math.max(1, Math.abs(a), Math.abs(b))) {
      out.differences.push({ path, kind: "discrete", before: a, after: b });
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.differences.push({ path: `${path}.length`, kind: "structural", before: a.length, after: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join("\u0000") !== kb.join("\u0000")) out.differences.push({ path: `${path}{keys}`, kind: "structural", before: ka, after: kb });
    for (const k of ka) if (Object.hasOwn(b, k)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    return;
  }
  if (a !== b) out.differences.push({ path, kind: "structural", before: a, after: b });
}

/** Compare two JSON texts value by value. `before` is the earlier report. */
export function numericDiff(before: string, after: string): NumericDiff {
  const out: NumericDiff = { numbers: 0, changed: 0, maxAbs: 0, maxRel: 0, maxAbsPath: null, maxRelPath: null, differences: [] };
  walk(JSON.parse(before), JSON.parse(after), "$", out);
  return out;
}

/**
 * The D78 replay check: same structure, keys, order, labels, nulls and
 * integers, and no number moved by more than rounding. Throws, listing the
 * first differences by JSON path, when that does not hold.
 */
export function expectSameUpToRounding(after: string, before: string, label: string): NumericDiff {
  const d = numericDiff(before, after);
  if (d.differences.length > 0) {
    const shown = d.differences.slice(0, 20).map((x) => `  ${x.kind} ${x.path}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`);
    throw new Error(`${label}: ${d.differences.length} difference(s) beyond rounding\n${shown.join("\n")}`);
  }
  return d;
}
