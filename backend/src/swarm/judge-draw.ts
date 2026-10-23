// THE JUDGE DRAW (issue #1336, decisions.md D71, investment-swarm.md §9.7).
//
// Every eligible judge judges. After the judging deadline the system lists the
// on-time answers, keeps one per judge, and draws ONE of them at random. That
// answer is the session's judgement. This module is the draw and nothing else:
// the list, the transaction and the audit row belong to `epoch.finalizeEpoch`.
//
// THE RULE IS VERSIONED: 'rejection-u32-v1'. Draw a 32-bit value v. Reject v
// when v >= floor(2^32 / n) * n, because those values would make the low
// positions likelier. Then drawn_index = v mod n. The stored record holds the
// accepted v, the list and the rule name, so anyone can recompute the pick:
// `recomputeDrawnIndex(randomValue, n)`. The random value itself is trusted,
// because commit-reveal is out of scope.
//
// THE SOURCE IS A CSPRNG BY DEFAULT. A test may fix the value through
// `setJudgeDrawSourceForTests`, which is a test-only path (backend/src/test-seam.ts):
// it throws in any process that is not the test harness.
import { testSeamArmed, testSeamRefusal } from "../test-seam.ts";

export const DRAW_RULE = "rejection-u32-v1";

const TWO_POW_32 = 2 ** 32;

/** A source of unsigned 32-bit values. */
export type DrawSource = () => number;

/** The values at or above this are rejected for a list of `n`, so every position is equally likely. */
export function rejectionLimit(n: number): number {
  return Math.floor(TWO_POW_32 / n) * n;
}

/** The position a 32-bit value picks from a list of `n`, or null when the rule rejects the value. */
export function recomputeDrawnIndex(randomValue: number, n: number): number | null {
  if (!Number.isInteger(n) || n < 1) return null;
  if (!Number.isInteger(randomValue) || randomValue < 0 || randomValue >= TWO_POW_32) return null;
  if (randomValue >= rejectionLimit(n)) return null;
  return randomValue % n;
}

const csprng: DrawSource = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

let source: DrawSource = csprng;

/**
 * Fix the random source for a test. `null` restores the CSPRNG. Refused outside
 * the test harness (smoke-production-spec.md §7.1, D69 (3), D71).
 */
export function setJudgeDrawSourceForTests(next: DrawSource | null): void {
  if (!testSeamArmed()) {
    throw testSeamRefusal(
      "swarm/judge-draw.setJudgeDrawSourceForTests()",
      "A deployed process draws from the operating system's secure random source only.",
    );
  }
  source = next ?? csprng;
}

/** More than this many rejections in a row means the source is broken, not unlucky. */
const MAX_REJECTIONS = 64;

/** Draw one position from a list of `n` (n >= 1). */
export function drawIndex(n: number): { randomValue: number; drawnIndex: number } {
  if (!Number.isInteger(n) || n < 1) throw new Error(`judge draw needs at least one candidate, got ${n}`);
  for (let i = 0; i < MAX_REJECTIONS; i++) {
    const randomValue = source();
    const drawnIndex = recomputeDrawnIndex(randomValue, n);
    if (drawnIndex !== null) return { randomValue, drawnIndex };
  }
  throw new Error(`judge draw: ${MAX_REJECTIONS} values in a row were rejected by ${DRAW_RULE}; the random source is broken`);
}

/** The draw facts stored on the session's judge record and in the audit log. */
export type JudgeDraw = {
  candidate_judgement_ids: number[];
  candidate_member_ids: string[];
  drawn_index: number;
  random_value: number;
  draw_rule: typeof DRAW_RULE;
  drawn_at: string;
};
