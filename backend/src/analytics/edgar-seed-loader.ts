// EDGAR/MNA seed loader + offline repopulation client (issue #108). Both
// operations only ever talk to the authenticated analytics HTTP boundary
// (issue #106) — NEVER db/client.ts, db/worker-client.ts, or an analytics
// store writer (enforced by tests/analytics-api-boundary.test.ts, which scans
// this whole directory minus store/ and report/).
//
//   bootstrapEdgarSeed        — load the committed artifact + ingest it via
//                               POST /api/analytics/raw-history/seed (the
//                               #106 server-side gap-fill: existing real rows
//                               always win, a second run is a no-op).
//   repopulateEdgarSeed       — an operator-run offline repopulation client:
//                               diff the committed artifact against whatever
//                               is currently persisted, ingest through the
//                               SAME seed endpoint (still existing-wins), and
//                               report how many points were newly seeded,
//                               already present with the same value, or
//                               already present with a DIFFERENT (real) value
//                               that was correctly left standing.
//   repairEdgarSeed           — the REPAIR path (issue #509): the ONLY
//                               in-system way to restore an archived baseline
//                               date that was already OVERWRITTEN. Deliberately
//                               separate from the two gap-fill entrypoints
//                               above, because it is the exact inverse of their
//                               honesty rule — see its own comment.
import { resolveAnalyticsApiConfig, analyticsApiClient, type AnalyticsApiConfig } from "./api-client.ts";
import { loadEdgarSeed, EDGAR_SEED_INDICATOR } from "./extract/edgar-seed.ts";
import type { FloorSeedResult } from "./persistence.ts";

export async function bootstrapEdgarSeed(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): Promise<FloorSeedResult> {
  const { history } = await loadEdgarSeed();
  return analyticsApiClient(cfg).seedRawHistory(history);
}

export interface RepopulationReport {
  seeded: number; // rows the committed artifact restored (were missing)
  existing: number; // rows already present with the SAME value (no-op)
  rejected: number; // rows already present with a DIFFERENT (real) value — correctly left standing
}

export async function repopulateEdgarSeed(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): Promise<RepopulationReport> {
  const { history } = await loadEdgarSeed();
  const persistence = analyticsApiClient(cfg);
  const current = await persistence.loadRawHistory();

  let seeded = 0;
  let existing = 0;
  let rejected = 0;
  for (const [indicator, pts] of Object.entries(history)) {
    const have = new Map((current[indicator] ?? []).map((p) => [p.date, p.value] as const));
    for (const p of pts) {
      if (!have.has(p.date)) seeded++;
      else if (have.get(p.date) === p.value) existing++;
      else rejected++;
    }
  }

  // The actual write: still the server-owned gap-fill (existing rows always
  // win), so this call can never overwrite a real observation regardless of
  // the client-side diff above.
  await persistence.seedRawHistory(history);

  return { seeded, existing, rejected };
}

export interface SeedRepairReport {
  restored: number; // rows whose persisted value DISAGREED with the artifact and was overwritten back to it
  unchanged: number; // rows already equal to the artifact (or absent, then written)
}

// REPAIR (issue #509). `repopulateEdgarSeed` above — like every other seed
// path (store/floor-seed.ts's `applyRawFloorSeed`) — writes only dates that
// are MISSING: an already-persisted value always wins. That is the correct
// default, and it is also precisely why a bad bulk write was unrepairable in
// system: after a full-sweep batch clobbered ~200 archived months, every one
// of those dates is PRESENT, so the seed path reports them all as `rejected`
// and restores nothing. Only a manual DB operation could undo it.
//
// This entrypoint is that missing repair, and it inverts the rule on purpose:
// it submits the committed #108 artifact through the ordinary raw-history
// upsert (`saveRawHistory`, ON CONFLICT DO UPDATE), so the ARTIFACT wins on
// overlap and clobbered dates are restored to the archived baseline. Rows are
// tagged provenance 'seed' again, undoing the 'seed' → 'live' flip the bad
// write caused.
//
// Deliberately NOT reachable from any scheduled/automatic path: it is an
// operator command (scripts/edgar-seed-repopulate.ts --repair), because
// running it indiscriminately would throw away GENUINE live revisions that
// legitimately superseded the artifact.
export async function repairEdgarSeed(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): Promise<SeedRepairReport> {
  const { history } = await loadEdgarSeed();
  const persistence = analyticsApiClient(cfg);
  const current = await persistence.loadRawHistory();

  let restored = 0;
  let unchanged = 0;
  for (const [indicator, pts] of Object.entries(history)) {
    const have = new Map((current[indicator] ?? []).map((p) => [p.date, p.value] as const));
    for (const p of pts) {
      if (have.has(p.date) && have.get(p.date) !== p.value) restored++;
      else unchanged++;
    }
  }

  await persistence.saveRawHistory(history, "seed");

  return { restored, unchanged };
}

export { EDGAR_SEED_INDICATOR };
