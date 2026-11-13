// The route and header table covers every duty of the server (issue 1624,
// docs/technical/web-serving-architecture.md §3.3), and its security header
// values are the ones website-server/nginx.conf sends today (website-csp.test.ts
// pins the CSP's directives). The table itself runs in
// scripts/tests/integration/website-server-routes.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DUTIES, SECURITY_HEADERS, TABLE } from "../support/website-routes-table.ts";

const conf = readFileSync(join(import.meta.dir, "../../../website-server/nginx.conf"), "utf8");

describe("website-server route and header table", () => {
  test.each([...DUTIES])("duty %s has at least one row", (duty) => {
    expect(TABLE.filter((r) => r.duty === duty).length).toBeGreaterThan(0);
  });

  test("row ids are unique", () => {
    expect(new Set(TABLE.map((r) => r.id)).size).toBe(TABLE.length);
  });

  test("the maintenance rows run with the api stopped, and only they do", () => {
    expect(TABLE.filter((r) => r.phase === "api-down").every((r) => r.duty === "maintenance")).toBe(true);
    expect(TABLE.some((r) => r.duty === "maintenance" && r.path.startsWith("/api/status/maintenance"))).toBe(true);
  });

  test.each(Object.entries(SECURITY_HEADERS))("the table's %s equals nginx.conf's", (name, value) => {
    const re = new RegExp(`add_header\\s+${name}\\s+"([^"]*)"`, "i");
    expect(re.exec(conf)?.[1]).toBe(value);
  });
});
