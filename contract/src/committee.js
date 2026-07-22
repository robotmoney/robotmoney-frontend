// CANONICAL committee constants shared across the boundary — the single source
// of truth for values that must agree across backend, mcp, and scripts (those
// packages cannot import each other; the contract is the sanctioned
// cross-boundary channel — maintainability findings 008/027). Pure data + pure
// functions, zero runtime deps, same conventions as regime.js.

// Canonical stance vocabulary, ASCENDING (most bearish → most bullish). This
// ORDER is load-bearing: the backend aggregation ladder ranks takes by it to
// contrast the most- and least-constructive members. Surfaces that render the
// vocabulary reversed (e.g. prompt text listing bullish first) must derive from
// this tuple, never re-declare the values.
export const STANCES = /** @type {const} */ (["bearish", "cautious", "neutral", "constructive", "bullish"]);

// Fixed target size for the standing demo committee. The onboarding drivers
// (backend gate + scripts/lib/demo-main.ts loop) stop admitting new members once
// the active roster reaches this cap, so the committee settles at a realistic,
// bounded size instead of growing without bound. Pinned by
// backend/tests/committee-roster-cap.test.ts (always via this constant, never a
// literal).
export const COMMITTEE_ROSTER_CAP = 15;

// Demo no-show rule (issue #122): absence emerges from a RULE (a curated set of
// habitual no-shows), not a baked boolean — the contrarian member (draco) models
// an occasional no-show. Kept deterministic (no Math.random / Date) so the
// hermetic e2e drivers and any goldens stay reproducible: the roster outcome is
// fixed (draco absent; athena/boreas/cygnus present).
export const DEMO_NO_SHOWS = /** @type {const} */ (["draco"]);

/**
 * Whether a demo committee member attends a session (the demo no-show rule).
 * @param {string} memberId
 * @returns {boolean}
 */
export function demoAttends(memberId) {
  return !DEMO_NO_SHOWS.includes(/** @type {any} */ (memberId));
}

/**
 * Deterministic demo stance derivation from the regime composite plus a
 * member's directional bias — the HERMETIC (no-LLM) authoring path shared by
 * the backend demo e2e and the mcp agent. Buckets: >=0.67 bullish, >=0.55
 * constructive, >=0.45 neutral, >=0.33 cautious, else bearish; confidence grows
 * with distance from the 0.5 midpoint (clamped to [0,1], 2dp).
 * @param {number} composite
 * @param {number} [bias]
 * @returns {{ stance: "bearish" | "cautious" | "neutral" | "constructive" | "bullish", confidence: number }}
 */
export function stanceFor(composite, bias = 0) {
  const x = composite + bias;
  const stance = x >= 0.67 ? "bullish" : x >= 0.55 ? "constructive" : x >= 0.45 ? "neutral" : x >= 0.33 ? "cautious" : "bearish";
  const confidence = Math.round(Math.min(1, Math.abs(x - 0.5) * 2 + 0.4) * 100) / 100;
  return { stance, confidence };
}
