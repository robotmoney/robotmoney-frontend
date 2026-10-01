// Issue #979 AC2: the cutover gate. Reads analytics_parity_observations
// (migration 0060) and decides whether ledger-mode reads may be armed —
// exiting zero ONLY for a fully matching observation window, across EVERY
// domain, spanning at least the configured minimum duration and count, with
// no stale result. Five independent ways to fail, each its own reason string:
//   1. a checksum mismatch (any observation with matched = false)
//   2. a missing domain (zero observations recorded for it at all)
//   3. a stale result (the newest observation for a domain is older than the
//      freshness budget — the gate must not pass on old evidence that the
//      checker may since have stopped running)
//   4. insufficient duration (the domain's observations don't span the
//      configured minimum window)
//   5. insufficient count (fewer than the configured minimum observations)
import { sql, type DbHandle } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { ALL_PARITY_DOMAINS, type ParityDomain } from "./parity.ts";

// A registered query (smoke-production-spec.md §7.1). The gate is evaluated
// by the operator's cutover CLI and by setAnalyticsReadMode('ledger'), which
// only that CLI calls; both run on the api's pool.
const readObservations = registerQuery({
  role: "rm_app",
  object: "analytics_parity_observations",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/gate:evaluateCutoverGate",
  purpose: "Read every parity observation, oldest first per domain, to decide whether ledger-mode reads may be armed.",
  callers: ["scripts/analytics-ledger-cutover-gate"],
  probe: {
    statement: "SELECT domain, observed_at, matched FROM analytics_parity_observations ORDER BY domain, observed_at ASC",
  },
});

export interface CutoverGateConfig {
  minWindowMs: number;
  minObservations: number;
  maxStalenessMs: number;
}

// Env-overridable so an operator can tune the real cutover window without a
// code change; every default is generous enough that a real production
// rollout, not merely a test, could rely on it. Tests override every field
// explicitly rather than relying on these.
export function defaultCutoverGateConfig(): CutoverGateConfig {
  return {
    minWindowMs: Number(process.env.ANALYTICS_CUTOVER_MIN_WINDOW_MS ?? 24 * 60 * 60 * 1000),
    minObservations: Number(process.env.ANALYTICS_CUTOVER_MIN_OBSERVATIONS ?? 12),
    maxStalenessMs: Number(process.env.ANALYTICS_CUTOVER_MAX_STALENESS_MS ?? 2 * 60 * 60 * 1000),
  };
}

export interface CutoverGateResult {
  ok: boolean;
  reasons: string[];
  perDomain: Record<ParityDomain, { count: number; earliest: string | null; latest: string | null; allMatched: boolean }>;
}

interface ObservationRow {
  domain: ParityDomain;
  observed_at: Date;
  matched: boolean;
}

export async function evaluateCutoverGate(
  db: DbHandle = sql,
  config: CutoverGateConfig = defaultCutoverGateConfig(),
  now: Date = new Date(),
): Promise<CutoverGateResult> {
  const rows = await on(db, readObservations)<ObservationRow>`
    SELECT domain, observed_at, matched FROM analytics_parity_observations ORDER BY domain, observed_at ASC
  `;

  const byDomain = new Map<ParityDomain, ObservationRow[]>();
  for (const row of rows) {
    const list = byDomain.get(row.domain);
    if (list) list.push(row);
    else byDomain.set(row.domain, [row]);
  }

  const reasons: string[] = [];
  const perDomain = {} as CutoverGateResult["perDomain"];

  for (const domain of ALL_PARITY_DOMAINS) {
    const observations = byDomain.get(domain) ?? [];
    if (observations.length === 0) {
      reasons.push(`missing domain: no parity observations recorded for "${domain}"`);
      perDomain[domain] = { count: 0, earliest: null, latest: null, allMatched: false };
      continue;
    }
    const earliest = observations[0]!;
    const latest = observations[observations.length - 1]!;
    const allMatched = observations.every((o) => o.matched);
    perDomain[domain] = {
      count: observations.length,
      earliest: earliest.observed_at.toISOString(),
      latest: latest.observed_at.toISOString(),
      allMatched,
    };

    const mismatched = observations.filter((o) => !o.matched);
    if (mismatched.length > 0) {
      reasons.push(
        `checksum mismatch: "${domain}" has ${mismatched.length} mismatched observation(s), most recently at ${
          mismatched[mismatched.length - 1]!.observed_at.toISOString()
        }`,
      );
    }

    const stalenessMs = now.getTime() - latest.observed_at.getTime();
    if (stalenessMs > config.maxStalenessMs) {
      reasons.push(
        `stale result: "${domain}"'s newest observation is ${Math.round(stalenessMs / 1000)}s old, ` +
          `exceeding the ${Math.round(config.maxStalenessMs / 1000)}s freshness budget`,
      );
    }

    const spanMs = latest.observed_at.getTime() - earliest.observed_at.getTime();
    if (spanMs < config.minWindowMs) {
      reasons.push(
        `insufficient duration: "${domain}"'s observations span ${Math.round(spanMs / 1000)}s, ` +
          `below the required ${Math.round(config.minWindowMs / 1000)}s`,
      );
    }

    if (observations.length < config.minObservations) {
      reasons.push(
        `insufficient count: "${domain}" has ${observations.length} observation(s), below the required ${config.minObservations}`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons, perDomain };
}
