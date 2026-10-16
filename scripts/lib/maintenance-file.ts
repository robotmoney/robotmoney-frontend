// maintenance.json: the public maintenance answer while the api is down
// (issue 1220, scope item (b)).
//
// The rollout tool writes it at the root of the instance's web directory
// (InstancePaths.webDir, mounted at /srv/web in website-server) when a window
// starts, and removes it when the window ends. website-server/nginx.conf serves
// it for GET /api/status/maintenance when the api upstream is unreachable. The
// body has exactly the shape of the api's own answer (backend/src/ops/maintenance.ts
// MaintenanceStatus), so the site reads one shape whichever side answered.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAINTENANCE_FILE = "maintenance.json";

export type MaintenanceState = "none" | "scheduled" | "active";

export interface MaintenanceStatus {
  state: MaintenanceState;
  startsAt: string | null;
  expectedEnd: string | null;
  message: string | null;
}

const STATES: readonly string[] = ["none", "scheduled", "active"];
const KEYS = ["state", "startsAt", "expectedEnd", "message"] as const;

function isIsoOrNull(v: unknown): boolean {
  return v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v));
}

/** Problems with `value` as the public route's body; empty when it is valid. */
export function maintenanceProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["body is not an object"];
  const o = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(o)) if (!(KEYS as readonly string[]).includes(k)) problems.push(`unexpected key ${k}`);
  if (typeof o.state !== "string" || !STATES.includes(o.state)) problems.push("state must be none, scheduled or active");
  if (!isIsoOrNull(o.startsAt)) problems.push("startsAt must be an ISO instant or null");
  if (!isIsoOrNull(o.expectedEnd)) problems.push("expectedEnd must be an ISO instant or null");
  if (o.message !== null && typeof o.message !== "string") problems.push("message must be a string or null");
  if (o.state === "active" && (o.startsAt === null || o.expectedEnd === null)) problems.push("an active window needs startsAt and expectedEnd");
  return problems;
}

/** Write maintenance.json atomically (temp file, then rename). Refuses an invalid body. */
export function writeMaintenanceFile(webDir: string, status: MaintenanceStatus): string {
  const problems = maintenanceProblems(status);
  if (problems.length > 0) throw new Error(`refusing to write an invalid maintenance.json: ${problems.join("; ")}`);
  const target = join(webDir, MAINTENANCE_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(status)}\n`, { mode: 0o644 });
  renameSync(tmp, target);
  return target;
}

/** Remove maintenance.json when the window ends. Returns whether a file was removed. */
export function clearMaintenanceFile(webDir: string): boolean {
  const target = join(webDir, MAINTENANCE_FILE);
  if (!existsSync(target)) return false;
  rmSync(target);
  return true;
}

export function readMaintenanceFile(webDir: string): MaintenanceStatus | null {
  const target = join(webDir, MAINTENANCE_FILE);
  if (!existsSync(target)) return null;
  const body = JSON.parse(readFileSync(target, "utf8")) as unknown;
  const problems = maintenanceProblems(body);
  if (problems.length > 0) throw new Error(`invalid maintenance.json: ${problems.join("; ")}`);
  return body as MaintenanceStatus;
}
