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
});
