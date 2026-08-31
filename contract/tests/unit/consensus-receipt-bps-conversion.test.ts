// bps_conversion, the one rule that turns a committee's float allocation into
// the integer basis points the canonical bytes carry (issue #798).
//
// WHY THIS FILE IS SEPARATE FROM consensus-receipt-fixture.test.ts. That file
// pins the BYTES; this one pins the ARITHMETIC that decides what those bytes
// say. The receipt's weights are the vector a RouterGovernance.propose call is
// built from, so a rounding rule that refuses a session, or that quietly moves
// a basis point from one vault to another between two implementations, is a
// correctness defect in a signed and anchored artifact rather than a test
// detail.
//
// WHAT CHANGED, AND WHAT THIS FILE HAS TO PROVE. The rule used to round the
// first three canonical buckets to the nearest bp and settle the positionally
// LAST bucket (`real_world_assets`) to 10000 minus the prefix sum, refusing
// when that landed outside 0..10000. robotmoney-core#1290 measured that
// refusing about ONE VECTOR IN EIGHT whose last bucket is exactly zero — and a
// zero `real_world_assets` is four of the six real archived allocations. The
// replacement is LARGEST REMAINDER (Hare quota) with an explicitly stated
// tie-break. Three things therefore have to hold at once, and each has a test
// below:
//   1. the corpus that used to be refused now converts, with ZERO refusals;
//   2. the six real archived allocations convert to exactly the bps arrays the
//      OLD rule produced for them — the change must not move settled data;
//   3. the tie-break is deterministic and stated, because two buckets can hold
//      the identical remainder and which one takes the leftover bp changes the
//      canonical bytes and so the anchored digest.
//
// ZERO DEPENDENCIES, like the rest of contract/: the PRNG below is four lines
// rather than a property-testing library.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BPS_DENOMINATOR,
  RECEIPT_CANONICAL_BUCKET_ORDER,
  bucketSharesToBps,
} from "../../src/consensus-receipt.js";

const FIXTURES = join(import.meta.dir, "../../src/__fixtures__");
const spec = JSON.parse(
  readFileSync(join(FIXTURES, "consensus-receipt.canonicalization.json"), "utf8"),
);
const ORDER = RECEIPT_CANONICAL_BUCKET_ORDER as readonly string[];

type Bps = { bucket: string; weight_bps: number };

/**
 * THE SUPERSEDED RULE, kept executable on purpose. Every "the new rule does
 * not move settled data" and "the corpus really was refused" claim below is
 * measured against this rather than against a remembered number.
 */
function settleTheLastBps(shares: Map<string, number>, order: readonly string[]): Bps[] {
  const out: Bps[] = [];
  let prefix = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const bucket = order[i]!;
    const weight_bps = Math.floor(shares.get(bucket)! * 10_000 + 0.5);
    prefix += weight_bps;
    out.push({ bucket, weight_bps });
  }
  return [...out, { bucket: order[order.length - 1]!, weight_bps: 10_000 - prefix }];
}

/** The old rule's own acceptance test: the settled last entry must be in range. */
function settleTheLastRefuses(shares: Map<string, number>, order: readonly string[]): boolean {
  const final = settleTheLastBps(shares, order).at(-1)!.weight_bps;
  return final < 0 || final > 10_000;
}

/** mulberry32 — a seeded PRNG, so "50000 random vectors" is the same 50000 every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A share vector over `ORDER`, normalized to sum 1, with `zeroed` forced to 0. */
function randomShares(rand: () => number, zeroed: readonly string[]): Map<string, number> {
  for (;;) {
    const draws = ORDER.map((bucket) => (zeroed.includes(bucket) ? 0 : rand()));
    const total = draws.reduce((sum, value) => sum + value, 0);
    if (total <= 0) continue; // degenerate: no allocation at all, not a share vector
    return new Map(ORDER.map((bucket, i) => [bucket, draws[i]! / total]));
  }
}

function sumBps(vector: Bps[]): number {
  return vector.reduce((sum, entry) => sum + entry.weight_bps, 0);
}

// ── THE PRODUCER'S OWN ARITHMETIC ────────────────────────────────────────────
// MIRRORS backend/src/swarm/domain.ts:1733-1751 — normalizedTakeWeights() and
// meanTakeWeights(), the only thing in the system allowed to author a bucket
// weight. REPLICATED RATHER THAN IMPORTED on purpose: contract/ is a
// zero-dependency package that backend/ depends on, and importing backend/ from
// a contract test would invert that edge. It is copied line for line; if
// domain.ts changes, this copy is what tells us the conversion has to be
// re-checked against the new shape.
//
// WHY IT IS HERE AT ALL. randomShares() below builds a zeroed bucket as EXACTLY
// 0 — an input the producer never emits. meanTakeWeights() rounds every averaged
// entry to 8 decimal places and then OVERWRITES the positionally last one with
// round(1 - prefixTotal, 8); localeCompare order over the four canonical buckets
// equals canonical_bucket_order, so that last entry IS real_world_assets, and
// when every member zeroes it the three prefix roundings can sum just above 1
// and the settled entry lands on EXACTLY -1e-8. A corpus drawn from
// randomShares() is structurally blind to that value. This one is not.
const round8 = (value: number): number => Math.round(value * 1e8) / 1e8;

/** domain.ts normalizedTakeWeights(): each analyst vector normalized to sum 1. */
function normalizedTakeWeights(
  entries: { bucket: string; weight: number }[],
): { bucket: string; weight: number }[] | null {
  let total = 0;
  for (const { weight } of entries) total += weight;
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return entries.map(({ bucket, weight }) => ({ bucket, weight: weight / total }));
}

/** domain.ts meanTakeWeights(): mean, re-normalize, round to 8dp, settle the last. */
function meanTakeWeights(
  vectors: { bucket: string; weight: number }[][],
): { bucket: string; weight: number }[] | undefined {
  const normalized = vectors
    .map(normalizedTakeWeights)
    .filter((weights): weights is { bucket: string; weight: number }[] => weights !== null);
  if (normalized.length === 0) return undefined;
  const totals = new Map<string, number>();
  for (const weights of normalized) {
    for (const { bucket, weight } of weights) totals.set(bucket, (totals.get(bucket) ?? 0) + weight);
  }
  const averaged = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, total]) => ({ bucket, weight: total / normalized.length }));
  const averageTotal = averaged.reduce((sum, entry) => sum + entry.weight, 0);
  const result = averaged.map(({ bucket, weight }) => ({
    bucket,
    weight: round8(weight / averageTotal),
  }));
  const finalIndex = result.length - 1;
  const prefixTotal = result.slice(0, finalIndex).reduce((sum, entry) => sum + entry.weight, 0);
  result[finalIndex]!.weight = round8(1 - prefixTotal);
  return result;
}

/** One session's worth of member vectors, `zeroed` buckets set to 0 by every member. */
function producerShares(rand: () => number, zeroed: readonly string[]): Map<string, number> {
  const members = 2 + Math.floor(rand() * 6);
  const vectors: { bucket: string; weight: number }[][] = [];
  while (vectors.length < members) {
    const draws = ORDER.map((bucket) => (zeroed.includes(bucket) ? 0 : rand()));
    if (draws.reduce((sum, value) => sum + value, 0) <= 0) continue;
    vectors.push(ORDER.map((bucket, i) => ({ bucket, weight: draws[i]! })));
  }
  const mean = meanTakeWeights(vectors)!;
  return new Map(mean.map(({ bucket, weight }) => [bucket, weight]));
}

/** The clamp bound, which is SHARE_SUM_TOLERANCE in consensus-receipt.js. */
const SHARE_SUM_TOLERANCE = 1e-6;

describe("consensus receipt bps_conversion — largest remainder (issue #798)", () => {
  // ── the published rule and the implementation are one rule ────────────────

  test("the spec file states largest remainder AND names the tie-break", () => {
    // The tie-break is the part a reader would otherwise have to infer from
    // JavaScript sort stability, so it is asserted as published PROSE, not only
    // as behaviour: an implementer in another language reads this file.
    expect(spec.bps_conversion.rule).toBe("LARGEST REMAINDER (Hare quota)");
    expect(spec.bps_conversion.denominator).toBe(BPS_DENOMINATOR);
    expect(BPS_DENOMINATOR).toBe(10_000);
    expect(spec.bps_conversion.floor_rule).toContain("floor, never nearest");
    expect(spec.bps_conversion.remainder_rule).toContain("ONE BASIS POINT AT A TIME");
    expect(spec.bps_conversion.tie_break).toContain("CANONICAL BUCKET ORDER");
    expect(spec.bps_conversion.tie_break).toContain("EARLIER in canonical_bucket_order");
    expect(spec.bps_conversion.tie_break).toContain("must not rely on its sort being stable");
    // The refusal that is gone, and the one that is left.
    expect(spec.bps_conversion.refusal).toContain("NEVER refuses because of where a bucket sits");
    expect(spec.bps_conversion.superseded_rule).toContain("ONE TIME IN EIGHT");
    expect(spec.bps_conversion.rejected_alternative).toContain("only moves the failure");
    expect(spec.bps_conversion.reference).toContain("bucketSharesToBps()");
    // The old prose is GONE, not merely appended to: a reader must not be able
    // to implement settle-the-last from this file and still call it 1.0.
    expect(spec.bps_conversion.prefix_rule).toBeUndefined();
    expect(spec.bps_conversion.final_rule).toBeUndefined();
  });

  // ── (1) the corpus that used to be refused ────────────────────────────────

  test("the zero-RWA corpus that settle-the-last refused converts with ZERO refusals", () => {
    const rand = mulberry32(0x1290);
    const SAMPLES = 50_000;
    let refusedNow = 0;
    let refusedBefore = 0;
    let movedByTheOldRule = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const shares = randomShares(rand, ["real_world_assets"]);
      if (settleTheLastRefuses(shares, ORDER)) refusedBefore++;
      else if (settleTheLastBps(shares, ORDER).at(-1)!.weight_bps !== 0) movedByTheOldRule++;
      let vector: Bps[] | undefined;
      try {
        vector = bucketSharesToBps(shares, ORDER);
      } catch {
        refusedNow++;
        continue;
      }
      expect(sumBps(vector)).toBe(BPS_DENOMINATOR);
      expect(vector.map((entry) => entry.bucket)).toEqual([...ORDER]);
      for (const entry of vector) {
        expect(Number.isSafeInteger(entry.weight_bps)).toBe(true);
        expect(entry.weight_bps).toBeGreaterThanOrEqual(0);
        expect(entry.weight_bps).toBeLessThanOrEqual(BPS_DENOMINATOR);
      }
      // A bucket the committee set to ZERO stays zero. The old rule could not
      // promise this either: when the three prefix buckets UNDERSHOT it handed
      // the settled last bucket a stray +1 bp of a vault the session had
      // allocated nothing to — the same defect as the refusal, one sign over.
      expect(vector.at(-1)!.weight_bps).toBe(0);
    }
    expect(refusedNow).toBe(0);
    // LOUD, NOT SILENT: the corpus really is the one that used to fail. If this
    // ever reads 0 the test above has stopped proving anything.
    expect(refusedBefore).toBeGreaterThan(SAMPLES * 0.05);
    expect(movedByTheOldRule).toBeGreaterThan(0);
  });

  test("every non-degenerate share vector converts and sums to exactly BPS_DENOMINATOR", () => {
    // Each bucket takes a turn at being the zero one, and one sweep has none —
    // the property must not depend on WHERE the zero sits.
    const rand = mulberry32(0x798);
    const shapes: readonly string[][] = [[], ...ORDER.map((bucket) => [bucket])];
    let converted = 0;
    for (const zeroed of shapes) {
      for (let i = 0; i < 10_000; i++) {
        const shares = randomShares(rand, zeroed);
        const vector = bucketSharesToBps(shares, ORDER);
        expect(sumBps(vector)).toBe(BPS_DENOMINATOR);
        for (const bucket of zeroed) {
          expect(vector.find((entry) => entry.bucket === bucket)!.weight_bps).toBe(0);
        }
        converted++;
      }
    }
    expect(converted).toBe(shapes.length * 10_000);
  });

  // ── (2) the settled data does not move ────────────────────────────────────

  test("the six real archived allocations convert to the bps arrays the OLD rule produced", () => {
    // THE CORPUS IS THE REPOSITORY'S OWN ARCHIVE, read from disk rather than
    // transcribed: these are the six sessions robotmoney-core's
    // consensus-receipt.legacy-weights.json pins, and the expected arrays are
    // that file's `canonical_weights`. Four of the six have
    // real_world_assets == 0 — the shape the old rule refused one time in eight
    // — and they convert only because their means are whole bps.
    const SESSIONS = join(import.meta.dir, "../../../frontend/public/data/swarm/sessions");
    const archived: { date: string; expected: number[] }[] = [
      { date: "2026-06-05", expected: [500, 9500, 0, 0] },
      { date: "2026-06-09", expected: [400, 9600, 0, 0] },
      { date: "2026-06-13", expected: [500, 9500, 0, 0] },
      { date: "2026-06-17", expected: [300, 9500, 0, 200] },
      { date: "2026-06-21", expected: [500, 9500, 0, 0] },
      { date: "2026-06-24", expected: [300, 9500, 0, 200] },
    ];
    expect(archived).toHaveLength(6);
    let zeroRwa = 0;
    for (const { date, expected } of archived) {
      const session = JSON.parse(
        readFileSync(join(SESSIONS, `${date}-robotmoney-allocation.json`), "utf8"),
      );
      // The archived payloads serialize `weights` as a MAP whose key order is
      // NOT canonical_bucket_order — reading it by ORDER is the conversion the
      // assembler performs, and is why the receipt's array shape exists.
      const legacy = session.committee_recommendation.weights;
      expect(Object.keys(legacy).sort()).toEqual([...ORDER].sort());
      const shares = new Map(ORDER.map((bucket) => [bucket, legacy[bucket]]));
      if (legacy.real_world_assets === 0) zeroRwa++;

      const now = bucketSharesToBps(shares, ORDER);
      expect(now.map((entry) => entry.bucket)).toEqual([...ORDER]);
      expect(now.map((entry) => entry.weight_bps)).toEqual(expected);
      // And the same array the superseded rule produced, recomputed here rather
      // than asserted from memory. THIS is the backward-compatibility claim.
      expect(now).toEqual(settleTheLastBps(shares, ORDER));
      expect(sumBps(now)).toBe(BPS_DENOMINATOR);
    }
    expect(zeroRwa).toBe(4);
  });

  // ── (3) the tie-break ─────────────────────────────────────────────────────

  test("an exact tie is broken by canonical bucket order, the same way every run", () => {
    // A THREE-WAY EXACT TIE. Identical shares are identical doubles, so their
    // fractional parts are equal BITWISE — this is a real tie, not a tie that
    // float noise resolves for us. One leftover bp, three claimants, and
    // canonical order decides: agent_tokens is index 0.
    const thirds = new Map([
      ["agent_tokens", 1 / 3],
      ["conservative_defi_yield", 1 / 3],
      ["protocol_tokens", 1 / 3],
      ["real_world_assets", 0],
    ]);
    expect(bucketSharesToBps(thirds, ORDER).map((e) => e.weight_bps)).toEqual([3334, 3333, 3333, 0]);

    // The SAME tie with the zero moved to the front: the winner moves with the
    // canonical index, so the rule is "earliest bucket", not "first entry" and
    // not "largest bucket".
    const thirdsFromSecond = new Map([
      ["agent_tokens", 0],
      ["conservative_defi_yield", 1 / 3],
      ["protocol_tokens", 1 / 3],
      ["real_world_assets", 1 / 3],
    ]);
    expect(bucketSharesToBps(thirdsFromSecond, ORDER).map((e) => e.weight_bps))
      .toEqual([0, 3334, 3333, 3333]);

    // A TWO-WAY EXACT TIE with exactly one bp to hand out, so precisely one of
    // the two tied buckets can win and the tie-break is load-bearing.
    const tiedEarly = new Map([
      ["agent_tokens", 0.100045],
      ["conservative_defi_yield", 0.100045],
      ["protocol_tokens", 0.5],
      ["real_world_assets", 0.29991],
    ]);
    expect(bucketSharesToBps(tiedEarly, ORDER).map((e) => e.weight_bps))
      .toEqual([1001, 1000, 5000, 2999]);
    // Mirrored: the tied pair now sits at indices 2 and 3, and index 2 wins.
    const tiedLate = new Map([
      ["agent_tokens", 0.5],
      ["conservative_defi_yield", 0.29991],
      ["protocol_tokens", 0.100045],
      ["real_world_assets", 0.100045],
    ]);
    expect(bucketSharesToBps(tiedLate, ORDER).map((e) => e.weight_bps))
      .toEqual([5000, 2999, 1001, 1000]);

    // DETERMINISM, stated as a property rather than as one lucky run: the same
    // vector converts identically however the Map was built and however many
    // times it is converted.
    for (const tie of [thirds, thirdsFromSecond, tiedEarly, tiedLate]) {
      const first = JSON.stringify(bucketSharesToBps(tie, ORDER));
      for (let run = 0; run < 100; run++) {
        expect(JSON.stringify(bucketSharesToBps(tie, ORDER))).toBe(first);
        // Insertion order is not the rule either.
        const shuffled = new Map([...tie].reverse());
        expect(JSON.stringify(bucketSharesToBps(shuffled, ORDER))).toBe(first);
      }
      expect(sumBps(JSON.parse(first))).toBe(BPS_DENOMINATOR);
    }
  });

  // ── what is still refused, and it is only ever the input ──────────────────

  test("the only remaining refusals are about the input, never about bucket position", () => {
    const complete = new Map(ORDER.map((bucket) => [bucket, 0.25]));
    expect(sumBps(bucketSharesToBps(complete, ORDER))).toBe(BPS_DENOMINATOR);

    const missing = new Map([...complete].slice(1));
    expect(() => bucketSharesToBps(missing, ORDER)).toThrow(/agent_tokens.*finite share in 0\.\.1/s);

    const notNormalized = new Map(ORDER.map((bucket) => [bucket, 0.3]));
    expect(() => bucketSharesToBps(notNormalized, ORDER)).toThrow(/sum to .*, not 1/);

    const outOfRange = new Map(complete).set("agent_tokens", 1.25);
    expect(() => bucketSharesToBps(outOfRange, ORDER)).toThrow(/finite share in 0\.\.1/);

    const notANumber = new Map(complete).set("protocol_tokens", Number.NaN);
    expect(() => bucketSharesToBps(notANumber, ORDER)).toThrow(/finite share in 0\.\.1/);

    // A whole allocation in the LAST bucket, and a whole allocation in the
    // FIRST: neither is special, and neither is refused.
    for (const bucket of ORDER) {
      const all = new Map(ORDER.map((name) => [name, name === bucket ? 1 : 0]));
      const vector = bucketSharesToBps(all, ORDER);
      expect(sumBps(vector)).toBe(BPS_DENOMINATOR);
      expect(vector.find((entry) => entry.bucket === bucket)!.weight_bps).toBe(BPS_DENOMINATOR);
    }

    // A plain object is accepted as well as a Map — the rule is about the
    // shares, not about the container the caller happens to hold them in.
    expect(bucketSharesToBps(Object.fromEntries(complete), ORDER))
      .toEqual(bucketSharesToBps(complete, ORDER));
  });

  // ── (4) THE CORPUS THE PRODUCER ACTUALLY EMITS ────────────────────────────
  // Every corpus above is built by randomShares(), which sets a zeroed bucket
  // to EXACTLY 0. meanTakeWeights() does not: it settles the positionally last
  // entry to round(1 - prefixTotal, 8), and that entry is real_world_assets.
  // The tests below draw their vectors from the producer's own arithmetic, so
  // the input under test is the one swarm_recommendation.weights holds.

  test("the PRODUCER's zero-RWA corpus converts with ZERO refusals — negative settle dust and all", () => {
    const rand = mulberry32(0x1749);
    const SAMPLES = 50_000;
    let refused = 0;
    let negativeDust = 0;
    let mostNegative = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const shares = producerShares(rand, ["real_world_assets"]);
      const settled = shares.get("real_world_assets")!;
      if (settled < 0) {
        negativeDust++;
        mostNegative = Math.min(mostNegative, settled);
      }
      let vector: Bps[] | undefined;
      try {
        vector = bucketSharesToBps(shares, ORDER);
      } catch {
        refused++;
        continue;
      }
      expect(sumBps(vector)).toBe(BPS_DENOMINATOR);
      expect(vector.map((entry) => entry.bucket)).toEqual([...ORDER]);
      for (const entry of vector) {
        expect(Number.isSafeInteger(entry.weight_bps)).toBe(true);
        expect(entry.weight_bps).toBeGreaterThanOrEqual(0);
        expect(entry.weight_bps).toBeLessThanOrEqual(BPS_DENOMINATOR);
      }
      // The clamp must not become an allocation: -1e-8 of a vault is 0 bps of
      // it, never 1. A committee that allocated nothing to real_world_assets
      // gets a receipt saying so. Object.is, not toBe: the producer also emits
      // NEGATIVE ZERO here (round(1 - prefixTotal, 8) of a tiny overshoot), and
      // -0 must be normalized rather than passed through as an integer -0.
      expect(vector.at(-1)!.weight_bps).toBe(0);
      expect(Object.is(vector.at(-1)!.weight_bps, 0)).toBe(true);
    }
    // THE HEADLINE: 12.39% of this corpus was refused before the clamp.
    expect(refused).toBe(0);
    // LOUD, NOT SILENT — the corpus really is the one that used to fail. Without
    // this the test above would still pass if producerShares() quietly stopped
    // producing dust, and would then be proving nothing at all.
    expect(negativeDust).toBeGreaterThan(SAMPLES * 0.05);
    // And the dust is DUST: two orders of magnitude inside the clamp bound, so
    // absorbing it never needed the bound widened.
    expect(mostNegative).toBeLessThan(0);
    expect(mostNegative).toBeGreaterThanOrEqual(-1e-7);
    expect(mostNegative).toBeGreaterThan(-SHARE_SUM_TOLERANCE);
  });

  test("every producer-shaped session converts, wherever the zero sits and whether or not there is one", () => {
    const rand = mulberry32(0x788);
    const shapes: readonly string[][] = [[], ...ORDER.map((bucket) => [bucket])];
    let converted = 0;
    for (const zeroed of shapes) {
      for (let i = 0; i < 10_000; i++) {
        const shares = producerShares(rand, zeroed);
        const vector = bucketSharesToBps(shares, ORDER);
        expect(sumBps(vector)).toBe(BPS_DENOMINATOR);
        for (const bucket of zeroed) {
          expect(vector.find((entry) => entry.bucket === bucket)!.weight_bps).toBe(0);
        }
        converted++;
      }
    }
    expect(converted).toBe(shapes.length * 10_000);
  });

  test("the exact -1e-8 vector the producer emits, pinned rather than sampled", () => {
    // Lifted verbatim from a producer run: three members, all of them zeroing
    // real_world_assets, whose prefix roundings sum to 1 + 1e-8.
    const dusty = new Map([
      ["agent_tokens", 0.32328275],
      ["conservative_defi_yield", 0.38341626],
      ["protocol_tokens", 0.293301],
      ["real_world_assets", -1e-8],
    ]);
    expect(dusty.get("real_world_assets")).toBeLessThan(0);
    const vector = bucketSharesToBps(dusty, ORDER);
    expect(sumBps(vector)).toBe(BPS_DENOMINATOR);
    expect(vector.map((entry) => entry.weight_bps)).toEqual([3233, 3834, 2933, 0]);
  });

  test("the clamp is bounded by SHARE_SUM_TOLERANCE — below it a negative share is still refused BY NAME", () => {
    const at = (rwa: number): Map<string, number> =>
      new Map([
        ["agent_tokens", 0.3],
        ["conservative_defi_yield", 0.4],
        ["protocol_tokens", 0.3 - rwa],
        ["real_world_assets", rwa],
      ]);
    // The closed end of the range: exactly -SHARE_SUM_TOLERANCE is absorbed.
    expect(bucketSharesToBps(at(-SHARE_SUM_TOLERANCE), ORDER).at(-1)!.weight_bps).toBe(0);
    expect(sumBps(bucketSharesToBps(at(-SHARE_SUM_TOLERANCE), ORDER))).toBe(BPS_DENOMINATOR);
    // NEGATIVE ZERO, which `-0 < 0` does NOT catch, is normalized to +0 — an
    // integer weight_bps of -0 must never leave this function.
    expect(Object.is(-0 < 0, false)).toBe(true); // the trap, stated
    expect(Object.is(bucketSharesToBps(at(-0), ORDER).at(-1)!.weight_bps, 0)).toBe(true);
    expect(Object.is(bucketSharesToBps(at(-1e-8), ORDER).at(-1)!.weight_bps, 0)).toBe(true);
    // One step past it is a REAL negative allocation, and it is refused naming
    // the bucket — not swallowed, and not thrown as an unnamed internal error.
    expect(() => bucketSharesToBps(at(-1e-5), ORDER)).toThrow(
      /real_world_assets.*finite share in 0\.\.1/s,
    );
    expect(() => bucketSharesToBps(at(-0.25), ORDER)).toThrow(
      /real_world_assets.*finite share in 0\.\.1/s,
    );
    // And the clamp never becomes a licence to author: a zero share and a dust
    // share convert to the same vector, so nothing is invented at the boundary.
    expect(bucketSharesToBps(at(0), ORDER)).toEqual(bucketSharesToBps(at(-1e-9), ORDER));
  });

  // ── (5) THE ARITHMETIC DOMAIN ─────────────────────────────────────────────

  test("the spec pins IEEE-754 binary64, the exact remainder form, and the dust clamp", () => {
    // These clauses exist for an implementer in ANOTHER LANGUAGE — core is
    // Python, where decimal.Decimal is the natural instinct for allocation
    // math. They are asserted as published PROSE for the same reason the
    // tie-break is: a reader of this file must not be able to implement the
    // rule in the wrong domain and still call it 1.0.
    const bps = spec.bps_conversion;
    expect(bps.arithmetic_domain).toContain("IEEE-754 BINARY64");
    expect(bps.arithmetic_domain).toContain("FORBIDDEN");
    expect(bps.arithmetic_domain).toContain("decimal.Decimal");
    expect(bps.floor_rule).toContain("SINGLE IEEE-754 BINARY64 MULTIPLY");
    expect(bps.remainder_rule).toContain("remainder = raw - floor(raw)");
    expect(bps.remainder_rule).toContain("EXACT");
    expect(bps.tie_break).toContain("BITWISE-EQUAL BINARY64 REMAINDERS");
    expect(bps.negative_dust_clamp.rule).toContain("FLOORED TO POSITIVE ZERO");
    expect(bps.negative_dust_clamp.rule).toContain("NEGATIVE ZERO IS CLAMPED TOO");
    expect(bps.negative_dust_clamp.rule).toContain("REFUSED BY NAME");
    expect(bps.negative_dust_clamp.why).toContain("round(1 - prefixTotal, 8)");
    expect(bps.refusal).toContain("negative_dust_clamp");
    // The input clause has to describe what meanTakeWeights ACTUALLY computes:
    // a verifier recomputes the mean from the frozen take set, so an unstated
    // step decides the bytes just as much as a stated one.
    expect(bps.input).toContain("localeCompare");
    expect(bps.input).toContain("8 DECIMAL PLACES");
    expect(bps.input).toContain("SETTLE THE POSITIONALLY LAST ENTRY");
    expect(bps.input).toContain("meanTakeWeights()");
    expect(bps.input).toContain("backend/src/swarm/domain.ts");
  });

  test("the spec's divergent example converts the way the spec says it does", () => {
    // A SELF-TEST published for other implementations, executed here so it can
    // never go stale: this is the vector where a decimal implementation of the
    // same prose produces DIFFERENT SIGNED BYTES.
    const example = spec.bps_conversion.divergent_example;
    const shares = new Map(ORDER.map((bucket) => [bucket, example.shares[bucket] as number]));
    const vector = bucketSharesToBps(shares, ORDER);
    expect(vector.map((entry) => entry.weight_bps)).toEqual(example.bps_binary64);
    expect(sumBps(vector)).toBe(BPS_DENOMINATOR);
    // The decimal answer is a DIFFERENT answer, not a rounding nicety — one bp
    // moved between two vaults, which is one verification failure against an
    // anchored digest.
    expect(example.bps_decimal_WRONG).not.toEqual(example.bps_binary64);
    expect(
      (example.bps_decimal_WRONG as number[]).reduce((sum: number, bp: number) => sum + bp, 0),
    ).toBe(BPS_DENOMINATOR);

    // THE MECHANISM, executed rather than described: the two contested
    // remainders are NOT bitwise equal in binary64, so the tie-break never
    // fires and real_world_assets takes the bp outright. In decimal they ARE
    // equal, the tie-break fires, and canonical order hands it to
    // conservative_defi_yield instead.
    const remainder = (share: number): number => {
      const raw = share * BPS_DENOMINATOR;
      return raw - Math.floor(raw);
    };
    const cdy = remainder(example.shares.conservative_defi_yield as number);
    const rwa = remainder(example.shares.real_world_assets as number);
    expect(cdy).not.toBe(rwa);
    expect(rwa).toBeGreaterThan(cdy);
    // Both are ".6132" to the eight decimals the producer emits — the whole
    // point being that "the same number" in decimal is two numbers here.
    expect(cdy.toFixed(4)).toBe("0.6132");
    expect(rwa.toFixed(4)).toBe("0.6132");
  });
});
