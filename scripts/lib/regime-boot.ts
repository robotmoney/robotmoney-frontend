// Demo-boot regime freshness decision (issue #126). The boot self-heal loop in
// smoke-main.ts (verify the seed regime run landed a FRESH snapshot; re-run the
// analytics up to 3× on stale; log LOUDLY if still stale) used to hold this
// decision inline in an untestable for-loop. The pure "is the served snapshot
// fresh? should we re-run? give up loudly?" classification lives HERE so it can
// be unit-tested (scripts/tests/unit/regime-boot.test.ts) while smoke-main.ts keeps
// only the I/O (fetch the snapshot, run e2e.admin, log the returned message).
// No I/O, no imports — safe for the root scripts test suite.

export const REGIME_BOOT_MAX_ATTEMPTS = 3;

// The `staleness` object served by GET /api/dashboards/regime-snapshots
// (backend regime-projection.ts RegimeStaleness), as seen loosely over HTTP —
// or null when the fetch failed / the body had no staleness.
export interface RegimeBootStaleness {
  stale?: boolean;
  asof?: string | null;
  ageDays?: number | null;
}

export type RegimeBootDecision =
  // Snapshot verified fresh → stop retrying, hand off to the worker's cron.
  | { action: "fresh"; message: string }
  // Stale (or unverifiable) with attempts left → re-run analytics and loop.
  | { action: "rerun"; message: string }
  // Still stale on the final attempt → give up with the LOUD operator warning.
  | { action: "give-up"; message: string };

// Pure decision for one attempt of the boot loop. `staleness === null` (fetch
// failed / no body) is treated exactly like stale: freshness was NOT verified,
// so the run is retried rather than trusted silently.
export function decideRegimeBootAction(
  staleness: RegimeBootStaleness | null,
  attempt: number,
  maxAttempts: number = REGIME_BOOT_MAX_ATTEMPTS,
): RegimeBootDecision {
  if (staleness && !staleness.stale) {
    return {
      action: "fresh",
      message: `regime snapshot fresh (asof ${staleness.asof}, ${staleness.ageDays}d)`,
    };
  }
  if (attempt < maxAttempts) {
    return {
      action: "rerun",
      message: `regime snapshot STALE (asof ${staleness?.asof ?? "none"}) — re-running analytics (attempt ${attempt}/${maxAttempts})`,
    };
  }
  return {
    action: "give-up",
    message: `⚠ regime snapshot STILL STALE after ${maxAttempts} attempts (asof ${staleness?.asof ?? "none"}) — live fetchers may be blocked in this environment; the /regime charts will show a staleness banner until the worker lands a fresh run`,
  };
}
