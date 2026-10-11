// Maintenance windows (issue 1220, scope item (a)): the append-only table, the
// public status route's answer and the audited admin routes. Real Postgres from
// the preload; if it is absent the preload throws, so nothing here skips.
import { beforeAll, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { provisionOperatorToken } from "./support/automation-auth.ts";
import { handleAdmin } from "../src/api/routes/admin.ts";
import { isMaintenanceStatus, maintenanceStatus, type MaintenanceStatus } from "../src/ops/maintenance.ts";

useCleanDatabase(import.meta.file);

let OPERATOR = "";
beforeAll(async () => {
  OPERATOR = await provisionOperatorToken();
});

function post(path: string, body: unknown, token?: string): Promise<{ status: number; body: any } | null> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["X-Admin-Token"] = token;
  const r = new Request(`http://x${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return handleAdmin(r, new URL(r.url)) as Promise<{ status: number; body: any } | null>;
}

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const REASON = "planned release window";
const auditRows = async (id: string) =>
  (await fixtureDb`SELECT action, target_type, target_id, reason FROM audit_log WHERE target_id = ${id} ORDER BY id`) as unknown as Record<string, string>[];

describe("grants", () => {
  test("no runtime role holds UPDATE, DELETE or TRUNCATE on maintenance_windows", async () => {
    for (const role of ["rm_app", "rm_worker", "rm_readonly"]) {
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
        const [row] = await fixtureDb`SELECT has_table_privilege(${role}, 'maintenance_windows', ${privilege}) AS held`;
        expect({ role, privilege, held: row!.held }).toEqual({ role, privilege, held: false });
      }
    }
    const [app] = await fixtureDb`SELECT has_table_privilege('rm_app', 'maintenance_windows', 'INSERT') AS held`;
    expect(app!.held).toBe(true);
  });
});

describe("GET /api/status/maintenance", () => {
  test("answers state none with no window, and the route is in the contract", async () => {
    expect(ROUTES.status.maintenance).toBe("/api/status/maintenance");
    expect(await maintenanceStatus()).toEqual({ state: "none", startsAt: null, expectedEnd: null, message: null });
  });

  test("the admin routes refuse an unauthenticated caller and write nothing", async () => {
    const id = crypto.randomUUID();
    for (const [path, body] of [
      [ROUTES.admin.maintenanceSchedule, { startsAt: hours(1), expectedEnd: hours(2), reason: REASON }],
      [`/api/admin/maintenance/${id}/start`, { reason: REASON }],
      [`/api/admin/maintenance/${id}/end`, { reason: REASON }],
      [`/api/admin/maintenance/${id}/cancel`, { reason: REASON }],
    ] as const) {
      expect((await post(path, body))?.status).toBe(403);
      expect((await post(path, body, "wrong"))?.status).toBe(403);
    }
    const [n] = await fixtureDb`SELECT count(*)::int AS n FROM maintenance_windows`;
    expect(n!.n).toBe(0);
  });

  test("schedule, start, end change the public answer and each write one audit row", async () => {
    const startsAt = hours(1);
    const expectedEnd = hours(2);
    const sched = await post(ROUTES.admin.maintenanceSchedule, { startsAt, expectedEnd, message: "Database upgrade", reason: REASON }, OPERATOR);
    expect(sched?.status).toBe(201);
    const id: string = sched!.body.windowId;

    let status = await maintenanceStatus();
    expect(status).toEqual({ state: "scheduled", startsAt, expectedEnd, message: "Database upgrade" });
    expect(isMaintenanceStatus(status)).toBe(true);

    const later = hours(3);
    const start = await post(`/api/admin/maintenance/${id}/start`, { reason: REASON, expectedEnd: later }, OPERATOR);
    expect(start?.status).toBe(200);
    status = await maintenanceStatus();
    expect(status.state).toBe("active");
    expect(status.expectedEnd).toBe(later);
    expect(status.message).toBe("Database upgrade");

    expect((await post(`/api/admin/maintenance/${id}/end`, { reason: REASON }, OPERATOR))?.status).toBe(200);
    expect(await maintenanceStatus()).toEqual({ state: "none", startsAt: null, expectedEnd: null, message: null });

    const audit = await auditRows(id);
    expect(audit.map((r) => r.action)).toEqual(["maintenance_schedule", "maintenance_start", "maintenance_end"]);
    expect(audit.every((r) => r.target_type === "maintenance_window" && r.reason === REASON)).toBe(true);
    const [n] = await fixtureDb`SELECT count(*)::int AS n FROM maintenance_windows WHERE window_id = ${id}::uuid`;
    expect(n!.n).toBe(3);
  });

  test("cancel clears a scheduled window, a second live window is refused, bad input is a 400", async () => {
    const a = await post(ROUTES.admin.maintenanceSchedule, { startsAt: hours(1), expectedEnd: hours(2), reason: REASON }, OPERATOR);
    const id: string = a!.body.windowId;
    expect((await post(ROUTES.admin.maintenanceSchedule, { startsAt: hours(5), expectedEnd: hours(6), reason: REASON }, OPERATOR))?.status).toBe(409);
    expect((await post(`/api/admin/maintenance/${id}/end`, { reason: REASON }, OPERATOR))?.status).toBe(409);
    expect((await post(`/api/admin/maintenance/${id}/cancel`, { reason: REASON }, OPERATOR))?.status).toBe(200);
    expect((await maintenanceStatus() as MaintenanceStatus).state).toBe("none");
    expect((await post(`/api/admin/maintenance/${id}/start`, { reason: REASON }, OPERATOR))?.status).toBe(409);
    expect((await post(`/api/admin/maintenance/${crypto.randomUUID()}/start`, { reason: REASON }, OPERATOR))?.status).toBe(404);
    expect((await post(ROUTES.admin.maintenanceSchedule, { startsAt: hours(2), expectedEnd: hours(1), reason: REASON }, OPERATOR))?.status).toBe(400);
    expect((await post(ROUTES.admin.maintenanceSchedule, { startsAt: hours(1), expectedEnd: hours(2), reason: "no" }, OPERATOR))?.status).toBe(400);
    expect((await auditRows(id)).map((r) => r.action)).toEqual(["maintenance_schedule", "maintenance_cancel"]);
  });
});

describe("isMaintenanceStatus", () => {
  test("accepts the public shapes and refuses anything else", () => {
    expect(isMaintenanceStatus({ state: "none", startsAt: null, expectedEnd: null, message: null })).toBe(true);
    expect(isMaintenanceStatus({ state: "active", startsAt: hours(0), expectedEnd: hours(1), message: null })).toBe(true);
    expect(isMaintenanceStatus({ state: "active", startsAt: null, expectedEnd: null, message: null })).toBe(false);
    expect(isMaintenanceStatus({ state: "none", startsAt: null, expectedEnd: null })).toBe(false);
    expect(isMaintenanceStatus({ state: "other", startsAt: null, expectedEnd: null, message: null })).toBe(false);
  });
});
