// Pure (no-I/O, no DB import) regime row → DTO projection. Kept in its own module
// so BOTH the live endpoint (projections.ts, over Postgres rows) and the offline
// eq-snapshot mapper (regime-eq-map.ts, over reshaped in-memory rows) share the
// EXACT same projection — guaranteeing the Playwright stub payload equals what
// GET /api/dashboards/regime-snapshots returns, without dragging in the DB client
// (which requires DATABASE_URL at import time).
//
// The code lives in the SDK (packages/analyst-sdk/src/report/, issue 1751), so
// the backend and a downstream model run one copy. This file is the shim.
export {
  num,
  rowToSnapshot,
  forHistory,
  REGIME_STALE_THRESHOLD_DAYS,
  computeRegimeStaleness,
  panelObservationDates,
  overallObservationDate,
  computeRegimeSnapshotStaleness,
  shapeRegimeSnapshots,
  type RegimeStaleness,
} from "../../../../packages/analyst-sdk/src/report/regime-snapshots.ts";
export type { JsonValue, RegimeSnapshotRow } from "../../../../packages/analyst-sdk/src/report/canonical.ts";
