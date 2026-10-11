// Maintenance windows (issue 1220, scope item (a); migration 0120).
//
// A window is a planned period when api, workers or the database are down for a
// release. The operator schedules it, starts it, ends it or cancels it through
// the audited admin routes (src/api/routes/admin-maintenance.ts). Everyone reads
// one public answer, GET /api/status/maintenance, with no credential.
//
// STORAGE IS AN APPEND-ONLY EVENT LOG (`maintenance_windows`). A window's state
// is its newest row, so the public answer is the newest row of the one window
// that is still live. At most one window is live at a time: a second `schedule`
// is refused until the first has ended or been cancelled.
import { on, registerQuery } from "../db/registry.ts";
import type { DbHandle } from "../db/client.ts";
import { sql } from "../db/client.ts";

export type MaintenanceEvent = "scheduled" | "started" | "ended" | "cancelled";
export type MaintenanceState = "none" | "scheduled" | "active";

/** The public answer. `maintenance.json` (scope item (b)) holds this same shape. */
export interface MaintenanceStatus {
  state: MaintenanceState;
  /** ISO instant the window starts (scheduled) or started (active); null when none. */
  startsAt: string | null;
  /** ISO instant the operator expects the window to end; null when none. */
  expectedEnd: string | null;
  /** A short notice for visitors; null when none. */
  message: string | null;
}

export const NO_MAINTENANCE: MaintenanceStatus = { state: "none", startsAt: null, expectedEnd: null, message: null };

export interface MaintenanceWindowRow {
  window_id: string;
  event: MaintenanceEvent;
  starts_at: Date;
  expected_end: Date;
  message: string;
}

const WINDOW_COLUMNS = "window_id, event, starts_at, expected_end, message";

const readLiveWindow = registerQuery({
  role: "rm_app",
  object: "maintenance_windows",
  privileges: ["SELECT"],
  site: "src/ops/maintenance:readLiveWindow",
  purpose: "Read the newest event of the one live (scheduled or started) maintenance window, for the public status route and the schedule guard.",
  callers: ["src/api/index", "src/api/routes/admin-maintenance"],
  probe: {
    statement: `SELECT ${WINDOW_COLUMNS} FROM (
        SELECT DISTINCT ON (window_id) ${WINDOW_COLUMNS} FROM maintenance_windows ORDER BY window_id, id DESC
      ) latest
      WHERE event IN ('scheduled', 'started')
      ORDER BY (event = 'started') DESC, starts_at LIMIT 1`,
  },
});

const readWindowState = registerQuery({
  role: "rm_app",
  object: "maintenance_windows",
  privileges: ["SELECT"],
  site: "src/ops/maintenance:readWindowState",
  purpose: "Read the newest event of one maintenance window, the state a start, end or cancel is judged against.",
  callers: ["src/api/routes/admin-maintenance"],
  probe: {
    statement: `SELECT ${WINDOW_COLUMNS} FROM maintenance_windows WHERE window_id = $1::uuid ORDER BY id DESC LIMIT 1`,
    params: ["00000000-0000-0000-0000-000000000000"],
  },
});

const insertWindowEvent = registerQuery({
  role: "rm_app",
  object: "maintenance_windows",
  privileges: ["INSERT"],
  site: "src/ops/maintenance:insertWindowEvent",
  purpose: "Append one maintenance window event (schedule, start, end or cancel); the log is never updated.",
  callers: ["src/api/routes/admin-maintenance"],
  probe: {
    statement: `INSERT INTO maintenance_windows (window_id, event, starts_at, expected_end, message, actor)
      SELECT $1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6 WHERE false`,
    params: ["00000000-0000-0000-0000-000000000000", "scheduled", "2030-01-01T00:00:00Z", "2030-01-01T01:00:00Z", "", "probe"],
  },
});

/** The status a window row means to a visitor. */
export function statusOf(row: MaintenanceWindowRow | undefined): MaintenanceStatus {
  if (!row || (row.event !== "scheduled" && row.event !== "started")) return NO_MAINTENANCE;
  return {
    state: row.event === "started" ? "active" : "scheduled",
    startsAt: new Date(row.starts_at).toISOString(),
    expectedEnd: new Date(row.expected_end).toISOString(),
    message: row.message === "" ? null : row.message,
  };
}

export async function liveWindow(db: DbHandle = sql): Promise<MaintenanceWindowRow | undefined> {
  const [row] = await on(db, readLiveWindow)<MaintenanceWindowRow>`
    SELECT window_id, event, starts_at, expected_end, message FROM (
      SELECT DISTINCT ON (window_id) window_id, event, starts_at, expected_end, message
        FROM maintenance_windows ORDER BY window_id, id DESC
    ) latest
    WHERE event IN ('scheduled', 'started')
    ORDER BY (event = 'started') DESC, starts_at LIMIT 1`;
  return row;
}

export async function windowState(db: DbHandle, windowId: string): Promise<MaintenanceWindowRow | undefined> {
  const [row] = await on(db, readWindowState)<MaintenanceWindowRow>`
    SELECT window_id, event, starts_at, expected_end, message FROM maintenance_windows
     WHERE window_id = ${windowId}::uuid ORDER BY id DESC LIMIT 1`;
  return row;
}

export async function appendWindowEvent(
  db: DbHandle,
  e: { windowId: string; event: MaintenanceEvent; startsAt: Date; expectedEnd: Date; message: string; actor: string },
): Promise<void> {
  await on(db, insertWindowEvent)`
    INSERT INTO maintenance_windows (window_id, event, starts_at, expected_end, message, actor)
    VALUES (${e.windowId}::uuid, ${e.event}, ${e.startsAt}::timestamptz, ${e.expectedEnd}::timestamptz, ${e.message}, ${e.actor})`;
}

/** GET /api/status/maintenance: no credential, one small body. */
export async function maintenanceStatus(): Promise<MaintenanceStatus> {
  return statusOf(await liveWindow());
}

/** True when `value` is a well-formed public answer (what maintenance.json must hold). */
export function isMaintenanceStatus(value: unknown): value is MaintenanceStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "expectedEnd,message,startsAt,state") return false;
  const iso = (x: unknown) => typeof x === "string" && !Number.isNaN(Date.parse(x));
  if (v.state === "none") return v.startsAt === null && v.expectedEnd === null && v.message === null;
  if (v.state !== "scheduled" && v.state !== "active") return false;
  return iso(v.startsAt) && iso(v.expectedEnd) && (v.message === null || typeof v.message === "string");
}
