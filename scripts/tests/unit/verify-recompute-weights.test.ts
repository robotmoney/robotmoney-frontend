// The reference recomputation must agree with the real derivation, always.
//
// WHY THIS FILE IS THE WHOLE POINT OF HAVING TWO IMPLEMENTATIONS.
// scripts/lib/verify/recompute-weights.ts deliberately does NOT import
// `meanTakeWeights()` — a check that calls the function it is checking cannot
// catch a bug in that function, and D42's claim is specifically that a THIRD
// PARTY can recompute the vector from the published take set. Independence buys
// that property and costs drift risk; this file is what pays the cost.
//
// So: every fixture below is fed to BOTH implementations and their outputs must
// be identical. A deliberate change to the derivation turns this red and has to
// be made in both places on purpose. An accidental divergence cannot pass
// quietly, which is the only way two implementations are better than one.
//
// The fixtures are chosen to exercise the parts of the rule that are easy to
// get subtly wrong rather than to be exhaustive: whole-take rejection, the
// survivor-count divisor, bucket ordering, and the last-bucket remainder.
import { describe, expect, test } from "bun:test";
import { normalizeTakeWeights, recomputeMeanTakeWeights, diffWeightVectors } from "../../lib/verify/recompute-weights.ts";

// DYNAMIC import, behind a dummy DATABASE_URL. domain.ts pulls in config.ts,
// which does `required("DATABASE_URL")` at module load — the very coupling that
// makes importing the derivation into a production verifier a bad idea, and the
// reason recompute-weights.ts stands alone. The two functions used here are
// pure and never open a connection, so a syntactically valid URL that is never
// dialled is enough, and this test stays in the fast unit lane (no docker)
// rather than moving to backend/tests for an env var.
process.env.DATABASE_URL ??= "postgres://verify:verify@127.0.0.1:1/verify";
const { meanTakeWeights, normalizedTakeWeights } = await import("../../../backend/src/swarm/domain.ts");

type Take = { payload: { weights?: unknown } };
const take = (weights: unknown): Take => ({ payload: { weights } });

const FIXTURES: { name: string; takes: Take[] }[] = [
  {
    name: "two takes, already normalized",
    takes: [
      take([{ bucket: "a", weight: 0.5 }, { bucket: "b", weight: 0.5 }]),
      take([{ bucket: "a", weight: 0.25 }, { bucket: "b", weight: 0.75 }]),
    ],
  },
  {
    name: "unnormalized inputs are scaled per take before averaging",
    takes: [
      take([{ bucket: "a", weight: 10 }, { bucket: "b", weight: 30 }]),
      take([{ bucket: "a", weight: 1 }, { bucket: "b", weight: 1 }]),
    ],
  },
  {
    name: "three buckets that do not divide evenly — exercises the last-bucket remainder",
    takes: [
      take([{ bucket: "a", weight: 1 }, { bucket: "b", weight: 1 }, { bucket: "c", weight: 1 }]),
      take([{ bucket: "a", weight: 2 }, { bucket: "b", weight: 1 }, { bucket: "c", weight: 1 }]),
    ],
  },
  {
    name: "bucket order is by localeCompare, not insertion order",
    takes: [
      take([{ bucket: "zeta", weight: 0.5 }, { bucket: "alpha", weight: 0.5 }]),
      take([{ bucket: "alpha", weight: 0.9 }, { bucket: "zeta", weight: 0.1 }]),
    ],
  },
  {
    name: "a malformed take is dropped WHOLE and does not change the divisor",
    takes: [
      take([{ bucket: "a", weight: 0.5 }, { bucket: "b", weight: 0.5 }]),
      take([{ bucket: "a", weight: -1 }, { bucket: "b", weight: 2 }]), // negative -> whole take out
      take([{ bucket: "a", weight: 0.25 }, { bucket: "b", weight: 0.75 }]),
    ],
  },
  {
    name: "duplicate bucket in one take drops that take",
    takes: [
      take([{ bucket: "a", weight: 0.5 }, { bucket: "a", weight: 0.5 }]),
      take([{ bucket: "a", weight: 0.3 }, { bucket: "b", weight: 0.7 }]),
    ],
  },
  {
    name: "takes carrying no weights at all yield undefined",
    takes: [take(undefined), take([]), take(null)],
  },
  {
    name: "a take with a non-finite weight is rejected whole",
    takes: [
      take([{ bucket: "a", weight: Number.POSITIVE_INFINITY }, { bucket: "b", weight: 1 }]),
      take([{ bucket: "a", weight: 0.4 }, { bucket: "b", weight: 0.6 }]),
    ],
  },
  {
    name: "a take whose weights sum to zero is rejected",
    takes: [
      take([{ bucket: "a", weight: 0 }, { bucket: "b", weight: 0 }]),
      take([{ bucket: "a", weight: 0.4 }, { bucket: "b", weight: 0.6 }]),
    ],
  },
  {
    name: "many buckets, uneven — the renormalize+remainder path under pressure",
    takes: [
      take([{ bucket: "a", weight: 3 }, { bucket: "b", weight: 5 }, { bucket: "c", weight: 7 }, { bucket: "d", weight: 11 }]),
      take([{ bucket: "a", weight: 1 }, { bucket: "b", weight: 1 }, { bucket: "c", weight: 1 }, { bucket: "d", weight: 1 }]),
      take([{ bucket: "a", weight: 13 }, { bucket: "b", weight: 2 }, { bucket: "c", weight: 2 }, { bucket: "d", weight: 2 }]),
    ],
  },
];

describe("the reference recomputation agrees with the real derivation", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const real = meanTakeWeights(fixture.takes as never[]);
      const reference = recomputeMeanTakeWeights(fixture.takes);
      expect(reference).toEqual(real as typeof reference);
    });
  }

  test("every fixture's vector sums to exactly 1 (or is undefined)", () => {
    for (const fixture of FIXTURES) {
      const v = recomputeMeanTakeWeights(fixture.takes);
      if (v === undefined) continue;
      const sum = v.reduce((s, e) => s + e.weight, 0);
      expect({ fixture: fixture.name, sum }).toEqual({ fixture: fixture.name, sum: 1 });
    }
  });
});

describe("the normalizer agrees entry-for-entry", () => {
  const CASES: unknown[] = [
    [{ bucket: "a", weight: 1 }, { bucket: "b", weight: 3 }],
    [{ bucket: "a", weight: 0 }, { bucket: "b", weight: 1 }],
    [{ bucket: " ", weight: 1 }],
    [{ bucket: "a", weight: "1" }],
    [{ bucket: "a" }],
    "not an array",
    [],
    null,
    [[{ bucket: "a", weight: 1 }]],
  ];
  for (const [i, value] of CASES.entries()) {
    test(`case ${i}: ${JSON.stringify(value)?.slice(0, 48) ?? String(value)}`, () => {
      expect(normalizeTakeWeights(value)).toEqual(normalizedTakeWeights(value));
    });
  }
});

describe("diffWeightVectors reports a real divergence and stays quiet on agreement", () => {
  const base = [{ bucket: "a", weight: 0.4 }, { bucket: "b", weight: 0.6 }];

  test("identical vectors produce no problems", () => {
    expect(diffWeightVectors(base, base)).toEqual([]);
  });

  test("a tampered weight is named with both values", () => {
    const tampered = [{ bucket: "a", weight: 0.41 }, { bucket: "b", weight: 0.59 }];
    const problems = diffWeightVectors(tampered, base);
    expect(problems.length).toBe(2);
    expect(problems[0]).toContain("a: published 0.41");
  });

  test("a differing bucket SET is reported once, not as per-bucket noise", () => {
    const problems = diffWeightVectors([{ bucket: "a", weight: 1 }], base);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("bucket set/order differs");
  });

  test("reordered buckets are a divergence, because the derivation fixes the order", () => {
    const reordered = [{ bucket: "b", weight: 0.6 }, { bucket: "a", weight: 0.4 }];
    expect(diffWeightVectors(reordered, base)[0]).toContain("bucket set/order differs");
  });

  test("a divergence in the 9th decimal is BELOW the 8dp the derivation rounds to", () => {
    const hair = [{ bucket: "a", weight: 0.4000000001 }, { bucket: "b", weight: 0.6 }];
    expect(diffWeightVectors(hair, base)).toEqual([]);
  });

  test("a divergence AT 8dp is caught", () => {
    const eightDp = [{ bucket: "a", weight: 0.40000001 }, { bucket: "b", weight: 0.6 }];
    expect(diffWeightVectors(eightDp, base).length).toBe(1);
  });
});
