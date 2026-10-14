import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMaintenanceFile, maintenanceProblems, MAINTENANCE_FILE, readMaintenanceFile, writeMaintenanceFile } from "../../lib/maintenance-file.ts";

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "rm-maint-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const active = { state: "active" as const, startsAt: "2030-01-01T10:00:00.000Z", expectedEnd: "2030-01-01T11:00:00.000Z", message: "Upgrade" };

describe("maintenance.json", () => {
  test("write produces a body that validates against the public route shape, and clear removes it", () => {
    const dir = tmp();
    const path = writeMaintenanceFile(dir, active);
    expect(path).toBe(join(dir, MAINTENANCE_FILE));
    expect(maintenanceProblems(JSON.parse(readFileSync(path, "utf8")))).toEqual([]);
    expect(readMaintenanceFile(dir)).toEqual(active);
    expect(clearMaintenanceFile(dir)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(clearMaintenanceFile(dir)).toBe(false);
  });

  test("an invalid body is refused and nothing is written", () => {
    const dir = tmp();
    expect(() => writeMaintenanceFile(dir, { ...active, state: "down" as never })).toThrow();
    expect(() => writeMaintenanceFile(dir, { ...active, expectedEnd: null })).toThrow();
    expect(existsSync(join(dir, MAINTENANCE_FILE))).toBe(false);
  });

  test("the validator names extra keys and bad instants", () => {
    expect(maintenanceProblems({ ...active, extra: 1 })).toContain("unexpected key extra");
    expect(maintenanceProblems({ ...active, startsAt: "soon" })).toContain("startsAt must be an ISO instant or null");
    expect(maintenanceProblems([])).toEqual(["body is not an object"]);
  });
});
