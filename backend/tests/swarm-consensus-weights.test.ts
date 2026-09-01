// meanTakeWeights is LOAD-BEARING (issue #752, 2.3).
//
// Project Fusion's rule is that math decides and the judge explains. That rule
// is only worth anything if the math is (a) correct and (b) the ONLY math: a
// second averaging routine somewhere else, or a model quietly authoring a
// number, and the reproducibility property the receipt rests on is gone.
//
// This file therefore does two different jobs. The first half is properties —
// exercised over generated inputs, not three hand-picked ones, because the
// claim being made ("always sums to exactly 1") is universal. The second half
// is the no-bypass/no-reimplementation guard, which reads the shipped source.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildRationale, buildSynthesis, meanTakeWeights, normalizedTakeWeights } from "../src/swarm/domain.ts";
import { findWeightLikeKey, WEIGHT_LIKE_KEYS } from "../src/swarm/judge.ts";

const take = (weights: { bucket: string; weight: number }[] | undefined) => ({ payload: weights ? { weights } : {} });
// Summed as SCALED INTEGERS, not floats. Every published weight is an 8-decimal
// value (domain.ts's round(v, 8)), so "the vector sums to exactly 1" is a claim
// about those decimals — 0.1 + 0.2 + 0.7 is 1.0000000000000002 in binary
// floating point no matter how correct the aggregator is, and asserting on that
// would be testing IEEE-754 rather than meanTakeWeights.
const SCALE = 1e8;
const scaledSum = (v: { bucket: string; weight: number }[]) =>
  v.reduce((t, e) => t + Math.round(e.weight * SCALE), 0);

// Deterministic PRNG so a failure is reproducible from the printed seed rather
// than "it went red once in CI".
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const BUCKETS = ["conservative_defi_yield", "agent_tokens", "protocol", "rwa"];

// ── Properties ──────────────────────────────────────────────────────────────

test("property: any set of member vectors averages to a vector summing to EXACTLY 1", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = rng(seed);
    const memberCount = 1 + Math.floor(next() * 7);
    const takes = [];
    for (let m = 0; m < memberCount; m++) {
      // A member may weight any non-empty subset of the buckets, on any scale —
      // normalization is the aggregator's job, not the member's.
      const bucketCount = 1 + Math.floor(next() * BUCKETS.length);
      const scale = 10 ** Math.floor(next() * 6 - 2);
      const weights = BUCKETS.slice(0, bucketCount).map((bucket) => ({ bucket, weight: next() * scale }));
      takes.push(take(weights));
    }
    const result = meanTakeWeights(takes);
    expect(result, `seed ${seed}`).toBeDefined();
    // EXACTLY 1, not "within epsilon". meanTakeWeights closes the vector by
    // assigning the final bucket 1 - (sum of the rest), so the published vector
    // never sums to 0.99999999.
    expect(scaledSum(result!), `seed ${seed}`).toBe(SCALE);
    // …and every component really is an 8-decimal value, which is what makes
    // the scaled sum above the right question to ask.
    for (const entry of result!) expect(Math.round(entry.weight * SCALE) / SCALE, `seed ${seed}`).toBe(entry.weight);
    for (const entry of result!) expect(entry.weight, `seed ${seed} bucket ${entry.bucket}`).toBeGreaterThanOrEqual(0);
  }
});

test("property: a single member's vector is that member's vector, normalized", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = rng(seed * 7919);
    const raw = BUCKETS.map((bucket) => ({ bucket, weight: next() * 100 }));
    const total = raw.reduce((t, e) => t + e.weight, 0);
    const result = meanTakeWeights([take(raw)])!;
    expect(scaledSum(result)).toBe(SCALE);
    for (const entry of result) {
      const original = raw.find((r) => r.bucket === entry.bucket)!;
      expect(Math.abs(entry.weight - original.weight / total), `seed ${seed}`).toBeLessThan(1e-7);
    }
  }
});

test("near-ties and long tails still close to exactly 1", () => {
  // Three members a hair apart across four buckets: the case where naive
  // rounding leaves a 1e-8 hole in the published vector.
  const nudge = [0, 1e-9, -1e-9];
  const takes = nudge.map((d) => take(BUCKETS.map((bucket) => ({ bucket, weight: 0.25 + d }))));
  const result = meanTakeWeights(takes)!;
  expect(scaledSum(result)).toBe(SCALE);
  expect(result.length).toBe(BUCKETS.length);

  // A dust bucket that rounds to zero must not open a hole either.
  const dust = meanTakeWeights([take([{ bucket: "a", weight: 1 }, { bucket: "b", weight: 1e-12 }])])!;
  expect(scaledSum(dust)).toBe(SCALE);
});

test("takes that carry no usable weights contribute nothing, and an all-empty set yields no vector", () => {
  expect(meanTakeWeights([])).toBeUndefined();
  expect(meanTakeWeights([take(undefined), take([])])).toBeUndefined();
  // A negative weight, a duplicate bucket, a non-finite weight, or a zero total
  // invalidates that member's whole vector — it is never partially salvaged.
  expect(normalizedTakeWeights([{ bucket: "a", weight: -1 }])).toBeNull();
  expect(normalizedTakeWeights([{ bucket: "a", weight: 1 }, { bucket: "a", weight: 1 }])).toBeNull();
  expect(normalizedTakeWeights([{ bucket: "a", weight: Number.POSITIVE_INFINITY }])).toBeNull();
  expect(normalizedTakeWeights([{ bucket: "a", weight: 0 }])).toBeNull();
  // …and one bad member does not poison a good one.
  const mixed = meanTakeWeights([take([{ bucket: "a", weight: -1 }]), take([{ bucket: "a", weight: 3 }])])!;
  expect(mixed).toEqual([{ bucket: "a", weight: 1 }]);
});

test("order of members never changes the vector", () => {
  const a = take([{ bucket: "x", weight: 3 }, { bucket: "y", weight: 1 }]);
  const b = take([{ bucket: "x", weight: 1 }, { bucket: "y", weight: 1 }]);
  const c = take([{ bucket: "y", weight: 5 }]);
  expect(JSON.stringify(meanTakeWeights([a, b, c]))).toBe(JSON.stringify(meanTakeWeights([c, b, a])));
});

// ── The no-bypass guard ─────────────────────────────────────────────────────
// Grep-based on purpose: what is being defended is a NEGATIVE ("nothing else
// computes a weight"), and a negative over a whole source tree cannot be
// asserted by executing one code path. A future edit that adds a second
// averaging routine, or lets the judge write `weights`, fails here.

const SRC = join(process.cwd(), "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Comments legitimately discuss weights at length (this whole phase is about
// them); only CODE is scanned. The `[^:]` guard keeps `https://` from reading
// as a line comment.
function codeOnly(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("meanTakeWeights is defined exactly once in the backend source", () => {
  const definitions = tsFiles(SRC).filter((f) => /function\s+meanTakeWeights\s*\(/.test(codeOnly(f)));
  expect(definitions.map((f) => f.replace(`${SRC}/`, ""))).toEqual(["swarm/domain.ts"]);
});

test("meanTakeWeights has exactly two callers: its own aggregator, and the read-only replay audit", () => {
  // ONE WRITER, ONE AUDITOR (issue #766). `domain.ts` is the aggregator that
  // AUTHORS the vector. `swarm/judge-replay.ts` is an offline, read-only audit
  // that recomputes one purely to compare it against what a published session
  // stored — the reproducibility property D4 puts the signed number on, which
  // nothing asserted against real history before. Recomputing to CHECK is the
  // opposite of the danger this guard exists for; recomputing to WRITE is the
  // danger, and the next two tests are what hold that line.
  //
  // The allowlist is exactly two entries and stays that way. A third caller is
  // a review conversation, not a test edit.
  const callers = tsFiles(SRC).filter((f) => /\bmeanTakeWeights\s*\(/.test(codeOnly(f)));
  expect(callers.map((f) => f.replace(`${SRC}/`, "")).sort())
    .toEqual(["swarm/domain.ts", "swarm/judge-replay.ts"]);
});

test("the replay audit is READ ONLY — it may recompute a vector, it may not write one anywhere", () => {
  // What makes the allowlist entry above safe is not the file's name; it is
  // that the file cannot write. Asserted, not asserted-in-a-comment: no DML at
  // all, and no `weights` authored, in the one module permitted to reach the
  // derivation from outside domain.ts. D42 turns on the same property — the
  // tie-break report identifies affected published sessions and must never
  // repair one.
  const src = codeOnly(join(SRC, "swarm/judge-replay.ts"));
  for (const dml of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
    expect(dml.test(src), `swarm/judge-replay.ts must not write: ${dml}`).toBe(false);
  }
  expect(/\bweights\s*[:=][^=]/.test(src), "swarm/judge-replay.ts must not author a weights field").toBe(false);
});

test("swarm_recommendation is written from exactly two files, and only one of them may touch weights", () => {
  // The recommendation object is where a weight vector would have to land to
  // reach a receipt. Pinning the set of files that WRITE it keeps that a
  // reviewable list of two rather than an open question about the tree.
  const writers = tsFiles(SRC)
    .filter((f) => /UPDATE\s+swarm_sessions[\s\S]{0,400}?swarm_recommendation\s*=/.test(codeOnly(f)))
    .map((f) => f.replace(`${SRC}/`, ""))
    .sort();
  expect(writers).toEqual(["swarm/domain.ts", "swarm/judge-session.ts"]);
});

test("the judge modules never reach the derivation and never ASSIGN a weights field", () => {
  // DELIBERATELY NOT WIDENED FOR #766. The replay audit that does read the
  // derivation was moved OUT of judge-session.ts into its own module precisely
  // so this list — the production judging path, the one that writes — could
  // stay exactly as strict as it was.
  for (const rel of ["swarm/judge.ts", "swarm/judge-session.ts"]) {
    const src = codeOnly(join(SRC, rel));
    expect(src.includes("meanTakeWeights"), `${rel} must not reach the derivation`).toBe(false);
    // `weights:` in an object literal or `weights =` as an assignment. READING
    // one (`rec.weights ?? null`) is fine and necessary — the replay path
    // compares vectors; AUTHORING one is what is forbidden.
    expect(/\bweights\s*[:=][^=]/.test(src), `${rel} must not author a weights field`).toBe(false);
  }
});

// ── The template producers are order-independent ────────────────────────────
// Promoting the derivation to load-bearing means the prose that describes it
// has to be reproducible too: the judge's fallback re-derives it from a stored
// `swarm_recommendation.stances`, and postgres does not preserve jsonb key
// order. A rationale that depended on key order would make "the fallback is
// exactly today's prose" false on any tie.

test("buildRationale and buildSynthesis do not depend on the key order of the stance counts", () => {
  const forward = { neutral: 1, bullish: 1, cautious: 1 };
  const reversed = { cautious: 1, bullish: 1, neutral: 1 };
  expect(buildRationale("Subj", reversed, 3, 0.5, null)).toBe(buildRationale("Subj", forward, 3, 0.5, null));
  expect(buildSynthesis("Subj", 3, 3, 1, reversed)).toBe(buildSynthesis("Subj", 3, 3, 1, forward));
  // The ladder decides a tie, so the named majority is the LOWEST-ranked stance
  // in play — the same one stanceBreakdown lists first.
  expect(buildRationale("Subj", forward, 3, null, null)).toContain("Majority stance is cautious");
});

// ── The rejection itself ────────────────────────────────────────────────────

test("findWeightLikeKey catches a weight at any depth, under any casing or separator", () => {
  expect(findWeightLikeKey({ rationale: "fine", disagreements: [] })).toBeNull();
  expect(findWeightLikeKey({ weights: [] })).toBe("weights");
  expect(findWeightLikeKey({ release_safety: { concerns: [{ Allocation: 0.5 }] } }))
    .toBe("release_safety.concerns.0.Allocation");
  expect(findWeightLikeKey({ a: [{ b: { "target weights": 1 } }] })).toBe("a.0.b.target weights");
  expect(findWeightLikeKey({ a: { "bucket-weights": 1 } })).toBe("a.bucket-weights");
  // A weight-like WORD inside prose is not a weight-like FIELD.
  expect(findWeightLikeKey({ rationale: "the weights are unchanged" })).toBeNull();
  for (const key of WEIGHT_LIKE_KEYS) expect(findWeightLikeKey({ [key]: 1 })).toBe(key);
});
