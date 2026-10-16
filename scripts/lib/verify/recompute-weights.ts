// A REFERENCE recomputation of a session's allocation vector from its takes.
//
// WHY THIS IS A SECOND IMPLEMENTATION AND NOT AN IMPORT. D42's claim — the one
// the whole product rests on — is that "ANYONE HOLDING THE TAKE SET CAN
// RECOMPUTE THE VECTOR THEMSELVES". Importing `meanTakeWeights()` from
// backend/src/swarm/domain.ts to check a published vector would be tautological:
// an algorithm bug reproduces itself and the check passes. A third party does
// not have that function; they have the published takes, the published vector,
// and the documented rule. So does this file.
//
// It follows the precedent already set by contract/src/consensus-receipt.js,
// which ships a reference canonicalizer for exactly this reason rather than
// leaving the pin inside one repo's test helper.
//
// WHAT KEEPS THE TWO FROM DRIFTING SILENTLY. Independence is only useful while
// both implementations agree about the SAME rule, so
// scripts/tests/unit/verify-recompute-weights.test.ts holds this function
// against the real `meanTakeWeights()` over shared fixtures. A deliberate
// change to the derivation turns that test red and has to be made in both
// places on purpose; an accidental divergence cannot pass quietly.
//
// Mirrors domain.ts's derivation exactly, in its order, because the order is
// load-bearing for the last-bucket remainder:
//   1. normalize each take's weights to sum 1, dropping malformed takes whole
//   2. sum per bucket across the surviving takes
//   3. order buckets by localeCompare, average by the SURVIVING take count
//   4. renormalize against the averaged total, rounding to 8dp
//   5. set the LAST bucket to 1 - (sum of the rest), so the vector sums to
//      exactly 1 and no rounding residue is left in it
//
// ZERO DEPENDENCIES, so it can run anywhere a fetch can — including against a
// production origin with no database access.

/** domain.ts's `round`, same default-free 8dp call the derivation makes. */
function round(value: number, dp: number): number {
  return Math.round(value * 10 ** dp) / 10 ** dp;
}

/**
 * domain.ts's `normalizedTakeWeights`: a take's weights normalized to sum 1, or
 * null if the take is malformed. Malformed is WHOLE-take, never per-entry — a
 * single bad entry drops the take rather than being skipped, or a member could
 * influence the mean by submitting partly-garbage weights.
 */
export function normalizeTakeWeights(value: unknown): { bucket: string; weight: number }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const entries: { bucket: string; weight: number }[] = [];
  let total = 0;
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const bucket = (candidate as { bucket?: unknown }).bucket;
    const weight = (candidate as { weight?: unknown }).weight;
    if (
      typeof bucket !== "string" || bucket.trim() === "" || seen.has(bucket) ||
      typeof weight !== "number" || !Number.isFinite(weight) || weight < 0
    ) {
      return null;
    }
    seen.add(bucket);
    entries.push({ bucket, weight });
    total += weight;
  }
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return entries.map(({ bucket, weight }) => ({ bucket, weight: weight / total }));
}

/**
 * The vector a session's take set implies. `undefined` when no take carries
 * usable weights — which is a real state (a `position_actions` subject, or a
 * session whose members all filed prose), not an error.
 */
export function recomputeMeanTakeWeights(
  takes: readonly { payload?: { weights?: unknown } | null }[],
): { bucket: string; weight: number }[] | undefined {
  const normalized = takes
    .map((take) => normalizeTakeWeights(take.payload?.weights))
    .filter((w): w is { bucket: string; weight: number }[] => w !== null);
  if (normalized.length === 0) return undefined;

  const totals = new Map<string, number>();
  for (const weights of normalized) {
    for (const { bucket, weight } of weights) totals.set(bucket, (totals.get(bucket) ?? 0) + weight);
  }
  const averaged = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, total]) => ({ bucket, weight: total / normalized.length }));
  const averagedTotal = averaged.reduce((sum, e) => sum + e.weight, 0);
  const result = averaged.map(({ bucket, weight }) => ({ bucket, weight: round(weight / averagedTotal, 8) }));
  const last = result.length - 1;
  const prefix = result.slice(0, last).reduce((sum, e) => sum + e.weight, 0);
  result[last]!.weight = round(1 - prefix, 8);
  return result;
}

/**
 * Compare a published vector against a recomputed one.
 *
 * EXACT on bucket set and order, and on weight to 8dp — the same precision the
 * derivation rounds to, so "close enough" is not a category here. A vector that
 * differs in the 9th place differs because something re-derived it differently,
 * which is the thing being detected.
 */
export function diffWeightVectors(
  published: readonly { bucket: string; weight: number }[],
  recomputed: readonly { bucket: string; weight: number }[],
): string[] {
  const problems: string[] = [];
  const pub = published.map((e) => e.bucket).join(",");
  const rec = recomputed.map((e) => e.bucket).join(",");
  if (pub !== rec) {
    problems.push(`bucket set/order differs — published [${pub}] vs recomputed [${rec}]`);
    return problems; // per-bucket diffs below would be noise once the sets disagree
  }
  for (const [i, entry] of published.entries()) {
    const mine = recomputed[i]!;
    if (round(entry.weight, 8) !== round(mine.weight, 8)) {
      problems.push(`${entry.bucket}: published ${entry.weight} vs recomputed ${mine.weight}`);
    }
  }
  return problems;
}
